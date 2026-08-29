/* Self-test: the server-side Meta "Purchase" in api/stripe-webhook.mjs.
   Run: node Website/tools/test-purchase-capi.mjs   (also a pre-push guard in tools/website-sync.ps1)

   Why this exists as a test at all: NONE of this is observable in a browser, and none of it
   fails loudly in production. A broken payload is accepted by Meta and simply never matches;
   a dropped field just means the ad optimises against less. The only way to know the shape is
   right is to assert it here.

   No network and no keys: `fetch` is stubbed, so the Stripe expand, the Meta call and Resend
   are all intercepted. The handler is driven with a genuinely HMAC-signed Stripe payload, so
   the signature path is exercised too.

   ⚠ Reads @vercel/blob through the handler's import chain. That resolves from the desktop
   project root's node_modules, same as tools/test-blob-*.mjs. */

import crypto from 'node:crypto';

const SESSION_ID = 'cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ';
const PIXEL = '2106222783607307';

let metaMode = 'ok';      // ok | reject | throw
let captured = [];        // every intercepted request
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/')) {
    if (metaMode === 'nostripe') return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({
        id: SESSION_ID,
        line_items: {
          data: [{
            description: 'Retirement Planner v7',
            price: { product: { id: 'prod_ABC123', name: 'AI Retirement Income Planner v7', metadata: { zip: 'planner-v7.zip' } } },
          }],
        },
      }),
    };
  }
  if (u.startsWith('https://graph.facebook.com/')) {
    if (metaMode === 'throw') throw new Error('getaddrinfo ENOTFOUND graph.facebook.com');
    captured.push({ kind: 'meta', body: JSON.parse(opts.body) });
    if (metaMode === 'reject') return { ok: false, status: 400, text: async () => '{"error":{"message":"Invalid access token"}}' };
    return { ok: true, status: 200, text: async () => '{}' };
  }
  if (u.startsWith('https://api.resend.com/')) {
    captured.push({ kind: 'email', body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '{}' };
  }
  throw new Error('unexpected fetch in test: ' + u);
};

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_harness';
process.env.STRIPE_VERIFY_KEY = 'rk_test_harness';
delete process.env.UPDATE_LOOKUP_PEPPER;   // skip the blob write; not what this covers

const { default: handler } = await import('../api/stripe-webhook.mjs');

/* The handler is deliberately chatty on the paths this test walks (missing pepper, Meta
   rejections). Swallow that, and print it only if something actually fails. */
const noise = [];
const realLog = console.log, realWarn = console.warn, realError = console.error;
const quiet = () => { console.log = console.warn = console.error = (...a) => noise.push(a.join(' ')); };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realError; };

