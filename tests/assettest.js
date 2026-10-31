const { chromium } = require('playwright');
const { device, drive, waitSynced, log } = require('./mock.js');
const keys = (pre) => [...drive.keys()].filter((k) => k.startsWith(pre));
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto('http://localhost:8765/#/library');
  await A.waitForSelector('#pickFiles', { state: 'attached' });
  await A.setInputFiles('#pickFiles', 'pack.zip');
  await A.waitForSelector('.modal input[name=pack]');
  console.log('dialog:', await A.$eval('.modal p', (p) => p.textContent), '| pack =', await A.$eval('.modal input[name=pack]', (i) => i.value));
  await A.click('.modal button.primary');
  await A.waitForSelector('.pack-row', { timeout: 20000 });
  console.log('A packs:', await A.$$eval('.pack-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' '))));
  // also import the same folder again: everything should be skipped
  await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]');
  await A.click('.modal button.primary');
  await A.waitForTimeout(1500);
  console.log('toast:', await A.$eval('#toast', (t) => t.textContent));
  for (let i = 0; i < 40 && keys('assets/').length < 14; i++) await A.waitForTimeout(500);
  await A.waitForTimeout(1000);
  console.log('drive: assets', keys('assets/').length, 'thumbs', keys('thumbs/').length, 'catalogue', drive.has('assets.json'));
  const cat = JSON.parse(drive.get('assets.json').body.toString());
  console.log('categories:', [...new Set(cat.assets.map((a) => a.category + ':' + a.kind))]);

  const B = await device(browser, 'B');
  await waitSynced(B);
  await B.goto('http://localhost:8765/#/library');
  await B.waitForSelector('.pack-row');
  await B.waitForTimeout(2500);
  await B.click('.pack-main');
  await B.waitForSelector('.tile');
  await B.waitForTimeout(1500);
  console.log('B tiles', await B.$$eval('.tile', (t) => t.length), 'with img', await B.$$eval('.tile img', (t) => t.length));
  await B.screenshot({ path: 'pack.png', fullPage: true });
  // on-demand full-size
  const id = cat.assets[0].id;
  console.log('on-demand blob bytes:', await B.evaluate(async (id) => (await (await import('./js/assetsync.js')).getAssetBlob(id))?.size, id), 'expected', cat.assets[0].size);
  // keep offline
  await B.check('#pinPack');
  await B.waitForTimeout(2500);
  console.log('B blobs after pin:', await B.evaluate(async () => (await (await import('./js/assets.js')).blobIds()).size));
  // switch a category's kind
  await B.click('.kind-seg[data-cat="Trees"] [data-kind=texture]');
  // delete from B
  await B.click('#delPack'); await B.click('[data-yes]');
  await B.waitForTimeout(500); await B.click('#syncBtn'); await waitSynced(B); await B.waitForTimeout(2000);
  console.log('drive after delete: assets', keys('assets/').length, 'thumbs', keys('thumbs/').length);
  await A.click('#syncBtn'); await waitSynced(A); await A.waitForTimeout(800);
  console.log('A packs after delete:', await A.$$eval('.pack-row', (r) => r.length), 'A blobs', await A.evaluate(async () => (await (await import('./js/assets.js')).blobIds()).size));
  await A.screenshot({ path: 'library.png' });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
