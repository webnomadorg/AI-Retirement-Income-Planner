/* Testimonial approval — /api/feedback-approve?id=<uuid>&t=<token>

   GET  → shows the exact wording we propose to publish, and the name it would carry.
          RECORDS NOTHING.
   POST → records the buyer's decision (approved | declined) and tells the owner.

   ⚠ The GET/POST split is the whole point, not ceremony. Corporate mail scanners and link
   previewers follow every URL in an inbound email automatically. If approval were a GET,
   a spam filter would forge the single most important artifact in the chain — a customer's
   consent to publish their words. So: GET shows, POST decides.

   The consent given on share.html ("you may quote me") is NOT this consent. That one was
   given before they knew which sentence of three paragraphs we would pull out, or how we
   would trim it. This is the approval of the specific wording. See
   Plans/Testimonials-Pipeline.md.

   Silence is a no: a record whose approval was never decided can never be published, and
   nobody is chased.

   Env: UPDATE_LOOKUP_PEPPER, BLOB_READ_WRITE_TOKEN, RESEND_API_KEY

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form
   crashes this project's runtime with FUNCTION_INVOCATION_FAILED. */

import { readFeedback, patchFeedback, verifyApprovalToken, isValidId } from '../lib/feedback-log.mjs';

const OWNER = 'dev@webnomad.org';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Same inline theme bootstrap every page carries, so this page honours the visitor's saved
   dark-mode choice before first paint (Website/tools/page_build.py → THEME_BOOTSTRAP). */
const THEME_BOOTSTRAP =
  "<script>!function(){var e=document.documentElement," +
  "t=localStorage.getItem('wn-theme'),d='1'===localStorage.getItem('wn-dark');" +
  "t&&e.setAttribute('data-theme',t);d&&e.classList.add('dark')}();</script>";

function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — AI Retirement Income Planner</title>
${THEME_BOOTSTRAP}
<link rel="stylesheet" href="/assets/css/styles.css">
<style>
  .ap-wrap{max-width:44rem;margin:0 auto;padding:3rem 1.2rem 4rem}
  .ap-quote{font-family:var(--font-display);font-size:1.35rem;line-height:1.5;
    border-left:3px solid var(--teal);padding:.2rem 0 .2rem 1.1rem;margin:0 0 .6rem}
  .ap-attrib{color:var(--ink-soft);margin:0 0 1.6rem}
  .ap-actions{display:flex;gap:.8rem;flex-wrap:wrap;margin:1.6rem 0 0}
  .ap-note{font-size:.9rem;color:var(--ink-soft);margin-top:1.6rem}
