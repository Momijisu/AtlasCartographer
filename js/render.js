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

export function drawDoc(ctx, project, doc) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, project.width, project.height);
  if (!doc) return;
  const objs = liveObjects(doc).sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const o of objs) if (o.kind === 'stroke') drawStroke(ctx, o);
}

// Render the whole map into a canvas no bigger than maxW × maxH.
export function drawThumb(canvas, project, doc, maxW = 480, maxH = 360) {
  const s = Math.min(maxW / project.width, maxH / project.height);
  canvas.width = Math.max(1, Math.round(project.width * s));
  canvas.height = Math.max(1, Math.round(project.height * s));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawDoc(ctx, project, doc);
}
