// Panning and zooming a big map stays smooth (audit fix 6): on a map with
// 3,000 stamps, frames while dragging the view take well under the 217 ms a
// full redraw took, and the map is drawn properly again when the drag ends.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Busy'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  // 3,000 stamps over the map, then reopen it.
  await A.evaluate(async () => {
    const s = await import('./js/store.js'), As = await import('./js/assets.js');
    const id = location.hash.split('/p/')[1], p = s.project(id);
    const art = As.liveAssets().filter((a) => a.kind === 'stamp');
    const objs = [];
    for (let i = 0; i < 3000; i++) {
      const a = art[i % art.length];
      objs.push({ id: 's' + i, kind: 'stamp', asset: a.id, x: (i * 7919) % p.width, y: (i * 104729) % p.height, w: 120, h: 120, rot: (i % 12) / 2, z: i + 1 });
    }
    await s.putObjects(id, objs);
  });
  await A.reload(); await A.waitForSelector('.editor-canvas'); await A.waitForTimeout(1500);
  // Time each paint while the view is dragged (Space + drag) and zoomed with the wheel.
  const record = () => A.evaluate(() => { window.__acPerf = []; });
  const stats = () => A.evaluate(() => {
    const all = window.__acPerf; window.__acPerf = null;
    const f = all.map((p) => p.ms).sort((a, b) => a - b);
    return { paints: f.length, full: all.filter((p) => p.full).length, median: Math.round(f[f.length >> 1]), p90: Math.round(f[Math.floor(f.length * 0.9)]) };
  });
  // A full draw, for comparison.
  await record();
  await A.evaluate(async () => { document.querySelector('[data-act=fit]').click(); await new Promise((r) => setTimeout(r, 400)); });
  const fullDraw = await A.evaluate(() => Math.round(Math.max(...window.__acPerf.filter((p) => p.full).map((p) => p.ms))));
  await A.mouse.move(600, 400);
  await A.keyboard.down('Space');
  await record();
  await A.mouse.down();
  for (let i = 0; i < 40; i++) { await A.mouse.move(600 - i * 8, 400 - i * 4); await A.waitForTimeout(16); }
  await A.screenshot({ path: 'out/pan-mid-drag.png' });
  await A.mouse.up();
  const pan = await stats();
  await A.keyboard.up('Space');
  await record();
  for (let i = 0; i < 20; i++) { await A.mouse.wheel(0, -40); await A.waitForTimeout(16); }
  const zoom = await stats();
  console.log(`a full draw takes ${fullDraw} ms; while panning: ${JSON.stringify(pan)}; while zooming: ${JSON.stringify(zoom)}`);
  check('dragging the view: paints take under 15 ms (median)', pan.median < 15, JSON.stringify(pan));
  check('…and nine in ten under 25 ms', pan.p90 < 25, JSON.stringify(pan));
  check('…with no full redraws mid-drag', pan.full <= 1, JSON.stringify(pan));
  check('wheel zooming: paints take under 15 ms (median)', zoom.median < 15, JSON.stringify(zoom));
  // When it stops, the map is drawn properly: compare the canvas with a fresh full draw.
  await A.waitForTimeout(600);
  const same = await A.evaluate(async () => {
    const c = document.querySelector('.editor-canvas');
    const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // A fresh full draw of the same view: a pan of nothing and back, then wait it out.
    window.__acPerf = [];
    document.querySelector('.editor-canvas').dispatchEvent(new WheelEvent('wheel', { deltaX: 0.01, deltaY: 0, bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    if (!window.__acPerf.some((p) => p.full)) return 'no full redraw after the view settled';
    const b = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) diff++;
    return diff / (a.length / 4);
  });
  check('once it stops, the map is redrawn in full (matches a fresh draw)', typeof same === 'number' && same < 0.002, typeof same === 'number' ? `${(same * 100).toFixed(2)}% of pixels differ` : same);
  await browser.close();
  done();
})();
