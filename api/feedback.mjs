/* Customer feedback intake — POST /api/feedback

   Body: { name, email, a1, a2, a3, quote_ok, attribution_style, display_name, region,
           social_ok, consent_version, app_build, _honey }
   200:  { ok: true }
   4xx:  { error: "…" }

   Records what a customer said, whether they had actually bought, and exactly what they
   consented to — at the moment they consented, which is the only time that verdict can
   honestly be captured. Nothing here publishes anything: a second, explicit approval of
   the specific wording happens later via api/feedback-approve.mjs. See
   Plans/Testimonials-Pipeline.md.

   ⚠ An unverified email NEVER blocks submission. It is recorded as unverified and simply
   cannot be published. Refusing to accept input based on who is sending it is exactly the
   review-suppression shape the FTC rule exists to stop — and it would also lose legitimate
   feedback from someone whose spouse paid, or who bought with a different address.

   Deliberately no CORS headers: unlike api/update-download.mjs (called from the planner
   running at file://), this is only ever posted from share.html on the same origin.

   Env:
     UPDATE_LOOKUP_PEPPER  — hashing + approval tokens (lib/feedback-log.mjs)
     BLOB_READ_WRITE_TOKEN — private Blob store
     STRIPE_VERIFY_KEY     — restricted read-only key, for the purchase check
     RESEND_API_KEY        — notification + acknowledgement email

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form
   crashes this project's runtime with FUNCTION_INVOCATION_FAILED. */

import { readPurchaseLog } from '../lib/purchase-log.mjs';
import { sessionsFromStripe } from '../lib/stripe-sessions.mjs';
import {
  newFeedbackId, hashEmail, approvalToken, writeFeedback, isConfigured,
} from '../lib/feedback-log.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OWNER = 'dev@webnomad.org';

const CAP = { name: 120, email: 254, answer: 4000, display_name: 80, region: 80, consent_version: 40 };
const ATTRIBUTION = ['full_name', 'first_initial', 'first_name', 'initials', 'region_only'];

/* Coarse rate limit, same shape and same caveat as api/update-download.mjs: serverless
   instances are ephemeral, so this is a speed bump against a single warm instance being
   hammered, not a wall. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return recent.length > RATE_MAX;
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

const trim = (v, max) => String(v ?? '').trim().slice(0, max);

async function sendEmail(payload) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/** Look the address up: the purchase index first, then Stripe itself for anyone who bought
    before the index existed or whose webhook write failed. Never throws. */
