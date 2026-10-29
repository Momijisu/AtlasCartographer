// Two-way sync between IndexedDB and the app's own folder in OneDrive → Apps.
//
// projects.json holds every project's index record (including deletion
// tombstones); projects/<id>.json holds each project's drawing. Both merge
// record by record (see store.js), so edits on phone and PC never clobber each
// other. Uploads use the file's eTag (If-Match), so a concurrent write from
// another device makes us re-download and merge instead of overwriting. One
// listing of projects/ tells us which drawings changed elsewhere, so a sync
// only transfers the maps that need it.
//
// assets.json is the art catalogue, merged the same way; the art itself moves
// in the background afterwards (assetsync.js).
import * as auth from './auth.js';
import * as store from './store.js';
import * as assets from './assets.js';
import * as assetsync from './assetsync.js';

const APPROOT = '/me/drive/special/approot';
const ROOT = `${APPROOT}:`; // + '/path/in/the/app/folder'
const INDEX = 'projects.json';
const CATALOGUE = 'assets.json';
const docPath = (id) => `projects/${id}.json`;

let status = { state: 'off', message: '' };
const listeners = new Set();
export const onStatus = (fn) => listeners.add(fn);
export const getStatus = () => status;
function setStatus(state, message = '') {
  status = { state, message };
  listeners.forEach((fn) => fn(status));
}

export function refreshStatus() {
  if (auth.isSignedIn()) setStatus(store.isDirty() ? 'pending' : 'synced');
  else if (auth.account()) setStatus('reauth', 'Reconnect OneDrive to resume syncing.');
  else setStatus('off');
}

let running = null;
let again = false;
export function sync() {
  if (running) { again = true; return running; }
  running = run().finally(() => {
    running = null;
    if (again) { again = false; sync(); }
  });
  return running;
}

async function run() {
  if (!auth.isSignedIn()) {
    if (auth.account() && await auth.renewSilently()) return run();
    return refreshStatus();
  }
  if (!navigator.onLine) return setStatus('offline', 'Offline. Changes are saved on this device.');
  setStatus('syncing');
  try {
    await retry(INDEX, syncIndex);
    await retry(CATALOGUE, syncCatalogue);
    const remote = await listDocs();
    for (const p of [...store.projects.values()]) {
      if (p.deleted) await removeRemoteDoc(p.id, remote);
      else {
        // The listing's eTag saves a request on the first try; after a race,
        // read the file afresh.
        // A map this device doesn't have yet is looked up directly rather
        // than trusting the listing, so it's never missed.
        let listed = remote.get(docPath(p.id)) ?? (await store.hasDoc(p.id) ? null : undefined);
        await retry(p.name || p.id, () => { const e = listed; listed = undefined; return syncDoc(p.id, e); });
      }
    }
    await store.saveMeta({ lastSync: Date.now() });
    setStatus(store.isDirty() ? 'pending' : 'synced');
    assetsync.kick();
  } catch (e) {
    console.error('Sync failed', e);
    // A lapsed session: try renewing in the background before asking.
    if (e instanceof auth.ReauthRequired && await auth.renewSilently()) { again = true; return; }
    if (e instanceof auth.ReauthRequired) setStatus('reauth', e.message);
    else if (!navigator.onLine) setStatus('offline', 'Offline. Changes are saved on this device.');
    else setStatus('error', e.message || String(e));
  }
}

// A step returns false when another device wrote the same file mid-sync;
// running it again merges their version in first.
async function retry(what, step) {
  for (let attempt = 0; attempt < 4; attempt++) if (await step()) return;
  throw new Error(`OneDrive kept changing ${what} during sync. Try again shortly.`);
}

async function check(res, what) {
  if (res.ok) return res;
  let msg = `${what} failed (${res.status})`;
  try { msg += ': ' + (await res.json()).error.message; } catch { /* ignore */ }
  const err = new Error(msg);
  err.status = res.status;
  throw err;
}

