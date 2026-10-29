// Draws a project's document onto a 2D canvas context, in map pixels. The
// editor and the project thumbnails share it, so they always agree.
import { liveObjects } from './store.js';

export const PAPER = '#e8dcc0';

// Land and sea: once any land is painted, the map becomes sea around it.
export const STYLE = {
  sea: '#b5cac3',
  ripple: 'rgba(58, 88, 92, .32)',
  coast: '#3b2f22',
  land: '#e9dcbc',
  ripples: [26, 52, 84], // ring distances from the shore, map pixels
  rippleWidth: 2.2,
  coastWidth: 5,
  textureSize: 512, // a land texture repeats every this many map pixels
};

// Strokes are flat [x0, y0, x1, y1, …] point lists in map pixels.
export function drawStroke(ctx, o) {
  ctx.strokeStyle = ctx.fillStyle = o.color;
  strokePath(ctx, o.points, o.width);
}

// A smoothed polyline of the given width (a dot for a single point).
export function strokePath(ctx, p, width) {
  if (!p || p.length < 2 || width <= 0) return;
  ctx.lineWidth = width;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Midpoint quadratic curves smooth out the jaggedness of sampled input.
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length - 2; i += 2) {
    ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  }
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  ctx.stroke();
}

// Stamps: library art centred on (x, y), w × h map pixels, rotated by rot
// radians, mirrored when flip. Art that hasn't loaded yet shows as an outline
// when placeholder is set (the editor), and not at all otherwise.
export function drawStamp(ctx, o, img, placeholder = false, shadow = false) {
  if (!img && !placeholder) return;
  if (img && (o.tintAmt > 0 || (o.bright && o.bright !== 0))) img = adjusted(img, o);
  ctx.save();
  if (o.opacity != null && o.opacity < 1) ctx.globalAlpha = o.opacity;
  if (shadow && img) {
    // A soft shadow down and to the right, sized to the stamp. Shadows are
    // measured in screen pixels, so scale by the current zoom.
    const k = Math.hypot(ctx.getTransform().a, ctx.getTransform().b);
    ctx.shadowColor = 'rgba(40, 28, 15, .45)';
    ctx.shadowBlur = Math.min(60, o.w * 0.05 * k);
    ctx.shadowOffsetX = o.w * 0.03 * k;
    ctx.shadowOffsetY = o.w * 0.04 * k;
  }
  ctx.translate(o.x, o.y);
  if (o.rot) ctx.rotate(o.rot);
  if (o.flip) ctx.scale(-1, 1);
  if (img) ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
  else {
    ctx.strokeStyle = 'rgba(80, 60, 40, .45)';
    ctx.lineWidth = Math.max(1, o.w / 60);
    ctx.setLineDash([o.w / 12, o.w / 12]);
    ctx.strokeRect(-o.w / 2, -o.h / 2, o.w, o.h);
  }
  ctx.restore();
}

// A stamp's picture with its tint (a colour laid over it, tintAmt 0…1) and
// brightness (-1…1) applied. Made once per picture and setting, then reused.
// Compositing rather than filters, so it works in every browser.
const adjustedCache = new WeakMap(); // picture → Map(key → canvas)
function adjusted(img, o) {
  const key = `${o.tint || ''}:${o.tintAmt || 0}:${o.bright || 0}`;
  let m = adjustedCache.get(img);
  if (!m) adjustedCache.set(img, m = new Map());
  if (m.has(key)) return m.get(key);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const c = makeCanvas(w, h), g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  if (o.tintAmt > 0 && o.tint) {
    // 'color' keeps the art's light and shade but takes the tint's hue.
    g.globalCompositeOperation = 'color';
    g.globalAlpha = o.tintAmt;
    g.fillStyle = o.tint;
    g.fillRect(0, 0, w, h);
  }
  if (o.bright) {
    g.globalCompositeOperation = 'source-atop';
    g.globalAlpha = Math.abs(o.bright) * 0.8;
    g.fillStyle = o.bright > 0 ? '#fff' : '#000';
    g.fillRect(0, 0, w, h);
  }
  // Keep the art's own outline (the colour blend also tints transparent areas).
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0, w, h);
  if (m.size > 20) m.delete(m.keys().next().value);
  m.set(key, c);
  return c;
}

