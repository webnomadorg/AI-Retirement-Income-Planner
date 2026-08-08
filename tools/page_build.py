#!/usr/bin/env python3
"""Propagate the shared header + footer partials into the hand-maintained root pages.

The marketing site is static (Vercel, no server-side includes), so the shared chrome
is baked into each page at build time. Edit `partials/header.html` or
`partials/footer.html`, then run this script to push the change to every root page.
The blog pages get the same partials via `tools/blog_build.py`.

Each root page keeps its own <head> (title, meta, inline analytics) and <main>
content. This script only rewrites the two shared regions:
    <header class="site-header"> ... </header>
    <footer class="site-footer"> ... </footer>
It is idempotent: after a run the regions equal the partials, so running again is a
no-op. The header's {{CUR_*}} nav tokens are filled per page so the active nav item
gets aria-current="page".

Run from anywhere:  python Website/tools/page_build.py
Verify only:        python Website/tools/page_build.py --check

--check writes nothing and exits 1 if any page's chrome no longer matches the partials.
It covers the blog pages too, because they share the same partials via blog_build.py —
so it catches the one silent failure of baking chrome in: editing a partial and
forgetting to propagate. `sync.ps1` runs it before every Website push.

--check ALSO verifies every page carries the inline theme bootstrap in its <head> (see
THEME_BOOTSTRAP below). That is a different silent failure with the same shape: a page
built by hand rather than propagated, which then ignores the visitor's saved dark-mode
and colour-theme choice. Report-only — this script never writes <head>.
"""

import re
import sys
from pathlib import Path

WEBSITE = Path(__file__).resolve().parents[1]
PARTIALS = WEBSITE / "partials"

# root page filename -> header nav key to mark current ("" = not in the nav)
PAGES = {
    "index.html": "HOME",
    "products.html": "PRODUCTS",
    "features.html": "FEATURES",
    "how-it-works.html": "HOW",
    "getting-started.html": "START",
    "sessions.html": "SESSIONS",
    "technical.html": "",
    "updates.html": "",
    "faq.html": "FAQ",
    "contact.html": "",
    "share.html": "",
    "affiliates.html": "",
    "privacy.html": "",
    "terms.html": "",
    "software-terms.html": "",
    "newsletter.html": "",
    "demo.html": "",
    "retire-abroad.html": "",
    "cross-border-retirement-data-study.html": "",
    "cross-border-methodology.html": "",
    "about.html": "",
    "press.html": "",
    "thanks.html": "",
    "thank-you.html": "",
    "404.html": "",
}

# Landing pages for the free downloads. Deliberately NOT in PAGES: membership forces the full
# header and footer in, and the whole point of these is a single exit. But an unregistered page
# is also a page nothing ever checks, which is how updates.html silently shipped without the
# theme bootstrap. So they are registered here instead — skipped for chrome propagation, still
# verified for THEME_BOOTSTRAP by --check.
BARE_PAGES = [
    "get/ebook.html",
    "get/checklist.html",
    "get/questions.html",
    "get/abroad.html",
]

NAV_KEYS = ["HOME", "PRODUCTS", "FEATURES", "HOW", "START", "SESSIONS", "BLOG", "FAQ"]

HEADER_RE = re.compile(r'<header class="site-header">.*?</header>', re.S)
FOOTER_RE = re.compile(r'<footer class="site-footer">.*?</footer>', re.S)

# Inline <head> script that restores the visitor's dark-mode + colour-theme choice BEFORE
# first paint. assets/js/main.js only WRITES these keys (when the toggle is clicked or the
# selector changed) — it never reads them back on load — so this snippet is the SOLE restore
# path. A page missing it silently ignores the saved preference and always renders light with
# the default palette. updates.html shipped that way until 2026-07-25; it was the only page of
# 73 without it, because it was hand-written and the chrome propagation does not touch <head>.
# Keep byte-identical across every page. If it ever legitimately changes, update it here and
# in all pages together, or --check will (correctly) flag the ones left behind.
THEME_BOOTSTRAP = (
    "<script>!function(){var e=document.documentElement,"
    "t=localStorage.getItem('wn-theme'),d='1'===localStorage.getItem('wn-dark');"
    "t&&e.setAttribute('data-theme',t);d&&e.classList.add('dark')}();</script>"
)
THEME_KEY_RE = re.compile(r"localStorage\.getItem\('wn-dark'\)")
HEAD_RE = re.compile(r"<head\b.*?</head>", re.S)


