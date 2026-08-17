/* Sale bar — the yellow strip under the nav.

   Asks /api/sale whether a promotion is running and, if one is, fills the empty #saleBar that
   partials/header.html puts inside the sticky header. Also rewrites any price carrying a
   data-usd attribute, because a bar at the top of the page that is not reflected beside the
   price loses most of its effect.

   Loaded from partials/footer.html, alongside search.js, for the reason stated there: the
   header and footer are the only two regions page_build.py propagates, so a script tag
   anywhere else would have to be pasted into 86 files by hand and would drift.

   ⚠ data-usd is OPT-IN, not a blanket .price selector. The 1-on-1 session prices are .price
   elements too, and sale codes deliberately never apply to a session — that is an hour of
   someone's time, not a file. Adding the attribute is how a price joins the sale.

   ⚠ THE OTHER HALF OF THAT RULE: every price a BUYER could act on must carry it. A page that
   says $39.99 while checkout charges $31.99 is the one failure that costs trust rather than
   money. Prices inside buttons and prose take `data-usd-plain` as well, which changes the figure
   without inserting the struck price and code pill beside it.
   ⚠ Editorial figures are NOT prices — the blog and the cross-border study are full of "$605,000
   portfolio" and "$312/month". Never mark those.

   Nothing here stores anything about the visitor. The two keys it writes are the cached
   response (so the next page does not jump) and which sale this browser has dismissed. */

