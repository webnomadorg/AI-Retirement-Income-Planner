/* Site assistant — what was asked, what it answered, what it cost, and when that is deleted.

   Written by the website (api/chat.mjs), read by the owner console. That is the same
   arrangement as lib/search-log.mjs, and the console has no module of its own for either.

   WHAT IS STORED
   Both sides of the conversation, scrubbed (see scrubMessage), plus tokens and cost per
   turn. No IP, no user agent, no cookie value, no address — nothing that ties a transcript
   to a person or two transcripts to each other beyond the conversation itself. That is
   what lets these inherit lib/search-log.mjs's reasoning that they are not personal data.
   ⚠ Attaching an address to one — which "email me this conversation" does — changes that
   for THAT record. It gets its own shorter retention; see lib/chat-share.mjs.

   RETENTION: text expires, numbers do not.
     chat-log/<YYYY-MM-DD>/…     transcripts,  90 days  (the house standard, and the same
                                 window privacy.html already promises for abuse records)
     chat-hold/<YYYY-MM-DD>/…    flagged for a dispute — NEVER pruned, released by hand
     chat-rollup/<YYYY-MM>.json  counts, tokens, cost, top questions — kept indefinitely

   ⚠ Pruning cannot wait for the owner to open the console; it might not be opened for
   weeks, and a stated retention that is not enforced is worse than none. Vercel Blob has
   no lifecycle policy, so deletion is an explicit act — triggered here on the first write
   of each new day and claimed atomically so it runs exactly once.

   ⚠ IF A LOCAL CACHE IS EVER ADDED HERE FOR SPEED, EXCLUDE IT FROM tools/backup.ps1.
   The Signups tab grew exactly such a cache when reads got slow, and `.signup-cache` had
   to be added to $ProjectExcludeDirs because the backup is additive and never deletes:
   records copied to the drive would outlive this prune and quietly make the retention
   promise false. Nothing to do today — transcripts live only in Blob.

   Env: BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID under OIDC) */

import crypto from 'node:crypto';
import { put, get, del } from '@vercel/blob';
import { listAll } from './blob-list.mjs';
import { blobConfigured, blobToken } from './blob-auth.mjs';

export const LOG_PREFIX = 'chat-log/';
export const HOLD_PREFIX = 'chat-hold/';
export const ROLLUP_PREFIX = 'chat-rollup/';
const CLAIM_PREFIX = 'chat-maint/';

export const RETAIN_DAYS = 90;
/* Shorter, and deliberately so: a share record ties a conversation to an email address,
   which makes THAT record personal data even though the transcript beside it is not. */
export const SHARE_RETAIN_DAYS = 30;
export const MAX_MESSAGE_CHARS = 4000;   // a stored turn; the INPUT cap is much smaller

export function isConfigured() {
  return blobConfigured();
}

/* A chat box is a free-text field, and people paste things into free-text fields — far
   more readily than into a search box, because it feels like talking to someone. An
   address or a long digit run (a card, a phone, an SSN) is the way a transcript could
   carry personal data despite the notice above the composer telling people not to.

   Same rule as lib/search-log.mjs scrubbable(), applied per MESSAGE rather than per
   record: dropping the whole conversation would lose the useful part, and redacting
   inside the string would leave the rest of a sentence that was clearly about something
   private. Replacing the turn keeps the shape of the conversation legible without
   keeping what was in it. */
export function scrubMessage(text) {
  const s = String(text ?? '');
  const looksPersonal = /[^\s@]+@[^\s@]+\.[^\s@]/.test(s) || /\d[\d\s-]{5,}/.test(s);
  if (looksPersonal) return { text: '[removed: looked like personal details]', scrubbed: true };
  return { text: s.slice(0, MAX_MESSAGE_CHARS), scrubbed: false };
}

/** One blob per conversation, rewritten as it grows.
 *
 *  ⚠ NOT appended to a shared ndjson. admin-state.mjs appendRow() is read-modify-write,
 *  which is fine for a single-owner console and loses rows the moment two visitors are
 *  talking at once. */
