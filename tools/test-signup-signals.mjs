/* Self-test for the bot-signal half of lib/signup-quarantine.mjs —
   run: node Website/tools/test-signup-signals.mjs

   Covers the two pure pieces: reading a pathname (parseKey) and judging a set of them
   (verdictFor). Neither touches the blob store, so this runs offline and instantly.

   Worth gating for the usual reason — every failure here is silent and points the WRONG WAY.
   A parseKey that mis-reads the layout does not throw; it returns an empty key id, and every
   subscriber then reads "unknown" for ever while looking like a working feature. A verdict
   that is too eager is worse: it puts an "automated" flag on a real person, and the owner
   stops emailing someone who did nothing wrong. */

import { parseKey, verdictFor, countHoneypotHits } from '../lib/signup-quarantine.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label, got, want) => ok(label, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------ parseKey --- */
console.log('parseKey — both layouts, because old records never go away before the purge does');

const OLD = 'signup-log/2026-08-12/blocked__disposable-domain__1786548503617-dlk9vu6u.json';
const NEW = 'signup-log/2026-08-21/pending__none__bce02e43b6237349__1787000000000-ab12cd34.json';

const o = parseKey(OLD);
eq('old: day',    o.day, '2026-08-12');
eq('old: event',  o.event, 'blocked');
eq('old: reason', o.reason, 'disposable-domain');
eq('old: no key id (it was never written)', o.kid, '');
eq('old: epoch still readable', o.epoch, 1786548503617);

const n = parseKey(NEW);
eq('new: day',    n.day, '2026-08-21');
eq('new: event',  n.event, 'pending');
eq('new: reason', n.reason, 'none');
eq('new: key id', n.kid, 'bce02e43b6237349');
eq('new: epoch',  n.epoch, 1787000000000);

// A 16-hex-looking reason must not be mistaken for a key id, and vice versa.
eq('a short tail is not a key id', parseKey('signup-log/2026-08-21/blocked__honeypot__123-abc.json').kid, '');

/* ⚠ logEvent writes the literal 'nokid' when an address cannot be canonicalised. That is a
   fourth field which is NOT a key id, and reading the timestamp by position rather than from
   the end silently returned epoch 0 for every one of them. */
const NOKID = 'signup-log/2026-08-21/blocked__syntax__nokid__1787000000000-ab12cd34.json';
eq('nokid: not treated as a key id', parseKey(NOKID).kid, '');
eq('nokid: the timestamp survives anyway', parseKey(NOKID).epoch, 1787000000000);
eq('nokid: reason still read', parseKey(NOKID).reason, 'syntax');

/* ⚠ list() returns blob OBJECTS, and passing one straight to parseKey (via `.map(parseKey)`)
   silently produced "[object Object]" — empty fields, no throw, and a UI that said "no
   record". It must handle both shapes. */
const asObject = parseKey({ pathname: NEW, url: 'https://example.invalid/x', size: 123 });
eq('a blob object works as well as a pathname', asObject.kid, 'bce02e43b6237349');
eq('  … and still reads the day', asObject.day, '2026-08-21');

/* ----------------------------------------------------------------- verdictFor --- */
console.log('verdictFor — the judgement, which must lean towards saying nothing');

const at = (secs, reason = 'none', event = 'pending') =>
  ({ day: '2026-08-20', event, reason, kid: 'k', epoch: Date.UTC(2026, 7, 20, 17, 0, 0) + secs * 1000 });

eq('nothing recorded is UNKNOWN, never clean', verdictFor([]).verdict, 'unknown');
eq('one ordinary signup is clean', verdictFor([at(0)]).verdict, 'clean');

// The real case, 20 Aug 2026: jbetts@receptional.com.
const jbetts = [
  at(0,  'honeypot', 'blocked'), at(4, 'honeypot', 'blocked'), at(9, 'honeypot', 'blocked'),
  at(14, 'none', 'pending'),
  at(20, 'honeypot', 'blocked'), at(24, 'honeypot', 'blocked'), at(29, 'honeypot', 'blocked'),
  at(58, 'none', 'confirmed'),
];
const j = verdictFor(jbetts);
eq('the real bot case reads as automated', j.verdict, 'automated');
eq('  … and counts the honeypot hits', j.automated, 6);
eq('  … and sees the burst', j.burst, 8);
ok('  … and names the reason', j.reasons.includes('honeypot'));

eq('beating the timer is automated', verdictFor([at(0, 'submitted-too-fast', 'blocked')]).verdict, 'automated');
eq('a forged token is automated', verdictFor([at(0, 'token-forged', 'blocked')]).verdict, 'automated');

