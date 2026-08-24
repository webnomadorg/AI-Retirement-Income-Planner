/* Version beacon — GET /api/version-ping?build=<n>

   Records that a copy of the planner on build <n> is still in use. That is the whole job.
   What it is counted into and why: Website/lib/version-log.mjs and
   Plans/Admin-Console-Charts.md.

   ══ WHY THIS IS A SEPARATE ENDPOINT, AND MUST STAY ONE ═════════════════════════════════
   The obvious place for this was /api/latest-version — the planner already calls it once a
   day. It was built that way first, and then deliberately taken back out.

   The reason is that /api/latest-version is what makes the customer's **Update available**
   button work, and the planner abandons that request after 6 seconds
   (`AbortSignal.timeout(6000)` in src/03-app.js). Writing a record before replying puts a
   storage dependency inside a customer-facing feature: on a normal day the write takes
   165–605 ms and nobody notices, but a slow or unavailable blob store would stall the reply
   until the planner gave up — and that failure is SILENT by design, because the planner is
   routinely used offline and must never nag. The update button would simply stop noticing
   new releases, with no error anywhere, because of an analytics dependency.

   Splitting it in two removes the possibility rather than managing it:

     • /api/latest-version is byte-for-byte what it was before any of this existed. It never
       touches storage, keeps its 30-minute edge cache, and cannot be slowed down by this
       file.
     • This endpoint is called fire-and-forget, AFTER the update check has already finished.
       Nothing reads its response. If it is slow, errors, or is deleted outright, the planner
       cannot tell and the update button is unaffected.
     • Any rate-limit rule targets THIS path, so a misconfigured firewall rule cannot reach
       the update check either — see Plans/Vercel-Hardening.md.

   ⚠ Do not "simplify" this back into the version feed. The duplication is the safety.

   ⚠ Public and unauthenticated, with a write behind it. The build number is range-checked,
   which bounds directory sprawl but not volume; the rate-limit rule is the real mitigation,
   and the instant kill switch is deleting this file — after which the beacon 404s, the
   planner swallows it, and nothing else changes.

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form crashes
   this project's runtime with FUNCTION_INVOCATION_FAILED. Same constraint as
   api/latest-version.mjs and api/download.mjs. */

export default async function handler(req, res) {
  // The planner is a file:// page, so its Origin is "null" — allow any origin. There is
  // nothing to protect: the request carries a build number and the reply carries nothing.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  // Never cached: a cached beacon is a beacon that counts one copy and ignores the rest.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).end();
  }

  /* Always 204, whatever happens. The caller is a beacon that ignores the response, so an
     error status would tell nobody anything — while a thrown error would show up in the logs
     as a broken endpoint on a live selling site. Recording is best-effort by definition. */
  try {
    const qs = String(req.url || '').indexOf('?');
    const build = qs === -1 ? null : new URLSearchParams(req.url.slice(qs + 1)).get('build');
    if (build !== null) {
      const { logPing } = await import('../lib/version-log.mjs');
      await logPing(build);        // ignores anything that is not a sane build number
    }
  } catch { /* best-effort by design */ }

  return res.status(204).end();
}
