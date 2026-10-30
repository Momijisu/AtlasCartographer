// Projects and their drawings, kept in IndexedDB and merged with OneDrive.
//
// A project is two things: a small index record (name, canvas size) that lives
// in projects.json with every other project's, and a document holding the
// drawing's objects (strokes for now; stamps and labels later) that lives in
// its own projects/<id>.json. Both merge record by record, newer updatedAt
// winning, so edits to different maps — or different strokes on the same
// map — made on two devices both survive. Deletions are tombstones, so they
// sync too.
import * as db from './db.js';
import { uid } from './util.js';

export const projects = new Map();
const docs = new Map(); // project id → document, loaded on first use

// localRev/syncedRev: edits to the index. docRev/docSynced: edits to each
// document, by project id. eTags: the OneDrive version of each file we last
// merged with, by path.
// assetRev/assetSynced: edits to the art catalogue (assets.js). pinned: packs
// this device keeps fully downloaded.
export let meta = {
  key: 'sync', localRev: 0, syncedRev: 0, docRev: {}, docSynced: {}, assetRev: 0, assetSynced: 0,
  eTags: {}, lastSync: null, pinned: [], lastAccount: null,
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const notify = (detail) => listeners.forEach((fn) => fn(detail));

export async function load() {
  projects.clear();
  for (const p of await db.getAll('projects')) projects.set(p.id, p);
  meta = { ...meta, ...(await db.get('meta', 'sync')) };
}

// Windows of the app share one stored record of this, each with its own copy
// in memory, so a save folds in what another window wrote: the revision
// counters only ever go up, so the larger value is the right one. drop: maps
// whose revision entries are gone for good (deleted).
const COUNTERS = ['localRev', 'syncedRev', 'assetRev', 'assetSynced', 'lastSync'];
const maxMap = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
};
function foldMeta(stored, mem, drop, bump) {
  const out = { ...stored, ...mem, docRev: maxMap(stored.docRev, mem.docRev), docSynced: maxMap(stored.docSynced, mem.docSynced) };
  for (const k of COUNTERS) out[k] = Math.max(stored[k] || 0, mem[k] || 0) || mem[k];
  // A counter bumped here counts one more than whichever copy was ahead
  // before the bump, so two windows' bumps both register.
  for (const k of bump) {
    if (k.startsWith('docRev:')) { const id = k.slice(7); out.docRev[id] = Math.max(stored.docRev?.[id] || 0, (mem.docRev[id] || 1) - 1) + 1; }
    else out[k] = Math.max(stored[k] || 0, mem[k] - 1) + 1;
  }
  for (const id of drop) { delete out.docRev[id]; delete out.docSynced[id]; }
  return out;
}
// Take over what's stored, never lowering anything held in memory.
function adoptMeta(stored, drop = []) {
  for (const k of COUNTERS) if ((stored[k] || 0) > (meta[k] || 0)) meta[k] = stored[k];
  meta.docRev = maxMap(meta.docRev, stored.docRev);
  meta.docSynced = maxMap(meta.docSynced, stored.docSynced);
  for (const id of drop) { delete meta.docRev[id]; delete meta.docSynced[id]; }
}

// bump: counters this save has just raised by one ('localRev', 'assetRev', 'docRev:<id>').
export async function saveMeta(patch, { drop = [], bump = [] } = {}) {
  Object.assign(meta, patch);
  for (const id of drop) { delete meta.docRev[id]; delete meta.docSynced[id]; }
  adoptMeta(await db.update('meta', 'sync', (stored) => foldMeta(stored || {}, meta, drop, bump)), drop);
}

// A map's revision entries, once it's deleted: nothing of it is left to upload.
export const forgetDoc = (id) => saveMeta({}, { drop: [id] });

export const isDirty = () => meta.localRev > meta.syncedRev || meta.assetRev > meta.assetSynced
  || Object.entries(meta.docRev).some(([id, rev]) => rev > (meta.docSynced[id] || 0));
