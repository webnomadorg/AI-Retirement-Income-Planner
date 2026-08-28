#!/usr/bin/env python3
"""Blog build for the AI Retirement Income Planner marketing site.

Assembles static blog pages from Markdown sources + shared partials:

  blog-src/posts/*.md      -> blog/<slug>.html   (flat files — same .html URL style as
                              the rest of the site; no directory-index URLs anywhere)
  blog-src/templates/*.html   page skeletons with {{TOKENS}}
  partials/*.html             shared header / footer / analytics head
  Blog Posts/Images/*.png  -> assets/img/blog/<slug>-<n>.webp (+ -thumb for card grids)

Also regenerates: blog.html at the site root (landing page with search/filter),
blog/feed.xml (RSS), and the blog block inside sitemap.xml. After building, every
internal href on the generated pages is checked against the files on disk and the
build FAILS on a broken link — never link a post that is not published yet.

Run from anywhere:  python Website/tools/blog_build.py
Requires: python-markdown (pip install markdown). Pillow needed only when
source images changed (pip install Pillow).

Markdown front matter = the `**Key:** value` lines before the first `## `
heading (`# Title` line gives the H1). Recognised keys, beyond the SEO ones
already present in the drafted posts:

  **Category:**          explicit category label (else derived from **Cluster:**)
  **Published:**         YYYY-MM-DD (required)
  **Updated:**           YYYY-MM-DD (optional)
  **Draft:** true        render + list with a "Draft preview" badge, but
                         noindex and excluded from sitemap.xml and feed.xml
  **Image source base:** basename of images in the images dir (defaults to
                         the .md filename); image n = "<base> <n>.png|jpg|jpeg|webp"
  **Image <n> alt:**     alt text for image n  (n is not capped — 1, 2, ... 10, 11, ...)

Body markers:
  [IMAGE <anything> <n>]        -> <figure> with assets/img/blog/<slug>-<n>.webp
  [IMAGE PLACEHOLDER - ...]     -> kept as an HTML comment (future screenshot)

Sections whose H2 matches PRODUCTION_SECTIONS are stripped from the page and
saved to blog-src/promo/<slug>-promo.md (Facebook snippets, newsletter copy...).
The "CTA Blocks" section feeds the on-page CTA boxes instead of rendering as prose.
"""

import datetime
import json
import re
import sys
from pathlib import Path

try:
    import markdown
except ImportError:
    sys.exit("The 'markdown' package is required:  pip install markdown")

WEBSITE = Path(__file__).resolve().parents[1]
POSTS_DIR = WEBSITE / "blog-src" / "posts"
TEMPLATES = WEBSITE / "blog-src" / "templates"
PARTIALS = WEBSITE / "partials"
OUT_DIR = WEBSITE / "blog"
IMG_OUT = WEBSITE / "assets" / "img" / "blog"
PROMO_DIR = WEBSITE / "blog-src" / "promo"
SITEMAP = WEBSITE / "sitemap.xml"
DEFAULT_IMAGES_DIR = WEBSITE.parent / "Blog Posts" / "Images"

SITE = "https://airetirementincomeplanner.com"
BLOG_TITLE = "AI Retirement Income Planner Blog"

# Cluster (from the content strategy docs) -> (category slug, short label)
CLUSTER_TO_CATEGORY = {
    "retirement income planning": ("retirement-income", "Retirement Income"),
    "social security and survivor planning": ("social-security", "Social Security"),
    "tax-aware retirement planning": ("taxes-roth", "Taxes & Roth"),
    "healthcare costs in retirement": ("healthcare", "Healthcare"),
    "withdrawal strategies and sequence risk": ("withdrawals-risk", "Withdrawals & Risk"),
    "retirement planning software and tool comparisons": ("software", "Software Comparisons"),
    "ai retirement planning": ("ai-retirement", "AI & Retirement"),
    "expat and international retirement": ("expat", "Expat & International"),
    "planner tutorials": ("planner-howto", "Planner How-To"),
    "already retired": ("already-retired", "Already Retired"),
    # Pillar series derived from the companion eBook "Build a Retirement Plan You Can Question"
    "build a plan you can question": ("planning-framework", "Planning Framework"),
}
CATEGORY_LABEL_TO_SLUG = {label: slug for slug, label in CLUSTER_TO_CATEGORY.values()}

# Which free download each post offers, by category slug. Before this existed only 15 of the
# 54 posts carried any email capture at all, so most search traffic arrived, read, and left
# with no way to stay in touch.
#
# The offer is matched to what the reader is already reading — someone working through a
# tutorial wants the input checklist, someone reading about retiring abroad wants the
# cross-border guide. A generic "join our newsletter" on all 54 converts worse than a
# relevant one, and costs the same to serve.
#
# Keys are category slugs from CLUSTER_TO_CATEGORY; values are magnet keys from MAGNETS in
# lib/magnets.mjs. Anything unlisted falls back to CAPTURE_DEFAULT.
CAPTURE_DEFAULT = "ebook"
CAPTURE_BY_CATEGORY = {
    "planner-howto": "checklist",     # mid-tutorial: the next question is "what do I need?"
    "expat": "abroad",
    "planning-framework": "ebook",    # these posts ARE the eBook's chapters
}
# Per-post overrides where the post's own subject beats its category. Slug -> magnet key.
# Validated against the real posts at build time (see check_capture_config) — a slug typo here
# would otherwise do nothing at all, silently, and look exactly like working config.
CAPTURE_BY_SLUG = {
    # Cross-border content filed under other categories.
    "retirement-planning-case-studies": "abroad",   # expats + digital nomads
    # The posts these magnets were made from — offering the PDF of what they just read.
    "questions-to-ask-your-retirement-plan": "questions",
    "your-first-retirement-planning-session": "checklist",
}

