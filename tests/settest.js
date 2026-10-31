// Pack / category / stamp / variations: the picker groups by the first folder, one tile per stamp.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack3/Cities');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  console.log('library:', await A.$eval('.pack-row', (r) => r.innerText.replace(/\s+/g, ' ')));
  await A.click('.pack-main'); await A.waitForSelector('details.cat');
  const cats = await A.$$eval('details.cat', (d) => d.map((x) => x.dataset.cat));
  check('the library shows the first folders as categories', JSON.stringify(cats) === '["babylonian","egyptian"]', cats.join());
  await A.goto(BASE + '#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Sets'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.keyboard.press('o');
  await A.waitForSelector('.picker:not([hidden]) .pk-cat-head');
  const heads = await A.$$eval('.pk-cat-name', (h) => h.map((x) => x.textContent));
  check('the picker has the same two categories', JSON.stringify(heads) === '["babylonian","egyptian"]', heads.join());
  // Open babylonian
  await A.click('.pk-cat-head:has(.pk-cat-name:text-is("babylonian"))');
  const tiles = await A.$$eval('.pk-section:has(.pk-cat-name:text-is("babylonian")) .pk-grid > .pk-set > .tile', (t) => t.map((x) => x.getAttribute('aria-label')));
  check('one tile per stamp: folders, numbered names, and single pictures', JSON.stringify(tiles) === '["gate-arch","house-block","Palm","well","ziggurat"]', tiles.join());
  const badges = await A.$$eval('.pk-section:has(.pk-cat-name:text-is("babylonian")) .pk-badge', (b) => b.map((x) => x.textContent));
  check('badges count the variations', JSON.stringify(badges) === '["3","3","2","5"]', badges.join());
  // Click a stamp: with random on, all its variations.
  const brush = () => A.evaluate(async () => { const A = await import('./js/assets.js'); return JSON.parse(localStorage.getItem('ac.brush')).map((id) => A.asset(id).name).sort(); });
  await A.click('.tile[aria-label="ziggurat"]');
  check('a stamp\'s tile picks all its variations (random on)', (await brush()).length === 5, (await brush()).join());
  // Show the variations, pick one.
  await A.click('.pk-set:has(.tile[aria-label="gate-arch"]) .pk-badge');
  const variants = await A.$$eval('.tile.variant', (t) => t.map((x) => x.getAttribute('aria-label')));
  check('the badge shows the variations beside it', JSON.stringify(variants) === '["gate-arch-1","gate-arch-2","gate-arch-3"]', variants.join());
  await A.click('.tile.variant[aria-label="gate-arch-2"]');
  check('a variation\'s tile picks just it', JSON.stringify(await brush()) === '["gate-arch-2"]', (await brush()).join());
  await A.click('.pk-set.open .pk-badge');
  check('…and the badge hides them again', (await A.$$('.tile.variant')).length === 0);
  // Random off: a stamp's tile picks its first; Alt → steps through its variations.
  await A.click('[data-act=picker]').catch(() => {});
  await A.keyboard.press('Escape');
  await A.click('[data-act=stamp-random]');
  await A.keyboard.press('f'); await A.waitForSelector('.picker:not([hidden]) .tile[aria-label="house-block"]');
  await A.click('.tile[aria-label="house-block"]');
  check('random off: the stamp\'s first variation', JSON.stringify(await brush()) === '["house-block-1"]', (await brush()).join());
  await A.keyboard.press('Escape');
  await A.mouse.move(600, 400);
  await A.keyboard.press('Alt+ArrowRight');
  check('Alt → goes to its next variation', JSON.stringify(await brush()) === '["house-block-2"]', (await brush()).join());
  await A.keyboard.press('Alt+ArrowLeft'); await A.keyboard.press('Alt+ArrowLeft');
  check('Alt ← wraps round within the stamp', JSON.stringify(await brush()) === '["house-block-3"]', (await brush()).join());
  await A.click('[data-act=stamp-random]');
  check('random back on: all of its variations', (await brush()).length === 3, (await brush()).join());
  // Library kind toggle applies to the whole category.
  await A.evaluate(async () => { const A = await import('./js/assets.js'); await A.setCategoryKind('Cities', 'egyptian', 'texture'); });
  const kinds = await A.evaluate(async () => { const A = await import('./js/assets.js'); return [...new Set(A.liveAssets().filter((a) => A.groupOf(a) === 'egyptian').map((a) => a.kind))]; });
  check('stamps/textures applies to everything in the category', JSON.stringify(kinds) === '["texture"]', kinds.join());
  await A.keyboard.press('f'); await A.waitForTimeout(300);
  await A.screenshot({ path: 'sets.png' });
  await browser.close();
  done();
})();
