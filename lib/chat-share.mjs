/* "Email me this conversation" — the signed link, and the record behind it.

   ⚠ THE EMAIL NEVER CONTAINS THE TRANSCRIPT, AND THAT IS THE WHOLE DESIGN.
   This endpoint mails an address the sender chose. If it also carried text the sender
   wrote, the site would be a harassment mailer: type abuse into the chat box, send it to
   a victim, and it arrives from a real company's domain. So the email is fixed text plus
   an unguessable, expiring link, and the content lives behind it. Somebody who receives
   one unsolicited sees a neutral message about software they have not heard of —
   irritating at worst, and nothing the sender chose.

   ⚠ THIS IS A TRANSACTIONAL SEND, NOT A SUBSCRIPTION. It must never add anyone to the
   mailing list. The newsletter is offered beside it as a separate, unticked box with its
   own double opt-in, because an implied opt-in here would be unlawful in the UK and EU —
   and this site already runs a proper double opt-in precisely because that line matters.

   ⚠ RETENTION IS SHORTER HERE. An ordinary transcript carries no identifier, which is why
   it inherits search-log's reasoning that it is not personal data. Attaching an address
   makes THAT record personal data, so it gets 30 days — matching the link's own expiry —
   rather than the 90 the rest of the log keeps.

   Env: RESEND_API_KEY, SIGNUP_TOKEN_SECRET, BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID) */

import crypto from 'node:crypto';
import { put, get } from '@vercel/blob';
import { blobConfigured, blobToken } from './blob-auth.mjs';
import { signingSecret } from './signup-guard.mjs';

export const SHARE_PREFIX = 'chat-share/';
export const LINK_TTL_DAYS = 30;

/* Same construction as the rest of the signed values in this project: base64url payload,
   HMAC, dot-joined. `k` gives domain separation, so a chat-state cookie or a form token
   can never be replayed here. */
function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function signShareToken(id, day) {
  const secret = signingSecret();
  if (!secret) return '';
  const payload = { k: 'chatshare', id, day, t: Date.now() };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** → { id, day } or null. Null covers forged, foreign-purpose and expired alike: the
 *  caller shows one message for all of them rather than telling an attacker which. */
export function verifyShareToken(token) {
  const secret = signingSecret();
  if (!secret) return null;
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(parts[1], sign(parts[0], secret))) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!p || p.k !== 'chatshare' || typeof p.t !== 'number') return null;
  if (Date.now() - p.t > LINK_TTL_DAYS * 86400_000) return null;
  if (!/^[0-9]{10,}-[0-9a-f]{8}$/.test(String(p.id))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.day))) return null;
  return { id: p.id, day: p.day };
}

/* One blob per share, and the PATH is the record of fact: if it exists, this conversation
   has already been sent. `allowOverwrite:false` makes that atomic, the same trick the
   affiliate payout ledger uses to make a double payment impossible.

   ⚠ Returns false on a repeat rather than throwing, and the caller answers identically
   either way — a different response would confirm to a prober which conversations exist. */
export async function claimShare(id, emailHashed) {
  if (!blobConfigured()) return true;
  try {
    await put(`${SHARE_PREFIX}${id}.json`, JSON.stringify({
      at: new Date().toISOString(),
      to: emailHashed,
    }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: blobToken(),
    });
    return true;
  } catch (err) {
    const msg = String(err?.message || err).toLowerCase();
    const name = String(err?.name || '').toLowerCase();
    if (msg.includes('already exist') || msg.includes('blob already') || name.includes('alreadyexists')) {
      return false;
    }
    console.error('[chat-share] claim error, allowing:', err?.message || err);
    return true;
  }
}

export async function readTranscript(id, day) {
  if (!blobConfigured()) return null;
  for (const prefix of ['chat-log/', 'chat-hold/']) {
    try {
      const r = await get(`${prefix}${day}/${id}.json`, {
        access: 'private',
        token: blobToken(),
      });
      if (r && r.statusCode === 200 && r.stream) {
        return JSON.parse(await new Response(r.stream).text());
      }
    } catch {
      /* keep looking — a held transcript lives under a different prefix, and a miss on
         the first is the normal case, not an error */
    }
  }
  return null;
}

/** The mail body. ⚠ Fixed text only — see the header. The one variable is the link. */
export function shareEmail(link) {
  const html = `<p>Here is the conversation you asked for on the AI Retirement Income Planner website:</p>
<p><a href="${link}">View the conversation</a></p>
<p style="color:#555;font-size:14px">The link works for ${LINK_TTL_DAYS} days. If you did not ask for
this, you can ignore it &mdash; nothing has been signed up or subscribed, and we have not kept your
address for anything else.</p>
<p style="color:#555;font-size:14px">The assistant gives educational information about the software.
It is not financial, tax or legal advice.</p>`;
  const text = `Here is the conversation you asked for on the AI Retirement Income Planner website:

${link}

The link works for ${LINK_TTL_DAYS} days. If you did not ask for this, you can ignore it - nothing
has been signed up or subscribed, and we have not kept your address for anything else.

The assistant gives educational information about the software. It is not financial, tax or legal
advice.`;
  return { html, text };
}
