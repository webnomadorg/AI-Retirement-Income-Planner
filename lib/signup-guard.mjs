/* Signup guard — everything that decides whether an email address reaches the mailing list.

   WHY THIS EXISTS
   The free-download forms were writing straight into MailerLite with two checks: a honeypot
   and a syntax regex. That let through a steady run of junk, of which the clearest signature
   was addresses like `a.rch.i.e.w.ane.2.9@gmail.com` — Gmail ignores dots entirely, so that
   is the SAME INBOX as `archiewane29@gmail.com`. One person (or one script) can mint an
   unlimited number of distinct-looking addresses that all deliver to one mailbox, and every
   one of them looked like a new subscriber.

   ⚠ THE POINT THAT DRIVES THE WHOLE DESIGN: an email-verification API cannot catch that.
   ZeroBounce, Kickbox and every SMTP-probe service will return `valid` for the dotted
   address, and charge for the answer, because it IS a valid deliverable mailbox. The fix is
   canonicalisation, which is free and instant. Paying per address would have bought us
   nothing on the exact case that prompted the work.

   THE CHAIN, cheapest first — each layer rejects before the next one runs:
     1. honeypot            (client-side trap, zero cost)
     2. syntax + length     (regex)
     3. canonicalisation    (Gmail dots / plus-addressing → one true address)
     4. non-human localpart (noreply@, postmaster@ …)
     5. disposable domain   (static Set)
     6. form token          (HMAC, proves the form was rendered and not submitted in 200ms)
     7. MX / A record       (one DNS lookup — does the domain accept mail at all?)
   Everything that survives goes to double opt-in, which is the real filter.
   ⚠ ONE MORE CHECK LIVES OUTSIDE THIS MODULE: api/newsletter.mjs then asks the
   quarantine log whether this address has tripped the honeypot before (see
   priorHoneypot). It is not here because it needs storage and this module does none. Nothing here
   needs a database, a third-party account or a captcha.

   WHAT THIS MODULE DELIBERATELY DOES NOT DO
   It never writes to MailerLite and never sends email. It answers questions and signs
   tokens. api/newsletter.mjs and api/newsletter-confirm.mjs decide what to do with the
   answers, and api/meta-leads.mjs reuses the same screening so Facebook Lead Ads cannot
   become the unguarded back door.

   Env: SIGNUP_TOKEN_SECRET — HMAC key for the form token and the confirm link. */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { DISPOSABLE_DOMAINS, NON_HUMAN_LOCALPARTS } from './disposable-domains.mjs';

/* Providers known to implement plus-addressing, where `user+tag@` and `user@` are one
   mailbox. Restricted to a known list ON PURPOSE: on a custom domain `user+tag@` may be a
   genuinely separate address, and merging two real subscribers into one is a worse failure
   than missing a dedupe. Gmail's dot rule is narrower still — it applies to Gmail alone. */
const PLUS_ADDRESSING_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'fastmail.com', 'fastmail.fm',
  'zoho.com',
]);

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export const MAX_EMAIL_LEN = 254;   // RFC 5321 maximum
export const MAX_NAME_LEN = 80;

/* Deliberately permissive — this rejects nonsense, not unusual-but-legal addresses. The
   authoritative test of an address is whether someone clicks the link we send to it. */
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.]+(\.[^\s@.]+)+$/;

/* ------------------------------------------------------------------ canonicalisation --- */

/** Reduce an address to the one true mailbox it delivers to. Returns null if unparseable. */
export function canonicaliseEmail(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_RE.test(trimmed)) return null;

  const at = trimmed.lastIndexOf('@');
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1).toLowerCase();

  // googlemail.com is a straight alias of gmail.com — same mailbox, different spelling.
  if (domain === 'googlemail.com') domain = 'gmail.com';

  // The local part is case-sensitive per the RFC and case-insensitive at every provider
  // anyone actually uses. Lowercasing is what makes dedupe work at all.
  local = local.toLowerCase();

  if (PLUS_ADDRESSING_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
  }

  // The dot rule. Gmail only — everywhere else a dot is a real character.
  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\./g, '');

  if (!local) return null;
  return { email: `${local}@${domain}`, local, domain };
}

