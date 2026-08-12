/* Vercel serverless function — /api/newsletter
   Free-download signup, step 1 of 2.

   WHAT CHANGED, AND WHY IT MATTERS
   This endpoint used to write straight into MailerLite. It no longer touches MailerLite at
   all. It screens the address (see lib/signup-guard.mjs) and, if it survives, emails a
   signed confirmation link. The address is recorded on the mailing list only when someone
   clicks that link — see api/newsletter-confirm.mjs, which is now the ONLY path that writes
   a subscriber.

   The prompt for this was a run of signups like `a.rch.i.e.w.ane.2.9@gmail.com`. Gmail
   ignores dots, so that is one inbox wearing an unlimited number of faces. Canonicalisation
   collapses them; the confirmation step handles everything canonicalisation cannot see.

   NOTHING IS STORED BEFORE CONFIRMATION. The pending signup lives entirely inside the signed
   token in the emailed link — no pending table, no MailerLite "unconfirmed" record, nothing
   in the Blob store bar an anonymised counter. An address that is never confirmed leaves no
   trace anywhere, which is the strongest form of "keep spam out of the list".

     GET  → { t: <form token> }   issued when the visitor first touches the form
     POST → { ok: true, pending: true }

   Env:
     SIGNUP_TOKEN_SECRET   — REQUIRED. HMAC key for both tokens. No fallback, by design.
     RESEND_API_KEY        — sends the confirmation email (already used by the contact form)
     BLOB_READ_WRITE_TOKEN — quarantine log + the one-per-day confirmation cap
     MAILERLITE_*          — read by api/newsletter-confirm.mjs, not here
     META_PIXEL_ID / META_CAPI_TOKEN — read by api/newsletter-confirm.mjs, not here

   Setup + revert notes: ../NEWSLETTER-SETUP.md.
   Design rationale + rollout state: ../../Plans/Newsletter-Spam-Prevention.md */

import {
  screenSignup,
  signConfirmToken,
  issueFormToken,
  signingSecret,
  emailHash,
  BLOCK_MESSAGE,
} from '../lib/signup-guard.mjs';
import { logEvent, claimConfirmSend } from '../lib/signup-quarantine.mjs';
import { resolveMagnet, magnetLabel } from '../lib/magnets.mjs';

const SITE = 'https://airetirementincomeplanner.com';

function confirmEmailBody(firstName, magnetLabel, link) {
  const hi = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';
  return {
    html: `<div style="font-family:Inter,Arial,sans-serif;color:#1f2a33;line-height:1.6;max-width:560px">
<p>${hi}</p>
<p>One quick step and <strong>${escapeHtml(magnetLabel)}</strong> is yours — just confirm this is your email address:</p>
<p style="margin:1.6em 0">
  <a href="${link}" style="background:#1B7165;color:#fff;text-decoration:none;padding:.85em 1.7em;border-radius:8px;font-weight:600;display:inline-block">Confirm and send my download</a>
</p>
<p style="font-size:.9em;color:#555">If the button doesn't work, copy and paste this into your browser:<br>
<a href="${link}" style="color:#1B7165;word-break:break-all">${link}</a></p>
<hr style="border:none;border-top:1px solid #e2e2e2;margin:1.6em 0">
<p style="font-size:.9em;color:#555">Why the extra click? It keeps the list to people who actually asked to be on it — which means fewer emails sent to the wrong person, and none of the junk signups that make a newsletter worth ignoring.</p>
<p style="font-size:.9em;color:#555">Didn't sign up? Then someone typed your address by mistake. Ignore this and nothing happens — you are not on any list, and this link expires in 7 days.</p>
<p>— WebNomad Studio<br><a href="${SITE}" style="color:#1B7165">airetirementincomeplanner.com</a></p>
</div>`,
    text: `${firstName ? `Hi ${firstName},` : 'Hi,'}

One quick step and "${magnetLabel}" is yours — confirm this is your email address:

${link}

Why the extra click? It keeps the list to people who actually asked to be on it.

Didn't sign up? Someone typed your address by mistake. Ignore this and nothing happens — you are not on any list, and this link expires in 7 days.

— WebNomad Studio
${SITE}`,
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendConfirmEmail(to, firstName, magnetLabel, link) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[newsletter] RESEND_API_KEY is not set — cannot send confirmation');
    return false;
  }
  const body = confirmEmailBody(firstName, magnetLabel, link);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'WebNomad Studio <noreply@webnomad.org>',
        to: [to],
        subject: `Please confirm: ${magnetLabel}`,
        html: body.html,
        text: body.text,
      }),
    });
    if (!r.ok) {
      console.error('[newsletter] Resend rejected confirmation:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[newsletter] confirmation send failed:', err);
    return false;
  }
}

