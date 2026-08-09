/* Sitewide search — WebNomad Studio.
   Vanilla JS, no dependencies, ES5 (matching assets/js/main.js).

   Two consumers, one matcher:
     - the header magnifier, which opens a modal overlay (every page)
     - /search.html, the canonical results page (deep-linkable, works without JS)

   The index (assets/search/core.json + blog.json, built by tools/search_build.py) holds the
   FULL body text of every page, so it is ~1.3 MB raw. It is therefore never fetched on an
   ordinary pageview — only when someone actually searches. The two files load in parallel and
   the smaller one renders first, so results appear while the blog half is still arriving.

   Loaded with `defer` from partials/footer.html, which is the only region that propagates to
   every page (page_build.py rewrites the header and footer regions and nothing else). */
(function () {
  "use strict";

  // No fetch means no index. The /search.html form still submits and the site still browses;
  // there is simply nothing to enhance, so leave the page exactly as served.
  if (typeof window.fetch !== "function" || typeof window.Promise !== "function") return;

  var CORE_URL = "/assets/search/core.json";
  var BLOG_URL = "/assets/search/blog.json";
  var OVERLAY_MAX = 8;      // results shown in the overlay — a glance, not a page
  var PAGE_MAX = 40;        // results shown on /search.html
  // Stop one long page (updates.html is 7,000 words) flooding the list. Tighter in the overlay:
  // three sections of the same article is a third of an eight-row list, and someone skimming a
  // short list wants to see the range of what exists, not the depth of one page.
  var OVERLAY_PER_URL = 2;
  var PAGE_PER_URL = 3;
  var DEBOUNCE = 120;       // matches the blog search's feel

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- index loading ------------------------------------------------------- */

  var parts = { core: null, blog: null };
  var failed = { core: false, blog: false };
  var started = false;
  var waiting = [];         // callbacks fired again as each half lands

  function prep(recs) {
    // Lowercase once here rather than per keystroke: the matcher runs over ~1.3 MB of text
    // and toLowerCase() on every scan would be the only slow thing in the whole feature.
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      r._t = r.t.toLowerCase();
      r._h = r.h.toLowerCase();
      r._b = r.b.toLowerCase();
    }
    return recs;
  }

  function grab(url, key) {
    // cache:"no-cache" revalidates rather than trusting a stale copy. vercel.json still uses
    // the legacy `routes` array, which cannot coexist with a `headers` block, so the freshness
    // rule lives here instead of in the CDN config. A 304 is cheap.
    return fetch(url, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      // Search still works on whatever did load — half an index beats none. But the failure is
      // recorded, because it must NOT be mistaken for "this half is legitimately empty": see
      // complete().
      .catch(function () { failed[key] = true; return []; })
      .then(function (data) {
        parts[key] = prep(data);
        for (var i = 0; i < waiting.length; i++) waiting[i]();
      });
  }

  function load(onProgress) {
    if (onProgress && waiting.indexOf(onProgress) === -1) waiting.push(onProgress);
    if (!started) {
      started = true;
      grab(CORE_URL, "core");
      grab(BLOG_URL, "blog");
    } else if (onProgress && (parts.core || parts.blog)) {
      onProgress();
    }
  }

  function index() {
    return (parts.core || []).concat(parts.blog || []);
  }
  // Both halves have settled — the UI can stop saying "Searching…".
  function ready() { return parts.core !== null && parts.blog !== null; }

  // Both halves settled AND both actually arrived. Analytics needs this stricter test: a
  // failed blog.json leaves an empty half that looks exactly like "no blog post matches", so
  // logging on ready() alone would file every blog-only query as a content gap that isn't one.
  function complete() { return ready() && !failed.core && !failed.blog; }

  /* ---- matching ------------------------------------------------------------ */

  function terms(q) {
    return q.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  function wordStart(s, i) {
    return i === 0 || !/[a-z0-9]/.test(s.charAt(i - 1));
  }

  // AND across terms (same semantics as the blog filter — typing more always narrows), with
  // the field a term lands in deciding how much it is worth.
  function score(r, ts, phrase) {
    var s = 0;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i],
          it = r._t.indexOf(t),
          ih = r._h.indexOf(t),
          ib = r._b.indexOf(t);
      if (it < 0 && ih < 0 && ib < 0) return 0;
      if (it >= 0) s += wordStart(r._t, it) ? 12 : 6;
      if (ih >= 0) s += wordStart(r._h, ih) ? 8 : 4;
      if (ib >= 0) s += wordStart(r._b, ib) ? 3 : 1;
    }
    if (phrase && ts.length > 1 && r._b.indexOf(phrase) >= 0) s += 10;
    if (r.k === "page") s += 2;
    return s;
  }

  function search(q, limit, perUrl) {
    var ts = terms(q);
    if (!ts.length) { search.lastTotal = 0; return []; }
    var phrase = q.toLowerCase().trim();
    var all = index(), hits = [];
    for (var i = 0; i < all.length; i++) {
      var sc = score(all[i], ts, phrase);
      if (sc > 0) hits.push({ r: all[i], s: sc });
    }
    // The true match count, before the display limit and the per-page cap. Analytics wants
    // "did this find anything", not "how many rows fitted in the dropdown".
    search.lastTotal = hits.length;
    hits.sort(function (a, b) { return b.s - a.s; });

    var seen = {}, out = [];
    for (var j = 0; j < hits.length && out.length < limit; j++) {
      var u = hits[j].r.u;
      seen[u] = (seen[u] || 0) + 1;
      if (seen[u] > perUrl) continue;
      out.push(hits[j].r);
    }
    return out;
  }

  /* ---- rendering ----------------------------------------------------------- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Escape each slice separately and wrap the matches. Highlighting AFTER escaping would let
  // a search for "amp" light up the innards of every &amp; on the page.
  function highlight(raw, ts) {
    var low = raw.toLowerCase(), ranges = [], i, t, from, at;
    for (i = 0; i < ts.length; i++) {
      t = ts[i]; from = 0;
      while ((at = low.indexOf(t, from)) > -1) {
        ranges.push([at, at + t.length]);
        from = at + t.length;
        if (ranges.length > 100) break;
      }
    }
    if (!ranges.length) return esc(raw);
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var out = "", cur = 0;
    for (i = 0; i < ranges.length; i++) {
      var s = ranges[i][0], e = ranges[i][1];
      if (s < cur) { if (e > cur) cur = e; continue; }   // overlapping terms
      out += esc(raw.slice(cur, s)) + "<mark>" + esc(raw.slice(s, e)) + "</mark>";
      cur = e;
    }
    return out + esc(raw.slice(cur));
  }

  function snippet(r, ts) {
    var b = r.b, pos = -1, i;
    for (i = 0; i < ts.length && pos < 0; i++) pos = r._b.indexOf(ts[i]);
    if (pos < 0) pos = 0;
    var start = Math.max(0, pos - 70);
    if (start > 0) {
      var sp = b.indexOf(" ", start);
      if (sp > -1 && sp < start + 30) start = sp + 1;
    }
    var end = Math.min(b.length, start + 210);
    if (end < b.length) {
      var sp2 = b.lastIndexOf(" ", end);
      if (sp2 > start + 120) end = sp2;
    }
    return (start > 0 ? "… " : "") + highlight(b.slice(start, end), ts) +
           (end < b.length ? " …" : "");
  }

  // Blog headings carry ids (the post TOC needs them); most hand-written marketing pages do
  // not. Where there is no id, fall back to a text fragment so supporting browsers still scroll
  // to the passage — and browsers that ignore it just open the page, which is the old behaviour.
  function href(r) {
    if (r.a) return r.u + "#" + r.a;
    var clean = String(r.h || "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    var words = clean.split(" ").slice(0, 8).join(" ");
    return words.length >= 12 ? r.u + "#:~:text=" + encodeURIComponent(words) : r.u;
  }

  function resultHTML(r, ts, id) {
    var kind = r.k === "post" ? (r.c || "Blog") : "Guide";
    var crumb = r.h && r.h !== r.t ? esc(r.t) + " › " + esc(r.h) : esc(r.t);
    return '<a class="search-result" href="' + esc(href(r)) + '"' +
      (id ? ' id="' + id + '" role="option"' : "") + '>' +
      '<span class="search-result-kind">' + esc(kind) + "</span>" +
      "<span class=\"search-result-title\">" + highlight(r.h || r.t, ts) + "</span>" +
      '<span class="search-result-crumb">' + crumb + "</span>" +
      '<span class="search-snippet">' + snippet(r, ts) + "</span>" +
      "</a>";
  }

  function countLabel(n, q, done) {
    if (!q) return "";
    if (!n) return done ? "No matches for “" + q + "”." : "Searching…";
    return n + (n === 1 ? " result" : " results") + " for “" + q + "”" +
      (done ? "" : " so far…");
  }

  /* ---- the results page (/search.html) ------------------------------------- */

  (function resultsPage() {
    var input = document.getElementById("searchInput");
    var list = document.getElementById("searchResults");
    var status = document.getElementById("searchStatus");
    if (!input || !list || !status) return;

    function render() {
      var q = input.value.trim();
      if (!q) {
        list.innerHTML = "";
        status.textContent = "";
        return;
      }
      var ts = terms(q);
      var hits = search(q, PAGE_MAX, PAGE_PER_URL);
      noteWhenSettled(q, search.lastTotal);
      status.textContent = countLabel(hits.length, q, ready());
      list.innerHTML = hits.length
        ? hits.map(function (r) { return resultHTML(r, ts, ""); }).join("")
        : (ready()
            ? '<p class="search-empty">Nothing matched that. Try fewer words, or browse the ' +
              '<a href="/faq.html">FAQ</a> and the <a href="/blog.html">blog index</a>.</p>'
            : "");
    }

    var timer;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        render();
        // Keep the URL shareable as you type, without stacking history entries.
        var q = input.value.trim();
        history.replaceState(null, "", q ? "?q=" + encodeURIComponent(q) : location.pathname);
      }, DEBOUNCE);
    });

    // With JS on, submitting should not reload the page — results are already live.
    var form = input.form;
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        clearTimeout(timer);
        render();
        // ⚠ Analytics MUST be flushed here, and this is the one place it is easy to forget.
        // Cancelling the navigation above means pagehide never fires, so a visitor who types
        // a query, presses Search and then reads the results without leaving the page was
        // never recorded at all — the single clearest statement of intent on the whole site
        // was the one action guaranteed to go unlogged. Log immediately rather than waiting
        // out the settle timer (a submit IS the settle), and flush rather than waiting for
        // the page to go away. noteQuery dedupes, so the pending timer becomes a no-op.
        noteQuery(input.value, search.lastTotal);
        flushLog();

        // Say something. The button cannot change the results — they are already live — so
        // without this it is a control that visibly does nothing, which reads as broken.
        // Removing and reflowing before re-adding restarts the animation on a repeated press;
        // without the reflow the class is already there and the second press looks ignored.
        // Focus is deliberately NOT moved: Enter submits from inside the input, and taking
        // focus away there would break refining a query mid-typing.
        if (input.value.trim()) {
          status.classList.remove("acked");
          void status.offsetWidth;
          status.classList.add("acked");
        }
      });
    }

    var m = location.search.match(/[?&]q=([^&]*)/);
    if (m) input.value = decodeURIComponent(m[1].replace(/\+/g, " "));
    input.focus();
    if (input.value.trim()) status.textContent = "Searching…";
    load(render);
  })();

  /* ---- what people search for, and what they fail to find ------------------ */

  // Sends the query text and its result count, batched, once per page. Nothing else: no id,
  // no cookie, no IP (the server uses the IP for rate limiting and never stores it). See
  // Website/lib/search-log.mjs.
  var LOG_URL = "/api/search-log";
  var loggedQueries = {};   // dedupe within a page session
  var pendingLog = [];
  var settleTimer;

  function trackingRefused() {
    return navigator.doNotTrack === "1" || window.doNotTrack === "1" ||
           navigator.msDoNotTrack === "1" || navigator.globalPrivacyControl === true;
  }

  function flushLog() {
    if (!pendingLog.length) return;
    var payload = JSON.stringify({ items: pendingLog });
    pendingLog = [];
    if (!navigator.sendBeacon) return;
    // sendBeacon survives the page going away, which a fetch on pagehide does not.
    try {
      navigator.sendBeacon(LOG_URL, new Blob([payload], { type: "application/json" }));
    } catch (e) { /* analytics must never surface to a visitor */ }
  }

  function noteQuery(q, total) {
    // ⚠ Never log against a partially-loaded index. core.json lands before blog.json, so a
    // query answered only by a blog post looks like a zero-result miss for a few hundred
    // milliseconds. Logging that would manufacture content gaps that do not exist — the exact
    // opposite of what this is for.
    if (!complete() || trackingRefused()) return;
    q = String(q).toLowerCase().replace(/\s+/g, " ").trim();
    if (q.length < 2 || q.length > 80) return;
    if (loggedQueries[q]) return;
    loggedQueries[q] = 1;
    pendingLog.push({ q: q, n: total });
    if (pendingLog.length >= 5) flushLog();
  }

  // Only record a query the visitor actually stopped on. The 120 ms render debounce fires on
  // every pause in typing, so logging there would record "r", "ro", "rot", "roth" — four
  // invented misses for one real search.
  function noteWhenSettled(q, total) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(function () { noteQuery(q, total); }, 1400);
  }

  window.addEventListener("pagehide", flushLog);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushLog();
  });

  /* ---- landing on an accordion --------------------------------------------- */

  // A search result can now link straight to an FAQ question, which is a <details>. Scrolling
  // one into view still leaves it CLOSED, so the reader arrives at the question and not the
  // answer. Open it on arrival, and on any later in-page jump.
  (function accordions() {
    function openTarget() {
      var id = location.hash.slice(1);
      if (!id || id.indexOf(":~:") === 0) return;
      var el;
      try { el = document.getElementById(decodeURIComponent(id)); } catch (e) { el = null; }
      if (!el) return;
      var d = el.tagName === "DETAILS" ? el : el.closest && el.closest("details");
      if (d && !d.open) {
        d.open = true;
        // Opening changes the page height, so the browser's own scroll landed short.
        if (d.scrollIntoView) d.scrollIntoView({ block: "start" });
      }
    }
    openTarget();
    window.addEventListener("hashchange", openTarget);
  })();

  /* ---- the overlay (every page) -------------------------------------------- */

  (function overlay() {
    var trigger = document.getElementById("navSearch");
    if (!trigger) return;

    // On /search.html the page itself is the search UI — sending the same keystroke to a modal
    // on top of it would be two search boxes arguing.
    var onResultsPage = !!document.getElementById("searchInput");

    var box, input, list, status, closeBtn, lastFocus, active = -1, timer;

    function build() {
      // Injected rather than baked into the markup, the same way main.js creates the
      // back-to-top button — so nothing has to be hand-pasted into 86 pages.
      box = document.createElement("div");
      box.className = "search-overlay" + (reduceMotion ? " no-anim" : "");
      box.hidden = true;
      box.innerHTML =
        '<div class="search-backdrop" data-close></div>' +
        '<div class="search-box" role="dialog" aria-modal="true" aria-label="Search the site">' +
          '<div class="search-box-head">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            '<input type="search" id="wnSearchInput" role="combobox" aria-expanded="false" aria-controls="wnSearchResults" aria-autocomplete="list" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search the site…" aria-label="Search the site">' +
            '<button type="button" class="search-close" data-close aria-label="Close search">Esc</button>' +
          "</div>" +
          '<p class="search-status" id="wnSearchStatus" role="status" aria-live="polite"></p>' +
          '<div class="search-results" id="wnSearchResults" role="listbox" aria-label="Search results"></div>' +
          '<div class="search-box-foot"><a href="/search.html" id="wnSearchAll">See all results</a></div>' +
        "</div>";
      document.body.appendChild(box);

      input = box.querySelector("#wnSearchInput");
      list = box.querySelector("#wnSearchResults");
      status = box.querySelector("#wnSearchStatus");
      closeBtn = box.querySelector(".search-close");

      box.addEventListener("click", function (e) {
        if (e.target.hasAttribute("data-close")) close();
      });
      input.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(render, DEBOUNCE);
      });
      box.addEventListener("keydown", onKey);
    }

    function items() {
      return Array.prototype.slice.call(list.querySelectorAll(".search-result"));
    }

    function setActive(i) {
      var els = items();
      if (!els.length) return;
      if (i < 0) i = els.length - 1;
      if (i >= els.length) i = 0;
      active = i;
      for (var n = 0; n < els.length; n++) {
        var on = n === i;
        els[n].classList.toggle("active", on);
        els[n].setAttribute("aria-selected", on ? "true" : "false");
      }
      input.setAttribute("aria-activedescendant", els[i].id);
      els[i].scrollIntoView({ block: "nearest" });
    }

    function render() {
      var q = input.value.trim();
      var all = box.querySelector("#wnSearchAll");
      all.href = "/search.html" + (q ? "?q=" + encodeURIComponent(q) : "");
      all.textContent = q ? "See all results for “" + q + "”" : "See all results";

      active = -1;
      input.removeAttribute("aria-activedescendant");

      if (!q) {
        list.innerHTML = "";
        status.textContent = "";
        input.setAttribute("aria-expanded", "false");
        return;
      }
      var ts = terms(q);
      var hits = search(q, OVERLAY_MAX, OVERLAY_PER_URL);
      noteWhenSettled(q, search.lastTotal);
      status.textContent = countLabel(hits.length, q, ready());
      list.innerHTML = hits.length
        ? hits.map(function (r, i) { return resultHTML(r, ts, "wn-opt-" + i); }).join("")
        : (ready() ? '<p class="search-empty">Nothing matched “' + esc(q) +
                     "”. Try fewer words.</p>" : "");
      input.setAttribute("aria-expanded", hits.length ? "true" : "false");
    }

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); return; }
      if (e.key === "Enter" && active > -1) {
        var el = items()[active];
        if (el) { e.preventDefault(); location.href = el.href; }
        return;
      }
      if (e.key === "Tab") {
        // Keep focus inside the dialog: behind it the whole page is still tabbable, and a
        // screen-reader user who tabs out of a modal has no way of knowing where they went.
        var focusable = [input].concat(items()).concat([closeBtn]);
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    function open() {
      if (!box) build();
      lastFocus = document.activeElement;
      box.hidden = false;
      document.documentElement.classList.add("search-open");
      trigger.setAttribute("aria-expanded", "true");
      input.focus();
      input.select();
      load(function () { if (!box.hidden) render(); });
    }

    function close() {
      if (!box || box.hidden) return;
      box.hidden = true;
      document.documentElement.classList.remove("search-open");
      trigger.setAttribute("aria-expanded", "false");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      // Dismissing the overlay ends a search just as definitely as navigating away from one.
      // Waiting for pagehide would hold the highest-signal case of all — searched, found
      // nothing, gave up, carried on reading — hostage to whether the visitor later closes
      // the tab in a way that fires it.
      flushLog();
    }

    if (onResultsPage) {
      // Reuse the button as a shortcut to the page's own input.
      trigger.addEventListener("click", function () {
        document.getElementById("searchInput").focus();
      });
    } else {
      trigger.addEventListener("click", open);
      // Warm the index on intent, so the overlay usually opens onto a loaded index.
      trigger.addEventListener("mouseenter", function () { load(null); });
      trigger.addEventListener("focus", function () { load(null); });
    }

    document.addEventListener("keydown", function (e) {
      var t = e.target || {};
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (onResultsPage) document.getElementById("searchInput").focus();
        else if (box && !box.hidden) close(); else open();
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (onResultsPage) document.getElementById("searchInput").focus();
        else open();
      }
    });
  })();

})();
