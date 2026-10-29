# AtlasCartographer

A fantasy map maker for phone and PC, and a companion to [WorldAtlas](https://github.com/Momijisu/WorldAtlas). It works offline, installs as its own app, and syncs through your own OneDrive.

Plain HTML, CSS and JavaScript. No server, no build step.

## Status

Early. What works today:

- Projects: create, rename and delete maps. Every map uses the same editor; its type sets the start: World and Region maps begin as sea, City maps and Battlemaps as land (the water brush carves rivers and lakes), and Battlemaps are sized in squares with a matching grid. Art packs can be tagged with the kind of map they're for, and the picker shows that art first
- Editor: pan and zoom (mouse, wheel, touch, pinch), an ink pen in five colours, an eraser, undo and redo
- Land and water: paint land, carve water (or hold Alt to switch), and the coastline, its outline and ripple rings in the sea draw themselves. Coasts are irregular like real shorelines (bays, headlands, a ragged edge), from smooth to rugged in Map style; each stroke's shape is fixed by its id, so it's the same on every device. Fill the land with any texture from the library. On PC the land is drawn at the map's full resolution; phones and tablets use a lighter version (Settings → Land detail)
- Terrain: paint any library texture onto the land (grass, forest floor, sand…) with soft edges and adjustable strength; it stops at the coast. Paint "Base land" to take it back off
- Paths: roads (dashed), trails (dotted), borders (dash-dot), and rivers that widen towards the mouth. Select one to reshape it: drag its points, drag a + to add a point, Alt-click or double-click to remove one; change its style or width in Adjust
- Map style: sea, land and coastline colours, coastline width, the shore (ripples, engraved hatching or plain), shadows under stamps; and finishing touches: a paper texture over the whole map, square or hex grids, darker edges, a line or double frame, a scale bar
- Stamps from the art library: place one, or paint many with the scatter brush (randomly chosen from the pictures you pick, nudged, resized and mirrored a little, overlapping front to back). Select a stamp to move, scale (corners), rotate (top handle; Shift snaps to 15°), flip, bring forward, send back or delete. Adjust opacity, tint and brightness. Drag a box (or Shift-click) to select several; duplicate, copy and paste, also between maps
- Labels: straight, curved, or along a line you draw (drag with the text tool; its points edit like a path's), in six fonts, with colour, letter spacing, capitals and a soft outline. Move, rotate and resize them like stamps; Enter or a double-click edits
- Layers: start with Labels, Stamps, and Ink and paths over Land and sea; add your own, rename and reorder them, choose which one you draw on (or Automatic: each kind on its own), and move selected things between them. Hide a layer (saved with the map, and left out of exports) or lock it on this device so it can't be selected or erased. Deleting a layer keeps what's on it. Labels stay above the paper, grid and shading
- Export as PNG, WebP or JPEG, at full size or smaller, with every stamp's full-size art (ready to upload to WorldAtlas Maps)
- OneDrive sync of every project, merged stroke by stroke, so edits from two devices both survive
- Art library: import a folder or zip of images (PNG, WebP, JPEG, GIF, SVG, AVIF). The top folder is the pack; folders inside it are categories, each marked as stamps or textures. Duplicates are skipped.
- Art syncs through OneDrive: the device that imported a pack uploads it in the background; other devices get thumbnails straight away and full-size art when it's used, or the whole pack with **Keep offline**
- Installable and offline, with dark and light themes

Planned:

- Grid snapping, a wall-and-door tool, exports sized for virtual tabletops

## Editor shortcuts

| Key | | Key | |
|---|---|---|---|
| H / Space | move the view | V | select |
| L | land and water | Alt (while painting) | the other one |
| G | terrain | P | paths |
| T | text | Enter | edit the selected label |
| B | ink pen | E | eraser |
| S | stamp | R | scatter |
| [ ] | smaller / larger (or send back / bring forward) | F | flip |
| Del | delete | 0 | fit the map |
| Ctrl+Z | undo | Ctrl+Shift+Z | redo |
| Ctrl+A | select all | Ctrl+D | duplicate |
| Ctrl+C / X / V | copy, cut, paste | Esc | clear the selection |

## Art assets

No art is bundled. Asset packs are imported on a device and synced through your OneDrive; they are never committed to this repository (`.gitignore` guards the usual places).

Each image is named by a hash of its contents, so the same file imported twice is stored once, and an uploaded file never changes. Zips can use the usual compression (stored or deflate) but not ZIP64: split archives over 4 GB, or import the unzipped folder. Importing a whole folder needs a desktop browser; on phones, import zips or pick images.

## 1. Hosting

The app must be served over HTTPS to install on a phone. GitHub Pages works:

1. Push to `main`.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. `.github/workflows/pages.yml` deploys every push to `main`, to `https://<user>.github.io/<repo>/`.

## 2. OneDrive sync

AtlasCartographer has its own Azure app registration (its client ID is in `js/config.js`). To set one up for another copy:

1. Sign in at https://entra.microsoft.com → **App registrations → New registration**:
   - Supported account types: *any organizational directory and personal Microsoft accounts*
   - Redirect URI: platform **Single-page application**, URL = the app's address with the trailing `/` (e.g. `https://momijisu.github.io/AtlasCartographer/`; Settings shows it with a Copy button)
2. Copy the **Application (client) ID** into `js/config.js` and push. (With no ID there, Settings asks each device for one.)
3. In the app, **Settings → Connect OneDrive**.

The app asks for `Files.ReadWrite.AppFolder`, which only reaches its own folder, `OneDrive/Apps/<registration name>`, and `User.Read` for your name. WorldAtlas and this app live on the same site (`<user>.github.io`), so their sign-ins and local data are kept under separate names.

For local testing, add `http://localhost:8000/` as a redirect URI and run `python3 -m http.server 8000`.

## Syncing

Each device keeps a full copy in IndexedDB. OneDrive holds:

```
Apps/<registration name>/
  projects.json          every map's name and size (and deletions)
  projects/<id>.json     each map's drawing
  assets.json            the art catalogue: pack, category, size, stamp or texture
  assets/<hash>.<ext>    full-size art
  thumbs/<hash>          small previews
```

Sync runs shortly after each edit, when the app is reopened or comes back online, and every two minutes. Only maps that changed are transferred. Art moves in the background afterwards, several files at a time, waiting whenever OneDrive asks to slow down; an interrupted upload picks up where it left off. Uploads are guarded by the file's eTag, so if another device wrote first the app downloads, merges and tries again instead of overwriting.

## Project layout

```
index.html            app shell
css/app.css           design system and both themes (shared look with WorldAtlas)
css/editor.css        the editor
js/app.js             boot, routing, top bar
js/views/*.js         one module per screen
js/render.js          draws a map document (editor and thumbnails)
js/images.js          decoded art for drawing, loading full size on demand
js/export.js          full-size picture export
js/store.js           projects and drawings, merge rules
js/assets.js          art catalogue, importing, pictures on this device
js/assetsync.js       moving art to and from OneDrive
js/zip.js             zip reader (no dependencies)
js/sync.js            OneDrive sync
js/auth.js            Microsoft sign-in (PKCE), background renewal
js/db.js              IndexedDB
sw.js                 offline cache; bump js/version.js on every release
```
