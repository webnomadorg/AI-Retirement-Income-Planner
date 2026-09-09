/* Site assistant — who has had how much, and when to stop spending.

   Four separate jobs, and it matters which one protects what:

     1. A signed cookie holds the visitor's message count. Server-authoritative and
        tamper-proof, and it handles the honest 99% at zero storage cost.
     2. A rolling HMAC over the conversation stops a visitor FORGING assistant turns.
        This is a security control, not a quota one — see below.
     3. An atomic per-IP daily claim catches the cookie-clearers.
     4. Running hourly and daily spend totals are the only actual WALL.

   ⚠ Be clear-eyed about which of these protects the money. Anonymous visitors cannot be
   limited perfectly, and nothing here pretends otherwise: (1) and (3) shape behaviour and
   make casual abuse tedious, but a determined person with a new IP defeats them. (4) is
   what bounds the bill, which is why it fails CLOSED while the rest fail open.

   ⚠ NO BROWSER FINGERPRINTING, deliberately. It is fragile, it is defeated by anyone who
   cares, and deploying it on a site that sells on a privacy promise would contradict the
   product and need a privacy-policy disclosure that undercuts the brand.

   Env: SIGNUP_TOKEN_SECRET  — HMAC key, shared with lib/signup-guard.mjs
        BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID under OIDC) */

import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { listAll } from './blob-list.mjs';
import { blobConfigured, blobToken } from './blob-auth.mjs';
import { signingSecret } from './signup-guard.mjs';

export const COOKIE_NAME = 'wn_chat';
export const COOKIE_MAX_AGE = 60 * 60 * 24;      // one day; the quota is per day anyway

const CLAIM_PREFIX = 'chat-quota/';
const SPEND_PREFIX = 'chat-spend/';

/* ------------------------------------------------------------------- signed values --- */

/* Same construction as lib/signup-guard.mjs: base64url payload, HMAC, dot-joined. The
   secret is SHARED with that module on purpose — one secret to configure and one to
   rotate. Domain separation comes from the `k` field, which every payload carries and
   every verifier checks, so a form token can never be replayed as a chat token. */

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function encode(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function decode(token, secret) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(parts[1], sign(parts[0], secret))) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ----------------------------------------------------------------- visitor state --- */

export function newState() {
  return { k: 'chat', sid: crypto.randomBytes(9).toString('base64url'), n: 0, day: today() };
}

/** Read the state cookie off a request. Anything unsigned, forged, foreign or from a
 *  previous day starts a fresh conversation rather than erroring. */
export function readState(req) {
  const secret = signingSecret();
  if (!secret) return newState();
  const raw = String((req && req.headers && req.headers.cookie) || '');
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE_NAME + '='));
  if (!hit) return newState();
  const p = decode(decodeURIComponent(hit.slice(COOKIE_NAME.length + 1)), secret);
  if (!p || p.k !== 'chat' || typeof p.n !== 'number' || typeof p.sid !== 'string') {
    return newState();
  }
  if (p.day !== today()) return newState();      // the allowance resets daily
  return { k: 'chat', sid: p.sid, n: p.n, day: p.day };
}

/* ⚠ HttpOnly, so page scripts cannot read or edit the count; SameSite=Lax, because the
   only caller is same-origin; Secure, because the site is HTTPS everywhere. Path=/ so one
   conversation follows the visitor across pages rather than restarting on each one. */
