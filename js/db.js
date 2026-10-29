// Thin promise wrapper over IndexedDB. Everything the app owns lives here
// on the device; OneDrive is a sync target, not the source of truth.
//
// projects: one small record per map (name, size), listed on the home page.
// docs:     the drawing itself for each project, keyed by project id.
// assets:   the art catalogue (synced): one record per file, keyed by its hash.
// blobs:    full-size art on this device; thumbs: small previews of it.
// assetState: what this device has uploaded or cleaned up (never synced).
const DB_NAME = 'atlascartographer';
const DB_VERSION = 2;

let dbp;
function open() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('docs', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
      }
      if (e.oldVersion < 2) {
        for (const n of ['assets', 'blobs', 'thumbs', 'assetState']) d.createObjectStore(n, { keyPath: 'id' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

export async function getAll(store) {
  return req((await open()).transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  return req((await open()).transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const t = (await open()).transaction(store, 'readwrite');
  t.objectStore(store).put(value);
  return done(t);
}

export async function putMany(store, values) {
  if (!values.length) return;
  const t = (await open()).transaction(store, 'readwrite');
  const os = t.objectStore(store);
  for (const v of values) os.put(v);
  return done(t);
}

export async function getAllKeys(store) {
  return req((await open()).transaction(store).objectStore(store).getAllKeys());
}

export async function del(store, keys) {
  if (!keys.length) return;
  const t = (await open()).transaction(store, 'readwrite');
  const os = t.objectStore(store);
  for (const k of keys) os.delete(k);
  return done(t);
}
