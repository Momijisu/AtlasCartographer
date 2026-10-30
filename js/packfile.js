// Pack files (.atlaspack): a whole art pack in one file, for keeping a copy or
// moving it somewhere sync doesn't reach. Inside it's an ordinary zip (the
// pictures stored as they are, in their category folders) plus pack.json,
// which keeps what the folders can't: each picture's name, whether its
// category is stamps or textures, and what kind of map the pack is made for.
//
// OneDrive sync doesn't use these: there, each picture is its own file, so a
// device only fetches the art it needs and an added picture is one upload.
import * as A from './assets.js';
import { getAssetBlob } from './assetsync.js';
import { readZip, writeZip } from './zip.js';

export const EXTENSION = '.atlaspack';
const MANIFEST = 'pack.json';
const FORMAT = 'atlaspack';

// Characters some systems won't take in a file name.
const safe = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120) || 'image';

// Builds a pack's file. Pictures not on this device are downloaded first;
// any that can't be (not uploaded yet, or offline) are left out and counted.
// onProgress({ stage: 'gathering' | 'writing', done, total }).
export async function exportPack(name, onProgress = () => {}) {
  const list = A.liveAssets().filter((a) => a.pack === name).sort(A.byName);
  if (!list.length) throw new Error('This pack has no images.');
  const pack = A.packs().find((p) => p.name === name);
  const files = new Array(list.length);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try { files[i] = await getAssetBlob(list[i].id); } catch (e) { console.warn('Left out', list[i].name, e); }
      onProgress({ stage: 'gathering', done: ++done, total: list.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));

  const taken = new Set();
  const entries = [];
  const images = [];
  list.forEach((a, i) => {
    if (!files[i]) return;
    const dir = a.category ? a.category.split('/').map(safe).join('/') + '/' : '';
    const ext = A.EXT[a.type] || 'png';
    let path = `${dir}${safe(a.name)}.${ext}`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${dir}${safe(a.name)} (${n}).${ext}`;
    taken.add(path.toLowerCase());
    entries.push({ path, blob: files[i] });
    images.push({ file: path, name: a.name, category: a.category, kind: a.kind });
  });
  if (!entries.length) throw new Error('None of this pack’s images could be fetched. Connect to OneDrive, or try again once they’ve finished uploading.');
  const manifest = { format: FORMAT, version: 1, app: 'AtlasCartographer', name, mapType: pack?.type || 'any', exportedAt: new Date().toISOString(), images };
  entries.unshift({ path: MANIFEST, blob: new Blob([JSON.stringify(manifest, null, 1)], { type: 'application/json' }) });
  const blob = await writeZip(entries, (d, t) => onProgress({ stage: 'writing', done: d, total: t }));
  return { blob, fileName: safe(name) + EXTENSION, count: images.length, missing: list.length - images.length };
}

// Reads a zip or pack file. Returns { manifest, entries } for a pack file,
// with each entry carrying its picture's name, category and kind, or
// { manifest: null, entries } for any other zip.
export async function readPackFile(file) {
  const entries = await readZip(file);
  const m = entries.find((e) => e.path === MANIFEST);
  let manifest = null;
  if (m) {
    try { manifest = JSON.parse(await (await m.blob()).text()); } catch { /* not ours */ }
    if (manifest?.format !== FORMAT) manifest = null;
  }
  if (!manifest) {
    if (file.name.toLowerCase().endsWith(EXTENSION)) throw new Error('This pack file is damaged.');
    return { manifest: null, entries };
  }
  if (manifest.version > 1) throw new Error('This pack file was made by a newer version of the app. Update it and try again.');
  const byFile = new Map((manifest.images || []).map((im) => [im.file, im]));
  return {
    manifest,
    entries: entries.filter((e) => byFile.has(e.path)).map((e) => {
      const im = byFile.get(e.path);
      return { ...e, name: String(im.name || ''), category: String(im.category ?? ''), kind: im.kind };
    }),
  };
}
