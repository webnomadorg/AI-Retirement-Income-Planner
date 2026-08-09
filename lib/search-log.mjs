/* Sitewide search analytics — storage helpers.

   Answers one question: what are people searching for, and what are they searching for and
   NOT finding? A zero-result query is the highest-signal thing this site can learn — it is a
   visitor telling us, in their own words, about a page we have not written.

   WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
   Each record holds only the query text, how many results it returned, and a coarse
   timestamp. There is no IP address, no user agent, no cookie, no session identifier and
   nothing that could link two searches to the same person. That is not incidental: this site
   sells on a privacy promise, and analytics that quietly builds a per-visitor profile would
   contradict the product. Because no identifier is stored and the records cannot be tied to a
   person, this is not personal data and does not require cookie consent — but see
   `scrubbable()`, which drops the one case where a query could carry personal data anyway.

   Layout: search-log/<YYYY-MM-DD>/<epoch>-<rand>.json
   One blob per BATCH, not per query — the client accumulates a page-session's searches and
   flushes once. That keeps writes low and makes aggregation cheap.

   Env: BLOB_READ_WRITE_TOKEN (private Blob store) */

import { put, list } from '@vercel/blob';

const PREFIX = 'search-log/';
export const MAX_QUERY = 80;
export const MIN_QUERY = 2;
export const MAX_BATCH = 25;

export function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/* True when a query must NOT be stored at all.

   A search box is a free-text field, and people paste things into free-text fields. An email
   address or a long digit run (a card, a phone, an SSN) typed in by mistake is the one way a
   query could carry personal data. Redacting it would still leave the rest of the string, so
   the safer move is to drop the whole record: the analytics value of one malformed query is
   nil, and the downside of storing it is not. */
export function scrubbable(q) {
  return /[^\s@]+@[^\s@]+\.[^\s@]/.test(q)   // looks like an email
      || /\d[\d\s-]{5,}/.test(q);            // 6+ digits, allowing spaces/dashes
}

export function cleanQuery(raw) {
  const q = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY)
    .toLowerCase();
  if (q.length < MIN_QUERY) return null;
  if (scrubbable(q)) return null;
  return q;
}

/** Normalise a client batch into storable items. Returns [] when nothing survives. */
export function cleanBatch(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items.slice(0, MAX_BATCH)) {
    const q = cleanQuery(it?.q);
    if (!q) continue;
    const n = Number(it?.n);
    out.push({ q, n: Number.isFinite(n) && n >= 0 ? Math.min(n, 9999) : 0 });
  }
  return out;
}

export async function writeBatch(items) {
  if (!items.length) return null;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `${PREFIX}${day}/${now.getTime()}-${Math.random().toString(36).slice(2, 10)}.json`;
  const record = { v: 1, at: now.toISOString(), items };
  await put(key, JSON.stringify(record), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: false,
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return key;
}

/** Every batch blob from the last `days` days, newest first. */
export async function listBatches(days = 30) {
  const { blobs } = await list({ prefix: PREFIX, token: process.env.BLOB_READ_WRITE_TOKEN });
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return (blobs || [])
    .filter((b) => String(b.pathname || '').slice(PREFIX.length, PREFIX.length + 10) >= cutoff)
    .sort((a, b) => String(b.pathname).localeCompare(String(a.pathname)));
}

/* Tally the raw batches into something worth looking at.

   Zero-result queries are reported separately and first, because they are the actionable
   half: a popular query with results means the content is working, a popular query with none
   is a content gap with a vote count attached. */
export async function aggregate(days = 30) {
  const batches = await listBatches(days);
  const all = new Map();     // q -> { q, count, zero, results }
  const byDay = new Map();   // YYYY-MM-DD -> count
  let searches = 0;

  for (const b of batches) {
    let rec;
    try {
      const r = await fetch(b.downloadUrl || b.url);
      if (!r.ok) continue;
      rec = await r.json();
    } catch { continue; }

    const day = String(b.pathname).slice(PREFIX.length, PREFIX.length + 10);
    for (const it of rec?.items || []) {
      const q = String(it?.q || '');
      if (!q) continue;
      searches += 1;
      byDay.set(day, (byDay.get(day) || 0) + 1);
      const e = all.get(q) || { q, count: 0, zero: 0, results: 0 };
      e.count += 1;
      if (Number(it.n) === 0) e.zero += 1; else e.results = Math.max(e.results, Number(it.n) || 0);
      all.set(q, e);
    }
  }

  const rows = [...all.values()].sort((a, b) => b.count - a.count || a.q.localeCompare(b.q));
  return {
    days,
    searches,
    unique: rows.length,
    // "Found nothing every time it was tried" — a query that sometimes works is not a gap.
    misses: rows.filter((r) => r.zero === r.count).sort((a, b) => b.count - a.count),
    top: rows.slice(0, 100),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    batches: batches.length,
  };
}
