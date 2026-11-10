// The shortcut list matches what the keys do (audit fix 9): Ctrl shortcuts
// work on keyboards whose letters aren't Latin (they go by key position), and
// the list says what 0 does in the tools where it sets opacity.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Keys'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const strokes = () => A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind === 'stroke').length; });
  // A pen stroke, then Ctrl+Z typed on a Russian layout (the Z key gives "я").
  await A.keyboard.press('p');
  await A.mouse.move(400, 300); await A.mouse.down(); await A.mouse.move(500, 350, { steps: 5 }); await A.mouse.up();
  await A.waitForTimeout(200);
  const n0 = await strokes();
  const press = (key, code, opts = {}) => A.evaluate(([key, code, opts]) => document.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true, ...opts })), [key, code, opts]);
  await press('я', 'KeyZ');
  await A.waitForTimeout(200);
  check('Ctrl+Z works on a non-Latin keyboard', await strokes() === n0 - 1, `${n0} → ${await strokes()}`);
  await press('Я', 'KeyZ', { shiftKey: true });
  await A.waitForTimeout(200);
  check('…and Ctrl+Shift+Z redoes', await strokes() === n0, `${await strokes()}`);
  // Ctrl+0 fits the map from any tool, whatever the layout ("à" is 0 on French keyboards).
  await A.mouse.wheel(0, -500); await A.waitForTimeout(300);
  const zoomed = await A.$eval('.zoom-pct', (b) => b.textContent);
  await press('à', 'Digit0');
  await A.waitForTimeout(300);
  const fit = await A.$eval('.zoom-pct', (b) => b.textContent);
  check('Ctrl+0 fits the map from the pen tool, on a French keyboard too', fit !== zoomed, `${zoomed} → ${fit}`);
  // The list says what 0 does.
  await A.keyboard.press('?'); await A.waitForSelector('.modal table.keys');
  const rows = await A.$$eval('.modal table.keys tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  const fitRow = rows.find((r) => /Fit the map/i.test(r)) || '';
  check('the list gives Ctrl 0 for fitting the map', /Ctrl 0/.test(fitRow), fitRow);
  check('…and says plain 0 sets opacity in the tools that have it', rows.some((r) => /0/.test(r) && /opacity/i.test(r) && /100%/.test(r)) && !/^0,/.test(fitRow.trim()), fitRow);
  await browser.close();
  done();
})();
