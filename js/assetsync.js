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
import * as db from './db.js';
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

let running = null, again = false, relist = false;
// force: look on OneDrive for new files even if nothing suggests there are any.
export function kick({ force = false } = {}) {
  if (force) relist = true;
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; kick(); }
  });
  return running;
}

// Each stage reports the files it couldn't move rather than giving up, and
// one stage failing doesn't stop the next: a single bad file mustn't keep
// everyone else's pictures from arriving.
async function run() {
  if (!auth.isSignedIn() || !navigator.onLine) return;
  const force = relist;
  relist = false;
  report({ state: 'working', up: 0, upTotal: 0, down: 0, downTotal: 0, message: '' });
  const problems = [];
  for (const stage of [purge, upload, download]) {
    try {
      problems.push(...await stage(force));
    } catch (e) {
      console.error('Asset transfer failed', e);
      problems.push(e);
      if (e instanceof auth.ReauthRequired) break;
    }
  }
  if (problems.length) {
    const first = problems[0];
    return report({ state: 'error', message: problems.length > 1 ? `${problems.length} problems, the first: ${first.message || first}` : first.message || String(first) });
  }
  // Files still waiting out their delay after an earlier failure count as problems too.
  const stuck = [...(await A.allStates()).values()].filter(waiting);
  if (stuck.length) report({ state: 'error', message: `${stuck.length} ${stuck.length === 1 ? 'file' : 'files'} couldn’t be transferred and will be tried again later (${stuck[0].lastError})` });
  else report({ state: 'idle', message: '' });
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

// Runs fn on every item, several at a time. A failing item is noted and the
// rest carry on; resolves with the failures, once every worker has finished.
// (A lapsed sign-in stops everything: the rest would fail the same way.)
async function pool(items, fn) {
  const failed = [];
  let i = 0, stop = false;
  const worker = async () => {
    while (i < items.length && !stop) {
      const item = items[i++];
      try { await fn(item); } catch (e) {
        failed.push({ item, error: e });
        if (e instanceof auth.ReauthRequired) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return failed;
}

// A file that fails is left alone for longer each time: 30 s, 1 min, 2 min…
// up to an hour. The record is the asset's device state; one made only to
// remember this (dlOnly) doesn't mean the asset was imported here.
const waiting = (s) => (s?.nextTry || 0) > Date.now();
const mine = (s) => !!s && !s.dlOnly;
async function noteFailure(states, id, error) {
  if (error instanceof auth.ReauthRequired) return;
  const s = states.get(id) || { id, dlOnly: true };
  const failCount = (s.failCount || 0) + 1;
  await A.putState({ ...s, failCount, lastError: error.message || String(error), nextTry: Date.now() + Math.min(3600e3, 30e3 * 2 ** (failCount - 1)) });
}
const cleared = ({ failCount, nextTry, lastError, ...s }) => s;

// Make every file this device holds count as not yet uploaded (for an
// account that has none of them).
export async function markAllUnsent() {
  const states = await A.allStates();
  const ids = new Set([...await A.blobIds(), ...await A.thumbIds()]);
  const recs = [];
  for (const id of ids) {
    if (!A.asset(id)) continue;
    recs.push({ ...cleared(states.get(id) || { id }), dlOnly: undefined, thumbUp: false, blobUp: false });
  }
  await db.putMany('assetState', recs);
}

// Deleted assets: remove their files from OneDrive (any device may do it; a
// 404 just means another one already did).
async function purge() {
  const states = await A.allStates();
  const gone = [...A.assets.values()].filter((a) => a.deleted && !states.get(a.id)?.purged && !waiting(states.get(a.id)));
  const failed = await pool(gone, async (a) => {
    try {
      for (const path of [assetPath(a), thumbPath(a.id)]) {
        const res = await patient(() => auth.graph(`${ROOT}/${path}`, { method: 'DELETE' }));
        if (res.status !== 404) await ok(res, 'Deleting from OneDrive');
      }
    } catch (e) { await noteFailure(states, a.id, e); throw e; }
    await A.putState({ ...cleared(states.get(a.id) || { id: a.id }), purged: true });
  });
  return failed.map((f) => f.error);
}

// Art this device imported and hasn't uploaded yet: thumbnails first, so
// other devices can browse the pack soon, then the full-size files.
async function upload() {
  const states = await A.allStates();
  const blobs = await A.blobIds();
  const thumbs = await A.thumbIds();
  const live = A.liveAssets();
  const ready = (a) => mine(states.get(a.id)) && !waiting(states.get(a.id));
  const needThumb = live.filter((a) => thumbs.has(a.id) && ready(a) && !states.get(a.id).thumbUp);
  const needBlob = live.filter((a) => blobs.has(a.id) && ready(a) && !states.get(a.id).blobUp);
  if (!needThumb.length && !needBlob.length) return [];
  report({ upTotal: needThumb.length + needBlob.length, up: 0 });
  const put = async (path, blob, type) => {
    const res = await patient(() => auth.graph(`${ROOT}/${path}:/content`, { method: 'PUT', headers: { 'Content-Type': type }, body: blob }));
    await ok(res, 'Uploading ' + path);
  };
  const step = (flag, get, path, typeOf) => async (a) => {
    try {
      const blob = await get(a.id);
      if (blob) await put(path(a), blob, typeOf(a, blob));
    } catch (e) { await noteFailure(states, a.id, e); throw e; }
    await A.putState({ ...cleared(await A.getState(a.id)), [flag]: true });
    report({ up: progress.up + 1 });
  };
  const failed = await pool(needThumb, step('thumbUp', A.getThumb, (a) => thumbPath(a.id), (a, blob) => blob.type || 'image/png'));
  failed.push(...await pool(needBlob, step('blobUp', A.getBlob, assetPath, (a) => a.type)));
  return failed.map((f) => f.error);
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

// A folder listing is reused for a while: files only turn up when the
// catalogue changes or the device that has them finishes uploading, and
// listing thousands of files every couple of minutes to find nothing new
// is a lot of requests. Download links last about an hour.
const LISTING_LIFE = 15 * 60e3;
const listings = new Map(); // folder → { at, version, urls }
async function listed(folder, force) {
  const hit = listings.get(folder);
  if (!force && hit && hit.version === A.catalogueVersion() && Date.now() - hit.at < LISTING_LIFE) return hit.urls;
  const version = A.catalogueVersion();
  const urls = await listFolder(folder);
  listings.set(folder, { at: Date.now(), version, urls });
  return urls;
}

const fetchBlob = async (url, what) => (await ok(await patient(() => fetch(url)), 'Downloading ' + what)).blob();

// Thumbnails for everything, and full-size art for packs kept offline. Files
// not uploaded yet by the device that has them are simply tried again later.
async function download(force) {
  const live = A.liveAssets();
  const states = await A.allStates();
  const thumbs = await A.thumbIds();
  const blobs = await A.blobIds();
  const pinned = new Set(meta.pinned);
  const wantThumbs = live.filter((a) => !thumbs.has(a.id) && !waiting(states.get(a.id)));
  const wantBlobs = live.filter((a) => pinned.has(a.pack) && !blobs.has(a.id) && !waiting(states.get(a.id)));
  if (!wantThumbs.length && !wantBlobs.length) return [];
  const thumbUrls = wantThumbs.length ? await listed('thumbs', force) : new Map();
  const blobUrls = wantBlobs.length ? await listed('assets', force) : new Map();
  const jobs = [
    ...wantThumbs.filter((a) => thumbUrls.has(a.id)).map((a) => ['thumb', a, thumbUrls.get(a.id)]),
    ...wantBlobs.filter((a) => blobUrls.has(assetPath(a).slice(7))).map((a) => ['blob', a, blobUrls.get(assetPath(a).slice(7))]),
  ];
  if (!jobs.length) return [];
  report({ downTotal: jobs.length, down: 0 });
  let fresh = 0;
  const failed = await pool(jobs, async ([kind, a, url]) => {
    try {
      const blob = await fetchBlob(url, a.name);
      if (kind === 'thumb') await A.putThumb(a.id, blob);
      else await A.putBlob(a.id, new Blob([blob], { type: a.type }));
    } catch (e) { await noteFailure(states, a.id, e); throw e; }
    if (states.get(a.id)?.failCount) await A.putState(cleared(states.get(a.id)));
    report({ down: progress.down + 1 });
    if (++fresh % 50 === 0) listeners.forEach((fn) => fn(progress, true));
  });
  listeners.forEach((fn) => fn(progress, true)); // true: new pictures arrived
  return failed.map((f) => f.error);
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
