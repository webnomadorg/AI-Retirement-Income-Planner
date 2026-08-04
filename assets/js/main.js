/* WebNomad Studio — site interactions. Vanilla JS, no dependencies. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Mobile navigation toggle ---- */
  var toggle = document.querySelector(".nav-toggle");
  var panel = document.getElementById("nav-panel");
  if (toggle && panel) {
    toggle.addEventListener("click", function () {
      var open = panel.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    panel.addEventListener("click", function (e) {
      if (e.target.closest("a") && window.innerWidth <= 1500) {
        panel.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---- Sticky header shadow on scroll ---- */
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      if (window.scrollY > 12) header.classList.add("scrolled");
      else header.classList.remove("scrolled");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---- Scroll reveal (progressive enhancement) ---- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (revealEls.length && "IntersectionObserver" in window && !reduceMotion) {
    document.documentElement.classList.add("reveal-on");
    // stagger groups: children of [data-stagger] get incremental delays
    document.querySelectorAll("[data-stagger]").forEach(function (group) {
      Array.prototype.slice.call(group.children).forEach(function (child, i) {
        if (child.classList.contains("reveal")) child.style.transitionDelay = (i * 0.07) + "s";
      });
    });
    // threshold must stay 0, and the bottom inset must stay in PIXELS. A ratio threshold is a
    // proportion of the element, so on a tall block it becomes a huge scroll distance: the changelog
    // on updates.html is one 6,500px .reveal, where the old threshold of 0.12 demanded 784px of it
    // on screen before the text faded in — you scrolled into a long blank stretch. A percentage
    // rootMargin had the same flaw in miniature. Fixed pixels make the trigger height-independent,
    // so every element reveals just as it reaches the viewport, whatever its size.
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-visible"); obs.unobserve(en.target); }
      });
    }, { threshold: 0, rootMargin: "0px 0px -60px 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---- Count-up for [data-count] when it scrolls into view ---- */
  var counters = Array.prototype.slice.call(document.querySelectorAll("[data-count]"));
  if (counters.length) {
    var run = function (el) {
      var target = parseFloat(el.getAttribute("data-count"));
      if (reduceMotion) { el.textContent = target; return; }
      var dur = 2600, start = performance.now();
      var step = function (now) {
        var p = Math.min(1, (now - start) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased);
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = target;
      };
      requestAnimationFrame(step);
    };
    if ("IntersectionObserver" in window) {
      var cio = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (en) { if (en.isIntersecting) { run(en.target); obs.unobserve(en.target); } });
      }, { threshold: 0.6 });
      counters.forEach(function (el) { cio.observe(el); });
    } else { counters.forEach(run); }
  }

  /* ---- Interactive theme gallery ---- */
  document.querySelectorAll(".theme-gallery").forEach(function (gal) {
    var stage = gal.querySelector(".tg-stage img");
    var meta = gal.querySelector(".tg-meta");
    var tabs = gal.querySelectorAll(".tg-tab");
    var modeBtns = gal.querySelectorAll(".tg-toggle button");
    if (!stage) return;
    var mode = "Light";
    var current = tabs[0];
    var seq = 0;
    var stageWrap = gal.querySelector(".tg-stage");
    var swap = function () {
      var theme = current.getAttribute("data-theme");
      var label = current.getAttribute("data-theme");
      var m = mode;
      var src = "assets/img/themes/" + theme + " Theme - " + m + ".jpeg";
      var token = ++seq;
      stageWrap.classList.add("swapping");
      var pre = new Image();
      pre.onload = function () {
        if (token !== seq) return;           // a newer selection superseded this one
        stage.src = src;
        stage.alt = label + " theme, " + m.toLowerCase() + " mode";
        if (meta) meta.innerHTML = "<strong>" + label + "</strong> — " + m.toLowerCase() + " mode";
        requestAnimationFrame(function () { stageWrap.classList.remove("swapping"); });
      };
      pre.onerror = function () { if (token === seq) stageWrap.classList.remove("swapping"); };
      pre.src = src;
    };
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
        t.classList.add("active"); t.setAttribute("aria-selected", "true");
        current = t; swap();
      });
    });
    modeBtns.forEach(function (b) {
      b.addEventListener("click", function () {
        modeBtns.forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active"); mode = b.getAttribute("data-mode"); swap();
      });
    });
  });

  /* ---- FAQ uses native <details> toggle (no JS animation) ---- */

  /* ---- Video facade: click to load the real player ---- */
  document.querySelectorAll(".video-facade").forEach(function (fac) {
    var load = function () {
      var src = fac.getAttribute("data-embed");
      if (!src) return;
      var iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.title = fac.getAttribute("data-title") || "Video";
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.setAttribute("allowfullscreen", "");
      fac.innerHTML = "";
      fac.appendChild(iframe);
    };
    fac.addEventListener("click", load);
    fac.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); load(); }
    });
  });

  /* ---- Lightbox for screenshots (figures with class "shot") ---- */
  var box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Enlarged screenshot");
  box.innerHTML = '<button class="lightbox-close" aria-label="Close">&times;</button><img alt="">';
  document.body.appendChild(box);
  var boxImg = box.querySelector("img");
  var closeBtn = box.querySelector(".lightbox-close");

  function openBox(src, alt) {
    boxImg.src = src; boxImg.alt = alt || "";
    box.classList.add("open"); document.body.style.overflow = "hidden"; closeBtn.focus();
  }
  function closeBox() {
    box.classList.remove("open"); document.body.style.overflow = ""; boxImg.src = "";
  }
  document.querySelectorAll("figure.shot").forEach(function (fig) {
    var img = fig.querySelector("img");
    if (!img) return;
    fig.setAttribute("tabindex", "0");
    fig.setAttribute("role", "button");
    fig.setAttribute("aria-label", "Enlarge: " + (img.alt || "screenshot"));
    var open = function () { openBox(img.getAttribute("data-full") || img.src, img.alt); };
    fig.addEventListener("click", open);
    fig.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  box.addEventListener("click", function (e) { if (e.target === box || e.target === closeBtn) closeBox(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && box.classList.contains("open")) closeBox(); });

  /* ---- Back-to-top FAB (mirrors the planner's scroll-top-fab) ---- */
  var fab = document.createElement("button");
  fab.id = "scroll-top-fab";
  fab.className = "scroll-top-fab";
  fab.type = "button";
  fab.title = "Back to top";
  fab.setAttribute("aria-label", "Scroll to top");
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  document.body.appendChild(fab);
  fab.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });
  var onFabScroll = function () {
    fab.classList.toggle("visible", window.scrollY > 400);
  };
  onFabScroll();
  window.addEventListener("scroll", onFabScroll, { passive: true });

  /* ---- Footer year ---- */
  var yr = document.getElementById("year");
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---- Dark mode toggle ---- */
  var darkBtn = document.getElementById("darkToggle");
  if (darkBtn) {
    darkBtn.addEventListener("click", function () {
      var isDark = document.documentElement.classList.toggle("dark");
      localStorage.setItem("wn-dark", isDark ? "1" : "0");
    });
  }

  /* ---- Colour theme selector ---- */
  var themeSel = document.getElementById("themeSelect");
  if (themeSel) {
    // Sync selector to whatever the inline script applied on load
    themeSel.value = document.documentElement.getAttribute("data-theme") || "";
    themeSel.addEventListener("change", function () {
      var theme = themeSel.value;
      if (theme) document.documentElement.setAttribute("data-theme", theme);
      else document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("wn-theme", theme);
    });
  }
})();

