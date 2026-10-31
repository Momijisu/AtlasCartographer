const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  // An old-style map: no surface in its style
  await A.evaluate(async () => { const s = await import('./js/store.js'); const p = await s.createProject({ name: 'Old map', width: 4096, height: 3072 }); location.hash = '#/p/' + p.id; });
  await A.waitForSelector('.editor-canvas'); await A.waitForTimeout(300);
  await A.click('[data-tool=land]'); await A.click('[data-landmode=erase]');
  await A.$eval('.land-size', (r) => { r.value = 60; r.dispatchEvent(new Event('input')); });
  await stroke(A, [[300, 300], [600, 450], [800, 400]]);
  await A.waitForTimeout(400);
  const px = await A.evaluate(() => { const c = document.querySelector('.editor-canvas'); const g = c.getContext('2d'); const at = (x, y) => [...g.getImageData(x * devicePixelRatio, y * devicePixelRatio, 1, 1).data].slice(0, 3); return { onWater: at(600, 450), awayFromWater: at(900, 650) }; });
  console.log(JSON.stringify(px));
  await A.screenshot({ path: 'water-first.png' });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
