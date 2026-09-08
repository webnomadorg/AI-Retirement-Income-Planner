/* Site AI assistant — GET /api/chat issues state, POST /api/chat answers a question.

   GET  → { enabled, showsHere, remaining, disclaimer, token, mac }  and a state cookie.
          Also hands out the anti-bot form token, the same GET-issues-token convention
          api/newsletter.mjs and api/contact.mjs already use.
   POST → NDJSON stream: {"t":"…"} text chunks, then one {"done":true,…} line.

   ⚠ THE KEY NEVER LEAVES THIS PROCESS. ANTHROPIC_API_KEY is a Vercel environment
   variable, exactly like STRIPE_VERIFY_KEY. It is not in assets/js/chat.js, not in any
   page, not in the repo, and there is no path by which a browser can obtain it.

   ⚠ THE OFF SWITCH IS READ HERE, BEFORE ANY MODEL CALL. `enabled:false` in the config
   stops all spend immediately and cannot be bypassed by a cached chat.js, a stale CDN
   copy, or a visitor who left a tab open. The widget hiding itself is cosmetic catch-up.

   ⚠ WHEN A CEILING TRIPS THE ASSISTANT GOES SILENT, NOT APOLOGETIC. Visitors are told
   nothing and the widget simply does not appear. A "daily limit reached" message would
   tell a prospective customer the vendor ran out of money, and would confirm to anyone
   probing that burning the budget is how you switch the thing off.

   NOTE: classic Node (req, res) signature — the web-standard handler(request) form
   crashes this project's runtime with FUNCTION_INVOCATION_FAILED. Same constraint as
   api/download.mjs, api/sale.mjs and api/latest-version.mjs.

   Env: ANTHROPIC_API_KEY, SIGNUP_TOKEN_SECRET, BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID) */

import Anthropic from '@anthropic-ai/sdk';
import { issueFormToken, verifyFormToken, signingSecret } from '../lib/signup-guard.mjs';
import { requestMeta } from '../lib/signup-quarantine.mjs';
import { readConfig, pauseForSpend, showsOn } from '../lib/chat-config.mjs';
import { readState as readSaleState, resolveActive, publicView } from '../lib/sale-state.mjs';
import {
  readState, stateCookie, signHistory, verifyHistory, ipHash,
  recordSpend, noteLocalSpend, spendStatus, ipGroup, claimConversation,
} from '../lib/chat-quota.mjs';
import {
  writeTranscript, newConversationId, dayOfConversation, scrubMessage, maybeRollover,
} from '../lib/chat-log.mjs';
import {
  retrieve, buildSystem, isContentGap, pickQa, MAX_QUESTION_CHARS, corpusReady,
} from '../lib/chat-context.mjs';

export const DISCLAIMER = 'Educational information about the planner — not financial advice.';

/* Per million tokens, in USD. ⚠ Used only to enforce the owner's ceiling and to report
   spend in the console; the real bill is Anthropic's. Cached reads are a tenth of input
   and cache WRITES are 1.25x, which is why they are counted separately — conflating them
   would understate a cold conversation and overstate a warm one. */
const PRICES = {
  'claude-sonnet-5': { in: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 },
  'claude-haiku-4-5': { in: 1, cacheWrite: 1.25, cacheRead: 0.1, out: 5 },
};
const FALLBACK_PRICE = PRICES['claude-sonnet-5'];

/* ⚠ THIS NUMBER IS THE SECOND BIGGEST COST LEVER, AFTER max_tokens.

   The API is stateless, so the ENTIRE history is re-sent and re-billed on every turn, and
   none of it is cached — only the fixed system block is. History therefore grows the cost
   of each message linearly: measured over a ten-message conversation at 24 turns, message
   one cost about $0.007 and message ten about $0.030.

   Ten turns is five exchanges, which is ample for a bounded FAQ conversation — nobody
   needs the model to recall the first question of a ten-question chat verbatim — and it
   caps what the last message can carry instead of letting it grow to the visitor's limit. */
const MAX_TURNS = 10;
const MIN_GAP_MS = 900;             // a reply arriving faster than this is not someone reading

