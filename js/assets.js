// The art library. Each image is identified by the SHA-256 of its bytes, so
// the same file imported twice (or on two devices) is one asset, and its
// OneDrive copy never changes once uploaded.
//
// The catalogue (name, pack, category, size…) syncs as assets.json, merged
// record by record like projects. The pictures themselves sync as separate
// files (see assetsync.js): every device fetches the small thumbnails, and
// full-size art only when it's needed or its pack is kept offline.
//
// Packs and categories come from folders: the top folder of an import is the
// pack, and the folders inside it are categories.
import * as db from './db.js';
import { meta, saveMeta, notify } from './store.js';

export const assets = new Map();

// Bumped whenever the catalogue changes, so the transfer code knows when
// there may be new files to look for.
let version = 0;
export const catalogueVersion = () => version;

export async function loadAssets() {
  version++;
  assets.clear();
  for (const a of await db.getAll('assets')) assets.set(a.id, a);
}

export const liveAssets = () => [...assets.values()].filter((a) => !a.deleted);
export const asset = (id) => { const a = assets.get(id); return a && !a.deleted ? a : null; };

export const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
const TYPE_OF = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
const extOf = (path) => path.split('.').pop().toLowerCase();
export const isImagePath = (path) => extOf(path) in TYPE_OF && !/(^|\/)(__MACOSX|\.)/.test(path);

// Folders whose names suggest repeating fills start out as textures; the
// library page can switch any category either way.
const guessKind = (category) => (/textur|tile|pattern|fill|ground/i.test(category) ? 'texture' : 'stamp');

// Packs on this device: [{ name, count, bytes, categories: [{ name, count, kind }] }]
// What kind of map a pack is made for (its records' mapType), so the picker
// can show a map's own kind of art first. Packs start as 'any'.
export const PACK_TYPES = [['any', 'Any map'], ['world', 'World maps'], ['region', 'Region maps'], ['city', 'City maps'], ['battlemap', 'Battlemaps']];

// Names in the order people expect: "tree 2" before "tree 10". One collator
// does this far faster than localeCompare with options on every comparison.
const collator = new Intl.Collator(undefined, { numeric: true });
export const byName = (a, b) => collator.compare(a.name, b.name);

// The live assets of each category, found once per change of the catalogue
// (and sorted when a category is first looked at), not on every redraw of a
// list. Thousands of assets in hundreds of categories would otherwise be
// searched once per category each time.
const memo = { at: -1, packs: null, groups: null, sorted: new Map() };
function fresh() {
  if (memo.at === version) return;
  memo.at = version;
  memo.packs = null;
  memo.sorted.clear();
  memo.groups = new Map();
  for (const a of liveAssets()) {
    const key = `${a.pack}\u0000${a.category}`;
    const list = memo.groups.get(key);
    if (list) list.push(a); else memo.groups.set(key, [a]);
  }
}
export function categoryAssets(pack, category) {
  fresh();
  const key = `${pack}\u0000${category}`;
  let list = memo.sorted.get(key);
  if (!list) memo.sorted.set(key, list = (memo.groups.get(key) || []).slice().sort(byName));
  return list;
}

export function packs() {
  fresh();
  return memo.packs ??= buildPacks();
}

function buildPacks() {
  const by = new Map();
  for (const a of liveAssets()) {
    let p = by.get(a.pack);
    if (!p) by.set(a.pack, p = { name: a.pack, count: 0, bytes: 0, cats: new Map(), type: 'any' });
    if (a.mapType && p.type === 'any') p.type = a.mapType;
    p.count++; p.bytes += a.size || 0;
    const c = p.cats.get(a.category) || { name: a.category, count: 0, kind: a.kind };
    c.count++;
    p.cats.set(a.category, c);
  }
  return [...by.values()].sort((x, y) => collator.compare(x.name, y.name)).map((p) => ({
    ...p, categories: [...p.cats.values()].sort((x, y) => collator.compare(x.name, y.name)),
  }));
}

const stamp = (rec) => { rec.updatedAt = Math.max(Date.now(), (assets.get(rec.id)?.updatedAt || 0) + 1); return rec; };

async function saveRecords(recs) {
  if (!recs.length) return;
  for (const r of recs) assets.set(r.id, stamp(r));
  version++;
  await db.putMany('assets', recs);
  await saveMeta({ assetRev: meta.assetRev + 1 }, { bump: ['assetRev'] });
  notify({ local: true, store: 'assets' });
}

export async function deletePack(name) {
  const gone = liveAssets().filter((a) => a.pack === name);
  // Tombstones keep the type: it names the file to remove from OneDrive.
  await saveRecords(gone.map((a) => ({ id: a.id, type: a.type, deleted: true })));
  await dropLocal(gone.map((a) => a.id));
  // This device is the one to remove their files from OneDrive (see assetsync.js).
  const states = await allStates();
  await db.putMany('assetState', gone.map((a) => ({ ...cleared(states.get(a.id) || { id: a.id }), purgePending: true, purged: false })));
  await saveMeta({ pinned: meta.pinned.filter((p) => p !== name) });
}

export async function setPackType(pack, type) {
  await saveRecords(liveAssets().filter((a) => a.pack === pack && (a.mapType || 'any') !== type).map((a) => ({ ...a, mapType: type })));
}

export async function setCategoryKind(pack, category, kind) {
  await saveRecords(liveAssets().filter((a) => a.pack === pack && a.category === category && a.kind !== kind).map((a) => ({ ...a, kind })));
}

export async function setPinned(pack, on) {
  const rest = meta.pinned.filter((p) => p !== pack);
  await saveMeta({ pinned: on ? [...rest, pack] : rest });
}

