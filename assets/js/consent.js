/* Cookie consent — gates Google Analytics + Meta (Facebook) Pixel until the
   visitor opts in. The choice is stored in localStorage('wn-consent') as
   'granted' or 'denied'. First-party Vercel Web Analytics is cookieless and
   loads independently of this. A "Cookie settings" link is added to the footer
   Support column so consent can be changed or withdrawn at any time. */
(function () {
  var GA_ID = 'G-6VX12DHPY3';
  var FB_ID = '2106222783607307';
  var KEY = 'wn-consent';

  function getChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setChoice(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  var loaded = false;
  function loadAnalytics() {
    if (loaded) return;
    loaded = true;

    // Google Analytics
    var ga = document.createElement('script');
    ga.async = true;
    ga.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(ga);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', GA_ID);

    // Meta Pixel
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', FB_ID);
    fbq('track', 'PageView');
  }

  function removeBanner() {
    var b = document.getElementById('cookie-banner');
    if (b) b.remove();
  }

  function accept() { setChoice('granted'); removeBanner(); loadAnalytics(); }
  function decline() { setChoice('denied'); removeBanner(); }

  function showBanner() {
    if (document.getElementById('cookie-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'cookie-banner';
    bar.className = 'cookie-banner';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.setAttribute('aria-live', 'polite');
    bar.innerHTML =
      '<div class="cookie-banner-text">' +
        '<strong>We value your privacy</strong>' +
        '<p>We use cookies only to measure site traffic and improve our content — ' +
        'your retirement plan always stays on your device. See our ' +
        '<a href="privacy.html">Privacy Policy</a>.</p>' +
      '</div>' +
      '<div class="cookie-banner-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-cc="decline">Decline</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-cc="accept">Accept</button>' +
      '</div>';
    document.body.appendChild(bar);
    bar.querySelector('[data-cc="accept"]').addEventListener('click', accept);
    bar.querySelector('[data-cc="decline"]').addEventListener('click', decline);
  }

  // Add a "Cookie settings" link to the footer Support column so the choice
  // can be revisited at any time.
  function addFooterLink() {
    if (document.getElementById('cookie-settings-link')) return;
    var cols = document.querySelectorAll('.footer-col');
    for (var i = 0; i < cols.length; i++) {
      var h = cols[i].querySelector('h4');
      if (h && h.textContent.trim() === 'Support') {
        var ul = cols[i].querySelector('ul');
        if (!ul) return;
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.id = 'cookie-settings-link';
        a.href = '#';
        a.textContent = 'Cookie settings';
        a.addEventListener('click', function (e) { e.preventDefault(); showBanner(); });
        li.appendChild(a);
        ul.appendChild(li);
        return;
      }
    }
  }

  // Load immediately if previously granted; the banner shows only when no
  // choice has been made yet.
  if (getChoice() === 'granted') loadAnalytics();

  function init() {
    addFooterLink();
    if (getChoice() == null) showBanner();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
