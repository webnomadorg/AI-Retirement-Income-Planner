/* Purchase log — shared by api/stripe-webhook.mjs (writer) and api/update-download.mjs (reader).

   Purpose: let a customer who has only their email address re-download what they bought,
   without us storing a customer database. Stripe remains the source of truth for the
   purchase itself; this is a lookup index that maps "email" → "the Checkout Session ids
   that email paid with". The session id is already the entitlement token used by
   api/download.mjs, so nothing new is trusted — the actual download still re-verifies
   with Stripe on every request.

   Storage: one small JSON object per customer in the PRIVATE Vercel Blob store, at
   customers/<hmac>.json. The store also holds the product ZIPs (products/…).

   Why the email is hashed: the key is HMAC-SHA256(normalised email, UPDATE_LOOKUP_PEPPER)
   rather than the address itself, so the object names are not a readable mailing list and
   cannot be brute-forced back into addresses without the pepper. A plain SHA-256 would be
   trivially reversible for email addresses (small, guessable input space).

   Lives outside api/ on purpose: every file inside Website/api/ becomes a public route.

   Env:
     UPDATE_LOOKUP_PEPPER  — random secret, ≥32 chars. Must be identical in the Vercel
                             project env and in the root .env used by
                             tools/stripe/seed-test-purchase.mjs, or lookups miss.
     BLOB_READ_WRITE_TOKEN — added automatically when the Blob store is connected
                             (falls back to OIDC when undefined). */

import crypto from 'node:crypto';
import { put, get } from '@vercel/blob';

const MAX_SESSIONS = 10; // plenty — this is "what did you buy", not an audit trail

/** Normalise an address so the same person always hashes to the same key. */
export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Blob pathname for an email. Returns null when the pepper isn't configured. */
export function logPathFor(email) {
  const pepper = process.env.UPDATE_LOOKUP_PEPPER;
  if (!pepper) return null;
  const normalised = normaliseEmail(email);
  if (!normalised) return null;
  const hmac = crypto.createHmac('sha256', pepper).update(normalised, 'utf8').digest('hex');
  return `customers/${hmac}.json`;
}

/** Read a customer's record. Returns null when absent, unreadable, or unconfigured. */
export async function readPurchaseLog(email) {
  const path = logPathFor(email);
  if (!path) return null;
  try {
    const result = await get(path, {
      access: 'private',
      token: process.env.BLOB_READ_WRITE_TOKEN, // undefined → SDK falls back to OIDC
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    const record = JSON.parse(text);
    return Array.isArray(record?.sessions) ? record : null;
  } catch {
    // A miss is the overwhelmingly common case (any email that never bought), and the
    // SDK signals it by throwing. Never let it surface as an error to the caller.
    return null;
  }
}

/**
 * Add a paid session to a customer's record, newest first, de-duplicated by session id.
 *
 * Read-modify-write, so two purchases by the same email landing in the same instant could
 * lose one under last-write-wins. Accepted: it needs two checkouts on one address inside a
 * few hundred milliseconds, and api/update-download.mjs falls back to querying Stripe
 * directly when the log doesn't have what it expects.
 */
export async function appendPurchase(email, session) {
  const path = logPathFor(email);
  if (!path) throw new Error('UPDATE_LOOKUP_PEPPER is not configured');

  const existing = await readPurchaseLog(email);
  const sessions = (existing?.sessions || []).filter((s) => s.id !== session.id);
  sessions.unshift(session);

  const record = {
    v: 1,
    updated: new Date().toISOString(),
    sessions: sessions.slice(0, MAX_SESSIONS),
  };

  await put(path, JSON.stringify(record), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false, // the path IS the lookup key — it must stay deterministic
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return record;
}