/** Mask an address for logging: keeps the shape and the domain, drops the identity. */
export function maskEmail(raw) {
  const s = String(raw ?? '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '(invalid)';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const shown = local.length <= 2 ? local[0] : local[0] + local[local.length - 1];
  return `${shown[0]}***${shown.length > 1 ? shown[1] : ''}@${domain}`;
}

/* ------------------------------------------------------------------------- HMAC keys --- */

/* ⚠ NO FALLBACK, AND NO GRACEFUL DEGRADATION — THIS IS INTENTIONAL.

   UPDATE_LOOKUP_PEPPER sat unset in production from launch until 2026-08-08 precisely
   because the code that used it degraded politely when it was missing. Nothing broke, so
   nobody looked. If this secret is unset the double opt-in cannot be trusted, and the only
   safe behaviour is a loud failure that stops signups until it is set — a quiet fallback
   here would mean the entire feature silently does nothing while appearing to work.

   ⚠ Vercel binds env vars at DEPLOY time. Setting this in the dashboard does not reach
   already-running functions; redeploy after adding it. */
export function signingSecret() {
  const s = process.env.SIGNUP_TOKEN_SECRET;
  if (!s || s.length < 16) return null;
  return s;
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function encodeToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function decodeToken(token, secret) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(parts[1], sign(parts[0], secret))) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Non-reversible id for a canonical address — lets the quarantine log count repeat
    offenders without storing a list of addresses nobody consented to us keeping. */
export function emailHash(canonicalEmail, secret) {
  return crypto
    .createHmac('sha256', secret || 'unsalted')
    .update(String(canonicalEmail).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/* A SECOND identifier, and the reason there are two is worth understanding before you use
   either.

   `emailHash` above is an HMAC, so it needs SIGNUP_TOKEN_SECRET. That secret lives in Vercel
   and is NOT on the owner's machine — so nothing running in the admin console can compute it,
   and any console feature built on it would silently match nothing. That is not hypothetical:
   the Signups search matches plaintext for exactly this reason.

   `keyId` is the answer to that: a plain SHA-256 of the canonical address, no secret, so the
   SAME id is computable in a Vercel function, in the console, and on a flash drive. It exists
   to JOIN records to a person — nothing more.

   ⚠ It is a join key, NOT a privacy control. An unsalted hash of an email address can be
   reversed by anyone willing to hash a wordlist, so treat it as equivalent to the address. It
   costs nothing here because the record it labels already stores the address in full, in the
   same private store. Do not reach for it anywhere that is actually trying to protect an
   address — use `emailHash` there.

   Canonical, so every dotted Gmail variant of one mailbox lands on one id. */
export function keyId(rawEmail) {
  const canon = canonicaliseEmail(rawEmail);
  if (!canon) return '';
  return crypto.createHash('sha256').update(canon.email).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------------ form token --- */

/* Issued by GET /api/newsletter when the visitor first touches the form, checked on POST.
   Two things it proves: the form was actually rendered (a script POSTing blind to the
   endpoint has no token), and a human spent more than a moment on it. */
export const MIN_FILL_SECONDS = 2;
export const MAX_FORM_AGE_SECONDS = 3 * 60 * 60;

export function issueFormToken(secret) {
  return encodeToken({ k: 'form', t: Date.now(), n: crypto.randomBytes(6).toString('base64url') }, secret);
}

/** → { state: 'ok' | 'missing' | 'forged' | 'too-fast' | 'stale', ageMs } */
export function verifyFormToken(token, secret) {
  if (!token) return { state: 'missing' };
  const p = decodeToken(token, secret);
  if (!p || p.k !== 'form' || typeof p.t !== 'number') return { state: 'forged' };
  const ageMs = Date.now() - p.t;
  if (ageMs < MIN_FILL_SECONDS * 1000) return { state: 'too-fast', ageMs };
  if (ageMs > MAX_FORM_AGE_SECONDS * 1000) return { state: 'stale', ageMs };
  return { state: 'ok', ageMs };
}

/* --------------------------------------------------------------------- confirm token --- */

/* The whole double opt-in, with no database behind it.

   Everything needed to complete the signup travels inside a signed token in the confirm
   link, so an unconfirmed address is stored NOWHERE — not in MailerLite, not in a pending
   table, not in the Blob store. That is the literal form of "weed it out before it is
   recorded in the mailing list": if the link is never clicked, the address leaves no trace.

   fbp/fbc ride along because the click routinely happens on a different device from the
   signup (people open email on their phone), and re-reading the cookies at that point would
   attribute the conversion to the wrong browser or to nothing at all.

   Replay: the link keeps working until it expires. That is fine — the MailerLite call it
   authorises is an idempotent upsert, so a second click re-subscribes the same person to the
   same group and changes nothing. */
export const CONFIRM_TTL_DAYS = 7;

export function signConfirmToken(data, secret) {
  return encodeToken(
    {
      k: 'confirm',
      e: data.email,                       // already canonical
      n: data.firstName || '',
      m: data.magnet,
      i: data.eventId || '',
      p: data.fbp || '',
      c: data.fbc || '',
      x: Date.now() + CONFIRM_TTL_DAYS * 86400_000,
    },
    secret
  );
}

/** → { ok: true, … } | { ok: false, reason: 'forged' | 'expired' } */
export function verifyConfirmToken(token, secret) {
  const p = decodeToken(token, secret);
  if (!p || p.k !== 'confirm' || !p.e || typeof p.x !== 'number') return { ok: false, reason: 'forged' };
  if (Date.now() > p.x) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    email: String(p.e),
    firstName: String(p.n || ''),
    magnet: String(p.m || ''),
    eventId: String(p.i || ''),
    fbp: String(p.p || ''),
    fbc: String(p.c || ''),
  };
}

/* ------------------------------------------------------------------------ DNS checks --- */

/* One lookup per domain, cached for the life of the warm instance. Nearly every signup is
   gmail/outlook/yahoo, so in practice this resolves once and then costs nothing.

   A domain with no MX may still accept mail at its A record (RFC 5321 §5.1), so a missing MX
   alone is not proof — checking A/AAAA before rejecting is what stops this from bouncing
   legitimate small-business addresses. */
const mxCache = new Map();          // domain -> { ok, at }
const MX_CACHE_MS = 60 * 60 * 1000;
const DNS_TIMEOUT_MS = 2500;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dns-timeout')), ms)),
  ]);
}