/* ---- Contact form (contact.html) ---- */
(function () {
  var form = document.getElementById('contactForm');
  if (!form) return;
  var notice = document.getElementById('form-notice');
  var success = document.getElementById('form-success');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');
    if (notice) { notice.textContent = ''; notice.classList.remove('visible'); }

    var name    = (document.getElementById('cf-name')    || {}).value || '';
    var email   = (document.getElementById('cf-email')   || {}).value || '';
    var subject = (document.getElementById('cf-subject') || {}).value || '';
    var message = (document.getElementById('cf-message') || {}).value || '';
    var honey   = (document.getElementById('_honey')     || {}).value || '';
    var origHtml = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = 'Sending…';

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, subject: subject, message: message, _honey: honey }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (res.ok && res.data.ok) {
          form.style.display = 'none';
          if (success) success.classList.add('visible');
        } else {
          if (notice) {
            notice.textContent = (res.data && res.data.error) || 'Something went wrong. Please try again.';
            notice.classList.add('visible');
          }
          btn.disabled = false;
          btn.innerHTML = origHtml;
        }
      })
      .catch(function () {
        if (notice) {
          notice.textContent = 'Could not connect. Please check your internet connection and try again.';
          notice.classList.add('visible');
        }
        btn.disabled = false;
        btn.innerHTML = origHtml;
      });
  });
}());

/* ---- "Share your experience" prefill (contact.html#share) ----
   The post-purchase thanks page tells buyers to come back after a few weeks of real use,
   so the ask has to live somewhere permanent and findable — here, plus a footer link.
   Fills the normal contact form with the feedback questions and the permission block
   (see Plans/Testimonials-Pipeline.md — a quote is never published without that consent). */
(function () {
  var start = document.getElementById('shareStart');
  var subject = document.getElementById('cf-subject');
  var message = document.getElementById('cf-message');
  if (!start || !subject || !message) return;

  var TEMPLATE = [
    '1. What I was trying to work out when I bought it:',
    '',
    '',
    '2. What it showed me that I did not already know:',
    '',
    '',
    "3. Anything that frustrated me, or that I'd change:",
    '',
    '',
    '--- Happy to be quoted? (entirely optional) ---',
    'Only fill this in if you are comfortable with your words appearing on the website:',
    '',
    'Name to show (e.g. Dave R., or just a first name):',
    'Roughly where I am based (e.g. Colorado, or Kent UK):',
    'You may quote me on the website: yes / no'
  ].join('\n');

  function prefill(focus) {
    // never clobber something the visitor has already typed
    if (!message.value.trim()) message.value = TEMPLATE;
    if (!subject.value.trim()) subject.value = "How I'm getting on with the planner";
    if (focus) {
      message.scrollIntoView({ block: 'center', behavior: 'smooth' });
      message.focus({ preventScroll: true });
      message.setSelectionRange(0, 0);
    }
  }

  start.addEventListener('click', function (e) { e.preventDefault(); prefill(true); });
  // deep link from the footer / thanks page: contact.html#share
  if (location.hash === '#share') prefill(false);
}());

