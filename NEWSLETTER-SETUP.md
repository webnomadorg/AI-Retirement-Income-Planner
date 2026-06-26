# Newsletter signup — setup & revert notes

The free-eBook signup form (`newsletter.html`) posts to the Vercel serverless function
`api/newsletter.js`. As of the MailerLite change, that function **adds each signup to a
MailerLite group** (the mailing list) via the MailerLite API. MailerLite then sends the
welcome email + eBook via an automation.

Previously the function sent the welcome email + eBook itself using **Resend** and did not
build any list. That original version is archived at the bottom of this file so it can be
restored at any time.

---

## Current setup (MailerLite)

### One-time setup in MailerLite
1. **Account approval** — a brand-new MailerLite account must be approved before it can send
   any email. Finish the account profile / approval first, or the welcome automation won't
   actually send.
2. **Create a group** for subscribers, e.g. "Newsletter — Free eBook".
3. **Find the Group ID and generate an API token:** Integrations → *MailerLite API* → **Use**.
   - The **Group IDs** for your account are listed there (scroll to the Groups section).
   - Click **Generate new token**, name it (e.g. "Website signup"), choose **Allow all IP
     addresses** (Vercel's outbound IPs are dynamic, so don't use an IP allowlist), then
     **Create token** and copy it.
4. **Build the welcome automation:** trigger = *"when a subscriber joins group <your group>"*;
   add an email step whose body contains a **Download button** linking to the eBook:
   `https://airetirementincomeplanner.com/assets/downloads/Build-a-Retirement-Plan-You-Can-Question-eBook.pdf`

### Vercel environment variables (Project → Settings → Environment Variables, all envs)
| Variable | Value |
| --- | --- |
| `MAILERLITE_API_KEY` | the API token from step 3 |
| `MAILERLITE_GROUP_ID` | the Group ID from step 3 |
| `RESEND_API_KEY` | **leave as-is** — still used by the contact form, and needed if you revert |

After adding/changing env vars, **redeploy** so the function picks them up.

### How the function works now
On submit, `api/newsletter.js` calls
`POST https://connect.mailerlite.com/api/subscribers` with the subscriber's email + first
name and the group ID. MailerLite returns **201** (new) or **200** (already existed) — both
are treated as success. The honeypot + email-format checks run first. No email is sent by our
code anymore; MailerLite's automation handles the welcome + eBook.

### Opt-in mode
The function sends `status: "active"` → subscribers are added immediately and get the eBook
right away (best conversion). To switch to **double opt-in** (subscriber must click a
confirmation link first):
1. change `status: "active"` to `status: "unconfirmed"` in `api/newsletter.js`, and
2. enable double opt-in for the group in MailerLite, and
3. update the `#nl-success` copy in `newsletter.html` to tell users to confirm via email.

---

## How to revert to the original (Resend) version

Either:

**A. Via git** — the last Resend-based version is commit `5214145`. Restore just that file:
```
cd Website
git checkout 5214145 -- api/newsletter.js
```
Then commit/push and redeploy. No env changes needed (`RESEND_API_KEY` is still set).

**B. Manually** — copy the archived source below back over `Website/api/newsletter.js`,
then commit/push and redeploy. You may remove the `MAILERLITE_API_KEY` /
`MAILERLITE_GROUP_ID` Vercel env vars afterwards (optional).

> Note: reverting only changes who *sends the eBook* (back to Resend). Any subscribers already
> collected in MailerLite stay in MailerLite.

### Archived original `api/newsletter.js` (Resend version)

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
