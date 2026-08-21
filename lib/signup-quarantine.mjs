/* Signup quarantine log — what the guard blocked, and what got through.

   WHY A LOG IS PART OF THE FEATURE, NOT AN EXTRA
   A spam filter fails in two directions and only one of them is visible. Junk that gets
   through is obvious; a real subscriber wrongly rejected is completely silent — they see a
   generic error, shrug, and never come back. Without this log the only way to discover an
   over-aggressive rule would be a customer complaining, and most never do. Anything that
   silently discards a would-be subscriber has to be observable, so every decision is
   recorded with the reason attached.

   WHAT IS STORED
   The full address, plus the domain and an HMAC of the CANONICAL form (equal for every
   dotted Gmail variant, which is what collapses one person's forty attempts into one row).

   ⚠ The address used to be masked here. That was over-cautious and it cost more than it
   bought: this console is loopback-only with no password, so masking defends against an
   attacker who would already have the machine and could read the raw blobs anyway — while
   making it impossible to answer "did Jane's signup get blocked?" or to reply to someone the
   guard wrongly rejected. The real privacy control is RETENTION, not redaction: records are
   deleted automatically after 90 days, which bounds the exposure in a way masking never did.

   ⚠ THE PATHNAME CARRIES THE EVENT AND REASON, AND THAT IS LOad-BEARING.
   Layout: signup-log/<YYYY-MM-DD>/<event>__<reason>__<epoch>-<rand>.json
   Vercel Blob's list() returns pathnames WITHOUT fetching contents, so counts per day, per
   event and per reason cost exactly one list() call no matter how many records exist. Only
   the day the owner actually opens gets read. The previous version read every blob in the
   window on every page load — one HTTP round trip per signup — which was fine at three
   records and would have timed the tab out at a few thousand.

   Env: BLOB_READ_WRITE_TOKEN (private Blob store) */

import { put, list, get, del } from '@vercel/blob';
import { keyId } from './signup-guard.mjs';

const PREFIX = 'signup-log/';
const CLAIM_PREFIX = 'signup-claim/';
/* Permanent, and deliberately NOT swept by purgeExpired() — see claimConfirmOnce(). */
const CONFIRMED_PREFIX = 'signup-confirmed/';

/** Records are deleted after this many days. This is the privacy control — see the note above. */
export const RETENTION_DAYS = 90;

export function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

const token = () => process.env.BLOB_READ_WRITE_TOKEN;
const dayOf = (pathname) => String(pathname).slice(PREFIX.length, PREFIX.length + 10);

/** A 16-hex key id, distinguishable from the `<epoch>-<rand>` tail that follows it. */
const KID_RE = /^[0-9a-f]{16}$/;

/* Everything a pathname can tell us, WITHOUT reading the record.

   ⚠ Handles both layouts. Records written before 21 Aug 2026 are
   `<event>__<reason>__<epoch>-<rand>` — three fields, no key id — so `kid` comes back empty
   for them and they can never be attributed to a person. That is a real limitation, not a
   bug to work around: the information was never written down. Anything built on this must
   say "no record" for those, never "clean". */
export function parseKey(pathname) {
  /* Accepts either the pathname string or the blob object list() returns. Being forgiving
     here is deliberate: passing the object is an easy slip, and its failure mode is silent —
     "[object Object]" parses without throwing and yields plausible-looking empty fields. */
  if (pathname && typeof pathname === 'object' && pathname.pathname) pathname = pathname.pathname;
  const day = dayOf(pathname);
  const file = String(pathname).slice(PREFIX.length + 11);
  const parts = file.replace(/\.json$/, '').split('__');
  const [event = 'other', reason = 'none'] = parts;
  const kid = parts.length > 3 && KID_RE.test(parts[2]) ? parts[2] : '';
  /* ⚠ The timestamp is the LAST field, never a fixed index. logEvent writes the literal
     'nokid' when an address cannot be canonicalised, which is a fourth field that is not a
     key id — indexing by `kid ? 3 : 2` read 'nokid' as the timestamp and silently produced
     epoch 0, losing the time on exactly the records least likely to be looked at. */
  const tail = parts[parts.length - 1] || '';
  const epoch = Number(String(tail).split('-')[0]) || 0;
  return { pathname, day, event, reason, kid, epoch };
}

