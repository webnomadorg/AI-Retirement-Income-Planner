/* Stripe webhook — POST /api/stripe-webhook

   Fires on `checkout.session.completed`. Does three things:
     1. Always emails dev@webnomad.org an owner alert (product, amount, buyer email).
     2. If the purchase includes a bookable session (product metadata.book set),
        emails the BUYER their booking directions (Calendly link) — the reliable
        safety net so a buyer who never opens thanks.html still learns how to book.
     3. Records the purchase in the email→sessions lookup index (see lib/purchase-log.mjs)
        so the buyer can later pull updated files from inside the planner itself,
        knowing only the address they bought with.

   Signature is verified manually (no Stripe SDK — this project uses fetch only)
   against STRIPE_WEBHOOK_SECRET. Raw body is required for that, so body parsing
   is disabled below.

   Env (Vercel project settings):
     STRIPE_WEBHOOK_SECRET — signing secret from the Stripe webhook endpoint (whsec_…)
     STRIPE_VERIFY_KEY     — restricted read-only key, used to expand line items
     RESEND_API_KEY        — already set; used for both emails
     UPDATE_LOOKUP_PEPPER  — secret for hashing emails into blob keys (step 3)

   NOTE: classic Node (req, res) signature — same as the other functions here. */

import crypto from 'node:crypto';
import { appendPurchase } from '../lib/purchase-log.mjs';

export const config = { api: { bodyParser: false } };

