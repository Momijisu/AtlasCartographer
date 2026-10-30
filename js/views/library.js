// The art library: import packs, see what's on this device, browse a pack.
import * as A from '../assets.js';
import * as assetsync from '../assetsync.js';
import * as auth from '../auth.js';
import { meta } from '../store.js';
import { readZip } from '../zip.js';
import { $, $$, esc, modal, confirmDialog, toast } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';

const fmtBytes = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n / 1e9).toFixed(1)} GB`);
const num = (n) => n.toLocaleString();
const catLabel = (c) => c || 'General';

// An import keeps going if you leave the page; this is what the page shows.
let importing = null;
state.busy.add(() => !!importing);

export async function viewLibrary(view) {
  setTitle('Art library');
  const ps = A.packs();
  const blobs = await A.blobIds();
  const onDevice = new Map(ps.map((p) => [p.name, 0]));
  for (const a of A.liveAssets()) if (blobs.has(a.id)) onDevice.set(a.pack, onDevice.get(a.pack) + 1);
  view.innerHTML = `
    <div class="page-head"><div><h1>Art library</h1></div>
      <div class="actions">
        <label class="btn" title="A folder of images; its folders become categories">${icon('upload-simple')} Import folder<input type="file" id="pickFolder" webkitdirectory multiple hidden></label>
        <label class="btn primary">${icon('upload-simple')} Import zip or images<input type="file" id="pickFiles" accept=".zip,application/zip,image/*" multiple hidden></label>
      </div></div>
    <div id="importStatus"></div>
    <div id="transferStatus"></div>
    ${ps.length ? `<div class="pack-list">${ps.map((p) => `
      <div class="pack-row">
        <a class="pack-main" href="#/library/${encodeURIComponent(p.name)}">
          <span class="pack-icon">${icon('stack')}</span>
          <span><b>${esc(p.name)}</b>
            <span class="sub">${p.type !== 'any' ? `${esc(A.PACK_TYPES.find(([v]) => v === p.type)?.[1] || '')} · ` : ''}${num(p.count)} images · ${p.categories.length} ${p.categories.length === 1 ? 'category' : 'categories'} · ${fmtBytes(p.bytes)}</span>
            <span class="sub">${onDevice.get(p.name) === p.count ? 'All on this device' : `${num(onDevice.get(p.name))} of ${num(p.count)} full-size on this device`}</span></span>
        </a>
        <label class="check" title="Download every image in this pack, for working offline"><input type="checkbox" data-pin="${esc(p.name)}" ${meta.pinned.includes(p.name) ? 'checked' : ''}> Keep offline</label>
      </div>`).join('')}</div>`
    : `<div class="empty-state">${icon('stack', 'empty-emblem')}<h2>No art yet</h2>
        <p>Import a folder or a zip of images. Its top folder becomes the pack, and the folders inside it become categories (mountains, trees, textures…).</p>
        <p class="muted small">Art is stored on this device and synced to your other devices through OneDrive. It’s never part of the app itself.</p></div>`}
    <p class="muted small center" id="storageNote"></p>`;

  $('#pickFolder').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) startImport(files.map((f) => ({ path: f.webkitRelativePath || f.name, blob: async () => f })));
  };
  $('#pickFiles').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    const loose = files.filter((f) => !/\.zip$/i.test(f.name));
    if (loose.length) await startImport(loose.map((f) => ({ path: f.name, blob: async () => f })));
    for (const z of zips) {
      try {
        await startImport(await readZip(z), z.name.replace(/\.zip$/i, ''));
      } catch (err) { toast(err.message, 6000); }
    }
  };
  for (const cb of $$('[data-pin]', view)) {
    cb.onchange = async () => {
      await A.setPinned(cb.dataset.pin, cb.checked);
      if (cb.checked) { toast(auth.isSignedIn() ? 'Downloading the pack…' : 'The pack will download once OneDrive is connected'); assetsync.kick({ force: true }); }
    };
  }
  renderImport();
  watchTransfers();
  navigator.storage?.estimate?.().then(({ usage, quota }) => {
    const el = $('#storageNote');
    if (el && usage != null) el.textContent = `This app is using ${fmtBytes(usage)} of storage on this device${quota ? ` (the browser allows up to ${fmtBytes(quota)})` : ''}.`;
  });
}

// --- importing ----------------------------------------------------------

async function startImport(raw, fallbackName = '') {
  if (importing) return toast('Wait for the current import to finish');
  const { root, entries } = A.splitRoot(raw.filter((e) => A.isImagePath(e.path)));
  if (!entries.length) return toast('No images found (PNG, WebP, JPEG, GIF, SVG or AVIF)');
  const folders = new Set(entries.map((e) => e.path.split('/').slice(0, -1).join('/')));
  const existing = A.packs().map((p) => p.name);
  const pack = await modal('Import art', `<form class="form">
      <p>${num(entries.length)} images in ${folders.size} ${folders.size === 1 ? 'folder' : 'folders'}. Each folder becomes a category.</p>
      <label>Pack<input name="pack" required maxlength="80" list="packNames" value="${esc(root || fallbackName || 'Imported art')}"></label>
      <datalist id="packNames">${existing.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <p class="muted small">Importing into an existing pack adds to it. Images already in your library are skipped.</p>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Import</button></div>
    </form>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(null);
      $('form', m).onsubmit = (e) => { e.preventDefault(); close(e.target.pack.value.trim() || null); };
    },
  });
  if (!pack) return;
  importing = { pack, done: 0, total: entries.length, added: 0, skipped: 0 };
  renderImport();
  try {
    const res = await A.importEntries(entries, pack, (p) => { importing = { pack, ...p }; renderImport(); });
    toast(`Imported ${num(res.added)} images into ${pack}${res.skipped ? ` (${num(res.skipped)} skipped)` : ''}`, 5000);
  } catch (e) {
    toast('Import failed: ' + e.message, 6000);
  } finally {
    importing = null;
    if (location.hash.startsWith('#/library')) state.route();
  }
}