// image(assetId) → a loaded picture or null (see images.js).
// landScale: resolution of the land layer relative to the map. It's cached
// for the next frame unless cache is false (one-off renders such as exports).
export function drawDoc(ctx, project, doc, { image = () => null, placeholder = false, landScale = 0.5, cache = true } = {}) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, project.width, project.height);
  if (!doc) return;
  const hidden = new Set(docStyle(doc).hidden || []);
  const objs = liveObjects(doc).sort((a, b) => (a.z || 0) - (b.z || 0));
  const land = objs.filter((o) => o.kind === 'land');
  const terrain = objs.filter((o) => o.kind === 'terrain');
  if ((land.length || terrain.length) && !hidden.has('land')) {
    ctx.drawImage(landLayer(project, doc, land, terrain, landScale, image, cache), 0, 0, project.width, project.height);
  }
  const st = mapStyle(doc);
  const shadow = st.stampShadow;
  // Layers bottom to top; within a layer, by z.
  const order = docLayers(doc).map((l) => l.id).reverse().filter((id) => !hidden.has(id));
  const lay = layerResolver(doc);
  const byLayer = new Map(order.map((id) => [id, []]));
  for (const o of objs) byLayer.get(lay(o))?.push(o);
  for (const id of order) {
    for (const o of byLayer.get(id)) {
      if (o.kind === 'stroke') drawStroke(ctx, o);
      else if (o.kind === 'path') drawPath(ctx, o, st);
      else if (o.kind === 'stamp') drawStamp(ctx, o, image(o.asset), placeholder, shadow);
    }
  }
  finish(ctx, project, st, image);
  // Labels go over the paper, grid and shading too, so names stay crisp;
  // among themselves they keep their layers' order.
  for (const id of order) for (const o of byLayer.get(id)) if (o.kind === 'label') drawLabel(ctx, o);
  if (st.frame !== 'none') drawFrame(ctx, project, st.frame);
  if (st.scaleBar !== 'none') drawScaleBar(ctx, project, st);
}

// A chequered bar of four sections with its distance written above, in a
// bottom corner. scaleLength is the bar's length as a share of the map's width.
function drawScaleBar(ctx, project, st) {
  const { width: W, height: H } = project;
  const u = Math.max(W, H) / 400;
  const len = W * st.scaleLength, bh = u * 2.2;
  const x = st.scaleBar === 'right' ? W - u * 20 - len : u * 20, y = H - u * 22;
  ctx.save();
  ctx.lineWidth = u * 0.5;
  ctx.strokeStyle = '#2b2118';
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#f4ead2' : '#2b2118';
    ctx.fillRect(x + (len / 4) * i, y, len / 4, bh);
  }
  ctx.strokeRect(x, y, len, bh);
  ctx.fillStyle = '#2b2118';
  ctx.font = fontCSS('serif', u * 5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(st.scaleText || '', x + len / 2, y - u * 1.2);
  ctx.font = fontCSS('serif', u * 3.6);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left'; ctx.fillText('0', x, y + bh + u);
  ctx.restore();
}

// --- finishing: paper texture, grid, vignette, frame ----------------------

