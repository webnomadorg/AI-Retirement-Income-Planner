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
      if (e.target.closest("a") && window.innerWidth <= 1420) {
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
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-visible"); obs.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
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

/* ---- Newsletter signup form (newsletter.html) ---- */
(function () {
  var form = document.getElementById('newsletterForm');
  if (!form) return;
  var notice = document.getElementById('nl-notice');
  var success = document.getElementById('nl-success');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');
    if (notice) { notice.textContent = ''; notice.classList.remove('visible'); }

    var name  = (document.getElementById('nl-name')  || {}).value || '';
    var email = (document.getElementById('nl-email') || {}).value || '';
    var honey = (document.getElementById('nl-honey') || {}).value || '';
    var origHtml = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = 'Sending…';

    fetch('/api/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, _honey: honey }),
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
