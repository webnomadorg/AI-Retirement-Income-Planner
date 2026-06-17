/* Vercel serverless function — POST /api/contact
   Sends a notification to dev@webnomad.org and a confirmation to the submitter.
   Requires RESEND_API_KEY environment variable set in Vercel project settings. */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, subject, message, _honey } = req.body || {};

  // Honeypot spam trap — bots fill hidden fields, humans don't
  if (_honey) return res.status(400).json({ error: 'Bad request' });

  // Basic field validation
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: 'Message is too long (max 5,000 characters).' });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('RESEND_API_KEY is not set');
    return res.status(500).json({ error: 'Email service not configured.' });
  }

  const subjectLine = subject
    ? `Contact: ${subject} — from ${name}`
    : `Contact form message from ${name}`;

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
    // 1. Notification to WebNomad
    const notifyRes = await sendEmail({
      from: 'WebNomad Contact Form <noreply@webnomad.org>',
      to: ['dev@webnomad.org'],
      reply_to: email,
      subject: subjectLine,
      html: `<p><strong>Name:</strong> ${esc(name)}</p>
<p><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>
<p><strong>Subject:</strong> ${subject ? esc(subject) : '(none)'}</p>
<hr style="border:none;border-top:1px solid #ddd;margin:1rem 0">
<p style="white-space:pre-wrap">${esc(message)}</p>`,
      text: `Name: ${name}\nEmail: ${email}\nSubject: ${subject || '(none)'}\n\n${message}`,
    });

    if (!notifyRes.ok) {
      const errText = await notifyRes.text();
      console.error('Resend notification error:', notifyRes.status, errText);
      return res.status(502).json({
        error: 'Could not send your message. Please try again or email dev@webnomad.org directly.',
      });
    }

    // 2. Confirmation to sender (best-effort — a failure here doesn't fail the request)
    try {
      await sendEmail({
        from: 'WebNomad Studio <noreply@webnomad.org>',
        to: [email],
        subject: 'We received your message — WebNomad Studio',
        html: `<p>Hi ${esc(name)},</p>
<p>Thanks for reaching out — we've received your message and will reply as soon as we can (usually within one business day).</p>
<blockquote style="border-left:3px solid #1B7165;margin:1em 0;padding:.5em 1em;color:#555;white-space:pre-wrap">${esc(message)}</blockquote>
<p>— WebNomad Studio<br><a href="https://airetirementincomeplanner.com">airetirementincomeplanner.com</a></p>`,
        text: `Hi ${name},\n\nThanks for reaching out — we've received your message and will reply as soon as we can (usually within one business day).\n\n"${message}"\n\n— WebNomad Studio\nhttps://airetirementincomeplanner.com`,
      });
    } catch (confErr) {
      console.error('Confirmation email failed (non-fatal):', confErr);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact handler error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
