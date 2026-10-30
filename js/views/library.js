// The art library: import packs, see what's on this device, browse a pack.
import * as A from '../assets.js';
import * as assetsync from '../assetsync.js';
import * as auth from '../auth.js';
import { meta } from '../store.js';
import { readPackFile, exportPack, EXTENSION } from '../packfile.js';
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
        <label class="btn primary" title="A pack file (${EXTENSION}), a zip, or loose images">${icon('upload-simple')} Import pack, zip or images<input type="file" id="pickFiles" accept="${EXTENSION},.zip,application/zip,image/*" multiple hidden></label>
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
        <p>Import a pack file, or a folder or zip of images. Its top folder becomes the pack, the folders inside it categories (mountains, trees, textures…), and a folder inside a category one stamp, with its pictures as that stamp’s variations.</p>
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
    await importFiles(files);
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

const isArchive = (f) => /\.(zip|atlaspack)$/i.test(f.name);

// Pack files, zips and loose images, as picked or opened with the app.
export async function importFiles(files) {
  const loose = files.filter((f) => !isArchive(f) && A.isImagePath(f.name));
  if (loose.length) await startImport(loose.map((f) => ({ path: f.name, blob: async () => f })));
  for (const z of files.filter(isArchive)) {
    try {
      const { manifest, entries } = await readPackFile(z);
      await startImport(entries, z.name.replace(/\.(zip|atlaspack)$/i, ''), manifest);
    } catch (err) { toast(err.message, 6000); }
  }
  if (!loose.length && !files.some(isArchive)) toast(`Pick a pack file (${EXTENSION}), a zip or images`);
}

// manifest: a pack file's, whose entries already say their category.
async function startImport(raw, fallbackName = '', manifest = null) {
  if (importing) return toast('Wait for the current import to finish');
  const images = raw.filter((e) => A.isImagePath(e.path));
  const { root, entries } = manifest ? { root: manifest.name, entries: images } : A.splitRoot(images);
  if (!entries.length) return toast('No images found (PNG, WebP, JPEG, GIF, SVG or AVIF)');
  const folders = new Set(entries.map((e) => e.category ?? e.path.split('/').slice(0, -1).join('/')));
  const existing = A.packs().map((p) => p.name);
  const pack = await modal('Import art', `<form class="form">
      <p>${num(entries.length)} images in ${folders.size} ${folders.size === 1 ? (manifest ? 'category' : 'folder') : (manifest ? 'categories' : 'folders')}.${manifest ? '' : ' Each folder becomes a category; a folder inside one becomes a stamp, its pictures the stamp’s variations.'}</p>
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
    const mapType = A.PACK_TYPES.some(([v]) => v === manifest?.mapType) ? manifest.mapType : undefined;
    const res = await A.importEntries(entries, pack, (p) => { importing = { pack, ...p }; renderImport(); }, { mapType });
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
  for (const a of A.liveAssets()) if (a.pack === name) byCat.get(A.groupOf(a)).push(a);
  const open = p.count <= 400;
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow"><a href="#/library">Art library</a></div><h1>${esc(name)}</h1>
      <div class="muted small">${num(p.count)} images · ${fmtBytes(p.bytes)}</div></div>
      <label class="inline pack-type">Made for <select id="packType">${A.PACK_TYPES.map(([v, n]) => `<option value="${v}" ${p.type === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <div class="actions">
        <label class="check"><input type="checkbox" id="pinPack" ${meta.pinned.includes(name) ? 'checked' : ''}> Keep offline</label>
        <button class="btn" id="exportPack" title="Save the whole pack as one ${EXTENSION} file">${icon('download-simple')} Export pack file</button>
        <button class="btn danger" id="delPack">${icon('trash')} Delete pack</button>
      </div></div>
    <div id="exportStatus"></div>
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
    // Stamp by stamp, each one's variations together.
    grid.innerHTML = A.categorySets(name, d.dataset.cat)
      .map((st) => st.items.map((a) => `<div class="tile" data-id="${a.id}" title="${esc(st.items.length > 1 ? `${st.name}: ${a.name}` : a.name)} · ${a.w}×${a.h}">${icon('image')}</div>`).join('')).join('');
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
  $('#exportPack').onclick = () => exportPackFile(name);
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

// --- exporting ----------------------------------------------------------

let exporting = null;
state.busy.add(() => !!exporting);

async function exportPackFile(name) {
  if (exporting) return toast('Wait for the current export to finish');
  const btn = $('#exportPack');
  const show = (p) => {
    const el = $('#exportStatus');
    if (!el) return;
    el.innerHTML = p ? `<div class="panel progress-panel">
        <div><b>${p.stage === 'writing' ? 'Writing the pack file' : 'Gathering images'}</b> <span class="muted">${num(p.done)} of ${num(p.total)}</span></div>
        <progress max="${p.total}" value="${p.done}"></progress></div>` : '';
  };
  exporting = name;
  if (btn) btn.disabled = true;
  show({ stage: 'gathering', done: 0, total: A.packs().find((x) => x.name === name)?.count || 0 });
  let res;
  try {
    res = await exportPack(name, show);
  } catch (e) {
    return toast('Export failed: ' + e.message, 6000);
  } finally {
    exporting = null;
    show(null);
    if (btn) btn.disabled = false;
  }
  saveDialog(res);
}

// Saving needs a fresh tap (browsers only share or download straight after
// one), so the finished file waits behind a button.
async function saveDialog({ blob, fileName, count, missing }) {
  const file = new File([blob], fileName, { type: 'application/zip' });
  const canShare = navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches;
  await modal('Pack file ready', `<div class="form">
      <p><b>${esc(fileName)}</b> · ${num(count)} images · ${fmtBytes(blob.size)}</p>
      ${missing ? `<p class="warn">${icon('warning')} ${num(missing)} ${missing === 1 ? 'image isn’t' : 'images aren’t'} on this device or OneDrive yet, so ${missing === 1 ? 'it was' : 'they were'} left out.</p>` : ''}
      <p class="muted small">Import it from the Art library on any device running AtlasCartographer.</p>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Close</button>
        ${canShare ? '<button type="button" class="btn" data-share>Share…</button>' : ''}
        <button type="button" class="btn primary" data-save>${icon('download-simple')} Save</button></div>
    </div>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(null);
      $('[data-save]', m).onclick = () => {
        const url = URL.createObjectURL(file);
        const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        close(true);
      };
      const share = $('[data-share]', m);
      if (share) share.onclick = async () => {
        try { await navigator.share({ files: [file], title: fileName }); close(true); } catch (e) { if (e.name !== 'AbortError') toast('Couldn’t share: ' + e.message); }
      };
    },
  });
}
