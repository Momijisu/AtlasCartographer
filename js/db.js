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
  // A failed open isn't remembered, so the next call tries again.
  dbp ??= connect().catch((e) => { dbp = null; throw e; });
  return dbp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(attempt = 0) {
  return new Promise((resolve, reject) => {
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
    // Another window still has an older copy open: the upgrade waits for it
    // to close, and carries on by itself when it does.
    r.onblocked = () => console.warn('The database upgrade is waiting for another window of this app to close.');
    r.onsuccess = () => {
      const d = r.result;
      // Let a newer copy of the app upgrade the database; we reopen on demand.
      d.onversionchange = () => { d.close(); dbp = null; };
      d.onclose = () => { dbp = null; };
      resolve(d);
    };
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    if (attempt >= 2) throw e;
    console.warn('Opening the database failed; trying again', e);
    return sleep(500 * (attempt + 1)).then(() => connect(attempt + 1));
  });
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

// Read one record, change it, and write it back in a single transaction, so
// a write from another window can't slip in between. fn gets the stored
// record (or undefined) and returns the record to store (or undefined to
// leave it). Resolves with what was stored.
export async function update(store, key, fn) {
  const t = (await open()).transaction(store, 'readwrite');
  const os = t.objectStore(store);
  const got = os.get(key);
  let out, failure;
  got.onsuccess = () => {
    // A failure here is rethrown to the caller, not left as an uncaught error.
    try {
      out = fn(got.result);
      if (out !== undefined) os.put(out);
    } catch (e) { failure = e; t.abort(); }
  };
  try { await done(t); } catch (e) { throw failure || e; }
  return out;
}

// Several reads and writes across stores in one transaction: all happen or
// none do. fn gets { get(store, key, then), put(store, value) }; then(record)
// runs when a read comes back and may call put again. A throw anywhere rolls
// everything back and reaches the caller.
export async function tx(stores, fn) {
  const t = (await open()).transaction(stores, 'readwrite');
  let failure;
  const guard = (f) => { try { f(); } catch (e) { failure = e; t.abort(); } };
  const api = {
    get(store, key, then) {
      const r = t.objectStore(store).get(key);
      r.onsuccess = () => guard(() => then(r.result));
    },
    put(store, value) { t.objectStore(store).put(value); },
  };
  guard(() => fn(api));
  try { await done(t); } catch (e) { throw failure || e; }
}
