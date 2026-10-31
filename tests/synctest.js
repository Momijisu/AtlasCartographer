const { chromium } = require('playwright');
const drive = new Map(); // path → { body, eTag }
const folders = new Set();
let etagN = 0, log = [];
async function handle(route) {
  const req = route.request();
  const u = new URL(req.url());
  if (u.host === 'dl.fake') {
    const f = drive.get(decodeURIComponent(u.pathname.slice(1)));
    return f ? route.fulfill({ status: 200, body: f.body, contentType: 'application/json' }) : route.fulfill({ status: 404 });
  }
  const rest = decodeURIComponent(u.pathname.replace('/v1.0/me/drive/special/approot', ''));
  const m = req.method();
  log.push(m + ' ' + rest);
  const json = (status, obj) => route.fulfill({ status, body: JSON.stringify(obj), contentType: 'application/json' });
  if (rest === '/children' || rest.endsWith(':/children') && m === 'POST') {
    const parent = rest === '/children' ? '' : rest.slice(2, -':/children'.length);
    const name = JSON.parse(req.postData()).name;
    const p = parent ? parent + '/' + name : name;
    if (folders.has(p)) return json(409, { error: { message: 'exists' } });
    folders.add(p); return json(201, { name });
  }
  const parts = rest.slice(2).split(':/');
  const path = parts[0], op = parts[1];
  if (op === 'children') {
    const pre = path + '/';
    if (!folders.has(path)) return json(404, { error: { message: 'nf' } });
    return json(200, { value: [...drive].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([k, v]) => ({ name: k.slice(pre.length), eTag: v.eTag })) });
  }
  if (op === 'content' && m === 'PUT') {
    const cur = drive.get(path);
    const h = req.headers();
    if (h['if-match'] && (!cur || cur.eTag !== h['if-match'])) return json(412, { error: { message: 'pre' } });
    if (h['if-none-match'] === '*' && cur) return json(412, { error: { message: 'pre' } });
    const f = { body: req.postData(), eTag: '"e' + (++etagN) + '"' };
    drive.set(path, f); return json(200, { eTag: f.eTag });
  }
  if (m === 'DELETE') { const had = drive.delete(path); return route.fulfill({ status: had ? 204 : 404 }); }
  if (m === 'GET') {
    const f = drive.get(path);
    if (!f) return json(404, { error: { message: 'nf' } });
    return json(200, { eTag: f.eTag, '@microsoft.graph.downloadUrl': 'https://dl.fake/' + encodeURIComponent(path) });
  }
  return json(500, { error: { message: 'unhandled ' + m + rest } });
}
const tokens = JSON.stringify({ access_token: 'x', refresh_token: 'r', expires_at: Date.now() + 3600e3, session_at: Date.now(), account: { name: 'Test', username: 't@x' } });
async function device(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block' });
  await ctx.route(/graph\.microsoft\.com|dl\.fake/, handle);
  await ctx.addInitScript((t) => { if (!localStorage.getItem('ac.tokens')) localStorage.setItem('ac.tokens', t); }, tokens);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(name, 'PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(name, 'console', m.text()); });
  await page.goto('http://localhost:8765/');
  return page;
}
const badge = (p) => p.$eval('#syncBtn', (b) => b.className);
async function waitSynced(p) { for (let i = 0; i < 60; i++) { if ((await badge(p)).includes('synced')) return; await p.waitForTimeout(250); } throw new Error('never synced: ' + await badge(p) + ' ' + await p.$eval('#syncBtn', b => b.title)); }
async function stroke(p, pts) {
  await p.mouse.move(...pts[0]); await p.mouse.down();
  for (const q of pts.slice(1)) await p.mouse.move(...q, { steps: 8 });
  await p.mouse.up();
}
const forceSync = (p) => p.click('#syncBtn');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.click('#newProject');
  await A.fill('input[name=name]', 'Shattered Coast');
  await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await stroke(A, [[300, 300], [500, 350], [700, 300]]);
  await stroke(A, [[300, 500], [600, 520]]);
  await A.waitForTimeout(3500); await waitSynced(A);
  console.log('drive after A:', [...drive.keys()]);
  const pid = A.url().split('/p/')[1];
  const docA = JSON.parse(drive.get(`projects/${pid}.json`).body);
  console.log('strokes on drive:', Object.keys(docA.objects).length);

  const B = await device(browser, 'B');
  await waitSynced(B);
  await B.waitForSelector('.project-card');
  console.log('B sees:', await B.$$eval('.project-card h3', (h) => h.map((x) => x.textContent)));
  await B.screenshot({ path: 'home.png' });
  await B.click('.project-card');
  await B.waitForSelector('.editor-canvas');
  // concurrent edits
  await stroke(B, [[400, 600], [800, 650]]);
  await stroke(A, [[200, 200], [250, 650]]);
  await A.waitForTimeout(3500); await B.waitForTimeout(500);
  await forceSync(A); await waitSynced(A); await forceSync(B); await waitSynced(B); await forceSync(A); await waitSynced(A);
  const count = (p) => p.evaluate(async (id) => { const s = await import('./js/store.js'); return s.liveObjects(await s.getDoc(id)).length; }, pid);
  console.log('A strokes', await count(A), 'B strokes', await count(B));
  await A.screenshot({ path: 'editor.png' });
  // undo on A, eraser on B
  await A.keyboard.press('Control+z');
  await A.waitForTimeout(3500); await waitSynced(A); await forceSync(B); await waitSynced(B);
  console.log('after undo: A', await count(A), 'B', await count(B));
  // rename + delete from B
  await B.goto('http://localhost:8765/#/'); await B.waitForSelector('.project-card');
  await B.click('[data-menu]'); await B.click('[data-del]'); await B.click('[data-yes]');
  await B.waitForTimeout(3500); await waitSynced(B);
  await forceSync(A); await waitSynced(A); await A.waitForTimeout(500);
  console.log('A url after delete:', A.url(), 'drive:', [...drive.keys()]);
  console.log('A projects:', await A.evaluate(async () => (await import('./js/store.js')).live().length));
  console.log('requests:', log.length);
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
