/* Site assistant — the floating launcher and its panel.
   Vanilla JS, no dependencies, ES5 (matching assets/js/main.js and search.js).

   WHY THIS COSTS NOTHING ON AN ORDINARY PAGEVIEW
   The script renders nothing and fetches nothing until the visitor shows some sign
   of engagement — a scroll past a quarter of the page, or a few seconds' dwell. Only
   then does it ask GET /api/chat whether it should exist here at all. A visitor who
   bounces costs one script parse and no requests, which is the same rule the search
   index follows: never fetched on an ordinary pageview.

   WHY THE SERVER DECIDES, NOT THIS FILE
   Whether the assistant is on, which pages it appears on, and how many questions a
   visitor gets are all answered by that GET. So the owner can switch it off, or
   change its reach, from the console with no deploy and no build. ⚠ The real off
   switch is the endpoint refusing; this hiding itself is cosmetic catch-up on the
   next page load.

   FOUR WAYS IN, one panel: the launcher pill, any element carrying [data-chat-open],
   the zero-result state of site search, and ?ask=… in the URL.

   Related: Website/api/chat.mjs, Plans/Website-AI-Assistant.md
*/
(function () {
  "use strict";

  // Same bail-out as search.js: without these there is no useful degraded mode, and
  // every page still works completely without this script.
  if (!window.fetch || !window.Promise || !document.querySelector) return;

  var API = "/api/chat";
  var MAX_CHARS = 1000;          // must match MAX_QUESTION_CHARS in lib/chat-context.mjs
  var ENGAGE_MS = 6000;          // dwell before we ask whether to appear
  var ENGAGE_SCROLL = 0.25;      // …or this much of the page scrolled

  /* The closed set of buttons the model may ask for. ⚠ Anything not in here is
     dropped silently rather than rendered as literal "[[…]]" punctuation — the
     failure mode guide.mjs has in the owner console, where an unhandled construct
     shows up as stray brackets instead of throwing. */
  var ACTIONS = {
    "demo":            { href: "/demo.html",       label: "Try the demo" },
    "ebook":           { href: "/newsletter.html", label: "Get the free guide" },
    "contact":         { href: "/contact.html",    label: "Contact us" },
    "page:products":   { href: "/products.html",   label: "Products and pricing" },
    "page:features":   { href: "/features.html",   label: "Features" },
    "page:faq":        { href: "/faq.html",        label: "FAQ" },
    "page:how-it-works": { href: "/how-it-works.html", label: "How it works" },
    "page:technical":  { href: "/technical.html",  label: "Technical detail" },
    "page:privacy":    { href: "/privacy.html",    label: "Privacy" },
    "page:blog":       { href: "/blog.html",       label: "Blog" },
    "page:contact":    { href: "/contact.html",    label: "Contact us" }
  };

  var STARTERS = [
    "What makes this different from a spreadsheet?",
    "Does it warn me before I cross the ACA subsidy cliff?",
    "Can it handle retiring abroad?",
    "Is it a subscription?"
  ];

  var cfg = null;        // { enabled, showsHere, remaining, disclaimer, token }
  var box = null;        // the panel element
  var fab = null;        // the launcher
  var els = {};          // cached children
  var history = [];      // [{role, content}] — sent back and signed
  var priorTurns = [];   // what the log should keep, scrubbed server-side
  var mac = "";          // rolling signature over `history`
  var cid = "";          // conversation id
  var startedAt = "";
  var lastReplyAt = 0;
  var busy = false;
  var asked = false;     // have we done the GET yet
  var lastFocus = null;

  var reduceMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---- asking the server whether to exist ------------------------------------ */

  function ask(then) {
    if (asked) { then && then(); return; }
    asked = true;
    fetch(API + "?path=" + encodeURIComponent(location.pathname), {
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      cfg = d;
      if (d && d.enabled && d.showsHere) mountFab();
      then && then();
    })["catch"](function () { then && then(); });
  }

  /* Engagement, not page load. Whichever comes first, once. */
  function armEngagement() {
    var fired = false;
    function go() {
      if (fired) return;
      fired = true;
      window.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
      ask();
    }
    function onScroll() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h <= 0 || (window.pageYOffset / h) > ENGAGE_SCROLL) go();
    }
    var timer = setTimeout(go, ENGAGE_MS);
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---- launcher --------------------------------------------------------------- */

  function mountFab() {
    if (fab) return;
    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "wn-chat-fab";
    fab.id = "wnChatFab";
    fab.setAttribute("aria-label", "Ask about the planner");
    fab.setAttribute("aria-expanded", "false");
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-4.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>' +
      "</svg>" +
      '<span class="wn-chat-fab-label">Ask about the planner</span>';
    fab.addEventListener("click", function () { open(); });
    document.body.appendChild(fab);
    // The class lifts .scroll-top-fab clear of the launcher; see styles.css §22.
    document.body.classList.add("wn-chat-on");
    /* Inline openers ship HIDDEN and are revealed only here. An "ask the assistant"
       line showing while the assistant is switched off is a broken promise, and
       "off" is supposed to mean it disappears entirely. Hidden is also the correct
       no-JS state: every page is complete without this script. */
    var openers = document.querySelectorAll("[data-chat-open]");
    for (var i = 0; i < openers.length; i++) {
      // ⚠ The hidden attribute usually sits on the WRAPPING element, not on the link
      // itself -- revealing a bare <a> inside a hidden <p> would leave its lead-in
      // sentence dangling. Unhide both, so the markup can put it on either.
      openers[i].hidden = false;
      var wrap = openers[i].closest && openers[i].closest("[hidden]");
      if (wrap) wrap.hidden = false;
    }
    // Next frame, so the transition actually runs instead of being skipped.
    window.requestAnimationFrame(function () { fab.classList.add("visible"); });
  }

  /* ---- panel ------------------------------------------------------------------ */

  function build() {
    box = document.createElement("div");
    box.className = "wn-chat-panel";
    box.id = "wnChatPanel";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Ask about the planner");
    box.innerHTML =
      '<div class="wn-chat-head">' +
        '<div class="wn-chat-head-text">' +
          '<strong class="wn-chat-title">Ask about the planner</strong>' +
          /* ⚠ Both halves are required and neither may be dropped to save a line: that this
             is an AI, and that it is not advice. Shortened, not removed. */
          '<span class="wn-chat-note">AI assistant · educational information, not ' +
          "financial advice.</span>" +
        "</div>" +
        '<button type="button" class="wn-chat-close" aria-label="Close">&times;</button>' +
      "</div>" +
      '<div class="wn-chat-log" id="wnChatLog" aria-busy="false"></div>' +
      '<p class="wn-chat-sr sr-only" id="wnChatLive" role="status" aria-live="polite"></p>' +
      '<div class="wn-chat-foot">' +
        '<p class="wn-chat-hint">Stored to improve the site. Please don’t type ' +
        "personal details.</p>" +
        '<form class="wn-chat-form" novalidate>' +
          '<div class="sr-only" aria-hidden="true">' +
            '<label for="wnChatHoney">Leave this blank</label>' +
            '<input type="text" id="wnChatHoney" name="_honey" tabindex="-1" autocomplete="off">' +
          "</div>" +
          '<textarea class="wn-chat-input" id="wnChatInput" rows="1" maxlength="' + MAX_CHARS + '" ' +
            'placeholder="Ask a question…" aria-label="Your question"></textarea>' +
          '<button type="submit" class="wn-chat-send" aria-label="Send">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 12h15M13 6l6 6-6 6"/></svg>' +
          "</button>" +
        "</form>" +
        '<div class="wn-chat-meta">' +
          '<p class="wn-chat-count" id="wnChatCount"></p>' +
        /* A quiet line, not a modal and not a banner. It selects the people who found the
           assistant useful, which is a value exchange rather than a toll on the way in --
           the reason it survives alongside the decision not to gate on an email. */
          '<p class="wn-chat-share" id="wnChatShare" hidden>' +
            '<button type="button" class="wn-chat-sharelink">Email me this</button>' +
          "</p>" +
        "</div>" +
        '<form class="wn-chat-shareform" id="wnChatShareForm" hidden novalidate>' +
          '<div class="sr-only" aria-hidden="true">' +
            '<label for="wnChatShareHoney">Leave this blank</label>' +
            '<input type="text" id="wnChatShareHoney" name="_honey" tabindex="-1" autocomplete="off">' +
          "</div>" +
          '<input type="email" class="wn-chat-input" id="wnChatEmail" ' +
            'placeholder="you@example.com" aria-label="Your email address" autocomplete="email">' +
          '<button type="submit" class="wn-chat-act">Send</button>' +
          '<p class="wn-chat-hint" style="margin:.45rem 0 0">We send a link to this ' +
            'conversation and nothing else. This does not subscribe you to anything.</p>' +
        "</form>" +
      "</div>";
    document.body.appendChild(box);

    els.log = box.querySelector("#wnChatLog");
    els.live = box.querySelector("#wnChatLive");
    els.input = box.querySelector("#wnChatInput");
    els.send = box.querySelector(".wn-chat-send");
    els.form = box.querySelector(".wn-chat-form");
    els.honey = box.querySelector("#wnChatHoney");
    els.count = box.querySelector("#wnChatCount");
    els.close = box.querySelector(".wn-chat-close");
    els.share = box.querySelector("#wnChatShare");
    els.shareForm = box.querySelector("#wnChatShareForm");
    els.email = box.querySelector("#wnChatEmail");
    els.shareHoney = box.querySelector("#wnChatShareHoney");

    els.close.addEventListener("click", close);
    els.form.addEventListener("submit", function (e) { e.preventDefault(); send(); });
    box.addEventListener("keydown", onKey);
    els.input.addEventListener("input", grow);
    // Enter sends, Shift+Enter makes a new line — what people expect of a chat box.
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    box.querySelector(".wn-chat-sharelink").addEventListener("click", function () {
      els.share.hidden = true;
      els.shareForm.hidden = false;
      els.email.focus();
    });
    els.shareForm.addEventListener("submit", function (e) { e.preventDefault(); shareIt(); });

    armViewport();
    greet();
  }

  function grow() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 96) + "px";
  }

  function greet() {
    var d = document.createElement("div");
    d.className = "wn-chat-msg wn-chat-from-bot";
    d.innerHTML =
      "<p>Ask me anything about the AI Retirement Income Planner — what it models, " +
      "what it costs, or whether it fits your situation.</p>" +
      '<div class="wn-chat-starters"></div>';
    var wrap = d.querySelector(".wn-chat-starters");
    for (var i = 0; i < STARTERS.length; i++) {
      (function (text) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "wn-chat-starter";
        b.textContent = text;
        b.addEventListener("click", function () { els.input.value = text; send(); });
        wrap.appendChild(b);
      })(STARTERS[i]);
    }
    els.log.appendChild(d);
    renderCount();
  }

  function renderCount() {
    if (!cfg || typeof cfg.remaining !== "number") { els.count.textContent = ""; return; }
    els.count.textContent = cfg.remaining > 0
      ? cfg.remaining + (cfg.remaining === 1 ? " question left" : " questions left")
      : "";
  }

  /* ⚠ THE KEYBOARD, which is the single most common chat-widget bug on a phone.
     Focusing the composer resizes the VISUAL viewport, not the layout viewport, so
     a panel sized in vh/dvh keeps its full height and iOS pushes the composer off
     the bottom of the screen. Sizing from visualViewport.height is the fix; the
     listeners are cheap and only matter while the panel is open. */
  function armViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    function fit() {
      if (!box || box.hidden) return;
      if (window.innerWidth > 600) { box.style.height = ""; return; }
      box.style.height = vv.height + "px";
      stick();
    }
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    els.input.addEventListener("focus", function () { setTimeout(fit, 50); });
    box._fit = fit;
  }

  function stick() {
    els.log.scrollTop = els.log.scrollHeight;
  }

  function open(seed) {
    if (!cfg || !cfg.enabled) return;
    if (!box) build();
    lastFocus = document.activeElement;
    box.hidden = false;
    document.documentElement.classList.add("wn-chat-open");
    if (fab) fab.setAttribute("aria-expanded", "true");
    if (box._fit) box._fit();
    if (seed) { els.input.value = String(seed).slice(0, MAX_CHARS); grow(); }
    els.input.focus();
    stick();
  }

  function close() {
    if (!box || box.hidden) return;
    box.hidden = true;
    box.style.height = "";
    document.documentElement.classList.remove("wn-chat-open");
    if (fab) fab.setAttribute("aria-expanded", "false");
    /* ⚠ Fall back to the launcher rather than trusting lastFocus blindly. A click does
       not always focus a button, so lastFocus can be <body> -- and returning focus there
       drops a keyboard user at the top of the document with no idea where they went.
       The launcher is where they were, conceptually, so send them back to it. */
    var back = (lastFocus && lastFocus.focus && lastFocus !== document.body) ? lastFocus : fab;
    if (back && back.focus) back.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    // Keep focus inside the dialog: behind it the whole page is still tabbable, and a
    // screen-reader user who tabs out of a modal has no way of knowing where they went.
    var f = [].slice.call(box.querySelectorAll(
      "button:not([disabled]), textarea, a[href], input:not([tabindex='-1'])"
    )).filter(function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---- rendering a reply ------------------------------------------------------ */

  /* Pull the [[token]]s out and hand back the prose plus the buttons they asked for.
     Unknown tokens vanish rather than showing as brackets. */
  function extract(text) {
    var acts = [];
    var prose = String(text).replace(/\[\[([a-z0-9:_-]+)\]\]/gi, function (_, name) {
      var key = String(name).toLowerCase();
      if (ACTIONS[key] && acts.indexOf(key) === -1) acts.push(key);
      return "";
    });
    return { prose: prose, acts: acts };
  }

  /* Deliberately tiny: paragraphs, bullets, and **bold**. The model is told to answer
     in short prose, so anything more would be scope for a bug rather than a feature. */
  function toHtml(text) {
    var blocks = String(text).replace(/\r/g, "").split(/\n{2,}/);
    var out = "";
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i].trim();
      if (!b) continue;
      var lines = b.split("\n");
      if (/^[-*]\s+/.test(lines[0])) {
        out += "<ul>";
        for (var j = 0; j < lines.length; j++) {
          out += "<li>" + bold(esc(lines[j].replace(/^[-*]\s+/, ""))) + "</li>";
        }
        out += "</ul>";
      } else {
        out += "<p>" + bold(esc(b).replace(/\n/g, "<br>")) + "</p>";
      }
    }
    return out;
  }

  function bold(s) {
    return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function addMsg(who, html) {
    var d = document.createElement("div");
    d.className = "wn-chat-msg wn-chat-from-" + who;
    d.innerHTML = html;
    els.log.appendChild(d);
    stick();
    return d;
  }

  function addActions(node, acts) {
    if (!acts.length) return;
    var wrap = document.createElement("div");
    wrap.className = "wn-chat-acts";
    for (var i = 0; i < acts.length; i++) {
      var a = ACTIONS[acts[i]];
      var el = document.createElement("a");
      el.className = "wn-chat-act";
      el.href = a.href;
      el.textContent = a.label;
      wrap.appendChild(el);
    }
    node.appendChild(wrap);
    stick();
  }

  /* The end of the road: the free guide first, the contact page second. Offered once
     the visitor has had real value, rather than as a toll on the way in. */
  function addLimit() {
    var d = addMsg("bot",
      "<p>That is all the questions I can take in one visit. If you would like to keep " +
      "reading, the free guide covers most of this in more depth — and the contact page " +
      "will always reach a person.</p>");
    addActions(d, ["ebook", "contact"]);
    els.input.disabled = true;
    els.send.disabled = true;
    els.count.textContent = "";
  }

  /* ---- sending ---------------------------------------------------------------- */

  function send() {
    if (busy || !cfg || !cfg.enabled) return;
    var q = (els.input.value || "").trim();
    if (!q) return;
    if (q.length > MAX_CHARS) q = q.slice(0, MAX_CHARS);

    busy = true;
    els.send.disabled = true;
    els.input.value = "";
    grow();
    addMsg("user", toHtml(q));

    var bot = addMsg("bot", '<span class="wn-chat-typing"><i></i><i></i><i></i></span>');
    // ⚠ aria-busy, NOT aria-live, on the streaming region. A live region here would
    // announce every arriving chunk, which is unusable; the finished message is
    // announced once, below.
    els.log.setAttribute("aria-busy", "true");

    if (!cid) {
      cid = String(Date.now()) + "-" + Math.random().toString(16).slice(2, 10);
      startedAt = new Date().toISOString();
    }

    fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: q,
        history: history,
        mac: mac,
        token: cfg.token,
        _honey: els.honey.value,
        since: lastReplyAt ? (Date.now() - lastReplyAt) : 0,
        cid: cid,
        startedAt: startedAt,
        priorTurns: priorTurns
      })
    }).then(function (r) {
      return readStream(r, bot);
    }).then(function (res) {
      finish(q, res, bot);
    })["catch"](function () {
      bot.innerHTML = "<p>I could not reach the assistant just then. The pages themselves " +
        "have the same information, and the contact page will always reach a person.</p>";
      addActions(bot, ["contact"]);
      done();
    });
  }

  /* NDJSON: {"t":"…"} chunks then one {"done":true,…}. Falls back to reading the whole
     body when streaming is unavailable — the same lines parse either way. */
  function readStream(r, bot) {
    var acc = "";     // text so far
    var meta = null;
    var buf = "";

    function feed(chunk) {
      buf += chunk;
      var lines = buf.split("\n");
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        var o;
        try { o = JSON.parse(lines[i]); } catch (e) { continue; }
        if (o.enabled === false) { meta = { off: true }; return; }
        if (o.limit && !o.done) { meta = { limit: true }; return; }
        if (o.error) { meta = { error: o.error }; return; }
        if (typeof o.t === "string") {
          acc += o.t;
          bot.innerHTML = toHtml(extract(acc).prose);
          stick();
        }
        if (o.done) meta = o;
      }
    }

    if (!r.body || !r.body.getReader) {
      return r.text().then(function (t) { feed(t + "\n"); return { text: acc, meta: meta }; });
    }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    return (function pump() {
      return reader.read().then(function (s) {
        if (s.done) { feed("\n"); return { text: acc, meta: meta }; }
        feed(dec.decode(s.value, { stream: true }));
        return pump();
      });
    })();
  }

  function finish(q, res, bot) {
    var meta = res.meta || {};
    if (meta.off) {
      // Switched off between page load and this question. Say nothing about why.
      bot.parentNode && bot.parentNode.removeChild(bot);
      close();
      if (fab) { fab.classList.remove("visible"); }
      done();
      return;
    }
    if (meta.limit && !res.text) { bot.parentNode.removeChild(bot); addLimit(); done(); return; }
    if (meta.error) {
      bot.innerHTML = toHtml(meta.error);
      addActions(bot, ["contact"]);
      done();
      return;
    }

    var parts = extract(res.text || "");
    bot.innerHTML = toHtml(parts.prose) || "<p>I do not have anything useful on that, " +
      "I am afraid. The contact page will reach a person who does.</p>";
    addActions(bot, parts.acts.length ? parts.acts : []);

    history.push({ role: "user", content: q });
    history.push({ role: "assistant", content: res.text || "" });
    priorTurns.push({ at: new Date().toISOString(), q: q, a: res.text || "" });
    if (priorTurns.length > 20) priorTurns = priorTurns.slice(-20);
    if (typeof meta.mac === "string") mac = meta.mac;
    if (typeof meta.remaining === "number") cfg.remaining = meta.remaining;

    // Announced ONCE, now that it is complete.
    // Offered only once there is a conversation worth having: after the first real answer.
    if (els.share && els.shareForm.hidden) els.share.hidden = false;

    els.live.textContent = parts.prose.slice(0, 400);
    done();
    renderCount();
    if (meta.limit) addLimit();
  }

  function done() {
    busy = false;
    els.log.setAttribute("aria-busy", "false");
    if (!els.input.disabled) { els.send.disabled = false; els.input.focus(); }
    lastReplyAt = Date.now();
    stick();
  }

  /* Answers the same way whatever happened, because the server does. Telling the visitor
     "already sent" or "we don't know that address" would hand a prober a way to test both. */
  function shareIt() {
    var addr = (els.email.value || "").trim();
    if (!addr || !cid) return;
    els.shareForm.innerHTML = '<p class="wn-chat-hint" style="margin:0">' +
      "If that address is valid, the conversation is on its way. The link works for 30 days " +
      "and does not subscribe you to anything.</p>";
    fetch("/api/chat-share", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: addr,
        cid: cid,
        day: (startedAt || new Date().toISOString()).slice(0, 10),
        token: cfg.token,
        _honey: els.shareHoney.value
      })
    })["catch"](function () { /* the message above is already the whole answer */ });
  }

  /* ---- the other three doors -------------------------------------------------- */

  function wireOpeners() {
    // Any element, anywhere, present or added later. data-chat-seed pre-fills a question.
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest && e.target.closest("[data-chat-open]");
      if (!t) return;
      e.preventDefault();
      ask(function () {
        if (!cfg || !cfg.enabled) {
          // Switched off: an opener must not be a dead click. Send them somewhere useful.
          var to = t.getAttribute("href");
          if (to) location.href = to;
          return;
        }
        open(t.getAttribute("data-chat-seed") || "");
      });
    });

    // ?ask=… — lets a blog CTA or an email point straight into a question.
    var m = /[?&]ask=([^&]+)/.exec(location.search);
    if (m) {
      var seed = "";
      try { seed = decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (err) { seed = ""; }
      if (seed) ask(function () { if (cfg && cfg.enabled) open(seed); });
    }
  }

  /* Site search finding nothing is the highest-intent moment on the site: the visitor
     has told us, in their own words, about something they could not find. search.js
     calls this if it is present, so the two stay decoupled. */
  window.wnChatOfferFor = function (query) {
    if (!cfg || !cfg.enabled) { if (!asked) ask(); return null; }
    var b = document.createElement("button");
    b.type = "button";
    b.className = "wn-chat-starter";
    b.textContent = "Ask the assistant about “" + query + "”";
    b.addEventListener("click", function () { open(query); });
    return b;
  };

  function init() {
    wireOpeners();
    armEngagement();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
