// Export a map as a picture: rendered at full size from the document, with
// every stamp's full-size art (downloaded first if needed). Browsers cap how
// big a canvas may be (iOS at about 16.7 million pixels), so the size choices
// stay under that.
import * as store from './store.js';
import * as images from './images.js';
import { drawDoc, fontCSS } from './render.js';
import { $, esc, modal, toast, download } from './util.js';

const MAX_PIXELS = 16_000_000;
const FORMATS = [
  ['image/png', 'PNG', 'png', 'Best quality, larger file'],
  ['image/webp', 'WebP', 'webp', 'Much smaller, nearly as sharp'],
  ['image/jpeg', 'JPEG', 'jpg', 'Smallest, works everywhere'],
];

export async function exportDialog(project) {
  const full = project.width * project.height;
  const scales = [1, 0.75, 0.5, 0.25].filter((k) => full * k * k <= MAX_PIXELS);
  const opts = await modal('Export map', `<form class="form">
      <div class="field-label">Format</div>
      ${FORMATS.map(([type, label, , note], i) => `<label class="check"><input type="radio" name="type" value="${type}" ${i ? '' : 'checked'}> <b>${label}</b> <small>${note}</small></label>`).join('')}
      <div class="field-label" style="margin-top:1rem">Size</div>
      <select name="scale">${scales.map((k) => `<option value="${k}">${Math.round(project.width * k)} × ${Math.round(project.height * k)}${k === 1 ? ' (full size)' : ''}</option>`).join('')}</select>
      <p class="muted small">For WorldAtlas, WebP at full size is a good choice: upload it as a map there.</p>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Export</button></div>
    </form>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(null);
      $('form', m).onsubmit = (e) => { e.preventDefault(); close({ type: e.target.type.value, scale: +e.target.scale.value }); };
    },
  });
  if (!opts) return;
  toast('Preparing the export…', 60000);
  try {
    const blob = await renderMap(project, opts);
    const ext = FORMATS.find((f) => f[0] === opts.type)[2];
    download(`${project.name.replace(/[^\w\- ]+/g, '').trim() || 'map'}.${ext}`, blob);
    toast(`Exported ${project.name}`);
  } catch (e) {
    toast('Export failed: ' + e.message, 6000);
  }
}

export async function renderMap(project, { type = 'image/png', scale = 1 } = {}) {
  const doc = await store.getDoc(project.id);
  // Load every picture the map uses at full size first.
  const ids = [...new Set(store.liveObjects(doc).filter((o) => o.kind === 'stamp').map((o) => o.asset))];
  const tex = doc.objects.style && !doc.objects.style.deleted && doc.objects.style.landTexture;
  if (tex) ids.push(tex);
  // Textures: the land's, the terrain brush's, shape fills, and the paper.
  // Patterns need the whole picture, so these aren't decoded smaller.
  const special = new Set(tex ? [tex] : []);
  for (const t of store.liveObjects(doc)) {
    const id = t.kind === 'terrain' ? t.texture : t.kind === 'shape' && t.fill ? t.fillTex : null;
    if (id) special.add(id);
  }
  const paper = doc.objects.style && !doc.objects.style.deleted && doc.objects.style.overlay;
  if (paper) special.add(paper);
  for (const id of special) if (!ids.includes(id)) ids.push(id);
  // Each stamp is decoded no larger than the biggest it's drawn here (with
  // some to spare), which keeps a map full of small stamps from needing the
  // whole library in memory at full size.
  const need = new Map();
  for (const o of store.liveObjects(doc)) if (o.kind === 'stamp') need.set(o.asset, Math.max(need.get(o.asset) || 0, Math.max(o.w, o.h) * scale * 1.5));
  const pics = new Map();
  let missing = 0, next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const img = await images.full(id, need.has(id) && !special.has(id) ? Math.ceil(need.get(id)) : 0);
      if (img) pics.set(id, img); else missing++;
    }
  };
  let blob;
  try {
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    if (missing) toast(`${missing} picture${missing === 1 ? ' isn’t' : 's aren’t'} available yet and will be left out`, 5000);
    // Labels' fonts too: the browser only fetches a font once something asks for it.
    const fonts = new Set(store.liveObjects(doc).filter((o) => o.kind === 'label').map((o) => o.font));
    await Promise.all([...fonts].map((f) => document.fonts.load(fontCSS(f, 40)).catch(() => {})));
    const c = document.createElement('canvas');
    c.width = Math.round(project.width * scale);
    c.height = Math.round(project.height * scale);
    const ctx = c.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawDoc(ctx, project, doc, { image: (id) => pics.get(id) || null, landScale: scale, cache: false });
    blob = await new Promise((r) => c.toBlob(r, type, 0.9));
    c.width = c.height = 0; // let the memory go now, phones need it
  } finally {
    images.release(pics.values());
  }
  if (!blob) throw new Error('The browser couldn’t make the picture (it may be too large for this device)');
  return blob;
}
