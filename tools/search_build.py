#!/usr/bin/env python3
"""Build the sitewide search index from the generated pages.

The site is static, so search runs entirely in the browser against a JSON index built here.
This script extracts the *rendered* text of every searchable page — it reads the generated
HTML, not the markdown or hand-written sources, so the index can never claim text that is
not actually on the page.

Output (two files, so the smaller one can answer most queries before the larger arrives):
    assets/search/core.json   the marketing pages
    assets/search/blog.json   the blog posts

Both live under assets/ deliberately. Anything written into blog/ is deleted on the next
run of blog_build.py, whose prune_stale_output() keeps only <slug>.html and feed.xml.

Run from anywhere:  python Website/tools/search_build.py
Verify only:        python Website/tools/search_build.py --check

--check writes nothing and exits 1 if the committed index no longer matches the pages. A
stale index is a silent failure with teeth: search would keep confidently quoting text that
has since been edited away. sync.ps1 runs it before every push.

ORDER MATTERS. This reads generated HTML, so it must run AFTER both other builds:
    python Website/tools/page_build.py
    python Website/tools/blog_build.py
    python Website/tools/search_build.py
"""

import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from page_build import PAGES, BARE_PAGES  # noqa: E402  (registry, not behaviour)

WEBSITE = Path(__file__).resolve().parents[1]
OUT_DIR = WEBSITE / "assets" / "search"

# Pages that exist but are deliberately NOT searchable. Anything found on disk and listed
# neither here nor in page_build's PAGES/BARE_PAGES fails the build — see check_registry().
EXCLUDE = {
    # Post-conversion and form-only dead ends: landing on them from a search is a wrong turn.
    "404.html",
    "thanks.html",
    "thank-you.html",
    "share.html",
    "search.html",          # the results page itself
    # A 6 MB copy of the planner app, not prose.
    "demo/index.html",
    # Chrome-free lead-magnet landing pages. The whole point is a single exit, so dropping a
    # visitor into one mid-journey would strand them. Their content is covered by newsletter.html.
    "get/ebook.html",
    "get/checklist.html",
    "get/questions.html",
    "get/abroad.html",
}

# Generated pages that carry site chrome but are not in page_build's PAGES (blog_build owns them).
GENERATED = {"blog.html"}

# Directories that hold no servable pages: sources, tooling, generated app copies, deps.
SKIP_DIRS = {"blog", "demo", "blog-src", "partials", "tools", "assets", "api", "data",
             "node_modules", "Source Files", ".git", ".vercel"}

# Elements whose text is never page content.
SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "select", "option"}
# Chrome that happens to sit inside <main>. Breadcrumbs put "Home" on every page, and the
# TOC/series nav duplicate headings we already index — which would double their weight.
# The rest are the per-post template blocks (eBook capture, planner CTA, related links): the
# SAME words on all 55 posts, so indexing them meant 175 near-identical records competing with
# real content — a search for "test this with your own numbers" matched every article at once.
SKIP_CLASSES = {"post-toc", "post-series-nav", "skip", "crumb", "post-breadcrumb",
                "post-capture", "cta-band", "related-posts"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
             "param", "source", "track", "wbr"}

# 0 = keep the full section text. The lever if blog.json ever feels heavy over the wire:
# set it to e.g. 900 and each section keeps only its opening — trades recall for bytes,
# and touches nothing at runtime.
SECTION_CHAR_CAP = 0

WS_RE = re.compile(r"\s+")
POSTS_RE = re.compile(r"^var POSTS = (\[.*?\n\]);$", re.S | re.M)