/* A per-instance speed bump, the same shape as api/search-log.mjs and api/feedback.mjs.
   ⚠ Serverless instances are ephemeral and there may be several at once, so this is NOT a
   wall — it is the cheapest possible first line, costing one Map lookup before any blob
   read or model call. The cross-instance limit is the Vercel WAF rule; the wall is the
   spend ceiling. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
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

function priceOf(model) {
  return PRICES[model] || FALLBACK_PRICE;
}

function costOf(model, usage) {
  const p = priceOf(model);
  const u = usage || {};
  return (
    ((u.input_tokens || 0) * p.in
      + (u.cache_creation_input_tokens || 0) * p.cacheWrite
      + (u.cache_read_input_tokens || 0) * p.cacheRead
      + (u.output_tokens || 0) * p.out) / 1_000_000
  );
}

/* Same-origin only. Unlike the planner's endpoints this is never called from file://, so
   there is no CORS header to send and a cross-site caller has no business here. */
function sameOrigin(req) {
  const h = req.headers || {};
  const site = String(h['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = String(h.origin || '');
  if (!origin) return true;                     // no Origin on a same-origin GET
  try {
    return new URL(origin).host === String(h.host || '');
  } catch {
    return false;
  }
}

function readBody(req) {
  // req.body is a lazy getter that THROWS when the platform cannot parse the declared
  // Content-Type, so read it defensively rather than letting it 500.
  let body;
  try { body = req.body; } catch { body = null; }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  return body && typeof body === 'object' ? body : {};
}

/* The live promotion, in words the model can quote. Returns null when none is running,
   which the prompt turns into "you do not have prices, send them to the products page" —
   the safe default, because prices change with no deploy. */
async function currentSale() {
  try {
    const state = await readSaleState();
    const active = resolveActive(state);
    if (!active) return null;
    const v = publicView(active);
    return {
      active: true,
      summary: `${v.title} — ${v.percent}% off, ending ${String(v.endsAt).slice(0, 10)}. `
        + 'Exact per-product prices are on the products page.',
    };
  } catch (err) {
    console.error('[chat] sale lookup failed:', err?.message || err);
    return null;                     // fail closed: no prices rather than stale ones
  }
}

/** The quiet refusal. Never explains itself to the visitor — see the header note. */
function silent(res, cookie) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  return res.status(200).json({ enabled: false });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });

  const secret = signingSecret();
  const cfg = await readConfig().catch(() => null);
  const state = readState(req);

  /* ---- GET: what the widget needs to decide whether to exist at all ---------------- */
  if (req.method === 'GET') {
    const path = String((req.query && req.query.path) || '/');
    const preview = String((req.query && req.query.preview) || '') === '1';
    const live = Boolean(cfg && cfg.enabled && secret && process.env.ANTHROPIC_API_KEY);
    const cookie = stateCookie(state);
    if (cookie) res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({
      enabled: live,
      showsHere: live && showsOn(cfg, path, preview),
      remaining: Math.max(0, (cfg?.maxMessagesPerVisitor ?? 10) - state.n),
      disclaimer: DISCLAIMER,
      token: secret ? issueFormToken(secret) : '',
      mac: '',
    });
  }

  /* ---- POST: answer one question --------------------------------------------------- */
  if (!cfg || !cfg.enabled) return silent(res);
  if (!secret) {
    console.error('[chat] SIGNUP_TOKEN_SECRET is not set — refusing rather than running unsigned');
    return silent(res);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[chat] ANTHROPIC_API_KEY is not set');
    return silent(res);
  }

  /* Before anything that costs: no blob read, no model call, one Map lookup. */
  const early = requestMeta(req);
  if (rateLimited(ipGroup(early.ip))) return silent(res);

  const body = readBody(req);

  // Honeypot: hidden from real users, filled by bots. Same `_honey` convention as the
  // contact and newsletter forms.
  if (String(body._honey || '')) return silent(res);

  const tok = verifyFormToken(body.token, secret);
  if (tok.state !== 'ok') return silent(res);

  /* ⚠ Test mode is enforced on the ENDPOINT too, not just in the widget. Otherwise anyone
     who found the URL could POST to it while the assistant was supposedly hidden. */
  if (cfg.previewOnly && body.preview !== true) return silent(res);

  const question = String(body.q || '').trim();
  if (!question) return silent(res);
  /* ⚠ THE INPUT CAP IS THE ONE REAL COST-AMPLIFICATION VECTOR. The message cap bounds
     ordinary use, but nothing in it stops a 50,000-word paste: that alone is roughly ten
     cents of input, and ten of them is a day's budget from one visitor who tripped no
     other check. Rejected here as well as client-side, because client-side is advice. */
  if (question.length > MAX_QUESTION_CHARS) return silent(res);

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_TURNS) : [];
  if (!verifyHistory(state.sid, history, String(body.mac || ''))) {
    console.error('[chat] history signature mismatch — refusing a possibly forged transcript');
    return silent(res);
  }

  // Cadence: a follow-up faster than a person could have read the last answer.
  const since = Number(body.since || 0);
  if (Number.isFinite(since) && since > 0 && since < MIN_GAP_MS) return silent(res);

  const maxMessages = cfg.maxMessagesPerVisitor ?? 10;
  if (state.n >= maxMessages) {
    const cookie = stateCookie(state);
    if (cookie) res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({ limit: true, remaining: 0 });
  }

  /* ⚠ Only on the FIRST message of a conversation. After that the signed cookie governs and
     it is exact, so there is nothing for the address check to add — and doing it per message
     was what made two people behind one address collide. See claimConversation(). */
  if (state.n === 0 && !(await claimConversation(ipHash(early.ip), state.sid))) {
    // Same shape as hitting the personal cap: the widget offers the hand-off, not an error.
    return res.status(200).json({ limit: true, remaining: 0 });
  }

  /* ---- the wall ------------------------------------------------------------------- */
  const spend = await spendStatus();
  /* ⚠ FAIL CLOSED WHEN THE TOTAL CANNOT BE READ. spendStatus() reports `unknown` when the
     blob listing failed and it has no cached figure to fall back on -- and it reports
     dayUsd:0 alongside it, because there is no honest number to give. Treating that as
     "nothing spent yet" is precisely how a storage outage turns into an unbounded bill:
     every instance would read zero and keep going. This is the only layer that is supposed
     to be a wall, so when it cannot see, it stops. */
  if (spend.unknown) {
    console.error('[chat] spend total unreadable — refusing rather than spending blind');
    return silent(res);
  }
  const overDay = cfg.dailyCeilingUsd > 0 && spend.dayUsd >= cfg.dailyCeilingUsd;
  const overHour = cfg.hourlyCeilingUsd > 0 && spend.hourUsd >= cfg.hourlyCeilingUsd;
  if (overDay || overHour) {
    const reason = overHour
      ? `hourly ceiling of $${cfg.hourlyCeilingUsd} reached`
      : `daily ceiling of $${cfg.dailyCeilingUsd} reached`;
    /* Switches itself off and STAYS off until the owner presses Resume. Auto-resuming at
       midnight would let an attack or a runaway bug consume the full ceiling every day
       before anyone noticed. */
    await pauseForSpend(reason, {
      dayUsd: Number(spend.dayUsd.toFixed(4)),
      hourUsd: Number(spend.hourUsd.toFixed(4)),
    }).catch((e) => console.error('[chat] pause failed:', e?.message || e));
    console.error('[chat] PAUSED —', reason);
    return silent(res);
  }

  /* ---- retrieve, then answer ------------------------------------------------------ */
  if (!corpusReady()) {
    // Degrade rather than 500: the prompt still carries the product summary.
    console.error('[chat] corpus unavailable — answering from the summary alone');
  }
  const hits = retrieve(question, 8);
  const gap = isContentGap(question, hits);
  const model = cfg.model || 'claude-sonnet-5';
  /* ⚠ READ SERVER-SIDE, NEVER FROM THE REQUEST BODY. Whatever is put in front of the model
     here is what it will quote as the price, so a client-supplied figure would let any
     visitor make the assistant announce a discount that does not exist. Same source the
     sale banner uses, so the two can never disagree. */
  const sale = await currentSale();
  const [staticText, volatileText] = buildSystem({
    hits,
    sale,                           // volatile by nature — kept out of the cached block
    houseNotes: cfg.houseNotes,
    qa: pickQa(question, cfg.qa),   // the owner's own wording, when any of it fits
  });

  const messages = [...history, { role: 'user', content: question }];
  const client = new Anthropic({ apiKey });

  /* ⚠ HEADERS GO OUT WITH THE FIRST BODY BYTE, NOT AFTER IT.

     This is where the assistant broke on its first real conversation. The Set-Cookie
     carrying the visitor's message count used to be set AFTER the reply had been streamed
     — but res.write() flushes the headers, so setHeader() then threw, and the throw landed
     after the last text chunk and before the closing {done} line. The visitor saw a
     complete answer and nothing looked wrong. Underneath, two things had failed silently:
     the count never incremented, and no conversation signature was issued. The next
     question therefore arrived with history but no signature, was refused as a possible
     forgery, and the panel went away.

     So the head is written lazily, at the first line of output. By then the model has
     produced a token, which is the proof that the turn is real and worth counting.

     ⚠ The error path calls headOnly() instead, which sends the same head WITHOUT the
     cookie — a turn the model never answered must not spend one of the visitor's ten. */
  const next = { ...state, n: state.n + 1 };
  let headSent = false;

  function sendHead(withCookie) {
    if (headSent) return;
    headSent = true;
    const h = {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (withCookie) {
      const cookie = stateCookie(next);
      if (cookie) h['Set-Cookie'] = cookie;
    }
    res.writeHead(200, h);
  }

  const line = (o) => { sendHead(true); res.write(JSON.stringify(o) + '\n'); };
  const headOnly = () => sendHead(false);

  let answer = '';
  let usage = null;
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 1000,
      /* Off for this route: it is a short grounded FAQ answer with no tools, so there is
         nothing for thinking to do except add latency and cost to every reply. */
      thinking: { type: 'disabled' },
      system: [
        /* ⚠ ORDER IS LOAD-BEARING. The breakpoint goes on the stable block ONLY. Anything
           volatile above it invalidates the cache on every single turn — no error, just a
           bill that never drops. Verify with usage.cache_read_input_tokens. */
        { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: volatileText },
      ],
      messages,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        answer += event.delta.text;
        line({ t: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    usage = final.usage || null;
  } catch (err) {
    console.error('[chat] model call failed:', err?.message || err);
    /* ⚠ The turn is NOT counted. A 429, an overload or a timeout must not burn one of the
       visitor's ten messages — otherwise a bad hour at the API silently exhausts people
       who never got an answer. Ends by saying what still works, the _aiFriendlyError()
       convention from the planner. */
    headOnly();
    res.write(JSON.stringify({ error: 'I could not reach the assistant just then. '
      + 'The pages themselves have the same information, and the contact page will '
      + 'always reach a person.' }) + String.fromCharCode(10));
    return res.end();
  }

  /* ---- account for it ------------------------------------------------------------- */
  const usd = costOf(model, usage);
  noteLocalSpend(usd);
  /* The cookie already went out with the head, above - it cannot be set here. */

  const nextHistory = [...messages, { role: 'assistant', content: answer }].slice(-MAX_TURNS);
  const remaining = Math.max(0, maxMessages - next.n);
  line({
    done: true,
    remaining,
    mac: signHistory(next.sid, nextHistory),
    limit: remaining === 0,
  });
  res.end();

  /* Everything below is bookkeeping and happens after the visitor has their answer. */
  const scrubbedQ = scrubMessage(question);
  const convoId = String(body.cid || '').match(/^[0-9]{10,}-[0-9a-f]{8}$/)
    ? body.cid
    : newConversationId();
  await Promise.allSettled([
    recordSpend(usd),
    writeTranscript({
      id: convoId,
      // Derived from the id, so a conversation crossing midnight UTC still files in one place.
      day: dayOfConversation(convoId),
      startedAt: body.startedAt || new Date().toISOString(),
      model,
      turns: [
        ...(Array.isArray(body.priorTurns) ? body.priorTurns.slice(-20) : []),
        {
          at: new Date().toISOString(),
          q: scrubbedQ.text,
          a: scrubMessage(answer).text,
          gap,
          scrubbed: scrubbedQ.scrubbed,
          usd: Number(usd.toFixed(5)),
          usage: usage
            ? {
              in: usage.input_tokens || 0,
              cacheW: usage.cache_creation_input_tokens || 0,
              cacheR: usage.cache_read_input_tokens || 0,
              out: usage.output_tokens || 0,
            }
            : null,
        },
      ],
      totals: {
        messages: next.n,
        inTokens: usage?.input_tokens || 0,
        cachedTokens: usage?.cache_read_input_tokens || 0,
        outTokens: usage?.output_tokens || 0,
        usd: Number(usd.toFixed(5)),
      },
      flags: { hitLimit: remaining === 0, deflected: /\[\[demo\]\]/.test(answer) },
    }),
    maybeRollover(),
  ]);
}
