const { chromium, devices } = require('playwright');
const { device, waitSynced } = require('./mock.js');
const objs = (p) => p.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind !== 'style'); });
async function setup(A, name) {
  await A.goto('http://localhost:8765/#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto('http://localhost:8765/#/');
  await A.click('#newProject'); await A.fill('input[name=name]', name); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
}
const ok = (l, v) => console.log(v ? 'ok  ' : 'FAIL', l);
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await setup(A, 'Features');
  await A.evaluate(() => localStorage.removeItem('ac.hintGone'));
  await A.reload(); await A.waitForSelector('.editor-canvas');
  ok('hint shown on empty map', await A.isVisible('.map-hint'));
  console.log(' hint:', await A.textContent('.hint-text'));
  ok('undo disabled', await A.$eval('[data-act=undo]', (b) => b.disabled));
  ok('redo disabled', await A.$eval('[data-act=redo]', (b) => b.disabled));
  await A.click('[data-tool=land]');
  await A.screenshot({ path: 'bar-land-desktop.png' });
  // tooltip
  await A.hover('[data-tool=select]'); await A.waitForTimeout(100);
  console.log(' tip:', await A.textContent('.tool-tip'), await A.isVisible('.tool-tip'));
  await A.screenshot({ path: 'tip-desktop.png', clip: { x: 0, y: 150, width: 400, height: 500 } });
  await A.mouse.move(600, 300);
  // land stroke -> hint goes, undo enabled
  await A.mouse.move(400, 300); await A.mouse.down(); await A.mouse.move(700, 350, { steps: 6 }); await A.mouse.up(); await A.waitForTimeout(600);
  console.log(' objs', (await objs(A)).map((o) => o.kind), await A.evaluate(() => document.querySelector('.map-hint').hidden));
  ok('hint hidden after drawing', !(await A.isVisible('.map-hint')));
  ok('undo enabled', !(await A.$eval('[data-act=undo]', (b) => b.disabled)));
  await A.click('[data-act=undo]'); await A.waitForTimeout(400);
  ok('hint back after undo', await A.isVisible('.map-hint'));
  ok('undo disabled again / redo enabled', (await A.$eval('[data-act=undo]', (b) => b.disabled)) && !(await A.$eval('[data-act=redo]', (b) => b.disabled)));
  await A.click('[data-hint-close]'); ok('dismissed', !(await A.isVisible('.map-hint')));
  await A.reload(); await A.waitForSelector('.editor-canvas'); ok('dismissal remembered', !(await A.isVisible('.map-hint')));
  // pen bar
  await A.click('[data-tool=pen]'); await A.screenshot({ path: 'bar-pen-desktop.png' });
  const bar = await A.$eval('.toolbar', (b) => [b.scrollHeight <= b.clientHeight, b.getBoundingClientRect().height]);
  ok('pen bar no vertical scroll ' + bar[1], bar[0]);
  console.log(' pen captions:', await A.$$eval('[data-for~=pen] .opt-cap', (c) => c.filter((x) => x.offsetParent).map((x) => x.textContent.trim())));
  await A.click('[data-tool=terrain]'); console.log(' terrain captions:', await A.$$eval('[data-for=terrain] .opt-cap', (c) => c.map((x) => x.textContent.trim())));
  await A.click('[data-tool=path]'); console.log(' path:', await A.$$eval('[data-for=path] .opt-cap', (c) => c.map((x) => x.textContent.trim())));
  // zoom
  const z0 = await A.textContent('.zoom-pct'); await A.click('[data-act=zoom-in]'); await A.waitForTimeout(100); const z1 = await A.textContent('.zoom-pct');
  await A.click('.zoom-pct'); await A.waitForTimeout(100);
  console.log(' zoom', z0, '->', z1, '-> click:', await A.textContent('.zoom-pct'));
  await A.click('[data-act=fit]'); await A.waitForTimeout(100);
  // stamp
  await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-strip .tile'); await A.click('.pk-strip .tile >> nth=0');
  // picker hover preview
  
  const tile = A.locator('.pk-strip .tile').nth(1); await tile.hover(); await A.waitForTimeout(150);
  ok('preview not yet at 150ms', !(await A.isVisible('.pk-preview')));
  await A.waitForTimeout(300);
  ok('preview visible', await A.isVisible('.pk-preview'));
  console.log(' preview:', (await A.textContent('.pk-preview')), await A.$eval('.pk-preview img', (i) => i.getBoundingClientRect().width));
  await A.screenshot({ path: 'hover-preview-desktop.png' });
  const tag = await A.$eval('.pk-strip .tile >> nth=2', (t) => (t.__m = 1, true));
  // click a tile: no re-render
  await A.$$eval('.pk-strip .tile', (t) => t.forEach((x) => (x.dataset.mark = '1')));
  await tile.click(); await A.waitForTimeout(100);
  ok('picker not re-rendered by choosing', (await A.$$eval('.pk-strip .tile[data-mark]', (t) => t.length)) > 0 && !(await A.isVisible('.pk-preview')));
  await A.click('.picker [data-close]');
  // rotate/flip
  await A.mouse.move(600, 450);
  await A.keyboard.press('.'); await A.keyboard.press('.'); await A.keyboard.press('Shift+.');
  console.log(' badge:', await A.textContent('[data-act=stamp-turn]'));
  await A.keyboard.press('f');
  ok('flip pressed', await A.$eval('[data-act=stamp-flip]', (b) => b.classList.contains('on')));
  await A.mouse.move(610, 455); await A.waitForTimeout(150);
  await A.screenshot({ path: 'bar-stamp-desktop.png' });
  await A.mouse.click(600, 450); await A.waitForTimeout(200);
  const st = (await objs(A)).find((o) => o.kind === 'stamp');
  console.log(' stamp rot/flip:', st.rot, st.flip, '(expect', (75 * Math.PI / 180).toFixed(3), 'true)');
  // select tool
  await A.click('[data-tool=select]'); await A.screenshot({ path: 'bar-select-none-desktop.png' });
  console.log(' select note:', await A.textContent('.tb-note'), '| delete hidden:', await A.$eval('[data-act=delete]', (b) => b.hidden));
  await A.mouse.click(600, 450); await A.waitForTimeout(100);
  console.log(' after select: delete hidden:', await A.$eval('[data-act=delete]', (b) => b.hidden), 'note visible:', await A.isVisible('.tb-note'));
  await A.screenshot({ path: 'bar-select-one-desktop.png' });
  await A.keyboard.press('f'); await A.waitForTimeout(100);
  ok('F flips selection not next stamp', !((await objs(A)).find((o) => o.kind === 'stamp').flip));
  await A.click('[data-tool=stamp]'); await A.mouse.click(800, 500); await A.waitForTimeout(200); await A.click('[data-tool=select]');
  await A.keyboard.press('Control+a'); await A.waitForTimeout(100);
  console.log(' multi note:', await A.textContent('.tb-note'), await A.isVisible('.tb-note')); await A.screenshot({ path: 'bar-select-multi-desktop.png', clip: { x: 200, y: 720, width: 800, height: 80 } });
  await browser.close();

  // phone
  const b2 = await chromium.launch();
  const ctx = await b2.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const P = await ctx.newPage(); P.on('pageerror', (e) => console.log('PHONE PAGEERROR', e.message));
  await P.goto('http://localhost:8765/');
  await setup(P, 'Phone'); await P.waitForTimeout(3200);
  for (const t of ['land', 'pen', 'stamp', 'select']) {
    await P.click(`[data-tool=${t}]`);
    if (t === 'stamp') { await P.waitForSelector('.pk-strip .tile'); await P.click('.pk-strip .tile >> nth=0'); await P.waitForTimeout(200); }
    await P.waitForTimeout(150);
    const r = await P.$eval('.toolbar', (b) => [b.scrollHeight <= b.clientHeight, Math.round(b.getBoundingClientRect().height), b.scrollWidth > b.clientWidth]);
    console.log(' phone', t, 'no vscroll:', r[0], 'h', r[1], 'hscroll:', r[2]);
    await P.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.display = 'none'; }); await P.screenshot({ path: `bar-${t}-phone.png` });
  }
  await P.click('[data-tool=pen]');
  console.log(' ink-custom size:', await P.$eval('.ink-custom', (i) => { const r = i.getBoundingClientRect(); return [r.width, r.height]; }));
  await b2.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