/* ---- Free-download signup forms ----
   Binds every form carrying data-newsletter, not one hard-coded id: the same handler serves
   newsletter.html, the /get/* landing pages and the capture card on all 54 blog posts.

   Each form declares:
     data-newsletter          marks it for this handler
     data-magnet="<key>"      which download to send (see MAGNETS in api/newsletter.js)
   Fields are found WITHIN the form, so several can coexist on one page without colliding.

   On success we leave for /thank-you.html instead of swapping in an inline panel. That gives
   a real URL to fire the Lead conversion on — which is what Facebook optimises against, and
   what an inline div can never provide. The inline #nl-success panel stays as the fallback
   for the case where the redirect is blocked. */
(function () {
  var forms = document.querySelectorAll('form[data-newsletter]');
  if (!forms.length) return;

  // Pairs the browser's fbq Lead with the server's Conversions API Lead so Meta counts one
  // conversion, not two. randomUUID needs a secure context; the fallback is only for
  // http:// previews and old browsers, where uniqueness matters less than not throwing.
  function newEventId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'lead-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10);
  }

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  }

  /* Facebook's own browser identifiers, forwarded so the server-side event can be matched.

     Sending only a hashed email leaves Meta guessing which person (and which ad click) a
     signup belongs to — event match quality sat at 5/10, and Events Manager flags weak fbc
     coverage as its top recommendation. `_fbp` identifies the browser; `_fbc` carries the ad
     click that brought them here. With those, a conversion can actually be attributed to the
     ad that caused it, which is what campaign optimisation runs on.

     Both are set by the Meta Pixel, which does not run until the visitor accepts the cookie
     banner — so for anyone who declined, these are simply absent and the event goes with the
     basics only. That is deliberate: declining should mean less is sent, not the same amount
     by another route. The fbclid fallback below is likewise gated on consent. */
  function fbIdentifiers() {
    var out = { fbp: readCookie('_fbp'), fbc: readCookie('_fbc') };
    if (!out.fbc) {
      // Arrived on an ad click but the pixel hasn't written _fbc yet (it lags the first
      // pageview). Meta's documented format is fb.1.<timestamp>.<fbclid>.
      var consented = false;
      try { consented = localStorage.getItem('wn-consent') === 'granted'; } catch (e) {}
      var clickId = '';
      try { clickId = new URLSearchParams(location.search).get('fbclid') || ''; } catch (e) {}
      if (consented && clickId) out.fbc = 'fb.1.' + Date.now() + '.' + clickId;
    }
    return out;
  }

  Array.prototype.forEach.call(forms, function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var magnet = form.getAttribute('data-magnet') || 'ebook';
      var btn    = form.querySelector('button[type="submit"]');
      // Scoped to this form so multiple capture points on one page stay independent.
      var notice  = form.querySelector('[data-nl-notice]')  || document.getElementById('nl-notice');
      var success = form.parentNode.querySelector('[data-nl-success]') || document.getElementById('nl-success');

      if (notice) { notice.textContent = ''; notice.classList.remove('visible'); }

      var name  = (form.querySelector('[name="name"]')   || {}).value || '';
      var email = (form.querySelector('[name="email"]')  || {}).value || '';
      var honey = (form.querySelector('[name="_honey"]') || {}).value || '';
      var eventId = newEventId();
      var fbIds = fbIdentifiers();
      var origHtml = btn ? btn.innerHTML : '';

      if (btn) { btn.disabled = true; btn.innerHTML = 'Sending…'; }

      function fail(msg) {
        if (notice) { notice.textContent = msg; notice.classList.add('visible'); }
        if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      }

      fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name, email: email, _honey: honey,
          magnet: magnet, eventId: eventId,
          fbp: fbIds.fbp, fbc: fbIds.fbc,
        }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (res.ok && res.data.ok) {
            // Trust the server's echo — it decides the real magnet after validating.
            var served = (res.data && res.data.magnet) || magnet;
            var eid    = (res.data && res.data.eventId) || eventId;
            try {
              window.location.assign(
                '/thank-you.html?m=' + encodeURIComponent(served) + '&eid=' + encodeURIComponent(eid)
              );
              return;
            } catch (navErr) { /* fall through to the inline panel */ }
            form.style.display = 'none';
            if (success) success.classList.add('visible');
          } else {
            fail((res.data && res.data.error) || 'Something went wrong. Please try again.');
          }
        })
        .catch(function () {
          fail('Could not connect. Please check your internet connection and try again.');
        });
    });
  });
}());
