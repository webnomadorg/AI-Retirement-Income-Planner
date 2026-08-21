/* Listing a Blob prefix COMPLETELY.
 *
 * ⚠ THE BUG THIS EXISTS TO PREVENT
 * `list()` returns at most **1000** blobs per call and reports the rest through `hasMore` +
 * `cursor`. A plain `const { blobs } = await list({ prefix })` therefore stops at 1000 and
 * gives no indication that it did — no error, no warning, just a shorter array.
 *
 * Every consumer here reads that array as "everything", so the failure surfaces as wrong
 * ANSWERS rather than as a crash: a signup overview that shows old days and silently omits
 * recent ones, a bot verdict that reads "unknown" because the records it needed were past the
 * cut, a purge that thinks there is nothing old left to delete.
 *
 * ⚠ AND THE TRUNCATION FAVOURS THE WRONG END. Pathnames sort lexicographically, and these
 * prefixes are dated (`signup-log/2026-08-21/…`), so the first 1000 are the OLDEST. The
 * records that get dropped are the newest — the ones every panel is actually about.
 *
 * Measured 21 Aug 2026: signup-log/ held 358 records and was growing ~45/day, which is about
 * a fortnight from the cap. Retention does not save it either — 90 days at that rate is a
 * steady state of ~4000, four times the page size.
 *
 * `lister` is injectable so the paging loop can be tested without a blob store.
 */
import { list } from '@vercel/blob';

/** Hard stop on the loop. 50 pages is 50,000 blobs — far beyond any prefix here, and cheap
 *  insurance against a cursor that never terminates. Hitting it is shouted about, not hidden. */
const MAX_PAGES = 50;

export async function listAll(options = {}, lister = list) {
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await lister({ ...options, ...(cursor ? { cursor } : {}) });
    out.push(...(r?.blobs || []));
    // Trust `cursor` over `hasMore`: a truthy cursor is the only thing that can actually
    // continue, and a `hasMore: true` with no cursor would spin forever.
    cursor = r?.hasMore ? r.cursor : undefined;
    if (!cursor) return out;
  }
  console.error(
    `[blob-list] stopped at ${MAX_PAGES} pages (${out.length} blobs) for prefix ` +
    `"${options.prefix || ''}" — the listing is INCOMPLETE. Raise MAX_PAGES or add retention.`
  );
  return out;
}
