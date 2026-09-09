/* "Email me this conversation" — POST sends the link, GET renders the conversation.

   The GET/POST split is the same shape as api/feedback-approve.mjs: GET renders and
   records nothing, POST acts. Here it also means the page can be returned as HTML straight
   from the function, which avoids the page registry entirely — Website/tools/search_build.py
   FAILS THE BUILD on any .html not listed in page_build.PAGES, BARE_PAGES or EXCLUDE, and a
   transcript viewer has no business in a sitemap.

   ⚠ THE MAIL CARRIES A LINK, NEVER THE TRANSCRIPT. See lib/chat-share.mjs for why: an
   endpoint that mails attacker-chosen text to an attacker-chosen address is a harassment
   mailer, and this one would have the site's own domain behind it.

   ⚠ ANSWERS IDENTICALLY WHATEVER HAPPENS. Sent, already sent, unknown conversation,
   screened-out address — all return the same { ok: true }. Anything else lets someone probe
   which conversations exist or which addresses are known.

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form crashes
   this project's runtime with FUNCTION_INVOCATION_FAILED.

   Env: RESEND_API_KEY, SIGNUP_TOKEN_SECRET, BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID) */

import { screenSignup, signingSecret, canonicaliseEmail, emailHash } from '../lib/signup-guard.mjs';
import { requestMeta } from '../lib/signup-quarantine.mjs';
import { readConfig } from '../lib/chat-config.mjs';
import { ipHash, claimShareSlot } from '../lib/chat-quota.mjs';
import { dayOfConversation } from '../lib/chat-log.mjs';
import {
  signShareToken, verifyShareToken, claimShare, readTranscript, shareEmail, LINK_TTL_DAYS,
} from '../lib/chat-share.mjs';

