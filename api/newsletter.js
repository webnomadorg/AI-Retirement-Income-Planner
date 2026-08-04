/* Vercel serverless function — POST /api/newsletter
   Free-download signup. Adds the subscriber to a MailerLite group (the mailing list);
   MailerLite's automation for that group sends the matching download link.
   Requires MAILERLITE_API_KEY and MAILERLITE_GROUP_ID environment variables in Vercel.

   Several lead magnets share this one endpoint. The posted `magnet` field picks the
   MailerLite group, and therefore which automation (and which PDF) the subscriber gets.
   Any magnet whose group ID is unset falls back to the default group, so a half-finished
   MailerLite setup degrades to "they get the eBook" rather than to an error.

   A best-effort "new signup" notification is also sent to dev@webnomad.org via Resend
   (RESEND_API_KEY — already used by the contact form); a failure there never fails signup.
   A best-effort Meta Conversions API "Lead" event is sent too — see sendCapiLead below.

   Setup + revert notes: see ../NEWSLETTER-SETUP.md.
   The previous Resend-based version (which sent the eBook itself) is git commit 5214145
   and is archived verbatim in that doc. */

const crypto = require('crypto');

/* The lead magnets this endpoint can deliver. `env` names the Vercel variable holding that
   magnet's MailerLite group ID; `label` is only for the dev notification email.
   Keep the keys in sync with the data-magnet attributes in assets/js/main.js consumers
   (the /get/* landing pages, newsletter.html, and the blog capture card). */
const MAGNETS = {
  ebook: {
    env: 'MAILERLITE_GROUP_ID',
    label: 'eBook — Build a Retirement Plan You Can Question',
  },
  checklist: {
    env: 'MAILERLITE_GROUP_ID_CHECKLIST',
    label: 'Retirement input checklist',
  },
  questions: {
    env: 'MAILERLITE_GROUP_ID_QUESTIONS',
    label: '50+ questions to ask your retirement plan',
  },
  abroad: {
    env: 'MAILERLITE_GROUP_ID_ABROAD',
    label: 'Cross-border retirement guide',
  },
};
const DEFAULT_MAGNET = 'ebook';

// Unrecognised values fall back rather than erroring: a visitor running a cached copy of
// main.js from before a magnet was renamed still gets a working signup.
function resolveMagnet(raw) {
  const key = typeof raw === 'string' && MAGNETS[raw] ? raw : DEFAULT_MAGNET;
  const groupId = process.env[MAGNETS[key].env] || process.env.MAILERLITE_GROUP_ID;
  return { key: key, label: MAGNETS[key].label, groupId: groupId };
}

/* Best-effort Meta Conversions API "Lead" event.

   Why server-side at all: the browser pixel starts consent-revoked, so a visitor who
   ignores the cookie banner sends Facebook nothing — including the conversion. Ad delivery
   optimises against these events, so with browser-only tracking the ad system is largely
   blind to the signups it produced.

   This fires ONLY when someone deliberately submits the signup form — never on browsing.
   That distinction is what makes it defensible, and privacy.html states it plainly. If that
   ever stops being true, the disclosure has to change with it.

   `eventId` is the same id the browser sends with its own fbq('track','Lead', …, {eventID}).
   Meta uses it to collapse the two into one conversion; omit it and every signup that does
   have consent is counted twice. Never fails the signup — analytics is not the product. */
async function sendCapiLead(opts) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) {
    // Log-only mode: this is the normal state locally and before the Vercel vars are set.
    console.log(
      `[capi] not configured — would have sent Lead (magnet=${opts.magnet}, event_id=${opts.eventId})`
    );
    return;
  }
  const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
  try {
    const capiRes = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              event_name: 'Lead',
              event_time: Math.floor(Date.now() / 1000),
              event_id: opts.eventId,
              event_source_url: opts.sourceUrl,
              action_source: 'website',
              // Meta requires the email pre-hashed, lowercased and trimmed. The raw
              // address never leaves this function.
              user_data: {
                em: [sha256(String(opts.email).trim().toLowerCase())],
                client_ip_address: opts.clientIp,
                client_user_agent: opts.userAgent,
              },
              custom_data: { content_name: opts.magnet },
            },
          ],
          access_token: token,
        }),
      }
    );
    if (!capiRes.ok) {
      console.error('[capi] Lead rejected:', capiRes.status, await capiRes.text());
    }
  } catch (capiErr) {
    console.error('[capi] Lead failed (non-fatal):', capiErr);
  }
}

