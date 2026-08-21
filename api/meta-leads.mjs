/* Meta Lead Ads webhook — GET/POST /api/meta-leads

   Meta's Lead Ads show the signup form INSIDE Facebook or Instagram. The person never
   reaches this website, so none of the normal capture path runs: no /api/newsletter call,
   no thank-you page, no browser pixel. Without this endpoint those leads simply sit in the
   Meta UI waiting to be downloaded as a CSV by hand.

   Two jobs:
     GET  — answer Meta's subscription challenge so the webhook can be verified at all.
     POST — on each `leadgen` notification, fetch the submitted field values from the Graph
            API (the webhook itself carries only ids) and upsert the person into the right
            MailerLite group, so they get the same automated download as a website signup.

   The magnet is chosen from the lead form's own name: name a form "…checklist…" in Meta and
   it delivers the checklist. That keeps the mapping in the place the campaign is built,
   rather than needing a code change per form.

   Env (Vercel project settings):
     META_LEADGEN_VERIFY_TOKEN — arbitrary shared secret, also typed into the Meta webhook UI
     META_PAGE_ACCESS_TOKEN    — Page token with leads_retrieval, to read the lead
     META_APP_SECRET           — app secret, to verify X-Hub-Signature-256
     MAILERLITE_API_KEY        — already set
     MAILERLITE_GROUP_ID*      — already set; the shared map lives in lib/magnets.mjs

   ⚠ Classic Node (req, res) signature. The web-standard handler(request) form crashes this
   project's runtime with FUNCTION_INVOCATION_FAILED — the same lesson as download.mjs.
   ⚠ Body parsing is disabled because the signature is over the RAW bytes; letting Vercel
   parse and re-serialise the JSON changes them and every verification fails. */

import crypto from 'node:crypto';
import { screenSignup, signingSecret, emailHash } from '../lib/signup-guard.mjs';
import { logEvent } from '../lib/signup-quarantine.mjs';
import { magnetGroupId } from '../lib/magnets.mjs';

export const config = { api: { bodyParser: false } };

const GRAPH = 'https://graph.facebook.com/v21.0';

/* Which download a lead form delivers, matched against the form's name (lowercased).
   First match wins, so order matters. Falls through to the eBook. */
const FORM_NAME_MAGNETS = [
  ['checklist', 'checklist'],
  ['question', 'questions'],
  ['abroad', 'abroad'],
  ['cross-border', 'abroad'],
  ['expat', 'abroad'],
  ['ebook', 'ebook'],
  ['book', 'ebook'],
];
function magnetForForm(formName) {
  const n = String(formName || '').toLowerCase();
  for (const [needle, magnet] of FORM_NAME_MAGNETS) {
    if (n.includes(needle)) return magnet;
  }
  return 'ebook';
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/* Verify Meta's X-Hub-Signature-256: "sha256=<hex hmac of the raw body>".
   Without this anyone who learns the URL could inject arbitrary addresses into the list. */
function verifyMetaSignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const [algo, sig] = String(header).split('=');
  if (algo !== 'sha256' || !sig) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The webhook carries only a leadgen_id; the answers live behind the Graph API.
async function fetchLead(leadgenId, pageToken) {
  const url = `${GRAPH}/${leadgenId}?access_token=${encodeURIComponent(pageToken)}`;
  const r = await fetch(url);
  if (!r.ok) {
    console.error('meta-leads: lead fetch failed', r.status, await r.text());
    return null;
  }
  return r.json();
}

function fieldsToObject(lead) {
  const out = {};
  for (const f of lead?.field_data || []) {
    out[String(f.name || '').toLowerCase()] = (f.values || [])[0] || '';
  }
  return out;
}

/* Screen a Lead Ads address with the same rules the website form uses, then subscribe.

   ⚠ THIS PATH IS NOT DOUBLE OPT-IN, AND SHOULD NOT BE.
   The person filled in a form inside Facebook, where Meta had already confirmed the address
   as theirs and pre-filled it from their account. Emailing them a confirmation link would be
   asking them to prove something Meta has already proved, and the drop-off would be paid-for
   leads thrown away. What DOES apply is everything free: canonicalisation (so the dotted
   Gmail trick cannot mint duplicate leads here either), the disposable-domain list, the
   non-human-address check and the MX lookup.

   The form token is skipped for the same reason it exists — there is no form of ours here.

   Without this, the whole guard on api/newsletter.mjs would just move the problem: anyone
   who can reach a lead form writes straight into the list through the back door. */
async function screenAndAdd(rawEmail, rawName, magnet) {
  const secret = signingSecret();

  const screened = await screenSignup({
    honeypot: '',
    email: rawEmail,
    name: rawName,
    checkToken: false,
    secret,
  });

  if (!screened.ok) {
    console.warn(`meta-leads: rejected lead (${screened.reason})`);
    await logEvent({
      event: 'blocked',
      reason: screened.reason,
      email: rawEmail,
      domain: screened.domain || '',
      magnet,
      note: 'facebook-lead-ads',
    });
    return false;
  }

  const email = screened.email;              // canonical, not what Meta sent
  const firstName = screened.firstName;

  const apiKey = process.env.MAILERLITE_API_KEY;
  const groupId = magnetGroupId(magnet);
  if (!apiKey || !groupId) {
    console.error('meta-leads: MailerLite not configured — lead dropped');
    return false;
  }
  const r = await fetch('https://connect.mailerlite.com/api/subscribers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      fields: firstName ? { name: firstName } : {},
      groups: [groupId],
      status: 'active',
    }),
  });
  if (r.status !== 200 && r.status !== 201) {
    console.error('meta-leads: MailerLite rejected', r.status, await r.text());
    return false;
  }

  /* ⚠ No requestMeta() here, deliberately. This handler is called by FACEBOOK, not by the
     person — the IP and user agent on this request belong to Meta's webhook infrastructure.
     Recording them would fill the log with a fingerprint of Facebook while looking exactly
     like a fingerprint of the subscriber, which is worse than the blank the v3 fields leave. */
  await logEvent({
    event: 'confirmed',
    email,
    domain: screened.domain,
    magnet,
    hash: emailHash(email, secret),
    note: 'facebook-lead-ads',
  });
  return true;
}

