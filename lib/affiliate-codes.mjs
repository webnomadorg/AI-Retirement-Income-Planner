/* Affiliate codes the public site may price from — code -> percent, nothing else.

   ONE document, written by the owner console and read by api/sale.mjs: the same arrangement as
   lib/sale-state.mjs, and for the same reason. A new affiliate's link shows the right prices with
   no deploy, and no Stripe key has to be added to the website.

   ⚠ WHY THE PERCENT IS NOT IN THE LINK. `?promo=X&off=90` would let anyone publish a page of ours
   showing prices checkout will not honor. The URL only names a code; this document says what it
   is worth.

   ⚠ ONLY ACTIVE AFFILIATE CODES EVER GO IN HERE. Sale codes are live in Stripe before their sale
   starts, and access codes can be 100% off, so an endpoint that answered for any code would be a
   way to test them. An unknown code gets exactly the answer no code gets.

   The document is derived, never a source of truth: tools/admin/affiliates.mjs rebuilds it from
   Stripe every time the Affiliates tab loads, so losing it costs one tab load.

   Env: BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID under OIDC) — see lib/blob-auth.mjs. */

import { put, get } from '@vercel/blob';
import { blobConfigured, blobToken } from './blob-auth.mjs';

export const CODES_PATH = 'affiliate-codes/public.json';

/* The console's code rule (CODE_RE in tools/admin/affiliates.mjs) and the one in assets/js/sale.js.
   Checked before any read, so junk in a query string costs nothing. */
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,29}$/;

/* Keeps a flood of made-up codes, each of which misses the edge cache, from becoming a flood of
   blob reads. Also why a deactivated code can take this long, plus the edge cache in api/sale.mjs,
   to stop showing its prices. */
const TTL_MS = 30_000;
let _cache = null;
let _cacheAt = 0;

function normalise(raw) {
  const out = {};
  const codes = raw && typeof raw === 'object' ? raw.codes : null;
  if (!codes || typeof codes !== 'object') return out;
  for (const [code, pct] of Object.entries(codes)) {
    const n = Number(pct);
    if (CODE_RE.test(code) && n > 0 && n < 100) out[code] = n;
  }
  return out;
}

/* ⚠ Must be get() with the token, NOT fetch(blob.downloadUrl), which 403s silently. Every failure
   reads as "no codes": the visitor then sees ordinary prices, which checkout will honor. */
export async function readCodes({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _cache && now - _cacheAt < TTL_MS) return _cache;
  let codes = {};
  if (blobConfigured()) {
    try {
      const r = await get(CODES_PATH, { access: 'private', token: blobToken() });
      if (r && r.statusCode === 200 && r.stream) {
        codes = normalise(JSON.parse(await new Response(r.stream).text()));
      }
    } catch { /* see above */ }
  }
  _cache = codes;
  _cacheAt = now;
  return codes;
}

export async function writeCodes(codes) {
  if (!blobConfigured()) {
    throw new Error('no blob credential: set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID for OIDC');
  }
  const clean = normalise({ codes });
  await put(CODES_PATH, JSON.stringify({ updated: new Date().toISOString(), codes: clean }, null, 2), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,                    // one document, rewritten in place
    addRandomSuffix: false,
    token: blobToken(),
  });
  return clean;
}

/** The percent an active affiliate code gives, or 0 if it is not one. */
export async function affiliatePercent(code) {
  const c = String(code || '').toUpperCase();
  if (!CODE_RE.test(c)) return 0;
  const codes = await readCodes();
  return Object.prototype.hasOwnProperty.call(codes, c) ? codes[c] : 0;
}

/* What api/sale.mjs answers with, in the same shape as a sale so sale.js can draw it the same way.
   endsAt is not a real deadline: the inline snippet in partials/header.html only reserves the bar's
   height for an offer with a future end date, and sale.js never shows this one. */
export function affiliateView(code, percent) {
  const c = String(code).toUpperCase();
  return {
    active: true,
    affiliate: true,
    id: `affiliate-${c}`,
    title: 'Your discount',
    percent,
    code: c,
    endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    icon: 'tag',
    url: `/products.html?promo=${encodeURIComponent(c)}`,
  };
}
