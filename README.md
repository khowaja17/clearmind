# Clearmind — GTD Survival (deployable PWA)

A Getting Things Done system wrapped in a post-apocalyptic survival game.
This folder is a complete, ready-to-deploy Vite + React project that publishes to
GitHub Pages and installs as a Progressive Web App (PWA).

Your progress (tasks, projects, habits, XP, gear) is saved in the browser's
`localStorage`, which persists across tab-close, app-quit, and device restart.

---

## One value you must check first

Open **`vite.config.js`** and confirm this line matches your repo name:

```js
base: "/clearmind/",
```

If your GitHub repo is named something other than `clearmind`, change it to
`/<your-repo-name>/` (keep the leading and trailing slashes). This is the single
most common cause of a blank page on GitHub Pages — it must match exactly.

The PWA files (`manifest.webmanifest`, `index.html`, `sw.js`) use **relative**
paths on purpose, so they need no editing regardless of repo name.

---

## Run it locally (optional, to try before deploying)

Requires Node.js 18+.

```bash
npm install      # one time
npm run dev      # local dev server with hot reload → http://localhost:5173/clearmind/
```

To preview the real production build locally:

```bash
npm run build    # outputs dist/
npm run preview
```

---

## Deploy to GitHub Pages (hands-off, auto on every push)

1. **Create a new GitHub repo** (e.g. `clearmind`). Make it public.

2. **Push this folder to it:**
   ```bash
   git init
   git add .
   git commit -m "Clearmind PWA"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo>.git
   git push -u origin main
   ```

3. **Turn on Pages with the Actions source:**
   Repo → **Settings** → **Pages** → under "Build and deployment",
   set **Source = GitHub Actions**. (You do *not* pick a branch — the included
   workflow handles it.)

4. **Done.** The workflow in `.github/workflows/deploy.yml` builds and deploys
   automatically. Watch progress under the repo's **Actions** tab. When it
   finishes (~1–2 min), your app is live at:

   ```
   https://<username>.github.io/<repo>/
   ```

   Every future `git push` to `main` redeploys automatically.

---

## Link it from your existing site's Projects tab

On your `username.github.io` site, just add a normal link:

```html
<a href="https://username.github.io/clearmind/">Clearmind — GTD Survival</a>
```

(Replace `clearmind` with your repo name if different.)

---

## Installing the app (what your visitors do)

When someone opens the live URL in Chrome or Edge:

- An **Install app** button appears in the app's left sidebar (and the browser
  also shows an install icon in the address bar).
- Clicking it adds Clearmind to their dock / Start menu / home screen as a
  standalone app that opens in its own window and works offline.
- **iPhone/iPad (Safari):** there's no programmatic install button; users tap
  the **Share** icon → **Add to Home Screen**. (This is an Apple limitation, not
  a bug — the app still works fully.)

---

## How persistence works (and its limits)

- Data lives in `localStorage`, written to disk by the browser/installed app.
  It survives restarts indefinitely.
- It is **per-device, per-browser**. It does not sync across devices, and
  clearing browser data for the site erases it.
- The in-app **Export / Import** (left sidebar) saves your whole system to a
  JSON file — use it as a backup and to move data between devices.

---

## Cloud sync (Supabase) — optional sign-in

Clearmind can sync your data across devices via Supabase. This is **optional** — the
app works fully offline and per-device without it; signing in just keeps multiple
devices in step.

Configuration lives in **`.env`** at the project root:

```
VITE_SUPABASE_URL=...        # your Supabase project URL
VITE_SUPABASE_ANON_KEY=...   # the anon/public key (safe to commit & expose)
```

The anon key is **public by design** — it is meant to ship in client code. Data is
protected by Row-Level Security on the database, not by hiding this key. **Never** put
the `service_role` / secret key here. If `.env` is missing, the app simply runs without
sync (no sign-in option appears) — it never breaks.

How sync behaves: you sign in with Google from **Settings → Account & Sync**. Your whole
state is saved to the cloud a few seconds after each change. On sign-in, Clearmind uses
"newest wins" — if another device has a newer copy, it asks before replacing this device's
data and lets you export the old copy first. Sign-in is gated to Google accounts you've
added as test users in the Google Cloud consent screen (ideal for a small private group).

If sign-in seems to work but lands you logged-out, the cause is almost always a redirect
URL mismatch: confirm `https://<username>.github.io/<repo>/` is listed under Supabase →
Authentication → URL Configuration (both Site URL and Redirect URLs).

## Updating the app later

Push changes to `main`; the Action rebuilds and redeploys. To force installed
clients to pick up a new version immediately, bump the cache version in
`public/sw.js` (`const CACHE = "clearmind-v2"`) before pushing.

---

## Adding custom plant sprites

Plant images are embedded as **base64 data URIs** directly in `src/App.jsx` —
the same pattern as the grower avatars. This keeps the app self-contained with
no external asset dependencies.

### Where the data lives

Find `PLANT_CATALOG` near the top of `App.jsx`. Each species has a `stages`
array; each stage has a `src` field that accepts either `null` (falls back to a
colored tile + emoji) or a `"data:image/png;base64,..."` string.

```js
pothos: {
  stages: [
    { name: "Cutting",  xpToNext: 30,   src: "data:image/png;base64,iVBOR...", tile: "#c8e6c9" },
    { name: "Rooted",   xpToNext: 90,   src: "data:image/png;base64,iVBOR...", tile: "#81c784" },
    { name: "Trailing", xpToNext: 200,  src: "data:image/png;base64,iVBOR...", tile: "#4caf50" },
    { name: "Lush",     xpToNext: null, src: "data:image/png;base64,iVBOR...", tile: "#2e7d32" },
  ],
},
```

### Adding images for a new species

**Step 1 — Convert your PNG to a base64 data URI.**

Run this from the project root (requires Python, which ships with macOS/Linux;
install from python.org on Windows):

```bash
python -c "import base64; print('data:image/png;base64,' + base64.b64encode(open('your-image.png','rb').read()).decode())"
```

This prints the full data URI to the terminal. Copy it.

**Step 2 — Paste it into the matching `src` field in `PLANT_CATALOG`.**

Find the species and stage (e.g. `succulent` → stage 0 = "Offset") and replace
`src: null` with `src: "<paste here>"`.

**Step 3 — Bump the service worker cache version.**

In `public/sw.js`, increment the version string so installed clients refresh:

```js
const CACHE = "clearmind-v22"; // → "clearmind-v23"
```

**Step 4 — Push.** The GitHub Action rebuilds and deploys automatically.

### Image recommendations

- **Format:** PNG with transparency
- **Size:** 192 × 192 px works well across all display sizes
- **Style:** 8-bit / pixel art — sprites are rendered with `image-rendering: pixelated`
  so they stay crisp at any display size without blurring
- Stage images should read clearly at small sizes (the status bar shows them at ~26 px)

---

## File map

```
index.html                      app shell + PWA meta tags
vite.config.js                  ← base path lives here
package.json                    dependencies + scripts
src/
  App.jsx                       the whole application (storage seam at top)
  main.jsx                      entry point + service worker registration
  index.css                     page framing
public/                         copied verbatim into dist/
  manifest.webmanifest          PWA metadata
  sw.js                         service worker (offline cache)
  icon-192.png / icon-512.png   app icons
.github/workflows/deploy.yml    auto build + deploy to Pages
```
