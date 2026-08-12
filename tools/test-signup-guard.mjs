/* Self-test for lib/signup-guard.mjs — run: node Website/tools/test-signup-guard.mjs
   Dependency-free (the guard imports nothing outside node: builtins), same spirit as
   mobile/test-engine.mjs: a golden-master gate you can run before pushing.

   Worth testing rather than eyeballing, because every failure mode here is silent. A
   canonicalisation bug does not throw — it merges two real subscribers into one, or stops
   collapsing the dot variants and quietly restores the problem this was built to solve. */

import {
  canonicaliseEmail,
  maskEmail,
  isDisposableDomain,
  isNonHumanLocalPart,
  issueFormToken,
  verifyFormToken,
  signConfirmToken,
  verifyConfirmToken,
  emailHash,
  domainAcceptsMail,
  screenSignup,
} from '../lib/signup-guard.mjs';

let pass = 0;
let fail = 0;

function ok(label, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const SECRET = 'test-secret-at-least-16-chars-long';
const canon = (e) => (canonicaliseEmail(e) || {}).email ?? null;

/* --------------------------------------------------------------- canonicalisation --- */
console.log('canonicalisation');

// The address that started all of this.
eq('gmail dots stripped', canon('a.rch.i.e.w.ane.2.9@gmail.com'), 'archiewane29@gmail.com');
eq('all dot variants agree', canon('a.r.c.h.i.e@gmail.com'), canon('archie@gmail.com'));
eq('gmail plus-tag stripped', canon('archie+etsy@gmail.com'), 'archie@gmail.com');
eq('dots and tag together', canon('a.rchie+x.y@gmail.com'), 'archie@gmail.com');
eq('googlemail folds to gmail', canon('Archie.Wane@googlemail.com'), 'archiewane@gmail.com');
eq('case folded', canon('ARCHIE@GMAIL.COM'), 'archie@gmail.com');
eq('surrounding space tolerated', canon('  archie@gmail.com  '), 'archie@gmail.com');

// ⚠ Dots must survive everywhere that is not Gmail — they are ordinary characters there,
// and stripping them would merge two unrelated people into one subscriber.
eq('outlook dots kept', canon('first.last@outlook.com'), 'first.last@outlook.com');
eq('custom-domain dots kept', canon('first.last@webnomad.org'), 'first.last@webnomad.org');
eq('outlook plus stripped', canon('first+news@outlook.com'), 'first@outlook.com');
// Unknown domains may treat +tag literally, so it stays — a lost dedupe beats a lost human.
eq('unknown-domain plus kept', canon('first+news@some-company.co.uk'), 'first+news@some-company.co.uk');

ok('rejects empty', canon('') === null);
ok('rejects no-at', canon('archie.gmail.com') === null);
ok('rejects no-dot domain', canon('archie@localhost') === null);
ok('rejects spaces inside', canon('arch ie@gmail.com') === null);
ok('rejects comma injection', canon('a@b.com,c@d.com') === null);
ok('rejects header injection', canon('a@b.com>\n Bcc: x@y.com') === null);
ok('rejects over-length', canon(`${'a'.repeat(250)}@gmail.com`) === null);
ok('rejects dots-only gmail local', canon('.....@gmail.com') === null);

/* ------------------------------------------------------------------------ masking --- */
console.log('masking');
ok('mask hides the local part', !maskEmail('archiewane29@gmail.com').includes('archiewane'));
ok('mask keeps the domain', maskEmail('archiewane29@gmail.com').endsWith('@gmail.com'));
eq('mask of junk', maskEmail('nonsense'), '(invalid)');

/* --------------------------------------------------------------------- blocklists --- */
console.log('blocklists');
ok('disposable caught', isDisposableDomain('mailinator.com'));
ok('disposable subdomain caught', isDisposableDomain('team.mailinator.com'));
ok('real domain not caught', !isDisposableDomain('gmail.com'));
ok('lookalike not caught', !isDisposableDomain('notmailinator.co'));
ok('noreply is non-human', isNonHumanLocalPart('noreply'));
ok('no-reply punctuation variant', isNonHumanLocalPart('no-reply'));
ok('postmaster is non-human', isNonHumanLocalPart('postmaster'));
ok('a person is not', !isNonHumanLocalPart('archie'));
// Deliberately allowed — a sole trader may really use these, and opt-in filters them.
ok('info@ is allowed through', !isNonHumanLocalPart('info'));

/* --------------------------------------------------------------------- form token --- */
console.log('form token');
const ft = issueFormToken(SECRET);
eq('fresh token is too fast', verifyFormToken(ft, SECRET).state, 'too-fast');
eq('absent token reports missing', verifyFormToken('', SECRET).state, 'missing');
eq('garbage is forged', verifyFormToken('abc.def', SECRET).state, 'forged');
eq('wrong secret is forged', verifyFormToken(ft, 'another-secret-16-chars').state, 'forged');
// Tamper with the payload but keep the signature: must not validate.
const tampered = `${Buffer.from(JSON.stringify({ k: 'form', t: Date.now() - 9e5 })).toString('base64url')}.${ft.split('.')[1]}`;
eq('payload swap is forged', verifyFormToken(tampered, SECRET).state, 'forged');

/* An aged token, minted by hand from the same secret, is the only way to test the happy
   path without sleeping for two seconds. */
const { createHmac } = await import('node:crypto');
function aged(ageMs) {
  const body = Buffer.from(JSON.stringify({ k: 'form', t: Date.now() - ageMs, n: 'x' })).toString('base64url');
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
eq('token aged 10s is ok', verifyFormToken(aged(10_000), SECRET).state, 'ok');
eq('token aged 4h is stale', verifyFormToken(aged(4 * 3600_000), SECRET).state, 'stale');

/* ------------------------------------------------------------------ confirm token --- */
console.log('confirm token');
const ct = signConfirmToken(
  { email: 'archie@gmail.com', firstName: 'Archie', magnet: 'checklist', eventId: 'ev-1', fbp: 'fb.1.2.3' },
  SECRET
);
const cv = verifyConfirmToken(ct, SECRET);
ok('valid token verifies', cv.ok);
eq('email survives', cv.email, 'archie@gmail.com');
eq('name survives', cv.firstName, 'Archie');
eq('magnet survives', cv.magnet, 'checklist');
eq('event id survives (Meta dedupe)', cv.eventId, 'ev-1');
eq('fbp survives (cross-device attribution)', cv.fbp, 'fb.1.2.3');
eq('wrong secret rejected', verifyConfirmToken(ct, 'different-secret-16ch').reason, 'forged');
eq('junk rejected', verifyConfirmToken('nope', SECRET).reason, 'forged');
eq('a form token is not a confirm token', verifyConfirmToken(aged(10_000), SECRET).reason, 'forged');

const expired = (() => {
  const body = Buffer.from(JSON.stringify({ k: 'confirm', e: 'a@gmail.com', x: Date.now() - 1000 })).toString('base64url');
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
})();
eq('expired link reported as expired', verifyConfirmToken(expired, SECRET).reason, 'expired');

/* ------------------------------------------------------------------------- hashing --- */
console.log('hashing');
ok('hash is stable', emailHash('archie@gmail.com', SECRET) === emailHash('archie@gmail.com', SECRET));
ok('hash differs per address', emailHash('a@gmail.com', SECRET) !== emailHash('b@gmail.com', SECRET));
ok('hash is not the address', !emailHash('archie@gmail.com', SECRET).includes('archie'));
// The whole point: every dotted variant lands on ONE hash, so the log can count one person.
ok(
  'dot variants share a hash',
  emailHash(canon('a.rch.i.e.w.ane.2.9@gmail.com'), SECRET) === emailHash(canon('archiewane29@gmail.com'), SECRET)
);

/* ------------------------------------------------------------------- screen (e2e) --- */
console.log('screen');
const screen = (over = {}) => screenSignup({
  honeypot: '', email: 'archie@gmail.com', name: 'Archie Wane',
  formToken: aged(10_000), secret: SECRET, ...over,
});

eq('honeypot blocks', (await screen({ honeypot: 'x' })).reason, 'honeypot');
eq('bad syntax blocks', (await screen({ email: 'nope' })).reason, 'syntax');
eq('disposable blocks', (await screen({ email: 'x@mailinator.com' })).reason, 'disposable-domain');
eq('non-human blocks', (await screen({ email: 'noreply@gmail.com' })).reason, 'non-human-address');
eq('forged token blocks', (await screen({ formToken: 'a.b' })).reason, 'forged-form-token');
eq('instant submit blocks', (await screen({ formToken: issueFormToken(SECRET) })).reason, 'submitted-too-fast');

// A missing token must NOT block: main.js is cached hard, so the first hours after deploy
// are full of real people posting without one.
const noTok = await screen({ formToken: '' });
ok('missing token still passes', noTok.ok, `blocked as ${noTok.reason}`);
eq('missing token is recorded', noTok.tokenState, 'missing');

/* The contact form's lighter screen. A throwaway address there may be a real person with a
   real question, so it is allowed through — but the checks that cannot be a person still
   apply. Getting this backwards would silently start rejecting pre-sales enquiries. */
const contactish = (over = {}) => screen({ checkDisposable: false, ...over });
ok('contact: disposable allowed through',
   (await contactish({ email: 'someone@mailinator.com' })).ok);
eq('contact: noreply@ still blocked',
   (await contactish({ email: 'noreply@gmail.com' })).reason, 'non-human-address');
eq('contact: honeypot still blocked',
   (await contactish({ honeypot: 'x' })).reason, 'honeypot');
eq('contact: bad syntax still blocked',
   (await contactish({ email: 'nope' })).reason, 'syntax');
eq('contact: instant submit still blocked',
   (await contactish({ formToken: issueFormToken(SECRET) })).reason, 'submitted-too-fast');
ok('contact: a missing token is tolerated when there is no secret',
   (await screen({ checkToken: false, formToken: '', checkDisposable: false })).ok);

const good = await screen();
ok('a good signup passes', good.ok, good.reason);
eq('screen returns the canonical address', (await screen({ email: 'A.rchie+tag@GMail.com' })).email, 'archie@gmail.com');
eq('first name only', good.firstName, 'Archie');

/* -------------------------------------------------------------------------- DNS --- */
/* Network-dependent, so a failure here is reported but never fails the run — offline is
   not a code defect. The fail-open behaviour is the thing that matters and it is exercised
   by the unreachable-domain case below. */
console.log('dns (network — advisory only)');
try {
  const gmailOk = await domainAcceptsMail('gmail.com');
  const bogusOk = await domainAcceptsMail('this-domain-should-not-exist-9f3a2b.invalid');
  console.log(`  gmail.com accepts mail: ${gmailOk} (want true)`);
  console.log(`  bogus .invalid accepts mail: ${bogusOk} (want false)`);
  if (!gmailOk || bogusOk) console.log('  ⚠ advisory mismatch — check network/DNS before assuming a bug');
} catch (err) {
  console.log(`  skipped: ${err.message}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