# Copy for each magnet's capture card: (kicker, headline, one-line pitch, button).
CAPTURE_COPY = {
    "ebook": (
        "Free eBook",
        "Build a Retirement Plan You Can Question",
        "Thirteen short chapters on building a plan whose numbers you can actually check "
        "— free, straight to your inbox.",
        "Send me the eBook",
    ),
    "checklist": (
        "Free checklist",
        "What you need before you start planning",
        "One page listing every figure a retirement projection needs, and where to find it.",
        "Send me the checklist",
    ),
    "questions": (
        "Free guide",
        "50+ questions to ask your retirement plan",
        "A plan that survives these questions is worth trusting. Fifteen review themes, free.",
        "Send me the guide",
    ),
    "abroad": (
        "Free guide",
        "What retiring abroad does to your income",
        "The same retirement modeled in the US, UK, Canada and Australia — with the method, "
        "so you can check it.",
        "Send me the guide",
    ),
}


def check_capture_config(posts):
    """Fail the build on capture config that silently does nothing.

    Both failure modes look identical to working config from the outside: the pages still
    build, every post still shows a card, and the only symptom is the wrong magnet being
    offered forever. Cheap to check, invisible otherwise.
    """
    known = {p["slug"] for p in posts}
    bad_slugs = sorted(set(CAPTURE_BY_SLUG) - known)
    if bad_slugs:
        sys.exit("blog_build: CAPTURE_BY_SLUG names %d post(s) that do not exist — the "
                 "override does nothing:\n    %s"
                 % (len(bad_slugs), "\n    ".join(bad_slugs)))

    bad_cats = sorted(set(CAPTURE_BY_CATEGORY) - set(CATEGORY_LABEL_TO_SLUG.values()))
    if bad_cats:
        sys.exit("blog_build: CAPTURE_BY_CATEGORY names unknown category slug(s): %s"
                 % ", ".join(bad_cats))

    magnets = ({CAPTURE_DEFAULT} | set(CAPTURE_BY_SLUG.values())
               | set(CAPTURE_BY_CATEGORY.values()))
    missing = sorted(magnets - set(CAPTURE_COPY))
    if missing:
        sys.exit("blog_build: no CAPTURE_COPY for magnet(s): %s" % ", ".join(missing))


def capture_for(post):
    """Which magnet key this post should offer."""
    return (CAPTURE_BY_SLUG.get(post["slug"])
            or CAPTURE_BY_CATEGORY.get(post["cat_slug"])
            or CAPTURE_DEFAULT)


def capture_html(post):
    """The inline email-capture card rendered near the end of every post.

    Posts to the same /api/newsletter endpoint as the landing pages; assets/js/main.js binds
    it by the data-newsletter attribute, so nothing here needs its own script. Field ids are
    namespaced per post because the blog landing page never shows two at once, but a post
    already carries other forms' ids in the shared footer.
    """
    magnet = capture_for(post)
    kicker, headline, pitch, button = CAPTURE_COPY[magnet]
    sid = post["slug"][:40]
    return f"""<aside class="post-capture">
  <p class="post-capture-kicker">{kicker}</p>
  <h2>{headline}</h2>
  <p class="post-capture-pitch">{pitch}</p>
  <div class="form-notice" role="alert" data-nl-notice></div>
  <form class="post-capture-form" novalidate data-newsletter data-magnet="{magnet}">
    <div class="sr-only" aria-hidden="true">
      <label for="pc-honey-{sid}">Leave this blank</label>
      <input type="text" id="pc-honey-{sid}" name="_honey" tabindex="-1" autocomplete="off">
    </div>
    <label class="sr-only" for="pc-email-{sid}">Email address</label>
    <input type="email" id="pc-email-{sid}" name="email" autocomplete="email" required
           placeholder="you@example.com">
    <button type="submit" class="btn btn-primary">{button}</button>
  </form>
  <p class="post-capture-fine">No spam. Unsubscribe anytime. Educational only &mdash; not financial advice.</p>
  <div class="form-success" role="status" aria-live="polite" data-nl-success>
    <p>Check your inbox &mdash; it&rsquo;s on its way.</p>
  </div>
</aside>"""


# Ordered blog series. A post whose slug is in a series gets a numbered "read in
# order" list of the WHOLE series as its related-articles block (the current post
# is shown in place but NOT linked) instead of the generic 3-pick related list.
# Order = the intended reading order, not publish date. Keep slugs in sync with
# the posts' **Suggested URL slug** / filename.
SERIES = [
    {
        "label": "Build a Retirement Plan You Can Question",
        "heading": "The full series: Build a Retirement Plan You Can Question",
        "slugs": [
            "retirement-plan-you-can-question",
            "retirement-income-timeline-phases",
            "gross-net-real-retirement-income",
            "retirement-ending-balance-that-carries-the-plan",
            "how-taxes-change-retirement-income",
            "how-healthcare-costs-move-with-income",
            "inflation-and-real-retirement-income",
            "check-your-retirement-plan-from-several-angles",
            "comparing-retirement-withdrawal-strategies",
            "asking-better-retirement-questions-with-ai",
            "keeping-your-retirement-plan-current",
            "your-first-retirement-planning-session",
            "retirement-plan-case-study",
            "questions-to-ask-your-retirement-plan",
        ],
    },
    {
        "label": "Master the AI Retirement Income Planner",
        "heading": "The full series: Master the AI Retirement Income Planner",
        "intro": "A step-by-step tutorial series. Read in order, or jump to what you need:",
        "slugs": [
            "how-to-set-up-a-retirement-income-plan",
            # Sits at step 2 deliberately: you have just been shown where the fields are, and the very
            # next question is which of your own income goes in which of them.
            "where-to-enter-retirement-income",
            "save-load-compare-retirement-scenarios",
            "taxes-aca-healthcare-early-retirement",
            "when-to-take-social-security-62-67-70",
            "drawdown-strategies-stress-test-retirement",
            "how-to-use-plan-health-ai-retirement-income-planner",
            "retirement-planner-ai-prompts",
            "how-to-update-tax-rates-retirement-plan",
            "multi-year-roth-conversion-optimizer",
            "retirement-planning-case-studies",
        ],
    },
]