export async function writeTranscript(convo) {
  if (!isConfigured()) return null;
  const day = String(convo.day || new Date().toISOString().slice(0, 10));
  const key = `${LOG_PREFIX}${day}/${convo.id}.json`;
  const doc = {
    v: 1,
    id: convo.id,
    startedAt: convo.startedAt,
    updatedAt: new Date().toISOString(),
    model: convo.model || '',
    turns: (convo.turns || []).slice(-40),
    totals: convo.totals || { messages: 0, inTokens: 0, cachedTokens: 0, outTokens: 0, usd: 0 },
    flags: convo.flags || {},
  };
  try {
    await put(key, JSON.stringify(doc), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,             // the same conversation grows across turns
      addRandomSuffix: false,
      token: blobToken(),
    });
    return key;
  } catch (err) {
    /* Best-effort, like every other log in this project: observability is not the
       product, and a Blob wobble must never turn into a failed answer for a visitor. */
    console.error('[chat-log] transcript write failed:', err?.message || err);
    return null;
  }
}

export function newConversationId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/* Which day's folder a conversation belongs in, derived from the id itself.

   ⚠ NOT `new Date()`. The day was previously taken from the clock at write time on the
   server and from the conversation's start on the client, and those disagree for any
   conversation that crosses midnight UTC — so the transcript was filed under one day while
   "email me this conversation" went looking under another, and the share silently found
   nothing. Deriving it from the id makes both sides compute the same answer with no
   coordination. */
