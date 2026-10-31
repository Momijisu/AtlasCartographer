// Pack files: a device without the full-size art exports a pack (fetching it from OneDrive),
// the file is a valid zip with pack.json, and importing it elsewhere restores names, kinds and map type.
const { chromium } = require('playwright');
const { device, drive, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
const { execFileSync } = require('child_process');
const keys = (pre) => [...drive.keys()].filter((k) => k.startsWith(pre));
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library');
  await A.waitForSelector('#pickFiles', { state: 'attached' });
  await A.setInputFiles('#pickFiles', 'pack.zip');
  await A.waitForSelector('.modal input[name=pack]');
  await A.click('.modal button.primary');
  await A.waitForSelector('.pack-row', { timeout: 20000 });
  // Give it a texture category, a map type, and two pictures sharing a name.
  const before = await A.evaluate(async () => {
    const A = await import('./js/assets.js');
    const p = A.packs()[0];
    await A.setPackType(p.name, 'region');
    await A.setCategoryKind(p.name, p.categories[0].name, p.categories[0].kind === 'texture' ? 'stamp' : 'texture');
    const list = A.liveAssets().filter((a) => a.pack === p.name).sort((x, y) => x.id < y.id ? -1 : 1);
    const twin = list.filter((a) => a.category === list[0].category)[1] || list[1];
    const db = await import('./js/db.js');
    const rec = { ...A.assets.get(twin.id), name: list[0].name, category: list[0].category, kind: list[0].kind, updatedAt: Date.now() + 5 };
    A.assets.set(rec.id, rec); await db.put('assets', rec);
    return { pack: p.name, recs: A.liveAssets().filter((a) => a.pack === p.name).map(({ id, name, category, kind, mapType }) => ({ id, name, category, kind, mapType })).sort((x, y) => x.id < y.id ? -1 : 1) };
  });
  await A.evaluate(async () => { const s = await import('./js/store.js'); await s.saveMeta({ assetRev: s.meta.assetRev + 1 }, { bump: ['assetRev'] }); (await import('./js/sync.js')).sync({ force: true }); });
  for (let i = 0; i < 60 && keys('assets/').length < before.recs.length; i++) await A.waitForTimeout(500);
  await A.waitForTimeout(1500);
  check('A uploaded the full-size art', keys('assets/').length >= before.recs.length, keys('assets/').length);

  // B has only thumbnails; exporting must fetch the full-size art.
  const B = await device(browser, 'B');
  await waitSynced(B);
  const localBefore = await B.evaluate(async () => (await (await import('./js/assets.js')).blobIds()).size);
  await B.goto(BASE + '#/library/' + encodeURIComponent(before.pack));
  await B.waitForSelector('#exportPack');
  await B.click('#exportPack');
  await B.waitForSelector('.modal [data-save]', { timeout: 30000 });
  const info = await B.$eval('.modal p', (p) => p.textContent);
  const [dl] = await Promise.all([B.waitForEvent('download'), B.click('.modal [data-save]')]);
  const out = __dirname + '/exported.atlaspack';
  await dl.saveAs(out);
  check('B had no full-size art before exporting', localBefore === 0, localBefore);
  check('file is named after the pack', dl.suggestedFilename() === before.pack + '.atlaspack', dl.suggestedFilename());
  console.log('dialog:', info);
  const py = execFileSync('python3', ['-I', '-c', `
import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); m=json.loads(z.read('pack.json'))
print(json.dumps({'bad':bad,'n':len(z.namelist()),'names':z.namelist(),'manifest':m}))`, out]).toString();
  const zi = JSON.parse(py);
  check('a valid zip (CRCs check out in Python)', zi.bad === null, zi.bad);
  check('pack.json plus every image', zi.n === before.recs.length + 1, `${zi.n} entries for ${before.recs.length} images`);
  check('pictures in category folders, twins kept apart', new Set(zi.names.map((n) => n.toLowerCase())).size === zi.n && zi.names.some((n) => / \(2\)\./.test(n)), zi.names.slice(0, 6).join(' | '));
  check('manifest keeps the map type', zi.manifest.mapType === 'region', zi.manifest.mapType);

  // A deletes the pack, then imports the file back through the library page.
  await A.evaluate(async (n) => (await import('./js/assets.js')).deletePack(n), before.pack);
  await A.goto(BASE + '#/');
  await A.reload();
  await A.goto(BASE + '#/library');
  await A.waitForSelector('#pickFiles', { state: 'attached' });
  check('the pack is gone before re-importing', !(await A.$('.pack-row')));
  await A.setInputFiles('#pickFiles', out);
  await A.waitForSelector('.modal input[name=pack]');
  const name = await A.$eval('.modal input[name=pack]', (i) => i.value);
  check('the pack name comes from the file', name === before.pack, name);
  await A.click('.modal button.primary');
  await A.waitForFunction(() => /^Imported/.test(document.querySelector('#toast').textContent), null, { timeout: 20000 });
  const after = await A.evaluate(async (n) => (await import('./js/assets.js')).liveAssets().filter((a) => a.pack === n).map(({ id, name, category, kind, mapType }) => ({ id, name, category, kind, mapType })).sort((x, y) => x.id < y.id ? -1 : 1), before.pack);
  check('the same pictures come back with their names, categories, kinds and map type', JSON.stringify(after) === JSON.stringify(before.recs), JSON.stringify(after.find((a, i) => JSON.stringify(a) !== JSON.stringify(before.recs[i])) || ''));

  // Garbage with the extension is refused politely.
  require('fs').writeFileSync(__dirname + '/bad.atlaspack', 'nope');
  await A.setInputFiles('#pickFiles', __dirname + '/bad.atlaspack');
  await A.waitForFunction(() => !/^Imported/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 }).catch(() => {});
  const t = await A.$eval('#toast', (e) => e.textContent);
  check('a broken file gets a message', /zip|damaged/i.test(t), t);
  await browser.close();
  done();
})();
