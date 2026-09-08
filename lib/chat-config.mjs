/* Site assistant — the settings the owner controls, shared between the console and the site.

   ONE document, written by the owner console and read by api/chat.mjs. That is the same
   arrangement as lib/sale-state.mjs, and for the same reason: the owner must be able to
   change how the assistant behaves — above all, to switch it OFF — without a deploy, a
   build, or waiting on Vercel. Modelled on that file deliberately; if you are changing
   one, look at the other.

   ⚠ THE OFF SWITCH IS THE ENDPOINT, NOT THE WIDGET.
   api/chat.mjs reads this before every model call, so `enabled:false` stops all spend
   immediately and cannot be bypassed by a cached chat.js, a stale CDN copy, or a visitor
   who left a tab open overnight. The widget hiding itself is cosmetic catch-up that
   happens on the visitor's next page load. Those are two different moments and the guide
   should say so.

   ⚠ WHAT IS DELIBERATELY NOT HERE: the system prompt. The persona, the accuracy rules and
   the no-advice guardrails live in lib/chat-context.mjs, in git, where a change is
   reviewable and revertable. `houseNotes` below is a short appendix for "there is a sale
   on" or "steer off topic X" — it is appended to the VOLATILE block and cannot remove a
   rule. An owner-editable system prompt is one paste away from having no disclaimer.

   Env: BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID under OIDC) — see lib/blob-auth.mjs. */

import { put, get } from '@vercel/blob';
import { blobConfigured, blobToken } from './blob-auth.mjs';

export const STATE_PATH = 'chat/config.json';
export const STATE_VERSION = 1;

/* ⚠ `enabled` defaults to FALSE. A half-finished deploy, an unreachable blob store or a
   corrupt document must all leave the assistant switched off and invisible — never
   accidentally live and spending. Every failure path below returns these defaults. */
export const DEFAULTS = {
  enabled: false,
  model: 'claude-sonnet-5',
  maxMessagesPerVisitor: 10,
  dailyCeilingUsd: 3,
  hourlyCeilingUsd: 1.5,
  /* Which pages show the launcher. '*' means everywhere. Paths are matched exactly, with
     '/' meaning the home page. Held here rather than in the script so the reach can be
     widened or narrowed from the console without a build. */
  placement: ['/', '/index.html', '/products.html', '/features.html',
    '/how-it-works.html', '/demo.html', '/faq.html', '/technical.html'],
  houseNotes: '',
  /* Answers the owner has written for questions they expect. ⚠ These are fed to the model as
     preferred wording, NOT returned instead of it. A matcher that decided "this question is
     that question" would fire the wrong answer confidently — the same reason isContentGap()
     in chat-context.mjs is not used as an off-topic classifier. The model reads them and
     answers from them, so rephrasing and follow-ups still work. */
  qa: [],
  /* Set by the endpoint itself when a ceiling trips — never by a person. It stays set
     until the owner presses Resume, which is the whole point: an attack or a runaway bug
     must not be able to refill its budget at midnight. */
  pausedAt: null,
  pausedReason: '',
  pausedDetail: null,
};

export function isConfigured() {
  return blobConfigured();
}

export function emptyConfig() {
  return { ...DEFAULTS, v: STATE_VERSION, updated: null };
}

/* Coerce anything read from storage into the shape the rest of the code assumes.
   Defensive on every field: this parses a document that may have been written by an older
   console, and a missing key must degrade to the safe default rather than to a crash. */
