/* Purchase delivery endpoint.

   GET /api/download?session_id=cs_...            → JSON manifest of the files
                                                    this purchase is entitled to
   GET /api/download?session_id=cs_...&zip=<name> → streams that ZIP

   Auth model: the Stripe Checkout Session id acts as the proof of purchase.
   Every request re-verifies the session with Stripe (payment_status must be
   "paid") before anything is returned, so a shared or leaked page URL still
   only works for a completed purchase. Product files live in a PRIVATE Vercel
   Blob store and are streamed through this function — they have no public URL.

   Env (Vercel project settings):
     STRIPE_VERIFY_KEY     — restricted Stripe key, READ-ONLY on Checkout Sessions
     BLOB_READ_WRITE_TOKEN — added automatically when the Blob store is
     (or OIDC + BLOB_STORE_ID — see the note at the get() call; OIDC alone is NOT enough)
                             connected to the project (falls back to OIDC).

   NOTE: written in the classic Node (req, res) signature — same as
   api/contact.mjs — which is how this project's functions are invoked. */

import { Readable } from 'node:stream';
import { get } from '@vercel/blob';

const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]+$/;

export default async function handler(req, res) {
  try {
    const sessionId = String(req.query.session_id || '');
    const zip = req.query.zip ? String(req.query.zip) : null;

    if (!SESSION_ID_RE.test(sessionId)) {
      return res.status(400).json({ error: 'Missing or malformed session_id' });
    }
    const stripeKey = process.env.STRIPE_VERIFY_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: 'Delivery is not configured yet — please contact dev@webnomad.org' });
    }

    // Verify the purchase with Stripe
    const verify = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items.data.price.product`,
      { headers: { Authorization: `Bearer ${stripeKey}` } },
    );
    if (!verify.ok) {
      return res.status(403).json({ error: 'Purchase not found. If you believe this is a mistake, contact dev@webnomad.org with your receipt.' });
    }
    const session = await verify.json();
    // A 100%-off coupon produces a completed session with NO PaymentIntent, and Stripe reports it
    // as "no_payment_required" rather than "paid". Without this it would be refused as unpaid — so
    // anyone using a free promo code would be told their purchase doesn't exist. The extra
    // status==='complete' guard is what stops an abandoned zero-total session from qualifying;
    // the "paid" path is untouched, since a paid session is always complete.
    const settled =
      session.payment_status === 'paid' ||
      (session.payment_status === 'no_payment_required' && session.status === 'complete');
    if (!settled) {
      return res.status(403).json({ error: 'This purchase has not completed payment yet. Refresh in a minute, or contact dev@webnomad.org.' });
    }

    const lineItems = session.line_items?.data ?? [];
    const products = lineItems
      .map(li => ({ name: li.price?.product?.name ?? li.description, zip: li.price?.product?.metadata?.zip }))
      .filter(p => p.zip);
    // Bookable educational sessions carry metadata.book (a duration key) and have no zip.
    const sessions = lineItems
      .map(li => ({ name: li.price?.product?.name ?? li.description, book: li.price?.product?.metadata?.book }))
      .filter(s => s.book);

    if (!products.length && !sessions.length) {
      return res.status(404).json({ error: 'No downloadable files or sessions are attached to this purchase — contact dev@webnomad.org with your receipt.' });
    }

    // Manifest mode
    if (!zip) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        paid: true,
        products,
        sessions,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_email: session.customer_details?.email ?? null,
      });
    }

    // Download mode — the requested zip must belong to this purchase
    if (!products.some(p => p.zip === zip)) {
      return res.status(403).json({ error: 'That file is not part of this purchase.' });
    }

    /* ⚠ THE OIDC FALLBACK IS NOT AUTOMATIC, WHATEVER THE OLD COMMENT HERE SAID.
       The SDK resolves credentials in this order: an explicit `token` wins (and the store id is
       derived FROM that token); otherwise it looks for an OIDC token, and OIDC additionally
       needs a store id from `options.storeId` or the `BLOB_STORE_ID` env var. With neither a
       read-write token NOR a store id, this get() THROWS.

       That matters more here than anywhere else in the codebase: this is a customer who has
       already paid, and the throw lands in the catch below as "Something went wrong verifying
       your purchase — please try again in a minute", which never comes right. Some of them
       will not email; they will just charge back.

       So if BLOB_READ_WRITE_TOKEN is ever removed from the Vercel project in favour of OIDC,
       BLOB_STORE_ID must be present FIRST, and a real download must be tested before the token
       is deleted. See Plans/Direct-Checkout-Migration.md. */
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
      console.error(
        '[download] FATAL: neither BLOB_READ_WRITE_TOKEN nor BLOB_STORE_ID is set. OIDC cannot ' +
        'resolve the blob store without a store id, so no customer can download their purchase.'
      );
    }
    const result = await get(`products/${zip}`, {
      access: 'private',
      token: process.env.BLOB_READ_WRITE_TOKEN, // absent → OIDC, which needs BLOB_STORE_ID
    });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return res.status(404).json({ error: 'File temporarily unavailable — please try again or contact dev@webnomad.org.' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zip}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-cache');
    Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    console.error('download endpoint error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Something went wrong verifying your purchase — please try again in a minute, or contact dev@webnomad.org with your receipt.' });
    }
    res.end();
  }
}