/** Keep pathname segments safe and, critically, free of the "__" field separator. */
function slug(v, fallback) {
  const s = String(v ?? '').replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s || fallback;
}

/* ------------------------------------------------------------------- request fingerprint --- */

/* Pull the bot-spotting fields off an incoming request.

   WHY THESE FIVE
   A timestamp alone cannot separate a person from a script, because a script is only
   suspicious relative to something. Each of these supplies the "relative to":
     ip       — the same address hitting several forms in one minute is the single clearest
                tell. It is also what lets a genuine mistake be told apart from an attack.
     ua       — an empty, ancient, or library-shaped user agent (python-requests, curl,
                headless Chrome) is close to a confession. A real browser sends a long one.
     country  — Vercel geolocates at the edge for free. A signup for a US-retirement product
                from a country with no plausible audience, at 4am local, is a signal.
     lang     — a browser sends Accept-Language; most scripts send nothing at all.
     ref      — which page the form was on. A submission with no referer never came from
                one of our pages.
   None of it is conclusive on its own. Together they turn "an address I do not recognise"
   into an answerable question.

   ⚠ x-forwarded-for is a CHAIN (client, proxy, proxy…), and the client half is attacker-
   controlled — anyone can send one. Take the FIRST entry and treat it as a hint, never as
   proof of identity. On Vercel, x-real-ip is set by the platform and is the trustworthy one,
   so prefer it when present.

   ⚠ An IP is PERSONAL DATA in the UK/EU. It is kept for the abuse-prevention purpose these
   records exist for, under the SAME 90-day retention as the rest of the log (that purge is
   what keeps this proportionate), and it is disclosed in the privacy policy. If that ever
   feels too broad, `ip.replace(/\.\d+$/, '.0')` keeps the network and drops the household —
   enough to spot a repeat, not enough to identify one. */
export function requestMeta(req) {
  const h = (req && req.headers) || {};
  const one = (v) => (Array.isArray(v) ? v[0] : v) || '';
  const fwd = String(one(h['x-forwarded-for'])).split(',')[0].trim();
  return {
    ip: (String(one(h['x-real-ip'])).trim() || fwd).slice(0, 45),   // 45 = max IPv6 text length
    ua: String(one(h['user-agent'])).slice(0, 300),
    country: String(one(h['x-vercel-ip-country'])).slice(0, 8),
    lang: String(one(h['accept-language'])).slice(0, 64),
    ref: String(one(h.referer) || one(h.origin)).slice(0, 200),
  };
}

/* Every write here is best-effort. Logging is observability, not the product: a Blob outage
   must never turn into a failed signup for a real person. */
export async function logEvent(entry) {
  if (!isConfigured()) return null;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ev = slug(entry.event, 'event');
  const reason = slug(entry.reason, 'none');
  /* ⚠ The key id goes in the PATHNAME for the same reason the event and reason do: list()
     returns pathnames without fetching anything, so putting it here is what makes "show me
     everything this person ever submitted" cost zero reads. One record read costs ~350ms
     against this store, so a feature that had to read the window to answer that — 358 records
     over nine days, and growing — would take two minutes and get worse every week. Computed
     from the CANONICAL address, so every dotted variant of one mailbox shares an id. */
  const kid = keyId(entry.email) || 'nokid';
  const key = `${PREFIX}${day}/${ev}__${reason}__${kid}__${now.getTime()}-${Math.random().toString(36).slice(2, 10)}.json`;
  const record = {
    v: 3,
    at: now.toISOString(),
    event: entry.event,                        // blocked | pending | confirmed
    reason: entry.reason || '',
    email: entry.email || '',                  // full address — see the retention note above
    domain: entry.domain || '',
    magnet: entry.magnet || '',
    hash: entry.hash || '',
    tokenState: entry.tokenState || '',
    note: entry.note || '',
    /* v3 — the request fingerprint. Empty on every v1/v2 record, and on any caller that does
       not pass one, so read these as "not recorded" rather than "none". */
    ip: entry.ip || '',
    ua: entry.ua || '',
    country: entry.country || '',
    lang: entry.lang || '',
    ref: entry.ref || '',
    fillMs: Number.isFinite(entry.fillMs) ? entry.fillMs : null,
    kid,
  };
  try {
    await put(key, JSON.stringify(record), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: token(),
    });
    return key;
  } catch (err) {
    console.error('[signup-log] write failed (non-fatal):', err?.message || err);
    return null;
  }
}

