/* Sitewide sale banner — the shared state file.

   ONE definition of the sale state, used from two sides:
     - the owner console (tools/testimonials/sales.mjs) WRITES it,
     - api/sale.mjs READS it and serves the public a stripped-down view.
   The console imports this module directly rather than keeping its own copy, for the same
   reason the search and signup tabs do: a second definition of a shape is a second definition
   that can drift, and the failure would be silent on a live selling site.

   ONE ACTIVE SALE IS A PROPERTY OF THE SHAPE, NOT A RULE THAT IS ENFORCED.
   `active` is a single id at the top level, not a flag on each row. Two simultaneous live
   sales are therefore unrepresentable — there is no state you could write that means it.

   TWO INDEPENDENT GATES.
   A sale shows only if it is `active` AND `now` is inside its window. The console is a local
   tool that is usually closed, and nothing here runs on a schedule, so the date gate is what
   actually ends a sale. The Stripe promotion code carries a matching `expires_at`, which ends
   the discount itself. Forgetting to press Deactivate costs nothing.

   Layout: sale/state.json — a single small document, overwritten in place.
   Env: BLOB_READ_WRITE_TOKEN (private Blob store) */

import { put, get } from '@vercel/blob';

export const STATE_PATH = 'sale/state.json';
export const STATE_VERSION = 1;

/** The icons assets/js/sale.js knows how to draw. Anything else falls back to `tag`. */
export const ICONS = ['tag', 'gift', 'bolt', 'leaf', 'calendar'];

/** Where the banner sends anyone who clicks it. */
export const SALE_URL = '/products.html';

export function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function emptyState() {
  return { v: STATE_VERSION, updated: null, active: null, sales: [] };
}

/* Read the state document.

   ⚠ Must be get() with the token, NOT fetch(blob.downloadUrl). A private blob's URL returns
   403 to an unauthenticated request, so a plain fetch fails SILENTLY — the site would simply
   never show a banner and nothing would appear in any log. That bug has already shipped twice
   in this codebase (affiliate payouts, search analytics); it does not get to ship a third time.

   A missing document is not an error: it is what "no sale has ever been configured" looks
   like, which is the state this repo is in until the owner creates one. */
export async function readState() {
  if (!isConfigured()) return emptyState();
  let r;
  try {
    r = await get(STATE_PATH, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch {
    return emptyState();                       // treat an unreachable store as "no sale"
  }
  if (!r || r.statusCode === 404 || !r.stream) return emptyState();
  if (r.statusCode !== 200) return emptyState();
  try {
    const raw = JSON.parse(await new Response(r.stream).text());
    return normalise(raw);
  } catch {
    return emptyState();                       // a corrupt document must not break the site
  }
}

export async function writeState(state) {
  if (!isConfigured()) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  const doc = { ...normalise(state), v: STATE_VERSION, updated: new Date().toISOString() };
  await put(STATE_PATH, JSON.stringify(doc, null, 2), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,                      // one document, rewritten in place
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return doc;
}

/** Coerce anything read from storage into the shape the rest of the code assumes. */
export function normalise(raw) {
  const sales = Array.isArray(raw?.sales) ? raw.sales.filter((s) => s && s.id) : [];
  const active = sales.some((s) => s.id === raw?.active) ? raw.active : null;
  return { v: STATE_VERSION, updated: raw?.updated || null, active, sales };
}

export function findSale(state, id) {
  return (state?.sales || []).find((s) => s.id === id) || null;
}

/* Is a sale live right now? Pure, so it can be unit-tested without a network or a clock.

   Both gates in one place. `now` is passed in rather than read, because a function that reads
   the clock is a function you cannot test at 11:59pm on the last day of a sale. */
export function resolveActive(state, now = new Date()) {
  const s = findSale(state, state?.active);
  if (!s) return null;
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const start = Date.parse(s.startsAt);
  const end = Date.parse(s.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // Both ends INCLUSIVE. `endsAt` is the last instant of the owner's chosen day
  // (23:59:59.999 Eastern), so the window has to contain it — otherwise the sale is over one
  // millisecond before the date printed on the bar.
  if (t < start || t > end) return null;
  return s;
}

/** Live / Scheduled / Ended / Draft — the label the console shows on each row. */
export function saleStatus(state, sale, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const start = Date.parse(sale?.startsAt);
  const end = Date.parse(sale?.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'draft';
  if (t > end) return 'ended';
  if (state?.active !== sale.id) return 'draft';
  return t < start ? 'scheduled' : 'live';
}

/* What the public is allowed to see.

   Deliberately a whitelist, not a delete-list: the stored record carries Stripe ids and
   internal notes, and a future field added to the console must not reach the open internet
   just because nobody remembered to strip it here. */
export function publicView(sale) {
  return {
    active: true,
    id: String(sale.id),
    title: String(sale.title || 'Sale'),
    percent: Number(sale.percent) || 0,
    code: String(sale.code || ''),
    endsAt: String(sale.endsAt),
    icon: ICONS.includes(sale.icon) ? sale.icon : 'tag',
    url: SALE_URL,
  };
}
