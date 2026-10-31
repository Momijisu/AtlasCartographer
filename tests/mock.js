const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8765/';
const drive = new Map(); // path → { body, eTag }
const folders = new Set();
let etagN = 0, log = [];
async function handle(route) {
  const req = route.request();
  const u = new URL(req.url());
  if (u.host === 'dl.fake') {
    if (global.__delay) { const d = global.__delay('GET', '/dl/' + decodeURIComponent(u.pathname.slice(1))); if (d) await new Promise((r) => setTimeout(r, d)); }
    const f = drive.get(decodeURIComponent(u.pathname.slice(1)));
    return f ? route.fulfill({ status: 200, body: f.body, contentType: f.type || 'application/json', headers: { 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 404 });
  }
  const rest = decodeURIComponent(u.pathname.replace('/v1.0/me/drive/special/approot', ''));
  const m = req.method();
  log.push(m + ' ' + rest);
  if (global.__delay) { const d = global.__delay(m, rest); if (d) await new Promise((r) => setTimeout(r, d)); }
  if (global.__fail) { const st = global.__fail(m, rest); if (st) return route.fulfill({ status: st, body: JSON.stringify({ error: { message: 'injected ' + st } }), contentType: 'application/json', headers: st === 429 ? { 'Retry-After': '120', 'access-control-expose-headers': 'Retry-After' } : {} }); }
  const json = (status, obj) => route.fulfill({ status, body: JSON.stringify(obj), contentType: 'application/json' });
  if (m === 'POST') return json(400, { error: { message: 'Invalid request' } });
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
    const pre = path === '' ? '' : path + '/';
    if (!folders.has(path)) return json(404, { error: { message: 'nf' } });
    return json(200, { value: [...drive].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([k, v]) => ({ name: k.slice(pre.length), eTag: v.eTag, '@microsoft.graph.downloadUrl': 'https://dl.fake/' + encodeURIComponent(k) })) });
  }
  if (op === 'content' && m === 'PUT') {
    const cur = drive.get(path);
    const h = req.headers();
    if (h['if-match'] && (!cur || cur.eTag !== h['if-match'])) return json(412, { error: { message: 'pre' } });
    if (h['if-none-match'] === '*' && cur) return json(412, { error: { message: 'pre' } });
    // Like OneDrive: uploading to a path creates its folders.
    path.split('/').slice(0, -1).forEach((_, i, a) => folders.add(a.slice(0, i + 1).join('/')));
    const f = { body: req.postDataBuffer(), type: req.headers()['content-type'], eTag: '"e' + (++etagN) + '"' };
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
  await page.goto(BASE);
  return page;
}
const badge = (p) => p.$eval('#syncBtn', (b) => b.className);
async function waitSynced(p) { for (let i = 0; i < 60; i++) { if ((await badge(p)).includes('synced')) return; await p.waitForTimeout(250); } throw new Error('never synced: ' + await badge(p) + ' ' + await p.$eval('#syncBtn', b => b.title)); }
async function stroke(p, pts) {
  await p.mouse.move(...pts[0]); await p.mouse.down();
  for (const q of pts.slice(1)) await p.mouse.move(...q, { steps: 8 });
  await p.mouse.up();
}

module.exports={device,drive,waitSynced,stroke,log,folders,BASE,handle,tokens};
