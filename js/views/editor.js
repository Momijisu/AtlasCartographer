// The map editor: a full-window canvas with pan/zoom (mouse, wheel, touch,
// pinch). Tools: select (move, scale, rotate, flip and layer stamps), ink pen,
// eraser, stamp (place art from the library) and scatter (paint many stamps
// at once). Everything is stored in map pixels, so the drawing is the same at
// any zoom and on any screen.
import * as store from '../store.js';
import * as A from '../assets.js';
import * as images from '../images.js';
import * as assetsync from '../assetsync.js';
import { $, $$, esc, uid, toast, modal } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';
import { drawDoc, drawStroke, strokePath, docStyle, STYLE, editorLandScale, labelBox, drawLabel, FONTS, fontCSS, mapStyle, texturePattern, drawPath, PATHS, docLayers, layerResolver, kindLayer, LAND_LAYER, BUILTIN_LAYERS, samplePath, pointsBox, simplify, landNeedsRefresh, refreshLand, releaseLand, SHAPE_DEFAULTS, shapePath, shapeHit, drawShapeGroup } from '../render.js';
import { exportDialog } from '../export.js';

const INKS = ['#2b2118', '#6b4a2b', '#2f5d7c', '#3f6b3a', '#8e2f22'];
// In the rail's order. Scatter is the stamp tool placing many at once, so it
// shares the stamp's button; moving the view has a button on touch screens
// only (elsewhere it's Space, or the middle mouse button).
const TOOLS = [
  ['pan', 'hand-pointing', 'Move the view (H, or hold Space)', 'Move'],
  ['select', 'cursor', 'Select, move, scale and rotate (V)', 'Select'],
  ['land', 'globe-hemisphere-west', 'Land and water (M)', 'Land'],
  ['terrain', 'paint-brush', 'Brush: paint textures onto the land (B)', 'Brush'],
  ['stamp', 'stamp', 'Stamp: place art from the library (O)', 'Stamp'],
  ['scatter', 'stamp', 'Stamp: place many at once (O)', 'Stamp'],
  ['shape', 'shapes', 'Shapes: rectangles, ellipses and polygons (R)', 'Shape'],
  ['path', 'path', 'Lines: roads, trails, rivers and borders (L)', 'Line'],
  ['pen', 'pencil-line', 'Pen and colour brush (P)', 'Pen'],
  ['text', 'text-t', 'Text: click to add a label, or click one to edit it (T)', 'Text'],
  ['eraser', 'eraser', 'Eraser (U)', 'Eraser'],
];
// The layer each tool draws on.
const TOOL_LAYER = { land: 'land', terrain: 'land', path: 'stroke', pen: 'stroke', shape: 'stroke', stamp: 'stamp', scatter: 'stamp', text: 'label' };
// Tool keys, as in Inkarnate where it has the tool (O picks the stamp tool
// in whichever placing mode it was last in).
const KEYS = { h: 'pan', v: 'select', m: 'land', b: 'terrain', o: 'stamp', r: 'shape', l: 'path', p: 'pen', t: 'text', u: 'eraser' };
const glyph = (d) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SHAPE_KINDS = [
  ['rect', 'Rectangle (Shift: square)', glyph('<rect x="4" y="6" width="16" height="12" rx="1"/>')],
  ['ellipse', 'Ellipse (Shift: circle)', glyph('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>')],
  ['poly', 'Polygon: click each corner, then the first again', glyph('<path d="M12 4l8 6-3 9H7l-3-9z"/>')],
  ['free', 'Freehand', glyph('<path d="M6 16c-2-4 1-9 6-10s8 3 6 7-6 2-7 5 3 3 5 2"/>')],
];
const DASHES = [['solid', '──', 'Solid outline'], ['dotted', '···', 'Dotted outline'], ['dashed', '- -', 'Dashed outline']];
const HANDLE = 9; // screen pixels
const ROT_OFFSET = 34;
// Gestures whose steps change the drawing or the view (the rest only draw over it).
const MAP_GESTURES = new Set(['pan', 'pinch', 'place', 'move', 'scale', 'rotate', 'node', 'shape']); // (the eraser and scatter redraw the map themselves, when they actually change something)

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
      <canvas class="editor-overlay"></canvas>
      <aside class="picker" hidden></aside>
      <div class="toolrail" role="toolbar" aria-label="Tools">
        ${TOOLS.filter(([t]) => t !== 'scatter').map(([t, ic, title, name]) => `<button class="tool${t === 'pan' ? ' touch-only' : ''}" data-tool="${t}" data-name="${name}" data-key="${title.match(/\(([^)]*)\)$/)[1]}" aria-label="${title.replace(/ \(.*/, '')}">${icon(ic)}</button>`).join('')}
      </div>
      <div class="ro-banner" role="status" hidden>This map is open in another window. Close it there to edit here.</div>
      <div class="save-banner" role="alert" hidden></div>
      <div class="tool-tip" hidden></div>
      <div class="map-hint" hidden><span class="hint-text"></span><button class="icon-btn" data-hint-close aria-label="Dismiss the hint">${icon('x')}</button></div>
      <div class="pk-preview" hidden></div>
      <div class="toolbar" role="toolbar" aria-label="Tool options">
        <span class="tb-name"></span><span class="tb-sep"></span>
        <span class="tb-group" data-for="land">
          <span class="seg land-mode"><button type="button" data-landmode="add" title="Paint land (X swaps; hold Alt for one water stroke)">Land</button><button type="button" data-landmode="erase" title="Paint water (X swaps)">Water</button></span>
          ${opt('Size', 'landSize', '<input type="range" class="land-size" min="0" max="100" step="1" title="Brush size (W and S)" aria-label="Land brush size">')}
          <button class="brush-chip texture-chip" data-act="textures" title="Land texture" aria-label="Land texture"></button>
        </span>
        <span class="tb-group" data-for="terrain">
          <button class="brush-chip terrain-chip" data-act="terrain-picker" title="Texture to paint" aria-label="Texture to paint"></button>
          ${opt('Size', 'terrainSize', '<input type="range" class="terrain-size" min="0" max="100" step="1" title="Brush size (W and S)" aria-label="Terrain brush size">')}
          ${opt('Soft', 'terrainSoft', '<input type="range" class="terrain-soft" min="0" max="100" step="1" title="Softness (Q and A)" aria-label="Soft edges">')}
          ${opt('Strength', 'terrainOpacity', '<input type="range" class="terrain-opacity" min="10" max="100" step="5" title="Strength: lower lets the land show through (E and D)" aria-label="Strength">')}
        </span>
        <span class="tb-group" data-for="path">
          <span class="seg path-style">${Object.entries(PATHS).map(([k, [name]]) => `<button type="button" data-pathstyle="${k}">${name}</button>`).join('')}</span>
          ${opt('Width', 'pathWidth', '<input type="range" class="path-width" min="2" max="160" step="1" title="Width (W and S)" aria-label="Path width">')}
        </span>
        <span class="tb-group" data-for="pen"><span class="swatches">${INKS.map((c) => `<button class="swatch" data-ink="${c}" style="--c:${c}" aria-label="Ink ${c}"></button>`).join('')}
          <input type="color" class="ink-custom" title="Any colour" aria-label="Any colour"></span></span>
        <span class="tb-group" data-for="pen eraser">${opt('Size', 'width', '<input type="range" class="width" min="0" max="100" step="1" title="Size (W and S)" aria-label="Pen size">')}</span>
        <span class="tb-group" data-for="pen">
          ${opt('Opacity', 'penOpacity', '<input type="range" class="pen-opacity" min="5" max="100" step="5" title="Opacity: lower lets the map show through (E and D)" aria-label="Opacity">')}
          ${opt('Soft', 'penSoft', '<input type="range" class="pen-soft" min="0" max="100" step="5" title="Softness (Q and A)" aria-label="Soft edges">')}
        </span>
        <span class="tb-group" data-for="stamp scatter">
          <span class="seg place-mode" title="Place one stamp per click, or paint many"><button type="button" data-place="stamp">One</button><button type="button" data-place="scatter">Many</button></span>
          <button class="brush-chip" data-act="picker" title="Choose art (F) · Alt ← → for the next variation" aria-label="Choose art"></button>
          <button class="tool" data-act="stamp-random" title="Random variation: each stamp placed is one of its variations, at random" aria-label="Random variation" aria-pressed="false">${icon('dice')}</button>
          ${opt('Size', 'stampSize', '<input type="range" class="stamp-size" min="0" max="100" step="1" title="Stamp size (W and S)" aria-label="Stamp size">')}
          ${opt('Opacity', 'stampOpacity', '<input type="range" class="stamp-opacity" min="5" max="100" step="5" title="Opacity of new stamps (E and D)" aria-label="Stamp opacity">')}
          <button class="tool flip stamp-only" data-act="stamp-turn" title="Turn the next stamp 15° (> and <)" aria-label="Turn the next stamp">${icon('arrow-counter-clockwise')}<b class="badge" data-val="stampRot"></b></button>
          <button class="tool stamp-only" data-act="stamp-flip" title="Flip the next stamp (Shift F)" aria-label="Flip the next stamp" aria-pressed="false">${icon('flip-horizontal')}</button>
          <button class="tool scatter-only" data-act="scatter-settings" title="Scatter settings: area (Q and A), density (Alt Q and Alt A), size and rotation" aria-label="Scatter settings">${icon('gear-six')}</button>
        </span>
        <span class="tb-group" data-for="shape">
          <span class="seg shape-kind">${SHAPE_KINDS.map(([k, n, g]) => `<button type="button" data-shapekind="${k}" title="${n}" aria-label="${n.replace(/ \(.*|:.*/, '')}">${g}</button>`).join('')}</span>
          <span class="seg shape-mode" title="Add a shape, or cut one out of the merged shapes it overlaps (X)"><button type="button" data-shapemode="add">Add</button><button type="button" data-shapemode="subtract">Cut</button></span>
          <label class="tb-check" title="Shapes with the same look join into one, outlined round the outside"><input type="checkbox" class="shape-merge"> Merge</label>
          <span class="tb-sep"></span>
          <label class="tb-check" title="Fill"><input type="checkbox" class="shape-fill"> Fill</label>
          <input type="color" class="shape-fill-color" title="Fill colour" aria-label="Fill colour">
          <button class="brush-chip shape-chip" data-act="shape-tex" title="Fill texture (F)" aria-label="Fill texture"></button>
          <span class="tb-sep"></span>
          <label class="tb-check" title="Outline"><input type="checkbox" class="shape-stroke"> Outline</label>
          <input type="color" class="shape-stroke-color" title="Outline colour" aria-label="Outline colour">
          ${opt('Width', 'shapeWidth', '<input type="range" class="shape-width" min="1" max="60" step="1" title="Outline width (W and S)" aria-label="Outline width">')}
          <span class="seg shape-dash">${DASHES.map(([k, g, n]) => `<button type="button" data-dash="${k}" title="${n}">${g}</button>`).join('')}</span>
          ${opt('Opacity', 'shapeOpacity', '<input type="range" class="shape-opacity" min="10" max="100" step="5" title="Opacity (E and D)" aria-label="Shape opacity">')}
        </span>
        <span class="tb-group" data-for="select">
          <span class="tb-note"></span>
          <button class="tool" data-act="duplicate" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${icon('plus-circle')}</button>
          <button class="tool" data-act="edit-text" title="Edit the text (Enter)" aria-label="Edit the text">${icon('pencil-simple')}</button>
          <button class="tool" data-act="adjust" title="Opacity, tint and brightness" aria-label="Adjust">${icon('magic-wand')}</button>
          <button class="tool" data-act="flip" title="Flip (F)" aria-label="Flip">${icon('flip-horizontal')}</button>
          <button class="tool" data-act="front" title="Bring forward (Ctrl ↑)" aria-label="Bring to front">${icon('arrow-up')}</button>
          <button class="tool" data-act="back" title="Send backward (Ctrl ↓)" aria-label="Send to back">${icon('arrow-down')}</button>
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
        <button class="tool" data-act="shortcuts" title="Keyboard shortcuts (K or ?)" aria-label="Keyboard shortcuts">${icon('info')}</button>
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
    // The map is drawn on one canvas; what moves with the pointer (the brush
    // outline, a stroke being drawn, the selection) on a transparent one over
    // it, so those can change without the whole map being drawn again.
    this.overlay = root.querySelector('.editor-overlay');
    this.octx = this.overlay.getContext('2d');
    this.mapDirty = true;
    this.s = 1; this.x = 0; this.y = 0; // map → screen: screen = map * s + (x, y)
    this.tool = load('ac.tool', 'pen');
    if (!TOOLS.some(([t]) => t === this.tool)) this.tool = 'pen';
    this.ink = load('ac.ink', INKS[0]);
    this.width = load('ac.width', 8);
    this.penOpacity = load('ac.penOpacity', 1);
    this.penSoft = load('ac.penSoft', 0);
    this.stampSize = load('ac.stampSize', 256);
    this.stampOpacity = load('ac.stampOpacity', 1); // of new stamps
    this.stampRandom = load('ac.stampRandom', true); // a stamp's tile picks all its variations, placed at random
    this.shapeKind = load('ac.shapeKind', 'rect');
    this.shapeMode = 'add';
    this.shapeMerge = load('ac.shapeMerge', true);
    this.shapeStyle = { ...SHAPE_DEFAULTS, ...load('ac.shapeStyle', {}) }; // how new shapes look
    this.poly = null; // a polygon being clicked out: its points so far
    this.snap = load('ac.snap', false); // stamps snap to the map's grid
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
    this.lastSel = []; // what was selected before the selection was cleared (` brings it back)
    this.prevTool = null; // Tab goes back to it
    this.preview = new Map(); // id → object (or null: hidden) as a gesture is changing it; the drawing itself changes when the gesture is committed
    this.undoStack = []; this.redoStack = [];
    this.pointers = new Map();
    this.gesture = null;
    this.spaceDown = false;
    this.disposers = [];
    this.wire();
    this.disposers.push(images.onLoad(() => this.redraw()));
    // Previews still coming down from OneDrive fill in the picker as they arrive.
    this.disposers.push(assetsync.onProgress((p, fresh) => { if (fresh) this.fillThumbs(); }));
    this.resize();
    this.fit();
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  destroy() {
    this.destroyed = true;
    releaseLand(this.project.id);
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
    this.canvas.width = this.overlay.width = Math.round(r.width * dpr);
    this.canvas.height = this.overlay.height = Math.round(r.height * dpr);
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

  // The map needs drawing again (the drawing, the view or a picture changed)...
  redraw() {
    this.mapDirty = true;
    this.schedule();
  }

  // ...or only what's over it.
  redrawOverlay() {
    this.schedule();
  }

  schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  // After a gesture step: the map changes only if the gesture changes the
  // drawing or the view.
  gestureRedraw() {
    if (!this.gesture || MAP_GESTURES.has(this.gesture.kind)) this.redraw(); else this.redrawOverlay();
  }

  // One frame going wrong (say, a canvas the device can't give us) shouldn't
  // end the drawing: the error is logged once per kind, and the next change
  // starts a fresh frame on canvases reset to their defaults.
  paint() {
    try {
      if (this.mapDirty) this.paintMap();
      this.mapDirty = false;
      this.paintOverlay();
      this.paintError = null;
      this.scheduleLandRefresh();
    } catch (e) {
      if (e.message !== this.paintError) console.error('Drawing a frame failed', e);
      this.paintError = e.message;
      this.canvas.width = this.canvas.width; // clears them and drops any half-done state
      this.overlay.width = this.overlay.width;
      this.mapDirty = true;
    }
    const zoom = (this.zoomEl ??= $('.zoom-pct', this.root)), pct = `${Math.round(this.s * 100)}%`;
    if (zoom.textContent !== pct) zoom.textContent = pct;
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

  paintMap() {
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
    const [x0, y0] = this.toMap(0, 0), [x1, y1] = this.toMap(this.vw, this.vh);
    drawDoc(ctx, this.project, this.doc, { image: (id) => images.get(id), placeholder: true, landScale: this.landScale(), view: [x0, y0, x1, y1], overlay: this.preview });
    ctx.restore();
  }

  paintOverlay() {
    const { octx: ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.s * dpr, 0, 0, this.s * dpr, this.x * dpr, this.y * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.project.width, this.project.height);
    ctx.clip();
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
    if (this.tool === 'shape' || this.tool === 'select') this.paintCutouts();
    if (this.poly && this.tool === 'shape') this.paintPoly();
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
    const { octx: ctx, dpr } = this;
    const [mx, my] = at;
    ctx.save();
    ctx.setTransform(this.s * dpr, 0, 0, this.s * dpr, this.x * dpr, this.y * dpr);
    if (tool === 'stamp' || tool === 'scatter') {
      // A ghost of the stamp (the first of the chosen pictures), at size.
      const a = this.brush.map((id) => A.asset(id)).find(Boolean);
      const img = a && images.get(a.id);
      if (img) {
        const k = size / Math.max(a.w, a.h, 1);
        ctx.globalAlpha = 0.55 * this.stampOpacity;
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
    this.redrawOverlay();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.redrawOverlay(), 950);
  }

  // A path (or text on a path): its points, to drag, and a small "+" between
  // each pair, to drag out a new point.
  paintNodes(o) {
    const { octx: ctx, dpr } = this;
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
    const { octx: ctx, dpr } = this;
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
    const { octx: ctx, dpr } = this;
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
      const o = this.get(id);
      if (o) out.push(o); else this.sel.delete(id);
    }
    return out;
  }

  // An object as it looks now, mid-gesture changes included (undefined if it's gone).
  get(id) {
    const o = this.preview.has(id) ? this.preview.get(id) : this.doc.objects[id];
    return o && !o.deleted ? o : undefined;
  }

  // Every live object as it looks now.
  live() {
    const out = [];
    for (const o of Object.values(this.doc.objects)) if (!o.deleted && !this.preview.has(o.id)) out.push(o);
    for (const o of this.preview.values()) if (o && !o.deleted) out.push(o);
    return out;
  }

  // (object) → can it be picked and changed? For many objects in one go: the
  // layers are worked out once, not for each object.
  editableOf() {
    const lay = layerResolver(this.doc), hidden = this.hidden();
    return (o) => { const k = lay(o); return !o.locked && !hidden.has(k) && !this.locked.has(k); };
  }

  // The selected object when exactly one is selected.
  selectedObj() { const l = this.selectedObjs(); return l.length === 1 ? l[0] : null; }

  select(ids) { this.sel = new Set(ids); }

  selectable() { const ok = this.editableOf(); return this.live().filter((o) => SELECTABLE.includes(o.kind) && ok(o)); }

  // Stamps and labels can be selected and transformed; this is their box.
  box(o) {
    if (ptsKey(o) === 'points') {
      const b = pointsBox(o.points), r = o.kind === 'path' ? o.width / 2 : 0;
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
    const ok = this.editableOf();
    const list = this.live().filter((o) => kinds.includes(o.kind) && ok(o)).sort((a, b) => rank(b) - rank(a));
    return list.find((o) => this.hitTest(o, mx, my)) || null;
  }

  // Is (mx, my) on this object? Paths and text on paths by their line;
  // everything else by its box.
  hitTest(o, mx, my) {
    const slack = 6 / this.s;
    if (o.kind === 'path') return nearLine(o.points, mx, my, o.width / 2 + slack);
    if (o.kind === 'shape') return shapeHit(o, mx, my, slack);
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
      ...(this.stampOpacity < 1 ? { opacity: this.stampOpacity } : {}),
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
    for (const o of this.live()) { lo = Math.min(lo, o.z || 0); hi = Math.max(hi, o.z || 0); }
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
    if (o.kind === 'shape' ? p.length <= 6 : p.length <= 4) { toast(o.kind === 'shape' ? 'A shape needs at least three points' : 'A line needs at least two points'); return; }
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
    const bs = clipboard.map((o) => this.box(o)), xs = bs.map((b) => b.cx), ys = bs.map((b) => b.cy);
    const [cx, cy] = this.toMap(this.vw / 2, this.vh / 2);
    this.addCopies(clipboard, cx - (Math.min(...xs) + Math.max(...xs)) / 2, cy - (Math.min(...ys) + Math.max(...ys)) / 2);
  }

  // Strokes and stamps under a point, within the eraser's radius (map pixels).
  hits([mx, my], radius) {
    const out = [], ok = this.editableOf();
    for (const o of this.live()) {
      if (!ok(o)) continue;
      if (o.kind === 'stamp' || o.kind === 'label') { if (this.inBox(o, mx, my, radius)) out.push(o); continue; }
      if (o.kind === 'shape') { if (shapeHit(o, mx, my, radius)) out.push(o); continue; }
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
    if (t !== this.tool) this.prevTool = this.tool;
    this.tool = t;
    this.poly = null;
    keep('ac.tool', t);
    if (t !== 'select') this.clearSel();
    if ((t === 'stamp' || t === 'scatter') && !this.brush.length) this.openPicker();
    this.syncToolbar();
    this.redrawOverlay();
  }

  syncToolbar() {
    const panning = this.tool === 'pan' || this.spaceDown;
    for (const b of $$('[data-tool]', this.root)) b.classList.toggle('on', b.dataset.tool === (this.tool === 'scatter' ? 'stamp' : this.tool));
    for (const b of $$('[data-place]', this.root)) b.classList.toggle('on', b.dataset.place === this.tool);
    for (const b of $$('[data-ink]', this.root)) b.classList.toggle('on', b.dataset.ink === this.ink);
    for (const g of $$('.tb-group', this.root)) g.hidden = !g.dataset.for.split(' ').includes(this.tool);
    $('.tb-name', this.root).textContent = TOOLS.find(([t]) => t === this.tool)[3];
    $('.width', this.root).value = penSlider(this.width);
    $('.pen-opacity', this.root).value = Math.round(this.penOpacity * 100);
    $('.pen-soft', this.root).value = Math.round(this.penSoft * 100);
    $('.ink-custom', this.root).value = this.ink;
    $('.ink-custom', this.root).classList.toggle('on', !INKS.includes(this.ink));
    $('.stamp-size', this.root).value = sliderFromSize(this.stampSize);
    $('.stamp-opacity', this.root).value = Math.round(this.stampOpacity * 100);
    $('.land-size', this.root).value = sliderFromSize(this.landSize);
    $('.terrain-size', this.root).value = sliderFromSize(this.terrainSize);
    $('.path-width', this.root).value = this.pathWidth;
    for (const b of $$('[data-pathstyle]', this.root)) b.classList.toggle('on', b.dataset.pathstyle === this.pathStyle);
    $('.terrain-soft', this.root).value = Math.round(this.terrainSoft * 100);
    $('.terrain-opacity', this.root).value = Math.round(this.terrainOpacity * 100);
    for (const b of $$('[data-landmode]', this.root)) b.classList.toggle('on', b.dataset.landmode === this.landMode);
    const sh = this.shapeStyle;
    for (const b of $$('[data-shapekind]', this.root)) b.classList.toggle('on', b.dataset.shapekind === this.shapeKind);
    for (const b of $$('[data-shapemode]', this.root)) b.classList.toggle('on', b.dataset.shapemode === this.shapeMode);
    for (const b of $$('[data-dash]', this.root)) b.classList.toggle('on', b.dataset.dash === sh.dash);
    $('.shape-merge', this.root).checked = this.shapeMerge;
    $('.shape-fill', this.root).checked = sh.fill;
    $('.shape-fill-color', this.root).value = sh.fillColor;
    $('.shape-stroke', this.root).checked = sh.stroke;
    $('.shape-stroke-color', this.root).value = sh.strokeColor;
    $('.shape-width', this.root).value = sh.strokeWidth;
    $('.shape-opacity', this.root).value = Math.round(sh.opacity * 100);
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
    $('[data-act="stamp-random"]', this.root).classList.toggle('on', this.stampRandom);
    $('[data-act="stamp-random"]', this.root).setAttribute('aria-pressed', this.stampRandom);
    $('[data-act="stamp-flip"]', this.root).setAttribute('aria-pressed', this.stampFlip);
    this.showValues();
    this.syncHistory();
    const adjustable = all.some((o) => o.kind === 'stamp' || o.kind === 'path' || o.kind === 'shape');
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
      pathWidth: this.pathWidth, width: this.width, penOpacity: pct(this.penOpacity), penSoft: pct(this.penSoft), stampSize: this.stampSize, stampOpacity: pct(this.stampOpacity), shapeWidth: this.shapeStyle.strokeWidth, shapeOpacity: pct(this.shapeStyle.opacity),
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
      : 'Start with Land (M) to paint the coast, or Stamp (O) to place art · ? for shortcuts';
  }

  // Random on: the chosen stamps' variations all go into the brush; off: just
  // the first chosen picture (Alt ← → then steps through the variations).
  setStampRandom(on) {
    this.stampRandom = on;
    keep('ac.stampRandom', on);
    const chosen = this.brush.map((id) => A.asset(id)).filter(Boolean);
    if (chosen.length) this.setBrush(on ? [...new Set(chosen.flatMap((a) => A.variationsOf(a).map((v) => v.id)))] : [chosen[0].id]);
    this.syncToolbar();
    toast(on ? 'Random variation on' : 'One variation: Alt ← → to change it', 1400);
  }

  // Turn the next stamp by deg (clockwise), within one full turn.
  turnStamp(deg) { this.stampRot = (((this.stampRot + deg) % 360) + 360) % 360; this.syncToolbar(); this.redrawOverlay(); }
  flipStamp() { this.stampFlip = !this.stampFlip; this.syncToolbar(); this.redrawOverlay(); }

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
    const fx = this.shapeStyle.fillTex, furl = fx && A.asset(fx) && await A.thumbURL(fx);
    $('.shape-chip', this.root).innerHTML = furl ? `<img src="${furl}" alt="">` : `<span class="chip-plain" style="background:${this.shapeStyle.fillColor}" title="Plain colour"></span>`;
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

  // How new shapes look; with shapes selected, they change too.
  setShapeStyle(patch) {
    this.shapeStyle = { ...this.shapeStyle, ...patch };
    keep('ac.shapeStyle', this.shapeStyle);
    if (this.selectedObjs().some((o) => o.kind === 'shape')) this.editSelected((o) => (o.kind === 'shape' ? patch : {}));
    this.syncToolbar();
    this.redrawOverlay();
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
    this.renderLayers(); this.syncToolbar(); this.redrawOverlay();
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
    const stamps = all.filter((o) => o.kind === 'stamp'), paths = all.filter((o) => o.kind === 'path'), shapes = all.filter((o) => o.kind === 'shape');
    if (!stamps.length && !paths.length && !shapes.length) return;
    // Don't redraw under a slider that's being dragged.
    if (el.contains(document.activeElement) && document.activeElement.type === 'range') return;
    const o = stamps[0], q = paths[0], sh = shapes[0];
    const title = all.length > 1 ? `${all.length} selected` : o ? 'Stamp' : q ? 'Path' : 'Shape';
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
        ${sh ? `${stamps.length || paths.length ? '<div class="field-label">Shapes</div>' : ''}
        <label class="inline">Kind <select name="shapeMode"><option value="add" ${sh.mode !== 'subtract' ? 'selected' : ''}>Shape</option><option value="subtract" ${sh.mode === 'subtract' ? 'selected' : ''}>Cut-out</option></select></label>
        <label class="check"><input type="checkbox" name="merge" ${sh.merge !== false ? 'checked' : ''}> Merge with matching shapes</label>
        <label class="check"><input type="checkbox" name="fill" ${sh.fill ? 'checked' : ''}> Fill</label>
        <label class="inline">Fill colour <input type="color" name="fillColor" value="${sh.fillColor || '#d9c9a3'}"></label>
        <label class="check"><input type="checkbox" name="stroke" ${sh.stroke ? 'checked' : ''}> Outline</label>
        <label class="inline">Outline colour <input type="color" name="strokeColor" value="${sh.strokeColor || '#2b2118'}"></label>
        <label>Outline width<input type="range" name="strokeWidth" min="1" max="60" step="1" value="${sh.strokeWidth || 6}"></label>
        <label class="inline">Outline <select name="dash">${DASHES.map(([k, , n]) => `<option value="${k}" ${sh.dash === k ? 'selected' : ''}>${n.replace(' outline', '')}</option>`).join('')}</select></label>
        <label>Opacity<input type="range" name="shapeOpacity" min="0.1" max="1" step="0.05" value="${sh.opacity ?? 1}"></label>
        ${ptsKey(sh) ? '<p class="muted small">Drag a corner to move it, drag a + to add one, Alt-click a corner to remove it.</p>' : ''}` : ''}
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
      const toShapes = (patch) => this.editSelected((x) => (x.kind === 'shape' ? patch : {}));
      if (t.name === 'shapeMode') return toShapes({ mode: v === 'subtract' ? 'subtract' : null });
      if (t.name === 'shapeOpacity') return toShapes({ opacity: v });
      if (t.name === 'merge') return toShapes({ merge: t.checked ? null : false });
      if (['fill', 'stroke'].includes(t.name)) return toShapes({ [t.name]: t.checked });
      if (t.name === 'fillColor') return toShapes({ fillColor: v, fillTex: null, fill: true });
      if (['strokeColor', 'strokeWidth', 'dash'].includes(t.name)) return toShapes({ [t.name]: v, stroke: true });
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
    const title = { stamp: 'Stamps', texture: 'Land texture', terrain: 'Terrain', overlay: 'Paper', shapeFill: 'Shape fill' }[mode];
    const plainLabel = { terrain: 'Base land', overlay: 'No paper', shapeFill: 'Plain colour' }[mode] || 'Plain land';
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
    const byName = A.byName;
    const open = this.pickOpen(kind);
    const query = (this.pickQuery || '').trim().toLowerCase();
    const tile = (a, cls = '', st = null) => {
      const url = A.cachedThumbURL(a.id);
      const name = st ? st.name : a.name;
      return `<button class="tile${cls}" data-id="${a.id}"${st ? ` data-set="${esc(st.key)}"` : ''} aria-label="${esc(name)}" title="${esc(name)}${st?.items.length > 1 ? ` · ${st.items.length} variations` : ''}">${url ? `<img src="${url}" alt="" draggable="false">` : icon('image')}</button>`;
    };
    // A stamp shows as one tile, its first variation, with a badge counting
    // the rest; the badge shows them (and hides them again) beside it.
    this.pickSets = new Map(); // stamp key → its variations' ids
    this.pickSetOpen ??= new Set();
    const setTile = (st, cls = '') => {
      this.pickSets.set(st.key, st.items.map((a) => a.id));
      const n = st.items.length, isOpen = n > 1 && this.pickSetOpen.has(st.key);
      return `<span class="pk-set${isOpen ? ' open' : ''}">${tile(st.items[0], cls, st)}${n > 1 ? `<button class="pk-badge" data-expand="${esc(st.key)}" title="${isOpen ? 'Hide' : 'Show'} the ${n} variations" aria-label="${isOpen ? 'Hide' : 'Show'} the ${n} variations">${isOpen ? '−' : n}</button>` : ''}</span>`
        + (isOpen ? st.items.map((a) => tile(a, `${cls} variant`)).join('') : '');
    };
    // A long category shows its first stamps; the rest come on request (a
    // category can hold thousands, and every tile is a button and a picture).
    const SHOWN = 120;
    const grid = (list, key) => {
      const more = list.length > SHOWN && !this.pickAll.has(key);
      return `<div class="pk-grid">${(more ? list.slice(0, SHOWN) : list).map((a) => tile(a)).join('')}</div>`
        + (more ? `<div class="pk-actions"><button class="btn small quiet" data-showall="${esc(key)}">Show all ${list.length.toLocaleString()}</button></div>` : '');
    };
    const setGrid = (sets, key) => {
      const more = sets.length > SHOWN && !this.pickAll.has(key);
      return `<div class="pk-grid">${(more ? sets.slice(0, SHOWN) : sets).map((st) => setTile(st)).join('')}</div>`
        + (more ? `<div class="pk-actions"><button class="btn small quiet" data-showall="${esc(key)}">Show all ${sets.length.toLocaleString()}</button></div>` : '');
    };
    const catHead = (key, label, count, isOpen, all = true) => `<div class="pk-cat-head" data-toggle="${esc(key)}">
        <span class="pk-caret">${icon(isOpen ? 'caret-down' : 'caret-right')}</span><span class="pk-cat-name">${esc(label)}</span><span class="muted small">${count}</span>
        ${all && !tex ? `<button class="btn small quiet" data-all="${esc(key)}" title="Stamp with any of these">Use all</button>` : ''}</div>`;
    let body = '';
    this.pickLists = new Map(); // section key → its assets, for "Use all"
    this.pickAll ??= new Set(); // long categories shown in full
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
        + [...groups].map(([key, list]) => { this.pickLists.set(key, list); const [pk, ct] = key.split(SEP); return `<section class="pk-section">${catHead(key, `${pk} · ${ct || 'General'}`, list.length, true)}${grid(list, key)}</section>`; }).join('');
    } else {
      const rec = recent(kind).map((id) => A.asset(id)).filter((a) => a && a.kind === kind).slice(0, 24);
      if (rec.length) {
        this.pickLists.set(RECENT, rec);
        const isOpen = !open.has(`${RECENT}:closed`);
        body += `<section class="pk-section">${catHead(RECENT, 'Recently used', rec.length, isOpen)}${isOpen ? grid(rec, RECENT) : ''}</section>`;
      }
      for (const p of packs) {
        const packOpen = !open.has(`${p.name}:closed`);
        body += `<section class="pk-pack-section"><div class="pk-pack-head" data-toggle="${esc(p.name)}:closed">
            <span class="pk-caret">${icon(packOpen ? 'caret-down' : 'caret-right')}</span><b>${esc(p.name)}</b>
            ${rank(p) === 2 ? `<span class="muted small">${esc(A.PACK_TYPES.find(([v]) => v === p.type)?.[1] || '')}</span>` : ''}</div>`;
        if (packOpen) {
          for (const c of p.categories) {
            const key = `${p.name}${SEP}${c.name}`;
            const sets = A.categorySets(p.name, c.name);
            this.pickLists.set(key, A.categoryAssets(p.name, c.name));
            const isOpen = open.has(key);
            // Closed, a category shows a strip of its first stamps.
            body += `<section class="pk-section">${catHead(key, c.name || 'General', sets.length, isOpen)}
              ${isOpen ? setGrid(sets, key) : `<div class="pk-strip">${sets.slice(0, 6).map((st) => `<span class="pk-set">${tile(st.items[0], ' mini', st)}${st.items.length > 1 ? `<span class="pk-badge static">${st.items.length}</span>` : ''}</span>`).join('')}${sets.length > 6 ? `<button class="pk-more" data-toggle="${esc(key)}">+${sets.length - 6}</button>` : ''}</div>`}</section>`;
            for (const st of sets.slice(0, 6)) this.pickSets.set(st.key, st.items.map((a) => a.id));
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
    const chosen = new Set(mode === 'texture' ? [docStyle(this.doc).landTexture] : mode === 'terrain' ? [this.terrainTex] : mode === 'overlay' ? [docStyle(this.doc).overlay] : mode === 'shapeFill' ? [this.shapeStyle.fillTex] : this.brush);
    for (const t of $$('.tile', el)) t.classList.toggle('on', chosen.has(t.dataset.id) || (!!t.dataset.set && !!this.pickSets?.get(t.dataset.set)?.some((id) => chosen.has(id))));
    const count = $('.pk-count', el);
    if (count) count.textContent = this.brush.length ? `${this.brush.length} chosen${this.brush.length > 1 ? ', placed at random' : ''}` : 'Click a picture to use it';
    $('[data-plain]', el)?.classList.toggle('on', mode === 'terrain' && !this.terrainTex);
  }

  wirePicker(el, mode) {
    const tex = mode !== 'stamp', kind = tex ? 'texture' : 'stamp';
    const pick = (id) => {
      if (mode === 'terrain') this.setTerrainTex(id);
      else if (mode === 'shapeFill') { this.setShapeStyle({ fillTex: id, fill: true }); this.renderChip(); }
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
      const showAll = e.target.closest('[data-showall]');
      if (showAll) { this.pickAll.add(showAll.dataset.showall); this.renderPicker(); return; }
      const expand = e.target.closest('[data-expand]');
      if (expand) {
        const k = expand.dataset.expand;
        if (this.pickSetOpen.has(k)) this.pickSetOpen.delete(k); else this.pickSetOpen.add(k);
        this.renderPicker();
        return;
      }
      const t = e.target.closest('.tile');
      if (t) {
        const id = t.dataset.id;
        if (tex) { pick(id); useRecent('texture', [id]); this.markPicker(); return; }
        // A stamp's tile picks the stamp: all its variations when placing
        // them at random, else its first. A variation's tile picks just it.
        const ids = t.dataset.set && this.stampRandom ? this.pickSets.get(t.dataset.set) || [id] : [id];
        // Ctrl / Cmd click (or "Pick several") adds or removes; a plain click picks just this one.
        const add = this.multi || e.ctrlKey || e.metaKey;
        if (add) this.setBrush(ids.every((x) => this.brush.includes(x)) ? this.brush.filter((x) => !ids.includes(x)) : [...new Set([...this.brush, ...ids])]);
        else this.setBrush(ids);
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
    this.pickIO?.disconnect();
    const io = this.pickIO = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) {
        io.unobserve(en.target);
        A.thumbURL(en.target.dataset.id).then((url) => { if (url) en.target.innerHTML = `<img src="${url}" alt="" draggable="false">`; });
      }
    }, { root: el, rootMargin: '300px' });
    for (const t of $$('.tile:not(:has(img))', el)) io.observe(t);
  }

  fillThumbs() {
    const el = $('.picker', this.root);
    if (!el || el.hidden) return;
    for (const t of $$('.tile:not(:has(img))', el)) {
      A.thumbURL(t.dataset.id).then((url) => { if (url && !t.querySelector('img')) t.innerHTML = `<img src="${url}" alt="" draggable="false">`; });
    }
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
      if (b.dataset.place) { keep('ac.stampPlace', b.dataset.place); this.setTool(b.dataset.place); }
      if (b.dataset.shapekind) { this.shapeKind = b.dataset.shapekind; keep('ac.shapeKind', this.shapeKind); this.poly = null; this.syncToolbar(); this.redrawOverlay(); }
      if (b.dataset.shapemode) { this.shapeMode = b.dataset.shapemode; this.syncToolbar(); }
      if (b.dataset.dash) this.setShapeStyle({ dash: b.dataset.dash, stroke: true });
      const act = b.dataset.act;
      if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
      else if (act === 'fit') this.fit();
      else if (act === 'zoom-in') this.zoomAt(this.vw / 2, this.vh / 2, 1.25);
      else if (act === 'zoom-out') this.zoomAt(this.vw / 2, this.vh / 2, 0.8);
      else if (act === 'zoom-100') this.zoomAt(this.vw / 2, this.vh / 2, 1 / this.s);
      else if (act === 'stamp-turn') this.turnStamp(e.shiftKey ? 45 : 15);
      else if (act === 'stamp-flip') this.flipStamp();
      else if (act === 'stamp-random') this.setStampRandom(!this.stampRandom);
      else if (act === 'picker') this.togglePicker('stamp');
      else if (act === 'textures') this.togglePicker('texture');
      else if (act === 'flip') this.flipSelected();
      else if (act === 'front') this.stepZ(1);
      else if (act === 'back') this.stepZ(-1);
      else if (act === 'duplicate') this.duplicateSelected();
      else if (act === 'delete') this.deleteSelected();
      else if (act === 'edit-text') this.editLabel(this.selectedObj());
      else if (act === 'shortcuts') showShortcuts();
      else if (act === 'layers') this.togglePanel('.layers-panel', () => this.renderLayers());
      else if (act === 'style') this.togglePanel('.style-panel', () => this.renderStylePanel());
      else if (act === 'adjust') this.togglePanel('.adjust-panel', () => this.renderAdjust());
      else if (act === 'terrain-picker') this.togglePicker('terrain');
      else if (act === 'shape-tex') this.togglePicker('shapeFill');
      else if (act === 'scatter-settings') this.togglePanel('.scatter-panel', () => this.renderScatter());
    };
    $('.toolbar', this.root).onclick = onBar;
    $('.toolrail', this.root).onclick = onBar;
    // Slider handlers set the value first; this then updates the numbers beside them.
    // The slider last moved is the one Shift ↑ ↓ change.
    $('.toolbar', this.root).addEventListener('input', (e) => { if (e.target.type === 'range') this.lastRange = e.target; this.showValues(); });
    $('[data-hint-close]', this.root).onclick = () => { this.hintGone = true; keep('ac.hintGone', true); this.syncHint(); };
    this.wireTips();
    $('.width', this.root).oninput = (e) => { this.flashSize(); this.width = penWidth(+e.target.value); keep('ac.width', this.width); };
    $('.pen-opacity', this.root).oninput = (e) => { this.penOpacity = +e.target.value / 100; keep('ac.penOpacity', this.penOpacity); };
    $('.pen-soft', this.root).oninput = (e) => { this.penSoft = +e.target.value / 100; keep('ac.penSoft', this.penSoft); };
    $('.ink-custom', this.root).oninput = (e) => { this.ink = e.target.value; keep('ac.ink', this.ink); this.syncToolbar(); };
    $('.stamp-size', this.root).oninput = (e) => { this.flashSize(); this.stampSize = sizeFromSlider(+e.target.value); keep('ac.stampSize', this.stampSize); };
    $('.shape-merge', this.root).onchange = (e) => { this.shapeMerge = e.target.checked; keep('ac.shapeMerge', this.shapeMerge); };
    $('.shape-fill', this.root).onchange = (e) => this.setShapeStyle({ fill: e.target.checked });
    $('.shape-fill-color', this.root).oninput = (e) => this.setShapeStyle({ fillColor: e.target.value, fill: true, fillTex: null });
    $('.shape-stroke', this.root).onchange = (e) => this.setShapeStyle({ stroke: e.target.checked });
    $('.shape-stroke-color', this.root).oninput = (e) => this.setShapeStyle({ strokeColor: e.target.value, stroke: true });
    $('.shape-width', this.root).oninput = (e) => this.setShapeStyle({ strokeWidth: +e.target.value, stroke: true });
    $('.shape-opacity', this.root).oninput = (e) => this.setShapeStyle({ opacity: +e.target.value / 100 });
    $('.stamp-opacity', this.root).oninput = (e) => { this.stampOpacity = +e.target.value / 100; keep('ac.stampOpacity', this.stampOpacity); this.redrawOverlay(); };
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
      if (e.pointerType === 'mouse') { this.hover = this.toMap(...this.local(e)); if (!this.pointers.size) this.redrawOverlay(); }
      this.move(e);
    });
    this.on(c, 'pointerleave', () => { this.hover = null; this.redrawOverlay(); });
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
      // Wheel with keys held, a step per notch (trackpads send many small
      // ones, so they're added up): Shift sizes the brush or the selection;
      // Alt the brush, or with the stamp tool picks the next in its set;
      // Ctrl turns the selection (Ctrl Alt, finely). A trackpad pinch also
      // arrives as Ctrl + wheel, in small fractional steps: that still zooms.
      const any = this.tool === 'select' && this.selectedObjs().length > 0;
      const d = e.deltaY || e.deltaX; // Shift turns the wheel sideways in some browsers
      const mouseCtrl = (e.ctrlKey || e.metaKey) && any && e.deltaMode === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY);
      if ((e.shiftKey || e.altKey || mouseCtrl) && !this.readOnly) {
        this.wheelStep = (this.wheelStep || 0) + d;
        if (Math.abs(this.wheelStep) < 50) return;
        const up = this.wheelStep < 0;
        this.wheelStep = 0;
        if (mouseCtrl) this.rotateSelected((up ? -1 : 1) * (e.altKey ? 1 : 15));
        else if (e.altKey && (this.tool === 'stamp' || this.tool === 'scatter')) this.stepSet(up ? -1 : 1);
        else if (any) this.scaleSelected(up ? 1.05 : 1 / 1.05);
        else this.resizeBrush(up);
        return;
      }
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
    const k = e.key.toLowerCase(), code = e.code;
    // Keys by position (KeyW…), so Shift (larger steps) and other layouts work.
    const letter = /^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase();
    const big = e.shiftKey;
    // Read-only: only the keys that move the view.
    if (this.readOnly && !(mod && k === '0') && (mod || ![' ', '?', 'k', '0', '+', '=', '-'].includes(k))) return;
    const any = this.selectedObjs().length > 0, sel = this.selectedObj();
    if (mod) {
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
      else if (k === 'y') { e.preventDefault(); this.redo(); }
      else if (k === 'c') { if (this.copySelected()) e.preventDefault(); }
      else if (k === 'x') { if (this.copySelected()) { e.preventDefault(); this.deleteSelected(); } }
      else if (k === 'v') { if (clipboard?.length) { e.preventDefault(); this.paste(); } }
      else if (k === 'd') { e.preventDefault(); this.duplicateSelected(); }
      else if (k === 'a') { e.preventDefault(); this.select(this.selectable().map((o) => o.id)); if (this.tool !== 'select') this.setTool('select'); this.syncToolbar(); this.redrawOverlay(); }
      // Everything saves as you go; don't let the browser offer to save the page.
      else if (k === 's') { e.preventDefault(); toast('Saved: every change is kept as you make it'); }
      else if (k === '0') { e.preventDefault(); this.fit(); }
      else if (letter === 'g') { e.preventDefault(); if (e.shiftKey) this.ungroupSelected(); else this.groupSelected(); }
      else if (letter === 'l') { e.preventDefault(); if (e.shiftKey) this.unlockAll(); else this.lockSelected(); }
      else if (code === 'ArrowUp' || code === 'ArrowDown') {
        e.preventDefault();
        const up = code === 'ArrowUp';
        // Ctrl Shift: the layer (the selection's, or the one drawn on); Ctrl: order within it.
        if (e.shiftKey) { if (any) this.moveSelectedLayer(up); else this.stepActiveLayer(up); }
        else if (any) this.stepZ(up ? 1 : -1);
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      // Space pans; it mustn't also press whichever toolbar button has focus.
      if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
      if (!this.spaceDown) { this.spaceDown = true; this.syncToolbar(); }
      return;
    }
    if (e.key === '?' || (letter === 'k' && !e.altKey)) { e.preventDefault(); showShortcuts(); return; }
    if (e.key === '/') { e.preventDefault(); this.togglePanel('.layers-panel', () => this.renderLayers()); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (this.prevTool && TOOLS.some(([t]) => t === this.prevTool)) this.setTool(this.prevTool); return; }
    if (code === 'Backquote') { e.preventDefault(); this.restoreSelection(); return; }
    if (this.poly) {
      if (e.key === 'Enter') { e.preventDefault(); this.finishPoly(); return; }
      if (e.key === 'Escape') { this.poly = null; this.redrawOverlay(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); this.poly.splice(-2); if (!this.poly.length) this.poly = null; this.redrawOverlay(); return; }
    }
    if (any && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); this.deleteSelected(); return; }
    if (sel?.kind === 'label' && e.key === 'Enter') { e.preventDefault(); this.editLabel(sel); return; }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    // Alt ← →: the next or previous picture in the stamp's set.
    if (arrow && e.altKey && (this.tool === 'stamp' || this.tool === 'scatter')) { if (arrow[0]) { e.preventDefault(); this.stepSet(arrow[0]); } return; }
    // Arrows nudge the selection: a screen pixel, or ten with Shift.
    if (any && arrow) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / this.s;
      const objs = this.selectedObjs();
      this.commit({ undo: objs.map(clean), redo: objs.map((o) => ({ ...clean(o), ...shifted(o, arrow[0] * step, arrow[1] * step) })) });
      return;
    }
    // Shift ↑ ↓ with nothing selected: the slider last moved.
    if (arrow && !arrow[0] && e.shiftKey && this.lastRange?.isConnected && !this.lastRange.closest('[hidden]')) {
      e.preventDefault();
      const r = this.lastRange, span = (+r.max - +r.min) / 20;
      r.value = Math.max(+r.min, Math.min(+r.max, +r.value - arrow[1] * Math.max(span, +r.step || 1)));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // Escape first drops whatever is half done (a stroke, a box, a move).
    if (e.key === 'Escape' && this.gesture && this.gesture.kind !== 'pinch') { this.restore(this.gesture); this.gesture = null; this.pointers.clear(); this.syncToolbar(); this.redraw(); return; }
    if (e.key === 'Escape') { this.clearSel(); this.closePanels(); this.syncToolbar(); this.redrawOverlay(); return; }
    if (this.toolKey(e, letter, big, any)) { e.preventDefault(); return; }
    // Number keys: opacity, or strength (10–90%, and 0 for 100%), by key position.
    const digit = /^Digit(\d)$/.exec(code)?.[1];
    if (digit != null && !e.shiftKey && !e.altKey && this.brushSetting('opacity', null, digit === '0' ? 1 : +digit / 10)) { e.preventDefault(); return; }
    if (letter === 'g' && !e.altKey) { this.toggleSnap(); return; }
    if (letter && KEYS[letter] && !e.altKey && !e.shiftKey) {
      this.setTool(letter === 'o' ? load('ac.stampPlace', 'stamp') : KEYS[letter]);
      return;
    }
    if (k === '0') this.fit();
    else if (k === '+' || k === '=') this.zoomAt(this.vw / 2, this.vh / 2, 1.25);
    else if (k === '-') this.zoomAt(this.vw / 2, this.vh / 2, 0.8);
    else if (code === 'BracketLeft' || code === 'BracketRight') {
      const up = code === 'BracketRight';
      if (any && this.tool === 'select') { if (up) this.toFront(); else this.toBack(); }
      else if (e.shiftKey) this.brushSetting('soft', up ? 0.1 : -0.1);
      else this.resizeBrush(up);
    }
  }

  // The keys that change the current tool's settings (Inkarnate's layout):
  // W S size, E D opacity, Q A softness (the stamp's area; Alt: density),
  // F the art or texture catalogue, X land ↔ water, < > turn. Shift takes
  // larger steps. True when the key was used.
  toolKey(e, letter, big, any) {
    const tool = this.tool, code = e.code;
    const turn = code === 'Comma' || code === 'Period' ? (code === 'Period' ? 1 : -1) : 0;
    if (tool === 'select') {
      if (!any) return false;
      if (letter === 'w' || letter === 's') { this.scaleSelected(letter === 'w' ? (big ? 1.25 : 1.05) : 1 / (big ? 1.25 : 1.05)); return true; }
      if (turn) { this.rotateSelected(turn * (big ? 15 : 5)); return true; }
      if (letter === 'f') { this.flipSelected(); return true; }
      return false;
    }
    if (tool === 'text') {
      const target = this.textTarget();
      if (letter === 'w' || letter === 's') return this.labelSetting(target, 'size', letter === 'w' ? (big ? 1.25 : 1.1) : 1 / (big ? 1.25 : 1.1));
      if (letter === 'q' || letter === 'a') return this.labelSetting(target, 'curve', (letter === 'q' ? 1 : -1) * (big ? 0.25 : 0.05));
      if (code === 'BracketLeft' || code === 'BracketRight') return this.labelSetting(target, 'font', code === 'BracketRight' ? 1 : -1);
      return false;
    }
    if (tool === 'shape') {
      const sh = this.shapeStyle;
      if (letter === 'w' || letter === 's') { this.setShapeStyle({ strokeWidth: Math.max(1, Math.min(60, sh.strokeWidth + (letter === 'w' ? 1 : -1) * (big ? 5 : 1))), stroke: true }); toast(`Outline ${this.shapeStyle.strokeWidth}`, 900); return true; }
      if (letter === 'e' || letter === 'd') { this.setShapeStyle({ opacity: Math.round(Math.max(0.1, Math.min(1, sh.opacity + (letter === 'e' ? 1 : -1) * (big ? 0.2 : 0.05))) * 100) / 100 }); toast(`Opacity ${Math.round(this.shapeStyle.opacity * 100)}%`, 900); return true; }
      if (letter === 'x') { this.shapeMode = this.shapeMode === 'add' ? 'subtract' : 'add'; this.syncToolbar(); toast(this.shapeMode === 'add' ? 'Adding shapes' : 'Cutting shapes out', 1200); return true; }
      if (letter === 'f') { this.togglePicker('shapeFill'); return true; }
      return false;
    }
    if (letter === 'w' || letter === 's') return this.resizeBrush(letter === 'w', big);
    if (tool === 'land' && letter === 'x') {
      this.landMode = this.landMode === 'add' ? 'erase' : 'add';
      keep('ac.landMode', this.landMode);
      this.syncToolbar();
      this.redrawOverlay();
      toast(this.landMode === 'add' ? 'Painting land' : 'Painting water', 1200);
      return true;
    }
    const stamping = tool === 'stamp' || tool === 'scatter';
    if (letter === 'f' && e.shiftKey && tool === 'stamp') { this.flipStamp(); return true; }
    if (letter === 'f') {
      if (stamping) { this.togglePicker('stamp'); return true; }
      if (tool === 'terrain') { this.togglePicker('terrain'); return true; }
      return false;
    }
    if (letter === 'e' || letter === 'd') return this.brushSetting('opacity', (letter === 'e' ? 1 : -1) * (big ? 0.2 : 0.05));
    if (stamping && (letter === 'q' || letter === 'a')) {
      const up = letter === 'q', sc = this.scatter;
      if (e.altKey) sc.spacing = Math.round(Math.max(0.15, Math.min(2, sc.spacing * (up ? 1 / 1.15 : 1.15) ** (big ? 3 : 1))) * 100) / 100;
      else sc.spread = Math.round(Math.max(0, Math.min(2, sc.spread + (up ? 1 : -1) * (big ? 0.3 : 0.1))) * 100) / 100;
      keep('ac.scatter', sc);
      this.renderScatter();
      this.flashSize();
      toast(e.altKey ? `Density ${Math.round(100 * 0.6 / sc.spacing)}%` : `Area ${Math.round(sc.spread * 100)}%`, 1000);
      return true;
    }
    if (letter === 'q' || letter === 'a') return this.brushSetting('soft', (letter === 'q' ? 1 : -1) * (big ? 0.2 : 0.05));
    if (turn && tool === 'stamp') { this.turnStamp(turn * (big ? 45 : 15)); return true; }
    return false;
  }

  // --- shapes -----------------------------------------------------------

  // A new shape object from its outline, with the current look.
  newShape(geom) {
    const st = this.shapeStyle;
    return {
      id: uid(), kind: 'shape', ...this.layerField(), ...geom,
      fill: st.fill, fillColor: st.fillColor, fillTex: st.fillTex, stroke: st.stroke, strokeColor: st.strokeColor,
      strokeWidth: st.strokeWidth, dash: st.dash, opacity: st.opacity,
      ...(this.shapeMode === 'subtract' ? { mode: 'subtract' } : {}), ...(this.shapeMerge ? {} : { merge: false }),
      z: this.nextZ(),
    };
  }

  // A drag's shape: a rectangle or ellipse from corner to corner (Shift:
  // square or circle; Alt: from the middle), or the freehand outline. Null
  // while it's too small to keep.
  shapeFromGesture(g, final = false) {
    const min = 4 / this.s;
    if (this.shapeKind === 'free') {
      const p = final ? simplify(g.points, Math.max(1, 1.5 / this.s)) : g.points;
      if (p.length < 6) return null;
      const b = pointsBox(p);
      if (b[2] - b[0] < min && b[3] - b[1] < min) return null;
      return { ...this.newShape({ shape: 'poly', points: p.slice() }), id: g.id };
    }
    let dx = g.to[0] - g.from[0], dy = g.to[1] - g.from[1];
    if (g.square) { const d = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * d; dy = Math.sign(dy || 1) * d; }
    const [w, h] = g.centred ? [Math.abs(dx) * 2, Math.abs(dy) * 2] : [Math.abs(dx), Math.abs(dy)];
    if (w < min || h < min) return null;
    const [x, y] = g.centred ? g.from : [g.from[0] + dx / 2, g.from[1] + dy / 2];
    return { ...this.newShape({ shape: this.shapeKind, x: r1(x), y: r1(y), w: r1(w), h: r1(h), rot: 0 }), id: g.id };
  }

  // Polygons are clicked out point by point; clicking the first point again
  // (or the last one twice, or Enter) finishes.
  polyClick(x, y) {
    const p = this.poly;
    if (!p) { this.poly = [x, y]; this.redrawOverlay(); return; }
    const near = (i) => Math.hypot(x - p[i], y - p[i + 1]) * this.s <= HANDLE + 4;
    if (p.length >= 6 && (near(0) || near(p.length - 2))) { this.finishPoly(); return; }
    p.push(x, y);
    this.redrawOverlay();
  }

  finishPoly() {
    const p = this.poly;
    this.poly = null;
    if (!p || p.length < 6) { this.redrawOverlay(); return; }
    const o = this.newShape({ shape: 'poly', points: p });
    this.commit({ undo: [{ id: o.id, deleted: true }], redo: [o] });
  }

  // Cut-outs draw nothing themselves, so they're outlined faintly while
  // shapes are being drawn or selected, to be found again.
  paintCutouts() {
    const { octx: ctx } = this;
    const cuts = this.live().filter((o) => o.kind === 'shape' && o.mode === 'subtract');
    if (!cuts.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(196, 85, 59, .7)';
    ctx.lineWidth = 1 / this.s;
    ctx.setLineDash([4 / this.s, 4 / this.s]);
    for (const o of cuts) { ctx.beginPath(); shapePath(ctx, o); ctx.stroke(); }
    ctx.restore();
  }

  paintPoly() {
    const { octx: ctx } = this;
    const p = [...this.poly, ...(this.hover ? [this.snapped(this.hover[0]), this.snapped(this.hover[1])] : [])];
    if (p.length >= 6) drawShapeGroup(ctx, { adds: [{ ...this.newShape({ shape: 'poly', points: p }), opacity: 0.6 * this.shapeStyle.opacity }], subs: [] }, (id) => images.get(id), mapStyle(this.doc));
    ctx.strokeStyle = '#c4553b';
    ctx.lineWidth = 1.5 / this.s;
    ctx.setLineDash([5 / this.s, 4 / this.s]);
    ctx.beginPath();
    for (let i = 0; i < p.length; i += 2) ctx[i ? 'lineTo' : 'moveTo'](p[i], p[i + 1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff4ea';
    for (let i = 0; i < this.poly.length; i += 2) { ctx.beginPath(); ctx.arc(this.poly[i], this.poly[i + 1], (i ? 3 : 5) / this.s, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }

  // --- selection helpers (keys) -------------------------------------------

  clearSel() {
    if (this.sel.size) this.lastSel = [...this.sel];
    this.sel.clear();
  }

  restoreSelection() {
    const ids = this.lastSel.filter((id) => this.get(id));
    if (!ids.length) return;
    if (this.tool !== 'select') this.setTool('select');
    this.select(ids);
    this.syncToolbar();
    this.redrawOverlay();
  }

  // Ids, plus everything grouped with them.
  withGroups(ids) {
    const groups = new Set(ids.map((id) => this.get(id)?.group).filter(Boolean));
    if (!groups.size) return ids;
    const out = new Set(ids);
    for (const o of this.selectable()) if (groups.has(o.group)) out.add(o.id);
    return [...out];
  }

  groupSelected() {
    const objs = this.selectedObjs();
    if (objs.length < 2) { toast('Select two or more things to group'); return; }
    const group = uid();
    this.editSelected({ group });
    toast(`Grouped ${objs.length}: they now select and move together`);
  }

  ungroupSelected() {
    if (!this.selectedObjs().some((o) => o.group)) return;
    this.editSelected({ group: null });
    toast('Ungrouped');
  }

  // Locked things can't be picked, moved or erased until unlocked (Ctrl Shift L).
  lockSelected() {
    const n = this.selectedObjs().length;
    if (!n) { toast('Select something to lock (Ctrl Shift L unlocks everything)'); return; }
    this.editSelected({ locked: true });
    this.clearSel();
    this.syncToolbar();
    toast(`Locked ${n}. Ctrl Shift L unlocks everything`);
  }

  unlockAll() {
    const objs = store.liveObjects(this.doc).filter((o) => o.locked);
    if (!objs.length) { toast('Nothing is locked'); return; }
    this.commit({ undo: objs.map(clean), redo: objs.map((o) => ({ ...clean(o), locked: null })) });
    toast(`Unlocked ${objs.length}`);
  }

  // One step forward or back: past the next thing above or below each
  // selected one (among things on the same layer that it overlaps), rather
  // than all the way to the front or back.
  stepZ(dir) {
    const objs = this.selectedObjs();
    if (!objs.length) return;
    const ids = new Set(objs.map((o) => o.id));
    const lay = layerResolver(this.doc);
    const others = this.live().filter((o) => !ids.has(o.id) && o.kind !== 'style' && o.kind !== 'land');
    const overlaps = (a, b) => { const p = this.box(a), q = this.box(b); return Math.abs(p.cx - q.cx) * 2 <= p.w + q.w + 1 && Math.abs(p.cy - q.cy) * 2 <= p.h + q.h + 1; };
    this.editSelected((o) => {
      const z = o.z || 0;
      const near = others.filter((x) => lay(x) === lay(o) && overlaps(x, o) && (dir > 0 ? (x.z || 0) >= z : (x.z || 0) <= z))
        .map((x) => x.z || 0).sort((a, b) => dir * (a - b))[0];
      return near == null ? {} : { z: near + dir * 0.5 };
    });
  }

  // The layers in drawing order, top first, that things can go on.
  pickableLayers() { return this.layers().map((l) => l.id); }

  moveSelectedLayer(up) {
    const ids = this.pickableLayers();
    const objs = this.selectedObjs();
    if (!objs.length) return;
    const cur = ids.indexOf(this.lay(objs[0]));
    const next = ids[cur + (up ? -1 : 1)];
    if (cur < 0 || next == null) { toast(up ? 'Already on the top layer' : 'Already on the bottom layer'); return; }
    if (this.locked.has(next)) { toast(`The ${this.layerName(next)} layer is locked`); return; }
    this.editSelected({ layer: next });
    toast(`Moved to ${this.layerName(next)}`);
  }

  stepActiveLayer(up) {
    const ids = this.pickableLayers();
    const cur = ids.indexOf(this.active() || this.toolLayer());
    const next = ids[Math.max(0, Math.min(ids.length - 1, (cur < 0 ? 0 : cur) + (up ? -1 : 1)))];
    if (!next) return;
    this.setActiveLayer(next);
    toast(`Drawing on ${this.layerName(next)}`);
  }

  scaleSelected(k) {
    const objs = this.selectedObjs();
    if (!objs.length) return;
    // Around the selection's middle, so a group keeps its arrangement.
    const bs = objs.map((o) => this.box(o));
    const cx = (Math.min(...bs.map((b) => b.cx - b.w / 2)) + Math.max(...bs.map((b) => b.cx + b.w / 2))) / 2;
    const cy = (Math.min(...bs.map((b) => b.cy - b.h / 2)) + Math.max(...bs.map((b) => b.cy + b.h / 2))) / 2;
    this.editSelected((o) => {
      const t = store.transformObject(clean(o), k, cx * (1 - k), cy * (1 - k));
      // Lines keep their width; only their shape grows.
      if (o.kind === 'path') t.width = o.width;
      if (o.kind === 'shape') t.strokeWidth = o.strokeWidth;
      return t;
    });
  }

  rotateSelected(deg) {
    const objs = this.selectedObjs();
    if (!objs.length) return;
    const a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const bs = objs.map((o) => this.box(o));
    const cx = bs.reduce((n, b) => n + b.cx, 0) / bs.length, cy = bs.reduce((n, b) => n + b.cy, 0) / bs.length;
    const turn = (x, y) => [r1(cx + (x - cx) * cos - (y - cy) * sin), r1(cy + (x - cx) * sin + (y - cy) * cos)];
    const turnPts = (p) => { const out = []; for (let i = 0; i < p.length; i += 2) out.push(...turn(p[i], p[i + 1])); return out; };
    this.editSelected((o) => {
      if (ptsKey(o) === 'points') return { points: turnPts(o.points) };
      const [x, y] = objs.length > 1 ? turn(o.x, o.y) : [o.x, o.y];
      return { x, y, rot: Math.round(((o.rot || 0) + a) * 1000) / 1000, ...(o.along ? { along: turnPts(o.along) } : {}) };
    });
  }

  // The text tool's keys change the label just made or edited (while it's
  // still selected), or else how the next one starts.
  textTarget() { const o = this.selectedObj(); return o?.kind === 'label' ? o : null; }

  labelSetting(o, field, step) {
    const base = o || { font: 'serif', curve: 0, size: Math.round(Math.max(this.project.width, this.project.height) / 40), ...load('ac.labelStyle', {}) };
    let v;
    if (field === 'size') v = Math.max(4, Math.round(base.size * step));
    else if (field === 'curve') { if (o?.along) { toast('Text along a line follows its line'); return true; } v = Math.round(Math.max(-1, Math.min(1, (base.curve || 0) + step)) * 100) / 100; }
    else { const keys = Object.keys(FONTS); v = keys[(keys.indexOf(base.font) + step + keys.length) % keys.length]; }
    if (o) this.commit({ undo: [clean(o)], redo: [{ ...clean(o), [field]: v }] });
    else keep('ac.labelStyle', { ...load('ac.labelStyle', {}), [field]: v });
    toast(`${o ? '' : 'Next label: '}${field === 'size' ? `size ${v}` : field === 'curve' ? `curve ${Math.round(v * 100)}` : FONTS[v][0]}`, 1000);
    return true;
  }

  // Alt ← →: the next or previous variation of the stamp (the pictures in
  // its folder, or numbered alike), or of its category when it has none.
  stepSet(dir) {
    const a = this.brush.map((id) => A.asset(id)).find(Boolean);
    if (!a) { this.openPicker(); return; }
    const set = A.variationsOf(a);
    const list = set.length > 1 ? set : A.categoryAssets(a.pack, A.groupOf(a));
    const i = list.findIndex((x) => x.id === a.id);
    const next = list[(i + dir + list.length) % list.length];
    this.setBrush([next.id]);
    this.redrawOverlay();
    toast(`${next.name} · ${list.indexOf(next) + 1} of ${list.length}`, 1200);
  }

  toggleSnap() {
    this.snap = !this.snap;
    keep('ac.snap', this.snap);
    toast(this.snap ? `Snap to grid on (every ${this.gridStep()} map pixels)` : 'Snap to grid off', 1400);
  }

  // Snapping goes to half the grid's size: the middle of each square and its edges.
  gridStep() { return Math.max(4, Math.round((mapStyle(this.doc).gridSize || 128) / 2)); }
  snapped(v) { if (!this.snap) return v; const g = this.gridStep(); return r1(Math.round(v / g) * g); }

  // W S, [ ] and Alt + wheel: the current tool's size (Shift: larger steps). False for tools without one.
  resizeBrush(up, big = false) {
    const k = big ? 1.5 : 1;
    if (!['pen', 'eraser', 'land', 'terrain', 'path', 'stamp', 'scatter'].includes(this.tool)) return false;
    if (this.tool === 'stamp' || this.tool === 'scatter') {
      this.stampSize = Math.max(16, Math.min(2048, Math.round(this.stampSize * (up ? 1.15 * k : 1 / (1.15 * k)))));
      keep('ac.stampSize', this.stampSize);
    } else if (this.tool === 'land') {
      this.landSize = Math.max(16, Math.min(2048, Math.round(this.landSize * (up ? 1.15 * k : 1 / (1.15 * k)))));
      keep('ac.landSize', this.landSize);
    } else if (this.tool === 'path') {
      this.pathWidth = Math.max(2, Math.min(160, Math.round(this.pathWidth * (up ? 1.2 * k : 1 / (1.2 * k)))));
      keep('ac.pathWidth', this.pathWidth);
    } else if (this.tool === 'terrain') {
      this.terrainSize = Math.max(16, Math.min(2048, Math.round(this.terrainSize * (up ? 1.15 * k : 1 / (1.15 * k)))));
      keep('ac.terrainSize', this.terrainSize);
    } else {
      this.width = Math.max(2, Math.min(800, Math.round(this.width * (up ? 1.2 * k : 1 / (1.2 * k)))));
      keep('ac.width', this.width);
    }
    this.syncToolbar();
    this.flashSize();
    return true;
  }

  // Shift [ ] and the number keys: soft edges and opacity (strength, for
  // terrain) of the tools that have them. Steps by delta, or sets value.
  brushSetting(which, delta, value) {
    const field = { pen: { soft: 'penSoft', opacity: 'penOpacity' }, terrain: { soft: 'terrainSoft', opacity: 'terrainOpacity' }, stamp: { opacity: 'stampOpacity' }, scatter: { opacity: 'stampOpacity' } }[this.tool]?.[which];
    if (!field) return false;
    const min = which === 'soft' ? 0 : this.tool === 'pen' ? 0.05 : 0.1;
    this[field] = Math.round(Math.max(min, Math.min(1, value ?? this[field] + delta)) * 100) / 100;
    keep('ac.' + field, this[field]);
    this.syncToolbar();
    this.redrawOverlay();
    toast(`${which === 'soft' ? 'Softness' : this.tool === 'terrain' ? 'Strength' : 'Opacity'} ${Math.round(this[field] * 100)}%`, 1000);
    return true;
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
    } else if (this.tool === 'shape') {
      const [sx, sy] = [this.snapped(r1(mx)), this.snapped(r1(my))];
      if (this.shapeKind === 'poly') { this.polyClick(sx, sy); this.gesture = { kind: 'noop' }; return; }
      this.gesture = { kind: 'shape', id: uid(), from: [sx, sy], to: [sx, sy], points: [sx, sy] };
    } else if (this.tool === 'stamp') {
      const o = this.newStamp(this.snapped(mx), this.snapped(my), this.stampSize, { flip: this.stampFlip, rot: this.stampRot * Math.PI / 180 });
      if (!o) { this.openPicker(); toast('Choose some art first'); return; }
      o.z = this.nextZ();
      this.preview.set(o.id, o);
      this.gesture = { kind: 'place', id: o.id, from: [mx, my], orig: { ...o } };
    } else if (this.tool === 'scatter') {
      if (!this.brush.some((id) => A.asset(id))) { this.openPicker(); toast('Choose some art first'); return; }
      this.gesture = { kind: 'scatter', placed: [], last: null };
      this.scatterAt(mx, my);
    }
    this.syncToolbar();
    // Starting most gestures changes nothing yet; these ones do (or the view moves).
    if (!this.gesture || ['pan', 'place', 'node'].includes(this.gesture.kind)) this.redraw(); else this.redrawOverlay();
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
        this.preview.set(sel.id, { ...sel, [key]: p });
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
    // Shift or Ctrl click adds or removes (a group as one).
    if (hit && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      const ids = this.withGroups([hit.id]);
      const on = !this.sel.has(hit.id);
      for (const id of ids) if (on) this.sel.add(id); else this.sel.delete(id);
      return { kind: 'noop' };
    }
    if (hit) {
      if (!this.sel.has(hit.id)) this.select(this.withGroups([hit.id]));
      return { kind: 'move', origs: this.selectedObjs().map(clean), from: [mx, my] };
    }
    if (e.pointerType === 'touch') { this.clearSel(); return null; }
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) this.clearSel();
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
      this.preview.set(g.id, { ...this.get(g.id), x: this.snapped(r1(o.x + mx - g.from[0])), y: this.snapped(r1(o.y + my - g.from[1])) });
    } else if (g.kind === 'move') {
      // With snapping, the first thing's middle lands on the grid and the rest keep their places around it.
      let dx = mx - g.from[0], dy = my - g.from[1];
      if (this.snap && g.origs[0]) { const b = this.box(g.origs[0]); dx = this.snapped(b.cx + dx) - b.cx; dy = this.snapped(b.cy + dy) - b.cy; }
      for (const o of g.origs) this.preview.set(o.id, { ...this.get(o.id), ...shifted(o, dx, dy) });
      g.moved = true;
    } else if (g.kind === 'marquee') {
      g.b = [mx, my];
      const [x0, x1] = [Math.min(g.a[0], mx), Math.max(g.a[0], mx)], [y0, y1] = [Math.min(g.a[1], my), Math.max(g.a[1], my)];
      const inside = this.selectable().filter((o) => { const b = this.box(o); return b.cx >= x0 && b.cx <= x1 && b.cy >= y0 && b.cy <= y1; });
      this.select([...g.base, ...this.withGroups(inside.map((o) => o.id))]);
    } else if (g.kind === 'scale') {
      const o = g.orig;
      const k = Math.hypot(mx - o.x, my - o.y) / g.d0;
      this.preview.set(g.id, o.kind === 'label'
        ? { ...this.get(g.id), size: r1(Math.max(4, o.size * k)) }
        : { ...this.get(g.id), ...((s) => ({ w: r1(o.w * s), h: r1(o.h * s) }))(Math.max(4 / Math.max(o.w, o.h), k)) });
      g.moved = true;
    } else if (g.kind === 'rotate') {
      let rot = (g.orig.rot || 0) + Math.atan2(my - g.orig.y, mx - g.orig.x) - g.a0;
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12); // 15° steps
      this.preview.set(g.id, { ...this.get(g.id), rot: Math.round(rot * 1000) / 1000 });
      g.moved = true;
    } else if (g.kind === 'shape') {
      const to = [this.snapped(r1(mx)), this.snapped(r1(my))];
      if (this.shapeKind === 'free') {
        const p = g.points;
        if (Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]) * this.s >= 3) p.push(r1(mx), r1(my));
      }
      g.to = to; g.square = e.shiftKey; g.centred = e.altKey;
      const o = this.shapeFromGesture(g);
      if (o) this.preview.set(g.id, o); else this.preview.delete(g.id);
    } else if (g.kind === 'scatter') {
      this.scatterAt(mx, my);
    } else if (g.kind === 'node') {
      const cur = this.get(g.id), p = cur[g.key].slice();
      p[2 * g.i] = r1(mx); p[2 * g.i + 1] = r1(my);
      this.preview.set(g.id, { ...cur, [g.key]: p, ...(g.key === 'along' ? { x: r1(p[0]), y: r1(p[1]) } : {}) });
      g.moved = true;
    } else if (g.kind === 'textpath') {
      const p = g.points;
      if (Math.hypot(mx - p[p.length - 2], my - p[p.length - 1]) * this.s >= 4) p.push(r1(mx), r1(my));
    }
    this.gestureRedraw();
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
      const o = clean(this.get(g.id));
      useRecent('stamp', [o.asset]);
      this.commit({ undo: [{ id: o.id, deleted: true }], redo: [o] });
    } else if (g.kind === 'move' && g.moved) {
      this.commit({ undo: g.origs, redo: g.origs.map((o) => clean(this.get(o.id))) });
    } else if (g.kind === 'node' && g.moved) {
      this.commit({ undo: [g.orig], redo: [clean(this.get(g.id))] });
    } else if (g.kind === 'textpath') {
      // A click places an ordinary label; a drag, text along what was drawn.
      const p = g.points, len = p.length / 2;
      let L = 0;
      for (let i = 1; i < len; i++) L += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
      if (L * this.s < 24) this.newLabel(p[0], p[1]);
      else this.newLabel(p[0], p[1], simplify(p, 2.5 / this.s));
    } else if ((g.kind === 'scale' || g.kind === 'rotate') && g.moved) {
      this.commit({ undo: [g.orig], redo: [clean(this.get(g.id))] });
    } else if (g.kind === 'shape') {
      const o = this.shapeFromGesture(g, true);
      if (o) this.commit({ undo: [{ id: o.id, deleted: true }], redo: [o] });
    } else if (g.kind === 'scatter' && g.placed.length) {
      // Stamps lower on the map overlap the ones behind them, like a landscape.
      const z0 = this.nextZ();
      useRecent('stamp', [...new Set(g.placed.map((id) => this.get(id).asset))]);
      const placed = g.placed.map((id) => this.get(id)).sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2))
        .map((o, i) => ({ ...clean(o), z: z0 + i }));
      this.commit({ undo: placed.map((o) => ({ id: o.id, deleted: true })), redo: placed });
    }
    // The committed objects are in the drawing by now (commit applies them at
    // once, before anything is drawn), so the gesture's stand-ins can go.
    this.preview.clear();
    this.syncToolbar();
    // The map changes if the drawing did (a click that only selected leaves it alone).
    if (g.moved || ['draw', 'land', 'terrain', 'path', 'erase', 'place', 'scatter', 'textpath', 'shape'].includes(g.kind)) this.redraw(); else this.redrawOverlay();
  }

  // Drop whatever an unfinished gesture changed on screen: it never reached the drawing.
  restore() {
    this.preview.clear();
  }

  abandon() {
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'erase') {
      // Erasing is committed rather than dropped: what was erased stays erased.
      this.gesture = null;
      if (g.erased.size) { const gone = [...g.erased.values()]; this.commit({ undo: gone.map(clean), redo: gone.map((o) => ({ id: o.id, deleted: true })) }); }
      this.preview.clear();
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
    this.preview.set(o.id, o);
    g.placed.push(o.id);
    this.redraw();
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
      this.preview.set(o.id, null);
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
const SELECTABLE = ['stamp', 'label', 'path', 'shape'];

// Which field holds an object's editable points, if it has them.
const ptsKey = (o) => (o.kind === 'path' || (o.kind === 'shape' && o.shape === 'poly') ? 'points' : o.kind === 'label' && o.along ? 'along' : null);

// The fields that change when an object moves by (dx, dy).
function shifted(o, dx, dy) {
  const move = (p) => p.map((v, i) => r1(v + (i % 2 ? dy : dx)));
  if (ptsKey(o) === 'points') return { points: move(o.points) };
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
// Laid out like Inkarnate's own list, so the same keys work in both.
export const SHORTCUTS = [
  ['Everywhere', [['Wheel', 'Zoom'], ['Space, or the middle button, and drag', 'Move the view'], ['K or ?', 'This list'], ['/', 'Layers panel'],
    ['Ctrl Z / Ctrl Shift Z (or Y)', 'Undo / redo'], ['G', 'Snap stamps to the grid, on or off'], ['Ctrl Shift ↑ ↓', 'Layer to draw on: up / down'],
    ['Shift ↑ ↓', 'The slider last moved: up / down'], ['Tab', 'Previous tool'], ['0, or Ctrl 0', 'Fit the map'], ['+  −', 'Zoom']]],
  ['Tools', [['V', 'Select'], ['M', 'Land and water'], ['B', 'Brush (textures)'], ['O', 'Stamp'], ['R', 'Shapes'], ['L', 'Lines'], ['T', 'Text'],
    ['P', 'Pen'], ['U', 'Eraser'], ['H', 'Move the view']]],
  ['Select', [['Ctrl A', 'Select all'], ['` or ~', 'Bring back the last selection'], ['Esc', 'Deselect (or cancel what’s half done)'],
    ['Del or Backspace', 'Delete'], ['Ctrl C / X / V, Ctrl D', 'Copy, cut, paste, duplicate'], ['Ctrl G / Ctrl Shift G', 'Group / ungroup'],
    ['Ctrl L / Ctrl Shift L', 'Lock / unlock everything'], ['Arrows', 'Move'], ['W / S, or Shift + wheel', 'Larger / smaller'],
    ['> / <, or Ctrl + wheel', 'Turn (Ctrl Alt + wheel: finely)'], ['Ctrl ↑ ↓', 'Forward / backward'], ['[  ]', 'To the back / front'],
    ['Ctrl Shift ↑ ↓', 'Move to the layer above / below'], ['Shift, dragging the round handle', 'Turn in 15° steps'], ['F', 'Flip'],
    ['Ctrl or Shift click, or drag', 'Add to / take from the selection'], ['Enter, or double-click', 'Edit a label'], ['Alt-click a path point', 'Remove it']]],
  ['Land', [['X', 'Paint land / water'], ['Alt (hold)', 'The other one, for one stroke'], ['W / S, or Shift + wheel', 'Brush size']]],
  ['Brush', [['F', 'Texture catalogue'], ['W / S, or Shift + wheel', 'Size'], ['E / D', 'Strength'], ['Q / A', 'Softness']]],
  ['Stamp', [['F', 'Stamp catalogue'], ['W / S, or Shift + wheel', 'Size'], ['E / D', 'Opacity'], ['Q / A', 'Area (placing many)'], ['Alt Q / Alt A', 'Density (placing many)'],
    ['Alt → ←, or Alt + wheel', 'Next / previous in the set'], ['> / <', 'Turn the next stamp'], ['Shift F', 'Flip the next stamp'],
    ['Ctrl click a picture', 'Pick several to place at random']]],
  ['Shape', [['X', 'Add / cut out'], ['W / S', 'Outline width'], ['E / D', 'Opacity'], ['F', 'Fill texture'],
    ['Shift (dragging)', 'Square or circle'], ['Alt (dragging)', 'Draw from the middle'],
    ['Click the first point, or Enter', 'Finish a polygon'], ['Backspace', 'Take back the last point'], ['Esc', 'Drop the polygon']]],
  ['Text', [['W / S', 'Size'], [']  [', 'Next / previous font'], ['Q / A', 'Curve']]],
  ['Pen, lines and eraser', [['W / S', 'Size'], ['E / D', 'Opacity (pen)'], ['Q / A', 'Softness (pen)']]],
];

function showShortcuts() {
  if (document.getElementById('modal-root').childElementCount) return;
  modal('Keyboard shortcuts', SHORTCUTS.map(([group, rows]) => `<div class="field-label">${group}</div>
    <table class="keys">${rows.map(([k, what]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(what)}</td></tr>`).join('')}</table>`).join('')
    + '<p class="muted small">Hold Shift for larger steps. Number keys 1–9 and 0 also set opacity (10–90%, 100%). On a Mac, Cmd works wherever Ctrl is shown.</p>', { wide: true });
}