# Companion YouTube tutorials, keyed by post slug: (youtube id, title, description).
# These mirror the planner's own VIDEO_LIBRARY (src/03-app.js) — each of these posts was written from
# the matching video's transcript, so this is an exact pairing rather than loose "related content".
# Thumbnails link OUT to YouTube; nothing is embedded, so there are no iframes and no third-party
# cookies before a deliberate click (same approach as the tutorial grid on how-it-works.html).
# Capped at 2 per post to keep the block light. A slug absent from this map renders no section at all.
POST_VIDEOS = {
    "how-to-set-up-a-retirement-income-plan": [
        ("mxwFwxY--S8", "First Time Retirement Scenario Setup",
         "Walks through the initial setup process for entering retirement ages, balances, income sources, and assumptions."),
        ("2Fi9xEA7oCM", "Full Scenario Walkthrough",
         "Runs through a complete example scenario from setup through analysis."),
    ],
    "save-load-compare-retirement-scenarios": [
        ("DVYW3oksW30", "Save and Load Scenarios",
         "How to save a retirement plan scenario and reload it later for continued planning."),
        ("rh-D1GpdvP4", "Compare Different Retirement Scenarios",
         "Demonstrates how to compare multiple retirement scenarios side by side."),
    ],
    "taxes-aca-healthcare-early-retirement": [
        ("7P7CUQzv7rg", "Tax and ACA Notes",
         "Explains the built-in notes for taxes, ACA subsidies, FPL, IRMAA, inflation, and related planning assumptions."),
    ],
    "when-to-take-social-security-62-67-70": [
        ("67OoVrQiCEI", "What Age Should I Take Social Security? (62 vs 67 vs 70)",
         "Compares Social Security claiming ages and explains the practical trade-offs between claiming at 62, 67, or 70."),
        ("6lKM14D7--c", "Model Claiming Social Security at Different Ages",
         "How to test different Social Security claiming ages inside the planner."),
    ],
    "drawdown-strategies-stress-test-retirement": [
        ("UPv6QS_aoig", "Drawdown Strategy Comparison — Know Your Number Is Safe",
         "Introduces the drawdown strategy comparison feature for checking whether your planned income level is sustainable."),
        ("mxoWUVqRYwQ", "Six Stress Tests for Your Retirement Portfolio",
         "Tests one retirement plan against multiple withdrawal and stress-test methods."),
    ],
    "how-to-use-plan-health-ai-retirement-income-planner": [
        ("k7XeKOJccw4", "Plan Health & Confidence Score",
         "Explains the Plan Health checks and the 0-100 Confidence Score, and why a plan can be complete without every check green."),
    ],
    "retirement-planner-ai-prompts": [
        ("EyAQQ-tGywM", "AI Chat Tutorial",
         "The full walkthrough of the AI Chat tab. Every message includes your complete plan; ask for optimizations and apply suggested edits with one click."),
        ("iVa_oJVmo94", "How to Use an Anthropic API Key",
         "A quick overview of the planner with and without an API key, and the simple process for obtaining your own."),
    ],
    "how-to-update-tax-rates-retirement-plan": [
        ("6CAJy2TfdDE", "Keep Your Retirement Plan Accurate Every Year",
         "How the planner can be kept current as tax rates, thresholds, and planning assumptions change."),
    ],
    "multi-year-roth-conversion-optimizer": [
        ("hyBWQH1yOHQ", "Roth Conversion Optimizer Walkthrough",
         "A walkthrough of the companion Roth Conversion Optimizer app and how its exported plan imports into the planner."),
    ],
    "retirement-planning-case-studies": [
        ("EdxtycWPnII", "Sell Everything and Move to Thailand",
         "A retirement relocation scenario focused on moving to Thailand and adjusting income, expenses, and assumptions."),
        ("M2cfNKW2SSc", "Digital Nomad Income Planner",
         "A digital-nomad-style scenario: age 55, part-time income until 65, Social Security at 67."),
    ],
}

# H2 sections that are production notes, not reader content (lowercased). Includes the
# heading variants used by the older 'Process Later' drafts (e.g. "internal link
# suggestions", "suggested article schema") so their trailers are stripped too.
PRODUCTION_SECTIONS = {
    "internal links to add",
    "internal link suggestions",
    "suggested internal links",
    "cta blocks",
    "suggested cta blocks",
    # Legacy drafts sometimes put the CTA under a per-type heading instead of one
    # "CTA Blocks" section. Strip these so they never leak as a stray reader heading.
    # (To actually surface the CTA as the end band, rename to "## CTA Blocks" with a
    #  "**Product/Soft/Demo CTA:**" marker so extract_ctas picks it up.)
    "suggested product cta",
    "suggested soft cta",
    "suggested demo cta",
    "schema notes",
    "suggested article schema",
    "suggested schema",
    "suggested faq schema questions",
    "facebook post snippets",
    "newsletter summary",
    "publishing notes",
}

# Reader-facing H2 headings the AI drafts get wrong. "Bottom Disclaimer" is a
# layout/production artifact that must never render (it also leaks into the TOC + anchor);
# the site convention is "Educational Disclaimer" (matches the **Educational disclaimer:**
# front-matter key and the education-not-advice voice). Map lowercased heading -> correct text.
HEADING_NORMALIZE = {
    "bottom disclaimer": "Educational Disclaimer",
    "disclaimer": "Educational Disclaimer",
}

