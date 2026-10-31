const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto('http://localhost:8765/#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto('http://localhost:8765/#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Preview'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const shots = [];
  // terrain brush under the mouse
  await A.click('[data-tool=land]'); await A.mouse.move(500, 400); await A.waitForTimeout(200); await A.screenshot({ path: 'pv-land.png', clip: { x: 300, y: 200, width: 400, height: 400 } });
  // stamp ghost while the size slider moves (mouse off the map)
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-grid .tile, .pk-strip .tile'); await A.click('.pk-strip .tile >> nth=0'); await A.click('[data-act=picker]');
  await A.mouse.move(5, 5);
  await A.$eval('.stamp-size', (r) => { r.value = 70; r.dispatchEvent(new Event('input')); });
  await A.waitForTimeout(150); await A.screenshot({ path: 'pv-stamp.png', clip: { x: 400, y: 250, width: 400, height: 300 } });
  // hotkeys: ? list, arrow nudge, Esc cancels, Ctrl+S
  await A.mouse.click(600, 400); // place a stamp
  await A.keyboard.press('v');
  await A.mouse.click(600, 400);
  const x0 = await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).find((o) => o.kind === 'stamp').x; });
  await A.keyboard.press('Shift+ArrowRight');
  const x1 = await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).find((o) => o.kind === 'stamp').x; });
  console.log('nudged by', Math.round((x1 - x0) * 100) / 100, 'map px (10 screen px)');
  await A.keyboard.press('Control+s'); await A.waitForTimeout(100);
  console.log('ctrl+s toast:', await A.$eval('#toast', (t) => t.textContent));
  await A.keyboard.press('?'); await A.waitForSelector('.modal table.keys');
  console.log('shortcut groups:', await A.$$eval('.modal .field-label', (f) => f.map((x) => x.textContent)));
  await A.keyboard.press('Escape');
  await A.click('[data-tool=pen]'); await A.mouse.move(300, 600); await A.mouse.down(); await A.mouse.move(500, 650, { steps: 5 });
  await A.keyboard.press('Escape'); await A.mouse.up();
  console.log('strokes after Esc mid-stroke:', await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind === 'stroke').length; }));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
