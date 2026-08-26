/* Sitewide sale banner — the shared state file.

   ONE definition of the sale state, used from two sides:
     - the owner console (tools/admin/sales.mjs) WRITES it,
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

   AUTOMATED SALES ARE DERIVED, NOT SWITCHED ON.
   A row with `auto:true` was minted ahead of time by the console — Stripe coupon and promotion
   code already created, window already computed. Nothing activates it when it starts: the
   resolver simply picks whichever minted window contains `now`. That is the whole reason this
   design needs no cron and no write-capable Stripe key in production.

   ⚠ WHY `tier` IS STORED ON THE ROW. Precedence between colliding occasions needs to know which
   tier an occasion is, and that table lives in tools/admin/sales.mjs — console code that
   imports Stripe. This module runs in a Vercel function and must never import it. So the tier
   travels on the minted row instead, written once at mint time.

   Layout: sale/state.json — a single small document, overwritten in place.
   Env: BLOB_READ_WRITE_TOKEN (private Blob store) */

import { put, get } from '@vercel/blob';
import { blobConfigured } from './blob-auth.mjs';

export const STATE_PATH = 'sale/state.json';
export const STATE_VERSION = 2;

/* Defaults for the automation block. A v1 document has no `auto` key at all, so these are also
   what "automation has never been configured" means — and `enabled:false` makes that safe. */
export const AUTO_DEFAULTS = {
  enabled: false,
  include: [],          // explicit allowlist of occasion ids — an empty list runs nothing
  maxPercent: 20,       // ⚠ see normalise(): a sale above this is never served
  /* A MINT-time rule; recorded here so the console has one home for it. 14 was measured, not
     guessed: over a 24-month tier-1 run it gives ~10 sales a year across 66 days (18%), and the
     only occasions it drops are the two that genuinely collide with Tax Day. At 21 it also
     silently loses Tax Season and ACA Open Enrollment, both tier 1 and both on-message. */
  minGapDays: 14,
  mintedThrough: null,  // ISO day the console has minted up to; null = nothing minted
  suppressed: {},       // { [saleId]: ISO instant } — occurrences ended early by the owner
};

/** The icons assets/js/sale.js knows how to draw. Anything else falls back to `tag`. */
export const ICONS = ['tag', 'gift', 'bolt', 'leaf', 'calendar'];

/** Where the banner sends anyone who clicks it. */
export const SALE_URL = '/products.html';

export function isConfigured() {
  return blobConfigured();
}