function drive(session = {}, signWith = process.env.STRIPE_WEBHOOK_SECRET) {
  const created = Math.floor(Date.now() / 1000) - 42;
  const body = {
    type: 'checkout.session.completed',
    created,
    data: {
      object: {
        id: SESSION_ID,
        created,
        amount_total: 3749,
        currency: 'usd',
        customer_details: { email: '  Test.Buyer+tag@Example.COM ', name: "Mary-Jane O'Brien", address: { country: 'GB' } },
        ...session,
      },
    },
  };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', signWith).update(`${t}.${raw.toString('utf8')}`, 'utf8').digest('hex');
  const req = {
    method: 'POST',
    headers: { 'stripe-signature': `t=${t},v1=${sig}` },
    async *[Symbol.asyncIterator]() { yield raw; },
  };
  const out = {};
  const res = { setHeader() {}, status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
  return handler(req, res).then(() => ({ ...out, created }));
}

const results = [];
const check = (label, ok) => { results.push([label, !!ok]); };

function reset(env = {}) {
  captured = [];
  metaMode = env.metaMode || 'ok';
  process.env.META_PIXEL_ID = PIXEL;
  process.env.META_CAPI_TOKEN = 'tok_test';
  process.env.RESEND_API_KEY = 're_test';
  delete process.env.META_CAPI_TEST_CODE;
  for (const [k, v] of Object.entries(env.env || {})) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
}

quiet();

/* ---- 1. The payload Meta receives -------------------------------------------------- */
reset();
let out = await drive();
let meta = captured.find((c) => c.kind === 'meta');
if (!meta) {
  loud();
  console.error('FATAL: no Meta call was made at all\n' + noise.join('\n'));
  process.exit(1);
}
let d = meta.body.data[0];
let ud = d.user_data;

check('handler returns 200', out.code === 200);
check('event_name is Purchase', d.event_name === 'Purchase');
check('event_id matches the thanks.html scheme', d.event_id === 'purchase-' + SESSION_ID);
check('event_time is the Stripe timestamp, not now', d.event_time === out.created);
check('action_source is website', d.action_source === 'website');
check('value is in major units', d.custom_data.value === 37.49);
check('currency is uppercase ISO', d.custom_data.currency === 'USD');
check('order_id is the checkout session', d.custom_data.order_id === SESSION_ID);
check('content_ids carries the Stripe product', JSON.stringify(d.custom_data.content_ids) === '["prod_ABC123"]');
check('email is hashed after trim + lowercase', ud.em[0] === sha('test.buyer+tag@example.com'));
check('first name is normalised before hashing', ud.fn[0] === sha('mary-jane'));
check('last name is normalised before hashing', ud.ln[0] === sha('obrien'));
check('country is hashed lowercase', ud.country[0] === sha('gb'));
check('NO raw email anywhere in the payload', !JSON.stringify(meta.body).includes('Test.Buyer'));
// ⚠ The webhook request comes from Stripe. Sending its IP/UA as the buyer's would poison
// match quality rather than improve it — the opposite of what this feature is for.
check('NO client_ip_address (it would be Stripe’s)', ud.client_ip_address === undefined);
check('NO client_user_agent (same reason)', ud.client_user_agent === undefined);
check('no test_event_code when the env var is unset', meta.body.test_event_code === undefined);

/* ---- 2. Dedup: a Stripe redelivery must not become a second conversion -------------- */
reset();
await drive();
const again = captured.find((c) => c.kind === 'meta');
check('a redelivered webhook reuses the same event_id', again.body.data[0].event_id === 'purchase-' + SESSION_ID);

/* ---- 3. The owner alert reports the outcome ----------------------------------------- */
const ownerEmail = () => captured.find((c) => c.kind === 'email' && Array.isArray(c.body.to) && c.body.to[0] === 'dev@webnomad.org');
const metaLine = (e) => (e ? (e.body.text.split('\n').find((l) => l.startsWith('Reported to Meta:')) || '') : '');

reset();
await drive();
let mail = ownerEmail();
check('owner alert says the event was sent', metaLine(mail).includes('sent OK'));
check('a healthy send is NOT highlighted red', mail && !mail.body.html.includes('color:#a33'));

reset({ env: { META_CAPI_TOKEN: null } });
await drive();
mail = ownerEmail();
check('owner alert flags a missing token', metaLine(mail).includes('NOT SENT'));
check('a missing token IS highlighted red', mail && mail.body.html.includes('color:#a33'));

reset({ metaMode: 'reject' });
out = await drive();
mail = ownerEmail();
check('owner alert quotes a Meta rejection', metaLine(mail).includes('REJECTED by Meta (HTTP 400)'));
check('a rejection still returns 200 (no Stripe retry storm)', out.code === 200);

reset({ env: { META_CAPI_TEST_CODE: 'TEST12345' } });
await drive();
mail = ownerEmail();
// Leaving the test code set in production is silent and costs every real conversion.
check('owner alert warns that TEST mode does not count', metaLine(mail).includes('will NOT count'));

reset({ metaMode: 'throw' });
out = await drive();
mail = ownerEmail();
check('Meta unreachable still emails the sale', metaLine(mail).includes('FAILED to reach Meta'));
check('Meta unreachable still returns 200', out.code === 200);

/* ---- 4. Analytics must never outrank the money paths -------------------------------- */
reset({ env: { RESEND_API_KEY: null } });
await drive();
check('CAPI still fires when RESEND_API_KEY is missing', !!captured.find((c) => c.kind === 'meta'));

reset();
await drive({ amount_total: null });
check('no amount_total → no Meta call, handler survives', !captured.find((c) => c.kind === 'meta'));

reset();
out = await drive({}, 'whsec_WRONG_SECRET');
check('a forged signature is rejected before anything fires', out.code === 400 && !captured.length);

loud();

const failed = results.filter(([, ok]) => !ok);
for (const [label, ok] of results) if (!ok) console.error(`  FAIL  ${label}`);
if (failed.length) {
  console.error('\n--- handler output during the run ---\n' + noise.join('\n'));
  console.error(`\npurchase CAPI: ${failed.length} of ${results.length} checks FAILED`);
  process.exit(1);
}
console.log(`  purchase CAPI: ALL ${results.length} checks PASS`);
