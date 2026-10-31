// Hold R (or Ctrl) and scroll to turn the next stamp or the selection; a tap of R still picks shapes.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack3/Cities');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Rot'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.keyboard.press('o'); await A.waitForSelector('.picker:not([hidden]) .tile');
  await A.click('.picker .tile >> nth=0');
  await A.mouse.move(400, 400);
  const rot = () => A.$eval('[data-val=stampRot]', (b) => b.textContent);
  const tool = () => A.$eval('.toolrail .tool.on', (b) => b.dataset.tool);
  const zoom = () => A.$eval('.zoom-pct', (b) => b.textContent);
  await A.keyboard.down('r'); await A.mouse.wheel(0, 100); await A.mouse.wheel(0, 100); await A.keyboard.up('r');
  check('hold R and scroll turns the next stamp', await rot() === '30°', await rot());
  check('…and stays in the stamp tool', await tool() === 'stamp', await tool());
  const z0 = await zoom();
  await A.keyboard.down('Control'); await A.mouse.wheel(0, -100); await A.keyboard.up('Control');
  check('Ctrl + scroll turns it back', await rot() === '15°', await rot());
  check('…without zooming', await zoom() === z0, `${z0} → ${await zoom()}`);
  await A.keyboard.down('r'); await A.keyboard.down('Alt'); await A.mouse.wheel(0, 100); await A.keyboard.up('Alt'); await A.keyboard.up('r');
  check('with Alt, finely', await rot() === '20°', await rot());
  await A.mouse.click(400, 400);
  const st = await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).find((o) => o.kind === 'stamp'); });
  check('the placed stamp is turned', Math.abs(st.rot - 20 * Math.PI / 180) < 0.001, st.rot);
  // Selection
  await A.keyboard.press('v'); await A.mouse.click(400, 400);
  await A.keyboard.down('r'); await A.mouse.wheel(0, 100); await A.keyboard.up('r');
  const st2 = await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).find((o) => o.kind === 'stamp'); });
  check('R + scroll turns the selection too', Math.abs(st2.rot - 35 * Math.PI / 180) < 0.001, st2.rot);
  check('…staying in select', await tool() === 'select', await tool());
  // A tap of R picks shapes.
  await A.keyboard.press('o'); await A.keyboard.press('r');
  check('a tap of R still picks the shape tool', await tool() === 'shape', await tool());
  // Plain scrolling still zooms.
  await A.keyboard.press('o');
  const z1 = await zoom(); await A.mouse.wheel(0, -200); await A.waitForTimeout(100);
  check('plain scrolling still zooms', await zoom() !== z1, `${z1} → ${await zoom()}`);
  await browser.close();
  done();
})();