export function normalise(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };
  return {
    v: STATE_VERSION,
    updated: typeof d.updated === 'string' ? d.updated : null,
    enabled: d.enabled === true,                       // ⚠ anything but exactly true is off
    model: typeof d.model === 'string' && d.model ? d.model : DEFAULTS.model,
    maxMessagesPerVisitor: num(d.maxMessagesPerVisitor, DEFAULTS.maxMessagesPerVisitor, 1, 100),
    dailyCeilingUsd: num(d.dailyCeilingUsd, DEFAULTS.dailyCeilingUsd, 0, 1000),
    hourlyCeilingUsd: num(d.hourlyCeilingUsd, DEFAULTS.hourlyCeilingUsd, 0, 1000),
    placement: Array.isArray(d.placement)
      ? d.placement.filter((p) => typeof p === 'string').slice(0, 200)
      : [...DEFAULTS.placement],
    houseNotes: typeof d.houseNotes === 'string' ? d.houseNotes.slice(0, 1500) : '',
    /* Capped hard. This document is read on every request, so an unbounded list here would
       be an unbounded read; and only a handful can be shown to the model per question
       anyway. Entries that survive are trimmed, not rejected — a truncated answer is worth
       more to the owner than a silently dropped one. */
    qa: Array.isArray(d.qa)
      ? d.qa
        .filter((e) => e && typeof e.q === 'string' && typeof e.a === 'string')
        .map((e) => ({ q: e.q.trim().slice(0, 200), a: e.a.trim().slice(0, 900) }))
        .filter((e) => e.q && e.a)
        .slice(0, 40)
      : [],
    pausedAt: typeof d.pausedAt === 'string' ? d.pausedAt : null,
    pausedReason: typeof d.pausedReason === 'string' ? d.pausedReason.slice(0, 200) : '',
    pausedDetail: d.pausedDetail && typeof d.pausedDetail === 'object' ? d.pausedDetail : null,
  };
}

/* ⚠ Must be get() with the token, NOT fetch(blob.downloadUrl). A private blob's URL returns
   403 unauthenticated, so a plain fetch fails SILENTLY and the assistant would read as
   "never configured" whatever is actually stored. That bug has shipped three times in this
   codebase already (affiliate payouts, search analytics, the sale banner). */
async function readRaw() {
  if (!isConfigured()) return emptyConfig();
  let r;
  try {
    r = await get(STATE_PATH, { access: 'private', token: blobToken() });
  } catch {
    return emptyConfig();                    // unreachable store => switched off
  }
  if (!r || r.statusCode !== 200 || !r.stream) return emptyConfig();
  try {
    return normalise(JSON.parse(await new Response(r.stream).text()));
  } catch {
    return emptyConfig();                    // a corrupt document must not turn it on
  }
}

/* A short in-process cache, and the reason for it is cost, not speed.

   Without it every message pays a blob round-trip before the model call. With it, an
   instance re-reads at most twice a minute. The price is that switching the assistant off
   can take up to TTL_MS to reach an already-warm instance — up to 20 seconds, which is
   the honest number to quote rather than "instant".

   ⚠ Do NOT raise this to save reads. The off switch is a safety control and its latency is
   the thing being traded away. */
const TTL_MS = 20_000;
let _cache = null;
let _cacheAt = 0;

export async function readConfig({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _cache && now - _cacheAt < TTL_MS) return _cache;
  _cache = await readRaw();
  _cacheAt = now;
  return _cache;
}

export async function writeConfig(next) {
  if (!isConfigured()) {
    throw new Error('no blob credential: set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID for OIDC');
  }
  const doc = { ...normalise(next), v: STATE_VERSION, updated: new Date().toISOString() };
  await put(STATE_PATH, JSON.stringify(doc, null, 2), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,                    // one document, rewritten in place
    addRandomSuffix: false,
    token: blobToken(),
  });
  /* Update from what we just wrote rather than re-reading. ⚠ A blob takes ~2.4s to become
     readable, so a read here would hand back the OLD document and look like the write was
     ignored. */
  _cache = doc;
  _cacheAt = Date.now();
  return doc;
}

/** Switch the assistant off because a ceiling tripped. Sets the pause record the console
 *  shows, so the owner can tell "busy day" from "one person hammering it" at a glance. */
export async function pauseForSpend(reason, detail) {
  const cfg = await readConfig({ fresh: true });
  if (!cfg.enabled) return cfg;              // already off; do not overwrite an earlier record
  return writeConfig({
    ...cfg,
    enabled: false,
    pausedAt: new Date().toISOString(),
    pausedReason: String(reason || 'spend ceiling reached').slice(0, 200),
    pausedDetail: detail || null,
  });
}

/** Is the launcher meant to appear on this path? */
export function showsOn(cfg, pathname) {
  if (!cfg || !cfg.enabled) return false;
  const list = cfg.placement || [];
  if (list.includes('*')) return true;
  const p = String(pathname || '/').split('?')[0].split('#')[0];
  if (list.includes(p)) return true;
  // '/' and '/index.html' are the same page; a visitor should not see different behaviour
  // depending on which form of the URL they arrived at.
  if ((p === '/' || p === '/index.html') && (list.includes('/') || list.includes('/index.html'))) {
    return true;
  }
  return false;
}
