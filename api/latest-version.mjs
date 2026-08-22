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
const LATEST = { build: 356, released: '2026-08-22', headline: 'Fetch current rates now covers every annual figure — the whole IRMAA ladder, Medicare premiums, poverty levels, the RMD age and the Australian tax rates — and shows you every proposed change, old beside new, before anything touches your plan. This copy also ships with the current year’s figures already in it.' }; /* __LATEST__ */

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

  // Half an hour at the edge. A new release does not need to propagate instantly —
  // the app only asks once a day anyway.
  res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=1800');
  return res.status(200).json({
    build: LATEST.build,
    released: LATEST.released,
    headline: LATEST.headline,
    notesUrl: `${SITE}/updates.html`,
  });
}
