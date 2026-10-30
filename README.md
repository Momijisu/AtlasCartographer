# AtlasCartographer

A fantasy map maker for phone and PC, and a companion to [WorldAtlas](https://github.com/Momijisu/WorldAtlas). It works offline and syncs through your own OneDrive.

**Live app:** https://momijisu.github.io/AtlasCartographer/

## Features

- World, region, city and battlemap maps in one editor: world and region maps start as sea, cities and battlemaps as land, and battlemaps are sized in squares with a matching grid
- Land and water brushes that draw the coastline, its outline and ripples in the sea for you, with coasts from smooth to rugged
- Terrain painting: any texture from your art library brushed onto the land with soft edges and adjustable strength, stopping at the coast
- Shapes: rectangles, ellipses, clicked-out polygons and freehand outlines, filled with a colour or texture and outlined (solid, dotted or dashed); matching shapes merge into one outline, and cut-outs make holes, for floor plans and walls
- Stamps from your art library, placed one at a time (turned and flipped before placing if you like) or many at once (area, density, size variation, random rotation and mirroring); Ctrl-click to place a random mix, and step through numbered variants of a stamp with Alt + arrows
- Move, scale, rotate, flip, layer, tint, brighten and fade stamps; select several to move, duplicate, copy and paste, also between maps
- Paths: roads, trails, borders, and rivers that widen towards the mouth, with points you can drag, add and remove afterwards
- Labels: straight, curved, or along a line you draw, in six fonts, with letter spacing, capitals and a soft outline
- A pen and colour brush from fine lines to broad washes, with opacity and soft edges
- Layers you can add, rename, reorder, hide and lock
- Map style: sea, land and coast colours, coast width, rippled, hatched or plain shores, stamp shadows, a paper texture, square or hex grids, darker edges, a frame and a scale bar
- An art library: import a folder or zip of images laid out as pack / category / stamp / variations (a folder of pictures inside a category is one stamp, its pictures its variations; numbered names like "Tower 1", "Tower 2" count too); the picker shows one tile per stamp with its variations a tap away, placed at random or one at a time; export any pack as a single `.atlaspack` file and import it on another device or install; tag packs by map type, browse them with previews, search everything, and see what you've used recently
- Export to PNG, WebP or JPEG at full size or smaller, ready to upload to WorldAtlas Maps
- Duplicate a map, or change its size by scaling everything or changing the canvas
- Inkarnate's keyboard layout (W/S size, E/D opacity, Q/A softness, F catalogue, and the rest), plus grouping, locking and snapping to the grid; press **K** or **?** in the editor for the list
- Dark and light themes

Plain HTML, CSS and JavaScript. No server, no build step.

Planned: grid snapping, a wall-and-door tool, and exports sized for virtual tabletops.

## 1. Hosting

The app must be served over HTTPS to install on a phone. GitHub Pages works:

1. Push to `main`.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. `.github/workflows/pages.yml` deploys every push to `main`, to `https://<user>.github.io/<repo>/`.

Pages on a private repo needs a paid GitHub plan. Maps and art aren't stored in the repo, so a public repo is fine. Netlify or Cloudflare Pages also work.

## 2. OneDrive sync

One-time setup with Microsoft:

1. Sign in at https://entra.microsoft.com with the account whose OneDrive you'll use. If personal accounts are refused, create a free Azure account first (card verification, no charge).
2. **App registrations → New registration**:
   - Supported account types: *any organizational directory and personal Microsoft accounts*
   - Redirect URI: platform **Single-page application**, URL = the app's address with the trailing `/` (Settings shows it with a Copy button)
3. Copy the **Application (client) ID** into `js/config.js` and push. (With no ID there, Settings asks each device for one.)
4. In the app, **Settings → Connect OneDrive**.

The app asks for `Files.ReadWrite.AppFolder`, which only reaches `OneDrive/Apps/<registration name>`, and `User.Read` for your name. No other permissions are needed. Give it its own registration rather than WorldAtlas's, so each app keeps to its own folder.

For local testing, add `http://localhost:8000/` as a redirect URI and run `python3 -m http.server 8000`.

## 3. Installing

- **Android:** Chrome menu → *Install app*. In Edge: menu → *Add to phone*.
- **iPhone/iPad:** Share → *Add to Home Screen*. Connect OneDrive from inside the installed app; iOS keeps its storage separate from the browser's.
- **PC:** the install icon in the address bar, in Edge or Chrome.

It installs as its own app next to WorldAtlas: its manifest has its own `id`, since both live on the same site.

## Syncing

Each device keeps a full copy in IndexedDB. OneDrive holds `projects.json` (every map's name, size and type), `projects/` (each map's drawing), `assets.json` (the art catalogue), `assets/` (full-size art) and `thumbs/` (previews).

Sync runs shortly after each edit, when the app is reopened or comes back online, and every two minutes. Only maps that changed are transferred, and they merge object by object, so edits made on two devices both survive. If OneDrive asks the app to slow down, it waits and carries on.

Art is never part of the app or this repo. The device that imports a pack uploads it in the background, a few files at a time, and picks up where it left off if interrupted; other devices get the previews straight away and full-size art when it's used, or a whole pack with **Keep offline**. Each image is named by a hash of its contents, so the same file imported twice is stored once. Zips can't be over 4 GB (ZIP64); import the unzipped folder instead, from a desktop browser.

OneDrive keeps art as one file per image, so a device only downloads what it uses and a new image is a single upload. To keep a pack as one file, open it in the Art library and choose **Export pack file**: you get a `.atlaspack` (a zip of the images in their category folders, plus `pack.json` with each image's name, whether its category is stamps or textures, and the map type). **Import pack, zip or images** reads it back, and the installed app on a desktop also opens `.atlaspack` files directly. Images missing from both this device and OneDrive are left out of an export, and the export says how many.

Microsoft limits browser sign-ins to 24 hours. The app renews in the background before then, in a hidden frame, so nothing interrupts you. Browsers that block third-party sign-in cookies (such as Safari) can't renew this way; there the sync badge shows **Reconnect**, and one tap signs you straight back in.

## Project layout

```
index.html            app shell
css/app.css           design system and both themes (shared with WorldAtlas)
css/editor.css        the editor
js/app.js             boot, routing, top bar
js/views/*.js         one module per screen: maps, editor, art library, settings
js/render.js          draws a map: land and coasts, terrain, stamps, paths, labels, finishing
js/images.js          decoded art for drawing, loading full size on demand
js/export.js          picture export
js/store.js           maps and their drawings, merging
js/sync.js            OneDrive sync
js/assets.js          art catalogue and importing
js/assetsync.js       moving art to and from OneDrive
js/packfile.js        .atlaspack pack files
js/zip.js             zip reader and writer
js/auth.js            Microsoft sign-in (auth code + PKCE)
js/db.js              IndexedDB
js/icons.js           Phosphor icons (MIT)
js/config.js          Microsoft client ID
js/version.js         app version
sw.js                 service worker
fonts/                Cormorant Garamond, Alegreya Sans, Cedarville Cursive, Kalam (OFL)
```

## Releasing

Bump `AC_VERSION` and `AC_BUILD` in `js/version.js`. Installed apps pick up the new version and replace their offline cache. Settings → About shows the running and latest versions. When adding or removing files, update `SHELL` in `sw.js`.
