/* Vercel serverless function — GET /api/newsletter-confirm?t=<token>
   Free-download signup, step 2 of 2 — and the ONLY code path that adds a subscriber.

   Someone clicked the link in the confirmation email. That click is the entire point of the
   design: it is proof a real person, at a real mailbox, wanted this. Everything that could
   be checked for free was checked before the email went out (lib/signup-guard.mjs); this is
   the check nothing else can substitute for.

   Reached directly from an email client, so it answers with a REDIRECT to a real page rather
   than JSON — nobody should ever see a raw API response here.

   Three things happen on a valid token, in this order:
     1. MailerLite upsert — the address joins the group and its automation sends the PDF
     2. Meta Conversions API "Lead" — fired HERE, not at signup (see below)
     3. dev@webnomad.org notification — so the inbox only sees confirmed humans

   ⚠ WHY THE LEAD EVENT LIVES HERE
   It used to fire when the form was submitted. That reports a conversion for someone who may
   never confirm, and worse, it trains Facebook's ad optimiser to go and find more of
   whatever produced the signup — including the junk. Firing on confirmation means the ad
   system optimises toward people who actually complete. The event id is carried through the
   token so the browser half (on confirmed.html) and this server half still collapse into one
   conversion instead of counting twice.

   Env: SIGNUP_TOKEN_SECRET, MAILERLITE_API_KEY, MAILERLITE_GROUP_ID[_*],
        RESEND_API_KEY, META_PIXEL_ID, META_CAPI_TOKEN, BLOB_READ_WRITE_TOKEN */

import crypto from 'node:crypto';
import { verifyConfirmToken, signingSecret, emailHash } from '../lib/signup-guard.mjs';
import { logEvent } from '../lib/signup-quarantine.mjs';
import { resolveMagnet, magnetLabel, magnetGroupId } from '../lib/magnets.mjs';

const SITE = 'https://airetirementincomeplanner.com';

function landing(status, extra = {}) {
  const p = new URLSearchParams({ status, ...extra });
  return `/confirmed.html?${p.toString()}`;
}

async function addToMailerLite(email, firstName, magnet) {
  const apiKey = process.env.MAILERLITE_API_KEY;
  const groupId = magnetGroupId(magnet);
  if (!apiKey || !groupId) {
    console.error('[confirm] MailerLite not configured — confirmed signup dropped:', magnet);
    return false;
  }
  const r = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      fields: firstName ? { name: firstName } : {},
      groups: [groupId],
      /* "active", not "unconfirmed". The confirmation has already happened — it happened
         here, on our own link. Handing MailerLite an unconfirmed record would make it send a
         SECOND confirmation email and put the address in its list before the person had done
         anything, which is the behaviour this whole design exists to avoid. */
      status: 'active',
    }),
  });
  // 201 = created, 200 = already existed (updated) — both are success.
  if (r.status !== 200 && r.status !== 201) {
    console.error('[confirm] MailerLite rejected', r.status, await r.text());
    return false;
  }
  return true;
}

/* Best-effort Meta Conversions API "Lead".

   Server-side because the browser pixel starts consent-revoked: a visitor who ignores the
   cookie banner sends Facebook nothing, including the conversion. Never fails the
   confirmation — analytics is not the product. */
async function sendCapiLead(opts) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) {
    console.log(`[capi] not configured — would have sent Lead (magnet=${opts.magnet}, event_id=${opts.eventId})`);
    return;
  }
  const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          {
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            event_id: opts.eventId,
            event_source_url: `${SITE}/confirmed.html`,
            action_source: 'website',
            user_data: {
              // Meta requires the email pre-hashed, lowercased and trimmed. The raw address
              // never leaves this function.
              //
              // fbp/fbc are Meta's own browser and ad-click identifiers, carried through the
              // confirm token rather than re-read from cookies — the click routinely happens
              // on a different device from the signup, where those cookies do not exist.
              // They are sent AS-IS; hashing them, unlike the email, would make them
              // unmatchable and waste the point of collecting them.
              em: [sha256(String(opts.email).trim().toLowerCase())],
              client_ip_address: opts.clientIp,
              client_user_agent: opts.userAgent,
              ...(opts.fbp ? { fbp: opts.fbp } : {}),
              ...(opts.fbc ? { fbc: opts.fbc } : {}),
            },
            custom_data: { content_name: opts.magnet },
          },
        ],
        access_token: token,
      }),
    });
    if (!r.ok) console.error('[capi] Lead rejected:', r.status, await r.text());
  } catch (err) {
    console.error('[capi] Lead failed (non-fatal):', err);
  }
}

// Best-effort internal notification. Now fires only for CONFIRMED signups, so the inbox
// stops carrying every piece of junk the form ever received.
async function notifyDev(firstName, email, magnetLabel) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'WebNomad Newsletter <noreply@webnomad.org>',
        to: ['dev@webnomad.org'],
        reply_to: email,
        subject: `Confirmed signup (${magnetLabel}): ${firstName || email}`,
        html: `<p><strong>Confirmed free-download signup</strong> — double opt-in completed.</p>
<p><strong>Requested:</strong> ${esc(magnetLabel)}</p>
<p><strong>Name:</strong> ${firstName ? esc(firstName) : '(not given)'}</p>
<p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>`,
        text: `Confirmed free-download signup (double opt-in completed)\nRequested: ${magnetLabel}\nName: ${firstName || '(not given)'}\nEmail: ${email}`,
      }),
    });
  } catch (err) {
    console.error('[confirm] dev notification failed (non-fatal):', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = signingSecret();
  if (!secret) {
    console.error('[confirm] FATAL: SIGNUP_TOKEN_SECRET is not set — cannot verify any link.');
    return res.redirect(302, landing('error'));
  }

  const token = (req.query && req.query.t) || '';
  const check = verifyConfirmToken(Array.isArray(token) ? token[0] : token, secret);

  if (!check.ok) {
    /* Two very different situations behind one screen. An EXPIRED link is a real person who
       took longer than a week — they get an obvious way to ask again. A FORGED one is
       someone poking at the endpoint and gets nothing useful back. */
    console.warn('[confirm] rejected link:', check.reason);
    return res.redirect(302, landing(check.reason === 'expired' ? 'expired' : 'invalid'));
  }

  const magnet = resolveMagnet(check.magnet);
  const label = magnetLabel(magnet);

  const added = await addToMailerLite(check.email, check.firstName, magnet);
  if (!added) {
    // The person did everything right; the failure is ours. Say so, and keep the log entry
    // so a broken MailerLite key cannot burn confirmations silently.
    await logEvent({
      event: 'blocked',
      reason: 'mailerlite-failed-after-confirm',
      email: check.email,
      magnet,
      hash: emailHash(check.email, secret),
    });
    return res.redirect(302, landing('error'));
  }

  await logEvent({
    event: 'confirmed',
    email: check.email,
    magnet,
    hash: emailHash(check.email, secret),
  });

  // Both best-effort — neither may block or fail a confirmation that has already succeeded.
  await sendCapiLead({
    email: check.email,
    magnet,
    eventId: check.eventId || crypto.randomUUID(),
    clientIp: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
    userAgent: req.headers['user-agent'],
    fbp: check.fbp || undefined,
    fbc: check.fbc || undefined,
  });
  await notifyDev(check.firstName, check.email, label);

  return res.redirect(302, landing('ok', { m: magnet, eid: check.eventId || '' }));
}