/* ------------------------------------------------------ one confirm email per day cap --- */

export async function claimConfirmSend(canonicalEmail, magnet, hash) {
  const id = hash || Buffer.from(String(canonicalEmail)).toString('base64url').slice(0, 32);
  return claimDailySend(magnet || 'ebook', id);
}

/* The same one-per-day guarantee, for any caller that emails an address it was handed.

   api/contact.mjs uses it for the courtesy auto-reply. ⚠ It caps ONLY that reply, never the
   notification to dev@webnomad.org: two genuine enquiries in one day must both reach the
   owner, and silently dropping the second would be a support failure far worse than the
   abuse it guards against. The auto-reply is the half that gets aimed at a victim, because
   it goes to an address the sender chose and quotes text the sender wrote.

   The mechanism is the storage layer, not a read-then-write check. `allowOverwrite: false`
   makes the PUT itself fail when the key already exists, which is atomic — the same trick
   the affiliate payout ledger uses to make a double payment impossible. A read-first check
   could not work here anyway: a freshly written blob takes ~2.4s to become readable, so two
   requests a second apart would both read "nothing there" and both send.

   ⚠ FAILS OPEN. Any error that is not a clear key conflict allows the send — an
   unconfigured or wobbling Blob store must not silently stop confirmation emails, because
   that failure mode looks exactly like "the signup form is broken" and would be invisible. */