</style>
</head><body><main class="ap-wrap">${bodyHtml}</main></body></html>`;
}

function send(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(status).send(html);
}

const invalidPage = () =>
  page('Link not valid', `
    <h1>This link isn’t valid</h1>
    <p>It may have been mistyped, or it may belong to a request that has since been withdrawn.</p>
    <p>If you were expecting to approve a quote, just reply to the email we sent, or contact
    <a href="mailto:${OWNER}">${OWNER}</a> and we’ll sort it out.</p>`);

async function notifyOwner(record, decision) {
  if (!process.env.RESEND_API_KEY) return;
  const who = record.consent?.display_name || record.name || 'A customer';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'WebNomad Feedback <dev@webnomad.org>',
        to: [OWNER],
        subject: `Testimonial ${decision} — ${who}`,
        html:
          `<p><strong>${esc(who)}</strong> ${decision === 'approved' ? 'approved' : 'declined'} the wording:</p>` +
          `<blockquote style="border-left:3px solid #1B7165;margin:1em 0;padding:.5em 1em;color:#555">${esc(record.published_text || '')}</blockquote>` +
          (decision === 'approved'
            ? '<p>It is now <strong>publishable</strong> — but it is not live. Run <code>node tools/testimonials/cli.mjs publish</code> (or the admin page) once you have three approved quotes.</p>'
            : '<p>Nothing will be published. No follow-up needed.</p>') +
          `<p style="color:#888;font-size:.85rem">Record ${esc(record.id)}</p>`,
        text:
          `${who} ${decision} the wording:\n\n"${record.published_text || ''}"\n\n` +
          (decision === 'approved'
            ? 'It is now publishable but NOT live. Run: node tools/testimonials/cli.mjs publish (needs 3 approved).\n'
            : 'Nothing will be published.\n') +
          `\nRecord ${record.id}\n`,
      }),
    });
  } catch (err) {
    console.error('feedback-approve: owner notification failed (non-fatal)', err);
  }
}

export default async function handler(req, res) {
  try {
    const isPost = req.method === 'POST';
    if (!isPost && req.method !== 'GET') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // GET carries id/t in the query; the POST form re-submits them in the body.
    let body = {};
    if (isPost) {
      try { body = req.body || {}; } catch { body = {}; }
      if (typeof body === 'string') {
        body = Object.fromEntries(new URLSearchParams(body));
      }
    }
    const id = String((isPost ? body.id : req.query?.id) || '');
    const token = String((isPost ? body.t : req.query?.t) || '');

    // Never leak whether an id exists — an invalid token and a missing record look identical.
    if (!isValidId(id) || !verifyApprovalToken(id, token)) return send(res, 404, invalidPage());

    const record = await readFeedback(id);
    if (!record || record.withdrawal?.removed_at) return send(res, 404, invalidPage());

    if (!record.published_text) {
      return send(res, 409, page('Nothing to approve yet', `
        <h1>Nothing to approve yet</h1>
        <p>We haven’t proposed any wording for this one. If you’ve had an email suggesting otherwise,
        please let us know at <a href="mailto:${OWNER}">${OWNER}</a>.</p>`));
    }

    const quoteBlock =
      `<blockquote class="ap-quote">${esc(record.published_text)}</blockquote>` +
      `<p class="ap-attrib">— ${esc(record.attribution_text || record.consent?.display_name || record.name)}</p>`;

    // Already decided — show the outcome rather than letting it be changed by a stale link.
    if (record.approval?.decision) {
      const was = record.approval.decision === 'approved';
      return send(res, 200, page(was ? 'Already approved' : 'Already declined', `
        <h1>${was ? 'You’ve already approved this' : 'You’ve already declined this'}</h1>
        ${quoteBlock}
        <p>${was
          ? 'Thank you — nothing more is needed from you.'
          : 'It will not be published anywhere.'}</p>
        <p class="ap-note">Changed your mind? Email <a href="mailto:${OWNER}">${OWNER}</a> and we’ll
        update it — including removing something already published.</p>`));
    }

    if (isPost) {
      const decision = body.decision === 'approved' ? 'approved' : 'declined';
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

      const updated = await patchFeedback(id, {
        status: decision,
        approval: {
          ...(record.approval || {}),
          decided_at: new Date().toISOString(),
          decision,
          ip,
        },
      });
      if (!updated) return send(res, 500, page('Something went wrong', `
        <h1>Something went wrong</h1>
        <p>We couldn’t record your answer. Please email <a href="mailto:${OWNER}">${OWNER}</a> and
        we’ll do it by hand.</p>`));

      await notifyOwner(updated, decision);

      return send(res, 200, page(decision === 'approved' ? 'Approved — thank you' : 'Not published', `
        <h1>${decision === 'approved' ? 'Approved — thank you' : 'Understood — nothing will be published'}</h1>
        ${quoteBlock}
        <p>${decision === 'approved'
          ? 'We’ve recorded your approval. This may now appear on the website alongside a small number of others.'
          : 'Your words will not appear on the website. No hard feelings, and thank you for the feedback all the same.'}</p>
        <p class="ap-note">You can change your mind at any time — email <a href="mailto:${OWNER}">${OWNER}</a>.</p>`));
    }

    // GET — show it, record nothing.
    return send(res, 200, page('Approve this quote?', `
      <h1>May we publish this?</h1>
      <p>You told us we could quote you. This is the <strong>exact wording</strong> we’d like to use —
      your words, shortened, with nothing added. It would appear on the front page of
      airetirementincomeplanner.com.</p>
      ${quoteBlock}
      <form method="POST" action="/api/feedback-approve">
        <input type="hidden" name="id" value="${esc(id)}">
        <input type="hidden" name="t" value="${esc(token)}">
        <div class="ap-actions">
          <button class="btn btn-primary" type="submit" name="decision" value="approved">Yes, publish this</button>
          <button class="btn btn-secondary" type="submit" name="decision" value="declined">No, don’t publish</button>
        </div>
      </form>
      <p class="ap-note">Nothing has been recorded yet — neither button is pressed by opening this page.
      If the wording isn’t right, reply to our email and we’ll change it and ask again. Ignoring this is
      also a perfectly good answer: without your approval, nothing is published.</p>`));
  } catch (err) {
    console.error('feedback-approve endpoint error:', err);
    return send(res, 500, page('Something went wrong', `
      <h1>Something went wrong</h1>
      <p>Please try again in a minute, or email <a href="mailto:${OWNER}">${OWNER}</a>.</p>`));
  }
}