// Three inside a minute with no honeypot: suspicious, not conclusive.
eq('a burst alone is only ODD', verdictFor([at(0), at(10), at(20)]).verdict, 'odd');

/* ⚠ The case that matters most: a keen human must NOT be flagged. Eight submissions spread
   over weeks is someone who wanted several downloads, and stopping their emails on that
   basis would be a silent, unrecoverable mistake. */
const spread = [0, 86400, 172800, 259200, 345600, 432000, 518400, 604800].map((s) => at(s));
eq('eight submissions over eight days is not a burst', verdictFor(spread).burst, 1);
ok('  … though the sheer number still reads as odd', verdictFor(spread).verdict === 'odd');
eq('five spread-out submissions stay clean', verdictFor(spread.slice(0, 5)).verdict, 'clean');

// A re-clicked confirmation link is a mail scanner, not a bot signup — counted, never damning.
const repeat = [at(0), at(60, 'repeat-click', 'confirmed')];
eq('a repeat click is counted', verdictFor(repeat).repeatClicks, 1);
eq('  … but does not condemn anyone', verdictFor(repeat).verdict, 'clean');

// Order independence: the caller has no obligation to sort.
eq('records arrive in any order', verdictFor([at(29, 'honeypot', 'blocked'), at(0)]).firstAt,
   new Date(Date.UTC(2026, 7, 20, 17, 0, 0)).toISOString());

/* --------------------------------------------------- countHoneypotHits (block) --- */
/* The rule that REFUSES a signup, so these assertions are load-bearing in a way the verdict
   ones are not: verdictFor only ever colours a row in a panel, this decides whether a real
   person reaches the mailing list. Threshold is 2 hits inside 30 days - see priorHoneypot. */
console.log('countHoneypotHits - the one signal that actually blocks');

const CUT = '2026-08-01';
const on = (day, reason = 'honeypot') =>
  ({ day, event: 'blocked', reason, kid: 'k', epoch: Date.parse(`${day}T17:00:00Z`) });

eq('no records is no hits', countHoneypotHits([], CUT).hits, 0);
eq('a clean signup is not a hit', countHoneypotHits([on('2026-08-20', 'none')], CUT).hits, 0);

// A SINGLE hit must not block - that is the password-manager case, and it is why the
// threshold is two. If this ever flips to 1, a hidden-field autofill starts costing real
// subscribers, silently.
eq('one honeypot hit is counted', countHoneypotHits([on('2026-08-20')], CUT).hits, 1);
ok('  ... but one is below the block threshold', countHoneypotHits([on('2026-08-20')], CUT).hits < 2);

// The real signature: jbetts@receptional.com, 6 honeypot hits, then a clean submission.
const botRun = ['2026-08-20', '2026-08-20', '2026-08-20', '2026-08-20', '2026-08-20', '2026-08-20']
  .map((d) => on(d))
  .concat([on('2026-08-20', 'none')]);
ok('the known bot signature blocks', countHoneypotHits(botRun, CUT).hits >= 2);

// Only the honeypot counts here. Other block reasons are separate rules with their own
// costs; folding them in would quietly widen this from one rule into four.
eq('other block reasons do not count', countHoneypotHits(
  [on('2026-08-20', 'disposable-domain'), on('2026-08-20', 'syntax'), on('2026-08-20', 'submitted-too-fast')], CUT).hits, 0);

// The window is what lets a wrongly-blocked person recover on their own. If the cutoff
// stops being applied, a single bad day follows an address for the full 90-day retention.
eq('hits outside the window are ignored', countHoneypotHits(
  [on('2026-07-01'), on('2026-07-02')], CUT).hits, 0);
eq('the window is inclusive of its first day', countHoneypotHits([on(CUT)], CUT).hits, 1);
eq('a mixed history counts only what is in range', countHoneypotHits(
  [on('2026-07-01'), on('2026-08-20'), on('2026-08-21')], CUT).hits, 2);

// lastAt is the newest hit, whatever order they arrive in.
eq('lastAt is the most recent hit', countHoneypotHits(
  [on('2026-08-21'), on('2026-08-05')], CUT).lastAt, Date.parse('2026-08-21T17:00:00Z'));
eq('lastAt is null when nothing matched', countHoneypotHits([on('2026-08-20', 'none')], CUT).lastAt, null);

// Callers pass whatever the log holds; a malformed record must not throw mid-signup.
eq('undefined records are survivable', countHoneypotHits(undefined, CUT).hits, 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