async function verifyPurchase(email) {
  const miss = { verified: false, method: 'none', session_id: null, product: null, purchased_at: null };
  try {
    let sessions = (await readPurchaseLog(email))?.sessions ?? [];
    let method = 'index';

    if (!sessions.length && process.env.STRIPE_VERIFY_KEY) {
      sessions = await sessionsFromStripe(email, process.env.STRIPE_VERIFY_KEY);
      method = 'stripe';
    }
    if (!sessions.length) return miss;

    sessions.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const newest = sessions[0];
    const products = (newest.products || []).map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);

    return {
      verified: true,
      method,
      session_id: newest.id || null,
      product: products.join(', ') || null,
      purchased_at: newest.ts || null,
    };
  } catch (err) {
    // A lookup failure must not cost us the submission — record it as unverified and say so.
    console.error('feedback: purchase lookup failed', err);
    return { ...miss, method: 'error' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // req.body is a lazy getter that THROWS when the platform can't parse the declared
    // Content-Type, so it needs its own try/catch or a malformed body becomes a 500.
    let body;
    try { body = req.body; } catch { body = null; }
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    body = body || {};

    // Honeypot — bots fill hidden fields, humans don't. Same trap as api/contact.mjs.
    if (body._honey) return res.status(400).json({ error: 'Bad request' });

    const name = trim(body.name, CAP.name);
    const email = trim(body.email, CAP.email).toLowerCase();
    const answers = {
      goal: trim(body.a1, CAP.answer),
      showed: trim(body.a2, CAP.answer),
      friction: trim(body.a3, CAP.answer),
    };

    if (!name) return res.status(400).json({ error: 'Please tell us your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!answers.goal && !answers.showed && !answers.friction) {
      return res.status(400).json({ error: 'Please fill in at least one of the three questions.' });
    }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Too many submissions just now — please wait a minute and try again.' });
    }

    const quoteOk = body.quote_ok === true || body.quote_ok === 'true' || body.quote_ok === 'on';
    const style = ATTRIBUTION.includes(body.attribution_style) ? body.attribution_style : 'first_initial';
    const buildNum = Number.parseInt(body.app_build, 10);

    const verification = await verifyPurchase(email);

    const id = newFeedbackId();
    const record = {
      id,
      v: 1,
      submitted_at: new Date().toISOString(),
      consent_version: trim(body.consent_version, CAP.consent_version) || 'unknown',
      app_build: Number.isFinite(buildNum) && buildNum > 0 ? buildNum : null,
      name,
      email,                       // plaintext lives ONLY here — see lib/feedback-log.mjs
      email_hmac: hashEmail(email),
      approval_token: approvalToken(id),
      verification,
      answers,                     // verbatim, never edited in place
      consent: {
        quote_ok: quoteOk,
        attribution_style: style,
        display_name: trim(body.display_name, CAP.display_name),
        region: trim(body.region, CAP.region),
        social_ok: body.social_ok === true || body.social_ok === 'true' || body.social_ok === 'on',
      },
      incentive: 'none',           // recording the negative IS the evidence under the FTC guides
      status: quoteOk ? 'new' : 'no-consent',
      published_text: null,
      attribution_text: null,
      approval: null,
      withdrawal: null,
    };

    // If the pepper is missing the record can't be made auditable. Do NOT throw the
    // customer's effort away over an env problem — mail it to the owner and shout about it.
    // `failure` names WHICH problem, because "check one of these two things" cost a real
    // debugging session the first time this fired.
    let stored = false;
    let failure = null;
    if (!isConfigured()) {
      failure = 'UPDATE_LOOKUP_PEPPER is not set on the Vercel project, so no auditable record '
        + 'can be created (it derives the approval token). Set it in Settings → Environment '
        + 'Variables and redeploy. Safe to set now ONLY while customers/ is empty — changing it '
        + 'later orphans every indexed purchase.';
      console.error('feedback: UPDATE_LOOKUP_PEPPER is not set — submission not recorded');
    } else {
      try {
        await writeFeedback(record);
        stored = true;
      } catch (err) {
        failure = `The Blob write failed (${err?.message || err}). Check BLOB_READ_WRITE_TOKEN / store access.`;
        console.error('feedback: blob write failed', err);
      }
    }

    if (!process.env.RESEND_API_KEY) {
      console.error('feedback: RESEND_API_KEY is not set');
      return stored
        ? res.status(200).json({ ok: true })
        : res.status(500).json({ error: 'Feedback is not configured yet — please email dev@webnomad.org.' });
    }

    const verdict = verification.verified ? 'verified buyer' : 'UNVERIFIED';
    const consentLabel = quoteOk ? 'quote OK' : 'no quote consent';
    const draftCmd = `node tools/admin/cli.mjs draft ${id} --text "…" --as "…"`;

    const notify = await sendEmail({
      from: 'WebNomad Feedback <dev@webnomad.org>',
      to: [OWNER],
      reply_to: email,
      subject: `${stored ? '' : '[NOT RECORDED] '}Planner feedback — ${verdict} — ${consentLabel}`,
      html:
        (stored ? '' : '<p style="background:#fee;padding:.8rem;border-left:3px solid #c00">'
          + '<strong>NOT RECORDED — this email is the only copy.</strong><br>' + esc(failure)
          + '<br><br>Nothing was stored, so there is no record to draft from, approve or withdraw. '
          + 'Once the above is fixed, ask them to resubmit (or paste their words into a fresh '
          + 'submission yourself) — a quote still needs their approval of the exact wording.</p>') +
        `<p><strong>${esc(name)}</strong> &lt;${esc(email)}&gt;</p>` +
        `<p><strong>Purchase:</strong> ${verification.verified
          ? `verified via ${esc(verification.method)} — ${esc(verification.product || 'unknown product')}, ${esc(verification.purchased_at || 'date unknown')}`
          : 'no purchase found for this address'}</p>` +
        `<p><strong>Consent:</strong> ${quoteOk ? 'may be quoted on the website' : 'NOT for publication'}` +
        `${record.consent.social_ok ? ' · social posts OK' : ''}` +
        `${quoteOk ? ` · as “${esc(record.consent.display_name || name)}”${record.consent.region ? `, ${esc(record.consent.region)}` : ''}` : ''}</p>` +
        `<p><strong>App build:</strong> ${record.app_build ?? 'not reported'}</p>` +
        '<hr style="border:none;border-top:1px solid #ddd;margin:1rem 0">' +
        `<p><strong>What they were working out</strong><br><span style="white-space:pre-wrap">${esc(answers.goal) || '<em>(blank)</em>'}</span></p>` +
        `<p><strong>What it showed them</strong><br><span style="white-space:pre-wrap">${esc(answers.showed) || '<em>(blank)</em>'}</span></p>` +
        `<p><strong>What frustrated them</strong><br><span style="white-space:pre-wrap">${esc(answers.friction) || '<em>(blank)</em>'}</span></p>` +
        '<hr style="border:none;border-top:1px solid #ddd;margin:1rem 0">' +
        // The draft command is offered ONLY when the record actually exists. Printing it for a
        // submission that was never stored sends you chasing an id that cannot resolve.
        (!quoteOk
          ? '<p style="color:#666">No publication consent — nothing to do beyond reading it.</p>'
          : stored
            ? `<p>To propose wording (trim only — never rewrite), open the admin page with <code>node tools/admin/cli.mjs serve</code>, or run:</p><pre style="background:#f4f4f4;padding:.7rem;white-space:pre-wrap">${esc(draftCmd)}</pre><p style="color:#666;font-size:.9rem">They still have to approve the exact wording before it can be published.</p>`
            : '<p style="color:#666">They gave permission to be quoted, but with nothing stored there is no record to draft from.</p>'),
      text:
        `${name} <${email}>\n` +
        `Purchase: ${verification.verified ? `verified (${verification.method}) — ${verification.product || 'unknown'}` : 'NOT FOUND'}\n` +
        `Consent: ${quoteOk ? 'may be quoted' : 'NOT for publication'}\n` +
        `App build: ${record.app_build ?? 'not reported'}\n` +
        `${stored ? '' : `WARNING: NOT RECORDED — this email is the only copy.\n${failure}\nThere is no record to draft from, approve or withdraw.\n`}\n` +
        `Working out:\n${answers.goal || '(blank)'}\n\nShowed them:\n${answers.showed || '(blank)'}\n\nFrustrated:\n${answers.friction || '(blank)'}\n\n` +
        (quoteOk && stored ? `Draft with:\n${draftCmd}\n` : ''),
    });

    if (!notify.ok) {
      console.error('feedback: Resend notification failed', notify.status, await notify.text());
      if (!stored) {
        return res.status(502).json({
          error: 'Could not send your feedback. Please try again, or email dev@webnomad.org directly.',
        });
      }
    }

    // Acknowledgement to the sender — best effort, never fails the request.
    try {
      await sendEmail({
        from: 'WebNomad Studio <dev@webnomad.org>',
        to: [email],
        subject: 'Thanks — we got your feedback',
        html:
          `<p>Hi ${esc(name)},</p>` +
          '<p>Thank you for taking the time — this is genuinely useful, and a real person reads every one.</p>' +
          (quoteOk
            ? '<p>You said we may quote you on the website. Nothing goes up yet: if we’d like to use something you wrote, ' +
              'we’ll email you the <strong>exact wording</strong> and the name it would carry, and it only appears if you ' +
              'click Approve. If you’d rather we didn’t, just say no — or ignore it, and nothing happens.</p>'
            : '<p>You didn’t give permission to be quoted, so nothing you wrote will appear anywhere. It’s feedback for us, nothing more.</p>') +
          '<p>You can withdraw at any time by replying to <a href="mailto:dev@webnomad.org">dev@webnomad.org</a>.</p>' +
          '<p>— WebNomad Studio<br><a href="https://airetirementincomeplanner.com">airetirementincomeplanner.com</a></p>',
        text:
          `Hi ${name},\n\nThank you for taking the time — this is genuinely useful, and a real person reads every one.\n\n` +
          (quoteOk
            ? 'You said we may quote you on the website. Nothing goes up yet: if we\'d like to use something you wrote, we\'ll email you the exact wording and the name it would carry, and it only appears if you click Approve. If you\'d rather we didn\'t, just say no — or ignore it, and nothing happens.\n\n'
            : 'You didn\'t give permission to be quoted, so nothing you wrote will appear anywhere. It\'s feedback for us, nothing more.\n\n') +
          'You can withdraw at any time by replying to dev@webnomad.org.\n\n— WebNomad Studio\nhttps://airetirementincomeplanner.com\n',
      });
    } catch (ackErr) {
      console.error('feedback: acknowledgement failed (non-fatal)', ackErr);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('feedback endpoint error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again, or email dev@webnomad.org.' });
  }
}