class PageText(HTMLParser):
    """Pull <main>'s text out of a built page, split into sections at each h2/h3.

    Sections are what makes a result useful: each one carries the heading's `id`, so a hit
    links to the exact place on the page rather than dumping the reader at the top of a
    7,000-word changelog.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.main_depth = None
        self.skip_depth = None
        self.h1_depth = None
        self.head_depth = None
        self.details_id = ""
        self.title = ""
        self.sections = [{"h": "", "a": "", "parts": []}]

    # -- helpers ----------------------------------------------------------------
    @property
    def _live(self):
        return self.main_depth is not None and self.skip_depth is None

    def _skippable(self, tag, attrs):
        if tag in SKIP_TAGS:
            return True
        a = dict(attrs)
        if a.get("aria-hidden") == "true" or "hidden" in a:
            return True
        return bool(SKIP_CLASSES & set((a.get("class") or "").split()))

    # -- parser hooks -----------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            return
        self.depth += 1
        if tag == "main" and self.main_depth is None:
            self.main_depth = self.depth
            return
        if self.main_depth is None:
            return
        if self.skip_depth is None and self._skippable(tag, attrs):
            self.skip_depth = self.depth
            return
        if not self._live:
            return
        if tag == "h1" and self.h1_depth is None:
            self.h1_depth = self.depth          # captured as the page title, not as body text
        elif tag in ("h2", "h3"):
            self.sections.append({"h": "", "a": dict(attrs).get("id", ""), "parts": []})
            self.head_depth = self.depth
        elif tag == "details":
            # The id lives on the <details>, not the <summary> — that is the element a reader
            # needs scrolled into view, and it is what heading_ids.py names.
            self.details_id = dict(attrs).get("id", "")
        elif tag == "summary":
            # An accordion question is its own section. Without this the FAQ's 22 questions all
            # collapse into whichever h2 sat above them, so a hit for "refund" was reported under
            # a heading like "1-on-1 sessions".
            self.sections.append({"h": "", "a": self.details_id, "parts": []})
            self.head_depth = self.depth
        else:
            self.sections[-1]["parts"].append(" ")   # keep block text from running together

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if self.skip_depth == self.depth:
            self.skip_depth = None
        elif self.h1_depth == self.depth:
            self.h1_depth = None
        elif self.head_depth == self.depth:
            self.head_depth = None
        elif self.main_depth == self.depth:
            self.main_depth = None
        elif self._live:
            self.sections[-1]["parts"].append(" ")
        self.depth = max(0, self.depth - 1)

    def handle_data(self, data):
        if not self._live:
            return
        if self.h1_depth is not None:
            self.title += data
        elif self.head_depth is not None:
            self.sections[-1]["h"] += data
        else:
            self.sections[-1]["parts"].append(data)


def tidy(s):
    return WS_RE.sub(" ", s).strip()


def extract(path):
    """-> (page_title, [{h, a, b}, ...]) for one built page. Empty sections dropped."""
    p = PageText()
    p.feed(path.read_text(encoding="utf-8"))
    title = tidy(p.title)
    out = []
    for sec in p.sections:
        body = tidy("".join(sec["parts"]))
        if SECTION_CHAR_CAP and len(body) > SECTION_CHAR_CAP:
            body = body[:SECTION_CHAR_CAP].rsplit(" ", 1)[0]
        heading = tidy(sec["h"])
        if not body and not heading:
            continue
        out.append({"h": heading, "a": sec["a"], "b": body})
    return title, out


def url_for(rel):
    return "/" if rel == "index.html" else "/" + rel


def page_title_of(path, extracted):
    """The <h1> if the page has one, else the <title> minus the site suffix."""
    if extracted:
        return extracted
    m = re.search(r"<title>(.*?)</title>", path.read_text(encoding="utf-8"), re.S)
    return tidy(re.split(r"\s+[|—]\s+", m.group(1))[0]) if m else path.stem


def records_for(path, rel, kind, category=""):
    title, sections = extract(path)
    title = page_title_of(path, title)
    recs = []
    for sec in sections:
        recs.append({"u": url_for(rel), "a": sec["a"], "t": title,
                     "h": sec["h"] or title, "b": sec["b"], "k": kind, "c": category})
    return recs


def blog_categories():
    """slug -> category label, read from the POSTS array blog_build.py inlines into blog.html."""
    blog = WEBSITE / "blog.html"
    if not blog.exists():
        return {}
    m = POSTS_RE.search(blog.read_text(encoding="utf-8"))
    if not m:
        return {}
    return {p["slug"]: p.get("category", "") for p in json.loads(m.group(1))}


def discover():
    """Searchable pages, found by glob rather than by registry.

    Default-INCLUDE is the whole point. Reading page_build.PAGES instead would mean a page
    someone forgot to register is silently unsearchable — the same shape of failure as
    updates.html shipping without the theme bootstrap, and just as invisible. This way the
    worst case is a new page turning up in search a little early, which is one line to fix.
    """
    root = sorted(p.name for p in WEBSITE.glob("*.html") if p.name not in EXCLUDE)
    posts = sorted("blog/" + p.name for p in (WEBSITE / "blog").glob("*.html"))
    return root, posts


def check_registry():
    """Every page on disk must be accounted for somewhere. Unknown page -> build fails.

    Nothing else catches a root page missing from page_build.PAGES, and that has already
    cost this site once. Since this build has to walk every page anyway, it may as well be
    the thing that notices.
    """
    known = set(PAGES) | set(BARE_PAGES) | EXCLUDE | GENERATED
    found = {p.name for p in WEBSITE.glob("*.html")}
    for sub in WEBSITE.iterdir():
        if sub.is_dir() and sub.name not in SKIP_DIRS and not sub.name.startswith("."):
            found |= {f"{sub.name}/{p.name}" for p in sub.glob("*.html")}
    unknown = sorted(found - known)
    if unknown:
        print("search_build: unknown page(s) — every page must be accounted for:\n")
        for u in unknown:
            print("    - %s" % u)
        print("\n  add each to page_build.PAGES      (gets site chrome + is checked), or")
        print("  add each to search_build.EXCLUDE  (deliberately not searchable)")
        sys.exit(1)


def build():
    check_registry()
    cats = blog_categories()
    root, posts = discover()

    core = []
    for rel in root:
        core += records_for(WEBSITE / rel, rel, "page")

    blog = []
    for rel in posts:
        slug = Path(rel).stem
        blog += records_for(WEBSITE / rel, rel, "post", cats.get(slug, ""))

    return core, blog


def serialise(recs):
    return json.dumps(recs, ensure_ascii=False, separators=(",", ":")) + "\n"


def summarise(name, recs, text):
    words = sum(len(r["b"].split()) for r in recs)
    print("  %-24s %4d sections  %7d words  %6.1f KB"
          % (name, len(recs), words, len(text.encode("utf-8")) / 1024))


def main():
    checking = "--check" in sys.argv
    core, blog = build()
    files = [("core.json", core), ("blog.json", blog)]

    if checking:
        stale = []
        for name, recs in files:
            path = OUT_DIR / name
            fresh = serialise(recs)
            if not path.exists():
                stale.append("%s is MISSING" % name)
            elif path.read_text(encoding="utf-8") != fresh:
                stale.append("%s no longer matches the pages" % name)
        if stale:
            print("search_build --check: STALE SEARCH INDEX — the site would return results "
                  "quoting text that is no longer on the page.\n")
            for s in stale:
                print("    - %s" % s)
            print("\n    fix: python Website/tools/search_build.py")
            print("    (run page_build.py and blog_build.py first — this reads their output)")
            return 1
        pages = len({r["u"] for r in core} | {r["u"] for r in blog})
        print("search_build --check: OK — index matches %d page(s), %d section(s)."
              % (pages, len(core) + len(blog)))
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, recs in files:
        text = serialise(recs)
        (OUT_DIR / name).write_text(text, encoding="utf-8")
        summarise("assets/search/" + name, recs, text)
    print("Done. %d searchable section(s)." % (len(core) + len(blog)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