export default async function handler(req, res) {
  /* Subscription handshake. Meta calls this once when the webhook is added, and will not
     deliver anything until it echoes hub.challenge back verbatim. */
  if (req.method === 'GET') {
    const q = req.query || {};
    const token = process.env.META_LEADGEN_VERIFY_TOKEN;
    if (q['hub.mode'] === 'subscribe' && token && q['hub.verify_token'] === token) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(String(q['hub.challenge'] ?? ''));
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('meta-leads: could not read body', err);
    return res.status(400).json({ error: 'Bad request' });
  }

  const appSecret = process.env.META_APP_SECRET;
  const pageToken = process.env.META_PAGE_ACCESS_TOKEN;
  if (!appSecret || !pageToken) {
    /* Deployed before the Meta side exists. Return 200 deliberately: a non-2xx makes Meta
       retry and eventually disable the subscription, and there is nothing to retry into. */
    console.warn('meta-leads: not configured yet — acknowledging without processing');
    return res.status(200).json({ received: true, skipped: 'unconfigured' });
  }

  if (!verifyMetaSignature(rawBody, req.headers['x-hub-signature-256'], appSecret)) {
    console.warn('meta-leads: invalid signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  /* Acknowledge before doing the slow work? No — Vercel may freeze the function the moment
     the response is sent, so anything still in flight would be lost. Meta's timeout is
     generous enough for a handful of leads, and a genuine failure SHOULD be retried. */
  let handled = 0;
  try {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;
        const v = change.value || {};
        const lead = await fetchLead(v.leadgen_id, pageToken);
        if (!lead) continue;

        const fields = fieldsToObject(lead);
        const email = (fields.email || fields.email_address || '').trim();
        if (!email) {
          console.warn('meta-leads: lead has no email field', v.leadgen_id);
          continue;
        }
        const leadName = (fields.first_name || fields.full_name || '').trim();
        const magnet = magnetForForm(lead.form_name || v.form_name);

        if (await screenAndAdd(email, leadName, magnet)) handled += 1;
      }
    }
  } catch (err) {
    console.error('meta-leads: processing error', err);
    // 500 so Meta retries rather than silently losing the lead.
    return res.status(500).json({ error: 'Processing failed' });
  }

  return res.status(200).json({ received: true, handled });
}
