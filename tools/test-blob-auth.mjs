/* Self-test for lib/blob-auth.mjs — run: node Website/tools/test-blob-auth.mjs

   Gated because this decides whether whole features write anything at all, and it fails in the
   quiet direction. If blobConfigured() says "no" on a healthy OIDC deployment, the signup log
   stops recording and the one-confirmation-per-day cap turns itself off — with no error, and
   every page still rendering perfectly. */

import { blobConfigured, blobToken, blobUsingOidc } from '../lib/blob-auth.mjs';

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; return; } fail++; console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); };
const eq = (l, g, w) => ok(l, Object.is(g, w), `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

const TOKEN = 'BLOB_READ_WRITE_TOKEN', STORE = 'BLOB_STORE_ID';
const saved = { [TOKEN]: process.env[TOKEN], [STORE]: process.env[STORE] };
const set = (t, s) => {
  if (t === undefined) delete process.env[TOKEN]; else process.env[TOKEN] = t;
  if (s === undefined) delete process.env[STORE]; else process.env[STORE] = s;
};

console.log('the four states');

set('vercel_blob_rw_abc', undefined);
eq('token only: configured', blobConfigured(), true);
eq('  … not OIDC mode', blobUsingOidc(), false);
eq('  … and the token is handed to the SDK', blobToken(), 'vercel_blob_rw_abc');

/* THE CASE THAT WAS BROKEN: OIDC leaves NO blob credential in the environment, because the
   token arrives on a request header. Only BLOB_STORE_ID is there to see. */
set(undefined, 'store_abc123');
eq('OIDC (store id only): configured', blobConfigured(), true);
eq('  … reports OIDC mode', blobUsingOidc(), true);
eq('  … and hands the SDK undefined, so it resolves OIDC itself', blobToken(), undefined);

set('vercel_blob_rw_abc', 'store_abc123');
eq('both present: configured', blobConfigured(), true);
eq('  … token wins, so not OIDC mode', blobUsingOidc(), false);

set(undefined, undefined);
eq('neither: NOT configured', blobConfigured(), false);
eq('  … and not OIDC either', blobUsingOidc(), false);

console.log('empty strings are not credentials');
set('', '');
eq('empty strings do not count as configured', blobConfigured(), false);

// Restore, so this file is safe to import alongside anything else.
set(saved[TOKEN], saved[STORE]);
ok('environment restored', process.env[TOKEN] === saved[TOKEN]);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
