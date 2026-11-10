// Signing back in as a different Microsoft account (audit fix 13): whether
// through Disconnect or Reconnect, the new account gets everything this
// device has, art files included, since it has none of it.
const { chromium } = require('playwright');
const { device, drive, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/'); await A.click('#newProject'); await A.fill('input[name=name]', 'Mine'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.goto(BASE + '#/');
  const sync = () => A.evaluate(async () => { const s = await import('./js/sync.js'); await s.sync({ force: true }); });
  const art = () => [...drive.keys()].filter((k) => k.startsWith('assets/')).length;
  await sync();
  for (let i = 0; i < 40 && art() < 10; i++) await A.waitForTimeout(250);
  const first = art();
  check('the first account has the art', first >= 10, first);
  // The session lapses and "Reconnect" signs in as someone else, whose OneDrive is empty.
  drive.clear();
  await A.evaluate(() => { const t = JSON.parse(localStorage.getItem('ac.tokens')); t.account = { name: 'Other', username: 'other@x' }; localStorage.setItem('ac.tokens', JSON.stringify(t)); });
  await A.reload(); await A.waitForSelector('#view');
  await sync();
  for (let i = 0; i < 40 && art() < first; i++) await A.waitForTimeout(250);
  check('after Reconnect as another account, its OneDrive gets the maps', drive.has('projects.json') && [...drive.keys()].some((k) => k.startsWith('projects/')));
  check('…and the art files', art() === first, `${art()} of ${first}`);
  check('…and the catalogue', drive.has('assets.json'));
  // Signing back in as the same account doesn't upload everything again.
  const puts = [];
  await A.route('**/*', (r) => { if (r.request().method() === 'PUT') puts.push(r.request().url()); r.fallback(); });
  await A.reload(); await A.waitForSelector('#view');
  await sync(); await A.waitForTimeout(1500);
  check('the same account again uploads nothing new', puts.filter((u) => /assets%2F|assets\//.test(u)).length === 0, puts.length);
  await browser.close();
  done();
})();
