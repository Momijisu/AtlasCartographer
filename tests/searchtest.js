const { chromium } = require('playwright');
const { device, waitSynced } = require('./mock.js');
let CAT = null;
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  for (const dir of ['pack/Fantasy Stamps', 'pack2/City Bits']) {
    await A.goto('http://localhost:8765/#/library'); await A.setInputFiles('#pickFolder', dir);
    await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForTimeout(2500);
  }
  await A.goto('http://localhost:8765/#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Search'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-search');
  await A.type('.pk-search', 'roof');
  await A.waitForTimeout(500);
  console.log('search "roof":', await A.$eval('.pk-found', (p) => p.textContent), await A.$$eval('.pk-browse .tile', (t) => t.map((x) => x.getAttribute("aria-label"))));
  console.log('focus kept:', await A.evaluate(() => document.activeElement.className), JSON.stringify(await A.$eval('.pk-search', (i) => i.value)));
  await A.type('.pk-search', ' 2'); await A.waitForTimeout(500);
  console.log('search "roof 2":', await A.$$eval('.pk-browse .tile', (t) => t.map((x) => x.getAttribute("aria-label"))));
  await A.click('.pk-browse .tile'); await A.click('[data-act=picker]');
  await A.mouse.click(500, 400);
  await A.click('[data-act=picker]'); await A.fill('.pk-search', ''); await A.dispatchEvent('.pk-search', 'input'); await A.waitForTimeout(400);
  await A.waitForTimeout(300);
  console.log('recent:', await A.$$eval('.pk-section:has(.pk-cat-name:text-is("Recently used")) .tile', (t) => t.map((x) => x.getAttribute("aria-label"))));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
