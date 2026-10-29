// The map editor: a full-window canvas with pan/zoom (mouse, wheel, touch,
// pinch). Tools: select (move, scale, rotate, flip and layer stamps), ink pen,
// eraser, stamp (place art from the library) and scatter (paint many stamps
// at once). Everything is stored in map pixels, so the drawing is the same at
// any zoom and on any screen.
import * as store from '../store.js';
import * as A from '../assets.js';
import * as images from '../images.js';
import { $, $$, esc, uid, toast } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';
import { drawDoc, drawStroke } from '../render.js';

const INKS = ['#2b2118', '#6b4a2b', '#2f5d7c', '#3f6b3a', '#8e2f22'];
const TOOLS = [
  ['pan', 'hand-pointing', 'Move the view (H, or hold Space)'],
  ['select', 'arrows-out-cardinal', 'Select, move, scale and rotate stamps (V)'],
  ['pen', 'pencil-line', 'Ink pen (B)'],
  ['eraser', 'x', 'Eraser (E)'],
  ['stamp', 'mountains', 'Stamp: place art from the library (S)'],
  ['scatter', 'tree-evergreen', 'Scatter: paint many stamps at once (R)'],
];
const KEYS = { h: 'pan', v: 'select', b: 'pen', e: 'eraser', s: 'stamp', r: 'scatter' };
const HANDLE = 9; // screen pixels
const ROT_OFFSET = 34;

const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

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
      <aside class="picker" hidden></aside>
      <div class="toolbar" role="toolbar" aria-label="Tools">
        ${TOOLS.map(([t, ic, title]) => `<button class="tool" data-tool="${t}" title="${title}" aria-label="${title.replace(/ \(.*/, '')}">${icon(ic)}</button>`).join('')}
        <span class="tb-sep"></span>
        <span class="tb-group" data-for="pen"><span class="swatches">${INKS.map((c) => `<button class="swatch" data-ink="${c}" style="--c:${c}" aria-label="Ink ${c}"></button>`).join('')}</span></span>
        <span class="tb-group" data-for="pen eraser"><input type="range" class="width" min="2" max="80" step="1" title="Size ([ and ])" aria-label="Pen size"></span>
        <span class="tb-group" data-for="stamp scatter">
          <button class="brush-chip" data-act="picker" title="Choose art" aria-label="Choose art"></button>
          <input type="range" class="stamp-size" min="0" max="100" step="1" title="Stamp size ([ and ])" aria-label="Stamp size">
        </span>
        <span class="tb-group" data-for="select">
          <button class="tool" data-act="flip" title="Flip (F)" aria-label="Flip">${icon('arrows-clockwise')}</button>
          <button class="tool" data-act="front" title="Bring to front (])" aria-label="Bring to front">${icon('arrow-up')}</button>
          <button class="tool" data-act="back" title="Send to back ([)" aria-label="Send to back">${icon('arrow-down')}</button>
          <button class="tool" data-act="delete" title="Delete (Del)" aria-label="Delete">${icon('trash')}</button>
        </span>
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
    if (e.store === 'assets') { images.retryMissing(); ed.renderPicker(); }
    ed.redraw();
  };
}

// Stamp sizes run from 16 to 2048 map pixels on a curve, so the slider is
// fine-grained for small stamps and still reaches very large ones.
const sizeFromSlider = (v) => Math.round(16 * Math.pow(128, v / 100));
const sliderFromSize = (s) => Math.round(100 * Math.log(s / 16) / Math.log(128));

class Editor {
  constructor(root, project, doc) {
    this.root = root;
    this.project = project;
    this.doc = doc;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.s = 1; this.x = 0; this.y = 0; // map → screen: screen = map * s + (x, y)
    this.tool = load('ac.tool', 'pen');
    if (!TOOLS.some(([t]) => t === this.tool)) this.tool = 'pen';
    this.ink = load('ac.ink', INKS[0]);
    this.width = load('ac.width', 8);
    this.stampSize = load('ac.stampSize', 256);
    this.brush = load('ac.brush', []).filter((id) => A.asset(id)); // asset ids to stamp with
    this.multi = load('ac.multi', false);
    this.selected = null;
    this.undoStack = []; this.redoStack = [];
    this.pointers = new Map();
    this.gesture = null;
    this.spaceDown = false;
    this.disposers = [];
    this.wire();
    this.disposers.push(images.onLoad(() => this.redraw()));
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
  toScreen(mx, my) { return [mx * this.s + this.x, my * this.s + this.y]; }

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
    drawDoc(ctx, this.project, this.doc, { image: (id) => images.get(id), placeholder: true });
    if (this.gesture?.kind === 'draw') drawStroke(ctx, this.gesture.stroke);
    ctx.restore();
    const sel = this.selectedObj();
    if (sel) this.paintSelection(sel);
  }