def header_for(active):
    h = (PARTIALS / "header.html").read_text(encoding="utf-8").strip()
    for k in NAV_KEYS:
        h = h.replace("{{CUR_%s}}" % k,
                      ' aria-current="page"' if k == active else "")
    return h


def drift_in(path, active, footer):
    """Which shared regions of `path` no longer match the partials. [] = in sync.

    Read-only. Used by --check to catch the one real weakness of baking the chrome in:
    editing a partial and forgetting to propagate it, which fails silently.
    """
    html = path.read_text(encoding="utf-8")
    out = []
    h, f = HEADER_RE.search(html), FOOTER_RE.search(html)
    if not h or h.group(0) != header_for(active):
        out.append("header")
    if not f or f.group(0) != footer:
        out.append("footer")
    return out


def theme_problem_in(path):
    """"" if `path` restores the saved theme before first paint, else why it does not.

    Checks <head> specifically: the snippet has to run before the page paints, and since
    main.js never restores the preference, the same code lower down would not merely flash —
    it would never apply at all.
    """
    html = path.read_text(encoding="utf-8")
    head = HEAD_RE.search(html)
    if not head:
        return "no <head>"
    if THEME_BOOTSTRAP in head.group(0):
        return ""
    if THEME_KEY_RE.search(head.group(0)):
        return "variant snippet — does not match the canonical one-liner"
    if THEME_KEY_RE.search(html):
        return "snippet is outside <head> — it must run before first paint"
    return "no theme bootstrap — page will ignore the visitor's dark/theme choice"


def engine_problem():
    """Is assets/js/engine.js stale against the mobile build?

    retire-abroad.html runs the SAME calc engine as the paid planner, generated from
    src/03-app.js by mobile/build-engine.mjs. That script writes both copies in one pass, so
    they can only diverge if someone rebuilt one without the other (or hand-edited a copy).
    A stale website copy means a public page quietly disagreeing with the product people paid
    for — the one failure mode worth blocking a push over.

    Returns a message on drift, else None. Skips silently when mobile/ is absent (the Website
    repo can be cloned on its own) — there is nothing to compare against then.
    """
    web = WEBSITE / "assets" / "js" / "engine.js"
    ref = WEBSITE.parent / "mobile" / "www" / "engine.js"
    if not ref.exists():
        return None
    if not web.exists():
        return "assets/js/engine.js is MISSING — retire-abroad.html will not calculate"
    if web.read_bytes() != ref.read_bytes():
        return ("assets/js/engine.js differs from mobile/www/engine.js — "
                "run `npm run build:engine` in mobile/ (it writes both), then `npm run test:engine`")
    return None