export const docDirty = (id) => (meta.docRev[id] || 0) > (meta.docSynced[id] || 0);

// Never older than the version it replaces, so a device with a slow clock
// can't produce an edit that loses to the one it was based on.
const stamp = (obj, prev) => { obj.updatedAt = Math.max(Date.now(), (prev?.updatedAt || 0) + 1); return obj; };

// --- projects -----------------------------------------------------------

export const live = () => [...projects.values()].filter((p) => !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
export const project = (id) => { const p = projects.get(id); return p && !p.deleted ? p : null; };

export async function saveProject(p) {
  stamp(p, projects.get(p.id));
  p.createdAt ??= p.updatedAt;
  projects.set(p.id, p);
  await db.put('projects', p);
  await saveMeta({ localRev: meta.localRev + 1 }, { bump: ['localRev'] });
  notify({ local: true, store: 'projects', id: p.id });
  return p;
}

// style: the map's starting look (see MAP_TYPES in views/home.js).
export async function createProject({ name, width, height, type, style }) {
  const p = await saveProject({ id: uid(), name, width, height, ...(type ? { type } : {}) });
  const doc = { id: p.id, objects: style ? { style: { id: 'style', kind: 'style', ...style, updatedAt: Date.now() } } : {} };
  docs.set(p.id, doc);
  await db.put('docs', doc);
  await bumpDoc(p.id);
  return p;
}

export async function deleteProject(id) {
  if (!project(id)) return;
  await saveProject({ id, deleted: true });
  docs.delete(id);
  await db.del('docs', [id]);
  await forgetDoc(id);
}

// Bring in index records from OneDrive. Returns true if this device has
// anything the remote copy lacks.
export async function mergeProjects(remote) {
  let localAhead = false;
  const incoming = [];
  const seen = new Set();
  for (const r of remote) {
    seen.add(r.id);
    const l = projects.get(r.id);
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) incoming.push(r);
    else if ((l.updatedAt || 0) > (r.updatedAt || 0)) localAhead = true;
  }
  if ([...projects.keys()].some((id) => !seen.has(id))) localAhead = true;
  for (const r of incoming) {
    projects.set(r.id, r);
    if (r.deleted) { docs.delete(r.id); await db.del('docs', [r.id]); await forgetDoc(r.id); }
  }
  await db.putMany('projects', incoming);
  if (incoming.length) notify({ local: false, store: 'projects' });
  return localAhead;
}

// --- documents ----------------------------------------------------------

export async function getDoc(id) {
  if (!docs.has(id)) {
    const d = await db.get('docs', id);
    if (!d) return null;
    docs.set(id, d);
  }
  return docs.get(id);
}

export const hasDoc = async (id) => !!(await getDoc(id));
export const liveObjects = (doc) => Object.values(doc.objects).filter((o) => !o.deleted);

// Write a drawing to the device. If another window saved it since this one
// read it (rev differs), its newer objects are folded in first, so two
// windows never overwrite each other's work.
async function saveDoc(doc) {
  let folded = false;
  await db.update('docs', doc.id, (stored) => {
    if (stored && (stored.rev || 0) !== (doc.rev || 0)) {
      for (const [oid, r] of Object.entries(stored.objects || {})) {
        const l = doc.objects[oid];
        if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { doc.objects[oid] = r; folded = true; }
      }
    }
    doc.rev = (stored?.rev || 0) + 1;
    return doc;
  });
  if (folded) notify({ local: false, store: 'docs', id: doc.id });
}

// Another window may have changed this map while this one wasn't editing it:
// read it, the index record and the counters afresh.
export async function refresh(id) {
  const rec = await db.get('projects', id);
  if (rec) projects.set(id, rec);
  docs.delete(id);
  const stored = await db.get('meta', 'sync');
  if (stored) adoptMeta(stored);
  return getDoc(id);
}

async function bumpDoc(id) {
  await saveMeta({ docRev: { ...meta.docRev, [id]: (meta.docRev[id] || 0) + 1 } }, { bump: [`docRev:${id}`] });
}

