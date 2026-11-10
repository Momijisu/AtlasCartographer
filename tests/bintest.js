// Deleting maps (audit fix 4): a delete from another device never wipes
// edits this device hasn't synced yet; Delete moves a map to "Recently
// deleted", from where it can be restored or deleted for good; binned maps go
// for good after 30 days; deletion records older than 90 days are tidied away.
const { chromium } = require('playwright');
const { device, drive, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
const DAY = 864e5;
// Change projects.json in the mock OneDrive, as another device would.
let etag = 1000;
function remoteIndex(fn) {
  const f = drive.get('projects.json');
  const json = JSON.parse(f.body.toString());
  fn(json.projects);
  drive.set('projects.json', { ...f, body: Buffer.from(JSON.stringify(json)), eTag: `"x${++etag}"` });
}
const remote = () => JSON.parse(drive.get('projects.json').body.toString()).projects;
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  const make = async (name) => {
    await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', name); await A.click('.modal button.primary');
    await A.waitForSelector('.editor-canvas');
    return A.evaluate(() => location.hash.split('/p/')[1]);
  };
  const sync = () => A.evaluate(async () => (await import('./js/sync.js')).sync({ force: true }));
  const proj = (id) => A.evaluate(async (id) => { const s = await import('./js/store.js'); const p = s.projects.get(id); return p && { deleted: !!p.deleted, binnedAt: p.binnedAt || null, objects: Object.keys((await s.getDoc(id))?.objects || {}).length }; }, id);

  // 1. Another device deletes a map this one has unsynced edits to.
  const id1 = await make('Edited here');
  await sync();
  await A.evaluate(async (id) => { const s = await import('./js/store.js'); await s.putObjects(id, [{ id: 'mine', kind: 'stroke', color: '#000', width: 4, points: [10, 10, 50, 50], z: 1 }]); }, id1);
  remoteIndex((ps) => { const p = ps.find((x) => x.id === id1); p.deleted = true; p.updatedAt = Date.now() + 1000; });
  await sync();
  let p1 = await proj(id1);
  check('a delete from another device keeps the map this device has unsynced edits to', p1 && !p1.deleted && p1.objects >= 1, JSON.stringify(p1));
  check('…and puts it back for every device', !remote().find((x) => x.id === id1)?.deleted, JSON.stringify(remote().find((x) => x.id === id1)));

  // 2. Delete moves to the bin; Restore; Delete forever.
  const id2 = await make('Binned');
  await A.goto(BASE + '#/');
  await A.click(`[data-menu="${id2}"]`); await A.click('.modal [data-del]'); // no "are you sure?": it can be restored
  await A.waitForTimeout(300);
  const cards = () => A.$$eval('.project-grid .project-card h3', (h) => h.map((x) => x.textContent));
  check('Delete takes the map off the list', !(await cards()).includes('Binned'), (await cards()).join());
  await A.click('.bin > summary');
  check('…into Recently deleted', await A.$eval('.bin', (b) => b.innerText).then((t) => /Binned/.test(t) && /30 days/.test(t)).catch(() => false));
  check('…keeping its drawing', (await proj(id2))?.objects >= 0 && !(await proj(id2)).deleted && !!(await proj(id2)).binnedAt);
  await sync();
  check('the bin syncs (another device sees it binned)', !!remote().find((x) => x.id === id2)?.binnedAt);
  await A.click(`.bin [data-restore="${id2}"]`);
  await A.waitForTimeout(300);
  check('Restore puts it back on the list', (await cards()).includes('Binned'), (await cards()).join());
  await A.click(`[data-menu="${id2}"]`); await A.click('.modal [data-del]');
  await A.waitForTimeout(300);
  if (!(await A.$('.bin[open]'))) await A.click('.bin > summary');
  await A.click(`.bin [data-forever="${id2}"]`);
  await A.waitForSelector('.modal [data-yes]'); await A.click('.modal [data-yes]');
  await A.waitForTimeout(300);
  check('Delete forever removes it from the bin', !(await A.$(`.bin [data-restore="${id2}"]`)) && (await proj(id2))?.deleted === true, JSON.stringify(await proj(id2)));
  await sync();
  check('…and its drawing from OneDrive', !drive.has(`projects/${id2}.json`));

  // 3. 30 days in the bin: gone for good.
  const id3 = await make('Old in bin');
  await A.evaluate(async ([id, DAY]) => { const s = await import('./js/store.js'); await s.saveProject({ ...s.projects.get(id), binnedAt: Date.now() - 31 * DAY }); }, [id3, DAY]);
  await sync();
  check('a map binned over 30 days ago goes for good', (await proj(id3))?.deleted === true, JSON.stringify(await proj(id3)));

  // 4. Deletion records over 90 days old are tidied out of the sync file.
  remoteIndex((ps) => ps.push({ id: 'ancient', deleted: true, updatedAt: Date.now() - 91 * DAY }));
  await sync();
  check('deletion records over 90 days old leave the sync file', !remote().some((x) => x.id === 'ancient'), remote().map((x) => x.id).join());
  check('…and this device', !(await A.evaluate(async () => (await import('./js/store.js')).projects.has('ancient'))));
  // Recent ones stay (other devices still need to hear about them).
  check('recent deletion records stay', remote().some((x) => x.id === id2 && x.deleted));
  await browser.close();
  done();
})();
