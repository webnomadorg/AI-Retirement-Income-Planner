# Blog source & build

The blog is assembled by `tools/blog_build.py` from the files in this folder plus the
shared partials in `partials/`. **Never edit anything under `blog/` by hand** — it is
generated output (like `demo/`), and the next build overwrites it.

```
blog-src/posts/*.md        one Markdown file per published post (source of truth)
blog-src/templates/*.html  page skeletons with {{TOKENS}}
blog-src/promo/*.md        generated: Facebook snippets / newsletter copy stripped from each post
partials/header.html       shared nav (root-absolute links, {{CUR_*}} tokens for aria-current)
partials/footer.html       shared footer
partials/head-analytics.html  GA + Meta Pixel + consent (inline, consent denied by default)
```

Build (from anywhere):

```powershell
python Website/tools/blog_build.py
```

Outputs: `blog/<slug>/index.html` per post, `blog/index.html` (landing page with
search/filter over an embedded post index), `blog/feed.xml` (RSS), optimized images in
`assets/img/blog/` (WebP, 1400px full + 640px thumb), and the generated blog block in
`sitemap.xml`. Requires `pip install markdown` (and `Pillow` when images changed).

## Post front matter

The `**Key:** value` lines before the first `## ` heading. On top of the SEO keys the
drafted posts already carry (`SEO title`, `Meta description`, `Suggested URL slug`,
`Cluster`, …), the build needs:

| Key | Required | Notes |
| --- | --- | --- |
| `**Published:**` | yes | `YYYY-MM-DD` |
| `**Category:**` | if no known `**Cluster:**` | one of the labels in `CLUSTER_TO_CATEGORY` in the build script |
| `**Updated:**` | no | shows "Updated …" and feeds `dateModified` |
| `**Draft:** true` | no | renders + lists with a badge, but noindex, and excluded from sitemap + RSS |
| `**Image source base:**` | no | image filename base in the images dir (default: the .md filename) |
| `**Image <n> alt:**` | recommended | alt text for image n |

Images live outside the repo in `..\Blog Posts\Images` as `"<base> <n>.png"`; pass a
different folder with `--images`. Body markers `[IMAGE <base> <n>]` become `<figure>`s;
`[IMAGE PLACEHOLDER - …]` notes are kept as HTML comments for future screenshots.

## Sections with special handling

- **CTA Blocks** — not rendered as prose. `**Soft CTA:**` becomes a boxed CTA after the
  first section, `**Demo CTA:**` a boxed CTA before the FAQ, `**Product CTA:**` the text
  of the end-of-article CTA band.
- **FAQ** — rendered on the page *and* emitted as FAQPage JSON-LD.
- **Internal Links To Add / Schema Notes / Facebook Post Snippets / Newsletter Summary** —
  stripped from the page and saved to `blog-src/promo/<slug>-promo.md`.

Every post gets BlogPosting + BreadcrumbList (+ FAQPage) JSON-LD, canonical +
Open Graph tags, a collapsible "On this page" TOC (3+ H2s), reading time, a
related-articles block, and lazy-loaded WebP images with width/height attributes.

The full editorial workflow (fact-checking against the planner, style scan, publish
steps) lives in the desktop repo: `Plans/Blog-Platform-and-Content-Plan.md`.