(function () {
  "use strict";

  var API = "/api/sale";
  var CACHE_KEY = "wn-sale";          // sessionStorage — last response, to avoid layout shift
  var DISMISS_KEY = "wn-sale-dismissed"; // localStorage — the sale id this browser closed
  var bar = document.getElementById("saleBar");
  if (!bar) return;                    // page without site chrome (the get/ landing pages)

  var timer = null;

  /* ---- tiny storage helpers (private mode throws on write) ---- */
  function readJSON(store, key) {
    try { return JSON.parse(store.getItem(key) || "null"); } catch (e) { return null; }
  }
  function write(store, key, val) {
    try { store.setItem(key, val); } catch (e) { /* private mode — the feature just degrades */ }
  }

  /* ---- icons ---- */
  /* Same visual family as the header's other icons: 24-box, currentColor, 2px round strokes. */
  var PATHS = {
    tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'
  };
  function icon(name) {
    var d = PATHS[name] || PATHS.tag;
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---- countdown ---------------------------------------------------------- */
  /* Recomputed once a MINUTE, never once a second. A seconds ticker on a 30px strip reads as
     a pop-up ad, and this bar has to look like the shop telling you something, not shouting. */
  function endsText(endsAt) {
    var left = Date.parse(endsAt) - Date.now();
    if (!(left >= 0)) return null;      // inclusive, to match resolveActive() on the server
    var mins = Math.floor(left / 60000);
    var hours = Math.floor(mins / 60);
    var days = Math.floor(hours / 24);
    if (days >= 2) return "ends in " + days + " days";
    if (hours >= 24) return "ends in 1 day";
    if (hours >= 2) return "ends in " + hours + " hours";
    if (hours >= 1) return "ends in 1 hour";
    if (mins >= 2) return "ends in " + mins + " minutes";
    if (mins >= 1) return "ends in 1 minute";
    return "ending now";
  }

  /* ---- prices ------------------------------------------------------------- */
  /* Match Stripe's own arithmetic: it discounts the amount in CENTS and rounds the discount,
     so working in dollars and rounding the result can land a cent away from what the buyer is
     actually charged. A price on the page that disagrees with checkout is worse than no price. */
  function salePrice(usd, pct) {
    var cents = Math.round(Number(usd) * 100);
    if (!(cents > 0)) return null;
    return (cents - Math.round((cents * pct) / 100)) / 100;
  }
  function money(n) { return "$" + n.toFixed(2); }

  function renderPrices(sale) {
    var nodes = document.querySelectorAll("[data-usd]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var now = salePrice(el.getAttribute("data-usd"), sale.percent);
      if (now === null) continue;
      var list = money(Number(el.getAttribute("data-usd")));
      el.textContent = money(now);

      // data-usd-plain: change the FIGURE and nothing else. For prices written into running
      // prose or into a call-to-action button ("Get the bundle — $39.99"), where a struck price
      // and a code pill injected beside them would break the sentence or the button. The offer
      // is already stated by the bar and by the product cards; here the only requirement is that
      // the number matches what checkout will actually charge.
      if (el.hasAttribute("data-usd-plain")) continue;

      // The row already carries the RRP and a "Save 53%" pill. During a sale the sale is the
      // message, so those two slots are reused: struck price becomes today's list price, and
      // the pill becomes the code. Originals stay in the attributes, so nothing is lost and
      // running this twice is harmless.
      var row = el.parentNode;
      if (!row) continue;
      var was = row.querySelector(".price-was");
      if (!was) {
        was = document.createElement("span");
        was.className = "price-was";
        el.parentNode.insertBefore(was, el.nextSibling);
      }
      was.textContent = list;
      var pill = row.querySelector(".price-save");
      if (!pill) {
        pill = document.createElement("span");
        pill.className = "price-save";
        // Beside the price, NOT appended to the row. On the v1–v5 list the row also holds the
        // Buy button, and appending would strand the code on the far side of it.
        was.parentNode.insertBefore(pill, was.nextSibling);
      }
      pill.textContent = sale.percent + "% off · " + sale.code;
    }
  }

  /* ---- the bar ------------------------------------------------------------ */
  function hide() {
    if (timer) { clearInterval(timer); timer = null; }
    bar.hidden = true;
    bar.innerHTML = "";
    document.documentElement.classList.remove("has-sale");
  }

  function render(sale, animate) {
    var ends = endsText(sale.endsAt);
    if (!ends && !sale.preview) { hide(); return; }

    bar.innerHTML =
      '<a class="sale-bar-msg" href="' + esc(sale.url || "/products.html") + '">' +
        icon(sale.icon) +
        "<span><strong>" + esc(sale.title) + "</strong> — " + sale.percent + "% off</span>" +
      "</a>" +
      '<span class="sale-bar-lead">Enter code</span>' +
      '<button type="button" class="sale-bar-code" aria-label="Copy the code ' + esc(sale.code) +
        '">' + esc(sale.code) + "</button>" +
      (ends ? '<span class="sale-bar-ends">· ' + esc(ends) + "</span>" : "") +
      '<button type="button" class="sale-bar-close" aria-label="Dismiss this sale notice">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
        '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';

    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Current sale");
    bar.hidden = false;
    document.documentElement.classList.add("has-sale");
    if (animate) {
      bar.classList.add("sale-bar-enter");
      setTimeout(function () { bar.classList.remove("sale-bar-enter"); }, 400);
    }

    bar.querySelector(".sale-bar-msg").addEventListener("click", function () { track("sale_bar_click"); });

    var codeBtn = bar.querySelector(".sale-bar-code");
    codeBtn.addEventListener("click", function () {
      copy(sale.code, codeBtn);
      track("sale_code_copy");
    });

    bar.querySelector(".sale-bar-close").addEventListener("click", function () {
      write(localStorage, DISMISS_KEY, sale.id);
      hide();
    });

    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var t = endsText(sale.endsAt);
      if (!t) { hide(); return; }          // the sale ends on screen, with no reload
      var slot = bar.querySelector(".sale-bar-ends");
      if (slot) slot.textContent = "· " + t;
    }, 60000);

    renderPrices(sale);
  }

  function copy(text, btn) {
    var done = function () {
      var was = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = was; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else {
      fallback(text, done);
    }
  }
  function fallback(text, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) { /* leave the code on screen to read — it is short on purpose */ }
  }

  function track(name) {
    // Consent Mode starts denied, so this leaves the browser only if the visitor accepted.
    try { if (typeof gtag === "function") gtag("event", name); } catch (e) {}
  }

  /* ---- decide what to show ------------------------------------------------ */
  function show(sale, animate) {
    if (!sale || !sale.active) { hide(); return; }
    var dismissed = null;
    try { dismissed = localStorage.getItem(DISMISS_KEY); } catch (e) {}
    // Keyed to the sale id, so closing one sale never hides the next one.
    if (!sale.preview && dismissed === sale.id) { hide(); return; }
    render(sale, animate);
  }

  // Paint from the cached copy first. The inline snippet in the header partial has already
  // reserved the 30px, so this fills it rather than moving the page.
  var cached = readJSON(sessionStorage, CACHE_KEY);
  if (cached && cached.active) show(cached, false);

  // A local escape hatch for verification: the preview server is a plain static file server
  // and does not run /api/*, so there is no other way to see the bar without deploying.
  if (window.__SALE_PREVIEW__) { show(window.__SALE_PREVIEW__, !cached); return; }

  var previewId = (/[?&]salepreview=([^&#]+)/.exec(location.search) || [])[1];
  var url = previewId ? API + "?preview=" + encodeURIComponent(previewId) : API;

  fetch(url, { headers: { Accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      if (!previewId) write(sessionStorage, CACHE_KEY, JSON.stringify(d));
      show(d, !(cached && cached.active));
    })
    .catch(function () { /* no banner is the correct answer when the feed cannot be reached */ });
})();
