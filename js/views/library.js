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
  for (const a of A.livePlaced()) if (blobs.has(a.id)) onDevice.set(a.pack, onDevice.get(a.pack) + 1);
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
  for (const a of A.livePlaced()) if (a.pack === name) byCat.get(A.groupOf(a)).push(a);
  // Categories stay open (and the page where it was) when it's redrawn after a change.
  const opened = openCats.get(name) || new Set(p.count <= 400 ? p.categories.map((c) => c.name) : []);
  openCats.set(name, opened);
  const scrollY = reorganised === name ? window.scrollY : 0;
  reorganised = null;
  const sel = new Set(); // selected stamps (keys)
  const sets = new Map(); // stamp key → { name, items, cat }
  let selecting = false;
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow"><a href="#/library">Art library</a></div><h1>${esc(name)}</h1>
      <div class="muted small">${num(p.count)} images · ${fmtBytes(p.bytes)}</div></div>
      <label class="inline pack-type">Made for <select id="packType">${A.PACK_TYPES.map(([v, n]) => `<option value="${v}" ${p.type === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <div class="actions">
        <button class="btn" id="selectMode" title="Pick several stamps to move or size together (or Ctrl-click them)">Select</button>
        <label class="check"><input type="checkbox" id="pinPack" ${meta.pinned.includes(name) ? 'checked' : ''}> Keep offline</label>
        <button class="btn" id="exportPack" title="Save the whole pack as one ${EXTENSION} file">${icon('download-simple')} Export pack file</button>
        <button class="btn danger" id="delPack">${icon('trash')} Delete pack</button>
      </div></div>
    <div id="exportStatus"></div>
    <div id="transferStatus"></div>
    <p class="muted small">Click a stamp to see its variations, rename or move it, or give it a default size. Ctrl or Shift-click (or Select) to pick several.</p>
    ${p.categories.map((c) => `<details class="cat" ${opened.has(c.name) ? 'open' : ''} data-cat="${esc(c.name)}">
      <summary><span class="cat-name">${icon('caret-right', 'caret')} ${esc(catLabel(c.name))}</span> <span class="muted small">${num(A.categorySets(name, c.name).length)} stamps · ${num(c.count)} images</span>
        <button type="button" class="icon-btn small" data-rename-cat="${esc(c.name)}" title="Rename this category (or merge it into another)" aria-label="Rename category">${icon('pencil-simple')}</button>
        <span class="seg small kind-seg" data-cat="${esc(c.name)}">
          <button type="button" data-kind="stamp" class="${c.kind === 'stamp' ? 'on' : ''}" title="Placed one at a time">Stamps</button>
          <button type="button" data-kind="texture" class="${c.kind === 'texture' ? 'on' : ''}" title="Painted as a repeating fill">Textures</button>
        </span></summary>
      <div class="asset-grid"></div></details>`).join('')}
    <div class="sel-bar" hidden><span class="sel-count"></span>
      <button class="btn small" data-sel="move">Move to…</button>
      <button class="btn small" data-sel="size">Default size…</button>
      <button class="btn small danger" data-sel="delete">${icon('trash')} Delete</button>
      <button class="btn small quiet" data-sel="clear">Clear</button></div>`;

  const io = new IntersectionObserver((list) => {
    for (const en of list) if (en.isIntersecting) { io.unobserve(en.target); hydrate(en.target); }
  }, { rootMargin: '400px' });
  const hydrate = async (tile) => {
    const url = await A.thumbURL(tile.dataset.id);
    if (url) tile.innerHTML = `<img src="${url}" alt="" draggable="false">`;
    else tile.classList.add('missing');
  };
  // One tile per stamp: its first picture, a count of its variations, and
  // its default size if it has one.
  const fill = (d) => {
    const grid = $('.asset-grid', d);
    if (grid.childElementCount) return;
    grid.innerHTML = A.categorySets(name, d.dataset.cat).map((st) => {
      sets.set(st.key, { ...st, cat: d.dataset.cat });
      const a = st.items[0], size = a.defaultSize;
      return `<div class="lib-stamp${sel.has(st.key) ? ' sel' : ''}" data-set="${esc(st.key)}" title="${esc(st.name)}${st.items.length > 1 ? ` · ${st.items.length} variations` : ''}${size ? ` · starts at ${size} px` : ''}">
        <div class="tile" data-id="${a.id}">${icon('image')}</div>
        ${st.items.length > 1 ? `<span class="pk-badge static">${st.items.length}</span>` : ''}${size ? `<span class="size-tag">${size}</span>` : ''}
        <span class="lib-stamp-name">${esc(st.name)}</span></div>`;
    }).join('');
    for (const t of $$('.tile', grid)) io.observe(t);
  };
  for (const d of $$('details.cat', view)) {
    if (d.open) fill(d);
    d.addEventListener('toggle', () => {
      if (d.open) { opened.add(d.dataset.cat); fill(d); } else opened.delete(d.dataset.cat);
    });
  }
  if (scrollY) requestAnimationFrame(() => window.scrollTo(0, scrollY));
  const syncSel = () => {
    const bar = $('.sel-bar', view);
    bar.hidden = !sel.size;
    const n = [...sel].reduce((k, key) => k + (sets.get(key)?.items.length || 0), 0);
    $('.sel-count', bar).textContent = `${num(sel.size)} ${sel.size === 1 ? 'stamp' : 'stamps'} (${num(n)} images)`;
    for (const el of $$('.lib-stamp', view)) el.classList.toggle('sel', sel.has(el.dataset.set));
    $('#selectMode').classList.toggle('on', selecting);
  };
  const selIds = () => [...sel].flatMap((k) => sets.get(k)?.items.map((a) => a.id) || []);
  // Redraw after a change, where you were.
  const redraw = () => { reorganised = name; if (!A.packs().some((x) => x.name === name)) location.hash = '#/library'; else state.route(); };
  // (A property, not a listener: the view element outlives this page.)
  view.onclick = async (e) => {
    const ren = e.target.closest('[data-rename-cat]');
    if (ren) {
      e.preventDefault(); // inside <summary>: don't fold it
      const from = ren.dataset.renameCat;
      const to = (await askText('Rename category', from, 'Name'))?.replace(/\//g, '-');
      if (!to || to === from) return;
      const merging = A.packs().find((x) => x.name === name)?.categories.some((c) => c.name === to);
      if (merging && !(await confirmDialog(`“${to}” already exists. Move everything in “${catLabel(from)}” into it?`, 'Merge'))) return;
      opened.delete(from); opened.add(to);
      await A.renameCategory(name, from, to);
      redraw();
      return;
    }
    const st = e.target.closest('.lib-stamp');
    if (st) {
      if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) {
        if (sel.has(st.dataset.set)) sel.delete(st.dataset.set); else sel.add(st.dataset.set);
        syncSel();
      } else if (await stampDialog(name, sets.get(st.dataset.set))) redraw();
      return;
    }
    const b = e.target.closest('[data-sel]');
    if (!b) return;
    const act = b.dataset.sel;
    if (act === 'clear') { sel.clear(); selecting = false; syncSel(); return; }
    if (act === 'move') {
      const to = await moveDialog(name, `Move ${sel.size} ${sel.size === 1 ? 'stamp' : 'stamps'}`, '', true);
      if (!to) return;
      // Without a stamp name, each keeps its own; with one, they become variations of one stamp.
      for (const key of sel) {
        const s1 = sets.get(key);
        await A.moveAssets(s1.items.map((a) => a.id), { pack: to.pack, category: to.category, stamp: to.stamp || (s1.items[0].category.includes('/') ? s1.name : '') }, name);
      }
      toast(`Moved to ${to.pack === name ? '' : `${to.pack} · `}${to.category || 'General'}`);
      sel.clear();
      redraw();
    } else if (act === 'size') {
      const size = await sizeDialog(sets.get([...sel][0])?.items[0]?.defaultSize);
      if (size === undefined) return;
      await A.setDefaultSize(selIds(), size);
      redraw();
    } else if (act === 'delete') {
      const ids = selIds();
      if (!(await confirmDialog(`Delete these ${num(ids.length)} images from all your devices and OneDrive? Maps that use them will show gaps.`, 'Delete'))) return;
      await A.deleteAssets(ids, name);
      sel.clear();
      redraw();
    }
  };
  $('#selectMode').onclick = () => { selecting = !selecting; if (!selecting) sel.clear(); syncSel(); };
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
    const shared = A.livePlaced().filter((a) => a.pack === name && A.placements(A.asset(a.id)).length > 1).length;
    if (!(await confirmDialog(`Delete “${name}” and its ${num(p.count)} images from all your devices and OneDrive? Maps that use them will show gaps.${shared ? ` (${num(shared)} of them are also in other packs, and stay there.)` : ''}`, 'Delete pack'))) return;
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
  state.cleanup = () => { stop?.(); io.disconnect(); view.onclick = null; };
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

// --- reorganising ---------------------------------------------------------

const openCats = new Map(); // pack → the categories open on its page
let reorganised = null; // the pack whose page is being redrawn after a change

function askText(title, value, label) {
  return modal(title, `<form class="form"><label>${esc(label)}<input name="v" required maxlength="80" value="${esc(value)}"></label>
    <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(null);
      $('form', m).onsubmit = (e) => { e.preventDefault(); close(e.target.v.value.trim() || null); };
      $('input', m).select();
    },
  });
}

// Where to move things: a pack, a category in it (new or existing), and
// optionally a stamp. Resolves { pack, category, stamp } or null.
function moveDialog(pack, title, stamp = '', several = false, category = '') {
  const ps = A.packs();
  const cats = (pk) => (ps.find((x) => x.name === pk)?.categories || []).map((c) => c.name);
  return modal(title, `<form class="form">
      <label>Pack<input name="pack" list="mvPacks" required maxlength="80" value="${esc(pack)}"></label>
      <datalist id="mvPacks">${ps.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
      <label>Category<input name="category" list="mvCats" maxlength="80" value="${esc(category)}" placeholder="General"></label>
      <datalist id="mvCats">${cats(pack).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <label>Stamp <small>${several ? 'empty: each keeps its own name; a name: they become variations of one stamp' : 'the stamp they’re variations of'}</small><input name="stamp" maxlength="80" value="${esc(stamp)}"></label>
      <p class="muted small">A new pack or category is made if the name isn’t taken.</p>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Move</button></div>
    </form>`, {
    onMount: (m, close) => {
      const f = $('form', m);
      f.pack.oninput = () => { $('#mvCats', m).innerHTML = cats(f.pack.value.trim()).map((c) => `<option value="${esc(c)}">`).join(''); };
      $('[data-cancel]', m).onclick = () => close(null);
      f.onsubmit = (e) => {
        e.preventDefault();
        const clean = (v) => v.trim().replace(/\//g, '-');
        close({ pack: f.pack.value.trim(), category: clean(f.category.value), stamp: clean(f.stamp.value) });
      };
    },
  });
}

// A default size: a number, null to clear it, undefined if cancelled.
function sizeDialog(value) {
  return modal('Default size', `<form class="form">
      <label>Size <small>map pixels, the longer side</small><input name="size" type="number" min="8" max="4096" step="1" value="${value || ''}" placeholder="None: use the size slider"></label>
      <p class="muted small">Picking the stamp in the editor sets the size slider to this. You can also set it there: size a stamp, then “Save as its default size”.</p>
      <div class="actions"><button type="button" class="btn quiet" data-clear>No default</button><span class="spacer"></span><button type="button" class="btn quiet" data-cancel>Cancel</button><button class="btn primary">Save</button></div>
    </form>`, {
    onMount: (m, close) => {
      $('[data-cancel]', m).onclick = () => close(undefined);
      $('[data-clear]', m).onclick = () => close(null);
      $('form', m).onsubmit = (e) => { e.preventDefault(); const v = +e.target.size.value; close(v >= 8 ? v : null); };
    },
  }).then((v) => v);
}

// One stamp: its variations (select some to act on just those), its name,
// where it lives, and its default size. Resolves true if anything changed.
async function stampDialog(pack, st) {
  if (!st) return false;
  const chosen = new Set();
  const res = await modal(st.name, `<div class="form">
      <div class="asset-grid stamp-vars">${st.items.map((a) => `<div class="tile" data-id="${a.id}" title="${esc(a.name)} · ${a.w}×${a.h}">${icon('image')}</div>`).join('')}</div>
      <p class="muted small sv-note">${st.items.length > 1 ? `${st.items.length} variations. Tap some to act on just those.` : 'One picture.'}</p>
      <label>Name<input name="name" maxlength="80" value="${esc(st.name)}"></label>
      <label>Default size <small>map pixels, the longer side</small><input name="size" type="number" min="8" max="4096" step="1" value="${st.items[0].defaultSize || ''}" placeholder="None: use the size slider"></label>
      <div class="actions left"><button type="button" class="btn small" data-a="move">Move…</button><button type="button" class="btn small danger" data-a="delete">${icon('trash')} Delete</button></div>
      <div class="actions"><button type="button" class="btn quiet" data-cancel>Cancel</button><button type="button" class="btn primary" data-a="save">Save</button></div>
    </div>`, {
    wide: true,
    onMount: (m, close) => {
      for (const t of $$('.tile', m)) A.thumbURL(t.dataset.id).then((url) => { if (url) t.innerHTML = `<img src="${url}" alt="" draggable="false">`; });
      $('.stamp-vars', m).onclick = (e) => {
        const t = e.target.closest('.tile');
        if (!t || st.items.length < 2) return;
        if (chosen.has(t.dataset.id)) chosen.delete(t.dataset.id); else chosen.add(t.dataset.id);
        t.classList.toggle('on', chosen.has(t.dataset.id));
        $('.sv-note', m).textContent = chosen.size ? `${chosen.size} of ${st.items.length} selected: Move or Delete acts on just these.` : `${st.items.length} variations. Tap some to act on just those.`;
      };
      $('[data-cancel]', m).onclick = () => close(null);
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (b) close({ a: b.dataset.a, name: $('[name=name]', m).value.trim().replace(/\//g, '-'), size: +$('[name=size]', m).value || null });
      });
    },
  });
  if (!res) return false;
  const all = st.items.map((a) => a.id), ids = chosen.size ? [...chosen] : all;
  if (res.a === 'delete') {
    if (!(await confirmDialog(`Delete ${ids.length === 1 ? 'this image' : `these ${ids.length} images`} from all your devices and OneDrive? Maps that use ${ids.length === 1 ? 'it' : 'them'} will show gaps.`, 'Delete'))) return false;
    await A.deleteAssets(ids, pack);
    return true;
  }
  if (res.a === 'move') {
    const to = await moveDialog(pack, chosen.size ? `Move ${chosen.size} variations` : `Move “${st.name}”`, chosen.size ? '' : res.name || st.name, false, st.cat);
    if (!to) return false;
    await A.moveAssets(ids, to, pack);
    toast(`Moved to ${to.pack === pack ? '' : `${to.pack} · `}${to.category || 'General'}${to.stamp ? ` · ${to.stamp}` : ''}`);
    return true;
  }
  let changed = false;
  if (res.name && res.name !== st.name) { await A.renameStamp(all, res.name, pack); changed = true; }
  if ((res.size || null) !== (st.items[0].defaultSize || null)) { await A.setDefaultSize(all, res.size); changed = true; }
  return changed;
}