WORDS_PER_MINUTE = 225


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def parse_post(md_path):
    text = md_path.read_text(encoding="utf-8")
    meta = {}
    title = None
    body_start = text.find("\n## ")
    head = text[:body_start] if body_start != -1 else text
    body = text[body_start + 1:] if body_start != -1 else ""

    for line in head.splitlines():
        m = re.match(r"^#\s+(.*)", line)
        if m:
            title = m.group(1).strip()
            continue
        m = re.match(r"^\*\*(.+?):\*\*\s*(.*)$", line)
        if m:
            meta[m.group(1).strip().lower()] = m.group(2).strip()

    if not title:
        sys.exit(f"{md_path.name}: no '# Title' line found")

    slug = meta.get("suggested url slug") or md_path.stem
    slug = re.sub(r"[^a-z0-9-]", "", slug.lower().replace(" ", "-"))

    category = meta.get("category")
    if not category:
        cluster = meta.get("cluster", "").lower()
        if cluster in CLUSTER_TO_CATEGORY:
            category = CLUSTER_TO_CATEGORY[cluster][1]
    if not category:
        sys.exit(f"{md_path.name}: no **Category:** and unrecognised **Cluster:** "
                 f"'{meta.get('cluster', '')}'. Add one of: "
                 + ", ".join(sorted(CATEGORY_LABEL_TO_SLUG)))
    cat_slug = CATEGORY_LABEL_TO_SLUG.get(category)
    if not cat_slug:
        sys.exit(f"{md_path.name}: unknown category '{category}'. Known: "
                 + ", ".join(sorted(CATEGORY_LABEL_TO_SLUG)))

    published = meta.get("published")
    if not published or not re.match(r"^\d{4}-\d{2}-\d{2}$", published):
        sys.exit(f"{md_path.name}: missing/invalid **Published:** YYYY-MM-DD")

    lead = meta.get("lead image", "").strip()
    card = int(lead) if lead.isdigit() and int(lead) >= 1 else 1

    return {
        "path": md_path,
        "meta": meta,
        "title": meta.get("seo title") or title,
        "h1": title,
        "description": meta.get("meta description", ""),
        "slug": slug,
        "category": category,
        "cat_slug": cat_slug,
        "published": published,
        "updated": meta.get("updated") or None,
        "draft": meta.get("draft", "").lower() in ("true", "yes", "1"),
        "img_base": meta.get("image source base") or md_path.stem,
        "card": card,  # image number used for the landing-page card + OG (default 1)
        "body": body,
    }


def split_sections(body):
    """Split the body on H2 headings -> list of (heading, md_text_incl_heading)."""
    parts = re.split(r"(?m)^(## .+)$", body)
    sections = []
    # parts[0] is anything before first H2 (usually empty)
    for i in range(1, len(parts), 2):
        heading = parts[i][3:].strip()
        content = parts[i] + "\n" + (parts[i + 1] if i + 1 < len(parts) else "")
        sections.append((heading, content))
    return sections


def extract_ctas(cta_md):
    ctas = {}
    for m in re.finditer(r"\*\*(Soft|Product|Demo) CTA:\*\*\s*(.+)", cta_md):
        ctas[m.group(1).lower()] = m.group(2).strip()
    return ctas


def extract_faq(faq_md):
    """-> list of (question, answer_text) from the FAQ section."""
    pairs = []
    chunks = re.split(r"(?m)^### +(.+)$", faq_md)
    for i in range(1, len(chunks), 2):
        q = chunks[i].strip()
        a = re.sub(r"\s+", " ", chunks[i + 1]).strip()
        if q and a:
            pairs.append((q, a))
    return pairs


# --------------------------------------------------------------------------
# Images
# --------------------------------------------------------------------------

def find_source_image(images_dir, base, n):
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = images_dir / f"{base} {n}{ext}"
        if p.exists():
            return p
    return None


def find_square_image(square_dir, base, card):
    """Locate the pre-cropped SQUARE version of a post's card image, if the user
    supplied one. Files live in '<images>/square images/' and are named
    '<base> <card> SQUARE.<ext>' or '<base> SQUARE.<ext>' (the number is optional,
    matching how the flat card images are named with/without a trailing number)."""
    for name in (f"{base} {card} SQUARE", f"{base} SQUARE"):
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            p = square_dir / f"{name}{ext}"
            if p.exists():
                return p
    return None


def prepare_square_thumb(post, square_dir):
    """Build the list-view square thumbnail (assets/img/blog/<slug>-sq.webp) from a
    genuinely-square source in 'square images/'. Returns its URL, or '' if there is
    no (square) source — in which case the landing page's list view falls back to the
    normal 16:10 thumbnail. Only the card/OG image gets a square variant."""
    dest = IMG_OUT / f"{post['slug']}-sq.webp"
    src = find_square_image(square_dir, post["img_base"], post["card"])
    ok = False
    if src:
        w0, h0 = image_size(src)
        ok = abs(w0 - h0) <= max(w0, h0) * 0.02  # within 2% of 1:1
    if not ok:
        if dest.exists():
            dest.unlink()
            print(f"  pruned square thumb (no square source): {dest.name}")
        return ""
    if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
        w, h = convert_image(src, dest, max_width=560, quality=80)
        print(f"  sq:  {src.name} -> {dest.name} ({w}x{h})")
    return f"/assets/img/blog/{dest.name}"


