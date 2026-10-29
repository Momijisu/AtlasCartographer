// The map editor: a full-window canvas with pan/zoom (mouse, wheel, touch,
// pinch) and, for now, an ink pen and an eraser. Everything is stored in map
// pixels, so the drawing is the same at any zoom and on any screen.
import * as store from '../store.js';
import { $, $$, esc, uid, toast } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';
import { drawDoc, drawStroke } from '../render.js';

const INKS = ['#2b2118', '#6b4a2b', '#2f5d7c', '#3f6b3a', '#8e2f22'];

export async function viewEditor(view, id) {
  const project = store.project(id);
  const doc = project && await store.getDoc(id);
  if (!project || !doc) {
    view.innerHTML = `<div class="empty-state">${icon('map-trifold', 'empty-emblem')}<h2>${project ? 'Not downloaded yet' : 'Map not found'}</h2>
      <p>${project ? 'This map’s drawing will appear after the next sync.' : 'It may have been deleted on another device.'}</p><p><a href="#/">Back to your maps</a></p></div>`;
    return;
  }
  setTitle(project.name);
  document.body.classList.add('editing');
  $('#topSlot').innerHTML = `<a class="icon-btn" href="#/" aria-label="Back to your maps" title="Back to your maps">${icon('arrow-left')}</a>
    <span class="editor-title" id="edTitle">${esc(project.name)}</span>`;
  view.innerHTML = `<div class="editor">
      <canvas class="editor-canvas"></canvas>
      <div class="toolbar" role="toolbar" aria-label="Tools">
        <button class="tool" data-tool="pan" title="Move (H, or hold Space)" aria-label="Move">${icon('hand-pointing')}</button>
        <button class="tool" data-tool="pen" title="Ink pen (B)" aria-label="Ink pen">${icon('pencil-line')}</button>
        <button class="tool" data-tool="eraser" title="Eraser (E)" aria-label="Eraser">${icon('x')}</button>
        <span class="tb-sep"></span>
        <div class="swatches">${INKS.map((c) => `<button class="swatch" data-ink="${c}" style="--c:${c}" aria-label="Ink ${c}"></button>`).join('')}</div>
        <input type="range" class="width" min="2" max="80" step="1" value="8" title="Pen size" aria-label="Pen size">
        <span class="tb-sep"></span>
        <button class="tool" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('arrow-counter-clockwise')}</button>
        <button class="tool flip" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon('arrow-counter-clockwise')}</button>
        <button class="tool" data-act="fit" title="Fit the map (0)" aria-label="Fit the map">${icon('corners-out')}</button>
      </div>
    </div>`;
  const ed = new Editor(view.querySelector('.editor'), project, doc);
  state.cleanup = () => ed.destroy();
  state.onRemote = async (e) => {
    const p = store.project(id);
    if (!p) { toast('This map was deleted on another device'); location.hash = '#/'; return; }
    $('#edTitle').textContent = p.name;
    ed.project = p;
    if (e.store === 'docs' && e.id === id) ed.doc = await store.getDoc(id);
    ed.redraw();
  };
}

class Editor {
  constructor(root, project, doc) {
    this.root = root;
    this.project = project;
    this.doc = doc;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.s = 1; this.x = 0; this.y = 0; // map → screen: screen = map * s + (x, y)
    this.tool = localStorage.getItem('ac.tool') || 'pen';
    this.ink = localStorage.getItem('ac.ink') || INKS[0];
    this.width = +(localStorage.getItem('ac.width') || 8);
    this.undoStack = []; this.redoStack = [];
    this.pointers = new Map();
    this.gesture = null; // { kind: 'draw' | 'erase' | 'pan' | 'pinch', … }
    this.spaceDown = false;
    this.disposers = [];
    this.wire();
    this.resize();
    this.fit();
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  destroy() {
    this.disposers.forEach((d) => d());
    cancelAnimationFrame(this.raf);
  }

  // --- view transform ---------------------------------------------------

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.vw = r.width; this.vh = r.height; this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.redraw();
  }

  minScale() { return Math.min(this.vw / this.project.width, this.vh / this.project.height) * 0.5; }

