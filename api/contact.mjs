/* Vercel serverless function — /api/contact
   Sends a notification to dev@webnomad.org and a courtesy auto-reply to the submitter.

   WHAT THIS GUARDS AGAINST, AND WHY IT IS NOT THE SAME AS THE NEWSLETTER
   This form emails an address supplied by whoever posted it, and the auto-reply quotes their
   own text back. Unthrottled, that is a way to send attacker-chosen content to a victim,
   repeatedly — the same subscription-bombing shape as the signup form, which is the real
   reason this was hardened. Inbox spam for the owner is the lesser problem.

   The screen is deliberately LIGHTER than the signup one (lib/signup-guard.mjs):
     • form token      — yes. Most contact spam is a blind POST at the endpoint.
     • MX / A record   — yes. A fake domain means the auto-reply hard-bounces, and bounces
                         cost sending reputation, which lands real mail in spam folders.
     • non-human local — yes. `noreply@` cannot be a person asking a question.
     • one auto-reply per address per day — yes, and this is the anti-bombing cap.
     • disposable domains — ⚠ NO, ON PURPOSE. A throwaway address on the mailing list is
                         worthless by definition; on a contact form it may be a
                         privacy-conscious person with a genuine pre-sales question. Losing
                         an enquiry costs more than reading one spam message.
     • canonicalisation, double opt-in — NO. There is no list to dedupe, and the whole point
                         is to receive the message, not to make someone prove they want it.

   ⚠ A MISSING SIGNUP_TOKEN_SECRET DOES NOT BREAK THIS FORM — the opposite of
   api/newsletter.mjs, and the difference is deliberate. There, the secret IS the feature:
   without it the double opt-in silently does nothing, so it must fail loudly. Here it powers
   one layer of four, and the form still screens without it. Taking the support channel
   offline over a defence-in-depth layer would be a worse failure than the spam.

   Env: RESEND_API_KEY (required), SIGNUP_TOKEN_SECRET (optional — enables the form token),
        BLOB_READ_WRITE_TOKEN (optional — enables the auto-reply cap and the log) */

import {
  screenSignup,
  signingSecret,
  issueFormToken,
  emailHash,
  BLOCK_MESSAGE,
} from '../lib/signup-guard.mjs';
import { logEvent, claimDailySend } from '../lib/signup-quarantine.mjs';

const MAX_MESSAGE = 5000;
const MAX_SUBJECT = 200;
const MAX_NAME = 100;

