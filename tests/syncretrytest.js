// Sync keeps going (audit fix 12): one map that won't upload doesn't stop the
// others syncing, and says which; a drawing download that OneDrive asks to
// slow down (429) waits and retries, as every other request does.
const { chromium } = require('playwright');
const { device, drive, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  const ids = [];
  for (const n of ['First', 'Second', 'Third']) {
    await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', n); await A.click('.modal button.primary');
    await A.waitForSelector('.editor-canvas');
    ids.push(await A.evaluate(() => location.hash.split('/p/')[1]));
  }
  await A.goto(BASE + '#/');
  const sync = () => A.evaluate(async () => (await import('./js/sync.js')).sync({ force: true }));
  await sync();
  // An edit on each map; the second map's uploads fail.
  for (const id of ids) await A.evaluate(async (id) => { const s = await import('./js/store.js'); await s.putObjects(id, [{ id: 'mark', kind: 'stroke', color: '#000', width: 4, points: [1, 1, 9, 9], z: 1 }]); }, id);
  global.__fail = (m, rest) => (m === 'PUT' && rest.includes(ids[1]) ? 500 : 0);
  await sync();
  const has = (id) => drive.has(`projects/${id}.json`) && JSON.parse(drive.get(`projects/${id}.json`).body.toString()).objects?.mark;
  check('the first map synced', !!has(ids[0]));
  check('the third map synced, though the second failed', !!has(ids[2]));
  check('the second didn\'t', !has(ids[1]));
  const status = await A.$eval('#syncBtn', (b) => `${b.className} ${b.title}`);
  check('the sync status names the map that failed', /error/.test(status) && /Second/.test(status), status);
  global.__fail = null;
  await sync();
  check('it syncs once the problem clears', !!has(ids[1]));
  // A second device whose drawing downloads are told to slow down, once each.
  const told = new Set();
  global.__fail = (m, rest) => (rest.startsWith('/dl/projects/') && !told.has(rest) ? (told.add(rest), 429) : 0);
  const B = await device(browser, 'B');
  await waitSynced(B);
  const got = await B.evaluate(async (ids) => { const s = await import('./js/store.js'); const out = []; for (const id of ids) out.push(!!(await s.getDoc(id))?.objects?.mark); return out; }, ids);
  global.__fail = null;
  check('drawings told to slow down (429) are fetched after waiting', got.every(Boolean) && told.size === 3, `${JSON.stringify(got)} after ${told.size} slow-downs`);
  await browser.close();
  done();
})();