def convert_image(src, dest, max_width, quality):
    """Resize + convert to webp. Returns (w, h) of the output."""
    from PIL import Image
    with Image.open(src) as im:
        if im.mode in ("RGBA", "P"):
            im = im.convert("RGB")
        if im.width > max_width:
            ratio = max_width / im.width
            im = im.resize((max_width, round(im.height * ratio)), Image.LANCZOS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        im.save(dest, "WEBP", quality=quality, method=6)
        return im.width, im.height


def image_size(path):
    from PIL import Image
    with Image.open(path) as im:
        return im.width, im.height


def prepare_images(post, images_dir):
    """Convert the source images the post actually references -> assets/img/blog/.
    Only image numbers used by an [IMAGE ... N] marker are built; unreferenced numbers
    are skipped and any stale output from a previously-used image is pruned (so dropping
    an image from a post also removes its webp). Returns {n: (rel_url, w, h)}."""
    referenced = {int(x) for x in re.findall(
        r"\[IMAGE (?!PLACEHOLDER)[^\]]*?(\d+)\]", post["body"])}
    referenced.add(post["card"])  # the landing-card / OG image is always built
    # Image numbers are not capped at 9. The prune sweep must therefore cover every number
    # ALREADY on disk for this slug as well as the ones now referenced, or dropping a
    # high-numbered image would orphan its .webp.
    on_disk = set()
    for p in IMG_OUT.glob(f"{post['slug']}-*.webp"):
        m = re.fullmatch(re.escape(post["slug"]) + r"-(\d+)(?:-thumb)?\.webp", p.name)
        if m:
            on_disk.add(int(m.group(1)))
    out = {}
    for n in range(1, max([9] + list(referenced) + list(on_disk)) + 1):
        dest = IMG_OUT / f"{post['slug']}-{n}.webp"
        thumb = IMG_OUT / f"{post['slug']}-{n}-thumb.webp"
        is_card = (n == post["card"])
        if n not in referenced:
            for stale in (dest, thumb):
                if stale.exists():
                    stale.unlink()
                    print(f"  pruned unused image: {stale.name}")
            continue
        src = find_source_image(images_dir, post["img_base"], n)
        if src:
            if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
                w, h = convert_image(src, dest, max_width=1400, quality=80)
                print(f"  img: {src.name} -> {dest.name} ({w}x{h})")
            if is_card and (not thumb.exists() or thumb.stat().st_mtime < src.stat().st_mtime):
                convert_image(src, thumb, max_width=640, quality=75)
        if not is_card and thumb.exists():
            thumb.unlink()  # a former card thumb that is no longer the lead image
            print(f"  pruned stale thumb: {thumb.name}")
        if dest.exists():
            w, h = image_size(dest)
            out[n] = (f"/assets/img/blog/{dest.name}", w, h)
    return out


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def md_to_html(md_text):
    return markdown.markdown(
        md_text,
        extensions=["tables", "sane_lists", "toc"],
        extension_configs={"toc": {"toc_depth": "2-2"}},
    )


def enhance_tables(html):
    """Wrap each table in a .table-scroll div and stamp every body cell with
    data-label="<column header>". On desktop the table renders normally (scrolling
    inside the wrapper if wide); on phones the CSS uses those labels to render each
    row as a stacked card (label above value) instead of a horizontal scroll."""
    def process_table(m):
        table = m.group(0)
        thead = re.search(r"<thead>.*?</thead>", table, re.S)
        labels = []
        if thead:
            labels = [re.sub(r"<[^>]+>", "", x).strip()
                      for x in re.findall(r"<th[^>]*>(.*?)</th>", thead.group(0), re.S)]

        def process_row(rm):
            idx = {"i": 0}

            def add_label(cm):
                i = idx["i"]
                idx["i"] += 1
                if "data-label" in cm.group(1):
                    return cm.group(0)
                label = labels[i] if i < len(labels) else ""
                open_tag = cm.group(1)[:-1] + ' data-label="' + esc_attr(label) + '">'
                return open_tag + cm.group(2) + "</td>"

            return re.sub(r"(<td[^>]*>)(.*?)</td>", add_label, rm.group(0), flags=re.S)

        body = re.search(r"<tbody>.*?</tbody>", table, re.S)
        if body:
            new_body = re.sub(r"<tr[^>]*>.*?</tr>", process_row, body.group(0), flags=re.S)
            table = table[:body.start()] + new_body + table[body.end():]
        # 2-column tables are key/value lists — they read better as a compact table on
        # phones than as one card per row, so tag them for the CSS to keep them tabular.
        cls = "table-scroll table-2col" if len(labels) == 2 else "table-scroll"
        return f'<div class="{cls}">' + table + "</div>"

    return re.sub(r"<table>.*?</table>", process_table, html, flags=re.S)


def external_links_new_tab(html):
    """Every external link (absolute http/https to another site) opens in a new tab
    with rel="noopener", matching the rest of the site (header/footer already do this).
    Internal links are root-relative ('/...') or fragments, so only absolute off-site
    anchors are rewritten; our own absolute URLs are left as same-tab. Idempotent —
    skips anchors that already carry target= / rel=."""
    def add_attrs(m):
        tag, href = m.group(0), m.group(1)
        if "airetirementincomeplanner.com" in href:
            return tag  # our own absolute URL = internal, keep same tab
        extra = ""
        if "target=" not in tag:
            extra += ' target="_blank"'
        if "rel=" not in tag:
            extra += ' rel="noopener"'
        return (tag[:-1] + extra + ">") if extra else tag

    return re.sub(r'<a\b[^>]*?\shref="(https?://[^"]*)"[^>]*>', add_attrs, html)


def replace_image_markers(md_text, post, images):
    def figure(m):
        n = int(m.group(1))
        if n not in images:
            return f"<!-- image {n} not found for {post['slug']} -->"
        url, w, h = images[n]
        alt = post["meta"].get(f"image {n} alt") or post["h1"]
        return (f'\n<figure class="shot post-img">\n'
                f'<img src="{url}" alt="{esc_attr(alt)}" width="{w}" height="{h}" loading="lazy">\n'
                f"</figure>\n")

    md_text = re.sub(r"(?m)^\[IMAGE (?!PLACEHOLDER)[^\]]*?(\d+)\]\s*$", figure, md_text)
    md_text = re.sub(
        r"(?m)^\[IMAGE PLACEHOLDER - ([^\]]*)\]\s*$",
        lambda m: "\n<!-- IMAGE PLACEHOLDER: " + m.group(1).replace("--", "-").strip() + " -->\n",
        md_text,
    )
    return md_text


def esc_attr(s):
    return (s.replace("&", "&amp;").replace('"', "&quot;")
             .replace("<", "&lt;").replace(">", "&gt;"))


def human_date(iso):
    d = datetime.date.fromisoformat(iso)
    return d.strftime("%B %-d, %Y") if sys.platform != "win32" else d.strftime("%B %d, %Y").replace(" 0", " ")


def cta_box(kind, text, link, label):
    return (f'<aside class="cta-box cta-{kind}">\n'
            f"  <p>{text}</p>\n"
            f'  <p class="cta-box-action"><a class="btn btn-primary btn-sm" href="{link}">{label}</a></p>\n'
            f"</aside>")


def build_toc(content_html):
    """Collapsible 'On this page' list from the h2 ids the toc extension added."""
    items = re.findall(r'<h2 id="([^"]+)">(.+?)</h2>', content_html)
    items = [(i, re.sub(r"<[^>]+>", "", t)) for i, t in items]
    if len(items) < 3:
        return ""
    lis = "\n".join(f'      <li><a href="#{i}">{t}</a></li>' for i, t in items)
    return ('<details class="post-toc">\n  <summary>On this page</summary>\n'
            f'  <ul>\n{lis}\n  </ul>\n</details>')


def jsonld_post(post, images, faq_pairs):
    url = f"{SITE}/blog/{post['slug']}.html"
    graph = [{
        "@type": "BlogPosting",
        "headline": post["title"],
        "description": post["description"],
        "datePublished": post["published"],
        "dateModified": post["updated"] or post["published"],
        "mainEntityOfPage": url,
        "author": {"@type": "Organization", "name": "WebNomad Studio", "url": SITE},
        "publisher": {"@type": "Organization", "name": "WebNomad Studio", "url": SITE,
                      "logo": {"@type": "ImageObject",
                               "url": f"{SITE}/assets/img/og-cover.png"}},
    }]
    if post["card"] in images:
        graph[0]["image"] = SITE + images[post["card"]][0]
    graph.append({
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": "Blog", "item": SITE + "/blog.html"},
            # The category level MUST carry an "item" — Google rejects the whole
            # BreadcrumbList with 'Missing field "item"' when an intermediate ListItem
            # has none (only the final, current-page item may omit it). This mirrors the
            # visible breadcrumb's link exactly: /blog.html#cat=<slug> deep-links the chip.
            {"@type": "ListItem", "position": 3, "name": post["category"],
             "item": f"{SITE}/blog.html#cat={post['cat_slug']}"},
            {"@type": "ListItem", "position": 4, "name": post["title"], "item": url},
        ],
    })
    if faq_pairs:
        graph.append({
            "@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": q,
                            "acceptedAnswer": {"@type": "Answer", "text": a}}
                           for q, a in faq_pairs],
        })
    data = {"@context": "https://schema.org", "@graph": graph}
    return ('<script type="application/ld+json">'
            + json.dumps(data, ensure_ascii=False) + "</script>")