const SITE = 'https://airetirementincomeplanner.com';
// Calendly scheduling links by session duration key (metadata.book). 1-hour only at launch.
const CALENDLY = { '1hr': 'https://calendly.com/webnomad/1-on-1-planner-session-1-hour' };
const SESSION_LABEL = { '1hr': '1-hour session', '2hr': '2-hour session' };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// Verify Stripe's `Stripe-Signature` header: t=timestamp,v1=hex-hmac.
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = {};
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const age = Math.floor(Date.now() / 1000) - Number(t);
  if (!Number.isFinite(age) || Math.abs(age) > toleranceSec) return false; // replay guard
  return true;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendEmail(key, payload) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('stripe-webhook: failed to read body', err);
    return res.status(400).json({ error: 'Could not read body' });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-safe: not configured yet (e.g. deployed before the secret was added).
    // Acknowledge so Stripe doesn't hammer retries; nothing is processed.
    console.warn('stripe-webhook: STRIPE_WEBHOOK_SECRET not set — skipping (no-op).');
    return res.status(200).json({ received: true, skipped: 'unconfigured' });
  }

  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sig, secret)) {
    console.warn('stripe-webhook: invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Only care about completed checkouts. Acknowledge everything else.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const resendKey = process.env.RESEND_API_KEY;

  try {
    const sessionObj = event.data?.object ?? {};
    const sessionId = sessionObj.id;
    const buyerEmail = sessionObj.customer_details?.email || null;
    const amount = typeof sessionObj.amount_total === 'number' ? (sessionObj.amount_total / 100) : null;
    const currency = (sessionObj.currency || 'usd').toUpperCase();

    // Line items are not in the webhook payload — expand them via the read-only key.
    let products = [];
    let sessions = [];
    const verifyKey = process.env.STRIPE_VERIFY_KEY;
    if (verifyKey && sessionId) {
      const r = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items.data.price.product`,
        { headers: { Authorization: `Bearer ${verifyKey}` } },
      );
      if (r.ok) {
        const full = await r.json();
        const items = full.line_items?.data ?? [];
        products = items
          .map((li) => ({
            name: li.price?.product?.name ?? li.description,
            book: li.price?.product?.metadata?.book,
            zip: li.price?.product?.metadata?.zip,
          }));
        sessions = products.filter((p) => p.book);
      } else {
        console.error('stripe-webhook: could not expand session', r.status);
      }
    }

    // Record this purchase against the buyer's email so they can re-download later from
    // inside the planner. Only downloadable products (those with a zip) are worth indexing;
    // a session booking has nothing to fetch.
    //
    // Deliberately isolated: a Blob outage must never cost the owner their purchase alert,
    // and must never make this handler return non-200 (Stripe would then retry the whole
    // webhook and re-send the emails). Log and carry on.
    const downloadables = products.filter((p) => p.zip);
    if (buyerEmail && downloadables.length && process.env.UPDATE_LOOKUP_PEPPER) {
      try {
        await appendPurchase(buyerEmail, {
          id: sessionId,
          ts: new Date().toISOString(),
          products: downloadables.map((p) => ({ name: p.name, zip: p.zip })),
        });
      } catch (e) {
        console.error('stripe-webhook: purchase-log write failed (emails unaffected)', e);
      }
    } else if (buyerEmail && downloadables.length) {
      console.warn('stripe-webhook: UPDATE_LOOKUP_PEPPER not set — purchase not indexed for in-app updates');
    }

    const productNames = products.length
      ? products.map((p) => p.name).join(', ')
      : '(unknown — could not expand line items)';
    const amountStr = amount != null ? `${currency} ${amount.toFixed(2)}` : 'unknown';

    if (!resendKey) {
      console.error('stripe-webhook: RESEND_API_KEY not set — cannot email; purchase was:', productNames, amountStr, buyerEmail);
      return res.status(200).json({ received: true, emailed: false });
    }

    // 1. Owner alert (always)
    try {
      await sendEmail(resendKey, {
        from: 'WebNomad Sales <dev@webnomad.org>',
        to: ['dev@webnomad.org'],
        reply_to: buyerEmail || undefined,
        subject: `New purchase: ${productNames} — ${amountStr}`,
        html: `<p><strong>Product(s):</strong> ${esc(productNames)}</p>
<p><strong>Amount:</strong> ${esc(amountStr)}</p>
<p><strong>Buyer email:</strong> ${buyerEmail ? `<a href="mailto:${esc(buyerEmail)}">${esc(buyerEmail)}</a>` : '(not provided)'}</p>
<p><strong>Includes session:</strong> ${sessions.length ? 'Yes — booking email sent to buyer' : 'No'}</p>
<p style="color:#777"><strong>Session id:</strong> ${esc(sessionId || '')}</p>`,
        text: `New purchase\nProduct(s): ${productNames}\nAmount: ${amountStr}\nBuyer: ${buyerEmail || '(not provided)'}\nIncludes session: ${sessions.length ? 'Yes' : 'No'}\nSession id: ${sessionId || ''}`,
      });
    } catch (e) {
      console.error('stripe-webhook: owner email failed', e);
    }

    // 2. Buyer booking directions (only when a session was purchased)
    if (sessions.length && buyerEmail) {
      const first = sessions[0];
      const url = CALENDLY[first.book];
      const label = SESSION_LABEL[first.book] || 'session';
      const bookHtml = url
        ? `<p style="margin:1.4rem 0"><a href="${url}" style="background:#1B7165;color:#fff;padding:.7rem 1.2rem;border-radius:8px;text-decoration:none;display:inline-block">Choose a time →</a></p>
<p style="color:#555;font-size:.9rem">Or paste this link into your browser: <a href="${url}">${url}</a></p>`
        : `<p>We’ll email you to arrange a time. Any questions, just reply to this message or write to <a href="mailto:dev@webnomad.org">dev@webnomad.org</a>.</p>`;
      try {
        await sendEmail(resendKey, {
          from: 'WebNomad Studio <dev@webnomad.org>',
          to: [buyerEmail],
          reply_to: 'dev@webnomad.org',
          subject: `Book your ${label} — AI Retirement Income Planner`,
          html: `<p>Thank you for booking a ${esc(label)}!</p>
<p><strong>Your session isn’t scheduled yet</strong> — please pick a time that suits you. It’s confirmed once you choose a slot:</p>
${bookHtml}
<p style="color:#555;font-size:.92rem">None of the available times convenient? Just reply to this email (or write to <a href="mailto:dev@webnomad.org">dev@webnomad.org</a>) with a few times that suit you and I’ll do my best to accommodate them. Once we agree a time that works for us both, you’ll receive a calendar invitation with the meeting link.</p>
<p>What to expect:</p>
<ul>
  <li>A one-hour, online, screen-share walkthrough of the planner — how to set it up, enter your numbers, and read the results, plus the concepts behind them.</li>
  <li>A <strong>Google Meet</strong> link is added to the calendar invite automatically — no extra software or account needed.</li>
  <li>You’ll leave with a <strong>starter scenario file</strong> we build together, emailed to you afterwards.</li>
  <li>Nothing sensitive is required — we work with sample numbers or the figures you’re comfortable sharing on screen.</li>
</ul>
<p style="background:#f4f7f6;border-left:3px solid #1B7165;padding:.6em 1em;color:#444;font-size:.92rem">
  These sessions are <strong>educational instruction only</strong> — they are not financial, tax, or legal advice, and no personalised recommendations are given. See the <a href="${SITE}/terms.html">session terms</a>.
</p>
<p>— WebNomad Studio<br><a href="${SITE}">airetirementincomeplanner.com</a></p>`,
          text: `Thank you for booking a ${label}!\n\nYour session isn’t scheduled yet — please pick a time here (it’s confirmed once you choose a slot):\n${url || 'We’ll email you to arrange a time.'}\n\nNone of the available times convenient? Reply to this email with a few times that suit you and I’ll do my best to accommodate them; once we agree a time you’ll get a calendar invitation with the meeting link.\n\nA Google Meet link is added automatically. You’ll leave with a starter scenario file emailed afterwards. Nothing sensitive is required.\n\nThese sessions are educational instruction only — not financial, tax, or legal advice. Terms: ${SITE}/terms.html\n\n— WebNomad Studio\n${SITE}`,
        });
      } catch (e) {
        console.error('stripe-webhook: buyer booking email failed', e);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook handler error:', err);
    // Acknowledge to avoid infinite retries; the error is logged for follow-up.
    return res.status(200).json({ received: true, error: 'handler error (logged)' });
  }
}