const SITE = 'https://airetirementincomeplanner.com';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readBody(req) {
  let body;
  try { body = req.body; } catch { body = null; }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  return body && typeof body === 'object' ? body : {};
}

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
  body{margin:0;background:#F7F2E8;color:#14304B;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:44rem;margin:0 auto;padding:2.5rem 1.2rem 4rem}
  h1{font-size:1.5rem;margin:0 0 .3rem}
  .sub{color:#51637A;font-size:.95rem;margin:0 0 2rem}
  .turn{margin:0 0 1.6rem}
  .q{background:#E7EFF7;padding:.7rem .9rem;border-radius:10px}
  .a{padding:.7rem .9rem;border:1px solid #E4DBC8;border-radius:10px;margin-top:.4rem;background:#fff}
  .lbl{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:#556879;margin-bottom:.25rem}
  footer{margin-top:2.5rem;padding-top:1.2rem;border-top:1px solid #E4DBC8;color:#556879;font-size:.9rem}
  a{color:#1B7165}
</style></head><body><main>${inner}</main></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Belt and braces alongside robots.txt: this page must never be indexed.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  /* ---- GET: render the conversation ------------------------------------------------ */
  if (req.method === 'GET') {
    const token = String((req.query && req.query.t) || '');
    const claim = verifyShareToken(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!claim) {
      /* One message for forged, expired and wrong-purpose alike. Saying which would tell
         someone probing whether they had the shape right. */
      return res.status(404).send(page('Link not available', `<h1>This link is not available</h1>
<p class="sub">It may have expired — these links last ${LINK_TTL_DAYS} days — or it may not be
complete. Conversations are deleted on a schedule, so an old one may simply be gone.</p>
<p><a href="${SITE}/">Go to the site</a></p>`));
    }
    const doc = await readTranscript(claim.id, claim.day);
    if (!doc) {
      return res.status(404).send(page('Conversation not found', `<h1>This conversation is no longer here</h1>
<p class="sub">Conversations are deleted after 90 days. This one has probably passed that point.</p>
<p><a href="${SITE}/">Go to the site</a></p>`));
    }
    const turns = (doc.turns || []).map((t) => `<div class="turn">
  <div class="lbl">You asked</div><div class="q">${esc(t.q)}</div>
  <div class="lbl" style="margin-top:.6rem">The assistant said</div><div class="a">${esc(t.a)}</div>
</div>`).join('');
    return res.status(200).send(page('Your conversation', `<h1>Your conversation</h1>
<p class="sub">${esc(doc.day)} &middot; ${(doc.turns || []).length} message(s) &middot; from the
assistant on the AI Retirement Income Planner website.</p>
${turns}
<footer>
  <p>This is educational information about the software. It is not financial, tax, investment, legal,
  insurance, Social Security, Medicare or estate advice. Tax rules, healthcare costs and thresholds
  change over time — verify important figures with official sources such as IRS.gov, SSA.gov,
  Medicare.gov and HealthCare.gov, and confirm decisions with a qualified professional before acting.</p>
  <p>You are not subscribed to anything. <a href="${SITE}/">airetirementincomeplanner.com</a></p>
</footer>`));
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* ---- POST: send the link --------------------------------------------------------- */
  // Same-origin only; nothing else has any business calling this.
  const h = req.headers || {};
  const site = String(h['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  /* ⚠ The one answer for every outcome. Sent, already sent, screened out, no such
     conversation — all identical, so nothing here can be used to probe. */
  const same = () => res.status(200).json({ ok: true });

  const body = readBody(req);
  const secret = signingSecret();
  const cfg = await readConfig().catch(() => null);
  if (!cfg || !cfg.enabled || !secret) return same();

  const id = String(body.cid || '');
  if (!/^[0-9]{10,}-[0-9a-f]{8}$/.test(id)) return same();
  /* ⚠ Derived, not taken from the request. The browser's idea of the day and the server's
     disagree across midnight UTC, and trusting the browser's would send the lookup to the
     wrong folder. Same derivation the transcript was filed under. */
  const day = dayOfConversation(id);

  const screen = await screenSignup({
    honeypot: body._honey,
    email: body.email,
    formToken: body.token,
    secret,
    /* Same asymmetry the contact form uses: a throwaway address here is a real person who
       would rather not hand over their main one to read back their own conversation. That
       is not the mailing list, and refusing it would cost more than it saves. */
    checkDisposable: false,
  });
  if (!screen.ok) return same();

  const canon = canonicaliseEmail(body.email);
  if (!canon) return same();

  /* A per-IP daily cap on top of the once-per-conversation claim, so the endpoint cannot be
     used to mail one address repeatedly by starting new conversations. See IP_DAILY_SHARES.

     ⚠ THIS LINE IS WHY THE WHOLE ENDPOINT WAS DEAD FOR A DAY. It used to call claimIpSlot(),
     which was deleted from lib/chat-quota.mjs when the per-message slot scheme was replaced
     by claimConversation() -- and nothing updated the import here. A missing named export is
     a LINK error in ESM, so the module never executed: every request returned
     FUNCTION_INVOCATION_FAILED, and the widget's "the conversation is on its way" was
     printed before the fetch, so it looked perfect from the browser. The guard suite read
     this file as text but never imported it; it does now. */
  const meta = requestMeta(req);
  if (!(await claimShareSlot(ipHash(meta.ip), id))) return same();

  /* ⚠ DO NOT GATE ON THE TRANSCRIPT BEING READABLE YET.

     The share link is offered the moment the first answer appears -- which is the same
     moment the transcript was written, and a blob takes appreciable time to become
     readable -- measured on this store at 0.5-1.4 seconds, which is small but is exactly
     the window a visitor clicking straight after their first answer lands in. Requiring the
     read to succeed therefore dropped genuine requests on the floor while telling the
     visitor it was on its way.

     Nothing is lost by sending anyway: the link is signed and expiring, the GET handler
     already renders a plain "no longer here" page if the conversation really is missing,
     and by the time anyone clicks a link in their inbox the write has long since landed.
     The read is kept only so a genuinely absent conversation is visible in the logs. */
  const doc = await readTranscript(id, day);
  if (!doc) console.warn('[chat-share] transcript not readable yet, sending the link anyway:', id);

  if (!(await claimShare(id, emailHash(canon.email, secret)))) return same();

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[chat-share] RESEND_API_KEY is not set');
    return same();
  }
  const link = `${SITE}/api/chat-share?t=${encodeURIComponent(signShareToken(id, day))}`;
  const mail = shareEmail(link);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'WebNomad Studio <dev@webnomad.org>',
        to: [canon.email],
        subject: 'Your conversation with the planner assistant',
        html: mail.html,
        text: mail.text,
      }),
    });
    if (!r.ok) console.error('[chat-share] resend rejected the send:', r.status);
  } catch (err) {
    console.error('[chat-share] send failed:', err?.message || err);
  }
  return same();
}
