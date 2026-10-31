// L9: imports run 3 wide with batched saves; duplicates are still skipped once, and a pack's map type still applies.
const { chromium } = require('playwright');
const { BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(BASE); await page.waitForSelector('#view');
  const r = await page.evaluate(async () => {
    const A = await import('./js/assets.js'); const db = await import('./js/db.js');
    const mk = (i) => new Promise((res) => { const c = document.createElement('canvas'); c.width = c.height = 1024; const g = c.getContext('2d'); g.fillStyle = `hsl(${i % 360},60%,50%)`; g.fillRect(0, 0, 1024, 1024); for (let k = 0; k < 200; k++) { g.fillStyle = `rgb(${(i * k) % 255},${(k * 7) % 255},${(i + k) % 255})`; g.fillRect((i * 13 + k * 37) % 1000, (k * 51) % 1000, 40, 40); } c.toBlob(res); });
    const blobs = []; for (let i = 0; i < 60; i++) blobs.push(await mk(i));
    const entries = blobs.map((b, i) => ({ path: `P/C${i % 4}/i${i}.png`, blob: async () => b }));
    // the same pictures again under other names, side by side, so workers collide on them
    for (let i = 0; i < 10; i++) { entries.splice(5 + i * 3, 0, { path: `P/Dup/copy${i}a.png`, blob: async () => blobs[i] }, { path: `P/Dup/copy${i}b.png`, blob: async () => blobs[i] }); }
    entries.push({ path: 'P/C0/broken.png', blob: async () => new Blob(['not a png'], { type: 'image/png' }) });
    entries.push({ path: 'P/readme.txt', blob: async () => new Blob(['hi']) });
    let tx = 0; const o = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (n, m) { if (m === 'readwrite') tx++; return o.apply(this, arguments); };
    const t0 = performance.now();
    const res = await A.importEntries(entries, 'P');
    const ms = performance.now() - t0;
    IDBDatabase.prototype.transaction = o;
    const ids = A.liveAssets().map((a) => a.id);
    const [bl, th, st] = await Promise.all([db.getAllKeys('blobs'), db.getAllKeys('thumbs'), db.getAllKeys('assetState')]);
    // into an existing pack of a given kind of map
    await A.setPackType('P', 'world');
    const more = [{ path: 'P/New/x1.png', blob: async () => mk(500) }, { path: 'P/New/x2.png', blob: async () => mk(501) }, { path: 'P/New/x3.png', blob: async () => mk(502) }];
    const res2 = await A.importEntries(more, 'P');
    const added = A.liveAssets().filter((a) => a.category.endsWith('New'));
    return { res, res2, ms: Math.round(ms), perImage: +(ms / res.added).toFixed(1), tx, live: ids.length, stored: [bl.length, th.length, st.length], types: added.map((a) => a.mapType) };
  });
  console.log(JSON.stringify(r));
  check('60 distinct pictures added once each', r.res.added === 60 && r.live === 60, `${r.res.added} added, ${r.live} in the catalogue`);
  check('the 20 repeated ones, the broken file are skipped; the text file ignored', r.res.skipped === 21, r.res.skipped);
  check('every record has its file, thumbnail and state', r.stored.every((n) => n >= 60), r.stored.join('/'));
  check('a pack\'s map type reaches pictures added to it', r.types.length === 3 && r.types.every((t) => t === 'world'), r.types.join());
  console.log(`per image: ${r.perImage} ms; ${r.tx} write transactions for 60 images`);
  check('far fewer write transactions than one per picture', r.tx < 20, r.tx);
  await browser.close(); done();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