def series_for(slug):
    """Return the SERIES entry a post belongs to (by slug), or None."""
    for s in SERIES:
        if slug in s["slugs"]:
            return s
    return None


def series_related_html(post, series, by_slug):
    """A numbered, read-in-order list of the whole series. The current post is shown
    in its position but rendered as plain text (no link, aria-current)."""
    lis = []
    for slug in series["slugs"]:
        p = by_slug.get(slug)
        if not p or p["draft"]:
            continue  # never link an unpublished/removed post
        title = esc_attr(p["title"])
        if slug == post["slug"]:
            lis.append(f'      <li aria-current="true"><span class="series-current">{title} '
                       f'<span class="series-here">(you are here)</span></span></li>')
        else:
            lis.append(f'      <li><a href="/blog/{slug}.html">{title}</a></li>')
    items = "\n".join(lis)
    return ('<nav class="related-posts series-nav" aria-label="Articles in this series">\n'
            f'  <h2>{esc_attr(series["heading"])}</h2>\n'
            f'  <p class="series-intro">{esc_attr(series.get("intro", "Read in order for the full framework:"))}</p>\n'
            f'  <ol class="series-list">\n{items}\n  </ol>\n</nav>')


def videos_html(post):
    """Companion-video cards for posts listed in POST_VIDEOS; '' for every other post.

    Markup mirrors the tutorial grid on how-it-works.html so it inherits the existing .vid-* styles
    (already dark-mode aware). Thumbnails are plain <img> links to YouTube — deliberately NOT iframes,
    so no third-party embed loads until the reader chooses to click. maxresdefault isn't generated for
    every upload, hence the onerror fallback to mqdefault.
    """
    vids = POST_VIDEOS.get(post["slug"])
    if not vids:
        return ""
    cards = []
    for yt, title, desc in vids:
        cards.append(
            f'    <a class="vid-card" href="https://www.youtube.com/watch?v={yt}" target="_blank" rel="noopener">\n'
            f'      <div class="vid-thumb"><img src="https://img.youtube.com/vi/{yt}/maxresdefault.jpg"'
            f' onerror="this.onerror=null;this.src=\'https://img.youtube.com/vi/{yt}/mqdefault.jpg\';"'
            f' alt="" loading="lazy"><span class="vid-play">&#9654;</span></div>\n'
            f'      <div class="vid-card-body"><div class="vid-card-title">{esc_attr(title)}</div>'
            f'<div class="vid-card-desc">{esc_attr(desc)}</div>'
            f'<div class="vid-card-foot">&#9654; Watch on YouTube &#8599;</div></div>\n'
            f'    </a>')
    lead = ("This tutorial is also on video, walked through on screen." if len(vids) == 1
            else "These tutorials are also on video, walked through on screen.")
    return ('<section class="post-videos" aria-label="Companion video tutorials">\n'
            '  <h2>Prefer to watch?</h2>\n'
            f'  <p class="series-intro">{lead}</p>\n'
            f'  <div class="vid-grid">\n' + "\n".join(cards) + '\n  </div>\n</section>')


def related_html(post, all_posts):
    by_slug = {p["slug"]: p for p in all_posts}
    series = series_for(post["slug"])
    if series:
        return series_related_html(post, series, by_slug)
    # drafts never appear as related links on other posts
    pool = [p for p in all_posts if p["slug"] != post["slug"] and not p["draft"]]
    same = [p for p in pool if p["cat_slug"] == post["cat_slug"]]
    others = [p for p in pool if p["cat_slug"] != post["cat_slug"]]
    picks = (same + others)[:3]
    if not picks:
        return ""
    items = "\n".join(
        f'      <li><a href="/blog/{p["slug"]}.html">{p["title"]}</a>'
        f' <span class="post-meta">· {p["category"]}</span></li>'
        for p in picks)
    return ('<nav class="related-posts" aria-label="Related articles">\n'
            '  <h2>Related articles</h2>\n'
            f"  <ul>\n{items}\n  </ul>\n</nav>")


