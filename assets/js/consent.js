/* Cookie consent — the Google Analytics + Meta (Facebook) Pixel tags live inline
   in every page's <head> (visible in the page source), but start with tracking
   consent DENIED via Google Consent Mode v2 and Meta's consent API. This script
   is only the consent SWITCH: accepting the banner upgrades consent, declining
   (or withdrawing later) keeps/returns it to denied. The choice is stored in
   localStorage('wn-consent') as 'granted' or 'denied'. First-party Vercel Web
   Analytics is cookieless and loads independently of this. A "Cookie settings"
   link is added to the footer Support column so consent can be changed or
   withdrawn at any time. */
(function () {
  var KEY = 'wn-consent';

  function getChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setChoice(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function applyConsent(granted) {
    var mode = granted ? 'granted' : 'denied';
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('consent', 'update', {
          ad_storage: mode,
          ad_user_data: mode,
          ad_personalization: mode,
          analytics_storage: mode
        });
      }
      if (typeof window.fbq === 'function') {
        window.fbq('consent', granted ? 'grant' : 'revoke');
      }
    } catch (e) {}
  }

  function removeBanner() {
    var b = document.getElementById('cookie-banner');
    if (b) b.remove();
  }

  function accept() { setChoice('granted'); removeBanner(); applyConsent(true); }
  function decline() { setChoice('denied'); removeBanner(); applyConsent(false); }

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
        '<a href="/privacy.html">Privacy Policy</a>.</p>' +
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

  // Upgrade consent immediately if previously granted; the banner shows only
  // when no choice has been made yet.
  if (getChoice() === 'granted') applyConsent(true);

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
