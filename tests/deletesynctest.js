// Deleting maps (audit fix 4): a delete from another device never wipes
// edits this device hasn't synced yet, and deletion records older than 90
// days are tidied out of the sync file.
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

  // 4. Deletion records over 90 days old are tidied out of the sync file.
  remoteIndex((ps) => ps.push({ id: 'ancient', deleted: true, updatedAt: Date.now() - 91 * DAY }));
  await sync();
  check('deletion records over 90 days old leave the sync file', !remote().some((x) => x.id === 'ancient'), remote().map((x) => x.id).join());
  check('…and this device', !(await A.evaluate(async () => (await import('./js/store.js')).projects.has('ancient'))));
  // Recent ones stay (other devices still need to hear about them).
  const id2 = await make('Deleted now');
  await A.evaluate(async (id) => (await import('./js/store.js')).deleteProject(id), id2);
  await sync();
  check('recent deletion records stay', remote().some((x) => x.id === id2 && x.deleted));
  await browser.close();
  done();
})();
