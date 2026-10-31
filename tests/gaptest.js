const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
const objs = (p, id) => p.evaluate(async (id) => { const s = await import('./js/store.js'); const pid = id || location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(pid)); }, id);
let CAT = null;
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto('http://localhost:8765/#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto('http://localhost:8765/#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Gaps'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  // colour brush: wide, soft, see-through red region
  await A.click('[data-tool=pen]');
  await A.$eval('.ink-custom', (i) => { i.value = '#c03030'; i.dispatchEvent(new Event('input')); });
  await A.$eval('.width', (r) => { r.value = 80; r.dispatchEvent(new Event('input')); });
  await A.$eval('.pen-opacity', (r) => { r.value = 40; r.dispatchEvent(new Event('input')); });
  await A.$eval('.pen-soft', (r) => { r.value = 70; r.dispatchEvent(new Event('input')); });
  await stroke(A, [[300, 300], [500, 250], [700, 350]]);
  // scatter: dense, spread wide, rotated
  CAT = null; await A.click('[data-tool=stamp]'); await A.click('[data-place=scatter]'); await A.waitForSelector('.pk-browse .tile'); await A.click(`${CAT ? `.pk-section:has(.pk-cat-name:text-is("${CAT}")) ` : '.pk-browse '}.tile >> nth=0`); await A.click('[data-act=picker]');
  await A.click('[data-act=scatter-settings]');
  for (const [n, v] of [['spacing', 1.9], ['spread', 1.5], ['rotate', 1]]) await A.$eval(`.scatter-panel input[name=${n}]`, (r, v) => { r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await A.$eval('.stamp-size', (r) => { r.value = 30; r.dispatchEvent(new Event('input')); });
  await stroke(A, [[300, 550], [800, 560]]);
  const o = await objs(A);
  const st = o.filter((x) => x.kind === 'stamp');
  const brush = o.find((x) => x.kind === 'stroke');
  console.log('brush:', brush.color, brush.width, brush.opacity, brush.soft, '| scattered', st.length, 'rotations', st.slice(0, 4).map((x) => x.rot.toFixed(2)).join(' '));
  await A.screenshot({ path: 'gaps.png' });
  const pid = A.url().split('/p/')[1];
  // duplicate + resize from the maps page
  await A.goto('http://localhost:8765/#/'); await A.waitForSelector('[data-menu]');
  await A.click('[data-menu]'); await A.click('.modal [data-dup]'); await A.waitForTimeout(800);
  const cards = await A.$$eval('.project-card h3', (h) => h.map((x) => x.textContent));
  console.log('cards:', cards);
  const before = (await objs(A, pid)).find((x) => x.kind === 'stamp');
  const menus = await A.$$('[data-menu]');
  for (const mnu of menus) { const name = await mnu.evaluate((b) => b.closest('.project-card').querySelector('h3').textContent); if (name === 'Gaps') { await mnu.click(); break; } }
  await A.click('.modal [data-size]'); await A.waitForSelector('.modal select[name=k]');
  await A.selectOption('.modal select[name=k]', '2'); await A.click('.modal button.primary'); await A.waitForTimeout(800);
  const after = (await objs(A, pid)).find((x) => x.id === before.id);
  const proj = await A.evaluate(async (pid) => { const s = await import('./js/store.js'); const p = s.project(pid); return [p.width, p.height]; }, pid);
  console.log('resized to', proj, '| stamp', [before.x, before.w], '->', [after.x, after.w]);
  await A.screenshot({ path: 'gaps-home.png' });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
