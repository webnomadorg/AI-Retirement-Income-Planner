/* Feedback / testimonial records — written by api/feedback.mjs, decided by
   api/feedback-approve.mjs, read by tools/testimonials/cli.mjs (desktop repo).

   Purpose: keep an auditable record of what a customer said, whether they had actually
   bought, exactly what they consented to, and — separately — whether they approved the
   specific wording we proposed to publish. The FTC's Rule on Consumer Reviews and
   Testimonials makes the seller liable for claims inside a quote as if it made them
   itself, so "we have an email somewhere" is not good enough evidence. See
   Plans/Testimonials-Pipeline.md for the publishing rules this exists to support.

   Storage: one JSON object per submission in the PRIVATE Vercel Blob store, at
   feedback/<uuid>.json. The store also holds the product ZIPs (products/…) and the
   purchase index (customers/…).

   ── Why the record carries its own email_hmac and approval_token ──────────────────────
   Both are derived from UPDATE_LOOKUP_PEPPER, which lives ONLY in the Vercel project env.
   The owner-side CLI runs on a laptop and must be able to (a) write a hashed address into
   the git-tracked ledger and (b) build the approval link for an email — without holding
   the pepper. So both values are computed here, once, at submission time and stored on the
   record. The CLI reads them; it never derives them.

   api/feedback-approve.mjs still RE-DERIVES the token from the id and compares in constant
   time, so a tampered stored token gets it nowhere. The stored copy is a convenience for
   the CLI, never an authority.

   ── Why the plaintext email lives here and nowhere else ───────────────────────────────
   Git history is effectively permanent, so an address committed to the ledger could never
   be erased on request. The plaintext stays in this deletable blob; the git ledger keeps
   only the hash, the consent and the withdrawal — the evidence actually worth retaining.

   Lives outside api/ on purpose: every file inside Website/api/ becomes a public route.

   Env:
     UPDATE_LOOKUP_PEPPER  — shared with lib/purchase-log.mjs. Without it, hashing and
                             approval tokens are unavailable and api/feedback.mjs refuses
                             to accept submissions rather than storing an unverifiable
                             record (unlike the purchase index, which degrades gracefully —
                             here the whole point IS the audit trail).
     BLOB_READ_WRITE_TOKEN — Blob store access. Undefined is fine ONLY under OIDC, which
     also needs BLOB_STORE_ID; see lib/blob-auth.mjs. */

import crypto from 'node:crypto';
import { put, get, del } from '@vercel/blob';
import { listAll } from './blob-list.mjs';

/* A submission id is a v4 UUID and appears in URLs and blob paths. Anything that does not
   match this shape is rejected before it can be interpolated into a path — otherwise an
   id like "../products/planner-v7" would read straight out of the product store. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newFeedbackId() {
  return crypto.randomUUID();
}

export function isValidId(id) {
  return ID_RE.test(String(id || ''));
}

export function feedbackPathFor(id) {
  if (!isValidId(id)) return null;
  return `feedback/${id}.json`;
}

function pepper() {
  return process.env.UPDATE_LOOKUP_PEPPER || '';
}

/** Whether this deployment can produce an auditable record at all. */
export function isConfigured() {
  return Boolean(pepper());
}

/** HMAC of the normalised address. Same derivation as lib/purchase-log.mjs's blob key, so
    the two can be cross-referenced. Returns null when the pepper isn't configured. */
export function hashEmail(email) {
  const p = pepper();
  const normalised = String(email || '').trim().toLowerCase();
  if (!p || !normalised) return null;
  return crypto.createHmac('sha256', p).update(normalised, 'utf8').digest('hex');
}

/** Approval token for a submission. Domain-prefixed so it can never collide with the
    email hash, which is derived from the same secret. */
export function approvalToken(id) {
  const p = pepper();
  if (!p || !isValidId(id)) return null;
  return crypto.createHmac('sha256', p).update(`approve:${id}`, 'utf8').digest('hex');
}

/** Constant-time check. Always re-derive rather than trusting record.approval_token. */
export function verifyApprovalToken(id, supplied) {
  const expected = approvalToken(id);
  const given = String(supplied || '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/** First write. allowOverwrite stays false so a replayed submission can never clobber an
    existing record — the id is generated server-side, so a collision means something is wrong. */
export async function writeFeedback(record) {
  const path = feedbackPathFor(record?.id);
  if (!path) throw new Error('writeFeedback: invalid id');
  await put(path, JSON.stringify(record, null, 2), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: false,
    addRandomSuffix: false, // the path IS the lookup key — it must stay deterministic
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return record;
}

/** Read one record. Returns null when absent or unreadable. */
export async function readFeedback(id) {
  const path = feedbackPathFor(id);
  if (!path) return null;
  try {
    const result = await get(path, {
      access: 'private',
      token: process.env.BLOB_READ_WRITE_TOKEN, // undefined → SDK falls back to OIDC
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return JSON.parse(await new Response(result.stream).text());
  } catch {
    // A miss throws in this SDK. Never surface it as an error to the caller.
    return null;
  }
}

/**
 * Merge a patch into an existing record.
 *
 * Read-modify-write under last-write-wins, same as appendPurchase(). Acceptable here for
 * the same reason and a stronger one: the only writers are the owner (drafting) and the
 * buyer (deciding once), and those are minutes-to-days apart, not milliseconds.
 *
 * ⚠ `answers` is never patched. The verbatim submission is the evidence; the difference
 * between it and published_text is what makes "we trimmed, we did not rewrite" checkable.
 */
export async function patchFeedback(id, patch) {
  const existing = await readFeedback(id);
  if (!existing) return null;

  const { answers, id: _ignoredId, ...safePatch } = patch || {};
  const record = { ...existing, ...safePatch, id: existing.id, answers: existing.answers };
  record.updated_at = new Date().toISOString();

  await put(feedbackPathFor(id), JSON.stringify(record, null, 2), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return record;
}

/** Every submission, newest first. Used by the owner CLI, never by a public route. */
export async function listFeedback() {
  const blobs = await listAll({
    prefix: 'feedback/',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  const ids = (blobs || [])
    .map((b) => String(b.pathname || '').replace(/^feedback\//, '').replace(/\.json$/, ''))
    .filter(isValidId);

  const records = [];
  for (const id of ids) {
    const r = await readFeedback(id);
    if (r) records.push(r);
  }
  records.sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));
  return records;
}

/** Erasure. Removes the only copy of the plaintext address; the git ledger keeps the hash,
    the consent and the withdrawal date, which is what the record needs to show. */
export async function deleteFeedback(id) {
  const path = feedbackPathFor(id);
  if (!path) return false;
  await del(path, { token: process.env.BLOB_READ_WRITE_TOKEN });
  return true;
}