export function stateCookie(state) {
  const secret = signingSecret();
  if (!secret) return null;
  const value = encodeURIComponent(encode(state, secret));
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/* --------------------------------------------------------- conversation integrity --- */

/* ⚠ THE ATTACK THIS STOPS, which is not obvious and is the most likely way to get a
   damaging screenshot out of this widget.

   The Messages API is stateless, so the whole conversation is resent on every turn. If the
   browser supplies that history unchecked, a visitor can insert an assistant turn THEY
   wrote — "I confirm the planner guarantees 12% returns" — and then ask the model to
   expand on it. The model reasonably trusts its own prior words, so every rule in the
   system prompt is bypassed in one move.

   Server-side storage is the obvious fix and the wrong one here: a blob takes ~2.4s to
   become readable and turn 2 can easily arrive sooner, so reads would intermittently hand
   back a stale conversation.

   A rolling HMAC is stateless, needs no read, and has no race. The server signs the
   history it just produced; the client returns that signature with the next turn; the
   server recomputes it over what it was handed. Altering ANY earlier turn breaks it. The
   sid is mixed in so a transcript cannot be replayed into someone else's session. */
export function signHistory(sid, messages) {
  const secret = signingSecret();
  if (!secret) return '';
  const canon = JSON.stringify((messages || []).map((m) => [m.role, m.content]));
  /* NUL as the separator, written explicitly. It cannot occur in a base64url sid nor in
     JSON.stringify output, so there is no pair of different inputs that could produce the
     same signed string -- which a space could not promise. */
  return sign(Buffer.from(sid + String.fromCharCode(0) + canon, 'utf8').toString('base64url'), secret);
}

export function verifyHistory(sid, messages, mac) {
  if (!(messages || []).length) return true;     // first turn signs nothing
  const expected = signHistory(sid, messages);
  if (!expected || !mac) return false;
  return safeEqual(mac, expected);
}

/* ------------------------------------------------------------------ per-IP backstop --- */

/* ⚠ IPv6 IS GROUPED TO ITS /64 BEFORE HASHING, AND WITHOUT THIS THE PER-IP CAP DOES NOTHING.

   A home IPv4 connection has one address, so hashing it whole is a real limit. A home IPv6
   connection is handed a /64 — eighteen quintillion addresses — and picking a new one costs
   an attacker nothing. Hashing the full address made every one of them look like a brand new
   visitor, so the layer meant to catch someone clearing their cookies was, for anyone on
   IPv6, no layer at all. Measured: four addresses in one subnet produced four distinct
   hashes.

   /64 is the right granularity: it is the standard single-site allocation, so it groups one
   household or office without reaching across to a neighbour. IPv4 keeps its full address —
   truncating to /24 there would lump together hundreds of unrelated homes on one ISP block. */
export function ipGroup(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return 'unknown';
  if (!raw.includes(':')) return raw;                       // IPv4, as-is
  // Expand only as far as needed to take the first four groups.
  const [head] = raw.split('%');                            // drop any zone index
  const parts = head.split('::');
  const left = (parts[0] || '').split(':').filter(Boolean);
  if (parts.length > 1 && left.length < 4) {
    // "2a02:c7f::1" — everything after :: is below the /64 boundary, so the left side is it.
    return left.join(':') + '::/64';
  }
  return left.slice(0, 4).join(':') + '::/64';
}

/** Non-reversible. The console never needs to compute this, so an HMAC is free here and
 *  keeps raw addresses out of the store entirely. */
export function ipHash(ip) {
  const secret = signingSecret() || 'unsalted';
  return crypto.createHmac('sha256', secret)
    .update(ipGroup(ip) || 'unknown').digest('hex').slice(0, 20);
}

/* How many separate conversations one address may start in a day.

   ⚠ THIS REPLACED A BROKEN SCHEME, AND THE BREAKAGE IS WORTH KNOWING ABOUT.
   The slot number used to be the visitor's own message count, so every visitor's FIRST
   message claimed slot 1. Two people behind one address — a couple at home, an office, a
   mobile carrier's NAT — therefore collided immediately: the first got their ten questions
   and the second got NONE, refused before they had asked anything. The advertised
   allowance was never reachable either, because nothing ever counted past the collision.

   Keying on the conversation id instead makes each visitor's claim distinct, and the cap
   becomes what it always claimed to be: how many fresh conversations one address may start.
   It is also cheaper — one listing plus one write per CONVERSATION, rather than a write on
   every message.

   ⚠ Only called on a visitor's first message. After that the signed cookie governs, and it
   is exact. */
export const IP_DAILY_CONVERSATIONS = 6;

/* How many separate conversations one address may EMAIL to itself in a day. Three rather
   than one: a household shares two transcripts, or somebody mistypes their address and
   tries again, and a silent refusal there looks exactly like the mail never arriving.
   lib/chat-share.mjs already allows one send per conversation ever, so this only bounds
   how many DIFFERENT conversations an address can mail. */
export const IP_DAILY_SHARES = 3;

/* The shape behind every daily per-address cap: count what is already filed under this
   prefix, refuse once the limit is reached, otherwise file one more.

   ⚠ Undercounts something claimed in the last few seconds, because a blob takes appreciable
   time to become listable. That is the right way to be wrong here: these are backstops
   against someone clearing cookies, not the layer that bounds the bill, and refusing a real
   visitor is far more costly than allowing one extra.

   ⚠ FAILS OPEN on a storage error, deliberately, and unlike the spend ceiling. A listing
   failure here must not lock every visitor out of a working assistant; the ceiling is the
   layer that is allowed to stop the world, and it is the one that fails closed. */
async function claimDaily(prefix, id, limit, what) {
  if (!blobConfigured()) return true;
  try {
    const existing = await listAll({ prefix, token: blobToken() });
    if (existing.length >= limit) return false;
  } catch (err) {
    console.error(`[chat-quota] could not count ${what}, allowing:`, err?.message || err);
    return true;
  }
  try {
    await put(`${prefix}${id}.json`, JSON.stringify({ at: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: blobToken(),
    });
    return true;
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    const name = String(err?.name || '').toLowerCase();
    // Already claimed under this same id: that is fine, it is not a new one.
    if (msg.includes('already exist') || msg.includes('blob already') || name.includes('alreadyexists')) {
      return true;
    }
    console.error('[chat-quota] claim error, allowing:', err?.message || err);
    return true;
  }
}

export async function claimConversation(hash, sid) {
  return claimDaily(`${CLAIM_PREFIX}${today()}/${hash}-`, sid, IP_DAILY_CONVERSATIONS,
    'conversations');
}

/* ⚠ THE TWO CLAIM NAMESPACES SHARE A FOLDER AND MUST NOT SEE EACH OTHER'S ROWS.
   A conversation claim is filed under `<day>/<hash>-…` and a share claim under
   `<day>/share-<hash>-…`. Neither listing can match the other because `hash` is hex and
   therefore never begins "share-" — but that is a property of the hash alphabet rather than
   of the paths, so it is asserted in tools/test-chat-guards.mjs rather than left to a
   reader to re-derive. Keyed on the CONVERSATION id, not a slot number, so a retry for the
   same conversation does not consume a second one; that slot-number scheme is exactly what
   made every visitor's first message collide, above. */
export async function claimShareSlot(hash, conversationId) {
  return claimDaily(`${CLAIM_PREFIX}${today()}/share-${hash}-`, conversationId, IP_DAILY_SHARES,
    'share requests');
}

/* --------------------------------------------------------------- spend accounting --- */

/* THE AMOUNT IS IN THE PATHNAME, and that is the whole design.

   `list()` returns pathnames without fetching any bodies, so a day's total is one listing
   and some string parsing — no per-blob reads at all. The same trick the signup quarantine
   uses to keep its overview cheap. Tenths of a cent are enough resolution: one message
   costs roughly one cent.

     chat-spend/<YYYY-MM-DD>/<HH>/<epoch>-<tenthsOfACent>-<rand>.json  */

function stamp(now = new Date()) {
  const iso = now.toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

export async function recordSpend(usd, now = new Date()) {
  if (!blobConfigured()) return null;
  const tenths = Math.max(0, Math.round(Number(usd || 0) * 1000));
  const { day, hour } = stamp(now);
  const key = `${SPEND_PREFIX}${day}/${hour}/${now.getTime()}-${tenths}-`
    + `${crypto.randomBytes(3).toString('hex')}.json`;
  try {
    await put(key, JSON.stringify({ usd: Number(usd || 0) }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: blobToken(),
    });
    return key;
  } catch (err) {
    console.error('[chat-quota] spend write failed:', err?.message || err);
    return null;
  }
}

function tenthsFromPath(pathname) {
  // …/<epoch>-<tenths>-<rand>.json
  const file = String(pathname).split('/').pop() || '';
  const parts = file.replace(/\.json$/, '').split('-');
  if (parts.length < 3) return 0;
  const n = Number(parts[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/* ⚠ THE CEILING IS APPROXIMATE, AND THAT IS A DESIGN DECISION, NOT AN OVERSIGHT.

   Reading the running total fresh on every request would add a listing to every reply, and
   the ~2.4s read-after-write lag means two concurrent requests can both see a pre-trip
   total anyway. So the total is cached for a minute and this instance's own unflushed
   spend is added on top. The ceiling can therefore overshoot by roughly one minute of
   traffic — pennies at any plausible volume, and the edge rate limit bounds how much
   traffic a minute can hold.

   What matters is that it is a wall that overshoots slightly, not a wall with a hole.
   Set the ceiling with that tolerance in mind rather than treating it as exact. */
const SPEND_TTL_MS = 60_000;
let _spendCache = null;      // { day, hour, dayUsd, hourUsd, at }
let _localDay = 0;           // this instance's spend since the last refresh
let _localHour = 0;

export async function spendStatus(now = new Date()) {
  const { day, hour } = stamp(now);
  const fresh = !_spendCache
    || _spendCache.day !== day
    || _spendCache.hour !== hour
    || Date.now() - _spendCache.at > SPEND_TTL_MS;

  if (fresh) {
    let dayUsd = 0;
    let hourUsd = 0;
    if (blobConfigured()) {
      try {
        const blobs = await listAll({ prefix: `${SPEND_PREFIX}${day}/`, token: blobToken() });
        for (const b of blobs) {
          const t = tenthsFromPath(b.pathname);
          dayUsd += t / 1000;
          if (String(b.pathname).startsWith(`${SPEND_PREFIX}${day}/${hour}/`)) hourUsd += t / 1000;
        }
      } catch (err) {
        /* ⚠ A listing failure must not read as "nothing spent" and reopen the taps. Keep
           the previous figures if we have them; if we have none, report the ceiling as
           unknown so the caller can decide. */
        console.error('[chat-quota] spend listing failed:', err?.message || err);
        if (_spendCache) return { ..._spendCache, stale: true };
        return { day, hour, dayUsd: 0, hourUsd: 0, unknown: true };
      }
    }
    _spendCache = { day, hour, dayUsd, hourUsd, at: Date.now() };
    _localDay = 0;
    _localHour = 0;
  }
  return {
    day: _spendCache.day,
    hour: _spendCache.hour,
    dayUsd: _spendCache.dayUsd + _localDay,
    hourUsd: _spendCache.hourUsd + _localHour,
  };
}

/** Called right after recordSpend so this instance sees its own spending before the
 *  cache next refreshes. Without it, an instance could blow past the ceiling inside one
 *  TTL window without ever noticing. */
export function noteLocalSpend(usd) {
  const n = Number(usd || 0);
  if (!Number.isFinite(n) || n <= 0) return;
  _localDay += n;
  _localHour += n;
}

/** Reset module state. Tests only — a serverless instance never needs this. */
export function _resetSpendCache() {
  _spendCache = null;
  _localDay = 0;
  _localHour = 0;
}