/** → true (accepts mail) | false (definitively does not) — errors resolve to true. */
export async function domainAcceptsMail(domain) {
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < MX_CACHE_MS) return hit.ok;

  let ok;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS);
    ok = Array.isArray(mx) && mx.some((r) => r && r.exchange);
    if (!ok) ok = await hasAddressRecord(domain);
  } catch (err) {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) {
      // No MX. Could still be an A-record mail host, so ask before rejecting.
      ok = await hasAddressRecord(domain);
    } else {
      /* Timeout, SERVFAIL, resolver trouble. FAIL OPEN — a DNS wobble must never turn into
         "the signup form is broken". A false accept costs one unconfirmed token; a false
         reject costs a real subscriber and looks like a site fault. */
      ok = true;
    }
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

async function hasAddressRecord(domain) {
  try {
    const a = await withTimeout(dns.resolve4(domain), DNS_TIMEOUT_MS);
    if (Array.isArray(a) && a.length) return true;
  } catch { /* fall through to AAAA */ }
  try {
    const aaaa = await withTimeout(dns.resolve6(domain), DNS_TIMEOUT_MS);
    return Array.isArray(aaaa) && aaaa.length > 0;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- disposable/role -- */

/** Catches `foo.mailinator.com` from the `mailinator.com` entry. */
export function isDisposableDomain(domain) {
  const parts = String(domain).split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export function isNonHumanLocalPart(local) {
  return NON_HUMAN_LOCALPARTS.has(String(local).replace(/[._-]/g, ''))
      || NON_HUMAN_LOCALPARTS.has(String(local));
}

/* ---------------------------------------------------------------------------- screen --- */

/* Reasons are stable strings — the quarantine log groups on them and the owner console
   shows them, so renaming one silently splits its history in two. */
export const BLOCK_REASONS = {
  HONEYPOT: 'honeypot',
  /* Not raised by screenSignup — it needs the quarantine log, and this module does no
     I/O and must not import signup-quarantine.mjs (which imports keyId from here).
     Raised by api/newsletter.mjs via priorHoneypot(). It lives in this map anyway so
     the reason string has ONE definition: the console groups its history on it. */
  PRIOR_HONEYPOT: 'prior-honeypot',
  SYNTAX: 'syntax',
  NON_HUMAN: 'non-human-address',
  DISPOSABLE: 'disposable-domain',
  NO_MX: 'domain-cannot-receive-mail',
  TOKEN_FORGED: 'forged-form-token',
  TOKEN_TOO_FAST: 'submitted-too-fast',
};

/* The message shown to whoever is on the other end.

   Every block returns the SAME wording regardless of reason. Telling a bot which layer
   caught it is free tuning advice, and a person who has hit a false positive is better
   served by a route to a human than by a diagnosis they cannot act on. */
export const BLOCK_MESSAGE =
  "We couldn't accept that email address. Please check it and try again, or email dev@webnomad.org and we'll send your download directly.";

/* The same refusal, for a form where the person is asking a question rather than requesting a
   file. Reusing the wording above told contact-form visitors we would "send your download",
   which is meaningless to someone who did not ask for one — and the fallback route is the
   whole value of the message, so it has to make sense. */
export const BLOCK_MESSAGE_CONTACT =
  "We couldn't accept that email address. Please check it and try again — or email us directly at dev@webnomad.org and we'll pick it up from there.";

/**
 * Run the free screen. Never throws; never writes anything.
 *
 * @param {object} input
 * @param {boolean} [input.checkToken=true]       false for callers with no form of ours
 * @param {boolean} [input.checkDisposable=true]  ⚠ false for the CONTACT form — see below
 *
 * @returns {Promise<{ok: boolean, reason?: string, email?: string, local?: string,
 *                    domain?: string, firstName?: string, tokenState?: string,
 *                    tokenAgeMs?: number|null}>}
 */
export async function screenSignup(input) {
  const {
    honeypot, email, name, formToken, secret,
    checkToken = true,
    checkDisposable = true,
  } = input;

  if (honeypot) return { ok: false, reason: BLOCK_REASONS.HONEYPOT };

  const canon = canonicaliseEmail(email);
  if (!canon) return { ok: false, reason: BLOCK_REASONS.SYNTAX };

  if (isNonHumanLocalPart(canon.local)) {
    return { ok: false, reason: BLOCK_REASONS.NON_HUMAN, domain: canon.domain };
  }

  /* ⚠ The contact form passes checkDisposable:false, and the asymmetry is the reason.

     On the MAILING LIST a throwaway address is worthless by definition — the mailbox is
     abandoned the moment the PDF lands, so blocking it costs nothing.

     On the CONTACT FORM the same address may be a privacy-conscious person asking a genuine
     pre-sales question. Losing that enquiry costs a sale; receiving one spam message costs a
     few seconds. The cost runs the opposite way, so the same rule would be wrong. */
  if (checkDisposable && isDisposableDomain(canon.domain)) {
    return { ok: false, reason: BLOCK_REASONS.DISPOSABLE, domain: canon.domain };
  }

  /* Token handling is asymmetric on purpose.

     A FORGED or TOO-FAST token is a hard block: both mean something automated. A MISSING
     token is not, because assets/js/main.js is cached hard by browsers and CDNs — the moment
     this ships, every visitor holding yesterday's main.js posts without one. Blocking those
     would take the signup form down for hours for real people while catching nothing a bot
     could not trivially work around. The state is reported so the log can show how fast the
     new client is taking over. */
  let tokenState = 'skipped';
  /* How long the form was open before it was posted. The token already decides pass/fail on
     this, but the RAW figure is worth keeping: "blocked, too fast" is one bit, whereas a run
     of real signups clustered at 2.1s says the threshold is about to start rejecting people,
     and a legitimate-looking submission at 2.0s flat every time says a script has simply
     learned to wait. Null when there is no usable token to measure against. */
  let tokenAgeMs = null;
  if (checkToken) {
    const v = verifyFormToken(formToken, secret);
    tokenState = v.state;
    tokenAgeMs = Number.isFinite(v.ageMs) ? v.ageMs : null;
    if (v.state === 'forged') {
      return { ok: false, reason: BLOCK_REASONS.TOKEN_FORGED, domain: canon.domain, tokenState, tokenAgeMs };
    }
    if (v.state === 'too-fast') {
      return { ok: false, reason: BLOCK_REASONS.TOKEN_TOO_FAST, domain: canon.domain, tokenState, tokenAgeMs };
    }
  }

  if (!(await domainAcceptsMail(canon.domain))) {
    return { ok: false, reason: BLOCK_REASONS.NO_MX, domain: canon.domain };
  }

  const safeName = String(name ?? '').trim().slice(0, MAX_NAME_LEN);
  return {
    ok: true,
    email: canon.email,
    local: canon.local,
    domain: canon.domain,
    firstName: safeName ? safeName.split(/\s+/)[0] : '',
    tokenState,
    tokenAgeMs,
  };
}
