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

/* ⚠ DELIBERATELY PLAIN. DO NOT "IMPROVE" THIS WITH A BUTTON, BRANDING OR COLOUR.

   The first version was styled like marketing — a teal CTA button, seven inline colour rules,
   three links, a paragraph explaining the benefit, and "download"/"yours" in the copy — and
   Gmail filed it under Promotions. That is not the spam folder, but for a link that expires
   in seven days it may as well be: nobody checks Promotions promptly, and 0 of 8 real
   signups confirmed while it looked like this.

   A confirmation is transactional mail. It should read like a receipt, not an offer:
     • subject names the ACTION, not the product ("Confirm your email address"). A product
       name in the subject is the single strongest promotional tell.
     • one link, as a plain link — a styled block-level button is marketing markup
     • no colours, no rules, no logo, no font stack
     • no persuasion. The "why the extra click" pitch belonged on the website, not here.
   The text part carries the whole message; the HTML is a near-copy so no client sees less. */
function confirmEmailBody(firstName, magnetLabel, link) {
  const hi = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';
  return {
    html: `<p>${hi}</p>
<p>Please confirm this is your email address so we can send you ${escapeHtml(magnetLabel)}:</p>
<p><a href="${link}">${link}</a></p>
<p>The link works for 7 days.</p>
<p>If you did not request this, ignore this message — you have not been added to anything.</p>
<p>Paul Hankin<br>WebNomad Studio</p>`,
    text: `${firstName ? `Hi ${firstName},` : 'Hi,'}

Please confirm this is your email address so we can send you ${magnetLabel}:

${link}

The link works for 7 days.

If you did not request this, ignore this message - you have not been added to anything.

Paul Hankin
WebNomad Studio`,
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
        from: 'WebNomad Studio <dev@webnomad.org>',
        to: [to],
        // ⚠ Names the action, not the product. "Please confirm: <product name>" reads as a
        // promotion to Gmail and was part of what filed the old version under Promotions.
        subject: 'Confirm your email address',
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
