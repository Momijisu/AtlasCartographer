// Decoded pictures of library art, for drawing on canvases. get() returns the
// best version loaded so far (or null) and starts loading a better one: the
// thumbnail first, which is instant, then the full-size art, downloaded from
// OneDrive if this device doesn't have it yet. Listeners hear when a picture
// arrives, so canvases can redraw.
//
// A decoded picture takes width × height × 4 bytes however small the file, so
// big art is decoded no larger than MAX_SIDE on its long side (plenty for a
// stamp or texture on screen), and the decoded pictures share a byte budget:
// the ones used least recently are dropped when it's full, and decoded again
// if they're wanted. The thumbnail is drawn in the meantime, so nothing goes
// blank. Exports ask for full() art instead, and release() it afterwards.
import * as A from './assets.js';
import { getAssetBlob } from './assetsync.js';

const MAX_SIDE = 2048;
const touchFirst = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;
let budget = touchFirst() ? 128 * 2 ** 20 : 384 * 2 ** 20;
let protectMs = 2000; // pictures drawn this recently are never dropped
const cache = new Map(); // id → { thumb, big, bytes, tick, loading, triedThumb, triedFull }
const listeners = new Set();
export const onLoad = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const sizeOf = (img) => img.width * img.height * 4;

// A picture from a blob, no larger than maxSide on its long side (0: as it
// is). Where the browser can decode and scale in one go, off the main thread,
// it does; otherwise the picture is decoded whole, as before.
async function decode(blob, maxSide = 0, w = 0, h = 0) {
  if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') {
    try {
      if (maxSide && w && h && Math.max(w, h) > maxSide) {
        const k = maxSide / Math.max(w, h);
        return await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' });
      }
      return await createImageBitmap(blob);
    } catch { /* fall back to an image element */ }
  }
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not decode image')); };
    img.src = url;
  });
}

const free = (img) => img?.close?.();

function used() {
  let n = 0;
  for (const e of cache.values()) n += e.bytes;
  return n;
}

// Drop the pictures used least recently until the rest fit the budget.
function trim() {
  let total = used();
  if (total <= budget) return;
  const now = performance.now();
  const old = [...cache.values()].filter((e) => e.big && now - e.tick > protectMs).sort((a, b) => a.tick - b.tick);
  for (const e of old) {
    if (total <= budget) break;
    total -= e.bytes;
    free(e.big);
    e.big = null; e.bytes = 0; e.triedFull = false; // drawn from its thumbnail until wanted again
  }
}

async function load(id, e, thumbOnly) {
  try {
    if (!e.thumb && !e.big) {
      const t = await A.getThumb(id);
      if (t) { e.thumb = await decode(t); listeners.forEach((fn) => fn(id)); }
    }
    if (thumbOnly) return;
    const b = await getAssetBlob(id);
    if (b) {
      const a = A.asset(id);
      const big = await decode(b, MAX_SIDE, a?.w, a?.h);
      free(e.big);
      e.big = big; e.bytes = sizeOf(big); e.tick = performance.now();
      trim();
      listeners.forEach((fn) => fn(id));
    }
  } catch (err) {
    console.warn('Picture failed to load', id, err);
  } finally {
    e.loading = null;
  }
}

// thumbOnly: small previews are enough (project thumbnails).
export function get(id, { thumbOnly = false } = {}) {
  let e = cache.get(id);
  if (!e) cache.set(id, e = { thumb: null, big: null, bytes: 0, tick: 0, loading: null, triedThumb: false, triedFull: false });
  e.tick = performance.now();
  if (!e.loading && !e.big && !(thumbOnly ? e.triedThumb : e.triedFull)) {
    e.triedThumb = true;
    if (!thumbOnly) e.triedFull = true;
    e.loading = load(id, e, thumbOnly);
  }
  return e.big || e.thumb;
}

// After a sync, pictures that weren't available may be now: try them again.
export function retryMissing() {
  for (const e of cache.values()) {
    if (!e.big) e.triedFull = false;
    if (!e.thumb && !e.big) e.triedThumb = false;
  }
}

// The picture at full size (or no larger than maxSide, if the caller only
// needs it small), waiting for it to load or download. null if it can't be
// had: not uploaded yet, or offline. For exports: it isn't kept in the cache,
// so give it back with release() when finished.
export async function full(id, maxSide = 0) {
  const blob = await getAssetBlob(id);
  if (!blob) return null;
  const a = A.asset(id);
  try { return await decode(blob, maxSide, a?.w, a?.h); } catch (err) { console.warn('Picture failed to load', id, err); return null; }
}

export function release(pictures) {
  for (const p of pictures) free(p);
}

// For tests: the cache's size, and a smaller budget.
export const stats = () => ({ bytes: used(), count: [...cache.values()].filter((e) => e.big).length, budget });
export function setBudget(bytes, protect = protectMs) { budget = bytes; protectMs = protect; trim(); }
