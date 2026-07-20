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
    "faq.html": "FAQ",
    "contact.html": "",
    "affiliates.html": "",
    "privacy.html": "",
    "terms.html": "",
    "newsletter.html": "",
    "demo.html": "",
    "about.html": "",
    "thanks.html": "",
    "404.html": "",
}

# NOTE: test-checkout.html is intentionally NOT listed — it's a temporary, unlinked
# standalone page (no shared chrome) removed after the $1 pipeline test.

NAV_KEYS = ["HOME", "PRODUCTS", "FEATURES", "HOW", "START", "SESSIONS", "BLOG", "FAQ"]

HEADER_RE = re.compile(r'<header class="site-header">.*?</header>', re.S)
FOOTER_RE = re.compile(r'<footer class="site-footer">.*?</footer>', re.S)


def header_for(active):
    h = (PARTIALS / "header.html").read_text(encoding="utf-8").strip()
    for k in NAV_KEYS:
        h = h.replace("{{CUR_%s}}" % k,
                      ' aria-current="page"' if k == active else "")
    return h


def main():
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


if __name__ == "__main__":
    main()
