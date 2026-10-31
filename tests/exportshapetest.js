// Exporting a map keeps the textures inside shapes (audit fix 1): the
// exported picture's pixels in a textured shape are the texture's, not the
// shape's plain fill colour.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Export shapes'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const r = await A.evaluate(async () => {
    const s = await import('./js/store.js'), As = await import('./js/assets.js'), ex = await import('./js/export.js');
    const id = location.hash.split('/p/')[1], p = s.project(id);
    const tex = As.liveAssets().find((a) => a.kind === 'texture');
    // A big textured rectangle in the middle, and a plain one beside it for comparison.
    await s.putObjects(id, [
      { id: 'tx', kind: 'shape', shape: 'rect', x: p.width * 0.3, y: p.height / 2, w: p.width * 0.3, h: p.height * 0.5, rot: 0, fill: true, fillColor: '#ff00ff', fillTex: tex.id, stroke: false, strokeColor: '#000000', strokeWidth: 4, dash: 'solid', opacity: 1, z: 1 },
      { id: 'pl', kind: 'shape', shape: 'rect', x: p.width * 0.75, y: p.height / 2, w: p.width * 0.2, h: p.height * 0.5, rot: 0, fill: true, fillColor: '#ff00ff', fillTex: null, stroke: false, strokeColor: '#000000', strokeWidth: 4, dash: 'solid', opacity: 1, z: 2 },
    ]);
    // A fresh page has no art decoded: forget what the editor loaded, as after a reload.
    const blob = await ex.renderMap(s.project(id), { type: 'image/png', scale: 0.25 });
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const px = (x, y) => [...g.getImageData(Math.round(x * bmp.width), Math.round(y * bmp.height), 1, 1).data.slice(0, 3)];
    return { textured: px(0.3, 0.5), plain: px(0.75, 0.5) };
  });
  const magenta = (c) => c[0] > 200 && c[1] < 60 && c[2] > 200;
  check('the plain shape exports in its colour', magenta(r.plain), r.plain.join());
  check('the textured shape exports with its texture, not the plain colour', !magenta(r.textured), r.textured.join());
  await browser.close();
  done();
})();
