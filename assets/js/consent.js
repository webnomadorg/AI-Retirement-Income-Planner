/* Cookie consent — the Google Analytics + Meta (Facebook) Pixel tags live inline
   in every page's <head> (visible in the page source), where consent starts DENIED
   unless the visitor has already accepted. This script is only the consent SWITCH:
   accepting the banner upgrades consent, declining (or withdrawing later) keeps or
   returns it to denied. The choice is stored in localStorage('wn-consent') as
   'granted' or 'denied'. First-party Vercel Web Analytics is cookieless and loads
   independently of this. A "Cookie settings" link is added to the footer Support
   column so consent can be changed or withdrawn at any time.

   ⚠ This file is DEFERRED, so it runs after GA4 has already sent this page's
   page_view. It therefore must NOT be the place a saved 'granted' is restored —
   that has to happen synchronously in <head> (see partials/head-analytics.html),
   or the page_view goes out consent-denied and GA4 never counts the visit. What
   this file still owes GA4 is countPageView(): a first-time visitor who accepts
   had their page_view sent as denied a moment ago, and gtag will not re-send it. */
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

  // GA4 already sent this page's page_view with consent denied, and gtag never re-sends
  // it — so without this, a first-time visitor who accepts is simply missing from GA4.
  // The Meta pixel needs no equivalent: fbq queues events while revoked and flushes the
  // queued PageView on grant, which is why Facebook's counts were right all along.
  // Fires at most once, and never when the page already loaded with consent granted
  // (head-analytics.html restores that synchronously, so that page_view was counted).
  var countedAtLoad = (window.wnConsent === 'granted');
  var counted = false;
  function countPageView() {
    if (countedAtLoad || counted) return;
    counted = true;
    try {
      if (typeof window.gtag === 'function') window.gtag('event', 'page_view');
    } catch (e) {}
  }

  function accept() { setChoice('granted'); removeBanner(); applyConsent(true); countPageView(); }
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

  // Belt and braces: <head> already restored a saved 'granted' before the page_view
  // went out, so this is a no-op on a correctly built page. It stays because a page
  // that somehow ships without the head bootstrap should still honour the visitor's
  // choice for every event after this point, even though its page_view is lost.
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