  // Selection outline with corner handles (scale) and a handle above (rotate).
  paintSelection(o) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = this.corners(o).map((p) => this.toScreen(...p));
    const rh = this.rotHandle(o);
    const top = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
    ctx.strokeStyle = '#c4553b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.moveTo(...top); ctx.lineTo(...rh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff4ea';
    for (const p of c) { ctx.beginPath(); ctx.rect(p[0] - HANDLE / 2, p[1] - HANDLE / 2, HANDLE, HANDLE); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(rh[0], rh[1], HANDLE / 2 + 1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  // --- stamps -----------------------------------------------------------

  selectedObj() {
    const o = this.selected && this.doc.objects[this.selected];
    if (!o || o.deleted) { this.selected = null; return null; }
    return o;
  }

  // Map-space corners of a stamp: top-left, top-right, bottom-right, bottom-left.
  corners(o) {
    const cos = Math.cos(o.rot || 0), sin = Math.sin(o.rot || 0);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const lx = sx * o.w / 2, ly = sy * o.h / 2;
      return [o.x + lx * cos - ly * sin, o.y + lx * sin + ly * cos];
    });
  }

  // Screen position of the rotate handle, a fixed distance above the top edge.
  rotHandle(o) {
    const [cx, cy] = this.toScreen(o.x, o.y);
    const d = (o.h / 2) * this.s + ROT_OFFSET;
    const a = (o.rot || 0) - Math.PI / 2;
    return [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
  }

  inStamp(o, mx, my, pad = 0) {
    const cos = Math.cos(-(o.rot || 0)), sin = Math.sin(-(o.rot || 0));
    const dx = mx - o.x, dy = my - o.y;
    const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
    return Math.abs(lx) <= o.w / 2 + pad && Math.abs(ly) <= o.h / 2 + pad;
  }

  stampAt(mx, my) {
    const list = store.liveObjects(this.doc).filter((o) => o.kind === 'stamp').sort((a, b) => (b.z || 0) - (a.z || 0));
    return list.find((o) => this.inStamp(o, mx, my)) || null;
  }

  // A new stamp from the brush (a random pick when it holds several), its
  // longer side `size` map pixels.
  newStamp(mx, my, size, { jitter = false } = {}) {
    const ids = this.brush.filter((id) => A.asset(id));
    if (!ids.length) return null;
    const a = A.asset(ids[Math.floor(Math.random() * ids.length)]);
    const k = size / Math.max(a.w, a.h, 1);
    return {
      id: uid(), kind: 'stamp', asset: a.id,
      x: r1(mx), y: r1(my), w: r1(a.w * k), h: r1(a.h * k), rot: 0,
      flip: jitter ? Math.random() < 0.5 : false,
    };
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

  zRange() {
    let lo = 0, hi = 0;
    for (const o of Object.values(this.doc.objects)) if (!o.deleted) { lo = Math.min(lo, o.z || 0); hi = Math.max(hi, o.z || 0); }
    return [lo, hi];
  }
  nextZ() { return this.zRange()[1] + 1; }

  // Change the selected stamp (one undo step).
  editSelected(patch) {
    const o = this.selectedObj();
    if (!o) return;
    this.commit({ undo: [clean(o)], redo: [{ ...clean(o), ...patch }] });
  }

  deleteSelected() {
    const o = this.selectedObj();
    if (!o) return;
    this.selected = null;
    this.commit({ undo: [clean(o)], redo: [{ id: o.id, deleted: true }] });
    this.syncToolbar();
  }

  // Strokes and stamps under a point, within the eraser's radius (map pixels).
  hits([mx, my], radius) {
    const out = [];
    for (const o of store.liveObjects(this.doc)) {
      if (o.kind === 'stamp') { if (this.inStamp(o, mx, my, radius)) out.push(o); continue; }
      if (o.kind !== 'stroke') continue;
      const p = o.points, r = radius + o.width / 2;
      if (p.length === 2) { if (Math.hypot(p[0] - mx, p[1] - my) <= r) out.push(o); continue; }
      for (let i = 0; i < p.length - 2; i += 2) {
        if (segDist(mx, my, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) { out.push(o); break; }
      }
    }
    return out;
  }

  // --- toolbar and picker -------------------------------------------------

  setTool(t) {
    this.tool = t;
    keep('ac.tool', t);
    if (t !== 'select') this.selected = null;
    if ((t === 'stamp' || t === 'scatter') && !this.brush.length) this.openPicker();
    this.syncToolbar();
    this.redraw();
  }

  syncToolbar() {
    const panning = this.tool === 'pan' || this.spaceDown;
    for (const b of $$('[data-tool]', this.root)) b.classList.toggle('on', b.dataset.tool === this.tool);
    for (const b of $$('[data-ink]', this.root)) b.classList.toggle('on', b.dataset.ink === this.ink);
    for (const g of $$('.tb-group', this.root)) g.hidden = !g.dataset.for.split(' ').includes(this.tool);
    $('.width', this.root).value = this.width;
    $('.stamp-size', this.root).value = sliderFromSize(this.stampSize);
    const hasSel = !!this.selectedObj();
    for (const b of $$('[data-for="select"] button', this.root)) b.disabled = !hasSel;
    this.canvas.style.cursor = panning ? (this.gesture?.kind === 'pan' ? 'grabbing' : 'grab') : this.tool === 'select' ? 'default' : 'crosshair';
    this.renderChip();
  }

  async renderChip() {
    const chip = $('.brush-chip', this.root);
    if (!chip) return;
    const ids = this.brush.filter((id) => A.asset(id));
    const url = ids.length && await A.thumbURL(ids[0]);
    chip.innerHTML = url ? `<img src="${url}" alt="">${ids.length > 1 ? `<span class="chip-count">${ids.length}</span>` : ''}` : icon('plus');
  }

  openPicker() {
    $('.picker', this.root).hidden = false;
    this.renderPicker();
  }

  // The art picker: a pack and a category of stamps, as a grid. A tap uses
  // that picture; with "Pick several", taps add and remove pictures, and the
  // stamp and scatter tools choose among them at random.
  renderPicker() {
    const el = $('.picker', this.root);
    if (!el || el.hidden) return;
    const packs = A.packs().map((p) => ({ ...p, categories: p.categories.filter((c) => c.kind === 'stamp') })).filter((p) => p.categories.length);
    if (!packs.length) {
      el.innerHTML = `<header><b>Stamps</b><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
        <p class="muted pad">No stamps yet. Import art in the <a href="#/library">Art library</a>.</p>`;
      $('[data-close]', el).onclick = () => { el.hidden = true; };
      return;
    }
    let pack = packs.find((p) => p.name === load('ac.pickPack', '')) || packs[0];
    let cat = pack.categories.find((c) => c.name === load('ac.pickCat', '')) || pack.categories[0];
    const list = A.liveAssets().filter((a) => a.pack === pack.name && a.category === cat.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const chosen = new Set(this.brush);
    el.innerHTML = `<header><b>Stamps</b>
        <label class="check small"><input type="checkbox" class="pk-multi" ${this.multi ? 'checked' : ''}> Pick several</label>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="pk-filters">
        <select class="pk-pack" aria-label="Pack">${packs.map((p) => `<option ${p === pack ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select class="pk-cat" aria-label="Category">${pack.categories.map((c) => `<option value="${esc(c.name)}" ${c === cat ? 'selected' : ''}>${esc(c.name || 'General')} (${c.count})</option>`).join('')}</select>
      </div>
      <div class="pk-actions"><button class="btn small" data-all>Use all ${list.length}</button><span class="muted small">${this.brush.length} chosen</span></div>
      <div class="pk-grid">${list.map((a) => `<button class="tile${chosen.has(a.id) ? ' on' : ''}" data-id="${a.id}" title="${esc(a.name)}">${icon('image')}</button>`).join('')}</div>`;
    $('[data-close]', el).onclick = () => { el.hidden = true; };
    $('.pk-multi', el).onchange = (e) => { this.multi = e.target.checked; keep('ac.multi', this.multi); };
    $('.pk-pack', el).onchange = (e) => { keep('ac.pickPack', e.target.value); keep('ac.pickCat', ''); this.renderPicker(); };
    $('.pk-cat', el).onchange = (e) => { keep('ac.pickCat', e.target.value); this.renderPicker(); };
    $('[data-all]', el).onclick = () => this.setBrush(list.map((a) => a.id));
    $('.pk-grid', el).onclick = (e) => {
      const t = e.target.closest('.tile');
      if (!t) return;
      const id = t.dataset.id;
      if (this.multi) this.setBrush(chosen.has(id) ? this.brush.filter((x) => x !== id) : [...this.brush, id]);
      else this.setBrush([id]);
      if (this.tool !== 'stamp' && this.tool !== 'scatter') this.setTool('stamp');
      // On small screens the picker covers the map: close it after a single pick.
      if (!this.multi && matchMedia('(max-width: 600px)').matches) el.hidden = true;
    };
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) {
        io.unobserve(en.target);
        A.thumbURL(en.target.dataset.id).then((url) => { if (url) en.target.innerHTML = `<img src="${url}" alt="" draggable="false">`; });
      }
    }, { root: el, rootMargin: '200px' });
    for (const t of $$('.tile', el)) io.observe(t);
  }

  setBrush(ids) {
    this.brush = ids;
    keep('ac.brush', ids);
    this.renderPicker();
    this.syncToolbar();
  }

  // --- input ------------------------------------------------------------

  wire() {
    const tb = $('.toolbar', this.root);
    tb.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool);
      if (b.dataset.ink) { this.ink = b.dataset.ink; keep('ac.ink', this.ink); this.syncToolbar(); }
      const act = b.dataset.act;
      if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
      else if (act === 'fit') this.fit();
      else if (act === 'picker') { const p = $('.picker', this.root); if (p.hidden) this.openPicker(); else p.hidden = true; }
      else if (act === 'flip') this.editSelected({ flip: !this.selectedObj()?.flip });
      else if (act === 'front') this.editSelected({ z: this.nextZ() });
      else if (act === 'back') this.editSelected({ z: this.zRange()[0] - 1 });
      else if (act === 'delete') this.deleteSelected();
    };
    $('.width', this.root).oninput = (e) => { this.width = +e.target.value; keep('ac.width', this.width); };
    $('.stamp-size', this.root).oninput = (e) => { this.stampSize = sizeFromSlider(+e.target.value); keep('ac.stampSize', this.stampSize); };
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
    this.on(document, 'keydown', (e) => this.key(e));
    this.on(document, 'keyup', (e) => { if (e.key === ' ') { this.spaceDown = false; this.syncToolbar(); } });
  }

  key(e) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
    if (document.getElementById('modal-root').childElementCount) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod) return;
    if (e.key === ' ') { e.preventDefault(); if (!this.spaceDown) { this.spaceDown = true; this.syncToolbar(); } return; }
    const sel = this.selectedObj();
    if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); this.deleteSelected(); return; }
    if (e.key === 'Escape') { this.selected = null; $('.picker', this.root).hidden = true; this.syncToolbar(); this.redraw(); return; }
    if (KEYS[k]) this.setTool(KEYS[k]);
    else if (k === '0') this.fit();
    else if (k === '+' || k === '=') this.zoomAt(this.vw / 2, this.vh / 2, 1.25);
    else if (k === '-') this.zoomAt(this.vw / 2, this.vh / 2, 0.8);
    else if (sel && k === 'f') this.editSelected({ flip: !sel.flip });
    else if (sel && k === ']') this.editSelected({ z: this.nextZ() });
    else if (sel && k === '[') this.editSelected({ z: this.zRange()[0] - 1 });
    else if (k === '[' || k === ']') {
      const up = k === ']';
      if (this.tool === 'stamp' || this.tool === 'scatter') {
        this.stampSize = Math.max(16, Math.min(2048, Math.round(this.stampSize * (up ? 1.15 : 1 / 1.15))));
        keep('ac.stampSize', this.stampSize);
      } else {
        this.width = Math.max(2, Math.min(80, this.width + (up ? 2 : -2)));
        keep('ac.width', this.width);
      }
      this.syncToolbar();
    }
  }

  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      // A second finger turns whatever the first started into a pinch. What
      // it began is put back: a stroke or stamp only just started is dropped
      // rather than left as a stray mark.
      this.abandon();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      this.redraw();
      return;
    }
    if (this.pointers.size > 2) return;
    const pt = this.local(e);
    const [mx, my] = this.toMap(...pt);
    const panning = this.tool === 'pan' || this.spaceDown || e.button === 1 || e.button === 2;
    if (panning) this.gesture = { kind: 'pan', last: pt };
    else if (this.tool === 'pen') {
      this.gesture = { kind: 'draw', stroke: { id: uid(), kind: 'stroke', color: this.ink, width: this.width, points: [r1(mx), r1(my)] } };
    } else if (this.tool === 'eraser') {
      this.gesture = { kind: 'erase', erased: new Map() };
      this.eraseAt(pt);
    } else if (this.tool === 'select') {
      this.gesture = this.selectGesture(pt, mx, my) || { kind: 'pan', last: pt };
    } else if (this.tool === 'stamp') {
      const o = this.newStamp(mx, my, this.stampSize);
      if (!o) { this.openPicker(); toast('Choose some art first'); return; }
      o.z = this.nextZ();
      this.doc.objects[o.id] = o;
      this.gesture = { kind: 'place', id: o.id, from: [mx, my], orig: { ...o } };
    } else if (this.tool === 'scatter') {
      if (!this.brush.some((id) => A.asset(id))) { this.openPicker(); toast('Choose some art first'); return; }
      this.gesture = { kind: 'scatter', placed: [], last: null };
      this.scatterAt(mx, my);
    }
    this.syncToolbar();
    this.redraw();
  }

  // Grab a handle of the selected stamp, or a stamp under the pointer.
  selectGesture(pt, mx, my) {
    const sel = this.selectedObj();
    if (sel) {
      const rh = this.rotHandle(sel);
      if (Math.hypot(pt[0] - rh[0], pt[1] - rh[1]) <= HANDLE + 4) {
        return { kind: 'rotate', id: sel.id, orig: clean(sel), a0: Math.atan2(my - sel.y, mx - sel.x) };
      }
      for (const c of this.corners(sel)) {
        const [sx, sy] = this.toScreen(...c);
        if (Math.abs(pt[0] - sx) <= HANDLE + 4 && Math.abs(pt[1] - sy) <= HANDLE + 4) {
          return { kind: 'scale', id: sel.id, orig: clean(sel), d0: Math.max(1, Math.hypot(mx - sel.x, my - sel.y)) };
        }
      }
    }
    const hit = this.stampAt(mx, my);
    this.selected = hit?.id || null;
    return hit ? { kind: 'move', id: hit.id, orig: clean(hit), from: [mx, my] } : null;
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const pt = this.local(e);
    this.pointers.set(e.pointerId, pt);
    const g = this.gesture;
    if (!g) return;
    const [mx, my] = this.toMap(...pt);
    if (g.kind === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.x += mid[0] - g.mid[0]; this.y += mid[1] - g.mid[1];
      if (g.dist > 0) this.zoomAt(mid[0], mid[1], dist / g.dist);
      g.dist = dist; g.mid = mid;
    } else if (g.kind === 'pan') {
      this.x += pt[0] - g.last[0]; this.y += pt[1] - g.last[1];
      g.last = pt;
    } else if (g.kind === 'draw') {
      const p = g.stroke.points;
      // Skip points closer than ~1.5 screen pixels: invisible, and they bloat the file.
      if (Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]) * this.s < 1.5) return;
      p.push(r1(mx), r1(my));
    } else if (g.kind === 'erase') {
      this.eraseAt(pt);
    } else if (g.kind === 'move' || g.kind === 'place') {
      const o = g.orig;
      this.doc.objects[g.id] = { ...this.doc.objects[g.id], x: r1(o.x + mx - g.from[0]), y: r1(o.y + my - g.from[1]) };
      g.moved = true;
    } else if (g.kind === 'scale') {
      const o = g.orig;
      const k = Math.max(4 / Math.max(o.w, o.h), Math.hypot(mx - o.x, my - o.y) / g.d0);
      this.doc.objects[g.id] = { ...this.doc.objects[g.id], w: r1(o.w * k), h: r1(o.h * k) };
      g.moved = true;
    } else if (g.kind === 'rotate') {
      let rot = (g.orig.rot || 0) + Math.atan2(my - g.orig.y, mx - g.orig.x) - g.a0;
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      this.doc.objects[g.id] = { ...this.doc.objects[g.id], rot: Math.round(rot * 1000) / 1000 };
      g.moved = true;
    } else if (g.kind === 'scatter') {
      this.scatterAt(mx, my);
    }
    this.redraw();
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
    if (cancelled && g.kind !== 'erase') { this.restore(g); this.syncToolbar(); this.redraw(); return; }
    if (g.kind === 'draw') {
      const stroke = { ...g.stroke, z: this.nextZ() };
      this.commit({ undo: [{ id: stroke.id, deleted: true }], redo: [stroke] });
    } else if (g.kind === 'erase' && g.erased.size) {
      const gone = [...g.erased.values()];
      if (gone.some((o) => o.id === this.selected)) this.selected = null;
      this.commit({ undo: gone.map(clean), redo: gone.map((o) => ({ id: o.id, deleted: true })) });
    } else if (g.kind === 'place') {
      const o = clean(this.doc.objects[g.id]);
      this.commit({ undo: [{ id: o.id, deleted: true }], redo: [o] });
    } else if ((g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate') && g.moved) {
      this.commit({ undo: [g.orig], redo: [clean(this.doc.objects[g.id])] });
    } else if (g.kind === 'scatter' && g.placed.length) {
      // Stamps lower on the map overlap the ones behind them, like a landscape.
      const z0 = this.nextZ();
      const placed = g.placed.map((id) => this.doc.objects[id]).sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2))
        .map((o, i) => ({ ...clean(o), z: z0 + i }));
      this.commit({ undo: placed.map((o) => ({ id: o.id, deleted: true })), redo: placed });
    }
    this.syncToolbar();
    this.redraw();
  }

  // Put back whatever an unfinished gesture changed on screen.
  restore(g) {
    if (g.kind === 'place') delete this.doc.objects[g.id];
    else if (g.kind === 'scatter') for (const id of g.placed) delete this.doc.objects[id];
    else if (g.kind === 'move' || g.kind === 'scale' || g.kind === 'rotate') this.doc.objects[g.id] = { ...this.doc.objects[g.id], ...g.orig };
  }

  abandon() {
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'erase') {
      // Erasing is committed rather than dropped: what was erased stays erased.
      this.gesture = null;
      if (g.erased.size) { const gone = [...g.erased.values()]; this.commit({ undo: gone.map(clean), redo: gone.map((o) => ({ id: o.id, deleted: true })) }); }
      return;
    }
    this.restore(g);
    this.gesture = null;
  }

  // Scatter: drop stamps along the drag, spaced by their size, each nudged,
  // resized a little and sometimes mirrored, so they don't look stamped.
  scatterAt(mx, my) {
    const g = this.gesture;
    const spacing = this.stampSize * 0.6;
    if (g.last && Math.hypot(mx - g.last[0], my - g.last[1]) < spacing) return;
    g.last = [mx, my];
    const r = this.stampSize * 0.5;
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    const o = this.newStamp(mx + Math.cos(a) * d, my + Math.sin(a) * d, this.stampSize * (0.8 + Math.random() * 0.4), { jitter: true });
    if (!o) return;
    o.z = this.nextZ();
    this.doc.objects[o.id] = o;
    g.placed.push(o.id);
  }

  // The eraser hides strokes and stamps as it passes; they're removed for
  // real (and become one undo step) when the pointer lifts.
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

// An object as stored, without sync bookkeeping (for undo and redo entries).
const clean = ({ updatedAt, deleted, ...o }) => o;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
