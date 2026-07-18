# Nostr Reaction Viewer

A static, dependency-free web app that shows the Nostr posts **you have reacted to**.
Log in with a NIP-07 browser extension, and the app fetches your `kind 7` reactions,
resolves the original `kind 1` posts, reflects each author's `kind 0` profile, and
renders everything — including images — in a polished, infinite-scrolling feed.

**Vanilla JavaScript. No framework. No build step.** Just static files you can drop
on GitHub Pages.

## Features

- **NIP-07 login** — reads only your public key; no keys or private data ever leave the browser.
- **Reacted-post feed** — kind 7 → original kind 1 posts, deduplicated by post.
- **Profiles** — each post reflects the author's kind 0 metadata (name, avatar).
- **Images** — detected from the URL **pathname extension only**, ignoring query strings
  (so `.../photo.png?token=…` is an image, `.../render?file=cat.png` is not). Also honors NIP-92 `imeta` tags.
- **Infinite scrolling** — reactions are paged by `created_at` via an `IntersectionObserver`.
- **Date range filter** — narrow by reaction date.
- **Image filter** — all / with images / without images.
- **Relays** — defaults to `wss://yabu.me` and `wss://r.kojira.io`; toggle **Use my relays**
  to switch to your NIP-65 (`kind 10002`) / NIP-07 relay list when available.
- **Lightbox**, gradient fallback avatars, skeleton loaders, dark polished UI.

## Run locally

Any static server works. A tiny dependency-free one is included:

```bash
node tools/server.mjs 8123
# open http://localhost:8123
```

You need a NIP-07 extension (Alby, nos2x, …) installed to connect.

## Automated verification

An end-to-end Playwright check drives the real UI against a **mocked** NIP-07 signer and
mocked relay WebSockets (no network, no private data). It verifies login, feed rendering,
profile reflection, image rendering, the image filters, and pathname-only image detection.

```bash
npm install          # installs Playwright (dev-only; the app itself has no dependencies)
npx playwright install chromium
npm test             # runs tools/verify.mjs → 7/7 checks
```

## Deploy to GitHub Pages

The repository is plain static files at the root, so GitHub Pages can serve it directly.
This repo also ships a workflow (`.github/workflows/pages.yml`) that publishes on every push
to `main`. In the repo settings, set **Pages → Build and deployment → Source: GitHub Actions**
(or **Deploy from a branch → main → / (root)**).

## Project layout

```
index.html            # markup + shell
assets/styles.css     # all styling
src/relay.js          # dependency-free relay WebSocket pool
src/nostr.js          # image detection, profile parsing, content rendering
src/app.js            # login, paging, filters, feed rendering
tools/server.mjs      # local static server (dev)
tools/verify.mjs      # Playwright end-to-end verification (dev)
```

## Privacy

The app only calls `window.nostr.getPublicKey()` (and optionally `getRelays()`). It never
requests signatures, never reads private keys, and displays only public Nostr data.
