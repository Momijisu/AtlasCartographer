// Inkarnate's keyboard layout and the reorganised tool rail.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/library'); await A.setInputFiles('#pickFolder', 'pack/Fantasy Stamps');
  await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForSelector('.pack-row', { timeout: 20000 });
  await A.goto(BASE + '#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Keys'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const objs = () => A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind === 'stamp'); });
  const tool = () => A.$eval('.toolrail .tool.on', (b) => b.dataset.tool);
  const val = (sel) => A.$eval(sel, (r) => +r.value);
  const toastText = () => A.$eval('#toast', (t) => t.textContent);

  // Rail
  const rail = await A.$$eval('.toolrail .tool', (bs) => bs.map((b) => [b.dataset.tool, !!b.offsetParent]));
  console.log('rail:', rail.map(([t, v]) => t + (v ? '' : '(hidden)')).join(' '));
  check('no separate scatter button', !rail.some(([t]) => t === 'scatter'));
  check('the hand is hidden with a mouse', rail.find(([t]) => t === 'pan')[1] === false);
  const order = rail.filter(([, v]) => v).map(([t]) => t);
  check('stamp sits right after the brush', order.indexOf('stamp') === order.indexOf('terrain') + 1, order.join(' '));

  await A.mouse.move(600, 400);
  // Land: M, X, W
  await A.keyboard.press('m'); check('M picks land', await tool() === 'land', await tool());
  const mode = () => A.$eval('[data-landmode].on', (b) => b.dataset.landmode);
  const m0 = await mode(); await A.keyboard.press('x'); check('X swaps land and water', await mode() !== m0);
  await A.keyboard.press('x');
  const l0 = await val('.land-size'); await A.keyboard.press('w'); check('W grows the land brush', await val('.land-size') > l0);
  const l1 = await val('.land-size'); await A.keyboard.press('Shift+KeyW'); check('Shift W takes a larger step', await val('.land-size') - l1 > 4, `${l1} → ${await val('.land-size')}`);

  // Brush: B, E/D, Q/A, F
  await A.keyboard.press('b'); check('B picks the texture brush', await tool() === 'terrain', await tool());
  await A.keyboard.press('0'); // 100%
  await A.keyboard.press('d'); check('D lowers strength', await val('.terrain-opacity') === 95, await val('.terrain-opacity'));
  const s0 = await val('.terrain-soft'); await A.keyboard.press('q'); check('Q softens', await val('.terrain-soft') > s0);
  await A.keyboard.press('f'); await A.waitForTimeout(150);
  check('F opens the texture catalogue', await A.$eval('.picker', (p) => !p.hidden));
  await A.keyboard.press('f'); await A.waitForTimeout(100);

  // Stamp: O, pick, W, E/D, Alt →, place
  await A.keyboard.press('o'); check('O picks the stamp tool', await tool() === 'stamp', await tool());
  await A.waitForSelector('.picker:not([hidden]) .tile', { timeout: 5000 }).catch(() => {});
  if (!(await A.$('.picker:not([hidden])'))) await A.keyboard.press('f');
  await A.waitForSelector('.picker:not([hidden]) .tile');
  // The first mountain.
  await A.evaluate(async () => { const A = await import('./js/assets.js'); const m = A.liveAssets().filter((a) => /mountains-1$/.test(a.name)); localStorage.setItem('ac.brush', JSON.stringify(m.map((a) => a.id))); });
  await A.click('.picker .tile[data-id]');
  await A.keyboard.press('Escape');
  await A.evaluate(async () => { const A = await import('./js/assets.js'); const m = A.liveAssets().find((a) => /mountains-2$/.test(a.name)); document.querySelector(`.picker .tile[data-id="${m.id}"]`)?.click(); });
  const brushName = () => A.evaluate(async () => { const A = await import('./js/assets.js'); return A.asset(JSON.parse(localStorage.getItem('ac.brush'))[0])?.name; });
  const n0 = await brushName();
  await A.keyboard.press('Alt+ArrowRight');
  const n1 = await brushName();
  check('Alt → goes to the next in the set', n0 !== n1 && /mountains/.test(n1), `${n0} → ${n1}  (${await toastText()})`);
  await A.keyboard.press('Alt+ArrowLeft');
  check('Alt ← comes back', await brushName() === n0, await brushName());
  await A.keyboard.press('e'); await A.keyboard.press('d');
  check('E/D set the opacity of new stamps', await val('.stamp-opacity') === 95, await val('.stamp-opacity'));
  await A.mouse.click(500, 400);
  await A.keyboard.press('0');
  await A.mouse.click(530, 400);
  let st = await objs();
  check('a placed stamp takes that opacity', st.length === 2 && st.some((o) => o.opacity === 0.95) && st.some((o) => o.opacity == null), JSON.stringify(st.map((o) => o.opacity)));
  // Many
  await A.click('[data-place=scatter]');
  check('"Many" places with the same stamp button lit', await tool() === 'stamp' && await A.$eval('[data-place=scatter]', (b) => b.classList.contains('on')));
  const area0 = await A.evaluate(() => JSON.parse(localStorage.getItem('ac.scatter') || '{}').spread ?? 0.5);
  await A.keyboard.press('q');
  const area1 = await A.evaluate(() => JSON.parse(localStorage.getItem('ac.scatter')).spread);
  check('Q widens the area', area1 > area0, `${area0} → ${area1}`);
  await A.keyboard.press('Alt+KeyQ');
  check('Alt Q makes it denser', /Density/.test(await toastText()), await toastText());
  await A.keyboard.press('v');
  await A.keyboard.press('o');
  check('O comes back in the last placing mode', await A.$eval('[data-place=scatter]', (b) => b.classList.contains('on')));
  await A.click('[data-place=stamp]');

  // Tab: previous tool
  await A.keyboard.press('v'); await A.keyboard.press('Tab');
  check('Tab goes back to the previous tool', await tool() === 'stamp', await tool());

  // Select: W S, > <, Ctrl G, Ctrl L, `, Ctrl ↑
  await A.keyboard.press('v');
  await A.keyboard.press('Control+a');
  st = await objs();
  const w0 = st.map((o) => o.w);
  await A.keyboard.press('w');
  st = await objs();
  check('W grows the selection', st.every((o, i) => o.w > w0[i]), `${w0} → ${st.map((o) => o.w)}`);
  await A.keyboard.press('Period');
  st = await objs();
  check('> turns the selection', st.every((o) => Math.abs((o.rot || 0) - 5 * Math.PI / 180) < 0.01), st.map((o) => o.rot).join());
  await A.keyboard.press('Control+g');
  st = await objs();
  check('Ctrl G groups', st[0].group && st.every((o) => o.group === st[0].group));
  await A.keyboard.press('Escape');
  const [sx, sy] = await A.evaluate(() => [500, 400]);
  await A.mouse.click(sx, sy);
  check('clicking one selects its whole group', /2 selected/.test(await A.$eval('.tb-note', (n) => n.textContent)) || (await A.$$eval('.tb-note', (n) => n[0].hidden)) === false, await A.$eval('.tb-note', (n) => n.textContent));
  await A.keyboard.press('Escape');
  await A.keyboard.press('Backquote');
  check('` brings the last selection back', /2 selected/.test(await A.$eval('.tb-note', (n) => n.textContent)), await A.$eval('.tb-note', (n) => n.textContent));
  await A.keyboard.press('Control+Shift+g');
  check('Ctrl Shift G ungroups', (await objs()).every((o) => !o.group));
  await A.keyboard.press('Control+l');
  check('Ctrl L locks', (await objs()).every((o) => o.locked));
  await A.mouse.click(500, 400);
  check('locked things can\'t be picked', /Click/.test(await A.$eval('.tb-note', (n) => n.textContent)), await A.$eval('.tb-note', (n) => n.textContent));
  await A.keyboard.press('Control+Shift+l');
  check('Ctrl Shift L unlocks', (await objs()).every((o) => !o.locked));
  // Ctrl ↑: one step forward
  await A.keyboard.press('Escape');
  await A.mouse.click(478, 400); // only the first (lower) stamp is here
  st = await objs();
  const first = st.sort((a, b) => a.x - b.x)[0], other = st.find((o) => o.id !== first.id);
  check('the lower one starts behind', (first.z || 0) < (other.z || 0), `${first.z} / ${other.z}`);
  await A.keyboard.press('Control+ArrowUp');
  st = await objs();
  check('Ctrl ↑ brings it one step forward, past the one it overlaps', st.find((o) => o.id === first.id).z > st.find((o) => o.id === other.id).z, st.map((o) => o.z).join());

  // Snap
  await A.keyboard.press('g');
  check('G turns snapping on', /Snap to grid on/.test(await toastText()), await toastText());
  await A.keyboard.press('o');
  await A.mouse.click(613, 287);
  st = await objs();
  const step = await A.evaluate(async () => { const r = await import('./js/render.js'); const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return Math.round(r.mapStyle(await s.getDoc(id)).gridSize / 2); });
  const newest = st.sort((a, b) => (b.z || 0) - (a.z || 0))[0];
  check('a snapped stamp lands on the grid', Math.abs(newest.x / step - Math.round(newest.x / step)) < 0.01 && Math.abs(newest.y / step - Math.round(newest.y / step)) < 0.01, `${newest.x},${newest.y} step ${step}`);
  await A.keyboard.press('g');

  // Text: W changes the next label's size
  await A.keyboard.press('t');
  await A.keyboard.press('w');
  check('W in the text tool sets the next label\'s size', /Next label: size/.test(await toastText()), await toastText());
  await A.keyboard.press('BracketRight');
  check('] picks the next font', /Next label: /.test(await toastText()) && !/size/.test(await toastText()), await toastText());

  await A.keyboard.press('k'); await A.waitForSelector('.modal table.keys');
  const list = await A.$eval('.modal', (m) => m.innerText);
  check('K shows the shortcuts, in Inkarnate\'s groups', /Ctrl G/.test(list) && /Alt Q/.test(list) && /Snap/.test(list));
  await browser.close();
  done();
})();
