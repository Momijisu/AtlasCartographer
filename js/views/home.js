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

export function viewHome(view) {
  setTitle('');
  const list = store.live();
  view.innerHTML = `
    <div class="page-head"><div><h1>Your maps</h1></div>
      <div class="actions"><button class="btn primary" id="newProject">${icon('plus')} New map</button></div></div>
    ${list.length ? `<div class="project-grid">${list.map((p) => `
      <a class="project-card" href="#/p/${p.id}">
        <canvas data-thumb="${p.id}" width="4" height="3"></canvas>
        <div class="meta"><h3>${esc(p.name)}</h3><div class="sub">${p.width} × ${p.height} · edited ${timeAgo(p.updatedAt)}</div></div>
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
      <div class="field-label">Size</div>
      <div class="seg" id="sizeSeg">${SIZES.map((s, i) => `<button type="button" data-i="${i}" class="${i ? '' : 'on'}">${s.label}</button>`).join('')}</div>
      <p class="muted small" id="sizeNote"></p>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Create</button></div>
    </form>`, {
    onMount: (m, close) => {
      let size = SIZES[0];
      const note = () => { $('#sizeNote', m).textContent = `${size.width} × ${size.height} pixels`; };
      note();
      $('#sizeSeg', m).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        size = SIZES[b.dataset.i];
        for (const x of $('#sizeSeg', m).children) x.classList.toggle('on', x === b);
        note();
      };
      $('[data-cancel]', m).onclick = () => close(null);
      $('form', m).onsubmit = async (e) => {
        e.preventDefault();
        const name = e.target.name.value.trim();
        if (!name) return;
        const p = await store.createProject({ name, width: size.width, height: size.height });
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