  fit() {
    const pad = 24;
    this.s = Math.min((this.vw - pad * 2) / this.project.width, (this.vh - pad * 2) / this.project.height);
    this.x = (this.vw - this.project.width * this.s) / 2;
    this.y = (this.vh - this.project.height * this.s) / 2;
    this.redraw();
  }

  zoomAt(cx, cy, factor) {
    const ns = Math.max(this.minScale(), Math.min(this.s * factor, 8));
    this.x = cx - (cx - this.x) * (ns / this.s);
    this.y = cy - (cy - this.y) * (ns / this.s);
    this.s = ns;
    this.redraw();
  }

  toMap(cx, cy) { return [(cx - this.x) / this.s, (cy - this.y) / this.s]; }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // --- drawing ----------------------------------------------------------

  redraw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  paint() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.s * dpr, 0, 0, this.s * dpr, this.x * dpr, this.y * dpr);
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 24 * dpr;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.project.width, this.project.height);
    ctx.shadowColor = 'transparent';
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.project.width, this.project.height);
    ctx.clip();
    drawDoc(ctx, this.project, this.doc);
    if (this.gesture?.kind === 'draw') drawStroke(ctx, this.gesture.stroke);
    ctx.restore();
  }

  // --- editing ----------------------------------------------------------

  async apply(objs) {
    await store.putObjects(this.project.id, objs);
    this.redraw();
  }

  async commit(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    await this.apply(entry.redo.map((o) => ({ ...o })));
  }

  async undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    await this.apply(e.undo.map((o) => ({ ...o })));
  }

  async redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    await this.apply(e.redo.map((o) => ({ ...o })));
  }

  nextZ() {
    let z = 0;
    for (const o of Object.values(this.doc.objects)) if (!o.deleted && (o.z || 0) > z) z = o.z;
    return z + 1;
  }

  // Strokes under a point, within the eraser's radius (map pixels).
  hits([mx, my], radius) {
    const out = [];
    for (const o of store.liveObjects(this.doc)) {
      if (o.kind !== 'stroke') continue;
      const p = o.points, r = radius + o.width / 2;
      if (p.length === 2) { if (Math.hypot(p[0] - mx, p[1] - my) <= r) out.push(o); continue; }
      for (let i = 0; i < p.length - 2; i += 2) {
        if (segDist(mx, my, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) { out.push(o); break; }
      }
    }
    return out;
  }

  // --- input ------------------------------------------------------------

  setTool(t) {
    this.tool = t;
    localStorage.setItem('ac.tool', t);
    this.syncToolbar();
  }

  syncToolbar() {
    const panning = this.tool === 'pan' || this.spaceDown;
    for (const b of $$('[data-tool]', this.root)) b.classList.toggle('on', b.dataset.tool === this.tool);
    for (const b of $$('[data-ink]', this.root)) b.classList.toggle('on', b.dataset.ink === this.ink);
    $('.width', this.root).value = this.width;
    this.canvas.style.cursor = panning ? (this.gesture?.kind === 'pan' ? 'grabbing' : 'grab') : 'crosshair';
  }

  wire() {
    const tb = $('.toolbar', this.root);
    tb.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool);
      if (b.dataset.ink) { this.ink = b.dataset.ink; localStorage.setItem('ac.ink', this.ink); if (this.tool !== 'pen') this.setTool('pen'); this.syncToolbar(); }
      if (b.dataset.act === 'undo') this.undo();
      if (b.dataset.act === 'redo') this.redo();
      if (b.dataset.act === 'fit') this.fit();
    };
    $('.width', this.root).oninput = (e) => { this.width = +e.target.value; localStorage.setItem('ac.width', this.width); };
    this.syncToolbar();

    const c = this.canvas;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
    this.disposers.push(() => this.ro.disconnect());

    this.on(c, 'pointerdown', (e) => this.down(e));
    this.on(c, 'pointermove', (e) => this.move(e));
    this.on(c, 'pointerup', (e) => this.up(e));
    this.on(c, 'pointercancel', (e) => this.up(e, true));
    this.on(c, 'contextmenu', (e) => e.preventDefault());
    this.on(c, 'wheel', (e) => {
      e.preventDefault();
      const [cx, cy] = this.local(e);
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) < 1) this.zoomAt(cx, cy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else { this.x -= e.deltaX; this.y -= e.deltaY; this.redraw(); }
    }, { passive: false });
    this.on(document, 'keydown', (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
      if (document.getElementById('modal-root').childElementCount) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
      if (mod) return;
      if (e.key === ' ') { e.preventDefault(); if (!this.spaceDown) { this.spaceDown = true; this.syncToolbar(); } return; }
      const k = e.key.toLowerCase();
      if (k === 'b') this.setTool('pen');
      else if (k === 'e') this.setTool('eraser');
      else if (k === 'h') this.setTool('pan');
      else if (k === '0') this.fit();
      else if (k === '+' || k === '=') this.zoomAt(this.vw / 2, this.vh / 2, 1.25);
      else if (k === '-') this.zoomAt(this.vw / 2, this.vh / 2, 0.8);
      else if (k === '[') { this.width = Math.max(2, this.width - 2); this.syncToolbar(); }
      else if (k === ']') { this.width = Math.min(80, this.width + 2); this.syncToolbar(); }
    });
    this.on(document, 'keyup', (e) => { if (e.key === ' ') { this.spaceDown = false; this.syncToolbar(); } });
  }

  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      // A second finger turns whatever the first started into a pinch; a
      // stroke only just begun is dropped rather than left as a stray mark.
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      this.redraw();
      return;
    }
    if (this.pointers.size > 2) return;
    const pt = this.local(e);
    const panning = this.tool === 'pan' || this.spaceDown || e.button === 1 || e.button === 2;
    if (panning) this.gesture = { kind: 'pan', last: pt };
    else if (this.tool === 'pen') {
      const [mx, my] = this.toMap(...pt);
      this.gesture = { kind: 'draw', stroke: { id: uid(), kind: 'stroke', color: this.ink, width: this.width, points: [r1(mx), r1(my)] } };
    } else if (this.tool === 'eraser') {
      this.gesture = { kind: 'erase', erased: new Map() };
      this.eraseAt(pt);
    }
    this.syncToolbar();
    this.redraw();
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const pt = this.local(e);
    this.pointers.set(e.pointerId, pt);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.x += mid[0] - g.mid[0]; this.y += mid[1] - g.mid[1];
      if (g.dist > 0) this.zoomAt(mid[0], mid[1], dist / g.dist);
      g.dist = dist; g.mid = mid;
      this.redraw();
    } else if (g.kind === 'pan') {
      this.x += pt[0] - g.last[0]; this.y += pt[1] - g.last[1];
      g.last = pt;
      this.redraw();
    } else if (g.kind === 'draw') {
      const p = g.stroke.points;
      const [mx, my] = this.toMap(...pt);
      // Skip points closer than ~1.5 screen pixels: invisible, and they bloat the file.
      if (Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]) * this.s < 1.5) return;
      p.push(r1(mx), r1(my));
      this.redraw();
    } else if (g.kind === 'erase') {
      this.eraseAt(pt);
    }
  }

  up(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    this.gesture = null;
    if (g.kind === 'draw' && !cancelled) {
      const stroke = { ...g.stroke, z: this.nextZ() };
      this.commit({ undo: [{ id: stroke.id, deleted: true }], redo: [stroke] });
    } else if (g.kind === 'erase' && g.erased.size) {
      const gone = [...g.erased.values()];
      this.commit({ undo: gone.map(({ deleted, updatedAt, ...o }) => o), redo: gone.map((o) => ({ id: o.id, deleted: true })) });
    }
    this.syncToolbar();
    this.redraw();
  }

  // The eraser hides strokes as it passes; they're removed for real (and
  // become one undo step) when the pointer lifts.
  eraseAt(pt) {
    const g = this.gesture;
    // The eraser is as wide as the pen, but never under ~6 screen pixels.
    const hit = this.hits(this.toMap(...pt), Math.max(this.width / 2, 6 / this.s));
    if (!hit.length) return;
    for (const o of hit) {
      g.erased.set(o.id, o);
      this.doc.objects[o.id] = { ...o, deleted: true };
    }
    this.redraw();
  }
}

const r1 = (v) => Math.round(v * 10) / 10;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
