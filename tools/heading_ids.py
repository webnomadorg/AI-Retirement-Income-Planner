#!/usr/bin/env python3
"""Give every <main> heading on the hand-written root pages a stable id.

Sitewide search links a result to the exact section it matched — but only if the heading
carries an `id`. Blog posts have them already (blog_build.py generates them for the post
TOC); the hand-written marketing pages mostly did not, so their results had to fall back
to a `#:~:text=` fragment, which Firefox ignores entirely.

This adds the missing ones, derived from the heading's own text, and never touches a
heading that already has an id. It is idempotent: a second run is a no-op.

⚠ This is the ONE tool that edits <main>. page_build.py deliberately rewrites only the
header and footer regions, because the page bodies are hand-maintained. Keep it that way —
this script inserts an attribute and changes no content, and it is not part of the routine
build. You need it only after ADDING a heading, and --check tells you when that is.

Run from anywhere:  python Website/tools/heading_ids.py
Verify only:        python Website/tools/heading_ids.py --check

--check writes nothing and exits 1 if any indexed page has a heading without an id, which
would silently degrade those search results. sync.ps1 runs it before every push.

Run this BEFORE search_build.py — adding ids changes the pages the index is built from.
"""

import re
import sys
import unicodedata
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from page_build import PAGES                      # noqa: E402
from search_build import EXCLUDE, VOID_TAGS       # noqa: E402

WEBSITE = Path(__file__).resolve().parents[1]
HEADINGS = ("h2", "h3")
ID_RE = re.compile(r'\bid="([^"]*)"')


def slugify(text):
    """Heading text -> a short, readable, ASCII anchor.

    Combining marks are stripped rather than replaced, so "café" becomes "cafe" and not
    "cafe-". Everything else non-alphanumeric collapses to a hyphen, which is what turns
    the non-breaking hyphen in "co‑pilot" into an ordinary one.
    """
    t = "".join(c for c in unicodedata.normalize("NFKD", text)
                if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")
    return t[:60].rstrip("-") or "section"


class Headings(HTMLParser):
    """Locate <main>'s anchorable section starts, with their text and any existing id.

    Two shapes, because the site uses two. Headings carry their own id. An accordion
    (<details><summary>) takes the id on the <details>, since that is what a reader needs
    scrolled into view — the FAQ's 22 questions are all summaries, and before this they
    were indistinguishable from whatever h2 happened to sit above them.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.main_depth = None
        self.open_at = None       # (line, col, tag) of the element currently being named
        self.has_id = False
        self.text = ""
        self.capturing = False
        self.pending = None       # a <details> waiting for its <summary> to name it
        self.found = []           # [(line, col, tag, text, has_id)]

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            return
        self.depth += 1
        if tag == "main" and self.main_depth is None:
            self.main_depth = self.depth
            return
        if self.main_depth is None:
            return
        has_id = any(k == "id" for k, _ in attrs)
        if tag in HEADINGS and self.open_at is None:
            self.open_at = self.getpos() + (tag,)
            self.has_id = has_id
            self.text = ""
            self.capturing = True
        elif tag == "details":
            self.pending = (self.getpos(), has_id)
        elif tag == "summary" and self.pending is not None and self.open_at is None:
            self.open_at = self.pending[0] + ("details",)
            self.has_id = self.pending[1]
            self.text = ""
            self.capturing = True
            self.pending = None

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if self.capturing and (tag in HEADINGS or tag == "summary"):
            line, col, name = self.open_at
            self.found.append((line, col, name, self.text.strip(), self.has_id))
            self.open_at = None
            self.capturing = False
        elif self.main_depth == self.depth:
            self.main_depth = None
        self.depth = max(0, self.depth - 1)

    def handle_data(self, data):
        if self.capturing:
            self.text += data


def line_offsets(html):
    offs, n = [0], 0
    for line in html.splitlines(keepends=True):
        n += len(line)
        offs.append(n)
    return offs


def plan_for(html):
    """-> [(absolute_offset, id)] for each <main> heading that needs one. Empty = nothing to do."""
    p = Headings()
    p.feed(html)
    taken = set(ID_RE.findall(html))     # every id already on the page, not just headings'
    offs = line_offsets(html)
    out = []
    for line, col, tag, text, has_id in p.found:
        if has_id or not text:
            continue
        base = slugify(text)
        slug, n = base, 2
        while slug in taken:
            slug = "%s-%d" % (base, n)
            n += 1
        taken.add(slug)
        start = offs[line - 1] + col            # points at "<"
        out.append((start + 1 + len(tag), slug))  # just past "<h2" / "<details"
    return out


def pages():
    return [n for n in PAGES if n not in EXCLUDE and (WEBSITE / n).exists()]


def main():
    checking = "--check" in sys.argv
    missing, changed, added = [], 0, 0

    for name in pages():
        path = WEBSITE / name
        html = path.read_text(encoding="utf-8")
        todo = plan_for(html)
        if not todo:
            continue
        if checking:
            missing.append((name, len(todo)))
            continue
        # Insert back-to-front so earlier offsets stay valid.
        for at, slug in sorted(todo, reverse=True):
            html = html[:at] + ' id="%s"' % slug + html[at:]
        path.write_text(html, encoding="utf-8")
        changed += 1
        added += len(todo)
        print("  %-46s +%d id(s)" % (name, len(todo)))

    if checking:
        if not missing:
            print("heading_ids --check: OK — every <main> heading on %d indexed page(s) "
                  "has an id." % len(pages()))
            return 0
        total = sum(n for _, n in missing)
        print("heading_ids --check: %d heading(s) across %d page(s) have no id, so search "
              "results for them cannot deep-link.\n" % (total, len(missing)))
        for name, n in missing[:12]:
            print("    - %-46s %d" % (name, n))
        if len(missing) > 12:
            print("    ... and %d more" % (len(missing) - 12))
        print("\n    fix: python Website/tools/heading_ids.py"
              "  (then re-run search_build.py — the pages changed)")
        return 1

    print("Done. %d id(s) added across %d page(s)." % (added, changed))
    if changed:
        print("NOTE: the pages changed — re-run "
              "`python Website/tools/search_build.py` to refresh the index.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
