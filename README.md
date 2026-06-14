# WebNomad Studio — Marketing Website

A fast, fully static marketing site for the **AI Retirement Income Planner v7** and the **Roth Conversion Optimizer**, with buttons linking to the Etsy store (no shopping cart).

Built with hand-crafted HTML + CSS + a little vanilla JavaScript — **no build step, no framework, no server requirements.** It runs from any static host or even straight off disk.

---

## Pages
| File | Purpose |
|------|---------|
| `index.html` | Home — hero, value prop, feature highlights, product preview, privacy, FAQ teaser |
| `products.html` | All products, prices, comparison table |
| `features.html` | Full capability tour (8 areas) |
| `how-it-works.html` | 5-step walkthrough + video tutorials |
| `technical.html` | Engine, methodology, privacy, validation + PDF downloads |
| `faq.html` | FAQ + contact |

## Folder structure
```
Website/
├── index.html, products.html, features.html, how-it-works.html, technical.html, faq.html
├── assets/
│   ├── css/styles.css         ← the whole design system
│   ├── js/main.js             ← nav toggle, screenshot lightbox, footer year
│   ├── img/
│   │   ├── etsy/              ← Etsy listing graphics (1–11, companion)
│   │   ├── screens/          ← product screenshots
│   │   ├── themes/           ← theme/appearance screenshots
│   │   ├── logo-mark.svg, favicon.svg, og-cover.png
│   └── downloads/            ← PDF documentation linked from Technical
└── README.md
```
> `Source Files/` holds the originals and is **not** needed to run the site — everything used is copied into `assets/`. You can keep or delete it.

## Hosting (pick any)
- **Netlify / Cloudflare Pages / Vercel:** drag-and-drop the `Website` folder, or point it at a repo. No build command; publish directory is the folder root.
- **GitHub Pages:** push the contents of `Website/` to the repo (or a `/docs` folder) and enable Pages.
- **Any web host / S3:** upload the files; `index.html` is the entry point.
- **Local preview:** `python -m http.server 5500` from inside `Website/`, then open `http://localhost:5500`.

All links are **relative**, so it works in a subfolder too.

## GitHub sync
This folder is its own git repo, wired to **github.com/webnomadorg/AI-Retirement-Income-Planner** (branch `main`). `Source Files/`, `Website Notes.txt`, and `sync.ps1` are git-ignored, so only the publishable site is pushed.

- **First push (one-time auth):** from inside `Website/`, run `git push -u origin main`. Git Credential Manager opens a browser to log in to GitHub; after that, credentials are cached.
- **Resync after future edits:** `pwsh ./sync.ps1 "what changed"` — it stages, commits, and pushes in one step.
- Enable **GitHub Pages** on the repo (Settings → Pages → deploy from `main` / root) to host it free at a github.io URL, or point a custom domain at it.

## Before you go live — quick edits
1. **Domain:** find-and-replace `https://REPLACE-WITH-YOUR-DOMAIN.com` across all six `.html` files with your real domain (used in canonical + social tags).
2. **Prices / sales:** edit the `.price`, `.price-was`, `.price-save` spans in `index.html` and `products.html`, and the comparison table in `products.html`.
3. **Etsy links:** product buttons point to —
   - Planner v7: `https://www.etsy.com/listing/4509386063/...`
   - Bundle (v7 + Roth): `https://www.etsy.com/listing/4503115757/...`
   - Shop / earlier versions: `https://www.etsy.com/shop/webnomadstudio/`
   Update these if listings change. (The standalone Roth Optimizer currently points to the shop — swap in its own listing URL when available.)
4. **Contact email:** `dev@webnomad.com` (search to change).
5. **Social share image:** `assets/img/og-cover.png` (1200×630-ish). Replace to taste.

## Regenerating images (optional)
Two helper scripts live in `Source Files/_gen/` (they need Python + Pillow; not required to run the site):
- `make_images.py` — builds the branded **OG share image** (`og-cover.png`, 1200×630) and the three **product covers** (`cover-v7/bundle/roth.png`) from screenshots on a navy gradient.
- `optimize_images.py` — resizes/recompresses screenshots in `assets/img/screens` and `/themes` to a 1500px max width for fast loading. Originals stay safe in `Source Files/`.

Run from the `Website/` folder, e.g. `python "Source Files/_gen/make_images.py"`.

## Interactive pieces
- **Theme gallery** (Features page) — tabbed switcher across the 5 themes with a Light/Dark toggle; images preload with a sequence guard so the picture and caption never disagree.
- **Video facade** (How It Works) — a click-to-play poster that injects the YouTube player only on click (faster, and avoids the playlist embed error).
- **Motion** — scroll-reveal, a count-up stats band, hover image-zoom and a sticky-header shadow. All respect `prefers-reduced-motion` and degrade gracefully without JS.

## Accessibility & audience notes
Tuned for a 40+ audience: 18px base text, large tap targets, high-contrast Quiet-Fintech palette (WCAG-AA intent), visible nav labels, reduced-motion support, and a keyboard-accessible screenshot lightbox.

## Credits
Fonts: Fraunces + Inter (Google Fonts). Imagery: WebNomad Studio product graphics & screenshots.
