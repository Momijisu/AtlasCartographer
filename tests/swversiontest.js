// The offline copy of the app never mixes two versions (audit fix 11): a
// file changed on the server without a new version number isn't picked up
// piecemeal into the running version's cache; a new version comes in whole.
// (Kept as a guard: the audit's concern didn't reproduce here. The service
// worker's background refresh never reached the server on reload.)
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { check, done } = require('./tlib.js');
(async () => {
  const root = path.resolve(__dirname, '..');
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'acsw-'));
  execSync(`tar -C "${root}" --exclude=.git --exclude=tests --exclude=.github -cf - . | tar -C "${site}" -xf -`);
  const server = spawn('python3', ['-m', 'http.server', '8767', '--directory', site], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const url = 'http://localhost:8767/';
    await page.goto(url); await page.waitForSelector('#view');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await page.waitForSelector('#view');
    check('the app is running from its offline copy', await page.evaluate(() => !!navigator.serviceWorker.controller));
    // What the offline copy holds (and so what the next launch runs).
    const served = () => page.evaluate(async () => {
      for (const k of await caches.keys()) { const r = await (await caches.open(k)).match('js/render.js'); if (r && (await r.text()).includes('// CHANGED ON THE SERVER')) return true; }
      return false;
    });
    // A file changes on the server, with the same version number.
    fs.appendFileSync(path.join(site, 'js/render.js'), '\n// CHANGED ON THE SERVER\n');
    await page.reload(); await page.waitForSelector('#view'); await page.waitForTimeout(800);
    await page.reload(); await page.waitForSelector('#view'); await page.waitForTimeout(500);
    check('a file changed without a new version isn\'t mixed into the running version', !(await served()));
    // A new version: everything comes in together.
    const v = path.join(site, 'js/version.js');
    fs.writeFileSync(v, fs.readFileSync(v, 'utf8').replace(/AC_VERSION = '([^']+)'/, "AC_VERSION = '$1-next'"));
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await page.waitForFunction(() => caches.keys().then((k) => k.some((x) => x.endsWith('-next'))), null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.goto(url); await page.waitForSelector('#view'); await page.waitForTimeout(500);
    const keys = await page.evaluate(() => caches.keys());
    check('a new version brings the changed file', await served(), keys.join());
    check('…and replaces the old offline copy', keys.length === 1 && keys[0].endsWith('-next'), keys.join());
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(site, { recursive: true, force: true });
  }
  done();
})();
