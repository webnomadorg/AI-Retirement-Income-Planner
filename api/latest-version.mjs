/* Version feed — GET /api/latest-version

   Tells an installed copy of the planner whether a newer build exists. The app
   fetches this at most once a day and shows an "Update available" chip if the
   build number here is higher than its own APP_BUILD.

   Deliberately carries NO personal data in either direction: no email, no plan
   data, no identifiers. It is a public, cacheable constant. The email-gated part
   of the flow lives in api/update-download.mjs.

   Why a function and not a static latest-version.json:
   the app runs from file:// so its Origin is "null", which means it needs an
   explicit Access-Control-Allow-Origin header. A static file can only get one via
   a "headers" block in vercel.json — and this project's vercel.json still uses the
   legacy "routes" key, which Vercel refuses to combine with "headers". Rewriting
   that routing would risk the real 404 status on a live selling site, so the
   version feed is served from here instead, where it can set its own headers.

   NOTE: classic Node (req, res) signature — the web-standard handler(request)
   form crashes this project's runtime with FUNCTION_INVOCATION_FAILED. Same
   constraint as api/download.mjs. */

// ↓ SINGLE SOURCE OF TRUTH for "newest build customers can actually download".
//
//   ⚠ This MUST match the planner HTML inside the delivery ZIPs — NOT merely the newest
//   build sitting on the developer's disk. Set it too high and every customer is told an
//   update exists, follows the link, and is handed the same file they already have.
//
//   Rewritten automatically by tools/stripe/upload-blobs.mjs, which reads the build number
//   straight out of "marketplace assets/planner version 7 files/" and runs at the exact
//   moment the ZIPs are refreshed — so the two cannot drift apart. Safe to hand-edit;
//   keep the line shape (the script matches it by regex).
const LATEST = { build: 368, released: '2026-08-22', headline: 'Canadian tax figures corrected — the federal rates and all four bracket ceilings are now a single current set rather than a mix of two years — along with the 2026 Medicare Part D premium. If you plan in Canadian dollars, your figures will shift slightly.' }; /* __LATEST__ */

const SITE = 'https://airetirementincomeplanner.com';

export default async function handler(req, res) {
  // The planner is a file:// page, so its Origin is "null" — allow any origin.
  // Nothing here is private or user-specific, so there is nothing to protect.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* ── Version-check analytics ───────────────────────────────────────────────────────
     A planner that sends ?from=<its own build> is telling us which build is still in use.
     That is the only way to know how many copies are live and how fast a release reaches
     them — see Website/lib/version-log.mjs for what is stored (a build number and a date,
     nothing else) and Plans/Admin-Console-Charts.md for why.

     ⚠ THE CACHE IS THE WHOLE DIFFICULTY. The default response is cached at the edge for
     half an hour, which means most checks never reach this function — fine for serving a
     constant, useless for counting. So a request carrying ?from= opts out of the cache and
     is counted; everything else keeps the cheap cached path, byte for byte as before.

     ⚠ NOTHING HERE MAY BE ABLE TO BREAK THE VERSION FEED. Every installed copy depends on
     this endpoint, and it has been taken down by a one-character mistake before. Hence the
     dynamic import inside a try/catch: if the logging module is missing, throws on import,
     or the blob store is unreachable, the customer still gets their answer. */
  let counted = false;
  try {
    const qs = String(req.url || '').indexOf('?');
    const from = qs === -1 ? null : new URLSearchParams(req.url.slice(qs + 1)).get('from');
    if (from !== null) {
      const { logPing, cleanBuild, isConfigured } = await import('../lib/version-log.mjs');
      /* `isConfigured()` is checked BEFORE opting out of the cache. Without it, a
         deployment with no blob store would give up the edge cache on every check and
         store nothing in return — paying the whole cost for none of the benefit, silently.
         Conversely, once the store IS configured the opt-out is unconditional rather than
         contingent on the write succeeding: an intermittent failure would otherwise cache
         intermittently and undercount in a way nobody could see. */
      if (cleanBuild(from) !== null && isConfigured()) {
        counted = true;
        // Awaited on purpose: a serverless function may be frozen the instant it responds,
        // so a fire-and-forget write is a write that sometimes does not happen.
        await logPing(from);
      }
    }
  } catch { /* analytics must never cost a customer their update check */ }

  if (counted) {
    // Must not be cached, or one install's check would be served to all the others and
    // counted once. This path is only taken by the daily check, so the cost is one
    // invocation per copy per day.
    res.setHeader('Cache-Control', 'no-store');
  } else {
    // Half an hour at the edge. A new release does not need to propagate instantly —
    // the app only asks once a day anyway.
    res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800');
  }
  return res.status(200).json({
    build: LATEST.build,
    released: LATEST.released,
    headline: LATEST.headline,
    notesUrl: `${SITE}/updates.html`,
  });
}
