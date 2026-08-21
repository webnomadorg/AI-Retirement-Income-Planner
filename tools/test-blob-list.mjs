/* Self-test for lib/blob-list.mjs — run: node Website/tools/test-blob-list.mjs
   No blob store: the lister is injected.

   Gated because the failure mode is silence. A paging loop that stops early returns a
   perfectly valid, perfectly wrong array, and every caller treats it as the whole truth. */

import { listAll } from '../lib/blob-list.mjs';

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; return; } fail++; console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); };
const eq = (l, g, w) => ok(l, Object.is(g, w), `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

/** A fake store of `n` blobs that hands out pages of `size`, exactly as Vercel's does. */
function fakeStore(n, size = 1000) {
  const all = Array.from({ length: n }, (_, i) => ({ pathname: `p/${String(i).padStart(5, '0')}` }));
  let calls = 0;
  const lister = async ({ cursor }) => {
    calls += 1;
    const start = cursor ? Number(cursor) : 0;
    const blobs = all.slice(start, start + size);
    const next = start + size;
    return { blobs, hasMore: next < n, cursor: next < n ? String(next) : undefined };
  };
  return { lister, calls: () => calls, all };
}

console.log('paging');
for (const n of [0, 1, 999, 1000, 1001, 4000]) {
  const s = fakeStore(n);
  const got = await listAll({ prefix: 'p/' }, s.lister);
  eq(`${n} blob(s): all returned`, got.length, n);
}
const big = fakeStore(4000);
await listAll({ prefix: 'p/' }, big.lister);
eq('4000 blobs takes 4 pages', big.calls(), 4);

const exact = fakeStore(1000);
const gotExact = await listAll({ prefix: 'p/' }, exact.lister);
eq('exactly 1000 returns 1000', gotExact.length, 1000);
ok('  … and does not fetch a pointless extra page', exact.calls() === 1, `${exact.calls()} call(s)`);

console.log('order is preserved');
const ord = fakeStore(2500);
const got = await listAll({ prefix: 'p/' }, ord.lister);
ok('first blob is the first page\'s first', got[0].pathname === 'p/00000');
ok('last blob is the final page\'s last', got[got.length - 1].pathname === 'p/02499');

console.log('safety');
// hasMore true but no cursor: nothing could continue, so it must stop rather than spin.
let spun = 0;
const noCursor = async () => { spun += 1; return { blobs: [{ pathname: 'x' }], hasMore: true, cursor: undefined }; };
const r = await listAll({}, noCursor);
eq('hasMore with no cursor stops immediately', spun, 1);
eq('  … and still returns what it got', r.length, 1);

// A cursor that never terminates must hit the cap, not run for ever.
let runaway = 0;
const forever = async () => { runaway += 1; return { blobs: [{ pathname: 'y' }], hasMore: true, cursor: 'always' }; };
const rr = await listAll({ prefix: 'runaway/' }, forever);
ok('a non-terminating cursor is capped', runaway === 50, `${runaway} call(s)`);
eq('  … and returns the partial result rather than throwing', rr.length, 50);

const empty = await listAll({}, async () => ({ blobs: undefined, hasMore: false }));
eq('a malformed page does not throw', empty.length, 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
