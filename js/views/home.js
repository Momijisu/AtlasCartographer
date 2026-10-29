// The project list: every map on this device (and, once synced, OneDrive).
import * as store from '../store.js';
import { $, $$, esc, modal, confirmDialog, toast, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';
import { drawThumb } from '../render.js';
import * as images from '../images.js';

export const SIZES = [
  { label: 'Landscape', width: 4096, height: 3072 },
  { label: 'Wide', width: 4096, height: 2304 },
  { label: 'Square', width: 3072, height: 3072 },
  { label: 'Portrait', width: 3072, height: 4096 },
];

// Map types: the same editor and tools for every map; the
// type sets where a new map starts (its surface, grid and size) and which art
// packs the picker shows first. All of it can be changed later in Map style.
export const MAP_TYPES = {
  world: { label: 'World', note: 'Starts as sea: paint the continents.', style: { surface: 'sea' } },
  region: { label: 'Region', note: 'Starts as sea: paint the coast and land.', style: { surface: 'sea' } },
  city: { label: 'City', note: 'Starts as land: carve rivers and harbours with the water brush.', style: { surface: 'ground' } },
  battlemap: { label: 'Battlemap', note: 'Starts as ground, with a square grid.', style: { surface: 'ground', land: '#a39f78', coastStyle: 'plain', grid: 'square', gridOpacity: 0.35 } },
};
export const typeLabel = (t) => MAP_TYPES[t]?.label || '';
// Battlemaps are measured in squares; virtual tabletops commonly use these sizes.
const SQUARE_PX = [70, 100, 140, 200];
const MAX_SIDE = 8192;

export function viewHome(view) {
  setTitle('');
  const list = store.live();
  view.innerHTML = `
    <div class="page-head"><div><h1>Your maps</h1></div>
      <div class="actions"><button class="btn primary" id="newProject">${icon('plus')} New map</button></div></div>
    ${list.length ? `<div class="project-grid">${list.map((p) => `
      <a class="project-card" href="#/p/${p.id}">
        <canvas data-thumb="${p.id}" width="4" height="3"></canvas>
        <div class="meta"><h3>${esc(p.name)}</h3><div class="sub">${p.type ? `${typeLabel(p.type)} · ` : ''}${p.width} × ${p.height} · edited ${timeAgo(p.updatedAt)}</div></div>
        <button class="icon-btn" data-menu="${p.id}" aria-label="Rename or delete" title="Rename or delete">${icon('dots-three-vertical')}</button>
      </a>`).join('')}</div>`
    : `<div class="empty-state">${icon('map-trifold', 'empty-emblem')}<h2>No maps yet</h2>
        <p>Start a new map. It's saved on this device, and syncs to your other devices once OneDrive is connected in Settings.</p></div>`}`;
  $('#newProject').onclick = newProjectDialog;
  for (const b of $$('[data-menu]', view)) {
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); projectMenu(b.dataset.menu); };
  }
  // Thumbnails draw after the page shows; a drawing that hasn't synced yet stays blank.
  const opts = { image: (id) => images.get(id, { thumbOnly: true }) };
  const paint = (c) => store.getDoc(c.dataset.thumb).then((doc) => { const p = store.project(c.dataset.thumb); if (p && c.isConnected) drawThumb(c, p, doc, opts); });
  for (const c of $$('[data-thumb]', view)) paint(c);
  // Stamps' pictures load after the first paint: redraw as they arrive.
  let t;
  state.cleanup = images.onLoad(() => { clearTimeout(t); t = setTimeout(() => $$('[data-thumb]', view).forEach(paint), 150); });
}

