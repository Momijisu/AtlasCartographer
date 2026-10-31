const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const b = await chromium.launch();
  const A = await device(b, 'A'); await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'T'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.keyboard.press('r'); await A.keyboard.press('f');
  await A.waitForSelector('.picker:not([hidden]) .pk-browse .tile');
  check('F opens the fill textures', /Shape fill/.test(await A.$eval('.picker header', (h) => h.textContent)));
  await A.click('.pk-browse .tile >> nth=0');
  await A.keyboard.press('f');
  await A.mouse.move(400, 300); await A.mouse.down(); await A.mouse.move(600, 500, { steps: 5 }); await A.mouse.up();
  const o = await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).find((o) => o.kind === 'shape'); });
  check('the shape takes the texture', !!o?.fillTex, o?.fillTex);
  await A.waitForTimeout(500);
  await A.screenshot({ path: 'shapetex.png', clip: { x: 300, y: 200, width: 400, height: 400 } });
  // export
  await A.click('#exportBtn'); await A.waitForSelector('.modal');
  const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 30000 }), A.click('.modal button.primary')]);
  check('the map exports with shapes', !!(await dl.path()));
  await b.close(); done();
})();
