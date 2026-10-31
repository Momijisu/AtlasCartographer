const { chromium } = require('playwright');
const { device, waitSynced } = require('./mock.js');
let CAT = null;
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto('http://localhost:8765/#/library');
  await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary');
  await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto('http://localhost:8765/#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Layered'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const objs = () => A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; const d = await s.getDoc(id); return [s.liveObjects(d).filter((o) => o.kind === 'stamp').map((o) => o.layer || '-'), (d.objects.style?.layers || []).map((l) => l.name)]; });
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-browse .tile'); await A.click(`${CAT ? `.pk-section:has(.pk-cat-name:text-is("${CAT}")) ` : '.pk-browse '}.tile >> nth=0`); await A.click('[data-act=picker]');
  await A.mouse.click(450, 330);
  await A.click('[data-act=layers]');
  await A.click('.layers-panel [data-add]');
  await A.fill('.modal input[name=name]', 'Forests'); await A.click('.modal button.primary');
  await A.waitForTimeout(200);
  await A.mouse.click(550, 330); // drawn on Forests (now active)
  console.log('after placing on Forests:', JSON.stringify(await objs()));
  await A.screenshot({ path: 'customlayers.png' });
  // move Forests below Stamps
  await A.click('.layers-panel [data-menu]'); // first row = Forests
  await A.click('.modal [data-a=down]');
  await A.waitForTimeout(200);
  console.log('order:', await A.$$eval('.layers-panel .layer-name', (b) => b.map((x) => x.textContent.trim())));
  // hide Forests, the stamp on it should be unselectable
  const forestsEye = await A.$$('.layers-panel [data-eye]');
  // delete Forests: its stamp keeps living on Stamps
  const menus = await A.$$('.layers-panel [data-menu]');
  await menus[1].click();
  await A.click('.modal [data-a=delete]');
  await A.waitForTimeout(200);
  console.log('after delete:', JSON.stringify(await objs()));
  await A.keyboard.press('Control+z');
  console.log('after undo:', JSON.stringify(await objs()));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
