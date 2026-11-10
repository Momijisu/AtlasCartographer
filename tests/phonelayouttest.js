// Phone layout (audit fix 5), measured at 375 × 740 with touch: undo, redo
// and zoom are on screen whatever tool is chosen; every tool can be reached
// (the rail shows when there's more to scroll to); the stamp picker leaves
// the middle of the map visible; and on a computer, choosing another tool
// closes the stamp picker.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const mock = require('./mock.js');
  await ctx.route(/graph\.microsoft\.com|dl\.fake/, mock.handle);
  await ctx.addInitScript((t) => { if (!localStorage.getItem('ac.tokens')) localStorage.setItem('ac.tokens', t); }, mock.tokens);
  const P = await ctx.newPage();
  await P.goto(BASE + '#/library'); await P.waitForSelector('#pickFolder', { state: 'attached' });
  await P.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await P.waitForSelector('.modal input[name=pack]'); await P.click('.modal button.primary'); await P.waitForSelector('.pack-row', { timeout: 20000 });
  await P.goto(BASE + '#/'); await P.click('#newProject'); await P.fill('input[name=name]', 'Phone'); await P.click('.modal button.primary');
  await P.waitForSelector('.editor-canvas');
  const W = 375, H = 740;
  const onScreen = (sel) => P.$eval(sel, (el, [W, H]) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= W && r.top >= 0 && r.bottom <= H; }, [W, H]);
  const bad = [];
  for (const t of ['land', 'terrain', 'stamp', 'shape', 'path', 'pen', 'text', 'select']) {
    await P.evaluate((t) => document.querySelector(`.toolrail [data-tool="${t}"]`)?.click(), t);
    await P.evaluate(() => { const p = document.querySelector('.picker'); if (p) p.hidden = true; });
    // (On a phone, zooming is a pinch; the zoom level is shown, and tapping it goes to 100%.)
    for (const sel of ['[data-act=undo]', '[data-act=redo]', '[data-act=zoom-100]', '[data-act=fit]', '[data-act=layers]', '[data-act=style]']) if (!(await onScreen(sel))) bad.push(`${t}:${sel}`);
  }
  check('undo, redo, zoom level, fit, layers and style are on screen for every tool', !bad.length, bad.join(' '));
  // The rail: every tool reachable, with a sign when it's cut off.
  const rail = await P.$eval('.toolrail', (r) => ({ sw: r.scrollWidth, cw: r.clientWidth, sh: r.scrollHeight, ch: r.clientHeight, cls: r.className, hint: getComputedStyle(r).maskImage || getComputedStyle(r).webkitMaskImage }));
  const cut = rail.sw > rail.cw + 1 || rail.sh > rail.ch + 1;
  check('the tool rail fits, or shows that it scrolls', !cut || (rail.hint && rail.hint !== 'none'), JSON.stringify(rail));
  await P.$eval('.toolrail', (r) => { r.scrollLeft = r.scrollWidth; });
  await P.waitForTimeout(150);
  const end = await P.$eval('.toolrail', (r) => r.className);
  check('scrolled to its end, the rail fades at the start instead', /more-before/.test(end) && !/more-after/.test(end), end);
  await P.$eval('.toolrail', (r) => { r.scrollLeft = 0; });
  // The picker leaves the middle of the map in view.
  await P.click('.toolrail [data-tool=stamp]');
  await P.waitForSelector('.picker:not([hidden])');
  const pk = await P.$eval('.picker', (p) => p.getBoundingClientRect().toJSON());
  const centre = H / 2;
  check('the stamp picker leaves the middle of the map visible', pk.top > centre, `picker top ${Math.round(pk.top)} vs middle ${centre}`);
  await P.screenshot({ path: 'out/phone-picker.png' });
  await P.click('.picker [data-tall]');
  const tall = await P.$eval('.picker', (p) => Math.round(p.getBoundingClientRect().top));
  await P.screenshot({ path: 'out/phone-picker-tall.png' });
  await P.click('.picker [data-tall]');
  const back = await P.$eval('.picker', (p) => Math.round(p.getBoundingClientRect().top));
  check('the picker\'s button makes it taller, and back', tall < 150 && back === Math.round(pk.top), `${Math.round(pk.top)} → ${tall} → ${back}`);
  await P.click('.picker [data-close]');
  await P.click('.toolrail [data-tool=land]');
  await P.screenshot({ path: 'out/phone-land.png' });
  await ctx.close();
  // On a computer, choosing another tool closes the stamp picker.
  const D = await device(browser, 'D');
  await waitSynced(D);
  await D.goto(BASE + '#/'); await D.click('#newProject'); await D.fill('input[name=name]', 'Desk'); await D.click('.modal button.primary');
  await D.waitForSelector('.editor-canvas');
  await D.keyboard.press('o'); await D.waitForSelector('.picker:not([hidden])');
  await D.keyboard.press('m');
  check('choosing another tool closes the stamp picker', await D.$eval('.picker', (p) => p.hidden));
  await D.keyboard.press('o');
  check('…and the stamp tool opens it again', await D.$eval('.picker', (p) => !p.hidden));
  await D.mouse.move(600, 400);
  await D.screenshot({ path: 'out/desktop-viewbar.png' });
  await browser.close();
  done();
})();
