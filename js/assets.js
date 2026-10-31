// The art library. Each image is identified by the SHA-256 of its bytes, so
// the same file imported twice (or on two devices) is one asset, and its
// OneDrive copy never changes once uploaded.
//
// The catalogue (name, pack, category, size…) syncs as assets.json, merged
// record by record like projects. The pictures themselves sync as separate
// files (see assetsync.js): every device fetches the small thumbnails, and
// full-size art only when it's needed or its pack is kept offline.
//
// Packs, categories and stamps come from folders: the top folder of an import
// is the pack, the folders inside it are categories (groups of art), and a
// folder inside a category is one stamp, whose pictures are its variations:
//   Pack / babylonian / gate-arch / gate-arch-1.png, gate-arch-2.png …
// Pictures straight in a category are stamps of their own, except that
// numbered names ("Tower 1", "Tower 2") are variations of one.
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

// A picture is stored once, however many packs include it. Its record says
// where it first came in (pack, category, name, kind, mapType) and, in
// `also`, the other packs that include the same file, each with those fields
// of its own. A placement is the picture as one pack sees it.
const PLACE = ['pack', 'category', 'name', 'kind', 'mapType'];
export const placements = (a) => (a.also?.length ? [a, ...a.also.map((p) => ({ ...a, ...p, also: undefined }))] : [a]);
export const livePlaced = () => liveAssets().flatMap(placements);
// The picture as the given pack sees it (or null).
export const placedIn = (a, pack) => placements(a).find((p) => p.pack === pack) || null;
// A record with its placement in `pack` changed by fn (placement fields →
// new fields, or null to take the picture out of that pack). Returns null if
// no pack would include it any more.
function replace(a, pack, fn) {
  const list = placements(a).map((p) => {
    if (p.pack !== pack) return p;
    const out = fn(Object.fromEntries(PLACE.map((k) => [k, p[k]])));
    return out && { ...p, ...out };
  }).filter(Boolean);
  // Two placements in the same pack (after a move into it) are one.
  const seen = new Set(), keep = list.filter((p) => !seen.has(p.pack) && seen.add(p.pack));
  if (!keep.length) return null;
  const [first, ...rest] = keep;
  const base = { ...a };
  for (const k of PLACE) delete base[k];
  delete base.also;
  const pick = (p) => Object.fromEntries(PLACE.filter((k) => p[k] != null).map((k) => [k, p[k]]));
  return { ...base, ...pick(first), ...(rest.length ? { also: rest.map(pick) } : {}) };
}
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
const memo = { at: -1, packs: null, groups: null, sorted: new Map(), sets: new Map() };
function fresh() {
  if (memo.at === version) return;
  memo.at = version;
  memo.packs = null;
  memo.sorted.clear();
  memo.sets.clear();
  memo.groups = new Map();
  for (const a of livePlaced()) {
    const key = `${a.pack}\u0000${groupOf(a)}`;
    const list = memo.groups.get(key);
    if (list) list.push(a); else memo.groups.set(key, [a]);
  }
}
// Every picture in a category, stamp by stamp (variations together).
export function categoryAssets(pack, category) {
  fresh();
  const key = `${pack}\u0000${category}`;
  let list = memo.sorted.get(key);
  if (!list) memo.sorted.set(key, list = categorySets(pack, category).flatMap((s) => s.items));
  return list;
}

// A category's stamps: [{ key, name, items }], items being its variations.
export function categorySets(pack, category) {
  fresh();
  const key = `${pack}\u0000${category}`;
  let sets = memo.sets.get(key);
  if (!sets) {
    const by = new Map();
    for (const a of memo.groups.get(key) || []) {
      const k = setOf(a);
      if (by.has(k)) by.get(k).push(a); else by.set(k, [a]);
    }
    // (A key safe in HTML attributes, which can't hold \u0000.)
    sets = [...by].map(([k, items]) => { items.sort(byName); return { key: `${pack}\u241f${category}\u241f${k}`, name: setLabel(items[0], items), items }; })
      .sort((x, y) => collator.compare(x.name, y.name));
    memo.sets.set(key, sets);
  }
  return sets;
}

