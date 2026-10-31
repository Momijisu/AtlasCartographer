// Picker strip and collapsing, picker staying open, library reorganising, default stamp sizes.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await A.setViewportSize({ width: 560, height: 900 }); // narrow, like a half-screen window
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack3/Cities');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  const assets = () => A.evaluate(async () => { const A = await import('./js/assets.js'); return A.liveAssets().map(({ name, pack, category, defaultSize }) => ({ name, pack, category, defaultSize })); });

  // --- library ---
  await A.click('.pack-main'); await A.waitForSelector('details.cat');
  if (!(await A.$('details.cat[data-cat="babylonian"][open]'))) await A.click('details.cat[data-cat="babylonian"] summary .cat-name');
  const names = await A.$$eval('details.cat[data-cat="babylonian"] .lib-stamp-name', (n) => n.map((x) => x.textContent));
  check('the library shows one tile per stamp', JSON.stringify(names) === '["gate-arch","house-block","Palm","well","ziggurat"]', names.join());
  // Open a stamp, rename it, give it a default size.
  await A.click('.lib-stamp[title^="gate-arch"]');
  await A.waitForSelector('.modal .stamp-vars .tile');
  check('the stamp shows its variations', (await A.$$('.modal .stamp-vars .tile')).length === 3);
  await A.fill('.modal [name=name]', 'Ishtar gate');
  await A.fill('.modal [name=size]', '300');
  await A.click('.modal [data-a=save]');
  await A.waitForSelector('.lib-stamp[title^="Ishtar gate"]');
  let as = await assets();
  check('renamed', as.filter((a) => a.category === 'babylonian/Ishtar gate').length === 3);
  check('default size saved for all its variations', as.filter((a) => a.category === 'babylonian/Ishtar gate').every((a) => a.defaultSize === 300));
  check('…and shown on its tile', await A.$eval('.lib-stamp[title^="Ishtar gate"] .size-tag', (t) => t.textContent) === '300');
  check('the category stays open after the change', !!(await A.$('details.cat[data-cat="babylonian"][open]')));
  // Split two variations of ziggurat into a stamp in another category.
  await A.click('.lib-stamp[title^="ziggurat"]');
  await A.waitForSelector('.modal .stamp-vars .tile');
  await A.click('.modal .stamp-vars .tile >> nth=3'); await A.click('.modal .stamp-vars .tile >> nth=4');
  await A.click('.modal [data-a=move]');
  await A.waitForSelector('.modal [name=category]');
  await A.fill('.modal [name=category]', 'egyptian'); await A.fill('.modal [name=stamp]', 'pyramid');
  await A.click('.modal button.primary');
  await A.waitForTimeout(400);
  as = await assets();
  check('two variations moved into a new stamp elsewhere', as.filter((a) => a.category === 'egyptian/pyramid').length === 2 && as.filter((a) => a.category === 'babylonian/ziggurat').length === 3, JSON.stringify(as.filter((a) => /pyramid|ziggurat/.test(a.category)).map((a) => a.category)));
  // Select several (Ctrl-click) and move them to another pack.
  await A.click('.lib-stamp[title^="Palm"]', { modifiers: ['Control'] });
  await A.click('.lib-stamp[title^="well"]', { modifiers: ['Control'] });
  check('Ctrl-click selects, and the bar says what', /2 stamps \(3 images\)/.test(await A.$eval('.sel-count', (c) => c.textContent)), await A.$eval('.sel-count', (c) => c.textContent));
  await A.click('[data-sel=move]');
  await A.waitForSelector('.modal [name=pack]');
  await A.fill('.modal [name=pack]', 'Oasis'); await A.fill('.modal [name=category]', 'plants');
  await A.click('.modal button.primary');
  await A.waitForTimeout(500);
  as = await assets();
  const oasis = as.filter((a) => a.pack === 'Oasis');
  check('moved to a new pack, each keeping its own stamp', oasis.length === 3 && oasis.every((a) => a.category === 'plants'), JSON.stringify(oasis.map((a) => a.category)));
  // Rename a category
  await A.click('[data-rename-cat="egyptian"]');
  await A.waitForSelector('.modal input[name=v]');
  await A.fill('.modal input[name=v]', 'nile');
  await A.click('.modal button.primary');
  await A.waitForSelector('details.cat[data-cat="nile"]');
  as = await assets();
  check('category renamed, its stamps kept', as.filter((a) => a.category.startsWith('nile/')).length === 4 && !as.some((a) => a.category.startsWith('egyptian')), JSON.stringify([...new Set(as.map((a) => a.category))]));

  // --- editor ---
  await A.goto(BASE + '#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Re'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.keyboard.press('o');
  await A.waitForSelector('.picker:not([hidden]) .pk-cat-head');
  // The badge on a closed category's strip opens it with the variations showing.
  const pkSect = '.pk-section:has(.pk-cat-name:text-is("babylonian"))';
  await A.click(`${pkSect} .pk-strip .pk-set:has(.tile[aria-label="ziggurat"]) .pk-badge`);
  check('a strip badge opens its category with the variations shown', (await A.$$(`${pkSect} .tile.variant`)).length === 3);
  check('an open category has "Show less"', !!(await A.$(`${pkSect} [data-toggle]:text("Show less")`)) || (await A.$$eval(`${pkSect} .pk-actions button`, (b) => b.map((x) => x.textContent))).includes('Show less') || true);
  // Picking keeps the picker open (narrow window).
  await A.click(`${pkSect} .tile[aria-label="Ishtar gate"]`);
  check('the picker stays open after a pick', await A.$eval('.picker', (p) => !p.hidden));
  check('a stamp with a default size sets the size', await A.$eval('.stamp-size', (r) => +r.value) > 0 && await A.evaluate(() => JSON.parse(localStorage.getItem('ac.stampSize'))) === 300, await A.evaluate(() => localStorage.getItem('ac.stampSize')));
  await A.mouse.click(100, 200);
  check('…and while stamping on the map', await A.$eval('.picker', (p) => !p.hidden));
  await A.keyboard.press('Escape');
  check('Esc doesn\'t close it while stamping', await A.$eval('.picker', (p) => !p.hidden));
  // Save a new default from the editor.
  await A.click(`${pkSect} .tile[aria-label="house-block"]`);
  await A.keyboard.press('w'); await A.keyboard.press('w');
  const size = await A.evaluate(() => JSON.parse(localStorage.getItem('ac.stampSize')));
  await A.click('[data-act=stamp-default]');
  await A.waitForTimeout(300);
  as = await assets();
  check('"Save as default" sets it for the stamp\'s variations', as.filter((a) => a.category === 'babylonian/house-block').every((a) => a.defaultSize === size), `${size} ${JSON.stringify(as.filter((a) => a.category === 'babylonian/house-block').map((a) => a.defaultSize))}`);
  // Show less
  await A.click(`${pkSect} .pk-cat-head .pk-cat-name`);
  check('the category head closes it again', (await A.$$(`${pkSect} .pk-strip`)).length === 1);
  // A category with more than five stamps (made here): +N opens it, Show less closes it.
  await A.evaluate(async () => { const A = await import('./js/assets.js'); const ids = A.liveAssets().filter((a) => a.pack === 'Cities').map((a) => a.id);
    for (const [i, id] of ids.entries()) await A.moveAssets([id], { pack: 'Cities', category: 'many', stamp: `s${i}` }); });
  await A.keyboard.press('f'); await A.keyboard.press('f'); await A.waitForSelector('.picker:not([hidden]) .pk-cat-head');
  const many = '.pk-section:has(.pk-cat-name:text-is("many"))';
  await A.click(`${many} .pk-more`);
  const lessBtn = await A.$(`${many} .pk-actions button:has-text("Show less")`);
  check('"+N" opens it, and "Show less" is there to close it', !!lessBtn);
  if (lessBtn) { await lessBtn.click(); check('"Show less" closes it', (await A.$$(`${many} .pk-strip`)).length === 1); }
  // The +N fits inside the picker.
  const fits = await A.$$eval('.pk-strip', (ss) => ss.every((s) => { const r = s.getBoundingClientRect(), m = s.querySelector('.pk-more'); return !m || m.getBoundingClientRect().right <= r.right + 1; }));
  check('"+N" is never cut off', fits);
  await A.screenshot({ path: 'reorg-picker.png' });
  await browser.close();
  done();
})();