function renderImport() {
  const el = $('#importStatus');
  if (!el) return;
  el.innerHTML = importing ? `<div class="panel progress-panel">
      <div><b>Importing into ${esc(importing.pack)}</b> <span class="muted">${num(importing.done)} of ${num(importing.total)}</span></div>
      <progress max="${importing.total}" value="${importing.done}"></progress>
      <p class="muted small">Keep this app open until it finishes. Each image is saved as it’s done, so nothing is lost if it’s interrupted.</p></div>` : '';
}

// --- transfers ----------------------------------------------------------

function watchTransfers(onFresh) {
  const render = (p, fresh) => {
    if (fresh) onFresh?.();
    const el = $('#transferStatus');
    if (!el) return;
    const parts = [];
    if (p.state === 'working' && p.upTotal) parts.push(`Uploading to OneDrive: ${num(p.up)} of ${num(p.upTotal)}`);
    if (p.state === 'working' && p.downTotal) parts.push(`Downloading: ${num(p.down)} of ${num(p.downTotal)}`);
    el.innerHTML = p.state === 'error'
      ? `<div class="panel progress-panel"><p class="warn">${icon('warning')} Art sync stopped: ${esc(p.message)}. It will try again at the next sync.</p></div>`
      : parts.length ? `<div class="panel progress-panel">${parts.map((t) => `<div>${t}</div>`).join('')}
          ${p.upTotal ? `<progress max="${p.upTotal}" value="${p.up}"></progress>` : `<progress max="${p.downTotal}" value="${p.down}"></progress>`}
          ${p.message ? `<p class="muted small">${esc(p.message)}</p>` : ''}</div>` : '';
  };
  render(assetsync.progress);
  const stop = assetsync.onProgress(render);
  state.cleanup = stop;
}

// --- one pack -----------------------------------------------------------