export async function claimDailySend(namespace, id) {
  if (!isConfigured()) return true;
  const day = new Date().toISOString().slice(0, 10);
  const safeNs = slug(namespace, 'default');
  const key = `${CLAIM_PREFIX}${day}/${safeNs}-${id}.json`;
  try {
    await put(key, JSON.stringify({ at: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: token(),
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

/* ------------------------------------------------------ one confirmation per address --- */

/* Has this address already been confirmed for this magnet? Claim it if not.

   WHY THIS EXISTS — a real case, on 20 Aug 2026.
   A confirmation link is valid for seven days and, until this, could be redeemed as many
   times as it was clicked. Every click re-wrote the subscriber to MailerLite and sent
   another "new signup" notification, so ONE person appeared in the inbox as two signups.
   That is not a hypothetical: it is what a link scanner does. Corporate mail security
   (Defender Safe Links, Barracuda, Proofpoint) fetches every URL in an inbound message to
   see where it goes, often more than once and often hours apart. The click looks perfect —
   real IP, browser-shaped user agent — because it IS a real fetch.

   Keyed by the HMAC of the address, so this file holds no address, no name and no IP, which
   is why it is the one thing here with no retention limit: it must outlive the 90-day log or
   the duplicate comes back on day 91.

   ⚠ CLAIM AFTER THE MAILERLITE WRITE SUCCEEDS, never before. Claiming first would mean a
   MailerLite outage burned the only attempt, and the person's retry would be told "already
   done" while they were on no list at all.

   ⚠ FAILS OPEN, like every other claim here: an unexplained storage error lets the
   confirmation through. A duplicate notification is a nuisance; a confirmation refused by
   accident loses a subscriber who did everything right. */
export async function claimConfirmOnce(hash, magnet) {
  if (!isConfigured()) return true;
  if (!hash) return true;
  const key = `${CONFIRMED_PREFIX}${slug(magnet, 'ebook')}-${slug(hash, 'x')}.json`;
  try {
    await put(key, JSON.stringify({ at: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: token(),
    });
    return true;
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    const name = String(err?.name || '').toLowerCase();
    if (msg.includes('already exist') || msg.includes('blob already') || name.includes('alreadyexists')) {
      return false;                            // already confirmed once — do it all again for nobody
    }
    console.error('[signup-confirmed] unexpected error, allowing:', err?.message || err);
    return true;
  }
}

/* ---------------------------------------------------------------------------- purge --- */

/* Delete everything past the retention window. This IS the privacy control, so it runs
   automatically whenever the overview is read rather than waiting for someone to press a
   button — a retention policy nobody remembers to apply is not a retention policy. The count
   is reported back so the deletion is visible rather than silent.

   Also sweeps the one-per-day claim keys, which are pure throttle state with no value at all
   once their day has passed. */
export async function purgeExpired() {
  if (!isConfigured()) return 0;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  let removed = 0;
  for (const prefix of [PREFIX, CLAIM_PREFIX]) {
    try {
      const { blobs } = await list({ prefix, token: token() });
      const stale = (blobs || [])
        .filter((b) => String(b.pathname).slice(prefix.length, prefix.length + 10) < cutoff)
        .map((b) => b.pathname);
      // del() takes a batch, so this is a couple of calls rather than one per blob.
      for (let i = 0; i < stale.length; i += 100) {
        await del(stale.slice(i, i + 100), { token: token() });
        removed += Math.min(100, stale.length - i);
      }
    } catch (err) {
      console.error('[signup-log] purge failed (non-fatal):', err?.message || err);
    }
  }
  return removed;
}

/* ------------------------------------------------------------------------ overview --- */

/* Per-day counts for the whole window, from pathnames alone — NO record is fetched.

   This is why the event and reason live in the filename. At a few thousand records this
   still costs one list() call; the previous shape cost one HTTP request per record and would
   not have survived the volume the owner is expecting. */
export async function overview(days = 30) {
  if (!isConfigured()) return { configured: false, days, totals: {}, byDay: [], purged: 0 };
  const purged = await purgeExpired();
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const { blobs } = await list({ prefix: PREFIX, token: token() });

  const byDay = new Map();
  const totals = { blocked: 0, pending: 0, confirmed: 0, other: 0 };
  const reasons = new Map();

  for (const b of blobs || []) {
    const day = dayOf(b.pathname);
    if (day < cutoff) continue;
    const { event, reason } = parseKey(b.pathname);
    const bucket = byDay.get(day) || { day, blocked: 0, pending: 0, confirmed: 0, other: 0, total: 0 };
    const key = ['blocked', 'pending', 'confirmed'].includes(event) ? event : 'other';
    bucket[key] += 1;
    bucket.total += 1;
    byDay.set(day, bucket);
    totals[key] += 1;
    if (key === 'blocked') reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }

  const pending = totals.pending;
  return {
    configured: true,
    days,
    retentionDays: RETENTION_DAYS,
    purged,
    totals,
    // Of everyone sent a confirmation, how many clicked. A sharp drop means the confirmation
    // email has stopped arriving — the one failure that otherwise looks like "signups went quiet".
    confirmRate: pending ? Math.round((totals.confirmed / pending) * 100) : null,
    reasons: [...reasons.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    byDay: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
  };
}

/* Full records for ONE day. The only call that fetches contents, and it is made when the
   owner expands a day — so the cost is proportional to what is being looked at, not to how
   much history exists. */
export async function readDay(day) {
  if (!isConfigured()) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return [];
  const { blobs } = await list({ prefix: `${PREFIX}${day}/`, token: token() });
  const out = [];
  for (const b of blobs || []) {
    try {
      // ⚠ get() with the token, NOT fetch(downloadUrl). A private blob's URL returns 403 to
      // an unauthenticated request, so a plain fetch fails silently and the panel reads as
      // "nothing here" whatever is actually stored.
      const r = await get(b.pathname, { access: 'private', token: token() });
      if (!r || r.statusCode !== 200 || !r.stream) continue;
      const rec = JSON.parse(await new Response(r.stream).text());
      // v1 records predate the full-address change and only carry a masked form.
      out.push({ ...rec, email: rec.email || rec.masked || '(not recorded)' });
    } catch { continue; }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ------------------------------------------------------------------ bot signals --- */

/* Reasons that mean something automated, as opposed to something merely unwanted.

   The honeypot is the strongest of these by a distance: the field is invisible, so a person
   filling it in has to be a machine reading the HTML. ⚠ It is not *quite* conclusive — an
   aggressive password manager or autofill extension can fill hidden fields — which is exactly
   why this module FLAGS and never acts. A wrongly-stopped subscriber is silent, and silent
   failures are the thing this whole log exists to prevent. */
const AUTOMATED_REASONS = new Set(['honeypot', 'submitted-too-fast', 'token-forged']);

/** Several submissions this close together are not a person changing their mind. */
const BURST_MS = 60_000;
const BURST_COUNT = 3;

/* A verdict per person, from pathnames ALONE — one list() call, zero record reads.

   Pass the addresses you care about (the nurture worklist, say) and get back a Map keyed by
   the address you passed in. Everything is derived from what the pathname already carries:
   event, reason, key id and timestamp.

   ⚠ THE FOUR VERDICTS ARE NOT A SCORE, and 'unknown' is not a mild version of 'clean':
     'automated' — tripped the honeypot, beat the timer, or forged a token. Near-conclusive.
     'odd'       — a burst of submissions, or a lot of them, but nothing conclusive.
     'clean'     — records exist for this person and none of them raised anything.
     'unknown'   — NOTHING IS RECORDED. Either they signed up before 21 Aug 2026 (when the
                   key id went into the pathname), or they arrived by a route that writes no
                   fingerprint, such as Facebook Lead Ads. Never render this as reassurance.
   Most of an existing list will be 'unknown' for a long time. That is honest, and a UI that
   quietly turned it into a green tick would be worse than showing nothing at all. */
export async function botSignals(emails, days = RETENTION_DAYS) {
  const out = new Map();
  const wanted = new Map();                    // kid -> [address, …]
  for (const raw of emails || []) {
    const kid = keyId(raw);
    out.set(raw, { verdict: 'unknown', events: 0, automated: 0, reasons: [], firstAt: null, lastAt: null, burst: 0, repeatClicks: 0, kid });
    if (!kid) continue;
    wanted.set(kid, [...(wanted.get(kid) || []), raw]);
  }
  if (!isConfigured() || !wanted.size) return out;

  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  let blobs = [];
  try { ({ blobs } = await list({ prefix: PREFIX, token: token() })); }
  catch (err) { console.error('[signup-log] botSignals list failed:', err?.message || err); return out; }

  const hits = new Map();                      // kid -> parsed records
  for (const b of blobs || []) {
    const rec = parseKey(b.pathname);
    if (rec.day < cutoff || !rec.kid || !wanted.has(rec.kid)) continue;
    hits.set(rec.kid, [...(hits.get(rec.kid) || []), rec]);
  }

  for (const [kid, recs] of hits) {
    const summary = { ...verdictFor(recs), kid };
    for (const addr of wanted.get(kid) || []) out.set(addr, summary);
  }
  return out;
}

/* The judgement itself, kept pure and separate from the storage call so it can be tested
   without a blob store — see Website/tools/test-signup-guard.mjs. Takes parsed pathnames
   (parseKey shape), returns the summary a UI renders. */
export function verdictFor(records) {
  const recs = [...(records || [])].sort((a, b) => a.epoch - b.epoch);
  if (!recs.length) return { verdict: 'unknown', events: 0, automated: 0, repeatClicks: 0, burst: 0, reasons: [], firstAt: null, lastAt: null };

  const reasons = new Set();
  let automated = 0, repeatClicks = 0;
  for (const r of recs) {
    if (AUTOMATED_REASONS.has(r.reason)) { automated++; reasons.add(r.reason); }
    if (r.reason === 'repeat-click') repeatClicks++;
  }

  /* Biggest number of submissions inside one BURST_MS window. A sliding count, not a simple
     total: eight submissions over eight weeks is a keen subscriber and eight in twenty-nine
     seconds is a script. Only the second one means anything. */
  let burst = 1;
  for (let i = 0; i < recs.length; i++) {
    let j = i;
    while (j + 1 < recs.length && recs[j + 1].epoch - recs[i].epoch <= BURST_MS) j++;
    burst = Math.max(burst, j - i + 1);
  }

  return {
    verdict: automated ? 'automated' : (burst >= BURST_COUNT || recs.length >= 6) ? 'odd' : 'clean',
    events: recs.length,
    automated,
    repeatClicks,
    burst,
    reasons: [...reasons],
    firstAt: recs[0].epoch ? new Date(recs[0].epoch).toISOString() : null,
    lastAt: recs[recs.length - 1].epoch ? new Date(recs[recs.length - 1].epoch).toISOString() : null,
  };
}

/* The full records behind one person's verdict — the only call here that reads contents, and
   it reads ONLY that person's blobs (a handful), never the window. This is the drill-down
   behind a flag, so the cost lands when someone actually asks "why?".

   Returns [] for anyone whose records predate the key id — their rows cannot be found this
   way at all. The Signups tab's plaintext search is the fallback for those, and it is slow
   because it has to read everything; that is the price of information that was never indexed. */
export async function recordsForEmail(rawEmail, days = RETENTION_DAYS) {
  const kid = keyId(rawEmail);
  if (!isConfigured() || !kid) return [];
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  let blobs = [];
  try { ({ blobs } = await list({ prefix: PREFIX, token: token() })); }
  catch { return []; }
  /* ⚠ `.map(parseKey)` was the bug here: list() yields blob OBJECTS, so parseKey received
     `{pathname, url, …}` and stringified it to "[object Object]". Every field came back
     garbage, the filter matched nothing, and the panel said "no signup record" — which is
     indistinguishable from the legitimate legacy-record case it was written to describe. */
  const mine = (blobs || []).map((b) => parseKey(b.pathname)).filter((r) => r.kid === kid && r.day >= cutoff);
  const out = [];
  for (const m of mine) {
    try {
      // ⚠ get() with the token, never fetch(downloadUrl) — a private blob 403s unauthenticated.
      const r = await get(m.pathname, { access: 'private', token: token() });
      if (!r || r.statusCode !== 200 || !r.stream) continue;
      out.push(JSON.parse(await new Response(r.stream).text()));
    } catch { continue; }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* Find every record matching a term — an address, a fragment of one, or a domain.

   Deliberately searches the stored PLAINTEXT rather than hashing the term first. Hashing
   would need SIGNUP_TOKEN_SECRET, which lives in Vercel and is not necessarily present on
   the machine running this console, so a hash-based search would silently return nothing
   here. Matching the address we now store works with no secret at all.

   This is the one call that reads whole days, so it is bounded by the window and only ever
   runs on an explicit search. It also matches on `hash`, which means searching any single
   dotted Gmail variant finds all of them, and on `ip`, which finds everything one source
   did regardless of what addresses it used. */
export async function search(term, days = RETENTION_DAYS) {
  const q = String(term ?? '').trim().toLowerCase();
  if (q.length < 3) return { term: q, tooShort: true, hits: [] };
  const { byDay } = await overview(days);
  const hits = [];
  for (const d of byDay) {
    for (const r of await readDay(d.day)) {
      // IP is in the haystack on purpose: pasting one address in finds every form that IP
      // touched, which is how a run of unrelated-looking signups is shown to be one script.
      const hay = `${r.email} ${r.domain} ${r.hash} ${r.ip || ''}`.toLowerCase();
      if (hay.includes(q)) hits.push({ ...r, day: d.day });
    }
    if (hits.length >= 200) break;
  }
  return { term: q, tooShort: false, daysSearched: byDay.length, hits };
}