def render_post(post, all_posts, templates, partials, images):
    body = post["body"]
    # Legacy posts append a production trailer under a body-level H1 (e.g.
    # "# Publishing Notes"). Article bodies otherwise use only H2/H3, so the first H1
    # in the body marks the start of that trailer — split it off to the promo file so it
    # never renders as reader content.
    h1 = re.search(r"(?m)^# .+$", body)
    trailer = ""
    if h1:
        trailer = body[h1.start():].strip()
        body = body[:h1.start()]
    sections = split_sections(body)
    kept, ctas, faq_pairs = [], {}, []
    promo_parts = [trailer] if trailer else []
    for heading, md_sec in sections:
        key = heading.lower().strip()
        if key in HEADING_NORMALIZE:
            fixed = HEADING_NORMALIZE[key]
            # rewrite only the heading line's text; keep the ## level (drives the id/anchor + TOC)
            md_sec = re.sub(r"(?m)^(#+[ \t]+).+$", lambda m: m.group(1) + fixed, md_sec, count=1)
            key = fixed.lower().strip()
        if key == "cta blocks":
            ctas = extract_ctas(md_sec)
            continue
        if key in PRODUCTION_SECTIONS:
            promo_parts.append(md_sec.strip())
            continue
        if key == "faq":
            faq_pairs = extract_faq(md_sec)
        kept.append(md_sec)

    if promo_parts:
        PROMO_DIR.mkdir(parents=True, exist_ok=True)
        (PROMO_DIR / f"{post['slug']}-promo.md").write_text(
            f"# Promo material — {post['title']}\n\n" + "\n\n".join(promo_parts) + "\n",
            encoding="utf-8")

    body_md = "\n".join(kept)
    body_md = replace_image_markers(body_md, post, images)
    words = len(re.findall(r"\w+", body_md))
    read_time = max(1, round(words / WORDS_PER_MINUTE))
    content = md_to_html(body_md)
    # wrap tables + tag cells with column headers (desktop scroll / mobile card layout)
    content = enhance_tables(content)
    # external links open in a new tab (rel="noopener") — applies to every post body
    content = external_links_new_tab(content)

    # Demo CTA box before the FAQ heading (or at the end when there is no FAQ)
    if ctas.get("demo"):
        box = cta_box("demo", ctas["demo"], "/demo.html", "Try the live demo")
        m = re.search(r'<h2 id="faq[^"]*">', content)
        content = (content[:m.start()] + box + "\n" + content[m.start():]) if m else content + "\n" + box
    if ctas.get("soft"):
        # Soft CTA after the first h2 section (i.e. before the second h2)
        h2s = [m.start() for m in re.finditer(r"<h2 id=", content)]
        if len(h2s) >= 2:
            pos = h2s[1]
            box = cta_box("soft", ctas["soft"], "/demo.html", "See it in the demo")
            content = content[:pos] + box + "\n" + content[pos:]

    tokens = {
        "{{TITLE}}": esc_attr(post["title"]),
        "{{H1}}": esc_attr(post["h1"]),
        "{{DESCRIPTION}}": esc_attr(post["description"]),
        "{{CANONICAL}}": f"{SITE}/blog/{post['slug']}.html",
        "{{OG_IMAGE}}": SITE + images[post['card']][0] if post['card'] in images else f"{SITE}/assets/img/og-cover.png",
        "{{ROBOTS}}": '<meta name="robots" content="noindex">\n' if post["draft"] else "",
        "{{DATE_ISO}}": post["published"],
        "{{MODIFIED_ISO}}": post["updated"] or post["published"],
        "{{DATE_HUMAN}}": human_date(post["published"]),
        "{{UPDATED_HUMAN}}": f" · Updated {human_date(post['updated'])}" if post["updated"] else "",
        "{{READ_TIME}}": str(read_time),
        "{{CATEGORY}}": post["category"],
        "{{CATEGORY_SLUG}}": post["cat_slug"],
        "{{JSONLD}}": jsonld_post(post, images, faq_pairs),
        "{{HEAD_ANALYTICS}}": partials["head"],
        "{{HEADER}}": partials["header"].replace("{{CUR_BLOG}}", ' aria-current="page"'),
        "{{FOOTER}}": partials["footer"],
        "{{TOC}}": build_toc(content),
        "{{CONTENT}}": content,
        "{{CTA_PRODUCT}}": ctas.get("product",
            "The AI Retirement Income Planner models income, taxes, Social Security, "
            "healthcare and withdrawals month by month, privately in your browser."),
        "{{VIDEOS}}": videos_html(post),
        "{{RELATED}}": related_html(post, all_posts),
        "{{EMAIL_CAPTURE}}": capture_html(post),
    }
    html_page = templates["post"]
    for k, v in tokens.items():
        html_page = html_page.replace(k, v)
    html_page = re.sub(r"\{\{CUR_[A-Z]+\}\}", "", html_page)  # remaining nav tokens

    out = OUT_DIR / f"{post['slug']}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html_page, encoding="utf-8")
    post["read_time"] = read_time
    print(f"  page: blog/{post['slug']}.html ({words} words, ~{read_time} min)")


def render_index(posts, templates, partials):
    cats = {}
    for p in posts:
        cats[p["cat_slug"]] = p["category"]
    chips = "\n".join(
        f'        <button class="chip" data-cat="{slug}">{label}</button>'
        for slug, label in sorted(cats.items(), key=lambda kv: kv[1]))
    posts_json = json.dumps([{
        "slug": p["slug"],
        "title": p["title"],
        "description": p["description"],
        "category": p["category"],
        "catSlug": p["cat_slug"],
        "date": p["published"],
        "readTime": p["read_time"],
        "thumb": f"/assets/img/blog/{p['slug']}-{p['card']}-thumb.webp"
                 if (IMG_OUT / f"{p['slug']}-{p['card']}-thumb.webp").exists() else "",
        "sqThumb": p.get("sq_thumb", ""),
        "draft": p["draft"],
    } for p in posts], ensure_ascii=False, indent=1)

    jsonld = ('<script type="application/ld+json">' + json.dumps({
        "@context": "https://schema.org", "@type": "Blog",
        "name": BLOG_TITLE, "url": f"{SITE}/blog.html",
        "publisher": {"@type": "Organization", "name": "WebNomad Studio", "url": SITE},
    }, ensure_ascii=False) + "</script>")

    page = templates["index"]
    for k, v in {
        "{{HEAD_ANALYTICS}}": partials["head"],
        "{{HEADER}}": partials["header"].replace("{{CUR_BLOG}}", ' aria-current="page"'),
        "{{FOOTER}}": partials["footer"],
        "{{CATEGORY_CHIPS}}": chips,
        "{{POSTS_JSON}}": posts_json,
        "{{JSONLD}}": jsonld,
    }.items():
        page = page.replace(k, v)
    page = re.sub(r"\{\{CUR_[A-Z]+\}\}", "", page)
    (WEBSITE / "blog.html").write_text(page, encoding="utf-8")
    print(f"  page: blog.html ({len(posts)} posts listed)")


