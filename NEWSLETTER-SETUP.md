# Newsletter signup — setup, operation & switching guide

The free-eBook signup form (`newsletter.html`) posts to the Vercel serverless function
`api/newsletter.js`. That function can run in **either of two modes**. This doc records both
so you can switch between them at any time, even after the original chat/context is gone.

| Mode | What it does | Builds a mailing list? | Who sends the eBook? | Needs |
| --- | --- | --- | --- | --- |
| **A — MailerLite** *(CURRENTLY ACTIVE)* | Adds each signup to a MailerLite group; MailerLite's automation emails the welcome + eBook. Also sends a dev notification via Resend. | ✅ Yes (in MailerLite) | MailerLite automation | `MAILERLITE_API_KEY`, `MAILERLITE_GROUP_ID`, `RESEND_API_KEY` |
| **B — Resend only** *(original)* | The function itself emails the subscriber the welcome + eBook, and notifies dev. No list is stored anywhere. | ❌ No | The function (Resend) | `RESEND_API_KEY` |

Both modes: keep the honeypot + email-format checks, and send a best-effort "new signup"
notification to `dev@webnomad.org` (via Resend) that never blocks the signup.

The eBook PDF lives at
`https://airetirementincomeplanner.com/assets/downloads/Build-a-Retirement-Plan-You-Can-Question-eBook.pdf`
(unlisted — only delivered by email). Both modes link to it.

---

## Current configuration (Mode A — MailerLite)

### MailerLite account
- **Group:** "Newsletter — Free eBook" · **Group ID:** `188987074019329204` (not secret).
- **API token:** generated under Integrations → MailerLite API → Use → *Generate new token*
  (chose "Allow all IP addresses"). The token is a **secret** — it is stored only in Vercel
  (see below), never in this repo. To rotate it: generate a new token in MailerLite and update
  the Vercel value.
- **Welcome automation:** trigger = *"when a subscriber joins the group"*, one email step with a
  **Download** button linking to the eBook URL above. Must be **Active** to send.
