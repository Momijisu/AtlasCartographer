// The map editor: a full-window canvas with pan/zoom (mouse, wheel, touch,
// pinch). Tools: select (move, scale, rotate, flip and layer stamps), ink pen,
// eraser, stamp (place art from the library) and scatter (paint many stamps
// at once). Everything is stored in map pixels, so the drawing is the same at
// any zoom and on any screen.
import * as store from '../store.js';
import * as A from '../assets.js';
import * as images from '../images.js';
import { $, $$, esc, uid, toast, modal } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';
import { drawDoc, drawStroke, strokePath, docStyle, STYLE, editorLandScale, labelBox, drawLabel, FONTS, fontCSS, mapStyle, texturePattern, drawPath, PATHS, docLayers, layerResolver, kindLayer, LAND_LAYER, BUILTIN_LAYERS, samplePath, pointsBox, simplify, landNeedsRefresh, refreshLand } from '../render.js';
import { exportDialog } from '../export.js';

const INKS = ['#2b2118', '#6b4a2b', '#2f5d7c', '#3f6b3a', '#8e2f22'];
const TOOLS = [
  ['pan', 'hand-pointing', 'Move the view (H, or hold Space)', 'Move'],
  ['select', 'arrows-out-cardinal', 'Select, move, scale and rotate stamps (V)', 'Select'],
  ['land', 'globe-hemisphere-west', 'Land and water (L)', 'Land'],
  ['terrain', 'paint-brush', 'Terrain: paint textures onto the land (G)', 'Terrain'],
  ['text', 'text-t', 'Text: click to add a label, or click one to edit it (T)', 'Text'],
  ['path', 'path', 'Paths: roads, trails, rivers and borders (P)', 'Path'],
  ['pen', 'pencil-line', 'Pen and colour brush (B)', 'Pen'],
  ['eraser', 'eraser', 'Eraser (E)', 'Eraser'],
  ['stamp', 'mountains', 'Stamp: place art from the library (S)', 'Stamp'],
  ['scatter', 'tree-evergreen', 'Scatter: paint many stamps at once (R)', 'Scatter'],
];
// The layer each tool draws on.
const TOOL_LAYER = { land: 'land', terrain: 'land', path: 'stroke', pen: 'stroke', stamp: 'stamp', scatter: 'stamp', text: 'label' };
const KEYS = { h: 'pan', v: 'select', l: 'land', g: 'terrain', p: 'path', t: 'text', b: 'pen', e: 'eraser', s: 'stamp', r: 'scatter' };
const HANDLE = 9; // screen pixels
const ROT_OFFSET = 34;

const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

