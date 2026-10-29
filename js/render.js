// Draws a project's document onto a 2D canvas context, in map pixels. The
// editor and the project thumbnails share it, so they always agree.
import { liveObjects } from './store.js';

export const PAPER = '#e8dcc0';

// Strokes are flat [x0, y0, x1, y1, …] point lists in map pixels.
export function drawStroke(ctx, o) {
  const p = o.points;
  if (!p || p.length < 2) return;
  ctx.strokeStyle = ctx.fillStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], o.width / 2, 0, Math.PI * 2);
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
export function drawDoc(ctx, project, doc, { image = () => null, placeholder = false } = {}) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, project.width, project.height);
  if (!doc) return;
  const objs = liveObjects(doc).sort((a, b) => (a.z || 0) - (b.z || 0));
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
  drawDoc(ctx, project, doc, opts);
}
