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
export function drawStamp(ctx, o, img, placeholder = false) {
  if (!img && !placeholder) return;
  ctx.save();
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

// image(assetId) → a loaded picture or null (see images.js).
// landScale: resolution of the land layer relative to the map (it's cached).
export function drawDoc(ctx, project, doc, { image = () => null, placeholder = false, landScale = 0.5 } = {}) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, project.width, project.height);
  if (!doc) return;
  const objs = liveObjects(doc).sort((a, b) => (a.z || 0) - (b.z || 0));
  const land = objs.filter((o) => o.kind === 'land');
  if (land.length) ctx.drawImage(landLayer(project, doc, land, landScale, image), 0, 0, project.width, project.height);
  for (const o of objs) {
    if (o.kind === 'stroke') drawStroke(ctx, o);
    else if (o.kind === 'stamp') drawStamp(ctx, o, image(o.asset), placeholder);
  }
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

const layers = new Map(); // `${project.id}:${scale}` → { sig, canvas }

export const docStyle = (doc) => doc?.objects?.style && !doc.objects.style.deleted ? doc.objects.style : {};

function landLayer(project, doc, land, scale, image) {
  const style = docStyle(doc);
  const tex = style.landTexture ? image(style.landTexture) : null;
  const sig = land.map((o) => o.id + ':' + o.updatedAt).join() + `|${project.width}x${project.height}|${style.landTexture || ''}:${tex ? tex.naturalWidth : 0}`;
  const key = `${project.id}:${scale}`;
  const hit = layers.get(key);
  if (hit && hit.sig === sig) return hit.canvas;
  const canvas = renderLand(project, land, scale, tex);
  layers.set(key, { sig, canvas });
  return canvas;
}

function renderLand(project, land, scale, tex) {
  const w = Math.max(1, Math.round(project.width * scale)), h = Math.max(1, Math.round(project.height * scale));
  const out = makeCanvas(w, h);
  const mask = makeCanvas(w, h);
  const o = out.getContext('2d'), m = mask.getContext('2d');
  o.fillStyle = STYLE.sea;
  o.fillRect(0, 0, w, h);
  // Fill the land grown by d, in a colour (or with a pattern) of its own.
  const layer = (d, fill) => {
    m.globalCompositeOperation = 'source-over';
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, w, h);
    m.setTransform(scale, 0, 0, scale, 0, 0);
    m.fillStyle = m.strokeStyle = '#000';
    for (const s of land) {
      m.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
      strokePath(m, s.points, s.mode === 'erase' ? s.width - 2 * d : s.width + 2 * d);
    }
    m.globalCompositeOperation = 'source-in';
    m.fillStyle = fill;
    m.fillRect(0, 0, project.width, project.height);
    o.drawImage(mask, 0, 0);
  };
  for (const r of [...STYLE.ripples].sort((a, b) => b - a)) {
    layer(r, STYLE.ripple);
    layer(r - STYLE.rippleWidth, STYLE.sea);
  }
  layer(STYLE.coastWidth, STYLE.coast);
  let fill = STYLE.land;
  if (tex) {
    const pat = m.createPattern(tex, 'repeat');
    const k = STYLE.textureSize / Math.max(tex.naturalWidth, tex.naturalHeight, 1);
    pat.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
    fill = pat;
  }
  layer(0, fill);
  return out;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