export async function viewPack(view, name) {
  const p = A.packs().find((x) => x.name === name);
  if (!p) { location.hash = '#/library'; return; }
  setTitle(name);
  const byCat = new Map(p.categories.map((c) => [c.name, []]));
  for (const a of A.liveAssets()) if (a.pack === name) byCat.get(a.category).push(a);
  const open = p.count <= 400;
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow"><a href="#/library">Art library</a></div><h1>${esc(name)}</h1>
      <div class="muted small">${num(p.count)} images · ${fmtBytes(p.bytes)}</div></div>
      <label class="inline pack-type">Made for <select id="packType">${A.PACK_TYPES.map(([v, n]) => `<option value="${v}" ${p.type === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <div class="actions">
        <label class="check"><input type="checkbox" id="pinPack" ${meta.pinned.includes(name) ? 'checked' : ''}> Keep offline</label>
        <button class="btn danger" id="delPack">${icon('trash')} Delete pack</button>
      </div></div>
    <div id="transferStatus"></div>
    ${p.categories.map((c) => `<details class="cat" ${open ? 'open' : ''} data-cat="${esc(c.name)}">
      <summary><span class="cat-name">${icon('caret-right', 'caret')} ${esc(catLabel(c.name))}</span> <span class="muted small">${num(c.count)}</span>
        <span class="seg small kind-seg" data-cat="${esc(c.name)}">
          <button type="button" data-kind="stamp" class="${c.kind === 'stamp' ? 'on' : ''}" title="Placed one at a time">Stamps</button>
          <button type="button" data-kind="texture" class="${c.kind === 'texture' ? 'on' : ''}" title="Painted as a repeating fill">Textures</button>
        </span></summary>
      <div class="asset-grid"></div></details>`).join('')}`;

  const io = new IntersectionObserver((list) => {
    for (const en of list) if (en.isIntersecting) { io.unobserve(en.target); hydrate(en.target); }
  }, { rootMargin: '400px' });
  const hydrate = async (tile) => {
    const url = await A.thumbURL(tile.dataset.id);
    if (url) tile.innerHTML = `<img src="${url}" alt="" draggable="false">`;
    else tile.classList.add('missing');
  };
  const fill = (d) => {
    const grid = $('.asset-grid', d);
    if (grid.childElementCount) return;
    grid.innerHTML = byCat.get(d.dataset.cat).sort(A.byName)
      .map((a) => `<div class="tile" data-id="${a.id}" title="${esc(a.name)} · ${a.w}×${a.h}">${icon('image')}</div>`).join('');
    for (const t of grid.children) io.observe(t);
  };
  for (const d of $$('details.cat', view)) {
    if (d.open) fill(d);
    d.addEventListener('toggle', () => { if (d.open) fill(d); });
  }
  for (const seg of $$('.kind-seg', view)) {
    seg.onclick = async (e) => {
      e.preventDefault(); // inside <summary>: don't fold the category
      const b = e.target.closest('button');
      if (!b || b.classList.contains('on')) return;
      for (const x of seg.children) x.classList.toggle('on', x === b);
      await A.setCategoryKind(name, seg.dataset.cat, b.dataset.kind);
    };
  }
  $('#pinPack').onchange = async (e) => {
    await A.setPinned(name, e.target.checked);
    if (e.target.checked) assetsync.kick({ force: true });
  };
  $('#packType').onchange = async (e) => {
    await A.setPackType(name, e.target.value);
    toast(e.target.value === 'any' ? 'Shown first for every kind of map' : `Shown first on ${A.PACK_TYPES.find(([v]) => v === e.target.value)[1].toLowerCase()}`);
  };
  $('#delPack').onclick = async () => {
    if (!(await confirmDialog(`Delete “${name}” and its ${num(p.count)} images from all your devices and OneDrive? Maps that use them will show gaps.`, 'Delete pack'))) return;
    await A.deletePack(name);
    toast('Pack deleted');
    location.hash = '#/library';
  };
  // Catalogue changes from other devices (e.g. an import in progress there)
  // don't re-render the page you're browsing, unless this pack went away.
  state.onRemote = () => { if (!A.packs().some((x) => x.name === name)) location.hash = '#/library'; };
  // Thumbnails arriving from OneDrive fill in tiles that were waiting for them.
  watchTransfers(() => { for (const t of $$('.tile.missing', view)) { t.classList.remove('missing'); hydrate(t); } });
  const stop = state.cleanup;
  state.cleanup = () => { stop?.(); io.disconnect(); };
}
