# AtlasCartographer

A fantasy map maker for phone and PC, and a companion to [WorldAtlas](https://github.com/Momijisu/WorldAtlas). It works offline, installs as its own app, and syncs through your own OneDrive.

Plain HTML, CSS and JavaScript. No server, no build step.

## Status

Early. What works today:

- Projects: create, rename and delete maps at a few preset sizes
- Editor: pan and zoom (mouse, wheel, touch, pinch), an ink pen in five colours, an eraser, undo and redo
- OneDrive sync of every project, merged stroke by stroke, so edits from two devices both survive
- Installable and offline, with dark and light themes

Planned, in order:

1. Art asset library: import packs from a folder or zip on one device, synced to the others through OneDrive (catalogue first, full art downloaded on demand)
2. Land and water painting with automatic coastlines, terrain textures
3. Stamps with a scatter brush, curved text labels, layers
4. Export to PNG/WebP for WorldAtlas Maps

## Art assets

No art is bundled. Asset packs are imported on a device and synced through your OneDrive; they are never committed to this repository (`.gitignore` guards the usual places).

## 1. Hosting

The app must be served over HTTPS to install on a phone. GitHub Pages works:

1. Push to `main`.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. `.github/workflows/pages.yml` deploys every push to `main`, to `https://<user>.github.io/<repo>/`.

## 2. OneDrive sync

AtlasCartographer uses the same Azure app registration as WorldAtlas (its client ID is already in `js/config.js`):

1. Sign in at https://entra.microsoft.com → **App registrations** → the WorldAtlas registration → **Authentication**.
2. Under **Single-page application**, add this app's address as another redirect URI, with the trailing `/`. **Settings → OneDrive sync → Microsoft app registration** in the app shows the exact address with a Copy button.
3. In the app, **Settings → Connect OneDrive**.

The registration's app folder is `OneDrive/Apps/WorldAtlas`. This app keeps everything in its own subfolder, `Apps/WorldAtlas/Cartographer`, and never touches WorldAtlas's files. Both apps live on the same site (`<user>.github.io`), so their sign-ins and local data are kept under separate names.

For local testing, add `http://localhost:8000/` as a redirect URI and run `python3 -m http.server 8000`.

## Syncing

Each device keeps a full copy in IndexedDB. OneDrive holds:

```
Apps/WorldAtlas/Cartographer/
  projects.json          every map's name and size (and deletions)
  projects/<id>.json     each map's drawing
```

Sync runs shortly after each edit, when the app is reopened or comes back online, and every two minutes. Only maps that changed are transferred. Uploads are guarded by the file's eTag, so if another device wrote first the app downloads, merges and tries again instead of overwriting.

## Project layout

```
index.html            app shell
css/app.css           design system and both themes (shared look with WorldAtlas)
css/editor.css        the editor
js/app.js             boot, routing, top bar
js/views/*.js         one module per screen
js/render.js          draws a map document (editor and thumbnails)
js/store.js           projects and drawings, merge rules
js/sync.js            OneDrive sync
js/auth.js            Microsoft sign-in (PKCE), background renewal
js/db.js              IndexedDB
sw.js                 offline cache; bump js/version.js on every release
```
