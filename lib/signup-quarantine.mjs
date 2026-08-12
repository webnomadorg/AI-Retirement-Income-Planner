/* Signup quarantine log — what the guard blocked, and what it let through.

   WHY A LOG IS PART OF THE FEATURE, NOT AN EXTRA
   A spam filter fails in two directions and only one of them is visible. Junk that gets
   through is obvious; a real subscriber wrongly rejected is completely silent — they see a
   generic error, shrug, and never come back. Without this log the only way to discover an
   over-aggressive rule would be a customer complaining, and most never do. Anything that
   silently discards a would-be subscriber has to be observable, so every decision is
   recorded with the reason attached.

   WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
   No plaintext addresses. A blocked signup is, by definition, from someone who never
   confirmed anything, and keeping a list of their addresses would be collecting personal
   data from people specifically identified as not having consented — the opposite of the
   promise this site sells on. Each record keeps:
     • the reason and a masked address (`a***9@gmail.com`) — enough to judge a false positive
     • the full domain — pattern-spotting is domain-level
     • an HMAC of the CANONICAL address — non-reversible, but equal for every dotted variant,
       which is exactly what makes the Gmail-dot abuse legible: forty blocks sharing one hash
       is one person, not forty.
   No IP, no user agent, no cookie.

   Layout: signup-log/<YYYY-MM-DD>/<epoch>-<rand>.json — one blob per event. Signup volume is
   a few a day, unlike search queries, so batching would add complexity and buy nothing.

   Env: BLOB_READ_WRITE_TOKEN (private Blob store) */

import { put, list, get } from '@vercel/blob';
import { maskEmail } from './signup-guard.mjs';

const PREFIX = 'signup-log/';
const CLAIM_PREFIX = 'signup-claim/';

export function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/* Every write here is best-effort. Logging is observability, not the product: a Blob outage
   must never turn into a failed signup for a real person. */
export async function logEvent(entry) {
  if (!isConfigured()) return null;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const key = `${PREFIX}${day}/${now.getTime()}-${Math.random().toString(36).slice(2, 10)}.json`;
  const record = {
    v: 1,
    at: now.toISOString(),
    event: entry.event,                        // blocked | pending | confirmed | lead-ads
    reason: entry.reason || '',
    masked: entry.email ? maskEmail(entry.email) : '',
    domain: entry.domain || '',
    magnet: entry.magnet || '',
    hash: entry.hash || '',
    tokenState: entry.tokenState || '',
    note: entry.note || '',
  };
  try {
    await put(key, JSON.stringify(record), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return key;
  } catch (err) {
    console.error('[signup-log] write failed (non-fatal):', err?.message || err);
    return null;
  }
}

/* ------------------------------------------------------ one confirm email per day cap --- */

/* Stops this endpoint being turned INTO the abuse.

   Canonicalising means a hundred dotted variants all resolve to one real inbox — which is
   good for the mailing list, but it also means a script firing a hundred signups would have
   us send a hundred confirmation emails to one victim. That is subscription bombing, and we
   would be the weapon. So a confirmation for a given address+magnet may be sent once per day
   and no more.

   The mechanism is the storage layer, not a read-then-write check. `allowOverwrite: false`
   makes the PUT itself fail when the key already exists, which is atomic — the same trick
   the affiliate payout ledger uses to make a double payment impossible. A read-first check
   could not work here anyway: a freshly written blob takes ~2.4s to become readable, so two
   requests a second apart would both read "nothing there" and both send.

   The magnet is part of the key so someone genuinely collecting two different downloads on
   the same day still gets both.

   ⚠ FAILS OPEN. Any error that is not a clear key conflict allows the send — an
   unconfigured or wobbling Blob store must not silently stop confirmation emails, because
   that failure mode looks exactly like "the signup form is broken" and would be invisible. */
export async function claimConfirmSend(canonicalEmail, magnet, hash) {
  if (!isConfigured()) return true;
  const day = new Date().toISOString().slice(0, 10);
  const id = hash || Buffer.from(String(canonicalEmail)).toString('base64url').slice(0, 32);
  const key = `${CLAIM_PREFIX}${day}/${magnet || 'ebook'}-${id}.json`;
  try {
    await put(key, JSON.stringify({ at: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return true;
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    const name = String(err?.name || '').toLowerCase();
    if (msg.includes('already exist') || msg.includes('blob already') || name.includes('alreadyexists')) {
      return false;                            // genuine duplicate — hold the send
    }
    console.error('[signup-claim] unexpected error, allowing send:', err?.message || err);
    return true;
  }
}

/* ------------------------------------------------------------------------ aggregation --- */

export async function listRecords(days = 30) {
  const { blobs } = await list({ prefix: PREFIX, token: process.env.BLOB_READ_WRITE_TOKEN });
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return (blobs || [])
    .filter((b) => String(b.pathname || '').slice(PREFIX.length, PREFIX.length + 10) >= cutoff)
    .sort((a, b) => String(b.pathname).localeCompare(String(a.pathname)));
}

/* Tally for the owner console.

   `repeatOffenders` is the headline number: canonical hashes seen more than once. A high
   count against one hash is the dot-variant abuse, now collapsed into a single row instead
   of scattered across forty apparently unrelated signups. */
export async function aggregate(days = 30) {
  const items = await listRecords(days);
  const byReason = new Map();
  const byDomain = new Map();
  const byHash = new Map();
  const byDay = new Map();
  const recent = [];
  let blocked = 0;
  let pending = 0;
  let confirmed = 0;

  for (const b of items) {
    let rec;
    try {
      // ⚠ get() with the token, NOT fetch(downloadUrl). A private blob's URL returns 403 to
      // an unauthenticated request, so a plain fetch fails silently and the whole panel
      // reads as "nothing here" whatever is actually stored.
      const r = await get(b.pathname, {
        access: 'private',
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (!r || r.statusCode !== 200 || !r.stream) continue;
      rec = JSON.parse(await new Response(r.stream).text());
    } catch { continue; }
    if (!rec) continue;

    const day = String(b.pathname).slice(PREFIX.length, PREFIX.length + 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);

    if (rec.event === 'blocked') blocked += 1;
    else if (rec.event === 'pending') pending += 1;
    else if (rec.event === 'confirmed') confirmed += 1;

    if (rec.event === 'blocked' && rec.reason) {
      byReason.set(rec.reason, (byReason.get(rec.reason) || 0) + 1);
    }
    if (rec.domain) byDomain.set(rec.domain, (byDomain.get(rec.domain) || 0) + 1);
    if (rec.hash) {
      const e = byHash.get(rec.hash) || { hash: rec.hash, count: 0, domain: rec.domain, masked: rec.masked };
      e.count += 1;
      byHash.set(rec.hash, e);
    }
    if (recent.length < 200) recent.push({ ...rec, day });
  }

  const desc = (m) => [...m.entries()].map(([k, n]) => ({ key: k, count: n })).sort((a, b) => b.count - a.count);

  return {
    days,
    total: items.length,
    blocked,
    pending,
    confirmed,
    // Of everyone who was sent a confirmation, how many clicked it. The honest measure of
    // how much of the old list was real.
    confirmRate: pending ? Math.round((confirmed / pending) * 100) : null,
    reasons: desc(byReason),
    domains: desc(byDomain).slice(0, 40),
    repeatOffenders: [...byHash.values()].filter((e) => e.count > 1).sort((a, b) => b.count - a.count).slice(0, 40),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    recent,
  };
}
