const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
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
  await A.click('#newProject'); await A.fill('input[name=name]', 'Layers'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.click('[data-tool=land]'); await stroke(A, [[300, 300], [800, 400]]);
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-browse .tile'); await A.click(`${CAT ? `.pk-section:has(.pk-cat-name:text-is("${CAT}")) ` : '.pk-browse '}.tile >> nth=0`);
  await A.mouse.click(500, 340);
  await A.click('[data-tool=text]'); await A.mouse.click(520, 345);
  await A.fill('.label-form input[name=text]', 'Over the mountain'); await A.click('.label-form button.primary');
  await A.click('[data-act=layers]');
  await A.click('[data-eye=stamp]');
  await A.waitForTimeout(300);
  await A.screenshot({ path: 'layers.png' });
  // eraser shouldn't touch hidden stamps
  await A.click('[data-tool=eraser]'); await stroke(A, [[495, 300], [505, 305]]);
  const kinds = () => A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).map((o) => o.kind).sort().join(','); });
  console.log('after erasing over hidden stamp:', await kinds());
  // lock labels: select tool can't pick it
  await A.click('[data-lock=label]');
  await A.click('[data-tool=select]'); await A.mouse.click(520, 345);
  console.log('selected with labels locked:', await A.$eval('[data-act=delete]', (b) => !b.hidden && !b.disabled));
  // stamp tool unhides stamps
  CAT = null; await A.click('[data-tool=stamp]'); await A.mouse.click(700, 380);
  console.log('stamps hidden after stamping:', await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return (await s.getDoc(id)).objects.style.hidden; }));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
