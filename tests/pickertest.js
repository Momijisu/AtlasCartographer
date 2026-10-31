const { chromium } = require('playwright');
const { device, waitSynced } = require('./mock.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  for (const dir of ['pack/Fantasy Stamps', 'pack2/City Bits']) {
    await A.goto('http://localhost:8765/#/library'); await A.setInputFiles('#pickFolder', dir);
    await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForTimeout(2500);
  }
  await A.goto('http://localhost:8765/#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Picker'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-browse');
  await A.waitForTimeout(800);
  console.log('sections:', await A.$$eval('.pk-pack-head b, .pk-cat-name', (e) => e.map((x) => x.textContent)));
  // open Mountains
  await A.click('.pk-cat-head:has-text("Mountains") .pk-cat-name'); await A.waitForTimeout(500);
  // the mountains are one stamp with variations: show them
  await A.click('.pk-set:has(.tile[aria-label="mountains"]) .pk-badge'); await A.waitForTimeout(300);
  const tiles = await A.$$('.pk-grid .tile');
  await tiles[0].click(); await A.waitForTimeout(200);
  // tag the img nodes, click another, check they're the same nodes (no re-render)
  await A.$$eval('.pk-grid .tile img', (imgs) => imgs.forEach((i) => { i.dataset.mark = '1'; }));
  await A.click('.pk-grid .tile >> nth=2', { modifiers: ['Control'] });
  await A.click('.pk-grid .tile >> nth=4', { modifiers: ['Control'] });
  console.log('images kept (no flicker):', await A.$$eval('.pk-grid .tile img', (imgs) => imgs.every((i) => i.dataset.mark === '1')), '| chosen:', await A.$eval('.pk-count', (c) => c.textContent));
  await A.screenshot({ path: 'picker.png' });
  await A.click('.pk-cat-head:has-text("Trees") [data-all]');
  console.log('after Use all on Trees:', await A.$eval('.pk-count', (c) => c.textContent));
  const chip = await A.$eval('[data-act=picker]', (b) => { const r = b.getBoundingClientRect(), i = b.querySelector('img')?.getBoundingClientRect(); return i ? [i.width <= r.width, i.height <= r.height] : 'no img'; });
  const bar = await A.$eval('.toolbar', (t) => [t.scrollHeight <= t.clientHeight + 1]);
  console.log('chip image inside its box:', chip, '| bar has no vertical scroll:', bar);
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