def check():
    """Verify every generated page still matches the partials. Exit 1 on drift.

    Covers BOTH consumers: the root pages (rebuilt by this script) and the blog pages
    (rebuilt by blog_build.py), since a partial edit invalidates both. Also checks the
    inline theme bootstrap in every page's <head>, which nothing else guards, and that the
    shared calc engine bundle has not gone stale.
    """
    footer = (PARTIALS / "footer.html").read_text(encoding="utf-8").strip()
    stale_root, stale_blog, themeless = [], [], []

    for name, active in PAGES.items():
        f = WEBSITE / name
        if not f.exists():
            sys.exit("page_build --check: missing page %s" % name)
        d = drift_in(f, active, footer)
        if d:
            stale_root.append("%s (%s)" % (name, "+".join(d)))
        t = theme_problem_in(f)
        if t:
            themeless.append("%s — %s" % (name, t))

    # Blog landing + posts are generated by blog_build.py but share the same partials.
    blog_pages = [WEBSITE / "blog.html"] + sorted((WEBSITE / "blog").glob("*.html"))
    for f in blog_pages:
        if not f.exists():
            continue
        d = drift_in(f, "BLOG", footer)
        if d:
            stale_blog.append("%s (%s)" % (f.name, "+".join(d)))
        t = theme_problem_in(f)
        if t:
            themeless.append("%s — %s" % (f.name, t))

    # Bare landing pages carry no shared chrome to drift, but they DO need the theme
    # bootstrap — and being outside PAGES is exactly what would otherwise leave them
    # unexamined.
    bare_pages = []
    for name in BARE_PAGES:
        f = WEBSITE / name
        if not f.exists():
            sys.exit("page_build --check: missing landing page %s" % name)
        bare_pages.append(f)
        t = theme_problem_in(f)
        if t:
            themeless.append("%s — %s" % (name, t))

    total = len(PAGES) + len(blog_pages) + len(bare_pages)
    engine = engine_problem()

    if not stale_root and not stale_blog and not themeless and not engine:
        print("page_build --check: OK — %d page(s) match the partials, restore the saved "
              "theme, and the calc engine bundle is current." % total)
        return 0

    if engine:
        print("page_build --check: CALC ENGINE STALE — %s\n" % engine)
        if not stale_root and not stale_blog and not themeless:
            return 1

    if themeless:
        print("page_build --check: THEME BOOTSTRAP MISSING — %d page(s) will ignore the "
              "visitor's saved dark-mode / colour-theme choice.\n" % len(themeless))
        for s in themeless[:10]:
            print("    - %s" % s)
        if len(themeless) > 10:
            print("    ... and %d more" % (len(themeless) - 10))
        print("    fix: paste this as the last line of the page's <head>, byte-identical:")
        print("      %s\n" % THEME_BOOTSTRAP)
        if not stale_root and not stale_blog:
            return 1

    print("page_build --check: STALE CHROME — a partial was edited but not propagated.\n")
    if stale_root:
        print("  %d root page(s) out of sync:" % len(stale_root))
        for s in stale_root[:10]:
            print("    - %s" % s)
        if len(stale_root) > 10:
            print("    ... and %d more" % (len(stale_root) - 10))
        print("    fix: python Website/tools/page_build.py\n")
    if stale_blog:
        print("  %d blog page(s) out of sync:" % len(stale_blog))
        for s in stale_blog[:10]:
            print("    - %s" % s)
        if len(stale_blog) > 10:
            print("    ... and %d more" % (len(stale_blog) - 10))
        print("    fix: python Website/tools/blog_build.py\n")
    return 1


def main():
    if "--check" in sys.argv:
        sys.exit(check())
    footer = (PARTIALS / "footer.html").read_text(encoding="utf-8").strip()
    changed = 0
    for name, active in PAGES.items():
        f = WEBSITE / name
        if not f.exists():
            sys.exit("page_build: missing page %s" % name)
        html = f.read_text(encoding="utf-8")
        if not HEADER_RE.search(html):
            sys.exit('page_build: no <header class="site-header"> in %s' % name)
        if not FOOTER_RE.search(html):
            sys.exit('page_build: no <footer class="site-footer"> in %s' % name)
        new = HEADER_RE.sub(lambda m: header_for(active), html, count=1)
        new = FOOTER_RE.sub(lambda m: footer, new, count=1)
        if new != html:
            f.write_text(new, encoding="utf-8")
            changed += 1
            print("  updated: %s (nav=%s)" % (name, active or "-"))
        else:
            print("  unchanged: %s" % name)
    print("Done. %d of %d page(s) updated." % (changed, len(PAGES)))
    print("  (%d bare landing page(s) skipped by design — chrome-free, "
          "theme-checked by --check)" % len(BARE_PAGES))
    if changed:
        print("NOTE: blog pages share these partials — run "
              "`python Website/tools/blog_build.py` too if a partial changed.")


if __name__ == "__main__":
    main()
