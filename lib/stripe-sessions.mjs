/* Stripe Checkout Session lookup by email — used by api/feedback.mjs to stamp a
   "did this person actually buy?" verdict onto a feedback submission.

   ⚠ THIS IS A DELIBERATE COPY of the sessionsFromStripe() helper inlined in
   api/update-download.mjs. It was NOT extracted into a shared module, because
   update-download.mjs is the endpoint that hands paying customers their files and
   feedback verification is advisory by comparison — the asymmetry didn't justify
   editing the delivery path. The cost of that choice is this note: if you change the
   lookup here, check whether api/update-download.mjs needs the same change, and vice
   versa. There is a matching comment there pointing back at this file.

   Lives outside api/ on purpose: every file inside Website/api/ becomes a public route.

   Env:
     STRIPE_VERIFY_KEY — restricted read-only key (Checkout Sessions). Passed in by the
                         caller rather than read here, so this module stays a pure lookup. */

/** Ask Stripe directly which paid sessions belong to this address. Never throws. */
export async function sessionsFromStripe(email, stripeKey) {
  const auth = { headers: { Authorization: `Bearer ${stripeKey}` } };
  const listUrl =
    'https://api.stripe.com/v1/checkout/sessions' +
    `?customer_details[email]=${encodeURIComponent(email)}&status=complete&limit=20`;

  const listRes = await fetch(listUrl, auth);
  if (!listRes.ok) {
    console.error('stripe-sessions: session list failed', listRes.status, await listRes.text());
    return [];
  }
  const list = await listRes.json();
  // "no_payment_required" is what a 100%-off (zero-total) order reports instead of "paid" —
  // see the same note in api/download.mjs. The list call already filters status=complete.
  const paid = (list.data ?? []).filter(
    (s) => s.payment_status === 'paid' || s.payment_status === 'no_payment_required',
  );

  // The list response doesn't carry line items, so each session is re-fetched expanded.
  // Capped above at 20 sessions.
  const out = [];
  for (const s of paid) {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${s.id}?expand[]=line_items.data.price.product`,
      auth,
    );
    if (!r.ok) continue;
    const full = await r.json();
    const products = (full.line_items?.data ?? [])
      .map((li) => li.price?.product?.name ?? li.description)
      .filter(Boolean);
    out.push({ id: s.id, ts: new Date((s.created ?? 0) * 1000).toISOString(), products });
  }
  return out;
}