function newProjectDialog() {
  return modal('New map', `<form class="form">
      <label>Name<input name="name" required maxlength="120" placeholder="The Shattered Coast"></label>
      <div class="field-label">Type</div>
      <div class="seg" id="typeSeg">${Object.entries(MAP_TYPES).map(([k, t], i) => `<button type="button" data-t="${k}" class="${i ? '' : 'on'}">${t.label}</button>`).join('')}</div>
      <p class="muted small" id="typeNote"></p>
      <div id="sizeBox"></div>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Create</button></div>
    </form>`, {
    onMount: (m, close) => {
      let type = 'world', size = SIZES[0];
      const squares = { across: 30, down: 20, px: 140 };
      const battleSize = () => ({ width: squares.across * squares.px, height: squares.down * squares.px });
      const drawSize = () => {
        $('#typeNote', m).textContent = MAP_TYPES[type].note;
        const box = $('#sizeBox', m);
        if (type === 'battlemap') {
          const { width, height } = battleSize();
          const tooBig = Math.max(width, height) > MAX_SIDE;
          box.innerHTML = `<div class="field-label">Size in squares</div>
            <div class="row3">
              <label>Across<input type="number" name="across" min="2" max="200" value="${squares.across}"></label>
              <label>Down<input type="number" name="down" min="2" max="200" value="${squares.down}"></label>
              <label>Pixels a square<select name="px">${SQUARE_PX.map((v) => `<option ${v === squares.px ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            </div>
            <p class="small ${tooBig ? 'warn' : 'muted'}">${width} × ${height} pixels${tooBig ? ` — over ${MAX_SIDE} on a side: fewer squares or smaller ones` : ''}</p>`;
          box.oninput = box.onchange = (e) => {
            const t = e.target;
            if (!t.name) return;
            squares[t.name] = Math.max(2, Math.min(200, +t.value || squares[t.name]));
            const { width: w, height: h } = battleSize();
            const p = $('p', box);
            p.className = `small ${Math.max(w, h) > MAX_SIDE ? 'warn' : 'muted'}`;
            p.textContent = `${w} × ${h} pixels${Math.max(w, h) > MAX_SIDE ? ` — over ${MAX_SIDE} on a side: fewer squares or smaller ones` : ''}`;
          };
        } else {
          box.innerHTML = `<div class="field-label">Size</div>
            <div class="seg" id="sizeSeg">${SIZES.map((s, i) => `<button type="button" data-i="${i}" class="${s === size ? 'on' : ''}">${s.label}</button>`).join('')}</div>
            <p class="muted small" id="sizeNote">${size.width} × ${size.height} pixels</p>`;
          box.oninput = box.onchange = null;
          $('#sizeSeg', box).onclick = (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            size = SIZES[b.dataset.i];
            for (const x of $('#sizeSeg', box).children) x.classList.toggle('on', x === b);
            $('#sizeNote', box).textContent = `${size.width} × ${size.height} pixels`;
          };
        }
      };
      drawSize();
      $('#typeSeg', m).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        type = b.dataset.t;
        for (const x of $('#typeSeg', m).children) x.classList.toggle('on', x === b);
        drawSize();
      };
      $('[data-cancel]', m).onclick = () => close(null);
      $('form', m).onsubmit = async (e) => {
        e.preventDefault();
        const name = e.target.name.value.trim();
        if (!name) return;
        const dims = type === 'battlemap' ? battleSize() : size;
        if (Math.max(dims.width, dims.height) > MAX_SIDE) return toast(`Keep each side at ${MAX_SIDE} pixels or less`);
        const style = { ...MAP_TYPES[type].style, ...(type === 'battlemap' ? { gridSize: squares.px } : {}) };
        const p = await store.createProject({ name, ...dims, type, style });
        close(p);
        location.hash = `#/p/${p.id}`;
      };
    },
  });
}

function projectMenu(id) {
  const p = store.project(id);
  if (!p) return;
  return modal(p.name, `<form class="form">
      <label>Name<input name="name" required maxlength="120" value="${esc(p.name)}"></label>
      <div class="actions"><button type="button" class="btn danger" data-del>${icon('trash')} Delete</button><span class="spacer"></span>
        <button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Save</button></div>
    </form>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(null);
      $('[data-del]', m).onclick = async () => {
        close(null);
        if (!(await confirmDialog(`Delete “${p.name}” from all your devices?`))) return;
        await store.deleteProject(id);
        toast('Map deleted');
        state.route();
      };
      $('form', m).onsubmit = async (e) => {
        e.preventDefault();
        const name = e.target.name.value.trim();
        if (!name) return;
        await store.saveProject({ ...store.project(id), name });
        close(null);
        state.route();
      };
    },
  });
}
