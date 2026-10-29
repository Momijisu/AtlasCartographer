// Moves art between this device and OneDrive, in the background after each
// sync (sync.js keeps the catalogue itself, assets.json, in step).
//
//   assets/<id>.<ext>   full-size art, uploaded by the device that imported it
//   thumbs/<id>         small previews, fetched by every device
//
// Files are named by their content hash, so they never change once uploaded:
// no eTags, no merging, and a file is only ever uploaded once. Full-size art
// comes down on demand (getAssetBlob), or all at once for packs kept offline.
// Several transfers run at a time; when Microsoft says to slow down (429/503)
// we wait as long as it asks and carry on.
import * as auth from './auth.js';
import * as A from './assets.js';
import { meta } from './store.js';

const ROOT = '/me/drive/special/approot:';
const assetPath = (a) => `assets/${a.id}.${A.EXT[a.type] || 'bin'}`;
const thumbPath = (id) => `thumbs/${id}`;
const PARALLEL = 4;

// What's happening, for the library page.
export let progress = { state: 'idle', up: 0, upTotal: 0, down: 0, downTotal: 0, message: '' };
const listeners = new Set();
export const onProgress = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const report = (patch) => { progress = { ...progress, ...patch }; listeners.forEach((fn) => fn(progress)); };

let running = null, again = false;
export function kick() {
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; kick(); }
  });
  return running;
}

async function run() {
  if (!auth.isSignedIn() || !navigator.onLine) return;
  try {
    report({ state: 'working', up: 0, upTotal: 0, down: 0, downTotal: 0, message: '' });
    await purge();
    await upload();
    await download();
    report({ state: 'idle', message: '' });
  } catch (e) {
    console.error('Asset transfer failed', e);
    report({ state: 'error', message: e.message || String(e) });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Graph (or a download URL) with patience for throttling and brief outages.
async function patient(go) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await go(); } catch (e) { if (attempt >= 4 || e instanceof auth.ReauthRequired) throw e; await sleep(2000 * 2 ** attempt); continue; }
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt >= 6) return res;
    const wait = +res.headers.get('Retry-After') || 2 * 2 ** attempt;
    report({ message: `OneDrive asked to slow down; waiting ${Math.ceil(wait)} s…` });
    await sleep(wait * 1000);
    report({ message: '' });
  }
}

async function ok(res, what) {
  if (res.ok) return res;
  let msg = `${what} failed (${res.status})`;
  try { msg += ': ' + (await res.json()).error.message; } catch { /* ignore */ }
  throw new Error(msg);
}