// Download, merge and (if this device is ahead) upload one JSON file.
// Returns true when local and remote agree, false on an eTag race.
async function syncFile(path, { merge, collect, dirty, hasLocal, remoteETag, agreed }) {
  let item = null;
  const readItem = async () => {
    const res = await auth.graph(`${ROOT}/${path}`);
    item = res.status === 404 ? null : await (await check(res, 'Reading OneDrive')).json();
    remoteETag = item?.eTag || null;
  };
  if (remoteETag === undefined) await readItem();
  let localAhead;
  if (!remoteETag) {
    localAhead = hasLocal;
  } else if (remoteETag !== store.meta.eTags[path]) {
    if (!item) await readItem();
    if (!item) return false; // deleted since it was listed — start over
    const content = await check(await fetch(item['@microsoft.graph.downloadUrl']), 'Downloading ' + path);
    localAhead = await merge(await content.json());
  } else {
    localAhead = dirty;
  }
  // Snapshot now: the upload (and the sync baseline) cover exactly this state.
  const snap = await collect();
  if (localAhead) {
    const res = await auth.graph(`${ROOT}/${path}:/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(remoteETag ? { 'If-Match': remoteETag } : { 'If-None-Match': '*' }) },
      body: JSON.stringify({ app: 'AtlasCartographer', version: 1, savedAt: Date.now(), ...snap.body }),
    });
    if (res.status === 412 || res.status === 409) return false; // someone else wrote first — merge again
    remoteETag = (await (await check(res, 'Uploading ' + path)).json()).eTag;
  }
  await store.saveMeta({ eTags: { ...store.meta.eTags, [path]: remoteETag } });
  await agreed(snap);
  return true;
}

function syncIndex() {
  return syncFile(INDEX, {
    merge: (json) => store.mergeProjects(json.projects || []),
    collect: () => ({ rev: store.meta.localRev, body: { projects: [...store.projects.values()] } }),
    dirty: store.meta.localRev > store.meta.syncedRev,
    hasLocal: store.projects.size > 0,
    agreed: (snap) => store.saveMeta({ syncedRev: snap.rev }),
  });
}

function syncCatalogue() {
  return syncFile(CATALOGUE, {
    merge: (json) => assets.mergeAssets(json.assets || []),
    collect: () => ({ rev: store.meta.assetRev, body: { assets: [...assets.assets.values()] } }),
    dirty: store.meta.assetRev > store.meta.assetSynced,
    hasLocal: assets.assets.size > 0,
    agreed: (snap) => store.saveMeta({ assetSynced: snap.rev }),
  });
}

// remoteETag: from the listing (null = not on OneDrive), or undefined to read it.
async function syncDoc(id, remoteETag) {
  const path = docPath(id);
  // A project another device made: fetch its drawing even if the eTag is one
  // we've seen (e.g. this device's copy was cleared).
  if (!(await store.hasDoc(id))) await store.saveMeta({ eTags: { ...store.meta.eTags, [path]: null } });
  return syncFile(path, {
    merge: (json) => store.mergeDoc(id, json),
    collect: async () => {
      const rev = store.meta.docRev[id] || 0;
      return { rev, body: { id, objects: (await store.getDoc(id))?.objects || {} } };
    },
    dirty: store.docDirty(id),
    hasLocal: await store.hasDoc(id),
    remoteETag,
    agreed: (snap) => store.saveMeta({ docSynced: { ...store.meta.docSynced, [id]: snap.rev } }),
  });
}

// name → eTag of every drawing in projects/, following OneDrive's paging.
async function listDocs() {
  const out = new Map();
  let url = `${ROOT}/projects:/children?$select=name,eTag&$top=200`;
  while (url) {
    const res = await auth.graph(url);
    if (res.status === 404) break;
    const json = await (await check(res, 'Listing projects')).json();
    for (const it of json.value) out.set(`projects/${it.name}`, it.eTag);
    url = json['@odata.nextLink'] || null;
  }
  return out;
}

async function removeRemoteDoc(id, remote) {
  const path = docPath(id);
  if (remote.has(path)) {
    const res = await auth.graph(`${ROOT}/${path}`, { method: 'DELETE' });
    if (res.status !== 404) await check(res, 'Deleting a project from OneDrive');
  }
  if (path in store.meta.eTags) {
    const { [path]: _, ...eTags } = store.meta.eTags;
    await store.saveMeta({ eTags });
  }
  await store.dropDoc(id);
}

// Background scheduling: sync shortly after local edits, when the app comes
// back into view, when the network returns, and every couple of minutes.
export function start() {
  const soon = debounceSync(2500);
  store.onChange((e) => { if (e.local) { refreshStatus(); soon(); } });
  addEventListener('online', () => sync());
  addEventListener('offline', () => refreshStatus());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
    else if (store.isDirty()) sync(); // try to flush before the app is backgrounded
  });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 120000);
  refreshStatus();
  sync();
}

function debounceSync(ms) {
  let t;
  return () => { clearTimeout(t); t = setTimeout(sync, ms); };
}