export default async function handler(req, res) {
  const secret = signingSecret();

  // Form token, same shape as the signup form. Fetched by assets/js/main.js when someone
  // first touches the form; proves the POST came from a rendered page, not a script.
  if (req.method === 'GET') {
    if (!secret) return res.status(200).json({ t: '' });
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
  const { name, email, subject, message, _honey, formToken } = body || {};

  const cleanName = String(name ?? '').trim().slice(0, MAX_NAME);
  const cleanSubject = String(subject ?? '').trim().slice(0, MAX_SUBJECT);
  const cleanMessage = String(message ?? '').trim();

  if (!cleanName || !email || !cleanMessage) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  if (cleanMessage.length > MAX_MESSAGE) {
    return res.status(400).json({ error: 'Message is too long (max 5,000 characters).' });
  }

  const screened = await screenSignup({
    honeypot: _honey,
    email,
    name: cleanName,
    formToken,
    secret,
    // No form token can be checked without a secret; skip rather than reject (see header).
    checkToken: Boolean(secret),
    checkDisposable: false,
  });

  if (!screened.ok) {
    await logEvent({
      event: 'blocked',
      reason: screened.reason,
      email: typeof email === 'string' ? email : '',
      domain: screened.domain || '',
      note: 'contact-form',
    });
    console.warn(`[contact] blocked (${screened.reason})`);
    return res.status(400).json({ error: BLOCK_MESSAGE });
  }

  /* Use the address as TYPED for correspondence, not the canonical form.

     screenSignup returns a canonicalised address because that is what dedupes a mailing
     list. Replying to a person is the opposite problem: they wrote it that way, they expect
     the reply there, and `first.last@` vs `firstlast@` at Gmail reaches the same inbox
     anyway. The canonical form is used ONLY as the throttle key below, where collapsing the
     variants is exactly the point — otherwise adding a dot would reset the daily cap. */
  const replyTo = String(email).trim();

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[contact] RESEND_API_KEY is not set');
    return res.status(500).json({ error: 'Email service not configured.' });
  }

  const subjectLine = cleanSubject
    ? `Contact: ${cleanSubject} — from ${cleanName}`
    : `Contact form message from ${cleanName}`;

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

  async function sendEmail(payload) {
    return fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  try {
    // 1. Notification to WebNomad. NEVER throttled — every genuine message must arrive.
    const notifyRes = await sendEmail({
      from: 'WebNomad Contact Form <noreply@webnomad.org>',
      to: ['dev@webnomad.org'],
      reply_to: replyTo,
      subject: subjectLine,
      html: `<p><strong>Name:</strong> ${esc(cleanName)}</p>
<p><strong>Email:</strong> <a href="mailto:${esc(replyTo)}">${esc(replyTo)}</a></p>
<p><strong>Subject:</strong> ${cleanSubject ? esc(cleanSubject) : '(none)'}</p>
<hr style="border:none;border-top:1px solid #ddd;margin:1rem 0">
<p style="white-space:pre-wrap">${esc(cleanMessage)}</p>`,
      text: `Name: ${cleanName}\nEmail: ${replyTo}\nSubject: ${cleanSubject || '(none)'}\n\n${cleanMessage}`,
    });

    if (!notifyRes.ok) {
      const errText = await notifyRes.text();
      console.error('[contact] Resend notification error:', notifyRes.status, errText);
      return res.status(502).json({
        error: 'Could not send your message. Please try again or email dev@webnomad.org directly.',
      });
    }

    /* 2. Courtesy auto-reply to the sender — capped at one per address per day.

       This is the half that can be aimed at someone: it goes to an address the sender chose
       and quotes text the sender wrote. Keyed on the CANONICAL address so that adding a dot
       to a Gmail address cannot reset the counter.

       Skipping it is invisible to a genuine repeat correspondent (they already have today's
       acknowledgement) and never affects the message reaching the owner. Best-effort
       throughout — a failure here must not fail a message that has already been delivered. */
    const hash = emailHash(screened.email, secret);
    const mayReply = await claimDailySend('contact', hash);

    if (mayReply) {
      try {
        await sendEmail({
          from: 'WebNomad Studio <noreply@webnomad.org>',
          to: [replyTo],
          subject: 'We received your message — WebNomad Studio',
          html: `<p>Hi ${esc(cleanName)},</p>
<p>Thanks for reaching out — we've received your message and will reply as soon as we can (usually within one business day).</p>
<blockquote style="border-left:3px solid #1B7165;margin:1em 0;padding:.5em 1em;color:#555;white-space:pre-wrap">${esc(cleanMessage)}</blockquote>
<p>— WebNomad Studio<br><a href="https://airetirementincomeplanner.com">airetirementincomeplanner.com</a></p>`,
          text: `Hi ${cleanName},\n\nThanks for reaching out — we've received your message and will reply as soon as we can (usually within one business day).\n\n"${cleanMessage}"\n\n— WebNomad Studio\nhttps://airetirementincomeplanner.com`,
        });
      } catch (confErr) {
        console.error('[contact] auto-reply failed (non-fatal):', confErr);
      }
    } else {
      console.log('[contact] auto-reply suppressed — already sent to this address today');
      await logEvent({
        event: 'blocked',
        reason: 'contact-autoreply-capped',
        email: screened.email,
        domain: screened.domain,
        hash,
        note: 'contact-form — message still delivered to dev@',
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contact] handler error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