- **Sending domain:** `webnomad.org` verified in MailerLite (so the "from" address doesn't spam).
- **Opt-in:** single opt-in (instant eBook). For double opt-in, set `status: "unconfirmed"` in
  the function AND enable double opt-in on the group AND update the `#nl-success` copy in
  `newsletter.html` to tell users to confirm first.

### Vercel environment variables (Project → Settings → Environment Variables, all environments)
| Variable | Used by | Notes |
| --- | --- | --- |
| `MAILERLITE_API_KEY` | Mode A | the secret MailerLite token |
| `MAILERLITE_GROUP_ID` | Mode A | `188987074019329204` |
| `RESEND_API_KEY` | Both modes + the contact form | leave set; needed for dev notification (A) and everything (B) |

Env-var changes only take effect on the **next deployment** — redeploy after editing them.

---

## How to switch modes

Switching = replace the body of `Website/api/newsletter.js` with the matching version below,
then commit, push (auto-deploys), and make sure the right env vars exist.

### → Switch to Mode A (MailerLite) — the current state
1. Ensure `MAILERLITE_API_KEY` + `MAILERLITE_GROUP_ID` (and `RESEND_API_KEY`) are set in Vercel.
2. Ensure the MailerLite group + welcome automation exist and the automation is **Active**.
3. Put the **Mode A source** (below) into `api/newsletter.js`. (Or `git checkout c5d03d8 -- api/newsletter.js`.)
4. Commit, push, redeploy. Test (see Verification).

### → Switch to Mode B (Resend only) — the original
1. Ensure `RESEND_API_KEY` is set in Vercel (it already is — the contact form uses it).
2. Put the **Mode B source** (below) into `api/newsletter.js`. (Or `git checkout 5214145 -- api/newsletter.js`.)
3. Commit, push, redeploy. Test by signing up — the eBook email should arrive directly.
4. (Optional) the MailerLite env vars can stay or be removed; Mode B ignores them.
5. Note: any subscribers already collected in MailerLite remain there; Mode B just stops adding new ones.

> Git references: Mode A = commit `c5d03d8` · Mode B (original) = commit `5214145`.

---

## Verification (after any deploy)

The function + external APIs only run on Vercel (not the local static preview), so test live:
1. Submit `https://airetirementincomeplanner.com/newsletter.html` with a throwaway email.
2. Page shows the green "Check your inbox!" state (no red error).
3. **Mode A:** subscriber appears in the MailerLite group; MailerLite welcome email + eBook arrive.
   **Mode B:** the welcome email + eBook arrive directly.
4. Both modes: `dev@webnomad.org` receives the "New newsletter signup" notification.
5. If anything fails, check **Vercel → project → deployment → Logs/Functions** for the
   `/api/newsletter` entry (it logs the upstream status code).

Common issues: 401 = bad/rotated MailerLite token; "Email service not configured" = a required
env var is missing or the deploy predates it (redeploy); subscriber added but no welcome email =
MailerLite automation not Active, domain unverified, or double opt-in awaiting confirmation.

---

## Full source — Mode A (MailerLite, currently active)

```js
/* Vercel serverless function — POST /api/newsletter
   Free-eBook newsletter signup. Adds the subscriber to a MailerLite group (the mailing
   list); MailerLite's welcome automation sends the eBook download link.
   Requires MAILERLITE_API_KEY and MAILERLITE_GROUP_ID environment variables in Vercel.

   A best-effort "new signup" notification is also sent to dev@webnomad.org via Resend
   (RESEND_API_KEY — already used by the contact form); a failure there never fails signup.

   Setup + revert notes: see ../NEWSLETTER-SETUP.md.
   The previous Resend-based version (which sent the eBook itself) is git commit 5214145
   and is archived verbatim in that doc. */

// Best-effort internal notification so dev@webnomad.org always gets a copy of each signup.
// Uses Resend (same key as the contact form). Silently no-ops if the key is missing.
async function notifyDev(name, email) {
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
        subject: `New newsletter signup: ${safeName || email}`,
        html: `<p><strong>New free-eBook newsletter signup</strong></p>
<p><strong>Name:</strong> ${safeName ? esc(safeName) : '(not given)'}</p>
<p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>`,
        text: `New free-eBook newsletter signup\nName: ${safeName || '(not given)'}\nEmail: ${email}`,
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

  const { name, email, _honey } = req.body || {};

  // Honeypot spam trap — bots fill hidden fields, humans don't
  if (_honey) return res.status(400).json({ error: 'Bad request' });

  // Basic field validation (name is optional for newsletter signup)
  if (!email) {
    return res.status(400).json({ error: 'An email address is required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const apiKey = process.env.MAILERLITE_API_KEY;
  const groupId = process.env.MAILERLITE_GROUP_ID;
  if (!apiKey || !groupId) {
    console.error('MAILERLITE_API_KEY or MAILERLITE_GROUP_ID is not set');
    return res.status(500).json({ error: 'Email service not configured.' });
  }

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
        email: email,
        fields: firstName ? { name: firstName } : {},
        groups: [groupId],
        status: 'active',
      }),
    });

    // 201 = created, 200 = already existed (updated) — both are success.
    if (mlRes.status === 201 || mlRes.status === 200) {
      await notifyDev(name, email); // best-effort; never blocks/fails the signup
      return res.status(200).json({ ok: true });
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
```

---

## Full source — Mode B (Resend only, original)

```js
/* Vercel serverless function — POST /api/newsletter
   Free-eBook newsletter signup. Notifies dev@webnomad.org of the new subscriber
   and sends the subscriber a welcome email with the free eBook download link.
   Requires RESEND_API_KEY environment variable set in Vercel project settings. */

// Unlisted download URL for the free eBook — only ever delivered by email, never
// linked on the site, so the signup acts as the gate.
const EBOOK_URL =
  'https://airetirementincomeplanner.com/assets/downloads/Build-a-Retirement-Plan-You-Can-Question-eBook.pdf';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, _honey } = req.body || {};

  // Honeypot spam trap — bots fill hidden fields, humans don't
  if (_honey) return res.status(400).json({ error: 'Bad request' });

  // Basic field validation (name is optional for newsletter signup)
  if (!email) {
    return res.status(400).json({ error: 'An email address is required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('RESEND_API_KEY is not set');
    return res.status(500).json({ error: 'Email service not configured.' });
  }

  const safeName = (name || '').trim();
  const greeting = safeName ? safeName.split(/\s+/)[0] : 'there';

  // Escape HTML for the notification email body
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
    // 1. Welcome email to the new subscriber, with the free eBook link
    const welcomeRes = await sendEmail({
      from: 'WebNomad Studio <noreply@webnomad.org>',
      to: [email],
      subject: 'Your free eBook is here — Build a Retirement Plan You Can Question',
      html: `<div style="font-family:Inter,Arial,sans-serif;color:#1f2a33;line-height:1.6;max-width:560px">
<p>Hi ${esc(greeting)},</p>
<p>Thanks for joining the WebNomad Studio newsletter — welcome aboard.</p>
<p>As promised, here is your free copy of <strong>Build a Retirement Plan You Can Question</strong> by Paul Hankin, the companion guide to the AI Retirement Income Planner:</p>
<p style="margin:1.4em 0">
  <a href="${EBOOK_URL}" style="background:#1B7165;color:#fff;text-decoration:none;padding:.8em 1.6em;border-radius:8px;font-weight:600;display:inline-block">📘 Download your free eBook (PDF)</a>
</p>
<p style="font-size:.9em;color:#555">If the button doesn't work, copy and paste this link into your browser:<br>
<a href="${EBOOK_URL}" style="color:#1B7165;word-break:break-all">${EBOOK_URL}</a></p>
<hr style="border:none;border-top:1px solid #e2e2e2;margin:1.6em 0">
<p>Inside, you'll learn how to plan retirement income as a <em>timeline</em> — testing withdrawals, watching the balance carry forward, handling taxes, ACA and IRMAA healthcare thresholds, inflation and real income, comparing withdrawal strategies, and using AI to review your own plan.</p>
<p>From here, you can expect occasional emails with practical tips, worked examples, new release notes, and new YouTube videos — never spam, and you can unsubscribe anytime.</p>
<p>Happy planning,<br>— WebNomad Studio<br><a href="https://airetirementincomeplanner.com" style="color:#1B7165">airetirementincomeplanner.com</a></p>
</div>`,
      text: `Hi ${greeting},

Thanks for joining the WebNomad Studio newsletter — welcome aboard.

As promised, here is your free copy of "Build a Retirement Plan You Can Question" by Paul Hankin, the companion guide to the AI Retirement Income Planner:

${EBOOK_URL}

Inside, you'll learn how to plan retirement income as a timeline — testing withdrawals, watching the balance carry forward, handling taxes, ACA and IRMAA healthcare thresholds, inflation and real income, comparing withdrawal strategies, and using AI to review your own plan.

From here, you can expect occasional emails with practical tips, worked examples, new release notes, and new YouTube videos — never spam, and you can unsubscribe anytime.

Happy planning,
— WebNomad Studio
https://airetirementincomeplanner.com`,
    });

    if (!welcomeRes.ok) {
      const errText = await welcomeRes.text();
      console.error('Resend welcome error:', welcomeRes.status, errText);
      return res.status(502).json({
        error: 'Could not send your eBook. Please try again or email dev@webnomad.org directly.',
      });
    }

    // 2. Notification to WebNomad (best-effort — a failure here doesn't fail the request)
    try {
      await sendEmail({
        from: 'WebNomad Newsletter <noreply@webnomad.org>',
        to: ['dev@webnomad.org'],
        reply_to: email,
        subject: `New newsletter signup: ${safeName || email}`,
        html: `<p><strong>New free-eBook newsletter signup</strong></p>
<p><strong>Name:</strong> ${safeName ? esc(safeName) : '(not given)'}</p>
<p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>`,
        text: `New free-eBook newsletter signup\nName: ${safeName || '(not given)'}\nEmail: ${email}`,
      });
    } catch (notifyErr) {
      console.error('Signup notification failed (non-fatal):', notifyErr);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Newsletter handler error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
```