function finish(ctx, project, st, image) {
  const { width: W, height: H } = project;
  const paper = st.overlay && image(st.overlay);
  if (paper && st.overlayOpacity > 0) {
    // Multiplied over everything, like printing the map onto that paper.
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = st.overlayOpacity;
    ctx.fillStyle = texturePattern(ctx, paper, { textureSize: Math.max(W, H) / 4 });
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (st.grid !== 'none' && st.gridSize > 4) {
    ctx.save();
    ctx.strokeStyle = `rgba(40, 30, 20, ${st.gridOpacity})`;
    ctx.lineWidth = Math.max(1, st.gridSize / 60);
    ctx.beginPath();
    const g = st.gridSize;
    if (st.grid === 'square') {
      for (let x = g; x < W; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = g; y < H; y += g) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    } else {
      // Flat-topped hexagons, gridSize across.
      const r = g / 2, h = Math.sqrt(3) * r;
      for (let col = 0, cx = 0; cx < W + g; col++, cx += r * 1.5) {
        for (let cy = col % 2 ? h / 2 : 0; cy < H + h; cy += h) {
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i, b = (Math.PI / 3) * (i + 1);
            // Each hexagon draws its top three edges; neighbours supply the rest.
            if (i < 3) continue;
            ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
            ctx.lineTo(cx + r * Math.cos(b), cy + r * Math.sin(b));
          }
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  if (st.vignette > 0) {
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
    grad.addColorStop(0, 'rgba(50, 32, 15, 0)');
    grad.addColorStop(1, `rgba(50, 32, 15, ${st.vignette * 0.7})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawFrame(ctx, project, kind) {
  const { width: W, height: H } = project;
  const u = Math.max(W, H) / 400;
  ctx.save();
  ctx.strokeStyle = '#2b2118';
  ctx.lineWidth = u * 1.6;
  ctx.strokeRect(u * 6, u * 6, W - u * 12, H - u * 12);
  if (kind === 'double') {
    ctx.lineWidth = u * 0.6;
    ctx.strokeRect(u * 9, u * 9, W - u * 18, H - u * 18);
  }
  ctx.restore();
}

// Render the whole map into a canvas no bigger than maxW × maxH.
export function drawThumb(canvas, project, doc, opts, maxW = 480, maxH = 360) {
  const s = Math.min(maxW / project.width, maxH / project.height);
  canvas.width = Math.max(1, Math.round(project.width * s));
  canvas.height = Math.max(1, Math.round(project.height * s));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawDoc(ctx, project, doc, { ...opts, landScale: s });
}

// --- land and sea ---------------------------------------------------------
//
// Land is painted as strokes: 'add' strokes raise land, 'erase' strokes carve
// water back out, in z order. The coast effects come from drawing the same
// strokes wider: growing every land stroke (and shrinking every carve) by d
// gives the land's outline pushed d pixels out to sea. From the outside in:
// sea, ripple rings, a dark coastline, then the land fill on top.

const layers = new Map(); // project id (or id:thumb) → { sig, canvas }

// How sharp the land is in the editor. A land layer at full resolution takes
// 4 bytes a pixel (48 MB for a 4096 × 3072 map), more than phones and tablets
// comfortably spare, so on touch-first devices it's drawn at up to 2048
// pixels across and scaled up; elsewhere at the map's own resolution.
// Settings can choose either way on any device.
export const landDetail = () => { try { return localStorage.getItem('ac.landDetail') || 'auto'; } catch { return 'auto'; } };
const touchFirst = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;
export function editorLandScale(project) {
  const d = landDetail();
  const max = d === 'standard' || (d === 'auto' && touchFirst()) ? 2048 : 8192;
  return Math.min(1, max / Math.max(project.width, project.height));
}

// The map's layers, top to bottom; each holds one kind of object.
//
// Land and sea is always at the bottom. Above it, the map's own list of
// layers, top first, kept in its style object: to start with, one for each
// kind of thing (their ids are the kinds), and any the user adds. Each object
// is on its `layer`, or its kind's own layer when it has none (or that layer
// was deleted).
export const BUILTIN_LAYERS = [{ id: 'label', name: 'Labels' }, { id: 'stamp', name: 'Stamps' }, { id: 'stroke', name: 'Ink and paths' }];
export const LAND_LAYER = { id: 'land', name: 'Land and sea' };
export const docLayers = (doc) => (docStyle(doc).layers?.length ? docStyle(doc).layers : BUILTIN_LAYERS);
export const kindLayer = (o) => ({ path: 'stroke', terrain: 'land' }[o.kind] || o.kind);
// (object) → the id of the layer it's on, for this map.
export function layerResolver(doc) {
  const ids = new Set(docLayers(doc).map((l) => l.id));
  return (o) => (o.kind === 'land' || o.kind === 'terrain' ? 'land' : o.layer && ids.has(o.layer) ? o.layer : kindLayer(o));
}

export const docStyle = (doc) => doc?.objects?.style && !doc.objects.style.deleted ? doc.objects.style : {};

// The map's look: STYLE, with whatever the map's style object overrides.
const STYLE_KEYS = ['sea', 'coast', 'land', 'coastWidth', 'rippleCount', 'coastStyle', 'stampShadow',
  'grid', 'gridSize', 'gridOpacity', 'vignette', 'frame', 'overlay', 'overlayOpacity', 'scaleBar', 'scaleText', 'scaleLength'];
const FINISH = {
  coastStyle: 'ripples', grid: 'none', gridSize: 128, gridOpacity: 0.25, vignette: 0, frame: 'none', overlay: null, overlayOpacity: 0.35,
  scaleBar: 'none', scaleText: '100 miles', scaleLength: 0.2,
};
export function mapStyle(doc) {
  const d = docStyle(doc), st = { ...STYLE, ...FINISH, rippleCount: STYLE.ripples.length, stampShadow: false };
  for (const k of STYLE_KEYS) if (d[k] != null) st[k] = d[k];
  // Rings spread evenly out to the default outermost one, however many there are.
  const far = Math.max(...STYLE.ripples);
  st.ripples = st.coastStyle === 'ripples' ? Array.from({ length: st.rippleCount }, (_, i) => Math.round(far * (i + 1) / st.rippleCount)) : [];
  return st;
}

function landLayer(project, doc, land, terrain, scale, image, cache) {
  const style = docStyle(doc);
  const st = mapStyle(doc);
  const texIds = [...new Set([style.landTexture, ...terrain.map((t) => t.texture)].filter(Boolean))];
  const pics = new Map(texIds.map((id) => [id, image(id)]));
  if (!cache) return renderLand(project, land, terrain, scale, pics, style.landTexture, st);
  const sig = [...land, ...terrain].map((o) => o.id + ':' + o.updatedAt).join()
    + `|${project.width}x${project.height}@${scale}|${style.landTexture || ''}|`
    + texIds.map((id) => pics.get(id)?.naturalWidth || 0).join() + '|' + JSON.stringify(st);
  // Thumbnails get their own slot, so the home page doesn't evict the editor's layer.
  const key = scale < 0.2 ? `${project.id}:thumb` : project.id;
  const hit = layers.get(key);
  if (hit && hit.sig === sig) return hit.canvas;
  const canvas = renderLand(project, land, terrain, scale, pics, style.landTexture, st);
  layers.set(key, { sig, canvas });
  return canvas;
}

// A repeating fill of a library texture, textureSize map pixels a tile.
export function texturePattern(ctx, img, st) {
  const pat = ctx.createPattern(img, 'repeat');
  const k = st.textureSize / Math.max(img.naturalWidth, img.naturalHeight, 1);
  pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
  return pat;
}

function renderLand(project, land, terrain, scale, pics, landTexture, st) {
  const w = Math.max(1, Math.round(project.width * scale)), h = Math.max(1, Math.round(project.height * scale));
  const out = makeCanvas(w, h);
  const mask = makeCanvas(w, h);
  const o = out.getContext('2d'), m = mask.getContext('2d');
  const reset = () => {
    m.globalCompositeOperation = 'source-over';
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, w, h);
    m.setTransform(scale, 0, 0, scale, 0, 0);
    m.fillStyle = m.strokeStyle = '#000';
  };
  // The land grown by d, as a black mask.
  const landMask = (d) => {
    reset();
    for (const s of land) {
      m.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
      strokePath(m, s.points, s.mode === 'erase' ? s.width - 2 * d : s.width + 2 * d);
    }
  };
  // Colour (or pattern) the mask and lay it on the result.
  const paint = (fill, target = o) => {
    m.globalCompositeOperation = 'source-in';
    m.fillStyle = fill;
    m.fillRect(0, 0, project.width, project.height);
    target.drawImage(mask, 0, 0);
  };
  const base = landTexture && pics.get(landTexture) ? texturePattern(m, pics.get(landTexture), st) : st.land;
  if (land.length) {
    o.fillStyle = st.sea;
    o.fillRect(0, 0, w, h);
    for (const r of [...st.ripples].sort((a, b) => b - a)) {
      landMask(r); paint(STYLE.ripple);
      landMask(r - STYLE.rippleWidth); paint(st.sea);
    }
    if (st.coastStyle === 'hatch') {
      // Engraved-map shading: fine diagonal lines in a band along the shore.
      landMask(Math.max(...STYLE.ripples) * 0.8); paint(hatchPattern(m, st.coast, scale));
    }
    if (st.coastWidth > 0) { landMask(st.coastWidth); paint(st.coast); }
    landMask(0); paint(base);
  } else {
    // No land painted: the paper is the land, and terrain goes anywhere.
    o.fillStyle = PAPER;
    o.fillRect(0, 0, w, h);
  }
  if (terrain.length) {
    const t = makeCanvas(w, h), tc = t.getContext('2d');
    // Consecutive strokes of one texture share a pass.
    for (let i = 0; i < terrain.length;) {
      const tex = terrain[i].texture;
      let j = i;
      while (j < terrain.length && terrain[j].texture === tex) j++;
      const run = terrain.slice(i, j);
      i = j;
      const fill = tex ? (pics.get(tex) ? texturePattern(m, pics.get(tex), st) : null) : base;
      if (!fill) continue; // its picture hasn't loaded yet
      reset();
      for (const s of run) softStroke(m, s, scale);
      paint(fill, tc);
    }
    if (land.length) { landMask(0); tc.globalCompositeOperation = 'destination-in'; tc.drawImage(mask, 0, 0); }
    o.drawImage(t, 0, 0);
  }
  return out;
}

// Diagonal hatching in the coast's colour, a line every 7 map pixels.
function hatchPattern(ctx, colour, scale) {
  const n = 64;
  const c = makeCanvas(n, n), g = c.getContext('2d');
  g.strokeStyle = colour;
  g.globalAlpha = 0.55;
  g.lineWidth = 3;
  g.beginPath();
  for (let i = -n; i <= n * 2; i += 16) { g.moveTo(i, n); g.lineTo(i + n, 0); }
  g.stroke();
  const pat = ctx.createPattern(c, 'repeat');
  const k = 7 / 16; // map pixels per pattern pixel
  pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
  return pat;
}

// A stroke with feathered edges: soft (0…1) blurs up to half its width.
// The blur is a canvas shadow (it works in every browser, unlike filters):
// the stroke itself is drawn far off to the side, so only its shadow lands.
const FAR = 100000;
// opacity (0…1, default 1) makes the stroke partly see-through.
export function softStroke(ctx, s, scale) {
  const a = s.opacity ?? 1;
  const blur = Math.min(120, (s.soft || 0) * s.width * 0.5 * scale);
  if (blur < 0.5) { ctx.save(); ctx.globalAlpha = a; strokePath(ctx, s.points, s.width); ctx.restore(); return; }
  ctx.save();
  ctx.shadowColor = `rgba(0, 0, 0, ${a})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = FAR;
  ctx.translate(-FAR / scale, 0);
  strokePath(ctx, s.points, s.width * (1 - (s.soft || 0) * 0.4));
  ctx.restore();
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// --- labels -------------------------------------------------------------
//
// Text on the map: { text, x, y, size (map px), font, color, spacing (em),
// curve (-1…1: how far it bends, up like a hill when positive, down like a
// valley when negative; 1 is a half circle), rot, caps, halo }.

export const FONTS = {
  serif: ['Classic', (px) => `600 ${px}px Cormorant`],
  bold: ['Classic bold', (px) => `700 ${px}px Cormorant`],
  italic: ['Italic', (px) => `italic 500 ${px}px Cormorant`],
  sans: ['Plain', (px) => `500 ${px}px "Alegreya Sans"`],
  script: ['Script', (px) => `400 ${px}px "Cedarville Cursive"`],
  hand: ['Handwritten', (px) => `400 ${px}px Kalam`],
};
export const fontCSS = (key, px) => (FONTS[key] || FONTS.serif)[1](px);
export const HALO = 'rgba(233, 220, 188, .85)';

let measureCtx;
// Character advances for a label, and the arc it sits on.
function layout(o) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const text = o.caps ? o.text.toUpperCase() : o.text;
  measureCtx.font = fontCSS(o.font, o.size);
  const chars = [...text];
  const widths = chars.map((c) => measureCtx.measureText(c).width);
  const gap = (o.spacing || 0) * o.size;
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, chars.length - 1);
  const bend = Math.max(-1, Math.min(1, o.curve || 0));
  const R = Math.abs(bend) > 0.01 ? total / (Math.abs(bend) * Math.PI) : 0;
  return { chars, widths, gap, total, bend, R };
}

// The label's bounding box: centre, size and rotation, in map pixels.
export function labelBox(o) {
  const { total, bend, R } = layout(o);
  const lineH = o.size * 1.25;
  if (!R) return { cx: o.x, cy: o.y, w: Math.max(total, o.size), h: lineH, rot: o.rot || 0 };
  const half = total / R / 2; // half the angle the text spans
  const sag = R * (1 - Math.cos(half));
  const w = Math.max(2 * R * Math.sin(Math.min(half, Math.PI / 2)), o.size);
  const dy = Math.sign(bend) * sag / 2; // the arc's middle, below (or above) the text's anchor
  const rot = o.rot || 0;
  return { cx: o.x - Math.sin(rot) * dy, cy: o.y + Math.cos(rot) * dy, w, h: lineH + sag, rot };
}

export function drawLabel(ctx, o) {
  if (!o.text) return;
  const { chars, widths, gap, total, bend, R } = layout(o);
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.font = fontCSS(o.font, o.size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  const place = (fn) => {
    let s = 0;
    chars.forEach((c, i) => {
      const mid = s + widths[i] / 2 - total / 2;
      s += widths[i] + gap;
      ctx.save();
      if (R) {
        // Along a circle whose top (or bottom) passes through the anchor.
        const th = mid / R, sg = Math.sign(bend);
        ctx.translate(R * Math.sin(th), sg * R * (1 - Math.cos(th)));
        ctx.rotate(sg * th);
      } else ctx.translate(mid, 0);
      fn(c);
      ctx.restore();
    });
  };
  if (o.halo) {
    ctx.strokeStyle = HALO;
    ctx.lineWidth = o.size * 0.16;
    place((c) => ctx.strokeText(c, 0, 0));
  }
  ctx.fillStyle = o.color || '#2b2118';
  place((c) => ctx.fillText(c, 0, 0));
  ctx.restore();
}

// --- paths ----------------------------------------------------------------
//
// Roads (dashed), trails (dotted) and borders (dash-dot) in ink; rivers in
// the sea's colour with the coast's edge, widening from source to mouth.

export const PATHS = {
  road: ['Road', '#6b4a2b'],
  trail: ['Trail', '#6b4a2b'],
  river: ['River', null],
  border: ['Border', '#8e2f22'],
};

export function drawPath(ctx, o, st = STYLE) {
  const p = o.points, w = o.width;
  if (!p || p.length < 4) return;
  ctx.save();
  ctx.lineCap = ctx.lineJoin = 'round';
  if (o.style === 'river') {
    // Short segments, each a little wider than the last: from a quarter of
    // the width at the source to all of it at the mouth.
    const n = p.length / 2 - 1;
    const pass = (extra, colour) => {
      ctx.strokeStyle = colour;
      for (let i = 0; i < n; i++) {
        ctx.lineWidth = w * (0.25 + 0.75 * (i / Math.max(1, n - 1))) + extra;
        ctx.beginPath();
        ctx.moveTo(p[2 * i], p[2 * i + 1]);
        ctx.lineTo(p[2 * i + 2], p[2 * i + 3]);
        ctx.stroke();
      }
    };
    pass(Math.max(2, w * 0.35), st.coast);
    pass(0, st.sea);
  } else {
    ctx.strokeStyle = ctx.fillStyle = o.color || PATHS[o.style]?.[1] || '#6b4a2b';
    if (o.style === 'road') ctx.setLineDash([w * 3, w * 2]);
    else if (o.style === 'trail') ctx.setLineDash([0.01, w * 2.2]);
    else if (o.style === 'border') ctx.setLineDash([w * 4, w * 1.6, 0.01, w * 1.6]);
    if (o.style === 'trail') ctx.lineWidth = w * 1.1;
    smoothLine(ctx, p, o.style === 'trail' ? w * 1.1 : w);
  }
  ctx.restore();
}

function smoothLine(ctx, p, width) {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  ctx.stroke();
}
