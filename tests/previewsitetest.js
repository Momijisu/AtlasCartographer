// The preview at /preview/: built like the Pages workflow, it shows a Preview
// tag, keeps its own database and offline cache, puts its maps in OneDrive's
// preview/ folder, and the live app's service worker doesn't take over its pages.
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { drive } = require('./mock.js');
const mock = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  // Assemble the site as .github/workflows/pages.yml does (from the working tree).
  const root = path.resolve(__dirname, '..');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'acsite-'));
  const copy = (to) => execSync(`tar -C "${root}" --exclude=.git --exclude=tests --exclude=.github -cf - . | tar -C "${to}" -xf -`);
  copy(site); fs.mkdirSync(path.join(site, 'preview')); copy(path.join(site, 'preview'));
  const wf = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  const sed = wf.match(/sed -i (-e [\s\S]*?) _site\/preview\/manifest\.webmanifest/)[1].replace(/\\\n\s*/g, ' ');
  execSync(`sed -i ${sed} "${site}/preview/manifest.webmanifest"`);
  const server = spawn('python3', ['-m', 'http.server', '8766', '--directory', site], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(site, 'preview/manifest.webmanifest'), 'utf8'));
    check('the preview installs as its own app', manifest.id === 'atlascartographer-preview' && /preview/i.test(manifest.name), `${manifest.id} / ${manifest.name}`);

    // Service workers on, OneDrive mocked.
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.route(/graph\.microsoft\.com|dl\.fake/, mock.handle);
    await ctx.addInitScript((t) => { if (!localStorage.getItem('ac.tokens')) localStorage.setItem('ac.tokens', t); }, mock.tokens);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:8766/'); await page.waitForSelector('#view');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await page.waitForSelector('#view');
    check('the live app has a controlling service worker', await page.evaluate(() => !!navigator.serviceWorker.controller));
    check('the live app has no Preview tag', !(await page.$('.preview-tag')));
    await page.click('#newProject'); await page.fill('input[name=name]', 'Live map'); await page.click('.modal button.primary');
    await page.waitForSelector('.editor-canvas');
    await page.goto('http://localhost:8766/preview/'); await page.waitForSelector('#view');
    await page.waitForTimeout(500);
    const pv = await page.$$eval('.project-card', (c) => c.map((x) => x.textContent));
    check('the preview doesn\'t list the live app\'s maps', !pv.some((t) => /Live map/.test(t)), pv.join('|'));
    check('/preview/ opens the preview, not the live app\'s cached page', !!(await page.$('.preview-tag')), await page.title());
    check('…with a title that says so', /preview/i.test(await page.title()), await page.title());
    await page.evaluate(() => navigator.serviceWorker.ready);
    // A map made in the preview
    await page.click('#newProject'); await page.fill('input[name=name]', 'Preview map'); await page.click('.modal button.primary');
    await page.waitForSelector('.editor-canvas');
    await page.evaluate(async () => (await import('./js/sync.js')).sync({ force: true }));
    for (let i = 0; i < 40 && ![...drive.keys()].some((k) => k.startsWith('preview/projects/')); i++) await page.waitForTimeout(250);
    const keys = [...drive.keys()];
    check('its maps go to OneDrive\'s preview/ folder', keys.includes('preview/projects.json') && keys.some((k) => k.startsWith('preview/projects/')), keys.join(' '));
    check('…and not the live app\'s', !keys.includes('projects.json') && !keys.some((k) => /^projects\//.test(k)));
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());
    check('it keeps its own database on the device', dbs.includes('atlascartographer-preview'), dbs.join());
    await page.goto('http://localhost:8766/'); await page.waitForSelector('#view');
    await page.waitForTimeout(500);
    const live = await page.$$eval('.project-card', (c) => c.map((x) => x.textContent));
    check('the live app lists its own map but not the preview\'s', live.some((t) => /Live map/.test(t)) && !live.some((t) => /Preview map/.test(t)), live.join('|'));
    const cacheKeys = await page.evaluate(() => caches.keys());
    check('both offline caches survive each other', cacheKeys.some((k) => /^cartographer-\d/.test(k)) && cacheKeys.some((k) => /^cartographer-preview-/.test(k)), cacheKeys.join());
    check('no page errors', !errors.length, errors.join(' | '));
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(site, { recursive: true, force: true });
  }
  done();
})();
