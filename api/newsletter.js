/* Vercel serverless function — POST /api/newsletter
   Free-eBook newsletter signup. Adds the subscriber to a MailerLite group (the mailing
   list); MailerLite's welcome automation sends the eBook download link.
   Requires MAILERLITE_API_KEY and MAILERLITE_GROUP_ID environment variables in Vercel.

   Setup + revert notes: see ../NEWSLETTER-SETUP.md.
   The previous Resend-based version (which sent the eBook itself) is git commit 5214145
   and is archived verbatim in that doc. */

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