// The variations of the stamp a picture belongs to (itself, if none).
export function variationsOf(a) {
  const k = setOf(a);
  return categorySets(a.pack, groupOf(a)).find((s) => s.items[0] && setOf(s.items[0]) === k)?.items || [a];
}

// A picture's set: its name without a number at the end, so "Tower 1",
// "Tower_2" and "Tower (3)" are variants of one thing.
export const setName = (name) => name.replace(/[\s_-]*\(?\d+\)?$/, '').toLowerCase() || name.toLowerCase();
// A picture's category (its group: the first folder in the pack) and the
// stamp it's a variation of (the folders below that, or its numberless name).
export const groupOf = (a) => { const i = a.category.indexOf('/'); return i < 0 ? a.category : a.category.slice(0, i); };
export const setOf = (a) => { const i = a.category.indexOf('/'); return i < 0 ? setName(a.name) : a.category.slice(i + 1); };
// The stamp's display name: its folder's name, or its first picture's.
const setLabel = (a, list) => { const i = a.category.indexOf('/'); return i < 0 ? (list.length > 1 ? a.name.replace(/[\s_-]*\(?\d+\)?$/, '') || a.name : a.name) : a.category.slice(i + 1); };

export function packs() {
  fresh();
  return memo.packs ??= buildPacks();
}

