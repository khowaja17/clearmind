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

## Updating the app later

Push changes to `main`; the Action rebuilds and redeploys. To force installed
clients to pick up a new version immediately, bump the cache version in
`public/sw.js` (`const CACHE = "clearmind-v2"`) before pushing.

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
