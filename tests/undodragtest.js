// Undo in the middle of a drag (audit fix 10): Ctrl+Z while dragging a stamp
// drops the drag (as Esc does), and letting go afterwards changes nothing;
// the change before it isn't undone or brought back.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Undo'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.keyboard.press('o'); await A.waitForSelector('.picker:not([hidden]) .tile');
  await A.click('.picker .tile >> nth=0'); await A.click('.picker [data-close]');
  await A.mouse.click(400, 300); // stamp 1
  await A.mouse.click(700, 500); // stamp 2
  const stamps = () => A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind === 'stamp').map((o) => [Math.round(o.x), Math.round(o.y)]).sort((a, b) => a[0] - b[0]); });
  const before = await stamps();
  await A.keyboard.press('v');
  await A.mouse.move(700, 500); await A.mouse.down();
  await A.mouse.move(760, 540, { steps: 4 }); await A.mouse.move(820, 580, { steps: 4 });
  await A.keyboard.press('Control+z');
  await A.mouse.move(850, 600, { steps: 3 });
  await A.mouse.up();
  await A.waitForTimeout(300);
  const after = await stamps();
  check('both stamps are still there', after.length === 2, JSON.stringify(after));
  check('the dragged stamp is back where it was', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  // Undo now undoes the last real change: placing stamp 2.
  await A.keyboard.press('Control+z'); await A.waitForTimeout(200);
  check('the next Ctrl+Z undoes the stamp placed before the drag', (await stamps()).length === 1, JSON.stringify(await stamps()));
  await A.keyboard.press('Control+Shift+z'); await A.waitForTimeout(200);
  check('…and redo brings it back', (await stamps()).length === 2, JSON.stringify(await stamps()));
  await browser.close();
  done();
})();
