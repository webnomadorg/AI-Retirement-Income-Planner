/* In-app update delivery — POST /api/update-download

   Body: { "email": "buyer@example.com" }
   200:  { ok: true, products: [ { name, zip, url } ] }
   404:  { error: "…" }   (no purchase found for that address)

   Lets someone running an installed copy of the planner fetch the current files
   knowing only the address they bought with. Called by the "Updates" tab in the app.

   Two lookups, in order:
     1. The email→sessions index in the private Blob store (lib/purchase-log.mjs),
        written by api/stripe-webhook.mjs as purchases happen.
     2. If that misses, Stripe itself — list Checkout Sessions filtered by
        customer_details[email]. This covers everyone who bought BEFORE the index
        existed, and anyone whose webhook write failed.

   What this endpoint hands back is a URL into the existing api/download.mjs, keyed by
   Checkout Session id. It therefore grants no new authority: download.mjs still
   re-verifies the session with Stripe and still checks the requested zip belongs to it.

   Security note, deliberately accepted: an email address alone unlocks that customer's
   files. It is roughly the exposure that already exists via a bookmarked thanks.html
   link, and the payload is a retail product rather than personal data. The throttle
   below blunts scripted enumeration; it does not claim to prevent it.

   Why POST and not GET: the address must not end up in a query string, where it would
   sit in Vercel access logs and browser history.

   Env:
     STRIPE_VERIFY_KEY     — restricted read-only key (Checkout Sessions)
     BLOB_READ_WRITE_TOKEN — Blob store access (falls back to OIDC)
     UPDATE_LOOKUP_PEPPER  — email-hashing secret, see lib/purchase-log.mjs

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form
   crashes this project's runtime with FUNCTION_INVOCATION_FAILED. */

import { readPurchaseLog } from '../lib/purchase-log.mjs';

const SITE = 'https://airetirementincomeplanner.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Coarse rate limit. Serverless instances are ephemeral and there may be several at
   once, so this is a speed bump, not a wall: it stops a single warm instance being
   hammered in a loop. A real limiter would need shared state we deliberately don't have. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 8;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    // Keep the map from growing without bound on a long-lived instance.
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return recent.length > RATE_MAX;
}

/** Ask Stripe directly which paid sessions belong to this address. */
async function sessionsFromStripe(email, stripeKey) {
  const auth = { headers: { Authorization: `Bearer ${stripeKey}` } };
  const listUrl =
    'https://api.stripe.com/v1/checkout/sessions' +
    `?customer_details[email]=${encodeURIComponent(email)}&status=complete&limit=20`;

  const listRes = await fetch(listUrl, auth);
  if (!listRes.ok) {
    console.error('update-download: session list failed', listRes.status, await listRes.text());
    return [];
  }
  const list = await listRes.json();
  // "no_payment_required" is what a 100%-off (zero-total) order reports instead of "paid" — see the
  // same note in download.mjs. The list call already filters status=complete, so no extra guard.
  const paid = (list.data ?? []).filter(
    (s) => s.payment_status === 'paid' || s.payment_status === 'no_payment_required',
  );

  // The list response doesn't carry line items, so each session is re-fetched expanded —
  // the same call api/download.mjs makes. Capped above at 20 sessions.
  const out = [];
  for (const s of paid) {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${s.id}?expand[]=line_items.data.price.product`,
      auth,
    );
    if (!r.ok) continue;
    const full = await r.json();
    const products = (full.line_items?.data ?? [])
      .map((li) => ({
        name: li.price?.product?.name ?? li.description,
        zip: li.price?.product?.metadata?.zip,
      }))
      .filter((p) => p.zip);
    if (products.length) {
      out.push({ id: s.id, ts: new Date((s.created ?? 0) * 1000).toISOString(), products });
    }
  }
  return out;
}

export default async function handler(req, res) {
  // The planner runs from file://, so its Origin is "null" — allow any origin. No cookies
  // or credentials are involved, so '*' costs nothing here.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // req.body is a lazy getter that THROWS when the platform can't parse the declared
    // Content-Type — so it needs its own try/catch, or a malformed body becomes a 500 for
    // what is really a client error. It may also hand back a raw string, so parse that too.
    let body;
    try { body = req.body; } catch { body = null; }
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    const email = String(body?.email || '').trim().toLowerCase();

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Too many checks just now — please wait a minute and try again.' });
    }

    const stripeKey = process.env.STRIPE_VERIFY_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: 'Updates are not configured yet — please contact dev@webnomad.org' });
    }

    // 1. The index. 2. Stripe, if the index has nothing.
    let sessions = (await readPurchaseLog(email))?.sessions ?? [];
    if (!sessions.length) {
      sessions = await sessionsFromStripe(email, stripeKey);
    }

    if (!sessions.length) {
      return res.status(404).json({
        error:
          "We couldn't find a purchase for that address. Check it matches the email you " +
          'bought with, or contact dev@webnomad.org with your receipt and we\'ll sort it out.',
      });
    }

    // Newest first, then one entry per zip — if a customer bought the same product twice,
    // the most recent session is the one whose link we hand back.
    sessions.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const seen = new Set();
    const products = [];
    for (const s of sessions) {
      for (const p of s.products || []) {
        if (!p.zip || seen.has(p.zip)) continue;
        seen.add(p.zip);
        products.push({
          name: p.name,
          zip: p.zip,
          // Absolute — the caller is a file:// page, where a relative path would
          // resolve against the local filesystem.
          url: `${SITE}/api/download?session_id=${encodeURIComponent(s.id)}&zip=${encodeURIComponent(p.zip)}`,
        });
      }
    }

    if (!products.length) {
      return res.status(404).json({
        error:
          'That address has a purchase on file, but no downloadable files are attached to it. ' +
          'Please contact dev@webnomad.org with your receipt.',
      });
    }

    return res.status(200).json({ ok: true, products });
  } catch (err) {
    console.error('update-download endpoint error:', err);
    return res.status(500).json({
      error: 'Something went wrong looking up your purchase — please try again in a minute, or contact dev@webnomad.org.',
    });
  }
}
