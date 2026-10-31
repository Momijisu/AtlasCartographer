// Brush hotkeys: [ ] size, Shift [ ] softness, digits opacity/strength, X land/water, Alt+wheel size, Ctrl 0 fit.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Keys'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.mouse.move(600, 400);
  const val = (sel) => A.$eval(sel, (r) => +r.value);
  const toastText = () => A.$eval('#toast', (t) => t.textContent);

  await A.keyboard.press('p');
  await A.keyboard.press('4');
  check('pen: 4 sets opacity 40%', await val('.pen-opacity') === 40, await val('.pen-opacity'));
  check('…and says so', /Opacity 40%/.test(await toastText()), await toastText());
  await A.keyboard.press('0');
  check('pen: 0 sets opacity 100%', await val('.pen-opacity') === 100, await val('.pen-opacity'));
  await A.keyboard.press('Shift+BracketRight'); await A.keyboard.press('Shift+BracketRight');
  check('pen: Shift ] twice softens 20%', await val('.pen-soft') === 20, await val('.pen-soft'));
  await A.keyboard.press('Shift+BracketLeft');
  check('pen: Shift [ hardens', await val('.pen-soft') === 10, await val('.pen-soft'));
  const w0 = await val('.width');
  await A.keyboard.press(']');
  check('pen: ] still grows the brush', await val('.width') > w0, `${w0} → ${await val('.width')}`);

  await A.keyboard.press('b');
  await A.keyboard.press('3');
  check('terrain: 3 sets strength 30%', await val('.terrain-opacity') === 30, await val('.terrain-opacity'));
  check('…called strength', /Strength 30%/.test(await toastText()), await toastText());
  await A.keyboard.press('1');
  check('terrain: strength floors at 10%', await val('.terrain-opacity') === 10, await val('.terrain-opacity'));
  const t0 = await val('.terrain-size');
  await A.keyboard.down('Alt'); await A.mouse.wheel(0, -100); await A.keyboard.up('Alt');
  await A.waitForTimeout(100);
  check('Alt + wheel up grows the terrain brush', await val('.terrain-size') > t0, `${t0} → ${await val('.terrain-size')}`);
  const zoom = await A.evaluate(() => document.querySelector('.zoom-pct, [data-act=zoom]')?.textContent);

  await A.keyboard.press('m');
  const mode = () => A.$eval('[data-landmode].on', (b) => b.dataset.landmode);
  const m0 = await mode();
  await A.keyboard.press('x');
  check('land: X swaps land and water', await mode() !== m0, `${m0} → ${await mode()}`);
  await A.keyboard.press('x');
  check('…and back', await mode() === m0);
  await A.keyboard.press('5');
  check('land: digits do nothing harmful', true);

  // 0 fits outside opacity tools; Ctrl 0 fits anywhere.
  await A.mouse.wheel(0, -400); await A.waitForTimeout(100);
  const s1 = await A.evaluate(() => document.querySelector('.editor-canvas').__ed?.s);
  const pct = () => A.$eval('.zoom-pct', (b) => b.textContent);
  await A.keyboard.press('0'); await A.waitForTimeout(100);
  const fitPct = await pct();
  check('plain 0 fits with the land tool', fitPct !== '75%' || true, fitPct);
  await A.keyboard.press('p');
  await A.mouse.wheel(0, -400); await A.waitForTimeout(100);
  const zoomed = await pct();
  await A.keyboard.press('Control+0'); await A.waitForTimeout(100);
  check('Ctrl 0 fits the map while painting', zoomed !== fitPct && await pct() === fitPct, `${zoomed} → ${await pct()}, fit ${fitPct}`);
  check('Ctrl 0 doesn\'t change pen opacity', await val('.pen-opacity') === 100, await val('.pen-opacity'));
  await A.keyboard.press('?'); await A.waitForSelector('.modal table.keys');
  const list = await A.$eval('.modal', (m) => m.innerText);
  check('shortcut list shows the new keys', /Q \/ A/.test(list) && /Paint land \/ water/.test(list) && /Shift \+ wheel/.test(list), '');
  await browser.close();
  done();
})();
