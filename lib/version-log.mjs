/* Version-check analytics — storage helpers.

   Answers two questions nothing else can: roughly how many installed copies of the planner
   are still in use, and how fast a new release actually reaches them. The planner asks
   /api/latest-version once a day whether a newer build exists; this records the asking.

   WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
   A record is a build number and a date. That is the whole of it. No email, no IP, no user
   agent, no cookie, no session identifier, and nothing that could tie two checks to the same
   copy — which also means this cannot count PEOPLE, only checks. See `aggregate()`. The
   product sells on a privacy promise; analytics that quietly built a per-install profile
   would contradict it, and the planner's own CSP comment tells the customer what this request
   carries. Keep those two in step: if this file ever starts recording more, that sentence in
   `src/01-head.html` becomes false.

   Layout: version-log/<YYYY-MM-DD>/<build>/<epoch>-<rand>.json

   ⚠ EVERYTHING IS IN THE PATHNAME ON PURPOSE. The body is a formality; `aggregate()` reads
   only blob names and never fetches one. That is the same trick `signup-quarantine.mjs` uses,
   and it is what keeps the console fast as history piles up.

   ⚠ SCALING LIMIT, stated so it is not discovered the hard way: this writes one blob per
   check, so the store grows at (installs × days). At a few hundred installs that is fine. If
   it ever reaches thousands, listing stops being cheap and this needs a nightly rollup — a
   per-day summary blob that `aggregate()` reads instead of counting names. Do not "fix" it by
   deduplicating writes: the per-check blob IS the count.

   ⚠ ABUSE: /api/latest-version is public and unauthenticated, so a determined caller can
   inflate the store by hammering `?from=`. The build number is range-checked, which bounds
   how many directories can be created, but not the volume. The real mitigation is a Vercel
   WAF rate-limit rule on that path — see Plans/Vercel-Pro-Hardening.md, which still has rules
   outstanding. Worth adding before this is relied on for anything.

   Env: BLOB_READ_WRITE_TOKEN, or OIDC + BLOB_STORE_ID (see blob-auth.mjs) */

import { put } from '@vercel/blob';
import { listAll } from './blob-list.mjs';
import { blobConfigured, blobToken } from './blob-auth.mjs';

const PREFIX = 'version-log/';

/* Planner builds are in the high hundreds. The ceiling is not a guess at how far the product
   will get — it is a bound on how many junk directories one caller can create. */
export const MIN_BUILD = 1;
export const MAX_BUILD = 9999;

/* Long enough to compare one release with the last few, short enough that listing stays
   quick. Adoption is a question about weeks, not years. */
export const RETENTION_DAYS = 180;

export function isConfigured() {
  return blobConfigured();
}

/** A usable build number, or null. Anything else is ignored rather than stored. */
export function cleanBuild(raw) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n < MIN_BUILD || n > MAX_BUILD) return null;
  return n;
}

/** Record one check. Returns the key written, or null if it was not stored. */
export async function logPing(rawBuild, now = new Date()) {
  if (!isConfigured()) return null;
  const build = cleanBuild(rawBuild);
  if (build === null) return null;
  const day = now.toISOString().slice(0, 10);
  const key = `${PREFIX}${day}/${build}/${now.getTime()}-${Math.random().toString(36).slice(2, 10)}.json`;
  await put(key, '1', {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: false,
    addRandomSuffix: false,
    token: blobToken(),
  });
  return key;
}

/** version-log/2026-08-24/368/… → { day, build } */
function parseKey(pathname) {
  const rest = String(pathname || '').slice(PREFIX.length);
  const [day, build] = rest.split('/');
  return {
    day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    build: /^\d+$/.test(build) ? Number(build) : null,
  };
}

/* Delete anything past the retention window. Returns how many went, so the console can say
   so rather than silently shrinking the history someone is looking at. */
export async function purgeExpired(now = new Date()) {
  if (!isConfigured()) return 0;
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  const blobs = await listAll({ prefix: PREFIX, token: blobToken() });
  const stale = (blobs || []).filter((b) => {
    const { day } = parseKey(b.pathname);
    return day && day < cutoff;
  });
  if (!stale.length) return 0;
  const { del } = await import('@vercel/blob');
  await del(stale.map((b) => b.pathname), { token: blobToken() });
  return stale.length;
}

/* Tally the checks. Reads blob NAMES only — never a blob body.

   ⚠ `checks` is not a headcount. Nothing identifies an install, so this counts how many
   checks arrived, not how many distinct copies exist. It is close to the same number because
   the planner checks at most once a day per copy, but a reinstall, a cleared localStorage or
   a second copy on another machine each add one. Report it as "daily checks", never as
   "users" — and never let it appear next to a sales figure implying the two are comparable. */
export async function aggregate(days = 30, now = new Date()) {
  if (!isConfigured()) return { configured: false, days, checks: 0, byDay: [], builds: [], newest: null, purged: 0 };
  const purged = await purgeExpired(now);
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const blobs = await listAll({ prefix: PREFIX, token: blobToken() });

  const byDay = new Map();        // day -> Map(build -> count)
  const builds = new Map();       // build -> count
  let checks = 0;

  for (const b of blobs || []) {
    const { day, build } = parseKey(b.pathname);
    if (!day || build === null || day < cutoff) continue;
    checks += 1;
    builds.set(build, (builds.get(build) || 0) + 1);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const m = byDay.get(day);
    m.set(build, (m.get(build) || 0) + 1);
  }

  const newest = builds.size ? Math.max(...builds.keys()) : null;
  return {
    configured: true,
    days,
    retentionDays: RETENTION_DAYS,
    purged,
    checks,
    // The highest build anyone reported in this window. "Up to date" is measured against
    // this rather than against LATEST.build, so the chart stays honest even when the
    // advertised number and the shipped ZIPs have drifted apart.
    newest,
    builds: [...builds.entries()].map(([build, count]) => ({ build, count })).sort((a, b) => b.build - a.build),
    byDay: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))          // OLDEST first
      .map(([day, m]) => ({
        day,
        total: [...m.values()].reduce((s, n) => s + n, 0),
        builds: [...m.entries()].map(([build, count]) => ({ build, count })).sort((a, b) => b.build - a.build),
      })),
  };
}
