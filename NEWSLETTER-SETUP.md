# Newsletter signup — setup, operation & switching guide

> ## ⚠ READ FIRST — signup is now DOUBLE OPT-IN (changed 2026-08-12)
>
> `api/newsletter.js` no longer exists; it is **`api/newsletter.mjs`**, and it **does not write
> to MailerLite at all**. It screens the address and emails a signed confirmation link.
> **`api/newsletter-confirm.mjs` is the only code path that adds a subscriber.**
>
> **One new environment variable is REQUIRED: `SIGNUP_TOKEN_SECRET`.** Without it every
> signup returns 503 and nothing works. That is deliberate — see below. Set it in Vercel and
> **redeploy** (env vars bind at deploy time).
>
> Everything in "How to switch modes" further down still describes the *old* single-opt-in
> behaviour and is kept only as history. Do not follow it expecting the current design.
> The current design is documented in **`Plans/Newsletter-Spam-Prevention.md`** (desktop repo).

## The two-step flow, end to end

1. Visitor focuses a signup form → `GET /api/newsletter` issues a short-lived signed **form
   token** (proves the form was rendered; catches instant robotic submits).
2. Visitor submits → `POST /api/newsletter` runs the free screen in `lib/signup-guard.mjs`:
   honeypot → syntax → **canonicalisation** → non-human localpart → disposable domain → form
   token → MX/A record.
3. Survivors get a confirmation email (Resend). **Nothing is stored anywhere yet** — the
   pending signup lives entirely inside the signed token in the link.
4. They click it → `GET /api/newsletter-confirm` verifies the signature and expiry, upserts
   into MailerLite (`status: "active"` — the confirmation already happened, on our link),
   fires the Meta CAPI `Lead`, notifies `dev@webnomad.org`, and redirects to
   `/confirmed.html`.

### The one thing to understand about the spam it was built for

Addresses like `a.rch.i.e.w.ane.2.9@gmail.com` are **valid, deliverable mailboxes**. Gmail
ignores dots, so that is the same inbox as `archiewane29@gmail.com`, and one person can mint
unlimited distinct-looking addresses that all land in it. **No email-verification API can
catch this** — ZeroBounce, Kickbox and the rest all return `valid`, correctly, and charge for
the answer. Canonicalisation (free, instant) is the only fix, which is why none was bought.

### Why a missing `SIGNUP_TOKEN_SECRET` breaks signup instead of degrading

Because a quiet fallback would silently disable the entire double opt-in while the site kept
looking healthy. `UPDATE_LOOKUP_PEPPER` sat unset in production from launch until 2026-08-08
for exactly that reason. Breaking loudly is the feature.

### What is logged

`lib/signup-quarantine.mjs` writes one blob per decision to `signup-log/`, visible in the
owner console's **Signups** tab. **No plaintext addresses** — a masked form, the domain, and
an HMAC of the canonical address so repeat attempts can be counted without keeping a list of
addresses nobody consented to. Check it for **false positives**, not just spam volume.

It also enforces **one confirmation email per address+magnet per day**, via
`allowOverwrite:false` on a deterministic key (atomic at the storage layer, same trick as the
affiliate payout ledger). Without that cap, canonicalisation would make this endpoint a
convenient way to send a hundred emails to one victim.

### Facebook Lead Ads

`api/meta-leads.mjs` runs the same screen but **deliberately no double opt-in** — Meta already
verified the address and pre-filled it from the person's account, so a second confirmation
would just discard paid leads. Canonicalisation, disposable and MX checks still apply, so it
cannot be used as a back door into the list.

### Tests

`node Website/tools/test-signup-guard.mjs` — 63 assertions over canonicalisation, tokens and
the screen. Run automatically by `pwsh tools/website-sync.ps1` before every push.

---

## History — the original single-opt-in design

The rest of this document describes the flow **before** 2026-08-12, when
`api/newsletter.js` wrote straight into MailerLite. It is retained because the Mode A/Mode B
sources below are still the reference for the MailerLite and Resend call shapes.

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

### Four lead magnets, one endpoint (added 2026-08-04)

`/api/newsletter` no longer delivers only the eBook. The posted `magnet` field selects the
MailerLite group, and therefore which automation — and which PDF — the subscriber receives.
The keys live in `MAGNETS` at the top of `api/newsletter.js`; the forms declare them with
`data-magnet="…"`.

