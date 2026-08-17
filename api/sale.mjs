/* Sale feed — GET /api/sale

   Tells every page whether a promotion is running right now, so the yellow bar below the nav
   can appear and disappear WITHOUT A DEPLOY. The owner console writes sale/state.json in the
   private Blob store; this reads it.

   Carries no personal data in either direction — it is public marketing copy and is identical
   for every visitor, which is why it can be cached at the edge and needs no cookie consent.

   FAILS CLOSED, BUT NEVER CACHES THE FAILURE.
   Any problem at all — no token, unreachable store, corrupt document — answers
   {active:false}, because a site with no banner is correct and a site with a wrong banner is
   not. That answer is sent `no-store` so a momentary blip cannot suppress a real sale for the
   length of the cache window.

   ?preview=<id> returns a sale regardless of the active flag and the date window, so a
   scheduled sale can be looked at on the live site before it goes out. For a MANUAL sale that
   is safe because the console creates its promotion code INACTIVE and only activates it when
   the sale starts — a leaked code from a preview link buys nobody a discount.

   ⚠ NOT TRUE OF AN AUTOMATED SALE. Its code is live in Stripe from the moment it is minted
   (see lib/sale-state.mjs), and its id is guessable — `?preview=black-friday-2027` would hand
   out a working discount months early. So an automated sale that has not started yet has its
   code MASKED here. The bar can still be checked for layout, which is all a preview is for.

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form crashes
   this project's runtime with FUNCTION_INVOCATION_FAILED. Same constraint as
   api/download.mjs and api/latest-version.mjs. */

import {
  readState, resolveActive, findSale, publicView, inWindow, maskCode,
} from '../lib/sale-state.mjs';

export default async function handler(req, res) {
  // Same reasoning as api/latest-version.mjs: nothing here is private or user-specific, and
  // the planner runs from file:// (Origin "null") should it ever want to read this too.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let state;
  try {
    state = await readState();
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ active: false });
  }

  const previewId = typeof req.query?.preview === 'string' ? req.query.preview : '';
  if (previewId) {
    const sale = findSale(state, previewId);
    // A preview must never be cached — it is a one-off look at something not yet public.
    res.setHeader('Cache-Control', 'no-store');
    if (!sale) return res.status(200).json({ active: false });
    const view = publicView(sale);
    // See the header: an automated code works the moment it exists, so it stays masked until
    // the window it belongs to actually opens.
    if (sale.auto && !inWindow(sale, Date.now())) view.code = maskCode(view.code);
    return res.status(200).json({ ...view, preview: true });
  }

  const live = resolveActive(state, new Date());
  if (!live) {
    // Short and revalidatable: a sale that starts in two minutes should not wait an hour.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ active: false });
  }

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json(publicView(live));
}
