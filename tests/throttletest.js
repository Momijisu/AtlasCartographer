const { chromium } = require('playwright');
const { device, drive } = require('./mock.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  let mode = 'short', hits = 0;
  await A.context().route(/graph\.microsoft\.com/, (route) => {
    if (mode === 'short' && hits < 2) { hits++; return route.fulfill({ status: 429, headers: { 'Retry-After': '1', 'access-control-expose-headers': 'Retry-After' }, body: '{}' }); }
    if (mode === 'long') { hits++; return route.fulfill({ status: 429, headers: { 'Retry-After': '120', 'access-control-expose-headers': 'Retry-After' }, body: '{}' }); }
    return route.fallback();
  });
  await A.click('#newProject'); await A.fill('input[name=name]', 'Throttled'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.click('#syncBtn');
  for (let i = 0; i < 40 && !(await A.$eval('#syncBtn', (b) => b.className)).includes('synced'); i++) await A.waitForTimeout(250);
  console.log('short throttle: badge', await A.$eval('#syncBtn', (b) => b.className), '| 429s served', hits, '| on drive', [...drive.keys()].length);
  mode = 'long'; hits = 0;
  await A.click('#syncBtn'); await A.waitForTimeout(1500);
  console.log('long throttle: badge', await A.$eval('#syncBtn', (b) => b.className), '|', await A.$eval('#syncBtn', (b) => b.title));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