def render_feed(posts):
    public = [p for p in posts if not p["draft"]]
    items = []
    for p in public:
        d = datetime.date.fromisoformat(p["published"])
        pub = datetime.datetime(d.year, d.month, d.day, 9, 0,
                                tzinfo=datetime.timezone.utc)
        items.append(
            "  <item>\n"
            f"    <title>{esc_attr(p['title'])}</title>\n"
            f"    <link>{SITE}/blog/{p['slug']}.html</link>\n"
            f"    <guid>{SITE}/blog/{p['slug']}.html</guid>\n"
            f"    <pubDate>{pub.strftime('%a, %d %b %Y %H:%M:%S GMT')}</pubDate>\n"
            f"    <description>{esc_attr(p['description'])}</description>\n"
            "  </item>")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    feed = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rss version="2.0"><channel>\n'
            f"  <title>{BLOG_TITLE}</title>\n"
            f"  <link>{SITE}/blog.html</link>\n"
            "  <description>Practical retirement income planning articles from WebNomad Studio.</description>\n"
            "  <language>en-us</language>\n"
            + "\n".join(items) + "\n</channel></rss>\n")
    (OUT_DIR / "feed.xml").write_text(feed, encoding="utf-8")
    print(f"  feed: blog/feed.xml ({len(public)} public posts)")


def update_sitemap(posts):
    xml = SITEMAP.read_text(encoding="utf-8")
    start_marker = "  <!-- BLOG:START (generated by tools/blog_build.py — do not edit) -->"
    end_marker = "  <!-- BLOG:END -->"
    if start_marker not in xml:
        xml = xml.replace("</urlset>", f"{start_marker}\n{end_marker}\n</urlset>")
    today = datetime.date.today().isoformat()
    entries = [f"""  <url>
    <loc>{SITE}/blog.html</loc>
    <lastmod>{today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>"""]
    for p in posts:
        if p["draft"]:
            continue
        entries.append(f"""  <url>
    <loc>{SITE}/blog/{p['slug']}.html</loc>
    <lastmod>{p['updated'] or p['published']}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>""")
    block = start_marker + "\n" + "\n".join(entries) + "\n" + end_marker
    xml = re.sub(re.escape(start_marker) + r".*?" + re.escape(end_marker),
                 block, xml, flags=re.S)
    SITEMAP.write_text(xml, encoding="utf-8")
    print(f"  sitemap.xml: blog block regenerated ({len(entries)} URLs)")


def prune_stale_output(posts):
    """blog/ is fully generated: remove pages for posts that no longer exist."""
    import shutil
    keep = {f"{p['slug']}.html" for p in posts} | {"feed.xml"}
    if not OUT_DIR.exists():
        return
    for item in OUT_DIR.iterdir():
        if item.name not in keep:
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()
            print(f"  pruned stale output: blog/{item.name}")


def check_internal_links(posts):
    """Every root-relative href on generated pages must resolve to a real file.
    Fails the build on broken links — the guard for the internal-linking workflow."""
    pages = [WEBSITE / "blog.html"] + [OUT_DIR / f"{p['slug']}.html" for p in posts]
    broken = []
    for page in pages:
        html_text = page.read_text(encoding="utf-8")
        for href in re.findall(r'href="([^"]*)"', html_text):
            if not href.startswith("/") or "'" in href or " " in href:
                continue  # external/relative links, or string-concat fragments in inline JS
            href = href.split("#")[0].split("?")[0]
            if not href:
                continue
            target = WEBSITE / href.lstrip("/")
            if href.endswith("/"):
                target = target / "index.html"
            if href == "/":
                target = WEBSITE / "index.html"
            if not target.exists():
                broken.append(f"{page.relative_to(WEBSITE)} -> {href}")
    if broken:
        sys.exit("BROKEN INTERNAL LINKS (fix before publishing):\n  "
                 + "\n  ".join(sorted(set(broken))))
    print(f"  link check: OK ({len(pages)} pages scanned)")


# --------------------------------------------------------------------------

def main():
    import argparse
    ap = argparse.ArgumentParser(description="Build the blog from blog-src/")
    ap.add_argument("--images", default=str(DEFAULT_IMAGES_DIR),
                    help="Directory holding source images (default: ../Blog Posts/Images)")
    args = ap.parse_args()
    images_dir = Path(args.images)

    templates = {
        "post": (TEMPLATES / "post.html").read_text(encoding="utf-8"),
        "index": (TEMPLATES / "index.html").read_text(encoding="utf-8"),
    }
    partials = {
        "head": (PARTIALS / "head-analytics.html").read_text(encoding="utf-8").strip(),
        "header": (PARTIALS / "header.html").read_text(encoding="utf-8").strip(),
        "footer": (PARTIALS / "footer.html").read_text(encoding="utf-8").strip(),
    }

    md_files = sorted(POSTS_DIR.glob("*.md"))
    if not md_files:
        sys.exit(f"No posts found in {POSTS_DIR}")
    posts = [parse_post(p) for p in md_files]
    slugs = [p["slug"] for p in posts]
    dupes = {s for s in slugs if slugs.count(s) > 1}
    if dupes:
        sys.exit(f"Duplicate slugs: {dupes}")
    posts.sort(key=lambda p: p["published"], reverse=True)
    check_capture_config(posts)

    square_dir = images_dir / "square images"

    print(f"Building {len(posts)} post(s)...")
    for post in posts:
        images = prepare_images(post, images_dir)
        post["sq_thumb"] = prepare_square_thumb(post, square_dir)
        render_post(post, posts, templates, partials, images)
    render_index(posts, templates, partials)
    render_feed(posts)
    update_sitemap(posts)
    prune_stale_output(posts)
    check_internal_links(posts)
    print("Done.")


if __name__ == "__main__":
    main()
