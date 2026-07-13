// Purchase delivery endpoint.
//
// GET /api/download?session_id=cs_...            → JSON manifest of the files
//                                                   this purchase is entitled to
// GET /api/download?session_id=cs_...&zip=<name> → streams that ZIP
//
// Auth model: the Stripe Checkout Session id acts as the proof of purchase.
// Every request re-verifies the session with Stripe (payment_status must be
// "paid") before anything is returned, so a shared or leaked page URL still
// only works for a completed purchase. Product files live in a PRIVATE Vercel
// Blob store and are streamed through this function — they have no public URL.
//
// Env (Vercel project settings):
//   STRIPE_VERIFY_KEY — restricted Stripe key, READ-ONLY on Checkout Sessions
//   (Blob access is automatic via OIDC — the store is connected to the project)

import { get } from '@vercel/blob';

const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]+$/;

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id') || '';
  const zip = searchParams.get('zip');

  if (!SESSION_ID_RE.test(sessionId)) {
    return json({ error: 'Missing or malformed session_id' }, 400);
  }
  const stripeKey = process.env.STRIPE_VERIFY_KEY;
  if (!stripeKey) {
    return json({ error: 'Delivery is not configured yet — please contact dev@webnomad.org' }, 500);
  }

  // Verify the purchase with Stripe
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items.data.price.product`,
    { headers: { Authorization: `Bearer ${stripeKey}` } },
  );
  if (!res.ok) {
    return json({ error: 'Purchase not found. If you believe this is a mistake, contact dev@webnomad.org with your receipt.' }, 403);
  }
  const session = await res.json();
  if (session.payment_status !== 'paid') {
    return json({ error: 'This purchase has not completed payment yet. Refresh in a minute, or contact dev@webnomad.org.' }, 403);
  }

  const products = (session.line_items?.data ?? [])
    .map(li => ({ name: li.price?.product?.name ?? li.description, zip: li.price?.product?.metadata?.zip }))
    .filter(p => p.zip);

  if (!products.length) {
    return json({ error: 'No downloadable files are attached to this purchase — contact dev@webnomad.org with your receipt.' }, 404);
  }

  // Manifest mode
  if (!zip) {
    return json({
      paid: true,
      products,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: session.customer_details?.email ?? null,
    }, 200, { 'Cache-Control': 'private, no-store' });
  }

  // Download mode — the requested zip must belong to this purchase
  if (!products.some(p => p.zip === zip)) {
    return json({ error: 'That file is not part of this purchase.' }, 403);
  }

  const result = await get(`products/${zip}`, { access: 'private' });
  if (result?.statusCode !== 200 || !result.stream) {
    return json({ error: 'File temporarily unavailable — please try again or contact dev@webnomad.org.' }, 404);
  }

  return new Response(result.stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zip}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    },
  });
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
