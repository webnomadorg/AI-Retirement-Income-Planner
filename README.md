# WebNomad Studio — Marketing Website

A fast, fully static marketing site for the **AI Retirement Income Planner v7** and the **Roth Conversion Optimizer**, selling **directly via Stripe Managed Payments** (Stripe is merchant of record; payment-link buttons, no cart). The Etsy shop still exists but is no longer linked from the site.

Built with hand-crafted HTML + CSS + a little vanilla JavaScript — **no build step, no framework, no server requirements.** It runs from any static host or even straight off disk.

---

## Pages
| File | Purpose |
|------|---------|
| `index.html` | Home — hero, value prop, feature highlights, product preview, privacy, FAQ teaser |
| `products.html` | All products, prices, comparison table |
| `features.html` | Full capability tour (8 areas) |
| `how-it-works.html` | 5-step walkthrough + video tutorials |
| `getting-started.html` | Pre-purchase confidence: guided aids, planning-ahead vs already-retired paths, learning resources |
| `technical.html` | Engine, methodology, privacy, validation + PDF downloads |
| `newsletter.html` | Free-eBook signup + newsletter (see **Forms & email** below) |
| `faq.html` | FAQ + contact |

## Folder structure
```
Website/
├── index.html, products.html, features.html, how-it-works.html, getting-started.html, technical.html, faq.html
├── assets/
│   ├── css/styles.css         ← the whole design system
│   ├── js/main.js             ← nav toggle, screenshot lightbox, footer year
│   ├── img/
│   │   ├── etsy/              ← product listing graphics (1–11, companion; folder name is historical)
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
This folder is its own git repo, wired to **github.com/webnomadorg/AI-Retirement-Income-Planner** (branch `main`). `Source Files/` and `Website Notes.txt` are git-ignored (as is any stray `sync.ps1`), so only the publishable site is pushed.

- **First push (one-time auth):** from inside `Website/`, run `git push -u origin main`. Git Credential Manager opens a browser to log in to GitHub; after that, credentials are cached.
- **Resync after future edits:** `pwsh ../tools/website-sync.ps1 "what changed"` — it stages, commits, and pushes in one step.
- Enable **GitHub Pages** on the repo (Settings → Pages → deploy from `main` / root) to host it free at a github.io URL, or point a custom domain at it.

## Before you go live — quick edits
1. **Domain:** canonical + social tags across all seven `.html` files point to `https://airetirementincomeplanner.com`.
2. **Prices / sales:** edit the `.price`, `.price-was`, `.price-save` spans in `index.html` and `products.html`, and the comparison table in `products.html`.
3. **Stripe payment links** (created by `tools/stripe/create-catalog.mjs` in the desktop repo; canonical list in its `catalog-output.json`):
   - Planner v7 $37.49: `https://buy.stripe.com/fZucN6f6u6LEef08V74Ja00`
   - Bundle (v7 + Roth) $39.99: `https://buy.stripe.com/aFaaEY2jI1rk8UGc7j4Ja01`
   - Roth Optimizer $5.99: `https://buy.stripe.com/14AbJ25vU7PI9YKgnz4Ja02`
   - v1 $4.99 / v2 $9.99 / v3 $12.99 / v4 $16.99 / v5 $19.99: `.../6oU8wQbUi2vo6My1sF4Ja03`, `.../00weVecYmee6b2Ob3f4Ja04`, `.../5kQcN69Mab1Ufj4gnz4Ja05`, `.../4gM6oIaQe8TM8UG0oB4Ja06`, `.../8x200kf6ugme7QCc7j4Ja07`
   After payment, Stripe redirects to `thanks.html?session_id=…`, which lists downloads served by `api/download.mjs` (verifies the Checkout Session, then streams the ZIP from the **private** Vercel Blob store — product files are never in this repo, which is public).
4. **Contact email:** `dev@webnomad.com` (search to change).
5. **Social share image:** `assets/img/og-cover.png` (1200×630-ish). Replace to taste.

## Regenerating images (optional)
Two helper scripts live in `Source Files/_gen/` (they need Python + Pillow; not required to run the site):
- `make_images.py` — builds the branded **OG share image** (`og-cover.png`, 1200×630) and the three **product covers** (`cover-v7/bundle/roth.png`) from screenshots on a navy gradient.
- `optimize_images.py` — resizes/recompresses screenshots in `assets/img/screens` and `/themes` to a 1500px max width for fast loading. Originals stay safe in `Source Files/`.

Run from the `Website/` folder, e.g. `python "Source Files/_gen/make_images.py"`.

## Forms & email (serverless)
Three Vercel serverless functions in `api/` (they only run on Vercel, not the
local static preview):
- **`api/download.mjs`** — purchase delivery: verifies a Stripe Checkout Session
  (`STRIPE_VERIFY_KEY`, a restricted read-only key) and streams the product ZIP from the
  private Vercel Blob store (Blob auth is automatic via OIDC). Used by `thanks.html`.
  ⚠ Keep the classic Node `(req, res)` handler signature — the web-standard
  `handler(request)` form crashes this project's runtime. The product ZIPs and the Stripe
  catalog are maintained by tooling in a separate private repo; product files are never
  committed here (this repo is public).
- **`api/contact.js`** — the contact form; emails `dev@webnomad.org` + a confirmation to the
  sender via **Resend** (`RESEND_API_KEY`).
- **`api/newsletter.js`** — the free-eBook signup. Currently runs in **MailerLite mode**: adds
  each subscriber to a MailerLite group (which sends the welcome + eBook automation) and sends a
  dev notification via Resend. It can also run in the original **Resend-only mode**.
  👉 **Full setup, env vars, verification, and how to switch between the two modes (with both
  complete source versions archived) live in [`NEWSLETTER-SETUP.md`](NEWSLETTER-SETUP.md).**

Env vars (Vercel → Project → Settings → Environment Variables): `RESEND_API_KEY`,
`MAILERLITE_API_KEY`, `MAILERLITE_GROUP_ID`, `STRIPE_VERIFY_KEY`. None are committed to the repo.

## Interactive pieces
- **Theme gallery** (Features page) — tabbed switcher across the 5 themes with a Light/Dark toggle; images preload with a sequence guard so the picture and caption never disagree.
- **Video facade** (How It Works) — a click-to-play poster that injects the YouTube player only on click (faster, and avoids the playlist embed error).
- **Motion** — scroll-reveal, a count-up stats band, hover image-zoom and a sticky-header shadow. All respect `prefers-reduced-motion` and degrade gracefully without JS.

## Accessibility & audience notes
Tuned for a 40+ audience: 18px base text, large tap targets, high-contrast Quiet-Fintech palette (WCAG-AA intent), visible nav labels, reduced-motion support, and a keyboard-accessible screenshot lightbox.

## Credits
Fonts: Fraunces + Inter (Google Fonts). Imagery: WebNomad Studio product graphics & screenshots.