| `magnet` | Offered on | PDF to link from the automation |
| --- | --- | --- |
| `ebook` (default) | `newsletter.html`, `/get/ebook.html`, most blog posts | `/assets/downloads/Build-a-Retirement-Plan-You-Can-Question-eBook.pdf` |
| `checklist` | `/get/checklist.html`, Planner How-To posts | `/assets/downloads/Retirement-Planning-Input-Checklist.pdf` |
| `questions` | `/get/questions.html`, the Appendix B post | `/assets/downloads/Questions-To-Ask-Your-Retirement-Plan.pdf` |
| `abroad` | `/get/abroad.html`, cross-border posts | `/assets/downloads/What-Retiring-Abroad-Does-To-Your-Income.pdf` |

Prefix each with `https://airetirementincomeplanner.com`. The three new PDFs are generated —
edit the eBook or the study data and re-run **`python tools/lead-magnets/build_magnets.py`**
(desktop repo) rather than editing the PDFs by hand.

**Setup still to do in the MailerLite UI** — until it is done, all four magnets fall back to
the eBook group, so signups keep working but everyone receives the eBook:

1. Create three groups, e.g. "Free — Input checklist", "Free — Plan questions",
   "Free — Retiring abroad".
2. Give each an automation: trigger *"when a subscriber joins the group"*, one email with a
   **Download** button pointing at that magnet's PDF above. Set each one **Active**.
3. Copy each group ID into the matching Vercel env var below and redeploy.

### Vercel environment variables (Project → Settings → Environment Variables, all environments)
| Variable | Used by | Notes |
| --- | --- | --- |
| `SIGNUP_TOKEN_SECRET` | **double opt-in — REQUIRED** | **secret.** Any random string of 16+ chars (e.g. `openssl rand -base64 32`). Signs the form token and the confirmation link. **Unset = every signup returns 503, by design.** Rotating it invalidates confirmation links already in flight — those people simply sign up again. |
| `BLOB_READ_WRITE_TOKEN` | quarantine log + daily confirmation cap | already set for the other Blob features |
| `MAILERLITE_API_KEY` | Mode A | the secret MailerLite token |
| `MAILERLITE_GROUP_ID` | Mode A | `188987074019329204` — also the fallback for any magnet below that is unset |
| `MAILERLITE_GROUP_ID_CHECKLIST` | Mode A | group ID for the input checklist |
| `MAILERLITE_GROUP_ID_QUESTIONS` | Mode A | group ID for the plan questions |
| `MAILERLITE_GROUP_ID_ABROAD` | Mode A | group ID for the cross-border guide |
| `RESEND_API_KEY` | Both modes + the contact form | leave set; needed for dev notification (A) and everything (B) |
| `META_PIXEL_ID` | Conversions API | `2106222783607307` (not secret) |
| `META_CAPI_TOKEN` | Conversions API | **secret** — Events Manager → Settings → Conversions API → Generate access token. Unset = log-only, no events sent |
| `META_APP_SECRET` | Lead Ads webhook | **secret** — verifies `X-Hub-Signature-256` |
| `META_PAGE_ACCESS_TOKEN` | Lead Ads webhook | **secret** — Page token with `leads_retrieval` |
| `META_LEADGEN_VERIFY_TOKEN` | Lead Ads webhook | any string you choose; type the same one into Meta's webhook UI |

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
1. Submit any `/get/*` page or `newsletter.html` with a throwaway email.
2. You land on `/thank-you.html`, naming the download you asked for (no red error).
3. **Mode A:** subscriber appears in the MailerLite group; the automation's email + PDF arrive.
   **Mode B:** the welcome email + eBook arrive directly.
4. Both modes: `dev@webnomad.org` receives the signup notification.

⚠ **The two emails do NOT arrive together — give it time before diagnosing.** The
`dev@webnomad.org` notification is sent by this function directly, so it lands in seconds. The
subscriber's own email comes from a MailerLite *automation*, which is queued and routinely runs
several minutes behind. "Admin notification arrived, subscriber email did not" therefore looks
identical to a broken automation for the first few minutes, and on 2026-08-04 it sent us hunting
a fault that did not exist. Wait ~10 minutes before concluding anything is wrong.
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
