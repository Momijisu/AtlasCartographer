// Decoded pictures of library art, for drawing on canvases. get() returns the
// best version loaded so far (or null) and starts loading a better one: the
// thumbnail first, which is instant, then the full-size art, downloaded from
// OneDrive if this device doesn't have it yet. Listeners hear when a picture
// arrives, so canvases can redraw.
import * as A from './assets.js';
import { getAssetBlob } from './assetsync.js';

const cache = new Map(); // id → { img, full, loading }
const listeners = new Set();
export const onLoad = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function decode(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not decode image')); };
    img.src = url;
  });
}

async function load(id, e, thumbOnly) {
  try {
    if (!e.img) {
      const t = await A.getThumb(id);
      if (t) { e.img = await decode(t); listeners.forEach((fn) => fn(id)); }
    }
    if (thumbOnly) return;
    const b = await getAssetBlob(id);
    if (b) { e.img = await decode(b); e.full = true; listeners.forEach((fn) => fn(id)); }
  } catch (err) {
    console.warn('Picture failed to load', id, err);
  } finally {
    e.loading = null;
  }
}

// thumbOnly: small previews are enough (project thumbnails).
export function get(id, { thumbOnly = false } = {}) {
  let e = cache.get(id);
  if (!e) cache.set(id, e = { img: null, full: false, loading: null, triedThumb: false, triedFull: false });
  if (!e.loading && !e.full && !(thumbOnly ? e.triedThumb : e.triedFull)) {
    e.triedThumb = true;
    if (!thumbOnly) e.triedFull = true;
    e.loading = load(id, e, thumbOnly);
  }
  return e.img;
}

// After a sync, pictures that weren't available may be now: try them again.
export function retryMissing() {
  for (const e of cache.values()) {
    if (!e.full) e.triedFull = false;
    if (!e.img) e.triedThumb = false;
  }
}