// Add or replace objects in a project's drawing (each needs an id).
export async function putObjects(id, objs) {
  const doc = await getDoc(id);
  for (const o of objs) doc.objects[o.id] = stamp(o, doc.objects[o.id]);
  await saveDoc(doc);
  await bumpDoc(id);
  // Touch the project too, so the home page lists recently edited maps first.
  const p = projects.get(id);
  if (p) await saveProject({ ...p });
  notify({ local: true, store: 'docs', id });
}

// An object moved and scaled: every position times k, then shifted by
// (dx, dy); sizes times k. For resizing a map.
export function transformObject(o, k, dx, dy) {
  const r = (v) => Math.round(v * 10) / 10;
  const pts = (p) => p.map((v, i) => r(v * k + (i % 2 ? dy : dx)));
  const { updatedAt, ...out } = o;
  if (o.points) out.points = pts(o.points);
  if (o.along) out.along = pts(o.along);
  if (o.x != null) { out.x = r(o.x * k + dx); out.y = r(o.y * k + dy); }
  if (o.w != null) { out.w = r(o.w * k); out.h = r(o.h * k); }
  if (o.width != null) out.width = r(o.width * k);
  if (o.size != null) out.size = r(o.size * k);
  if (o.kind === 'style') {
    if (o.gridSize) out.gridSize = r(o.gridSize * k);
    if (o.coastWidth != null) out.coastWidth = r(o.coastWidth * k);
  }
  return out;
}

// Change a map's size: content scaled by k and shifted by (dx, dy).
export async function resizeProject(id, { width, height, k = 1, dx = 0, dy = 0 }) {
  const doc = await getDoc(id);
  if (!doc) return;
  const objs = Object.values(doc.objects).filter((o) => !o.deleted).map((o) => transformObject(o, k, dx, dy));
  if (objs.length) await putObjects(id, objs);
  await saveProject({ ...projects.get(id), width: Math.round(width), height: Math.round(height) });
}

// A copy of a map, under a new name.
export async function duplicateProject(id, name) {
  const p = project(id), doc = await getDoc(id);
  if (!p || !doc) return null;
  const copy = await createProject({ name, width: p.width, height: p.height, type: p.type });
  const objs = Object.values(doc.objects).filter((o) => !o.deleted).map(({ updatedAt, ...o }) => o);
  if (objs.length) await putObjects(copy.id, objs);
  return copy;
}

export const removeObjects = (id, ids) => putObjects(id, ids.map((oid) => ({ id: oid, deleted: true })));

// Bring in a document from OneDrive, object by object. Returns true if this
// device has anything the remote copy lacks.
export async function mergeDoc(id, remote) {
  const doc = (await getDoc(id)) || { id, objects: {} };
  const theirs = remote.objects || {};
  let localAhead = false, changed = false;
  for (const [oid, r] of Object.entries(theirs)) {
    const l = doc.objects[oid];
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { doc.objects[oid] = r; changed = true; }
    else if ((l.updatedAt || 0) > (r.updatedAt || 0)) localAhead = true;
  }
  if (Object.keys(doc.objects).some((oid) => !(oid in theirs))) localAhead = true;
  docs.set(id, doc);
  await saveDoc(doc);
  if (changed) notify({ local: false, store: 'docs', id });
  return localAhead;
}

export async function dropDoc(id) {
  docs.delete(id);
  await db.del('docs', [id]);
  await forgetDoc(id);
}

// Make everything on this device count as not yet uploaded, for an account
// that has none of it.
export async function markAllUnsynced() {
  const ids = [...projects.values()].filter((p) => !p.deleted).map((p) => p.id);
  await saveMeta({
    eTags: {}, localRev: meta.localRev + 1, assetRev: meta.assetRev + 1,
    docRev: { ...meta.docRev, ...Object.fromEntries(ids.map((id) => [id, (meta.docRev[id] || 0) + 1])) },
  }, { bump: ['localRev', 'assetRev', ...ids.map((id) => `docRev:${id}`)] });
}