export default async function handler(req, res) {
  const secret = signingSecret();

  /* ⚠ HARD FAIL, NOT A FALLBACK.

     If the signing secret is missing there is no safe way to continue: writing to MailerLite
     directly would silently disable the double opt-in this whole endpoint exists to provide,
     and the site would look completely healthy while doing it. That is exactly how
     UPDATE_LOOKUP_PEPPER stayed unset in production for months. Breaking loudly is the
     feature. Set SIGNUP_TOKEN_SECRET in Vercel and REDEPLOY (env vars bind at deploy time —
     setting one does not reach functions that are already running). */
  if (!secret) {
    console.error(
      '[newsletter] FATAL: SIGNUP_TOKEN_SECRET is not set (or is under 16 chars). ' +
      'Signups are refused until it is set AND the project is redeployed.'
    );
    return res.status(503).json({
      error: 'Signups are temporarily unavailable. Please email dev@webnomad.org and we will send your download directly.',
    });
  }

  /* The form token. Handed out when the visitor first focuses the form, so a POST can show
     the form was rendered and that a human spent more than an instant on it. */
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ t: issueFormToken(secret) });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // req.body is a lazy getter that THROWS when the platform cannot parse the declared
  // content type, so read it defensively rather than letting it 500.
  let body;
  try { body = req.body; } catch { body = null; }
  const { name, email, _honey, magnet, eventId, fbp, fbc, formToken } = body || {};

  // Client-supplied, so bound the length rather than forwarding whatever arrives.
  const cookieVal = (v) => (typeof v === 'string' && v ? v.slice(0, 256) : undefined);

  const chosenMagnet = resolveMagnet(magnet);
  const label = magnetLabel(chosenMagnet);

  const screened = await screenSignup({
    honeypot: _honey,
    email,
    name,
    formToken,
    secret,
  });

  if (!screened.ok) {
    /* Logged, then answered with one generic message. The log is the only place the reason
       is visible — see lib/signup-quarantine.mjs for why a filter nobody can audit is worse
       than no filter. */
    await logEvent({
      event: 'blocked',
      reason: screened.reason,
      email: typeof email === 'string' ? email : '',
      domain: screened.domain || '',
      magnet: chosenMagnet,
      hash: '',
    });
    console.warn(`[newsletter] blocked (${screened.reason})`);
    return res.status(400).json({ error: BLOCK_MESSAGE });
  }

  const hash = emailHash(screened.email, secret);

  /* One confirmation per address per magnet per day. Canonicalisation means a hundred dotted
     variants now resolve to one real inbox — without this cap, a script could use us to
     deliver a hundred emails to that inbox. Atomic at the storage layer; see the module. */
  const maySend = await claimConfirmSend(screened.email, chosenMagnet, hash);
  if (!maySend) {
    await logEvent({
      event: 'blocked',
      reason: 'confirmation-already-sent-today',
      email: screened.email,
      domain: screened.domain,
      magnet: chosenMagnet,
      hash,
    });
    /* Answered as success on purpose. It IS successful from the visitor's side — a
       confirmation is already sitting in that inbox — and an error here would both confuse a
       real person who double-clicked and confirm to a prober that the address is known. */
    return res.status(200).json({ ok: true, pending: true, magnet: chosenMagnet });
  }

  const token = signConfirmToken(
    {
      email: screened.email,
      firstName: screened.firstName,
      magnet: chosenMagnet,
      eventId: typeof eventId === 'string' ? eventId.slice(0, 64) : '',
      fbp: cookieVal(fbp),
      fbc: cookieVal(fbc),
    },
    secret
  );

  const link = `${SITE}/api/newsletter-confirm?t=${encodeURIComponent(token)}`;
  const sent = await sendConfirmEmail(screened.email, screened.firstName, label, link);

  if (!sent) {
    return res.status(502).json({
      error: 'Could not send your confirmation email. Please try again, or email dev@webnomad.org directly.',
    });
  }

  await logEvent({
    event: 'pending',
    email: screened.email,
    domain: screened.domain,
    magnet: chosenMagnet,
    hash,
    tokenState: screened.tokenState,
  });

  /* No dev notification and no Meta Lead event here — both belong to confirmation.

     The Lead event especially: firing it on submission would teach Facebook's optimiser to
     go and find more of whatever produced the signup, junk included, and would report a
     conversion for someone who may never confirm. api/newsletter-confirm.mjs fires it with
     the same event id, so browser and server halves still pair up. */
  return res.status(200).json({ ok: true, pending: true, magnet: chosenMagnet });
}
