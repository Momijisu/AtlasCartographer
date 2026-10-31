const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('ERR', e.message));
  await page.goto('http://localhost:8765/');
  const r = await page.evaluate(async () => {
    const R = await import('./js/render.js');
    const project = { id: 'p1', width: 2048, height: 1536 };
    const objs = {};
    let z = 0, t = 1;
    const add = (o) => { objs[o.id] = { ...o, z: ++z, updatedAt: ++t }; };
    const line = (x0, y0, x1, y1, n = 20) => { const p = []; for (let i = 0; i <= n; i++) p.push(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); return p; };
    for (let i = 0; i < 30; i++) add({ id: 'l' + i, kind: 'land', mode: 'add', width: 160, points: line(200 + i * 50, 300, 300 + i * 40, 1200) });
    add({ id: 'e1', kind: 'land', mode: 'erase', width: 90, points: line(400, 700, 1500, 800) });
    add({ id: 't1', kind: 'terrain', texture: null, soft: 0.6, opacity: 0.7, width: 200, points: line(500, 400, 1200, 900) });
    const doc = () => ({ id: 'p1', objects: { ...objs, style: { id: 'style', kind: 'style', land: '#c8b88a' } } });
    const draw = (cache) => { const c = document.createElement('canvas'); c.width = project.width; c.height = project.height; const ctx = c.getContext('2d'); const t0 = performance.now(); R.drawDoc(ctx, project, doc(), { landScale: 1, cache }); return [c, performance.now() - t0]; };
    const diff = (a, b) => { const x = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, y = b.getContext('2d').getImageData(0, 0, b.width, b.height).data; let n = 0, max = 0; for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); if (d > 2) n++; if (d > max) max = d; } return [n, max]; };
    const out = [];
    const [, tFull0] = draw(true); // fills the cache
    const step = (name, fn) => { fn(); const [c, ms] = draw(true); const [f, msFull] = draw(false); out.push([name, Math.round(ms), Math.round(msFull), ...diff(c, f)]); };
    step('add land', () => add({ id: 'n1', kind: 'land', mode: 'add', width: 120, points: line(1700, 200, 1900, 500) }));
    step('carve water', () => add({ id: 'n2', kind: 'land', mode: 'erase', width: 60, points: line(600, 900, 900, 1000) }));
    step('add terrain', () => add({ id: 'n3', kind: 'terrain', texture: null, soft: 0.8, opacity: 0.5, width: 150, points: line(300, 1100, 700, 1150) }));
    step('remove land', () => { delete objs.l5; });
    step('undo-ish change', () => { objs.n1 = { ...objs.n1, deleted: true, updatedAt: ++t }; });
    return [Math.round(tFull0), out];
  });
  console.log('first full render ms:', r[0]);
  for (const [name, partial, full, badPx, maxDiff] of r[1]) console.log(`${name.padEnd(16)} partial ${partial} ms, full ${full} ms, differing px ${badPx}, max diff ${maxDiff}`);
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