// One window edits a map at a time: two would each hold their own copy of
// the drawing in memory. The first to open it holds a Web Lock; others
// (another tab, or the installed app) get a read-only view until it's free.
// Where Web Locks don't exist, every window may edit, as before.
function claimMap(id) {
  if (!navigator.locks) return Promise.resolve({ held: true, release() {} });
  return new Promise((resolve) => {
    navigator.locks.request(`ac-map-${id}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve({ held: false, release() {} }); return null; }
      return new Promise((release) => resolve({ held: true, release }));
    });
  });
}

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
    <span class="editor-title" id="edTitle">${esc(project.name)}</span>
    <button class="btn small quiet" id="exportBtn" title="Export as a picture">${icon('download-simple')}<span class="hide-phone">Export</span></button>`;
  $('#exportBtn').onclick = () => exportDialog(store.project(id));
  view.innerHTML = `<div class="editor">
      <canvas class="editor-canvas"></canvas>
      <aside class="picker" hidden></aside>
      <div class="toolrail" role="toolbar" aria-label="Tools">
        ${TOOLS.map(([t, ic, title, name]) => `<button class="tool" data-tool="${t}" data-name="${name}" data-key="${title.match(/\(([^)]*)\)$/)[1]}" aria-label="${title.replace(/ \(.*/, '')}">${icon(ic)}</button>`).join('')}
      </div>
      <div class="ro-banner" role="status" hidden>This map is open in another window. Close it there to edit here.</div>
      <div class="save-banner" role="alert" hidden></div>
      <div class="tool-tip" hidden></div>
      <div class="map-hint" hidden><span class="hint-text"></span><button class="icon-btn" data-hint-close aria-label="Dismiss the hint">${icon('x')}</button></div>
      <div class="pk-preview" hidden></div>
      <div class="toolbar" role="toolbar" aria-label="Tool options">
        <span class="tb-name"></span><span class="tb-sep"></span>
        <span class="tb-group" data-for="land">
          <span class="seg land-mode"><button type="button" data-landmode="add" title="Paint land (hold Alt for water)">Land</button><button type="button" data-landmode="erase" title="Paint water">Water</button></span>
          ${opt('Size', 'landSize', '<input type="range" class="land-size" min="0" max="100" step="1" title="Brush size ([ and ])" aria-label="Land brush size">')}
          <button class="brush-chip texture-chip" data-act="textures" title="Land texture" aria-label="Land texture"></button>
        </span>
        <span class="tb-group" data-for="terrain">
          <button class="brush-chip terrain-chip" data-act="terrain-picker" title="Texture to paint" aria-label="Texture to paint"></button>
          ${opt('Size', 'terrainSize', '<input type="range" class="terrain-size" min="0" max="100" step="1" title="Brush size ([ and ])" aria-label="Terrain brush size">')}
          ${opt('Soft', 'terrainSoft', '<input type="range" class="terrain-soft" min="0" max="100" step="1" title="Soft edges" aria-label="Soft edges">')}
          ${opt('Strength', 'terrainOpacity', '<input type="range" class="terrain-opacity" min="10" max="100" step="5" title="Strength: lower lets the land show through" aria-label="Strength">')}
        </span>
        <span class="tb-group" data-for="path">
          <span class="seg path-style">${Object.entries(PATHS).map(([k, [name]]) => `<button type="button" data-pathstyle="${k}">${name}</button>`).join('')}</span>
          ${opt('Width', 'pathWidth', '<input type="range" class="path-width" min="2" max="160" step="1" title="Width ([ and ])" aria-label="Path width">')}
        </span>
        <span class="tb-group" data-for="pen"><span class="swatches">${INKS.map((c) => `<button class="swatch" data-ink="${c}" style="--c:${c}" aria-label="Ink ${c}"></button>`).join('')}
          <input type="color" class="ink-custom" title="Any colour" aria-label="Any colour"></span></span>
        <span class="tb-group" data-for="pen eraser">${opt('Size', 'width', '<input type="range" class="width" min="0" max="100" step="1" title="Size ([ and ])" aria-label="Pen size">')}</span>
        <span class="tb-group" data-for="pen">
          ${opt('Opacity', 'penOpacity', '<input type="range" class="pen-opacity" min="5" max="100" step="5" title="Opacity: lower lets the map show through" aria-label="Opacity">')}
          ${opt('Soft', 'penSoft', '<input type="range" class="pen-soft" min="0" max="100" step="5" title="Soft edges" aria-label="Soft edges">')}
        </span>
        <span class="tb-group" data-for="stamp scatter">
          <button class="brush-chip" data-act="picker" title="Choose art" aria-label="Choose art"></button>
          ${opt('Size', 'stampSize', '<input type="range" class="stamp-size" min="0" max="100" step="1" title="Stamp size ([ and ])" aria-label="Stamp size">')}
          <button class="tool flip stamp-only" data-act="stamp-turn" title="Turn the next stamp 15° (. and , keys; Shift: 45°)" aria-label="Turn the next stamp">${icon('arrow-counter-clockwise')}<b class="badge" data-val="stampRot"></b></button>
          <button class="tool stamp-only" data-act="stamp-flip" title="Flip the next stamp (F)" aria-label="Flip the next stamp" aria-pressed="false">${icon('flip-horizontal')}</button>
          <button class="tool scatter-only" data-act="scatter-settings" title="Scatter settings: spacing, spread, size and rotation" aria-label="Scatter settings">${icon('gear-six')}</button>
        </span>
        <span class="tb-group" data-for="select">
          <span class="tb-note"></span>
          <button class="tool" data-act="duplicate" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${icon('plus-circle')}</button>
          <button class="tool" data-act="edit-text" title="Edit the text (Enter)" aria-label="Edit the text">${icon('pencil-simple')}</button>
          <button class="tool" data-act="adjust" title="Opacity, tint and brightness" aria-label="Adjust">${icon('magic-wand')}</button>
          <button class="tool" data-act="flip" title="Flip (F)" aria-label="Flip">${icon('flip-horizontal')}</button>
          <button class="tool" data-act="front" title="Bring to front (])" aria-label="Bring to front">${icon('arrow-up')}</button>
          <button class="tool" data-act="back" title="Send to back ([)" aria-label="Send to back">${icon('arrow-down')}</button>
          <button class="tool" data-act="delete" title="Delete (Del)" aria-label="Delete">${icon('trash')}</button>
        </span>
        <span class="tb-sep"></span>
        <button class="tool" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('arrow-counter-clockwise')}</button>
        <button class="tool flip" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon('arrow-counter-clockwise')}</button>
        <span class="zoom">
          <button class="tool small" data-act="zoom-out" title="Zoom out (−)" aria-label="Zoom out">${icon('magnifying-glass-minus')}</button>
          <button class="zoom-pct" data-act="zoom-100" title="Zoom to 100%" aria-label="Zoom to 100%">100%</button>
          <button class="tool small" data-act="zoom-in" title="Zoom in (+)" aria-label="Zoom in">${icon('magnifying-glass-plus')}</button>
        </span>
        <button class="tool" data-act="fit" title="Fit the map (0)" aria-label="Fit the map">${icon('corners-out')}</button>
        <button class="tool" data-act="style" title="Map style" aria-label="Map style">${icon('sparkle')}</button>
        <button class="tool" data-act="layers" title="Layers" aria-label="Layers">${icon('stack')}</button>
        <button class="tool" data-act="shortcuts" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">${icon('info')}</button>
      </div>
      <div class="layers-panel side-panel" hidden></div>
      <div class="style-panel side-panel" hidden></div>
      <div class="adjust-panel side-panel" hidden></div>
      <div class="scatter-panel side-panel" hidden></div>
    </div>`;
  const claim = await claimMap(id);
  const ed = new Editor(view.querySelector('.editor'), project, doc);
  ed.claim = claim;
  if (!claim.held) ed.setReadOnly(true);
  // Mid-stroke is no time for the app to reload itself after an update.
  const busy = () => !!ed.gesture || ed.pointers.size > 0;
  state.busy.add(busy);
  // When this window is looked at again, see whether the map has been freed.
  const retake = async () => {
    if (!ed.readOnly || ed.destroyed) return;
    const c = await claimMap(id);
    if (ed.destroyed) { c.release(); return; }
    if (!c.held) return;
    ed.claim = c;
    await ed.setReadOnly(false);
  };
  const onShow = () => { if (document.visibilityState === 'visible') retake(); };
  addEventListener('focus', retake);
  document.addEventListener('visibilitychange', onShow);
  state.cleanup = () => {
    ed.destroy();
    state.busy.delete(busy);
    removeEventListener('focus', retake);
    document.removeEventListener('visibilitychange', onShow);
  };
  state.onRemote = async (e) => {
    const p = store.project(id);
    if (!p) { toast('This map was deleted on another device'); location.hash = '#/'; return; }
    $('#edTitle').textContent = p.name;
    ed.project = p;
    if (e.store === 'docs' && e.id === id) ed.doc = await store.getDoc(id);
    if (e.store === 'assets') { images.retryMissing(); ed.renderPicker(); }
    ed.renderLayers();
    ed.renderStylePanel();
    ed.syncHint();
    ed.redraw();
  };
}

// Stamp sizes run from 16 to 2048 map pixels on a curve, so the slider is
// fine-grained for small stamps and still reaches very large ones.
const sizeFromSlider = (v) => Math.round(16 * Math.pow(128, v / 100));
const sliderFromSize = (s) => Math.round(100 * Math.log(s / 16) / Math.log(128));

// A slider in the options bar, with a small caption and its live value
// (filled in by Editor.showValues).
const opt = (caption, val, input) => `<label class="opt"><span class="opt-cap">${caption} <b data-val="${val}"></b></span>${input}</label>`;

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
    this.penOpacity = load('ac.penOpacity', 1);
    this.penSoft = load('ac.penSoft', 0);
    this.stampSize = load('ac.stampSize', 256);
    // Scatter brush: gap between stamps and how far they stray (both as a
    // share of the stamp size), size variation (±), random turn (share of
    // half a turn), and random mirroring.
    this.scatter = { spacing: 0.6, spread: 0.5, vary: 0.2, rotate: 0, flip: true, ...load('ac.scatter', {}) };
    this.landSize = load('ac.landSize', 256);
    this.landMode = load('ac.landMode', 'add');
    this.pathStyle = load('ac.pathStyle', 'road');
    this.pathWidth = load('ac.pathWidth', 10);
    this.terrainTex = load('ac.terrainTex', null); // null paints the base land back
    this.terrainSize = load('ac.terrainSize', 384);
    this.terrainSoft = load('ac.terrainSoft', 0.6);
    this.terrainOpacity = load('ac.terrainOpacity', 1);
    this.stampRot = 0; this.stampFlip = false; // the next stamp's turn (degrees, clockwise) and mirroring
    this.hintGone = load('ac.hintGone', false); // the empty-map hint was dismissed on this device
    this.pickerMode = 'stamp'; // or 'texture': what the picker is choosing
    this.locked = new Set(load(`ac.locked.${project.id}`, [])); // layers this device won't edit
    this.activeLayer = load(`ac.layer.${project.id}`, null); // layer new things go on; null: each kind's own
    this.brush = load('ac.brush', []).filter((id) => A.asset(id)); // asset ids to stamp with
    this.multi = load('ac.multi', false);
    this.sel = new Set(); // selected stamps and labels
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
    this.destroyed = true;
    this.disposers.forEach((d) => d());
    cancelAnimationFrame(this.raf);
    clearTimeout(this.refreshTimer);
    this.claim?.release();
  }

  // --- one window at a time ---------------------------------------------

  // Read-only: another window is editing this map. The view still moves and
  // zooms; nothing can be drawn or changed. Going back to editable reads the
  // map afresh, since the other window will have changed it.
  async setReadOnly(on) {
    if (on) {
      this.readOnly = true;
      this.tool = 'pan';
      this.sel.clear();
      this.closePanels();
    } else {
      this.doc = await store.refresh(this.project.id);
      this.project = store.project(this.project.id) || this.project;
      await A.loadAssets();
      this.readOnly = false;
      this.undoStack = []; this.redoStack = [];
      this.tool = load('ac.tool', 'pen');
      if (!TOOLS.some(([t]) => t === this.tool)) this.tool = 'pen';
    }
    $('.ro-banner', this.root).hidden = !on;
    const viewOnly = '[data-act^="zoom"], [data-act="fit"], [data-act="shortcuts"], [data-tool="pan"]';
    for (const b of $$('.toolrail button, .toolbar button, .toolbar input', this.root)) b.disabled = on && !b.matches(viewOnly);
    this.syncToolbar();
    this.syncHistory();
    this.syncHint();
    this.redraw();
  }

  // The "can't save" notice stays up until a save works again.
  setSaveError(e) {
    const el = $('.save-banner', this.root);
    el.hidden = !e;
    if (e) el.textContent = `Can’t save changes on this device: ${e.message || e.name || 'unknown error'}`;
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

  landScale() { return editorLandScale(this.project); }

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

  // One frame going wrong (say, a canvas the device can't give us) shouldn't
  // end the drawing: the error is logged once per kind, and the next change
  // starts a fresh frame on a canvas reset to its defaults.
  paint() {
    try {
      this.paintFrame();
      this.paintError = null;
      this.scheduleLandRefresh();
    } catch (e) {
      if (e.message !== this.paintError) console.error('Drawing a frame failed', e);
      this.paintError = e.message;
      this.canvas.width = this.canvas.width; // clears it and drops any half-done state
    }
  }

  // The land layer is patched stroke by stroke, which drifts by a shade now
  // and then; once it has been patched a lot, redraw it in full, but only
  // when you've paused (it takes a moment) and not during a stroke.
  scheduleLandRefresh() {
    if (this.refreshTimer || !landNeedsRefresh(this.project.id)) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const quiet = () => !this.gesture && !this.pointers.size && performance.now() - (this.lastActive || 0) > 1500;
      const go = () => {
        if (this.destroyed) return;
        if (!quiet()) { this.scheduleLandRefresh(); return; }
        refreshLand(this.project.id);
        this.redraw();
      };
      if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 3000 }); else setTimeout(go, 0);
    }, 1600);
  }

  paintFrame() {
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
    drawDoc(ctx, this.project, this.doc, { image: (id) => images.get(id), placeholder: true, landScale: this.landScale() });
    const g = this.gesture;
    if (g?.kind === 'draw') drawStroke(ctx, g.stroke);
    if (g?.kind === 'path') drawPath(ctx, g.stroke, mapStyle(this.doc));
    if (g?.kind === 'textpath' && g.points.length >= 4) {
      ctx.strokeStyle = '#c4553b';
      ctx.lineWidth = 2 / this.s;
      ctx.setLineDash([6 / this.s, 5 / this.s]);
      strokePath(ctx, g.points, 2 / this.s);
      ctx.setLineDash([]);
    }
    // Land being painted shows as plain land or sea; the coast appears when it's done.
    if (g?.kind === 'land') { const st = mapStyle(this.doc); ctx.fillStyle = ctx.strokeStyle = g.stroke.mode === 'erase' ? st.sea : st.land; strokePath(ctx, g.stroke.points, g.stroke.width); }
    if (g?.kind === 'terrain') {
      const img = g.stroke.texture && images.get(g.stroke.texture);
      ctx.fillStyle = ctx.strokeStyle = img ? texturePattern(ctx, img, STYLE) : mapStyle(this.doc).land;
      strokePath(ctx, g.stroke.points, g.stroke.width);
    }
    ctx.restore();
    const sel = this.selectedObjs();
    if (sel.length === 1) this.paintSelection(sel[0]);
    else for (const o of sel) this.paintOutline(o);
    if (g?.kind === 'marquee') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const [ax, ay] = this.toScreen(...g.a), [bx, by] = this.toScreen(...g.b);
      ctx.fillStyle = 'rgba(196, 85, 59, .08)';
      ctx.strokeStyle = '#c4553b';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
    }
    this.paintBrushPreview();
    const zoom = (this.zoomEl ??= $('.zoom-pct', this.root)), pct = `${Math.round(this.s * 100)}%`;
    if (zoom.textContent !== pct) zoom.textContent = pct;
  }

  // What the current brush will paint, at its size: under the mouse, and for
  // a moment in the middle of the view while its size is being changed (so it
  // shows on touch screens too).
  paintBrushPreview() {
    const g = this.gesture;
    if (g?.kind === 'pinch' || g?.kind === 'pan' || this.spaceDown) return;
    const flashing = performance.now() - (this.sizeFlash || 0) < 900;
    const at = flashing && !this.hover ? this.toMap(this.vw / 2, this.vh / 2) : this.hover;
    if (!at) return;
    const tool = this.tool;
    const size = { pen: this.width, eraser: Math.max(this.width, 12 / this.s), land: this.landSize, terrain: this.terrainSize, path: this.pathWidth, stamp: this.stampSize, scatter: this.stampSize }[tool];
    if (!size) return;
    const { ctx, dpr } = this;
    const [mx, my] = at;
    ctx.save();
    ctx.setTransform(this.s * dpr, 0, 0, this.s * dpr, this.x * dpr, this.y * dpr);
    if (tool === 'stamp' || tool === 'scatter') {
      // A ghost of the stamp (the first of the chosen pictures), at size.
      const a = this.brush.map((id) => A.asset(id)).find(Boolean);
      const img = a && images.get(a.id);
      if (img) {
        const k = size / Math.max(a.w, a.h, 1);
        ctx.globalAlpha = 0.55;
        // The stamp tool's ghost is turned and mirrored the way the next stamp will be.
        ctx.translate(mx, my);
        if (tool === 'stamp') { ctx.rotate(this.stampRot * Math.PI / 180); if (this.stampFlip) ctx.scale(-1, 1); }
        ctx.drawImage(img, -(a.w * k) / 2, -(a.h * k) / 2, a.w * k, a.h * k);
        ctx.setTransform(this.s * dpr, 0, 0, this.s * dpr, this.x * dpr, this.y * dpr);
        ctx.globalAlpha = 1;
      }
      if (tool === 'scatter') ring(ctx, mx, my, size * this.scatter.spread + size / 2, this.s, true);
      else if (!img) ring(ctx, mx, my, size / 2, this.s);
    } else {
      // Inside the ring, a faint taste of what it paints.
      ctx.beginPath();
      ctx.arc(mx, my, size / 2, 0, Math.PI * 2);
      const st = mapStyle(this.doc);
      if (tool === 'pen') { ctx.globalAlpha = 0.35 * this.penOpacity; ctx.fillStyle = this.ink; ctx.fill(); }
      else if (tool === 'land') { ctx.globalAlpha = 0.45; ctx.fillStyle = this.landMode === 'erase' ? st.sea : st.land; ctx.fill(); }
      else if (tool === 'terrain') {
        const img = this.terrainTex && images.get(this.terrainTex);
        ctx.globalAlpha = 0.6 * this.terrainOpacity;
        ctx.fillStyle = img ? texturePattern(ctx, img, STYLE) : st.land;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ring(ctx, mx, my, size / 2, this.s);
    }
    ctx.restore();
  }

  // A size was just changed: show it, then let the preview fade with time.
  flashSize() {
    this.sizeFlash = performance.now();
    this.redraw();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.redraw(), 950);
  }

  // A path (or text on a path): its points, to drag, and a small "+" between
  // each pair, to drag out a new point.
  paintNodes(o) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { nodes, mids } = this.nodes(o);
    ctx.strokeStyle = '#c4553b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    nodes.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of mids) {
      ctx.fillStyle = 'rgba(255, 244, 234, .75)';
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 2.5, y); ctx.lineTo(x + 2.5, y); ctx.moveTo(x, y - 2.5); ctx.lineTo(x, y + 2.5); ctx.stroke();
    }
    ctx.fillStyle = '#fff4ea';
    for (const [x, y] of nodes) { ctx.beginPath(); ctx.arc(x, y, HANDLE / 2 + 1, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }

  // Screen positions of a path's points, and of the midpoints between them.
  nodes(o) {
    const p = o[ptsKey(o)];
    const nodes = [];
    for (let i = 0; i < p.length; i += 2) nodes.push(this.toScreen(p[i], p[i + 1]));
    const mids = nodes.slice(1).map((b, i) => [(nodes[i][0] + b[0]) / 2, (nodes[i][1] + b[1]) / 2]);
    return { nodes, mids };
  }

  // Just the dashed box, for each item of a multiple selection.
  paintOutline(o) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = this.corners(o).map((p) => this.toScreen(...p));
    ctx.strokeStyle = '#c4553b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Selection outline with corner handles (scale) and a handle above (rotate).
  paintSelection(o) {
    if (ptsKey(o)) { this.paintNodes(o); return; }
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

  // The selection, minus anything deleted meanwhile (here or on another device).
  selectedObjs() {
    const out = [];
    for (const id of this.sel) {
      const o = this.doc.objects[id];
      if (o && !o.deleted) out.push(o); else this.sel.delete(id);
    }
    return out;
  }

  // The selected object when exactly one is selected.
  selectedObj() { const l = this.selectedObjs(); return l.length === 1 ? l[0] : null; }

  select(ids) { this.sel = new Set(ids); }

  selectable() { return store.liveObjects(this.doc).filter((o) => SELECTABLE.includes(o.kind) && this.editable(this.lay(o))); }

  // Stamps and labels can be selected and transformed; this is their box.
  box(o) {
    if (o.kind === 'path') {
      const b = pointsBox(o.points), r = o.width / 2;
      return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, w: b[2] - b[0] + 2 * r, h: b[3] - b[1] + 2 * r, rot: 0 };
    }
    return o.kind === 'label' ? labelBox(o) : { cx: o.x, cy: o.y, w: o.w, h: o.h, rot: o.rot || 0 };
  }

  // Map-space corners of an object's box: top-left, top-right, bottom-right, bottom-left.
  corners(o) {
    const b = this.box(o);
    const cos = Math.cos(b.rot), sin = Math.sin(b.rot);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const lx = sx * b.w / 2, ly = sy * b.h / 2;
      return [b.cx + lx * cos - ly * sin, b.cy + lx * sin + ly * cos];
    });
  }

  // Screen position of the rotate handle, a fixed distance above the top edge.
  rotHandle(o) {
    const b = this.box(o);
    const [cx, cy] = this.toScreen(b.cx, b.cy);
    const d = (b.h / 2) * this.s + ROT_OFFSET;
    const a = b.rot - Math.PI / 2;
    return [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
  }

  inBox(o, mx, my, pad = 0) {
    const b = this.box(o);
    const cos = Math.cos(-b.rot), sin = Math.sin(-b.rot);
    const dx = mx - b.cx, dy = my - b.cy;
    const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
    return Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad;
  }

  // The topmost stamp or label under a map point.
  objectAt(mx, my, kinds = SELECTABLE) {
    // Whatever draws on top is found first: labels, then by layer, then z.
    const pos = new Map(this.layers().map((l, i, a) => [l.id, a.length - i]));
    const rank = (o) => (o.kind === 'label' ? 1e15 : 0) + (pos.get(this.lay(o)) || 0) * 1e12 + (o.z || 0);
    const list = store.liveObjects(this.doc).filter((o) => kinds.includes(o.kind) && this.editable(this.lay(o))).sort((a, b) => rank(b) - rank(a));
    return list.find((o) => this.hitTest(o, mx, my)) || null;
  }

  // Is (mx, my) on this object? Paths and text on paths by their line;
  // everything else by its box.
  hitTest(o, mx, my) {
    const slack = 6 / this.s;
    if (o.kind === 'path') return nearLine(o.points, mx, my, o.width / 2 + slack);
    if (o.kind === 'label' && o.along) {
      const line = samplePath(o.along, 8 / this.s).flat();
      return nearLine(line, mx, my, o.size * 0.6 + slack);
    }
    return this.inBox(o, mx, my);
  }

  // A new stamp from the brush (a random pick when it holds several), its
  // longer side `size` map pixels.
  newStamp(mx, my, size, { flip = false, rot = 0 } = {}) {
    const ids = this.brush.filter((id) => A.asset(id));
    if (!ids.length) return null;
    const a = A.asset(ids[Math.floor(Math.random() * ids.length)]);
    const k = size / Math.max(a.w, a.h, 1);
    return {
      id: uid(), kind: 'stamp', asset: a.id, ...this.layerField(),
      x: r1(mx), y: r1(my), w: r1(a.w * k), h: r1(a.h * k), rot: Math.round(rot * 1000) / 1000, flip,
    };
  }

  // --- editing ----------------------------------------------------------

  async apply(objs) {
    if (this.readOnly) return;
    try {
      await store.putObjects(this.project.id, objs);
      this.setSaveError(null);
    } catch (e) {
      // What's on screen is kept, and saved with the next change that works.
      console.error('Saving failed', e);
      this.setSaveError(e);
    }
    this.syncHint();
    this.redraw();
  }

  async commit(entry) {
    if (this.readOnly) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.syncHistory();
    await this.apply(entry.redo.map((o) => ({ ...o })));
  }

  async undo() {
    if (this.readOnly) return;
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.syncHistory();
    await this.apply(e.undo.map((o) => ({ ...o })));
  }

  async redo() {
    if (this.readOnly) return;
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.syncHistory();
    await this.apply(e.redo.map((o) => ({ ...o })));
  }

  zRange() {
    let lo = 0, hi = 0;
    for (const o of Object.values(this.doc.objects)) if (!o.deleted) { lo = Math.min(lo, o.z || 0); hi = Math.max(hi, o.z || 0); }
    return [lo, hi];
  }
  nextZ() { return this.zRange()[1] + 1; }

  // Change everything selected (one undo step). patch: fields, or
  // (object, index) → fields.
  editSelected(patch) {
    const objs = this.selectedObjs().sort((a, b) => (a.z || 0) - (b.z || 0));
    if (!objs.length) return;
    this.commit({ undo: objs.map(clean), redo: objs.map((o, i) => ({ ...clean(o), ...(typeof patch === 'function' ? patch(o, i) : patch) })) });
  }

  // Layer order keeps the selection's own order among itself.
  toFront() { const z = this.nextZ(); this.editSelected((o, i) => ({ z: z + i })); }
  toBack() { const objs = this.selectedObjs(); const z = this.zRange()[0] - objs.length; this.editSelected((o, i) => ({ z: z + i })); }
  flipSelected() { this.editSelected((o) => (o.kind === 'stamp' ? { flip: !o.flip } : {})); }

  deleteSelected() {
    const objs = this.selectedObjs();
    if (!objs.length) return;
    this.sel.clear();
    this.commit({ undo: objs.map(clean), redo: objs.map((o) => ({ id: o.id, deleted: true })) });
    this.syncToolbar();
  }

  removeNode(o, i) {
    const key = ptsKey(o), p = o[key].slice();
    if (p.length <= 4) { toast('A line needs at least two points'); return; }
    p.splice(2 * i, 2);
    this.commit({ undo: [clean(o)], redo: [{ ...clean(o), [key]: p, ...(key === 'along' ? { x: p[0], y: p[1] } : {}) }] });
  }

  copySelected() {
    const objs = this.selectedObjs();
    if (!objs.length) return false;
    clipboard = objs.sort((a, b) => (a.z || 0) - (b.z || 0)).map(clean);
    return true;
  }

  // Add copies of objs, moved by (dx, dy), on top, and select them.
  async addCopies(objs, dx, dy) {
    const z = this.nextZ();
    const copies = objs.map((o, i) => ({ ...o, ...shifted(o, dx, dy), id: uid(), z: z + i }));
    this.select(copies.map((o) => o.id));
    if (this.tool !== 'select') this.setTool('select');
    await this.commit({ undo: copies.map((o) => ({ id: o.id, deleted: true })), redo: copies });
    this.syncToolbar();
  }

  duplicateSelected() {
    const objs = this.selectedObjs().sort((a, b) => (a.z || 0) - (b.z || 0)).map(clean);
    if (objs.length) this.addCopies(objs, 30 / this.s, 30 / this.s);
  }

  // Paste in the middle of the view (from this map or another).
  paste() {
    if (!clipboard?.length) return;
    const xs = clipboard.map((o) => o.x), ys = clipboard.map((o) => o.y);
    const [cx, cy] = this.toMap(this.vw / 2, this.vh / 2);
    this.addCopies(clipboard, cx - (Math.min(...xs) + Math.max(...xs)) / 2, cy - (Math.min(...ys) + Math.max(...ys)) / 2);
  }

  // Strokes and stamps under a point, within the eraser's radius (map pixels).
  hits([mx, my], radius) {
    const out = [];
    for (const o of store.liveObjects(this.doc)) {
      if (!this.editable(this.lay(o))) continue;
      if (o.kind === 'stamp' || o.kind === 'label') { if (this.inBox(o, mx, my, radius)) out.push(o); continue; }
      if (o.kind !== 'stroke' && o.kind !== 'path') continue;
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
    if (t !== 'select') this.sel.clear();
    if ((t === 'stamp' || t === 'scatter') && !this.brush.length) this.openPicker();
    this.syncToolbar();
    this.redraw();
  }

  syncToolbar() {
    const panning = this.tool === 'pan' || this.spaceDown;
    for (const b of $$('[data-tool]', this.root)) b.classList.toggle('on', b.dataset.tool === this.tool);
    for (const b of $$('[data-ink]', this.root)) b.classList.toggle('on', b.dataset.ink === this.ink);
    for (const g of $$('.tb-group', this.root)) g.hidden = !g.dataset.for.split(' ').includes(this.tool);
    $('.tb-name', this.root).textContent = TOOLS.find(([t]) => t === this.tool)[3];
    $('.width', this.root).value = penSlider(this.width);
    $('.pen-opacity', this.root).value = Math.round(this.penOpacity * 100);
    $('.pen-soft', this.root).value = Math.round(this.penSoft * 100);
    $('.ink-custom', this.root).value = this.ink;
    $('.ink-custom', this.root).classList.toggle('on', !INKS.includes(this.ink));
    $('.stamp-size', this.root).value = sliderFromSize(this.stampSize);
    $('.land-size', this.root).value = sliderFromSize(this.landSize);
    $('.terrain-size', this.root).value = sliderFromSize(this.terrainSize);
    $('.path-width', this.root).value = this.pathWidth;
    for (const b of $$('[data-pathstyle]', this.root)) b.classList.toggle('on', b.dataset.pathstyle === this.pathStyle);
    $('.terrain-soft', this.root).value = Math.round(this.terrainSoft * 100);
    $('.terrain-opacity', this.root).value = Math.round(this.terrainOpacity * 100);
    for (const b of $$('[data-landmode]', this.root)) b.classList.toggle('on', b.dataset.landmode === this.landMode);
    const all = this.selectedObjs(), sel = all.length === 1 ? all[0] : null;
    // With nothing selected there's nothing to press: a hint takes the buttons' place.
    for (const b of $$('[data-for="select"] button', this.root)) b.hidden = !all.length;
    const note = $('.tb-note', this.root);
    note.hidden = all.length === 1;
    note.textContent = all.length ? `${all.length} selected` : matchMedia('(pointer: coarse)').matches ? 'Tap a stamp, label or path' : 'Click a stamp, label or path · drag to select several';
    $('[data-act="edit-text"]', this.root).hidden = sel?.kind !== 'label';
    $('[data-act="flip"]', this.root).hidden = !all.some((o) => o.kind === 'stamp');
    $('.scatter-only', this.root).hidden = this.tool !== 'scatter';
    for (const b of $$('.stamp-only', this.root)) b.hidden = this.tool !== 'stamp';
    $('[data-act="stamp-flip"]', this.root).classList.toggle('on', this.stampFlip);
    $('[data-act="stamp-flip"]', this.root).setAttribute('aria-pressed', this.stampFlip);
    this.showValues();
    this.syncHistory();
    const adjustable = all.some((o) => o.kind === 'stamp' || o.kind === 'path');
    $('[data-act="adjust"]', this.root).hidden = !adjustable;
    if (!adjustable) $('.adjust-panel', this.root).hidden = true;
    else this.renderAdjust();
    this.canvas.style.cursor = panning ? (this.gesture?.kind === 'pan' ? 'grabbing' : 'grab') : this.tool === 'select' ? 'default' : 'crosshair';
    this.renderChip();
  }

  // The numbers beside the options bar's sliders.
  showValues() {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const v = {
      landSize: this.landSize, terrainSize: this.terrainSize, terrainSoft: pct(this.terrainSoft), terrainOpacity: pct(this.terrainOpacity),
      pathWidth: this.pathWidth, width: this.width, penOpacity: pct(this.penOpacity), penSoft: pct(this.penSoft), stampSize: this.stampSize,
      stampRot: this.stampRot ? `${this.stampRot}°` : '',
    };
    for (const b of $$('[data-val]', this.root)) b.textContent = v[b.dataset.val];
  }

  // Undo and redo are only there to press when there's something to do.
  syncHistory() {
    $('[data-act="undo"]', this.root).disabled = !this.undoStack.length;
    $('[data-act="redo"]', this.root).disabled = !this.redoStack.length;
  }

  // A new map shows a hint until anything is drawn on it, or it's dismissed.
  syncHint() {
    const el = $('.map-hint', this.root);
    const empty = !store.liveObjects(this.doc).some((o) => o.kind !== 'style');
    el.hidden = !empty || this.hintGone;
    if (!el.hidden) $('.hint-text', el).textContent = matchMedia('(pointer: coarse)').matches
      ? 'Start with Land to paint the coast, or Stamp to place art'
      : 'Start with Land (L) to paint the coast, or Stamp (S) to place art · ? for shortcuts';
  }

  // Turn the next stamp by deg (clockwise), within one full turn.
  turnStamp(deg) { this.stampRot = (((this.stampRot + deg) % 360) + 360) % 360; this.syncToolbar(); this.redraw(); }
  flipStamp() { this.stampFlip = !this.stampFlip; this.syncToolbar(); this.redraw(); }

  async renderChip() {
    const chip = $('[data-act="picker"]', this.root);
    if (!chip) return;
    const ids = this.brush.filter((id) => A.asset(id));
    const url = ids.length && await A.thumbURL(ids[0]);
    chip.innerHTML = url ? `<img src="${url}" alt="">${ids.length > 1 ? `<span class="chip-count">${ids.length}</span>` : ''}` : icon('plus');
    const tex = docStyle(this.doc).landTexture;
    const turl = tex && A.asset(tex) && await A.thumbURL(tex);
    $('.texture-chip', this.root).innerHTML = turl ? `<img src="${turl}" alt="">` : '<span class="chip-plain"></span>';
    const gurl = this.terrainTex && A.asset(this.terrainTex) && await A.thumbURL(this.terrainTex);
    $('.terrain-chip', this.root).innerHTML = gurl ? `<img src="${gurl}" alt="">` : '<span class="chip-plain" title="Base land"></span>';
  }

  openPicker(mode = 'stamp') {
    this.pickerMode = mode;
    this.closePanels();
    $('.picker', this.root).hidden = false;
    this.renderPicker();
  }

  closePanels() {
    for (const p of $$('.picker, .side-panel', this.root)) p.hidden = true;
    this.hidePreview();
  }

  togglePanel(cls, render) {
    const p = $(cls, this.root);
    const open = p.hidden;
    this.closePanels();
    p.hidden = !open;
    if (open) render();
  }

  setTerrainTex(id) {
    this.terrainTex = id;
    keep('ac.terrainTex', id);
    if (this.tool !== 'terrain') this.setTool('terrain');
    this.renderChip();
  }

  togglePicker(mode) {
    const p = $('.picker', this.root);
    if (!p.hidden && this.pickerMode === mode) p.hidden = true;
    else this.openPicker(mode);
  }

  // Land texture: a document-wide setting, kept in the 'style' object so it
  // syncs (and undoes) like any other change.
  setLandTexture(id) {
    this.setStyle({ landTexture: id }).then(() => this.renderChip());
  }

  setStyle(patch) {
    const old = this.doc.objects.style;
    const base = old && !old.deleted ? clean(old) : { id: 'style', kind: 'style' };
    return this.commit({ undo: [old && !old.deleted ? clean(old) : { id: 'style', deleted: true }], redo: [{ ...base, ...patch }] });
  }

  // --- layers -----------------------------------------------------------

  hidden() { return new Set(docStyle(this.doc).hidden || []); }
  editable(kind) { return !this.hidden().has(kind) && !this.locked.has(kind); }

  setHidden(kind, hide) {
    const h = this.hidden();
    if (hide) h.add(kind); else h.delete(kind);
    if (hide) for (const o of this.selectedObjs()) if (this.lay(o) === kind) this.sel.delete(o.id);
    return this.setStyle({ hidden: [...h] }).then(() => { this.renderLayers(); this.syncToolbar(); });
  }

  setLocked(kind, lock) {
    if (lock) this.locked.add(kind); else this.locked.delete(kind);
    keep(`ac.locked.${this.project.id}`, [...this.locked]);
    if (lock) for (const o of this.selectedObjs()) if (this.lay(o) === kind) this.sel.delete(o.id);
    this.renderLayers(); this.syncToolbar(); this.redraw();
  }

  lay(o) { return layerResolver(this.doc)(o); }
  layers() { return docLayers(this.doc); }
  layerName(id) { return (id === 'land' ? LAND_LAYER : this.layers().find((l) => l.id === id))?.name || 'that'; }

  // The layer the current drawing tool puts things on.
  active() { return this.activeLayer && this.layers().some((l) => l.id === this.activeLayer) ? this.activeLayer : null; }
  toolLayer() {
    const kind = TOOL_LAYER[this.tool];
    return !kind ? null : kind === 'land' ? 'land' : this.active() || kind;
  }
  // Fields for a new object: its layer, when one is chosen.
  layerField() { return this.active() ? { layer: this.active() } : {}; }

  // Before drawing on a layer: show it if hidden; refuse if locked.
  readyLayer(id) {
    const name = this.layerName(id);
    if (this.locked.has(id)) { toast(`The ${name} layer is locked`); return false; }
    if (this.hidden().has(id)) { this.setHidden(id, false); toast(`Showing the ${name} layer`); }
    return true;
  }

  setActiveLayer(id) {
    this.activeLayer = id;
    keep(`ac.layer.${this.project.id}`, id);
    this.renderLayers();
  }

  // Layer list changes, as one undo step with any objects they move.
  saveLayers(layers, objs = []) {
    const old = this.doc.objects.style;
    const base = old && !old.deleted ? clean(old) : { id: 'style', kind: 'style' };
    return this.commit({
      undo: [old && !old.deleted ? clean(old) : { id: 'style', deleted: true }, ...objs.map(clean)],
      redo: [{ ...base, layers }, ...objs.map((o) => ({ ...clean(o), layer: null }))],
    }).then(() => { this.renderLayers(); this.syncToolbar(); });
  }

  async addLayer() {
    const name = await askName('New layer', '');
    if (!name) return;
    const id = uid();
    // New layers go on top, and become the one you draw on.
    await this.saveLayers([{ id, name }, ...this.layers()]);
    this.setActiveLayer(id);
  }

  async layerMenu(id) {
    const list = this.layers();
    const i = list.findIndex((l) => l.id === id);
    const l = list[i];
    const builtin = BUILTIN_LAYERS.some((b) => b.id === id);
    const n = this.selectedObjs().length;
    const act = await modal(l.name, `<form class="form">
        <label>Name<input name="name" maxlength="60" value="${esc(l.name)}"></label>
        <div class="actions left">
          <button type="button" class="btn small" data-a="up" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up')} Up</button>
          <button type="button" class="btn small" data-a="down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('arrow-down')} Down</button>
          ${n ? `<button type="button" class="btn small" data-a="move">Move the ${n} selected here</button>` : ''}
        </div>
        ${builtin ? '' : '<p class="muted small">Deleting a layer keeps what’s on it: each thing goes back to its usual layer.</p>'}
        <div class="actions">${builtin ? '' : '<button type="button" class="btn danger" data-a="delete">Delete layer</button><span class="spacer"></span>'}
          <button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Save</button></div>
      </form>`, {
      onMount: (m, close) => {
        $('[data-cancel]', m).onclick = () => close(null);
        m.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b && !b.disabled) close({ a: b.dataset.a, name: $('input', m).value.trim() }); });
        $('form', m).onsubmit = (e) => { e.preventDefault(); close({ a: 'save', name: e.target.name.value.trim() }); };
      },
    });
    if (!act) return;
    const renamed = list.map((x) => (x.id === id && act.name ? { ...x, name: act.name } : x));
    if (act.a === 'save') return this.saveLayers(renamed);
    if (act.a === 'up' || act.a === 'down') {
      const j = act.a === 'up' ? i - 1 : i + 1;
      [renamed[i], renamed[j]] = [renamed[j], renamed[i]];
      return this.saveLayers(renamed);
    }
    if (act.a === 'move') return this.editSelected({ layer: id });
    if (act.a === 'delete') {
      if (this.activeLayer === id) this.setActiveLayer(null);
      const on = store.liveObjects(this.doc).filter((o) => o.layer === id);
      return this.saveLayers(renamed.filter((x) => x.id !== id), on);
    }
  }

  // Opacity, tint and brightness of the selected stamps (shown as the first's).
  // Settings for what's selected: stamps' opacity, tint and brightness;
  // paths' style and width. Shows the first one's values.
  renderAdjust() {
    const el = $('.adjust-panel', this.root);
    if (!el || el.hidden) return;
    const all = this.selectedObjs();
    const stamps = all.filter((o) => o.kind === 'stamp'), paths = all.filter((o) => o.kind === 'path');
    if (!stamps.length && !paths.length) return;
    // Don't redraw under a slider that's being dragged.
    if (el.contains(document.activeElement) && document.activeElement.type === 'range') return;
    const o = stamps[0], q = paths[0];
    const title = all.length > 1 ? `${all.length} selected` : o ? 'Stamp' : 'Path';
    el.innerHTML = `<header><b>${title}</b><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="style-body">
        ${o ? `${paths.length ? '<div class="field-label">Stamps</div>' : ''}
        <label>Opacity<input type="range" name="opacity" min="0.1" max="1" step="0.05" value="${o.opacity ?? 1}"></label>
        <label class="inline">Tint <input type="color" name="tint" value="${o.tint || '#7a9a5a'}"></label>
        <label>Tint strength<input type="range" name="tintAmt" min="0" max="1" step="0.05" value="${o.tintAmt || 0}"></label>
        <label>Brightness<input type="range" name="bright" min="-1" max="1" step="0.05" value="${o.bright || 0}"></label>
        <button class="btn small quiet" data-reset>Reset</button>` : ''}
        ${q ? `${stamps.length ? '<div class="field-label">Paths</div>' : ''}
        <label class="inline">Style <select name="pathStyle">${Object.entries(PATHS).map(([k, [name]]) => `<option value="${k}" ${q.style === k ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <label>Width<input type="range" name="pathWidth" min="2" max="160" step="1" value="${q.width}"></label>
        <p class="muted small">Drag a point to move it, drag a + to add one, Alt-click or double-click a point to remove it.</p>` : ''}
      </div>`;
    $('[data-close]', el).onclick = () => { el.hidden = true; };
    const toStamps = (patch) => this.editSelected((x) => (x.kind === 'stamp' ? patch : {}));
    const toPaths = (patch) => this.editSelected((x) => (x.kind === 'path' ? patch : {}));
    el.onchange = (e) => {
      const t = e.target;
      if (!t.name) return;
      const v = t.type === 'range' ? +t.value : t.value;
      if (t.name === 'pathStyle') return toPaths({ style: v });
      if (t.name === 'pathWidth') return toPaths({ width: v });
      // Choosing a tint colour with no strength yet gives it some, so it shows.
      toStamps(t.name === 'tint' && !(o.tintAmt > 0) ? { tint: v, tintAmt: 0.5 } : { [t.name]: v });
    };
    $('[data-reset]', el)?.addEventListener('click', () => toStamps({ opacity: 1, tintAmt: 0, bright: 0 }));
  }

  // Scatter brush settings (this device's, like the other brush settings).
  renderScatter() {
    const el = $('.scatter-panel', this.root);
    if (!el || el.hidden) return;
    const sc = this.scatter;
    el.innerHTML = `<header><b>Scatter</b><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="style-body">
        <label>Spacing <small>sparse to dense</small><input type="range" name="spacing" min="0.15" max="2" step="0.05" value="${2.15 - sc.spacing}"></label>
        <label>Spread <small>how far from the line</small><input type="range" name="spread" min="0" max="2" step="0.05" value="${sc.spread}"></label>
        <label>Size variation<input type="range" name="vary" min="0" max="0.6" step="0.05" value="${sc.vary}"></label>
        <label>Random rotation<input type="range" name="rotate" min="0" max="1" step="0.05" value="${sc.rotate}"></label>
        <label class="check"><input type="checkbox" name="flip" ${sc.flip ? 'checked' : ''}> Mirror some at random</label>
        <button class="btn small quiet" data-reset>Reset</button>
      </div>`;
    $('[data-close]', el).onclick = () => { el.hidden = true; };
    el.oninput = (e) => {
      const t = e.target;
      if (!t.name) return;
      // The spacing slider runs from sparse (left) to dense (right).
      sc[t.name] = t.type === 'checkbox' ? t.checked : t.name === 'spacing' ? Math.round((2.15 - +t.value) * 100) / 100 : +t.value;
      keep('ac.scatter', sc);
    };
    $('[data-reset]', el).onclick = () => { this.scatter = { spacing: 0.6, spread: 0.5, vary: 0.2, rotate: 0, flip: true }; keep('ac.scatter', this.scatter); this.renderScatter(); };
  }

  // Map style: colours and coast, saved with the map (and undoable).
  renderStylePanel() {
    const el = $('.style-panel', this.root);
    if (!el || el.hidden) return;
    const st = mapStyle(this.doc);
    el.innerHTML = `<header><b>Map style</b><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="style-body">
        <label class="inline">A blank map is <select name="surface">${[['sea', 'Sea'], ['ground', 'Land'], ...(st.surface ? [] : [['', 'Paper']])].map(([v, n]) => `<option value="${v}" ${(st.surface || '') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="inline">Sea <input type="color" name="sea" value="${st.sea}"></label>
        <label class="inline">Land <input type="color" name="land" value="${st.land}"></label>
        <label class="inline">Coastline <input type="color" name="coast" value="${st.coast}"></label>
        <label>Coastline width<input type="range" name="coastWidth" min="0" max="24" step="1" value="${st.coastWidth}"></label>
        <label>Coast roughness <small>smooth to rugged</small><input type="range" name="coastRough" min="0" max="1" step="0.05" value="${st.coastRough}"></label>
        <label class="inline">Shore <select name="coastStyle">${[['ripples', 'Ripples'], ['hatch', 'Hatching'], ['plain', 'Plain']].map(([v, n]) => `<option value="${v}" ${st.coastStyle === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${st.coastStyle === 'ripples' ? `<label>Ripples in the sea<input type="range" name="rippleCount" min="1" max="6" step="1" value="${st.rippleCount}"></label>` : ''}
        <label class="check"><input type="checkbox" name="stampShadow" ${st.stampShadow ? 'checked' : ''}> Shadows under stamps</label>
        <div class="field-label">Finishing</div>
        <label class="inline">Grid <select name="grid">${[['none', 'None'], ['square', 'Squares'], ['hex', 'Hexes']].map(([v, n]) => `<option value="${v}" ${st.grid === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${st.grid !== 'none' ? `<label>Grid size<input type="range" name="gridSize" min="32" max="768" step="8" value="${st.gridSize}"></label>
        <label>Grid strength<input type="range" name="gridOpacity" min="0.05" max="0.8" step="0.05" value="${st.gridOpacity}"></label>` : ''}
        <label>Darker edges<input type="range" name="vignette" min="0" max="1" step="0.05" value="${st.vignette}"></label>
        <label class="inline">Frame <select name="frame">${[['none', 'None'], ['line', 'Line'], ['double', 'Double line']].map(([v, n]) => `<option value="${v}" ${st.frame === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="inline-row"><span>Paper</span><button type="button" class="btn small" data-paper>${st.overlay ? 'Change…' : 'Choose…'}</button></div>
        <label class="inline">Scale bar <select name="scaleBar">${[['none', 'None'], ['left', 'Bottom left'], ['right', 'Bottom right']].map(([v, n]) => `<option value="${v}" ${st.scaleBar === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        ${st.scaleBar !== 'none' ? `<label>Distance it shows<input name="scaleText" maxlength="30" value="${esc(st.scaleText)}"></label>
        <label>Bar length<input type="range" name="scaleLength" min="0.05" max="0.5" step="0.01" value="${st.scaleLength}"></label>` : ''}
        ${st.overlay ? `<label>Paper strength<input type="range" name="overlayOpacity" min="0.05" max="1" step="0.05" value="${st.overlayOpacity}"></label>` : ''}
        <button class="btn small quiet" data-reset>Reset to the defaults</button>
      </div>`;
    $('[data-close]', el).onclick = () => { el.hidden = true; };
    // 'change' rather than 'input': one undo step per adjustment, not per pixel of a drag.
    el.onchange = (e) => {
      const t = e.target;
      if (!t.name) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
      this.setStyle({ [t.name]: v }).then(() => { if (['grid', 'coastStyle', 'scaleBar'].includes(t.name)) this.renderStylePanel(); });
    };
    $('[data-paper]', el).onclick = () => this.openPicker('overlay');
    $('[data-reset]', el).onclick = () => this.setStyle({
      sea: null, land: null, coast: null, coastWidth: null, coastRough: null, rippleCount: null, stampShadow: null,
      grid: null, gridSize: null, gridOpacity: null, vignette: null, frame: null, overlay: null, overlayOpacity: null,
      coastStyle: null, scaleBar: null, scaleText: null, scaleLength: null,
    }).then(() => this.renderStylePanel());
  }

  renderLayers() {
    const el = $('.layers-panel', this.root);
    if (!el || el.hidden) return;
    const h = this.hidden();
    const active = this.active();
    const row = (l, pickable) => `<div class="layer-row${h.has(l.id) ? ' off' : ''}${pickable && active === l.id ? ' active' : ''}">
        ${pickable ? `<button class="layer-name" data-pick="${l.id}" title="Draw on this layer">${esc(l.name)}</button>` : `<span class="layer-name">${esc(l.name)}</span>`}
        <button class="icon-btn" data-eye="${l.id}" title="${h.has(l.id) ? 'Show' : 'Hide (also in exports)'}" aria-pressed="${!h.has(l.id)}">${icon(h.has(l.id) ? 'eye-slash' : 'eye')}</button>
        <button class="icon-btn${this.locked.has(l.id) ? ' on' : ''}" data-lock="${l.id}" title="${this.locked.has(l.id) ? 'Unlock' : 'Lock: can’t be selected or erased (this device)'}" aria-pressed="${this.locked.has(l.id)}">${icon('lock-simple')}</button>
        ${pickable ? `<button class="icon-btn" data-menu="${l.id}" title="Rename, reorder, move things here" aria-label="Layer options">${icon('dots-three-vertical')}</button>` : '<span class="icon-gap"></span>'}
      </div>`;
    el.innerHTML = `<header><b>Layers</b><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="layer-row auto${active ? '' : ' active'}"><button class="layer-name" data-pick="">Automatic <small>each kind on its own layer</small></button></div>
      ${this.layers().map((l) => row(l, true)).join('')}
      ${row(LAND_LAYER, false)}
      <div class="pk-actions"><button class="btn small" data-add>${icon('plus')} New layer</button></div>`;
    $('[data-close]', el).onclick = () => { el.hidden = true; };
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.eye) this.setHidden(b.dataset.eye, !h.has(b.dataset.eye));
      else if (b.dataset.lock) this.setLocked(b.dataset.lock, !this.locked.has(b.dataset.lock));
      else if (b.dataset.pick != null) this.setActiveLayer(b.dataset.pick || null);
      else if (b.dataset.menu) this.layerMenu(b.dataset.menu);
      else if ('add' in b.dataset) this.addLayer();
    };
  }

  // The art picker, laid out like the library: each pack a section, each
  // category a header with a strip of previews that opens into its full grid;
  // recently used art first; a search shows its matches grouped the same way.
  // A click uses that picture; Ctrl (or Cmd) click, or "Pick several", adds
  // and removes pictures, and the stamp and scatter tools choose among them.
  renderPicker() {
    const el = $('.picker', this.root);
    if (!el || el.hidden) return;
    // Modes: 'stamp' (the stamp brush), 'texture' (the land's base fill),
    // 'terrain' (the texture the terrain tool paints), 'overlay' (paper).
    const mode = this.pickerMode;
    const tex = mode !== 'stamp';
    const kind = tex ? 'texture' : 'stamp';
    const title = { stamp: 'Stamps', texture: 'Land texture', terrain: 'Terrain', overlay: 'Paper' }[mode];
    const plainLabel = { terrain: 'Base land', overlay: 'No paper' }[mode] || 'Plain land';
    const packs = A.packs().map((p) => ({ ...p, categories: p.categories.filter((c) => c.kind === kind) })).filter((p) => p.categories.length);
    const closeBtn = `<button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>`;
    if (!packs.length) {
      el.innerHTML = `<header><b>${title}</b>${closeBtn}</header>
        <p class="muted pad">No ${tex ? 'textures' : 'stamps'} yet. Import art in the <a href="#/library">Art library</a>${tex ? ', and mark a category as Textures there' : ''}.</p>
        ${tex ? `<div class="pk-actions"><button class="btn small" data-plain>${plainLabel}</button></div>` : ''}`;
      this.wirePicker(el, mode);
      return;
    }
    // This kind of map's own packs first, then packs for any map, then the rest.
    const mt = this.project.type || 'any';
    const rank = (p) => (p.type === mt && mt !== 'any' ? 0 : p.type === 'any' ? 1 : 2);
    packs.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const order = new Map(packs.map((p, i) => [p.name, i]));
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    const open = this.pickOpen(kind);
    const query = (this.pickQuery || '').trim().toLowerCase();
    const tile = (a, cls = '') => {
      const url = A.cachedThumbURL(a.id);
      return `<button class="tile${cls}" data-id="${a.id}" aria-label="${esc(a.name)}">${url ? `<img src="${url}" alt="" draggable="false">` : icon('image')}</button>`;
    };
    const grid = (list) => `<div class="pk-grid">${list.map((a) => tile(a)).join('')}</div>`;
    const catHead = (key, label, count, isOpen, all = true) => `<div class="pk-cat-head" data-toggle="${esc(key)}">
        <span class="pk-caret">${icon(isOpen ? 'caret-down' : 'caret-right')}</span><span class="pk-cat-name">${esc(label)}</span><span class="muted small">${count}</span>
        ${all && !tex ? `<button class="btn small quiet" data-all="${esc(key)}" title="Stamp with any of these">Use all</button>` : ''}</div>`;
    let body = '';
    this.pickLists = new Map(); // section key → its assets, for "Use all"
    if (query) {
      const words = query.split(/\s+/);
      const hits = A.liveAssets().filter((a) => a.kind === kind && order.has(a.pack)
        && words.every((w) => `${a.name} ${a.category} ${a.pack}`.toLowerCase().includes(w)))
        .sort((a, b) => order.get(a.pack) - order.get(b.pack) || a.category.localeCompare(b.category) || byName(a, b)).slice(0, 300);
      const groups = new Map();
      for (const a of hits) {
        const key = `${a.pack}${SEP}${a.category}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      }
      body = `<p class="muted small pk-found">${hits.length === 300 ? 'First 300 matches' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}</p>`
        + [...groups].map(([key, list]) => { this.pickLists.set(key, list); const [pk, ct] = key.split(SEP); return `<section class="pk-section">${catHead(key, `${pk} · ${ct || 'General'}`, list.length, true)}${grid(list)}</section>`; }).join('');
    } else {
      const rec = recent(kind).map((id) => A.asset(id)).filter((a) => a && a.kind === kind).slice(0, 24);
      if (rec.length) {
        this.pickLists.set(RECENT, rec);
        const isOpen = !open.has(`${RECENT}:closed`);
        body += `<section class="pk-section">${catHead(RECENT, 'Recently used', rec.length, isOpen)}${isOpen ? grid(rec) : ''}</section>`;
      }
      for (const p of packs) {
        const packOpen = !open.has(`${p.name}:closed`);
        body += `<section class="pk-pack-section"><div class="pk-pack-head" data-toggle="${esc(p.name)}:closed">
            <span class="pk-caret">${icon(packOpen ? 'caret-down' : 'caret-right')}</span><b>${esc(p.name)}</b>
            ${rank(p) === 2 ? `<span class="muted small">${esc(A.PACK_TYPES.find(([v]) => v === p.type)?.[1] || '')}</span>` : ''}</div>`;
        if (packOpen) {
          for (const c of p.categories) {
            const key = `${p.name}${SEP}${c.name}`;
            const list = A.liveAssets().filter((a) => a.pack === p.name && a.category === c.name).sort(byName);
            this.pickLists.set(key, list);
            const isOpen = open.has(key);
            // Closed, a category shows a strip of its first pictures.
            body += `<section class="pk-section">${catHead(key, c.name || 'General', list.length, isOpen)}
              ${isOpen ? grid(list) : `<div class="pk-strip">${list.slice(0, 6).map((a) => tile(a, ' mini')).join('')}${list.length > 6 ? `<button class="pk-more" data-toggle="${esc(key)}">+${list.length - 6}</button>` : ''}</div>`}</section>`;
          }
        }
        body += '</section>';
      }
    }
    const scroll = $('.pk-browse', el)?.scrollTop || 0;
    el.innerHTML = `<header><b>${title}</b>
        ${tex ? '' : `<label class="check small" title="Or hold Ctrl (Cmd on a Mac) while clicking"><input type="checkbox" class="pk-multi" ${this.multi ? 'checked' : ''}> Pick several</label>`}
        ${closeBtn}</header>
      <div class="pk-filters"><input type="search" class="pk-search" placeholder="Search all art…" value="${esc(this.pickQuery || '')}" aria-label="Search art"></div>
      <div class="pk-actions">${tex ? `<button class="btn small" data-plain>${plainLabel}</button>`
        : `<span class="muted small pk-count"></span><button class="btn small quiet" data-clear>Clear</button>`}</div>
      <div class="pk-browse">${body || '<p class="muted small pad">Nothing matches.</p>'}</div>`;
    $('.pk-browse', el).scrollTop = scroll;
    this.wirePicker(el, mode);
    this.markPicker();
  }

  // Which sections are open (or, for packs and recents, closed), per device.
  pickOpen(kind) {
    this.pickOpenSets ??= {};
    return (this.pickOpenSets[kind] ??= new Set(load(`ac.pickOpen.${kind}`, [])));
  }

  // Show what's chosen, without redrawing the picker (no flicker).
  markPicker() {
    const el = $('.picker', this.root);
    if (!el || el.hidden) return;
    const mode = this.pickerMode;
    const chosen = new Set(mode === 'texture' ? [docStyle(this.doc).landTexture] : mode === 'terrain' ? [this.terrainTex] : mode === 'overlay' ? [docStyle(this.doc).overlay] : this.brush);
    for (const t of $$('.tile', el)) t.classList.toggle('on', chosen.has(t.dataset.id));
    const count = $('.pk-count', el);
    if (count) count.textContent = this.brush.length ? `${this.brush.length} chosen${this.brush.length > 1 ? ', placed at random' : ''}` : 'Click a picture to use it';
    $('[data-plain]', el)?.classList.toggle('on', mode === 'terrain' && !this.terrainTex);
  }

  wirePicker(el, mode) {
    const tex = mode !== 'stamp', kind = tex ? 'texture' : 'stamp';
    const pick = (id) => {
      if (mode === 'terrain') this.setTerrainTex(id);
      else if (mode === 'overlay') this.setStyle({ overlay: id });
      else this.setLandTexture(id);
    };
    $('[data-close]', el).onclick = () => { el.hidden = true; };
    this.wirePreview(el);
    $('.pk-multi', el)?.addEventListener('change', (e) => { this.multi = e.target.checked; keep('ac.multi', this.multi); });
    $('[data-plain]', el)?.addEventListener('click', () => { pick(null); this.markPicker(); });
    $('[data-clear]', el)?.addEventListener('click', () => this.setBrush([]));
    const search = $('.pk-search', el);
    if (search) {
      let typing;
      search.oninput = () => {
        clearTimeout(typing);
        typing = setTimeout(() => {
          const at = search.selectionStart;
          this.pickQuery = search.value;
          this.renderPicker();
          // Keep typing where you were.
          const again = $('.pk-search', el);
          again.focus();
          again.setSelectionRange(at, at);
        }, 180);
      };
    }
    $('.pk-browse', el)?.addEventListener('click', (e) => {
      const all = e.target.closest('[data-all]');
      if (all) { e.stopPropagation(); this.setBrush((this.pickLists.get(all.dataset.all) || []).map((a) => a.id)); return; }
      const t = e.target.closest('.tile');
      if (t) {
        const id = t.dataset.id;
        if (tex) { pick(id); useRecent('texture', [id]); this.markPicker(); return; }
        // Ctrl / Cmd click (or "Pick several") adds or removes; a plain click picks just this one.
        const add = this.multi || e.ctrlKey || e.metaKey;
        if (add) this.setBrush(this.brush.includes(id) ? this.brush.filter((x) => x !== id) : [...this.brush, id]);
        else this.setBrush([id]);
        if (this.tool !== 'stamp' && this.tool !== 'scatter') this.setTool('stamp');
        // On small screens the picker covers the map: close it after a single pick.
        if (!add && matchMedia('(max-width: 600px)').matches) el.hidden = true;
        return;
      }
      const head = e.target.closest('[data-toggle]');
      if (head) {
        const key = head.dataset.toggle, open = this.pickOpen(kind);
        const k = key === RECENT ? `${RECENT}:closed` : key;
        if (open.has(k)) open.delete(k); else open.add(k);
        keep(`ac.pickOpen.${kind}`, [...open]);
        this.renderPicker();
      }
    });
    // Thumbnails not loaded yet arrive as they scroll into view.
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) {
        io.unobserve(en.target);
        A.thumbURL(en.target.dataset.id).then((url) => { if (url) en.target.innerHTML = `<img src="${url}" alt="" draggable="false">`; });
      }
    }, { root: el, rootMargin: '300px' });
    for (const t of $$('.tile:not(:has(img))', el)) io.observe(t);
  }

  setBrush(ids) {
    this.brush = ids;
    keep('ac.brush', ids);
    this.markPicker();
    this.syncToolbar();
  }

  // --- labels -----------------------------------------------------------

  async newLabel(mx, my, along = null) {
    const base = {
      font: 'serif', color: INKS[0], spacing: 0.12, curve: 0, caps: false, halo: true,
      size: Math.round(Math.max(this.project.width, this.project.height) / 40),
      ...load('ac.labelStyle', {}),
    };
    const v = await labelDialog({ ...base, text: '', ...(along ? { along, curve: 0 } : {}) }, along ? 'Text along a line' : 'New label');
    if (!v?.text) return;
    const o = { id: uid(), kind: 'label', x: r1(mx), y: r1(my), rot: 0, z: this.nextZ(), ...this.layerField(), ...v, ...(along ? { along } : {}) };
    this.rememberStyle(v);
    this.select([o.id]);
    if (this.tool !== 'text') this.setTool('select');
    await this.commit({ undo: [{ id: o.id, deleted: true }], redo: [o] });
    this.syncToolbar();
  }

  async editLabel(o) {
    if (!o) return;
    const v = await labelDialog(clean(o), 'Edit label');
    if (!v) return;
    if (!v.text) { this.select([o.id]); this.deleteSelected(); return; }
    this.rememberStyle(v);
    this.select([o.id]);
    await this.commit({ undo: [clean(o)], redo: [{ ...clean(o), ...v }] });
    this.syncToolbar();
  }

  // The next new label starts in the style of the last one made or edited.
  rememberStyle({ text, ...style }) { keep('ac.labelStyle', style); }

  // --- hints ----------------------------------------------------------------

  // A tool's name and key beside the rail at once, rather than after the
  // browser's slow tooltip. Mouse only: a touch has no hover.
  wireTips() {
    const rail = $('.toolrail', this.root), tip = $('.tool-tip', this.root);
    const hide = () => { tip.hidden = true; };
    this.on(rail, 'pointerover', (e) => {
      const b = e.pointerType === 'mouse' && e.target.closest('[data-tool]');
      if (!b) { hide(); return; }
      tip.innerHTML = `${esc(b.dataset.name)} <kbd>${esc(b.dataset.key)}</kbd>`;
      // To the right of a rail that stands at the side, above one along the bottom.
      const side = getComputedStyle(rail).flexDirection === 'column';
      const r = b.getBoundingClientRect(), o = this.root.getBoundingClientRect();
      tip.classList.toggle('above', !side);
      tip.style.left = `${(side ? r.right + 8 : r.left + r.width / 2) - o.left}px`;
      tip.style.top = `${(side ? r.top + r.height / 2 : r.top - 8) - o.top}px`;
      tip.hidden = false;
    });
    this.on(rail, 'pointerleave', hide);
    this.on(rail, 'pointerdown', hide);
  }

  // Hovering a picture in the picker (mouse only) shows it larger, with its
  // name, beside the picker. Only the preview is touched, never the picker's
  // own markup, so choosing a picture can't make the thumbnails reload.
  hidePreview() {
    clearTimeout(this.pvTimer);
    this.pvTile = null;
    $('.pk-preview', this.root).hidden = true;
  }

  wirePreview(el) {
    const tip = $('.pk-preview', this.root);
    this.hidePreview();
    el.onpointerover = (e) => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target.closest('.tile');
      if (!t) { this.hidePreview(); return; }
      if (t === this.pvTile) return;
      this.pvTile = t;
      clearTimeout(this.pvTimer);
      // Once one is showing, the next follows quickly.
      this.pvTimer = setTimeout(() => this.showPreview(t), tip.hidden ? 300 : 90);
    };
    el.onpointerleave = () => this.hidePreview();
    el.onpointerdown = () => this.hidePreview();
    $('.pk-browse', el)?.addEventListener('scroll', () => this.hidePreview());
  }

  async showPreview(t) {
    const a = A.asset(t.dataset.id);
    const url = a && (A.cachedThumbURL(a.id) || await A.thumbURL(a.id));
    if (!url || this.pvTile !== t || !t.isConnected) return;
    const tip = $('.pk-preview', this.root);
    tip.innerHTML = `<span class="pv-pic"><img src="${url}" alt=""></span><b>${esc(a.name)}</b><small>${esc(a.pack)}${a.category ? ` · ${esc(a.category)}` : ''}</small>`;
    const o = this.root.getBoundingClientRect(), p = $('.picker', this.root).getBoundingClientRect(), r = t.getBoundingClientRect();
    tip.hidden = false;
    tip.style.right = `${o.right - p.left + 8}px`;
    tip.style.top = `${Math.max(8, Math.min(r.top - o.top + r.height / 2 - tip.offsetHeight / 2, o.height - tip.offsetHeight - 8))}px`;
  }

  // --- input ------------------------------------------------------------

  wire() {
    const onBar = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool);
      if (b.dataset.ink) { this.ink = b.dataset.ink; keep('ac.ink', this.ink); this.syncToolbar(); }
      if (b.dataset.pathstyle) { this.pathStyle = b.dataset.pathstyle; keep('ac.pathStyle', this.pathStyle); this.syncToolbar(); }
      if (b.dataset.landmode) { this.landMode = b.dataset.landmode; keep('ac.landMode', this.landMode); this.syncToolbar(); }
      const act = b.dataset.act;
      if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
      else if (act === 'fit') this.fit();
      else if (act === 'zoom-in') this.zoomAt(this.vw / 2, this.vh / 2, 1.25);
      else if (act === 'zoom-out') this.zoomAt(this.vw / 2, this.vh / 2, 0.8);
      else if (act === 'zoom-100') this.zoomAt(this.vw / 2, this.vh / 2, 1 / this.s);
      else if (act === 'stamp-turn') this.turnStamp(e.shiftKey ? 45 : 15);
      else if (act === 'stamp-flip') this.flipStamp();
      else if (act === 'picker') this.togglePicker('stamp');
      else if (act === 'textures') this.togglePicker('texture');
      else if (act === 'flip') this.flipSelected();
      else if (act === 'front') this.toFront();
      else if (act === 'back') this.toBack();
      else if (act === 'duplicate') this.duplicateSelected();
      else if (act === 'delete') this.deleteSelected();
      else if (act === 'edit-text') this.editLabel(this.selectedObj());
      else if (act === 'shortcuts') showShortcuts();
      else if (act === 'layers') this.togglePanel('.layers-panel', () => this.renderLayers());
      else if (act === 'style') this.togglePanel('.style-panel', () => this.renderStylePanel());
      else if (act === 'adjust') this.togglePanel('.adjust-panel', () => this.renderAdjust());
      else if (act === 'terrain-picker') this.togglePicker('terrain');
      else if (act === 'scatter-settings') this.togglePanel('.scatter-panel', () => this.renderScatter());
    };
    $('.toolbar', this.root).onclick = onBar;
    $('.toolrail', this.root).onclick = onBar;
    // Slider handlers set the value first; this then updates the numbers beside them.
    $('.toolbar', this.root).addEventListener('input', () => this.showValues());
    $('[data-hint-close]', this.root).onclick = () => { this.hintGone = true; keep('ac.hintGone', true); this.syncHint(); };
    this.wireTips();
    $('.width', this.root).oninput = (e) => { this.flashSize(); this.width = penWidth(+e.target.value); keep('ac.width', this.width); };
    $('.pen-opacity', this.root).oninput = (e) => { this.penOpacity = +e.target.value / 100; keep('ac.penOpacity', this.penOpacity); };
    $('.pen-soft', this.root).oninput = (e) => { this.penSoft = +e.target.value / 100; keep('ac.penSoft', this.penSoft); };
    $('.ink-custom', this.root).oninput = (e) => { this.ink = e.target.value; keep('ac.ink', this.ink); this.syncToolbar(); };
    $('.stamp-size', this.root).oninput = (e) => { this.flashSize(); this.stampSize = sizeFromSlider(+e.target.value); keep('ac.stampSize', this.stampSize); };
    $('.land-size', this.root).oninput = (e) => { this.flashSize(); this.landSize = sizeFromSlider(+e.target.value); keep('ac.landSize', this.landSize); };
    $('.path-width', this.root).oninput = (e) => { this.flashSize(); this.pathWidth = +e.target.value; keep('ac.pathWidth', this.pathWidth); };
    $('.terrain-size', this.root).oninput = (e) => { this.flashSize(); this.terrainSize = sizeFromSlider(+e.target.value); keep('ac.terrainSize', this.terrainSize); };
    $('.terrain-soft', this.root).oninput = (e) => { this.terrainSoft = +e.target.value / 100; keep('ac.terrainSoft', this.terrainSoft); };
    $('.terrain-opacity', this.root).oninput = (e) => { this.terrainOpacity = +e.target.value / 100; keep('ac.terrainOpacity', this.terrainOpacity); };
    this.syncToolbar();
    this.syncHint();

    const c = this.canvas;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
    this.disposers.push(() => this.ro.disconnect());

    this.on(c, 'pointerdown', (e) => this.down(e));
    this.on(c, 'pointermove', (e) => {
      // The mouse's position, for the brush preview (touch has no hover).
      if (e.pointerType === 'mouse') { this.hover = this.toMap(...this.local(e)); if (!this.pointers.size) this.redraw(); }
      this.move(e);
    });
    this.on(c, 'pointerleave', () => { this.hover = null; this.redraw(); });
    this.on(c, 'pointerup', (e) => this.up(e));
    this.on(c, 'pointercancel', (e) => this.up(e, true));
    this.on(c, 'contextmenu', (e) => e.preventDefault());
    this.on(c, 'dblclick', (e) => {
      if (this.tool !== 'select') return;
      const pt = this.local(e), sel = this.selectedObj();
      // Double-clicking a point of a selected path removes it.
      if (sel && ptsKey(sel)) {
        const i = this.nodes(sel).nodes.findIndex((q) => Math.hypot(pt[0] - q[0], pt[1] - q[1]) <= HANDLE);
        if (i >= 0) { this.removeNode(sel, i); return; }
      }
      const hit = this.objectAt(...this.toMap(...pt), ['label']);
      if (hit) this.editLabel(hit);
    });
    // Labels measure their letters, so draw again once the fonts have loaded.
    Promise.all(Object.keys(FONTS).map((k) => document.fonts.load(fontCSS(k, 40)))).then(() => this.redraw(), () => {});
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
    // Read-only: only the keys that move the view.
    if (this.readOnly && (mod || ![' ', '?', '0', '+', '=', '-'].includes(k))) return;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && k === 'c') { if (this.copySelected()) e.preventDefault(); return; }
    if (mod && k === 'x') { if (this.copySelected()) { e.preventDefault(); this.deleteSelected(); } return; }
    if (mod && k === 'v') { if (clipboard?.length) { e.preventDefault(); this.paste(); } return; }
    if (mod && k === 'd') { e.preventDefault(); this.duplicateSelected(); return; }
    if (mod && k === 'a') { e.preventDefault(); this.select(this.selectable().map((o) => o.id)); if (this.tool !== 'select') this.setTool('select'); this.syncToolbar(); this.redraw(); return; }
    // Everything saves as you go; don't let the browser offer to save the page.
    if (mod && k === 's') { e.preventDefault(); toast('Saved: every change is kept as you make it'); return; }
    if (mod) return;
    if (e.key === ' ') {
      e.preventDefault();
      // Space pans; it mustn't also press whichever toolbar button has focus.
      if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
      if (!this.spaceDown) { this.spaceDown = true; this.syncToolbar(); }
      return;
    }
    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
    const any = this.selectedObjs().length > 0, sel = this.selectedObj();
    if (any && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); this.deleteSelected(); return; }
    if (sel?.kind === 'label' && e.key === 'Enter') { e.preventDefault(); this.editLabel(sel); return; }
    // Arrows nudge the selection: a screen pixel, or ten with Shift.
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (any && nudge) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / this.s;
      const objs = this.selectedObjs();
      this.commit({ undo: objs.map(clean), redo: objs.map((o) => ({ ...clean(o), ...shifted(o, nudge[0] * step, nudge[1] * step) })) });
      return;
    }
    // Escape first drops whatever is half done (a stroke, a box, a move).
    if (e.key === 'Escape' && this.gesture && this.gesture.kind !== 'pinch') { this.restore(this.gesture); this.gesture = null; this.pointers.clear(); this.syncToolbar(); this.redraw(); return; }
    if (e.key === 'Escape') { this.sel.clear(); this.closePanels(); this.syncToolbar(); this.redraw(); return; }
    if (KEYS[k]) this.setTool(KEYS[k]);
    else if (k === '0') this.fit();
    else if (k === '+' || k === '=') this.zoomAt(this.vw / 2, this.vh / 2, 1.25);
    else if (k === '-') this.zoomAt(this.vw / 2, this.vh / 2, 0.8);
    else if (any && k === 'f') this.flipSelected();
    // With nothing selected, the stamp tool's F and , . set up the next stamp (by key position, so Shift still works).
    else if (this.tool === 'stamp' && k === 'f') this.flipStamp();
    else if (this.tool === 'stamp' && (e.code === 'Comma' || e.code === 'Period')) this.turnStamp((e.code === 'Comma' ? -1 : 1) * (e.shiftKey ? 45 : 15));
    else if (any && k === ']') this.toFront();
    else if (any && k === '[') this.toBack();
    else if (k === '[' || k === ']') {
      const up = k === ']';
      if (this.tool === 'stamp' || this.tool === 'scatter') {
        this.stampSize = Math.max(16, Math.min(2048, Math.round(this.stampSize * (up ? 1.15 : 1 / 1.15))));
        keep('ac.stampSize', this.stampSize);
      } else if (this.tool === 'land') {
        this.landSize = Math.max(16, Math.min(2048, Math.round(this.landSize * (up ? 1.15 : 1 / 1.15))));
        keep('ac.landSize', this.landSize);
      } else if (this.tool === 'path') {
        this.pathWidth = Math.max(2, Math.min(160, Math.round(this.pathWidth * (up ? 1.2 : 1 / 1.2))));
        keep('ac.pathWidth', this.pathWidth);
      } else if (this.tool === 'terrain') {
        this.terrainSize = Math.max(16, Math.min(2048, Math.round(this.terrainSize * (up ? 1.15 : 1 / 1.15))));
        keep('ac.terrainSize', this.terrainSize);
      } else {
        this.width = Math.max(2, Math.min(800, Math.round(this.width * (up ? 1.2 : 1 / 1.2))));
        keep('ac.width', this.width);
      }
      this.syncToolbar();
      this.flashSize();
    }
  }

  down(e) {
    this.lastActive = performance.now();
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
    const panning = this.readOnly || this.tool === 'pan' || this.spaceDown || e.button === 1 || e.button === 2;
    if (!panning && this.toolLayer() && !this.readyLayer(this.toolLayer())) { this.pointers.delete(e.pointerId); return; }
    if (panning) this.gesture = { kind: 'pan', last: pt };
    else if (this.tool === 'land') {
      // Alt (Option) paints the other way, for quick fixes along a coast.
      const mode = e.altKey ? (this.landMode === 'add' ? 'erase' : 'add') : this.landMode;
      this.gesture = { kind: 'land', stroke: { id: uid(), kind: 'land', mode, width: this.landSize, points: [r1(mx), r1(my)] } };
    } else if (this.tool === 'path') {
      this.gesture = { kind: 'path', stroke: { id: uid(), kind: 'path', ...this.layerField(), style: this.pathStyle, width: this.pathWidth, points: [r1(mx), r1(my)] } };
    } else if (this.tool === 'terrain') {
      this.gesture = { kind: 'terrain', stroke: { id: uid(), kind: 'terrain', texture: this.terrainTex, width: this.terrainSize, soft: this.terrainSoft, opacity: this.terrainOpacity, points: [r1(mx), r1(my)] } };
    } else if (this.tool === 'text') {
      const hit = this.objectAt(mx, my, ['label']);
      if (hit) { this.editLabel(hit); return; }
      this.gesture = { kind: 'textpath', points: [r1(mx), r1(my)] };
    } else if (this.tool === 'pen') {
      this.gesture = { kind: 'draw', stroke: { id: uid(), kind: 'stroke', ...this.layerField(), color: this.ink, width: this.width, ...(this.penOpacity < 1 ? { opacity: this.penOpacity } : {}), ...(this.penSoft > 0 ? { soft: this.penSoft } : {}), points: [r1(mx), r1(my)] } };
    } else if (this.tool === 'eraser') {
      this.gesture = { kind: 'erase', erased: new Map() };
      this.eraseAt(pt);
    } else if (this.tool === 'select') {
      this.gesture = this.selectGesture(pt, mx, my, e) || { kind: 'pan', last: pt };
    } else if (this.tool === 'stamp') {
      const o = this.newStamp(mx, my, this.stampSize, { flip: this.stampFlip, rot: this.stampRot * Math.PI / 180 });
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

  // Grab a handle of the selected item, an item under the pointer (Shift adds
  // or removes it), or start a selection box on empty map. On touch screens
  // a drag on empty map moves the view instead, as everywhere else.
  selectGesture(pt, mx, my, e) {
    const sel = this.selectedObj();
    if (sel && ptsKey(sel)) {
      const key = ptsKey(sel), { nodes, mids } = this.nodes(sel);
      const near = (q) => Math.hypot(pt[0] - q[0], pt[1] - q[1]) <= HANDLE;
      const i = nodes.findIndex(near);
      if (i >= 0) {
        // Alt-click removes a point (a line keeps at least two).
        if (e.altKey) { this.removeNode(sel, i); return { kind: 'noop' }; }
        return { kind: 'node', id: sel.id, key, i, orig: clean(sel) };
      }
      const j = mids.findIndex(near);
      if (j >= 0) {
        const p = sel[key].slice();
        p.splice(2 * (j + 1), 0, r1(mx), r1(my));
        this.doc.objects[sel.id] = { ...sel, [key]: p };
        return { kind: 'node', id: sel.id, key, i: j + 1, orig: clean(sel), moved: true };
      }
    }
    if (sel && !ptsKey(sel)) {
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
    const hit = this.objectAt(mx, my);
    if (hit && e.shiftKey) {
      if (this.sel.has(hit.id)) this.sel.delete(hit.id); else this.sel.add(hit.id);
      return { kind: 'noop' };
    }
    if (hit) {
      if (!this.sel.has(hit.id)) this.select([hit.id]);
      return { kind: 'move', origs: this.selectedObjs().map(clean), from: [mx, my] };
    }
    if (e.pointerType === 'touch') { this.sel.clear(); return null; }
    if (!e.shiftKey) this.sel.clear();
    return { kind: 'marquee', a: [mx, my], b: [mx, my], base: new Set(this.sel) };
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
    } else if (g.kind === 'draw' || g.kind === 'land' || g.kind === 'terrain' || g.kind === 'path') {
      const p = g.stroke.points;
      // Skip points closer than ~1.5 screen pixels (and, for wide land
      // brushes, a twentieth of the brush): invisible, and they bloat the file.
      const gap = Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]);
      if (gap * this.s < (g.kind === 'path' ? 4 : 1.5) || ((g.kind === 'land' || g.kind === 'terrain') && gap < g.stroke.width / 20)) return;
      p.push(r1(mx), r1(my));
    } else if (g.kind === 'erase') {
      this.eraseAt(pt);
    } else if (g.kind === 'place') {
      const o = g.orig;
      this.doc.objects[g.id] = { ...this.doc.objects[g.id], x: r1(o.x + mx - g.from[0]), y: r1(o.y + my - g.from[1]) };
    } else if (g.kind === 'move') {
      for (const o of g.origs) this.doc.objects[o.id] = { ...this.doc.objects[o.id], ...shifted(o, mx - g.from[0], my - g.from[1]) };
      g.moved = true;
    } else if (g.kind === 'marquee') {
      g.b = [mx, my];
      const [x0, x1] = [Math.min(g.a[0], mx), Math.max(g.a[0], mx)], [y0, y1] = [Math.min(g.a[1], my), Math.max(g.a[1], my)];
      const inside = this.selectable().filter((o) => { const b = this.box(o); return b.cx >= x0 && b.cx <= x1 && b.cy >= y0 && b.cy <= y1; });
      this.select([...g.base, ...inside.map((o) => o.id)]);
    } else if (g.kind === 'scale') {
      const o = g.orig;
      const k = Math.hypot(mx - o.x, my - o.y) / g.d0;
      this.doc.objects[g.id] = o.kind === 'label'
        ? { ...this.doc.objects[g.id], size: r1(Math.max(4, o.size * k)) }
        : { ...this.doc.objects[g.id], ...((s) => ({ w: r1(o.w * s), h: r1(o.h * s) }))(Math.max(4 / Math.max(o.w, o.h), k)) };
      g.moved = true;
    } else if (g.kind === 'rotate') {
      let rot = (g.orig.rot || 0) + Math.atan2(my - g.orig.y, mx - g.orig.x) - g.a0;
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      this.doc.objects[g.id] = { ...this.doc.objects[g.id], rot: Math.round(rot * 1000) / 1000 };
      g.moved = true;
    } else if (g.kind === 'scatter') {
      this.scatterAt(mx, my);
    } else if (g.kind === 'node') {
      const cur = this.doc.objects[g.id], p = cur[g.key].slice();
      p[2 * g.i] = r1(mx); p[2 * g.i + 1] = r1(my);
      this.doc.objects[g.id] = { ...cur, [g.key]: p, ...(g.key === 'along' ? { x: r1(p[0]), y: r1(p[1]) } : {}) };
      g.moved = true;
    } else if (g.kind === 'textpath') {
      const p = g.points;
      if (Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]) * this.s >= 4) p.push(r1(mx), r1(my));
    }
    this.redraw();
  }

  up(e, cancelled = false) {
    this.lastActive = performance.now();
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size === 0) this.gesture = null;
      return;
    }
    this.gesture = null;
    if (cancelled && g.kind !== 'erase') { this.restore(g); this.syncToolbar(); this.redraw(); return; }
    if (g.kind === 'draw' || g.kind === 'land' || g.kind === 'terrain' || (g.kind === 'path' && g.stroke.points.length >= 4)) {
      const stroke = { ...g.stroke, z: this.nextZ() };
      // Paths keep only the points that shape them, so they're easy to edit.
      if (g.kind === 'path') stroke.points = simplify(stroke.points, Math.max(1, 1.5 / this.s));
      this.commit({ undo: [{ id: stroke.id, deleted: true }], redo: [stroke] });
    } else if (g.kind === 'erase' && g.erased.size) {
      const gone = [...g.erased.values()];
      for (const o of gone) this.sel.delete(o.id);
      this.commit({ undo: gone.map(clean), redo: gone.map((o) => ({ id: o.id, deleted: true })) });
    } else if (g.kind === 'place') {
      const o = clean(this.doc.objects[g.id]);
      useRecent('stamp', [o.asset]);
      this.commit({ undo: [{ id: o.id, deleted: true }], redo: [o] });
    } else if (g.kind === 'move' && g.moved) {
      this.commit({ undo: g.origs, redo: g.origs.map((o) => clean(this.doc.objects[o.id])) });
    } else if (g.kind === 'node' && g.moved) {
      this.commit({ undo: [g.orig], redo: [clean(this.doc.objects[g.id])] });
    } else if (g.kind === 'textpath') {
      // A click places an ordinary label; a drag, text along what was drawn.
      const p = g.points, len = p.length / 2;
      let L = 0;
      for (let i = 1; i < len; i++) L += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
      if (L * this.s < 24) this.newLabel(p[0], p[1]);
      else this.newLabel(p[0], p[1], simplify(p, 2.5 / this.s));
    } else if ((g.kind === 'scale' || g.kind === 'rotate') && g.moved) {
      this.commit({ undo: [g.orig], redo: [clean(this.doc.objects[g.id])] });
    } else if (g.kind === 'scatter' && g.placed.length) {
      // Stamps lower on the map overlap the ones behind them, like a landscape.
      const z0 = this.nextZ();
      useRecent('stamp', [...new Set(g.placed.map((id) => this.doc.objects[id].asset))]);
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
    else if (g.kind === 'erase') for (const o of g.erased.values()) this.doc.objects[o.id] = o;
    else if (g.kind === 'move') for (const o of g.origs) this.doc.objects[o.id] = { ...this.doc.objects[o.id], ...o };
    else if (g.kind === 'scale' || g.kind === 'rotate' || g.kind === 'node') this.doc.objects[g.id] = { ...this.doc.objects[g.id], ...g.orig };
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
    const g = this.gesture, sc = this.scatter;
    const spacing = this.stampSize * sc.spacing;
    if (g.last && Math.hypot(mx - g.last[0], my - g.last[1]) < spacing) return;
    g.last = [mx, my];
    const r = this.stampSize * sc.spread;
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    const o = this.newStamp(mx + Math.cos(a) * d, my + Math.sin(a) * d, this.stampSize * (1 + (Math.random() * 2 - 1) * sc.vary), {
      flip: sc.flip && Math.random() < 0.5,
      rot: (Math.random() * 2 - 1) * sc.rotate * Math.PI,
    });
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

// Copied stamps and labels, for pasting into this map or another.
let clipboard = null;

// An object as stored, without sync bookkeeping (for undo and redo entries).
const clean = ({ updatedAt, deleted, ...o }) => o;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// The label editor: text and style, with a live preview.
function labelDialog(o, title) {
  const swatches = [...INKS, '#ffffff'];
  return modal(title, `<form class="form label-form">
      <label>Text<input name="text" maxlength="200" value="${esc(o.text)}" placeholder="The Sunken Reach" autocomplete="off"></label>
      <canvas class="label-preview" width="560" height="150"></canvas>
      <div class="row">
        <label>Font<select name="font">${Object.entries(FONTS).map(([k, [name]]) => `<option value="${k}" ${k === o.font ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <label>Size <small>map pixels</small><input name="size" type="number" min="4" max="2000" step="1" value="${Math.round(o.size)}"></label>
      </div>
      <div class="field-label">Colour</div>
      <div class="swatches label-swatches">${swatches.map((c) => `<button type="button" class="swatch${c === o.color ? ' on' : ''}" data-c="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
      <label ${o.along ? 'hidden' : ''}>Curve <small>bend up or down</small><input name="curve" type="range" min="-100" max="100" step="1" value="${Math.round((o.curve || 0) * 100)}"></label>
      <label>Letter spacing<input name="spacing" type="range" min="0" max="100" step="1" value="${Math.round((o.spacing || 0) * 100)}"></label>
      <label class="check"><input type="checkbox" name="caps" ${o.caps ? 'checked' : ''}> Capitals</label>
      <label class="check"><input type="checkbox" name="halo" ${o.halo ? 'checked' : ''}> Soft outline, to stand out over busy art</label>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Done</button></div>
    </form>`, {
    onMount: (m, close) => {
      const f = $('form', m);
      let color = o.color || INKS[0];
      const read = () => ({
        text: f.text.value.trim(), font: f.font.value, size: Math.max(4, +f.size.value || o.size), color,
        curve: +f.curve.value / 100, spacing: +f.spacing.value / 100, caps: f.caps.checked, halo: f.halo.checked,
      });
      const cv = $('.label-preview', m);
      const draw = () => {
        const v = read();
        const ctx = cv.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = STYLE.land;
        ctx.fillRect(0, 0, cv.width, cv.height);
        const p = { ...v, text: v.text || 'Preview', x: 0, y: 0, rot: 0 };
        const b = labelBox(p);
        const k = Math.min(1, (cv.width - 40) / b.w, (cv.height - 20) / b.h) || 1;
        ctx.setTransform(k, 0, 0, k, cv.width / 2 - (b.cx * k), cv.height / 2 - (b.cy * k));
        drawLabel(ctx, p);
      };
      f.addEventListener('input', draw);
      $('.label-swatches', m).onclick = (e) => {
        const b = e.target.closest('.swatch');
        if (!b) return;
        color = b.dataset.c;
        for (const x of $('.label-swatches', m).children) x.classList.toggle('on', x === b);
        draw();
      };
      $('[data-cancel]', m).onclick = () => close(null);
      f.onsubmit = (e) => { e.preventDefault(); close(read()); };
      document.fonts.ready.then(draw);
      draw();
    },
  });
}

function askName(title, value) {
  return modal(title, `<form class="form"><label>Name<input name="name" maxlength="60" value="${esc(value)}" required></label>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Done</button></div></form>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(null);
      $('form', m).onsubmit = (e) => { e.preventDefault(); close(e.target.name.value.trim() || null); };
    },
  });
}

// Things the select tool can pick up.
const SELECTABLE = ['stamp', 'label', 'path'];

// Which field holds an object's editable points, if it has them.
const ptsKey = (o) => (o.kind === 'path' ? 'points' : o.kind === 'label' && o.along ? 'along' : null);

// The fields that change when an object moves by (dx, dy).
function shifted(o, dx, dy) {
  const move = (p) => p.map((v, i) => r1(v + (i % 2 ? dy : dx)));
  if (o.kind === 'path') return { points: move(o.points) };
  return { x: r1(o.x + dx), y: r1(o.y + dy), ...(o.along ? { along: move(o.along) } : {}) };
}

// Is (x, y) within r of the polyline p?
function nearLine(p, x, y, r) {
  if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y) <= r;
  for (let i = 0; i < p.length - 2; i += 2) if (segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) return true;
  return false;
}

// Art used recently on this device, newest first, for the picker.
const RECENT = ' recent'; // pack names are trimmed, so none starts with a space
const SEP = '\u241f'; // between a pack's name and a category's, in section keys
const recent = (kind) => load(`ac.recent.${kind}`, []);
function useRecent(kind, ids) {
  keep(`ac.recent.${kind}`, [...ids, ...recent(kind).filter((x) => !ids.includes(x))].slice(0, 60));
}

// Pen sizes from 2 to 800 map pixels on a curve: fine lines and broad washes.
const penWidth = (v) => Math.round(2 * Math.pow(400, v / 100));
const penSlider = (w) => Math.round(100 * Math.log(Math.max(2, w) / 2) / Math.log(400));

// A two-tone ring (dark and light, so it shows on any map), a fixed width on
// screen whatever the zoom; dashed for the scatter brush's reach.
function ring(ctx, x, y, r, scale, dashed = false) {
  ctx.lineWidth = 3 / scale;
  ctx.strokeStyle = 'rgba(255, 244, 234, .8)';
  ctx.setLineDash(dashed ? [6 / scale, 5 / scale] : []);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.2 / scale;
  ctx.strokeStyle = 'rgba(43, 33, 24, .9)';
  ctx.stroke();
  ctx.setLineDash([]);
}

// Every shortcut, for the ? list (and kept in step with the README's table).
export const SHORTCUTS = [
  ['Tools', [['H, or hold Space', 'Move the view'], ['V', 'Select'], ['L', 'Land and water'], ['G', 'Terrain'], ['P', 'Paths'], ['T', 'Text'],
    ['B', 'Pen and colour brush'], ['E', 'Eraser'], ['S', 'Stamp'], ['R', 'Scatter']]],
  ['While painting', [['[  ]', 'Smaller / larger brush or stamp'], ['Alt (hold)', 'Land ↔ water'], ['Shift (rotating)', 'Turn in 15° steps'],
    [',  .', 'Turn the next stamp 15° (Shift: 45°)'], ['F', 'Flip the next stamp (with nothing selected)'],
    ['Ctrl / Cmd click a picture', 'Pick several stamps to place at random']]],
  ['Selection', [['Drag on empty map, Shift-click', 'Select several'], ['Arrows (Shift: ×10)', 'Nudge'], ['F', 'Flip'],
    ['[  ]', 'Send back / bring forward'], ['Enter, or double-click', 'Edit a label'], ['Alt-click, or double-click a point', 'Remove a path point'],
    ['Del', 'Delete'], ['Esc', 'Cancel what’s half done, then clear the selection']]],
  ['Everywhere', [['Ctrl Z / Ctrl Shift Z (or Y)', 'Undo / redo'], ['Ctrl C / X / V', 'Copy, cut, paste (also between maps)'], ['Ctrl D', 'Duplicate'],
    ['Ctrl A', 'Select all'], ['0', 'Fit the map'], ['+  −, or the wheel', 'Zoom'], ['?', 'This list']]],
];

function showShortcuts() {
  if (document.getElementById('modal-root').childElementCount) return;
  modal('Keyboard shortcuts', SHORTCUTS.map(([group, rows]) => `<div class="field-label">${group}</div>
    <table class="keys">${rows.map(([k, what]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(what)}</td></tr>`).join('')}</table>`).join('')
    + '<p class="muted small">On a Mac, Cmd works wherever Ctrl is shown.</p>', { wide: true });
}
