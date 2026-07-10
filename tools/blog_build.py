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
  **Image <n> alt:**     alt text for image n

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
}
CATEGORY_LABEL_TO_SLUG = {label: slug for slug, label in CLUSTER_TO_CATEGORY.values()}

# H2 sections that are production notes, not reader content (lowercased)
PRODUCTION_SECTIONS = {
    "internal links to add",
    "cta blocks",
    "schema notes",
    "facebook post snippets",
    "newsletter summary",
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
        r"\[IMAGE (?!PLACEHOLDER)[^\]]*?(\d)\]", post["body"])}
    out = {}
    for n in range(1, 10):
        dest = IMG_OUT / f"{post['slug']}-{n}.webp"
        thumb = IMG_OUT / f"{post['slug']}-1-thumb.webp" if n == 1 else None
        if n not in referenced:
            for stale in (dest, thumb):
                if stale and stale.exists():
                    stale.unlink()
                    print(f"  pruned unused image: {stale.name}")
            continue
        src = find_source_image(images_dir, post["img_base"], n)
        if src:
            if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
                w, h = convert_image(src, dest, max_width=1400, quality=80)
                print(f"  img: {src.name} -> {dest.name} ({w}x{h})")
            if n == 1 and (not thumb.exists() or thumb.stat().st_mtime < src.stat().st_mtime):
                convert_image(src, thumb, max_width=640, quality=75)
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
        return '<div class="table-scroll">' + table + "</div>"

    return re.sub(r"<table>.*?</table>", process_table, html, flags=re.S)


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

    md_text = re.sub(r"(?m)^\[IMAGE (?!PLACEHOLDER)[^\]]*?(\d)\]\s*$", figure, md_text)
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
    if 1 in images:
        graph[0]["image"] = SITE + images[1][0]
    graph.append({
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": "Blog", "item": SITE + "/blog.html"},
            {"@type": "ListItem", "position": 3, "name": post["category"]},
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


def related_html(post, all_posts):
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
    sections = split_sections(post["body"])
    kept, ctas, faq_pairs = [], {}, []
    promo_parts = []
    for heading, md_sec in sections:
        key = heading.lower().strip()
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
        "{{DESCRIPTION}}": esc_attr(post["description"]),
        "{{CANONICAL}}": f"{SITE}/blog/{post['slug']}.html",
        "{{OG_IMAGE}}": SITE + images[1][0] if 1 in images else f"{SITE}/assets/img/og-cover.png",
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
        "{{RELATED}}": related_html(post, all_posts),
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
        "thumb": f"/assets/img/blog/{p['slug']}-1-thumb.webp"
                 if (IMG_OUT / f"{p['slug']}-1-thumb.webp").exists() else "",
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

    print(f"Building {len(posts)} post(s)...")
    for post in posts:
        images = prepare_images(post, images_dir)
        render_post(post, posts, templates, partials, images)
    render_index(posts, templates, partials)
    render_feed(posts)
    update_sitemap(posts)
    prune_stale_output(posts)
    check_internal_links(posts)
    print("Done.")


if __name__ == "__main__":
    main()