export function dayOfConversation(id) {
  const epoch = Number(String(id || '').split('-')[0]);
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date().toISOString().slice(0, 10);
  return new Date(epoch).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- retention + rollups --- */

function dayOf(pathname, prefix) {
  return String(pathname).slice(prefix.length, prefix.length + 10);
}

function monthOf(day) {
  return String(day).slice(0, 7);
}

/** Claim a once-a-day job. Same atomic `allowOverwrite:false` trick as the quota claim —
 *  with several instances warm, exactly one wins and the rest skip silently. */
async function claimMaintenance(name, day) {
  if (!isConfigured()) return false;
  try {
    await put(`${CLAIM_PREFIX}${day}/${name}.json`, JSON.stringify({ at: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: false,
      addRandomSuffix: false,
      token: blobToken(),
    });
    return true;
  } catch {
    return false;                        // already claimed, or unreachable — either way, skip
  }
}

async function readJson(pathname) {
  try {
    const r = await get(pathname, { access: 'private', token: blobToken() });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch {
    return null;
  }
}

/** Fold one finished day into its month's rollup: the numbers that are worth keeping
 *  after the text is gone. Cheap, tiny, and non-personal. */
export async function rollUpDay(day) {
  if (!isConfigured()) return null;
  const blobs = await listAll({ prefix: `${LOG_PREFIX}${day}/`, token: blobToken() });
  const acc = {
    conversations: 0, messages: 0, inTokens: 0, cachedTokens: 0, outTokens: 0, usd: 0,
    hitLimit: 0, deflected: 0, gaps: {},
  };
  for (const b of blobs) {
    const doc = await readJson(b.pathname);
    if (!doc) continue;
    acc.conversations += 1;
    const t = doc.totals || {};
    acc.messages += t.messages || 0;
    acc.inTokens += t.inTokens || 0;
    acc.cachedTokens += t.cachedTokens || 0;
    acc.outTokens += t.outTokens || 0;
    acc.usd += t.usd || 0;
    if (doc.flags?.hitLimit) acc.hitLimit += 1;
    if (doc.flags?.deflected) acc.deflected += 1;
    for (const turn of doc.turns || []) {
      // The content backlog: questions the site had little to say about, in the
      // visitor's own words. The single most useful thing this log produces.
      if (turn.gap && turn.q) acc.gaps[turn.q] = (acc.gaps[turn.q] || 0) + 1;
    }
  }

  const month = monthOf(day);
  const path = `${ROLLUP_PREFIX}${month}.json`;
  const existing = (await readJson(path)) || { v: 1, month, days: {} };
  existing.days[day] = {
    conversations: acc.conversations, messages: acc.messages,
    inTokens: acc.inTokens, cachedTokens: acc.cachedTokens, outTokens: acc.outTokens,
    usd: Number(acc.usd.toFixed(4)),
    hitLimit: acc.hitLimit, deflected: acc.deflected,
    gaps: Object.entries(acc.gaps).sort((a, b) => b[1] - a[1]).slice(0, 50),
  };
  try {
    await put(path, JSON.stringify(existing), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
      token: blobToken(),
    });
  } catch (err) {
    console.error('[chat-log] rollup write failed:', err?.message || err);
    return null;
  }
  return existing.days[day];
}

/** Delete transcripts past the window. ⚠ Only under LOG_PREFIX — chat-hold/ is exempt by
 *  construction, which is what makes a legal hold actually hold. */
export async function pruneExpired(now = new Date()) {
  if (!isConfigured()) return 0;
  const cutoff = new Date(now.getTime() - RETAIN_DAYS * 86400_000).toISOString().slice(0, 10);
  const blobs = await listAll({ prefix: LOG_PREFIX, token: blobToken() });
  const doomed = blobs.filter((b) => dayOf(b.pathname, LOG_PREFIX) < cutoff);

  /* ⚠ Share records go sooner, because they are the one thing here that carries an address.
     An ordinary transcript has no identifier and is not personal data; one of these is. 30
     days matches the link's own expiry, so nothing useful is lost by deleting it. */
  const shareCut = now.getTime() - SHARE_RETAIN_DAYS * 86400_000;
  for (const b of await listAll({ prefix: 'chat-share/', token: blobToken() })) {
    const at = Date.parse(b.uploadedAt || b.uploaded_at || 0);
    if (Number.isFinite(at) && at < shareCut) doomed.push(b);
  }

  /* ⚠ THE DAILY IP CLAIMS, WHICH NOTHING USED TO DELETE — AND privacy.html SAYS THEY ARE.
     Section 3f promises the IP hash is "deleted daily". The claims EXPIRE daily, because a
     new day is a new prefix and the allowance is fresh, but the rows themselves were kept
     for ever. An expired row and a deleted one are not the same statement, and the published
     one has to be the true one. Anything before today goes; today's is load-bearing. */
  const todayStr = now.toISOString().slice(0, 10);
  for (const b of await listAll({ prefix: 'chat-quota/', token: blobToken() })) {
    if (dayOf(b.pathname, 'chat-quota/') < todayStr) doomed.push(b);
  }

  let n = 0;
  for (const b of doomed) {
    try {
      await del(b.pathname, { token: blobToken() });
      n += 1;
    } catch (err) {
      console.error('[chat-log] prune failed for', b.pathname, err?.message || err);
    }
  }
  return n;
}

/* Run once per day, on the first write after midnight UTC. No cron, no scheduled task and
   nothing that depends on the owner being present — the alternative is a retention promise
   that quietly stops being true the first week nobody opens the console.

   Fire-and-forget from the endpoint: a visitor must never wait on housekeeping. */
export async function maybeRollover(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (!(await claimMaintenance('rollover', day))) return null;
  const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
  const rolled = await rollUpDay(yesterday).catch((e) => {
    console.error('[chat-log] rollup failed:', e?.message || e);
    return null;
  });
  const pruned = await pruneExpired(now).catch((e) => {
    console.error('[chat-log] prune failed:', e?.message || e);
    return 0;
  });
  console.log(`[chat-log] rollover ${day}: rolled ${yesterday}, pruned ${pruned} transcript(s)`);
  return { rolled, pruned };
}

/* ------------------------------------------------------------------ console reads --- */

/* ⚠ HOW MANY TRANSCRIPTS ARE ACTUALLY OPENED, AND WHY THERE IS A CAP.

   Listing a prefix is one cheap call; opening each blob is a network round trip apiece.
   Ninety days of real traffic is thousands of conversations, and reading them all in a loop
   is exactly the shape that took the Signups search to 87 seconds before it was pooled and
   cached. The tab would get slower every week, with nothing to see but a spinner.

   So: list once, sort newest first, and open at most this many. The response says when it
   stopped short, because a total quietly covering "some of the period" is worse than a
   smaller number honestly labelled. The month rollups are the place to go for figures that
   must span the whole window — they exist precisely so this does not have to. */
const MAX_TRANSCRIPT_READS = 300;

/** Everything the console's AI agent tab shows for a period. Mirrors the shape of
 *  lib/search-log.mjs aggregate() so the tab can be built the same way. */
export async function aggregate(days = 30) {
  if (!isConfigured()) {
    /* ⚠ Same keys as the success path, to the letter. The console reads these directly and
       a missing field renders as `undefined` with nothing thrown. */
    return { days, conversations: 0, inWindow: 0, messages: 0, usd: 0, byDay: [], gaps: [],
      top: [], transcripts: [], held: 0, oldestDays: null, truncated: false, configured: false };
  }
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  // ⚠ ONE listing, reused. This used to be done twice, identically, for no reason.
  const all = await listAll({ prefix: LOG_PREFIX, token: blobToken() });
  const inWindow = all
    .filter((b) => dayOf(b.pathname, LOG_PREFIX) >= cutoff)
    .sort((a, b) => String(b.pathname).localeCompare(String(a.pathname)));

  const blobs = inWindow.slice(0, MAX_TRANSCRIPT_READS);
  const truncated = inWindow.length > blobs.length;

  /* ⚠ HELD CONVERSATIONS ARE READ TOO, AND ARE NEVER FILTERED BY THE PERIOD.

     They used only to be COUNTED here, which meant holding one made it vanish from the
     tab -- the exact opposite of what a hold is for, and the opposite of what the button's
     own tooltip promises ("listed separately so it cannot be forgotten"). There was no
     separate listing. Holding a conversation was, in practice, a way to hide it.

     The period filter does not apply to them either: a hold is indefinite by design, and a
     dispute that outlives the window is precisely the one still worth reading. */
  const heldBlobs = (await listAll({ prefix: HOLD_PREFIX, token: blobToken() }))
    .sort((a, b) => String(b.pathname).localeCompare(String(a.pathname)));

  const toRead = [
    ...heldBlobs.slice(0, MAX_TRANSCRIPT_READS).map((b) => ({ b, prefix: HOLD_PREFIX, isHeld: true })),
    ...blobs.map((b) => ({ b, prefix: LOG_PREFIX, isHeld: false })),
  ];

  const byDay = new Map();
  const gaps = new Map();
  const asked = new Map();
  const transcripts = [];
  let messages = 0;
  let usd = 0;
  let counted = 0;

  for (const { b, prefix, isHeld } of toRead) {
    const doc = await readJson(b.pathname);
    if (!doc) continue;
    const day = dayOf(b.pathname, prefix);
    const t = doc.totals || {};
    /* ⚠ A held conversation contributes to the period's FIGURES only when it actually falls
       in the period. Otherwise pressing Hold would quietly change last month's totals, and
       a cost figure that moves because somebody flagged a dispute is not a cost figure. */
    if (day >= cutoff) {
      counted += 1;
      messages += t.messages || 0;
      usd += t.usd || 0;
      byDay.set(day, (byDay.get(day) || 0) + 1);
      for (const turn of doc.turns || []) {
        if (!turn.q) continue;
        asked.set(turn.q, (asked.get(turn.q) || 0) + 1);
        if (turn.gap) gaps.set(turn.q, (gaps.get(turn.q) || 0) + 1);
      }
    }
    transcripts.push({
      id: doc.id, day, startedAt: doc.startedAt, updatedAt: doc.updatedAt,
      model: doc.model, totals: t, flags: doc.flags || {}, turns: doc.turns || [],
      held: isHeld, hold: doc.hold || null,
    });
  }

  const oldest = all.length
    ? all.map((b) => dayOf(b.pathname, LOG_PREFIX)).sort()[0]
    : null;
  const held = heldBlobs.length;

  const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([q, n]) => ({ q, n }));
  return {
    days,
    configured: true,
    /* ⚠ Conversations IN THE PERIOD, not rows in the list. `transcripts` now also carries
       held ones from outside the window, and counting those here would make the summary
       disagree with byDay and with the cost. */
    conversations: counted,
    inWindow: inWindow.length,
    truncated,
    messages,
    usd: Number(usd.toFixed(4)),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    gaps: rank(gaps).slice(0, 100),
    top: rank(asked).slice(0, 100),
    transcripts,
    held,
    oldestDays: oldest
      ? Math.round((Date.now() - Date.parse(oldest + 'T00:00:00Z')) / 86400_000)
      : null,
  };
}

/* ------------------------------------------------------------------ legal hold --- */

/* Move one transcript out of the pruned prefix, or back into it.

   ⚠ This is the answer to "keep it for legal reasons", and it is deliberately narrow. A
   blanket permanent retention would be neither proportionate nor honest against a stated
   90-day policy; keeping the specific conversation someone is disputing is both, and is
   expressly permitted for establishing or defending a legal claim. Held records are listed
   separately in the console so they cannot be quietly forgotten. */
export async function setHold(id, day, hold, why) {
  if (!isConfigured()) throw new Error('no blob credential');
  if (!/^[0-9]{10,}-[0-9a-f]{8}$/.test(String(id))) throw new Error('bad transcript id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('bad day');

  const from = `${hold ? LOG_PREFIX : HOLD_PREFIX}${day}/${id}.json`;
  const to = `${hold ? HOLD_PREFIX : LOG_PREFIX}${day}/${id}.json`;
  const doc = await readJson(from);
  if (!doc) throw new Error('transcript not found (it may already have been pruned)');

  doc.hold = hold ? { at: new Date().toISOString(), why: String(why || '').slice(0, 300) } : null;
  await put(to, JSON.stringify(doc), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    token: blobToken(),
  });
  /* ⚠ Copy THEN delete, in that order. The reverse loses the transcript outright if the
     write fails, and the thing being moved is the one somebody may need to produce. */
  try {
    await del(from, { token: blobToken() });
  } catch (err) {
    console.error('[chat-log] hold: copied but could not remove the original:', err?.message || err);
  }
  return { ok: true, id, day, hold: Boolean(hold) };
}

/* ---------------------------------------------------------------------- export --- */

/* One row per MESSAGE, not per conversation: two hundred conversations are far easier to
   read down a spreadsheet column than by clicking through a panel.

   ⚠ An export is a copy with no retention control, and it will ride the external-drive
   backup, which is additive and never deletes. It is a convenience, NOT a way to keep
   transcripts longer than the stated window -- moving data to a disk does not move the
   obligation. If a longer window is wanted, change RETAIN_DAYS and say so in privacy.html. */
export function toCsv(data) {
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    // Excel treats a leading =, +, - or @ as a formula. Prefix with ' so a transcript
    // cannot become a spreadsheet injection in whatever opens this next.
    const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  const rows = [[
    'conversation', 'day', 'at', 'model', 'question', 'answer',
    'content_gap', 'scrubbed', 'usd', 'in_tokens', 'cached_tokens', 'out_tokens',
  ].join(',')];
  for (const c of data.transcripts || []) {
    for (const t of c.turns || []) {
      rows.push([
        cell(c.id), cell(c.day), cell(t.at), cell(c.model),
        cell(t.q), cell(t.a),
        cell(t.gap ? 'yes' : ''), cell(t.scrubbed ? 'yes' : ''),
        cell(t.usd ?? ''),
        cell(t.usage?.in ?? ''), cell(t.usage?.cacheR ?? ''), cell(t.usage?.out ?? ''),
      ].join(','));
    }
  }
  return rows.join('\r\n') + '\r\n';
}