// Best-effort internal notification so dev@webnomad.org always gets a copy of each signup.
// Uses Resend (same key as the contact form). Silently no-ops if the key is missing.
async function notifyDev(name, email, magnetLabel) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('RESEND_API_KEY is not set — skipping dev notification');
    return;
  }
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeName = (name || '').trim();
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'WebNomad Newsletter <noreply@webnomad.org>',
        to: ['dev@webnomad.org'],
        reply_to: email,
        subject: `New signup (${magnetLabel}): ${safeName || email}`,
        html: `<p><strong>New free-download signup</strong></p>
<p><strong>Requested:</strong> ${esc(magnetLabel)}</p>
<p><strong>Name:</strong> ${safeName ? esc(safeName) : '(not given)'}</p>
<p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>`,
        text: `New free-download signup\nRequested: ${magnetLabel}\nName: ${safeName || '(not given)'}\nEmail: ${email}`,
      }),
    });
  } catch (notifyErr) {
    console.error('Dev notification failed (non-fatal):', notifyErr);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, _honey, magnet, eventId } = req.body || {};

  // Honeypot spam trap — bots fill hidden fields, humans don't
  if (_honey) return res.status(400).json({ error: 'Bad request' });

  // Basic field validation (name is optional for newsletter signup).
  // Trim first: the regex forbids whitespace, so a pasted address carrying a leading or
  // trailing space — common from mobile keyboards and copy/paste — used to be rejected as
  // invalid. On a signup form that is a lost subscriber, not a helpful error.
  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) {
    return res.status(400).json({ error: 'An email address is required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const apiKey = process.env.MAILERLITE_API_KEY;
  const chosen = resolveMagnet(magnet);
  if (!apiKey || !chosen.groupId) {
    console.error('MAILERLITE_API_KEY or MAILERLITE_GROUP_ID is not set');
    return res.status(500).json({ error: 'Email service not configured.' });
  }

  // The browser generates the dedupe id and reuses it for its own fbq call, so the two
  // events pair up even if this response is lost. Only fall back if it did not send one.
  const leadEventId =
    typeof eventId === 'string' && eventId ? eventId.slice(0, 64) : crypto.randomUUID();

  const safeName = (name || '').trim();
  const firstName = safeName ? safeName.split(/\s+/)[0] : '';

  try {
    // Upsert the subscriber into the MailerLite group. MailerLite's automation
    // (triggered on joining the group) sends the welcome email + eBook link.
    // status "active" = no confirmation step; switch to "unconfirmed" for double opt-in
    // (see NEWSLETTER-SETUP.md).
    const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: cleanEmail,
        fields: firstName ? { name: firstName } : {},
        groups: [chosen.groupId],
        status: 'active',
      }),
    });

    // 201 = created, 200 = already existed (updated) — both are success.
    if (mlRes.status === 201 || mlRes.status === 200) {
      // Both are best-effort and must never block or fail the signup itself.
      await notifyDev(name, cleanEmail, chosen.label);
      await sendCapiLead({
        email: cleanEmail,
        magnet: chosen.key,
        eventId: leadEventId,
        sourceUrl: req.headers.referer || 'https://airetirementincomeplanner.com/',
        clientIp: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined,
        userAgent: req.headers['user-agent'],
      });
      return res.status(200).json({ ok: true, magnet: chosen.key, eventId: leadEventId });
    }

    // 422 = invalid data (most likely a malformed email MailerLite rejected).
    if (mlRes.status === 422) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const errText = await mlRes.text();
    console.error('MailerLite error:', mlRes.status, errText);
    return res.status(502).json({
      error: 'Could not complete your signup. Please try again or email dev@webnomad.org directly.',
    });
  } catch (err) {
    console.error('Newsletter handler error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
