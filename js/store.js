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
  eTags: {}, lastSync: null, pinned: [],
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const notify = (detail) => listeners.forEach((fn) => fn(detail));

export async function load() {
  projects.clear();
  for (const p of await db.getAll('projects')) projects.set(p.id, p);
  meta = { ...meta, ...(await db.get('meta', 'sync')) };
}

export async function saveMeta(patch) {
  Object.assign(meta, patch);
  await db.put('meta', meta);
}

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
  await saveMeta({ localRev: meta.localRev + 1 });
  notify({ local: true, store: 'projects', id: p.id });
  return p;
}

export async function createProject({ name, width, height }) {
  const p = await saveProject({ id: uid(), name, width, height });
  const doc = { id: p.id, objects: {} };
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
    if (r.deleted) { docs.delete(r.id); await db.del('docs', [r.id]); }
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

async function bumpDoc(id) {
  await saveMeta({ docRev: { ...meta.docRev, [id]: (meta.docRev[id] || 0) + 1 } });
}

// Add or replace objects in a project's drawing (each needs an id).
export async function putObjects(id, objs) {
  const doc = await getDoc(id);
  for (const o of objs) doc.objects[o.id] = stamp(o, doc.objects[o.id]);
  await db.put('docs', doc);
  await bumpDoc(id);
  // Touch the project too, so the home page lists recently edited maps first.
  const p = projects.get(id);
  if (p) await saveProject({ ...p });
  notify({ local: true, store: 'docs', id });
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
  await db.put('docs', doc);
  if (changed) notify({ local: false, store: 'docs', id });
  return localAhead;
}

export async function dropDoc(id) {
  docs.delete(id);
  await db.del('docs', [id]);
}