function buildPacks() {
  const by = new Map();
  for (const a of livePlaced()) {
    let p = by.get(a.pack);
    if (!p) by.set(a.pack, p = { name: a.pack, count: 0, bytes: 0, cats: new Map(), type: 'any' });
    if (a.mapType && p.type === 'any') p.type = a.mapType;
    p.count++; p.bytes += a.size || 0;
    const g = groupOf(a);
    const c = p.cats.get(g) || { name: g, count: 0, kind: a.kind };
    c.count++;
    p.cats.set(g, c);
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

// Pictures another pack also includes stay, in that pack.
export async function deletePack(name) {
  await deleteAssets(livePlaced().filter((a) => a.pack === name).map((a) => a.id), name);
  await saveMeta({ pinned: meta.pinned.filter((p) => p !== name) });
}

// Take pictures out of a pack; those no other pack includes are deleted
// from every device and OneDrive. With no pack, they're deleted outright.
export async function deleteAssets(ids, pack = null) {
  const recs = ids.map((id) => assets.get(id)).filter((a) => a && !a.deleted);
  const kept = [], gone = [];
  for (const a of recs) {
    const r = pack == null ? null : replace(a, pack, () => null);
    if (r) kept.push(r); else gone.push(a);
  }
  await saveRecords(kept);
  // Tombstones keep the type: it names the file to remove from OneDrive.
  await saveRecords(gone.map((a) => ({ id: a.id, type: a.type, deleted: true })));
  await dropLocal(gone.map((a) => a.id));
  // This device is the one to remove their files from OneDrive (see assetsync.js).
  const states = await allStates();
  await db.putMany('assetState', gone.map((a) => ({ ...cleared(states.get(a.id) || { id: a.id }), purgePending: true, purged: false })));
}

// Change the placements in a pack that match: test(placement) → fields.
async function editPack(pack, test, fields) {
  const recs = [];
  for (const a of liveAssets()) {
    const p = placedIn(a, pack);
    if (p && test(p)) recs.push(replace(a, pack, (q) => ({ ...q, ...fields(q) })));
  }
  await saveRecords(recs.filter(Boolean));
}

export async function setPackType(pack, type) {
  await editPack(pack, (p) => (p.mapType || 'any') !== type, () => ({ mapType: type }));
}

export async function setCategoryKind(pack, category, kind) {
  await editPack(pack, (p) => groupOf(p) === category && p.kind !== kind, () => ({ kind }));
}

// --- reorganising ------------------------------------------------------

// Move pictures to a pack, category and stamp (stamp '' leaves each one a
// stamp of its own). They take on the category's stamps/textures setting if
// it's already there, and the pack's map type.
// `from` is the pack they're being moved out of (other packs that include
// them keep them where they are).
export async function moveAssets(ids, { pack, category, stamp = '' }, from) {
  const target = packs().find((p) => p.name === pack);
  const kind = target?.categories.find((c) => c.name === category)?.kind;
  const path = stamp ? `${category}/${stamp}` : category;
  const recs = ids.map((id) => assets.get(id)).filter((a) => a && !a.deleted).map((a) => replace(a, from ?? a.pack, (p) => ({
    ...p, pack, category: path,
    ...(kind ? { kind } : {}),
    ...(pack !== p.pack ? { mapType: target && target.type !== 'any' ? target.type : null } : {}),
  }))).filter(Boolean);
  await saveRecords(recs);
  return recs.length;
}

// Rename a category (or merge it into another, if that name is taken).
export async function renameCategory(pack, from, to) {
  await editPack(pack, (p) => groupOf(p) === from, (p) => ({ category: to + p.category.slice(from.length) }));
}

// Rename a stamp in a pack: its pictures become (or stay) a folder of variations.
export async function renameStamp(ids, to, pack) {
  const want = new Set(ids);
  await editPack(pack, (p) => want.has(p.id), (p) => ({ category: `${groupOf(p)}/${to}` }));
}

// The size (longer side, map pixels) a stamp starts at when picked, or null.
export async function setDefaultSize(ids, size) {
  await saveRecords(ids.map((id) => assets.get(id)).filter((a) => a && !a.deleted)
    .map((a) => ({ ...a, defaultSize: size ? Math.round(size) : null })));
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
// An entry may also carry its name, category and kind (from a pack file),
// which then win over what its path suggests. opts.mapType is what a new pack
// is made for. onProgress({ done, total, added, skipped }) is called as it goes.
// A few images are read, hashed and shrunk at a time; their files are saved
// together, a batch at a time, and each batch's catalogue records only after
// its pictures are safely stored (so an interrupted import never leaves a
// record without a picture).
const IMPORT_WIDE = 3;
const IMPORT_BATCH = 50;
export async function importEntries(entries, pack, onProgress = () => {}, opts = {}) {
  const list = entries.filter((e) => isImagePath(e.path));
  const progress = { done: 0, total: list.length, added: 0, skipped: 0 };
  const seen = new Set(); // ids taken by this import, before they are in the catalogue
  // Images added to an existing pack take on what it's made for.
  const existing = packs().find((p) => p.name === pack);
  const mapType = existing?.type ?? opts.mapType;
  // Pictures added to a category that's already there are stamps or textures as it is.
  const kindOf = new Map((existing?.categories || []).map((c) => [c.name, c.kind]));
  let ready = [];
  const also = []; // pictures already in the library, added to this pack too
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
        if (seen.has(id)) { progress.skipped++; continue; }
        // Already in the library: added to this pack too, unless it's already in it.
        const had = asset(id);
        if (had) {
          seen.add(id);
          if (placedIn(had, pack)) { progress.skipped++; continue; }
          const parts = e.path.split('/'), file = parts.pop(), category = e.category ?? parts.join('/');
          const kind = e.kind === 'texture' || e.kind === 'stamp' ? e.kind : kindOf.get(category.split('/')[0]) || guessKind(category);
          const place = { pack, category, name: e.name || file.replace(/\.[^.]+$/, ''), kind, ...(mapType && mapType !== 'any' ? { mapType } : {}) };
          also.push({ ...had, also: [...(had.also || []), place] });
          progress.added++;
          continue;
        }
        seen.add(id);
        const { thumb, w, h } = await makeThumb(blob);
        const parts = e.path.split('/');
        const file = parts.pop();
        const category = e.category ?? parts.join('/');
        const kind = e.kind === 'texture' || e.kind === 'stamp' ? e.kind : kindOf.get(category.split('/')[0]) || guessKind(category);
        ready.push({ blob, thumb, rec: { id, name: e.name || file.replace(/\.[^.]+$/, ''), pack, category, kind, type, size: blob.size, w, h, ...(mapType && mapType !== 'any' ? { mapType } : {}) } });
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
  await saveRecords(also);
  return progress;
}