export function emptyState() {
  return { v: STATE_VERSION, updated: null, active: null, sales: [], auto: { ...AUTO_DEFAULTS } };
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
  if (!isConfigured()) throw new Error('no blob credential: set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID for OIDC');
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

/* Coerce anything read from storage into the shape the rest of the code assumes.

   Defensive on every field, because this parses a document that may have been written by an
   older version of the console — a v1 document has no `auto` key at all, and must normalise
   into "automation off" rather than into a crash. */
export function normalise(raw) {
  const sales = Array.isArray(raw?.sales) ? raw.sales.filter((s) => s && s.id) : [];
  const active = sales.some((s) => s.id === raw?.active) ? raw.active : null;
  const a = raw?.auto && typeof raw.auto === 'object' ? raw.auto : {};
  const maxPercent = Number(a.maxPercent);
  const minGapDays = Number(a.minGapDays);
  const auto = {
    enabled: a.enabled === true,
    include: Array.isArray(a.include) ? a.include.filter((x) => typeof x === 'string') : [],
    maxPercent: Number.isFinite(maxPercent) ? maxPercent : AUTO_DEFAULTS.maxPercent,
    minGapDays: Number.isFinite(minGapDays) ? minGapDays : AUTO_DEFAULTS.minGapDays,
    mintedThrough: typeof a.mintedThrough === 'string' ? a.mintedThrough : null,
    suppressed: a.suppressed && typeof a.suppressed === 'object' && !Array.isArray(a.suppressed)
      ? a.suppressed : {},
  };
  return { v: STATE_VERSION, updated: raw?.updated || null, active, sales, auto };
}

export function findSale(state, id) {
  return (state?.sales || []).find((s) => s.id === id) || null;
}

const ms = (now) => (now instanceof Date ? now.getTime() : new Date(now).getTime());

/* Does this sale's window contain `t`?

   Both ends INCLUSIVE. `endsAt` is the last instant of the owner's chosen day (23:59:59.999
   Eastern), so the window has to contain it — otherwise the sale is over one millisecond before
   the date printed on the bar. */
export function inWindow(sale, t) {
  const start = Date.parse(sale?.startsAt);
  const end = Date.parse(sale?.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return t >= start && t <= end;
}

/* Could this minted row be served at all — ignoring its dates and any rival?

   Four independent reasons an automated sale does not run, and all of them are the owner's:
   the master switch, the allowlist, ending that occurrence early, and the rate ceiling.

   ⚠ The maxPercent check is a genuine safety net, not decoration. `percent` is baked into the
   Stripe coupon at mint time, so lowering the ceiling later cannot change an already-minted
   sale. Enforcing it here means the lower ceiling takes effect immediately — the sale simply
   stops being served — instead of silently waiting for a re-mint nobody remembers to do. */
export function autoEligible(state, sale) {
  if (!sale?.auto) return false;
  const auto = state?.auto;
  if (!auto?.enabled) return false;
  if (!auto.include.includes(sale.occasion)) return false;
  if (Object.prototype.hasOwnProperty.call(auto.suppressed, sale.id)) return false;
  return Number(sale.percent) <= Number(auto.maxPercent);
}

/* Which minted sale wins right now?

   Occasions collide — in 2027 Financial Literacy Month overlaps three tier-1 April sales, and
   26 Dec is wanted by Christmas, Boxing Day and Year-End at once. Only one sale can be active,
   so the tie has to break deterministically:

     1. tier 1 before tier 2   — on-message for the product beats generic retail
     2. earlier start          — the sale already running is not interrupted by a newcomer
     3. shorter window         — a focused 3-day sale beats a month-long catch-all
     4. id                     — so the answer never depends on array order

   Pure, and total: same state and same instant always give the same winner. */
export function pickAutoSale(state, now = new Date()) {
  const t = ms(now);
  const candidates = (state?.sales || [])
    .filter((s) => autoEligible(state, s) && inWindow(s, t));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (
    (Number(a.tier) || 99) - (Number(b.tier) || 99)
    || Date.parse(a.startsAt) - Date.parse(b.startsAt)
    || (Date.parse(a.endsAt) - Date.parse(a.startsAt)) - (Date.parse(b.endsAt) - Date.parse(b.startsAt))
    || String(a.id).localeCompare(String(b.id))
  ));
  return candidates[0];
}

/* Is a sale live right now? Pure, so it can be unit-tested without a network or a clock.

   `now` is passed in rather than read, because a function that reads the clock is a function
   you cannot test at 11:59pm on the last day of a sale.

   ⚠ A MANUAL SALE ALWAYS BEATS AN AUTOMATED ONE. Someone pressed a button; the calendar did
   not. If that manual sale is over (or has not started), automation is asked instead — which is
   what makes a one-off sale a temporary override rather than a hole in the schedule. */
export function resolveActive(state, now = new Date()) {
  const t = ms(now);
  const manual = findSale(state, state?.active);
  if (manual && inWindow(manual, t)) return manual;
  return pickAutoSale(state, t);
}

/* Live / Scheduled / Superseded / Ended / Draft — the label the console shows on each row.

   `superseded` exists only for automated rows: its window contains now, everything about it is
   eligible, and it still is not showing because something else outranked it. Without the label
   that row would read "draft" and look like a bug. */
export function saleStatus(state, sale, now = new Date()) {
  const t = ms(now);
  const start = Date.parse(sale?.startsAt);
  const end = Date.parse(sale?.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'draft';
  if (t > end) return 'ended';
  if (state?.active === sale.id) return t < start ? 'scheduled' : 'live';
  if (autoEligible(state, sale)) {
    if (t < start) return 'scheduled';
    const winner = resolveActive(state, t);
    return winner && winner.id === sale.id ? 'live' : 'superseded';
  }
  return 'draft';
}

/* Hide a promo code while keeping its shape.

   ⚠ Needed because an AUTOMATED sale's code is live in Stripe from the moment it is minted —
   that is the trade that removes the runtime Stripe write. A manual sale's code is created
   inactive, so ?preview= could safely show it; an automated one cannot, and the preview id is
   guessable (`black-friday-2027`). Masked rather than removed so the bar can still be checked
   for layout, which is the only thing a preview is for. */
export function maskCode(code) {
  const s = String(code || '');
  if (s.length <= 2) return '••';
  return s.slice(0, 2) + '•'.repeat(s.length - 2);
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