async function pool(items, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

// Deleted assets: remove their files from OneDrive (any device may do it; a
// 404 just means another one already did).
async function purge() {
  const states = await A.allStates();
  const gone = [...A.assets.values()].filter((a) => a.deleted && !states.get(a.id)?.purged);
  await pool(gone, async (a) => {
    for (const path of [assetPath(a), thumbPath(a.id)]) {
      const res = await patient(() => auth.graph(`${ROOT}/${path}`, { method: 'DELETE' }));
      if (res.status !== 404) await ok(res, 'Deleting from OneDrive');
    }
    await A.putState({ ...(states.get(a.id) || { id: a.id }), purged: true });
  });
}

// Art this device imported and hasn't uploaded yet: thumbnails first, so
// other devices can browse the pack soon, then the full-size files.
async function upload() {
  const states = await A.allStates();
  const blobs = await A.blobIds();
  const thumbs = await A.thumbIds();
  const live = A.liveAssets();
  const needThumb = live.filter((a) => thumbs.has(a.id) && states.has(a.id) && !states.get(a.id).thumbUp);
  const needBlob = live.filter((a) => blobs.has(a.id) && states.has(a.id) && !states.get(a.id).blobUp);
  if (!needThumb.length && !needBlob.length) return;
  report({ upTotal: needThumb.length + needBlob.length, up: 0 });
  const put = async (path, blob, type) => {
    const res = await patient(() => auth.graph(`${ROOT}/${path}:/content`, { method: 'PUT', headers: { 'Content-Type': type }, body: blob }));
    await ok(res, 'Uploading ' + path);
  };
  await pool(needThumb, async (a) => {
    const blob = await A.getThumb(a.id);
    if (blob) await put(thumbPath(a.id), blob, blob.type || 'image/png');
    await A.putState({ ...(await A.getState(a.id)), thumbUp: true });
    report({ up: progress.up + 1 });
  });
  await pool(needBlob, async (a) => {
    const blob = await A.getBlob(a.id);
    if (blob) await put(assetPath(a), blob, a.type);
    await A.putState({ ...(await A.getState(a.id)), blobUp: true });
    report({ up: progress.up + 1 });
  });
}

// name → download URL for everything in a folder, 200 per request.
async function listFolder(folder) {
  const out = new Map();
  let url = `${ROOT}/${folder}:/children?$top=200`;
  while (url) {
    const res = await patient(() => auth.graph(url));
    if (res.status === 404) break;
    const json = await (await ok(res, 'Listing ' + folder)).json();
    for (const it of json.value) if (it['@microsoft.graph.downloadUrl']) out.set(it.name, it['@microsoft.graph.downloadUrl']);
    url = json['@odata.nextLink'] || null;
  }
  return out;
}

const fetchBlob = async (url, what) => (await ok(await patient(() => fetch(url)), 'Downloading ' + what)).blob();

// Thumbnails for everything, and full-size art for packs kept offline. Files
// not uploaded yet by the device that has them are simply tried again later.
async function download() {
  const live = A.liveAssets();
  const thumbs = await A.thumbIds();
  const blobs = await A.blobIds();
  const pinned = new Set(meta.pinned);
  const wantThumbs = live.filter((a) => !thumbs.has(a.id));
  const wantBlobs = live.filter((a) => pinned.has(a.pack) && !blobs.has(a.id));
  if (!wantThumbs.length && !wantBlobs.length) return;
  const thumbUrls = wantThumbs.length ? await listFolder('thumbs') : new Map();
  const blobUrls = wantBlobs.length ? await listFolder('assets') : new Map();
  const jobs = [
    ...wantThumbs.filter((a) => thumbUrls.has(a.id)).map((a) => ['thumb', a, thumbUrls.get(a.id)]),
    ...wantBlobs.filter((a) => blobUrls.has(assetPath(a).slice(7))).map((a) => ['blob', a, blobUrls.get(assetPath(a).slice(7))]),
  ];
  if (!jobs.length) return;
  report({ downTotal: jobs.length, down: 0 });
  let fresh = 0;
  await pool(jobs, async ([kind, a, url]) => {
    const blob = await fetchBlob(url, a.name);
    if (kind === 'thumb') await A.putThumb(a.id, blob);
    else await A.putBlob(a.id, new Blob([blob], { type: a.type }));
    report({ down: progress.down + 1 });
    if (++fresh % 50 === 0) listeners.forEach((fn) => fn(progress, true));
  });
  listeners.forEach((fn) => fn(progress, true)); // true: new pictures arrived
}

// Full-size art for one asset: from this device, or downloaded (and kept).
const inflight = new Map();
export function getAssetBlob(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const local = await A.getBlob(id);
    if (local) return local;
    const a = A.asset(id);
    if (!a || !auth.isSignedIn()) return null;
    const res = await patient(() => auth.graph(`${ROOT}/${assetPath(a)}`));
    if (res.status === 404) return null; // not uploaded yet
    const item = await (await ok(res, 'Reading ' + a.name)).json();
    const blob = new Blob([await fetchBlob(item['@microsoft.graph.downloadUrl'], a.name)], { type: a.type });
    await A.putBlob(id, blob);
    return blob;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}
