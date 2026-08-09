/* Sitewide search analytics intake — POST /api/search-log

   Body: { items: [ { q: "roth conversion", n: 8 }, … ] }
   204:  always, on success — the client uses navigator.sendBeacon and never reads a response.

   Records what visitors search for and, more usefully, what they search for and do not find.
   Only the query text and its result count are stored: no IP, no user agent, no cookie, no
   session id, nothing that links two searches to one person. See lib/search-log.mjs for why
   that is a deliberate design constraint rather than an omission, and for the one case
   (a query that looks like it contains an email or a long digit run) that is dropped entirely.

   FAILS SILENTLY BY DESIGN. Analytics must never be visible to a visitor. Every error path
   returns 204 — an unconfigured Blob token, a malformed body, a rate limit — because the
   alternative is a console error on a marketing page in exchange for data nobody is waiting on.
   Real faults are logged server-side where they can be seen without bothering anyone.

   Env: BLOB_READ_WRITE_TOKEN — private Blob store

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form
   crashes this project's runtime with FUNCTION_INVOCATION_FAILED. */

import { cleanBatch, writeBatch, isConfigured } from '../lib/search-log.mjs';

/* Coarse rate limit, same shape and same caveat as the other endpoints: serverless instances
   are ephemeral, so this is a speed bump against one warm instance being hammered, not a wall.
   Generous, because a single visitor legitimately sends one batch per page. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return recent.length > RATE_MAX;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!isConfigured()) return res.status(204).end();

    // The IP is used for rate limiting only, in memory, for at most 60 seconds. It is never
    // written to the log — that is the whole point of the storage design.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) return res.status(204).end();

    // req.body is a lazy getter that THROWS when the platform cannot parse the declared
    // Content-Type, and sendBeacon may send text/plain, so parse defensively.
    let body;
    try { body = req.body; } catch { body = null; }
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const items = cleanBatch(body?.items);
    if (items.length) await writeBatch(items);

    return res.status(204).end();
  } catch (err) {
    console.error('search-log:', err);
    return res.status(204).end();
  }
}
