const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
const setRange = (p, sel, v) => p.$eval(sel, (r, v) => { r.value = v; r.dispatchEvent(new Event('change', { bubbles: true })); }, v);
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
  await A.click('#newProject'); await A.fill('input[name=name]', 'Adjust'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.click('[data-tool=land]');
  await A.$eval('.land-size', (r) => { r.value = 90; r.dispatchEvent(new Event('input')); });
  await stroke(A, [[300, 250], [600, 260], [850, 350], [800, 550], [450, 560], [320, 420], [400, 380], [650, 420]]);
  // half-strength grass
  await A.click('[data-tool=terrain]'); await A.click('[data-act=terrain-picker]');
  await A.waitForSelector('.picker:not([hidden]) .pk-browse'); CAT = 'Textures';
  await A.waitForSelector('.pk-browse .tile'); await A.click(`${CAT ? `.pk-section:has(.pk-cat-name:text-is("${CAT}")) ` : '.pk-browse '}.tile >> nth=0`); await A.click('[data-act=terrain-picker]');
  await A.$eval('.terrain-opacity', (r) => { r.value = 45; r.dispatchEvent(new Event('input')); });
  await stroke(A, [[350, 450], [700, 470]]);
  // three stamps, tint two
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-browse .tile'); await A.click(`${CAT ? `.pk-section:has(.pk-cat-name:text-is("${CAT}")) ` : '.pk-browse '}.tile >> nth=0`); await A.click('[data-act=picker]');
  for (const [x, y] of [[450, 330], [550, 330], [650, 330]]) await A.mouse.click(x, y);
  await A.click('[data-tool=select]');
  await A.mouse.move(400, 280); await A.mouse.down(); await A.mouse.move(600, 380, { steps: 5 }); await A.mouse.up();
  await A.click('[data-act=adjust]');
  await A.waitForSelector('.adjust-panel:not([hidden]) input[name=tint]');
  await A.$eval('.adjust-panel input[name=tint]', (r) => { r.value = '#3a6fb0'; r.dispatchEvent(new Event('change', { bubbles: true })); });
  await setRange(A, '.adjust-panel input[name=tintAmt]', 0.8);
  await setRange(A, '.adjust-panel input[name=bright]', 0.3);
  // style: hatch + scale bar
  await A.click('[data-act=style]');
  await A.selectOption('.style-panel select[name=coastStyle]', 'hatch');
  await A.selectOption('.style-panel select[name=scaleBar]', 'right');
  await A.waitForSelector('.style-panel input[name=scaleText]');
  await A.fill('.style-panel input[name=scaleText]', '50 leagues'); await A.press('.style-panel input[name=scaleText]', 'Tab');
  await A.keyboard.press('Escape');
  await A.waitForTimeout(600);
  await A.screenshot({ path: 'adjust.png' });
  console.log(JSON.stringify(await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; const d = await s.getDoc(id); return [s.liveObjects(d).filter((o) => o.kind === 'stamp').map((o) => [o.tint, o.tintAmt, o.bright]), d.objects.style.coastStyle, d.objects.style.scaleText, s.liveObjects(d).find((o) => o.kind === 'terrain').opacity]; })));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
