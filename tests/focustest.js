// Keyboard use (audit fix 2): Tab moves between controls once one has focus
// (it's "previous tool" only from the map), Space presses a keyboard-focused
// button, focus is visible, tool buttons say whether they're on, and dialogs
// keep focus inside them and hand it back when they close.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Keys'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const active = () => A.evaluate(() => { const e = document.activeElement; return e?.dataset?.tool || e?.dataset?.act || e?.getAttribute('aria-label') || e?.tagName; });
  const tool = () => A.$eval('.toolrail .tool.on', (b) => b.dataset.tool);
  // Tab from a control moves on.
  await A.keyboard.press('m'); await A.keyboard.press('b'); // tools: land, then brush
  await A.focus('.toolrail [data-tool=land]');
  await A.keyboard.press('Tab');
  check('Tab on a tool button moves focus to the next one', await active() === 'terrain', await active());
  check('…without switching tool', await tool() === 'terrain', await tool());
  // Space presses the keyboard-focused button.
  await A.keyboard.press('Tab'); // → stamp
  const before = await tool();
  await A.keyboard.press('Space');
  check('Space presses a keyboard-focused button', await tool() === 'stamp', `${before} → ${await tool()}`);
  await A.keyboard.press('Escape');
  // Focus is visible.
  await A.focus('.toolrail [data-tool=land]'); await A.keyboard.press('Tab');
  const ring = await A.evaluate(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, width: s.outlineWidth }; });
  check('a keyboard-focused button shows a focus ring', ring.outline !== 'none' && parseFloat(ring.width) >= 1, JSON.stringify(ring));
  // aria-pressed
  const pressed = await A.$$eval('.toolrail [data-tool]', (bs) => bs.map((b) => [b.dataset.tool, b.getAttribute('aria-pressed'), b.classList.contains('on')]));
  check('tool buttons say whether they\'re on (aria-pressed)', pressed.every(([, p, on]) => p === String(on)), JSON.stringify(pressed.filter(([, p, on]) => p !== String(on))));
  // From the map, Tab is still "previous tool".
  await A.evaluate(() => document.activeElement.blur());
  await A.keyboard.press('m'); await A.keyboard.press('b');
  await A.keyboard.press('Tab');
  check('Tab with nothing focused still goes back to the previous tool', await tool() === 'land', await tool());
  // A button that was clicked (so has focus) doesn't take over Tab or Space.
  await A.click('.toolrail [data-tool=land]'); await A.click('.toolrail [data-tool=terrain]');
  await A.keyboard.press('Tab');
  check('after clicking tool buttons, Tab is still "previous tool"', await tool() === 'land', await tool());
  await A.click('.toolrail [data-tool=stamp]'); await A.keyboard.press('Escape');
  await A.keyboard.down('Space');
  const cursor = await A.$eval('.editor-canvas', (c) => c.style.cursor);
  await A.keyboard.up('Space');
  check('…and Space moves the view instead of pressing the button again', cursor === 'grab' && await tool() === 'stamp', `${cursor}, ${await tool()}`);
  // Dialogs keep focus inside, and give it back.
  await A.click('[data-act=shortcuts]');
  await A.waitForSelector('.modal');
  check('opening a dialog moves focus into it', await A.evaluate(() => !!document.activeElement.closest('.modal')), await active());
  let inside = true;
  for (let i = 0; i < 12; i++) { await A.keyboard.press('Tab'); inside &&= await A.evaluate(() => !!document.activeElement.closest('.modal')); }
  for (let i = 0; i < 12; i++) { await A.keyboard.press('Shift+Tab'); inside &&= await A.evaluate(() => !!document.activeElement.closest('.modal')); }
  check('Tab and Shift+Tab stay inside the dialog', inside, await active());
  await A.keyboard.press('Escape');
  check('closing it returns focus to the button that opened it', await active() === 'shortcuts', await active());
  check('…and the dialog is gone', !(await A.$('.modal')));
  await browser.close();
  done();
})();