// Bring in catalogue records from OneDrive. Returns true if this device has
// anything the remote copy lacks.
export async function mergeAssets(remote) {
  let localAhead = false;
  const incoming = [];
  const seen = new Set();
  for (const r of remote) {
    seen.add(r.id);
    const l = assets.get(r.id);
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) incoming.push(r);
    else if ((l.updatedAt || 0) > (r.updatedAt || 0)) localAhead = true;
  }
  if ([...assets.keys()].some((id) => !seen.has(id))) localAhead = true;
  for (const r of incoming) assets.set(r.id, r);
  if (incoming.length) version++;
  await db.putMany('assets', incoming);
  await dropLocal(incoming.filter((r) => r.deleted).map((r) => r.id));
  if (incoming.length) notify({ local: false, store: 'assets' });
  return localAhead;
}

// --- pictures on this device --------------------------------------------

const urls = new Map(); // `${store}:${id}` → object URL

export async function pictureURL(store, id) {
  const key = `${store}:${id}`;
  if (urls.has(key)) return urls.get(key);
  const rec = await db.get(store, id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(key, url);
  return url;
}
export const thumbURL = (id) => pictureURL('thumbs', id);
// The thumbnail's URL if it's already been loaded (so it can be drawn at once).
export const cachedThumbURL = (id) => urls.get(`thumbs:${id}`) || null;

export const getBlob = async (id) => (await db.get('blobs', id))?.blob || null;
export const getThumb = async (id) => (await db.get('thumbs', id))?.blob || null;
export const putBlob = (id, blob) => db.put('blobs', { id, blob });
export const putThumb = (id, blob) => db.put('thumbs', { id, blob });
export const blobIds = async () => new Set(await db.getAllKeys('blobs'));
export const thumbIds = async () => new Set(await db.getAllKeys('thumbs'));
export const getState = async (id) => (await db.get('assetState', id)) || { id };
export const putState = (rec) => db.put('assetState', rec);
const cleared = ({ failCount, nextTry, lastError, purged, ...s }) => s;
export const allStates = async () => new Map((await db.getAll('assetState')).map((s) => [s.id, s]));

async function dropLocal(ids) {
  if (!ids.length) return;
  await db.del('blobs', ids);
  await db.del('thumbs', ids);
  for (const id of ids) for (const s of ['blobs', 'thumbs']) {
    const url = urls.get(`${s}:${id}`);
    if (url) { URL.revokeObjectURL(url); urls.delete(`${s}:${id}`); }
  }
}

// --- importing ----------------------------------------------------------

// If every entry shares one top folder, that's the pack's name (and not a category).
export function splitRoot(entries) {
  const firsts = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
  const root = firsts.size === 1 ? [...firsts][0] : '';
  return { root, entries: root ? entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) })) : entries };
}

async function hash(blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    const url = URL.createObjectURL(blob);
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Not a readable image')); };
    img.src = url;
  });
}

const THUMB = 160;
async function makeThumb(blob) {
  const img = await loadImage(blob);
  try {
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    const s = Math.min(1, THUMB / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    // WebP where the browser can write it (Safari falls back to PNG).
    const thumb = await new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
    if (!thumb) throw new Error('Could not make a thumbnail');
    return { thumb, w, h };
  } finally { URL.revokeObjectURL(img.src); }
}

// entries: [{ path (inside the pack, '/'-separated), blob: () => Promise<Blob> }]
// onProgress({ done, total, added, skipped }) is called as it goes.
// A few images are read, hashed and shrunk at a time; their files are saved
// together, a batch at a time, and each batch's catalogue records only after
// its pictures are safely stored (so an interrupted import never leaves a
// record without a picture).
const IMPORT_WIDE = 3;
const IMPORT_BATCH = 50;
export async function importEntries(entries, pack, onProgress = () => {}) {
  const list = entries.filter((e) => isImagePath(e.path));
  const progress = { done: 0, total: list.length, added: 0, skipped: 0 };
  const seen = new Set(); // ids taken by this import, before they are in the catalogue
  // Images added to an existing pack take on what it's made for.
  const mapType = packs().find((p) => p.name === pack)?.type;
  let ready = [];
  let saving = Promise.resolve();
  const flush = () => {
    const batch = ready;
    ready = [];
    if (!batch.length) return saving;
    return saving = saving.then(async () => {
      await db.tx(['blobs', 'thumbs', 'assetState'], ({ put }) => {
        for (const b of batch) {
          put('blobs', { id: b.rec.id, blob: b.blob });
          put('thumbs', { id: b.rec.id, blob: b.thumb });
          put('assetState', { id: b.rec.id }); // not uploaded yet (also after a re-import of a deleted asset)
        }
      });
      await saveRecords(batch.map((b) => b.rec));
    });
  };
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const e = list[next++];
      try {
        const raw = await e.blob();
        const type = TYPE_OF[extOf(e.path)];
        const blob = raw.type === type ? raw : new Blob([raw], { type });
        const id = await hash(blob);
        // (No waiting between checking and taking an id, so two workers
        // holding the same picture can't both add it.)
        if (asset(id) || seen.has(id)) { progress.skipped++; continue; }
        seen.add(id);
        const { thumb, w, h } = await makeThumb(blob);
        const parts = e.path.split('/');
        const file = parts.pop();
        const category = parts.join('/');
        ready.push({ blob, thumb, rec: { id, name: file.replace(/\.[^.]+$/, ''), pack, category, kind: guessKind(category), type, size: blob.size, w, h, ...(mapType && mapType !== 'any' ? { mapType } : {}) } });
        progress.added++;
      } catch (err) {
        console.warn('Skipped', e.path, err);
        progress.skipped++;
      } finally {
        progress.done++;
        onProgress(progress);
      }
      if (ready.length >= IMPORT_BATCH) await flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_WIDE, list.length) }, worker));
  await flush();
  return progress;
}
