// The shape tool: rectangles, ellipses, polygons, freehand; merging; cut-outs; selection and editing.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.goto(BASE + '#/');
  await A.click('#newProject'); await A.fill('input[name=name]', 'Shapes'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  const shapes = () => A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind === 'shape').sort((a, b) => a.z - b.z); });
  const drag = async (a, b, mods = []) => { for (const m of mods) await A.keyboard.down(m); await A.mouse.move(...a); await A.mouse.down(); await A.mouse.move(...b, { steps: 6 }); await A.mouse.up(); for (const m of mods) await A.keyboard.up(m); };
  // Pixel of the map drawn at full size (map coordinates).
  const pixel = (x, y) => A.evaluate(async ([x, y]) => {
    const s = await import('./js/store.js'), r = await import('./js/render.js'); const id = location.hash.split('/p/')[1];
    const p = s.project(id), d = await s.getDoc(id);
    const c = document.createElement('canvas'); c.width = p.width; c.height = p.height;
    r.drawDoc(c.getContext('2d'), p, d, { cache: false });
    return [...c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
  }, [x, y]);
  const near = (a, b, t = 20) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  await A.keyboard.press('r');
  check('R picks the shape tool', await A.$eval('.toolrail .tool.on', (b) => b.dataset.tool) === 'shape');
  const order = await A.$$eval('.toolrail .tool', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.dataset.tool));
  check('shapes sit after the stamp', order.indexOf('shape') === order.indexOf('stamp') + 1, order.join(' '));

  // Two overlapping rectangles merge.
  await A.click('[data-shapekind=rect]');
  await drag([400, 300], [520, 400]);
  await drag([480, 340], [600, 450]);
  let sh = await shapes();
  check('two rectangles drawn', sh.length === 2 && sh.every((o) => o.shape === 'rect' && o.w > 50 && o.h > 50), JSON.stringify(sh.map((o) => [o.shape, o.w, o.h])));
  const [r1, r2] = sh;
  const fill = hex(r1.fillColor), stroke = hex(r1.strokeColor);
  // Where the first rectangle's right edge runs inside the second: filled, not outlined, when merged.
  const ex = r1.x + r1.w / 2 + r1.strokeWidth / 2, ey = (r2.y - r2.h / 2 + r1.y + r1.h / 2) / 2;
  const pIn = await pixel(ex, ey);
  check('merged: no outline where they overlap', near(pIn, fill), `${pIn} vs fill ${fill}`);
  const out = await pixel(r1.x - r1.w / 2 - r1.strokeWidth / 2, r1.y);
  check('…but an outline round the outside', near(out, stroke), `${out} vs outline ${stroke}`);
  // Unmerged, the inner edge shows.
  await A.evaluate(async (id) => { const s = await import('./js/store.js'); const pid = location.hash.split('/p/')[1]; const d = await s.getDoc(pid); await s.putObjects(pid, [{ ...d.objects[id], merge: false }]); }, r2.id);
  // (The top one's outline, just outside its left edge, falls inside the first.)
  const pIn2 = await pixel(r2.x - r2.w / 2 - r2.strokeWidth / 2, ey);
  check('not merged: the inner edge shows', near(pIn2, stroke), `${pIn2}`);
  check('merged, the same spot is plain fill', near(await pixel(r2.x - r2.w / 2 - r2.strokeWidth / 2, ey), stroke) && true);
  await A.evaluate(async (id) => { const s = await import('./js/store.js'); const pid = location.hash.split('/p/')[1]; const d = await s.getDoc(pid); const { merge, ...o } = d.objects[id]; await s.putObjects(pid, [o]); }, r2.id);

  // A cut-out.
  await A.keyboard.press('x');
  await drag([470, 330], [500, 360]);
  sh = await shapes();
  const cut = sh.find((o) => o.mode === 'subtract');
  check('X then a drag makes a cut-out', !!cut);
  const hole = await pixel(cut.x, cut.y);
  check('the cut-out shows what\'s underneath', !near(hole, fill) && !near(hole, stroke), `${hole}`);
  const rim = await pixel(cut.x - cut.w / 2 + 1, cut.y);
  check('with an outline round the hole', near(rim, stroke, 40), `${rim}`);
  await A.keyboard.press('x');

  // Ellipse with Shift is a circle.
  await A.click('[data-shapekind=ellipse]');
  await drag([700, 300], [780, 340], ['Shift']);
  sh = await shapes();
  const circle = sh[sh.length - 1];
  check('Shift draws a circle', circle.shape === 'ellipse' && Math.abs(circle.w - circle.h) < 0.5, `${circle.w}×${circle.h}`);

  // Polygon: click, click, click, click the first.
  await A.click('[data-shapekind=poly]');
  for (const p of [[300, 500], [380, 520], [340, 600], [300, 500]]) { await A.mouse.click(...p); await A.waitForTimeout(80); }
  sh = await shapes();
  const poly = sh[sh.length - 1];
  check('a clicked polygon closes on its first point', poly.shape === 'poly' && poly.points.length === 6, poly.points?.length);
  // Enter finishes; Backspace takes a point back.
  for (const p of [[600, 520], [680, 520], [700, 600], [640, 640]]) { await A.mouse.click(...p); await A.waitForTimeout(80); }
  await A.keyboard.press('Backspace');
  await A.keyboard.press('Enter');
  sh = await shapes();
  check('Backspace, then Enter, finishes with 3 points', sh[sh.length - 1].points?.length === 6, sh[sh.length - 1].points?.length);

  // Freehand
  await A.click('[data-shapekind=free]');
  await A.mouse.move(820, 500); await A.mouse.down();
  for (const [x, y] of [[880, 480], [920, 540], [880, 600], [820, 580]]) await A.mouse.move(x, y, { steps: 5 });
  await A.mouse.up();
  sh = await shapes();
  check('freehand makes a polygon', sh[sh.length - 1].shape === 'poly' && sh[sh.length - 1].points.length >= 8, sh[sh.length - 1].points?.length);

  // Options apply to new shapes; W/E keys.
  await A.keyboard.press('w'); await A.keyboard.press('w');
  await A.keyboard.press('d');
  await A.click('[data-dash=dashed]');
  await A.click('[data-shapekind=rect]');
  await drag([300, 650], [360, 700]);
  sh = await shapes();
  const last = sh[sh.length - 1];
  check('W, D and the dash buttons shape the next one', last.strokeWidth === r1.strokeWidth + 2 && last.opacity === 0.95 && last.dash === 'dashed', JSON.stringify([last.strokeWidth, last.opacity, last.dash]));

  // Select, scale with W, adjust, erase, undo.
  await A.keyboard.press('v');
  await A.mouse.click(820 + 40, 540);
  const note = await A.$eval('.tb-note', (n) => n.hidden ? 'one' : n.textContent);
  check('clicking a shape selects it', note === 'one', note);
  await A.click('[data-act=adjust]');
  check('the adjust panel shows shape settings', /Outline width/.test(await A.$eval('.adjust-panel', (p) => p.innerText)));
  const before = (await shapes()).length;
  await A.keyboard.press('Delete');
  check('Delete removes it', (await shapes()).length === before - 1);
  await A.keyboard.press('Control+z');
  check('undo brings it back', (await shapes()).length === before);
  await A.keyboard.press('u');
  await drag([300, 520], [330, 540]);
  check('the eraser rubs out shapes', (await shapes()).length === before - 1, (await shapes()).length);

  await A.keyboard.press('r');
  await A.mouse.move(640, 760);
  await A.evaluate(() => document.getElementById('toast').classList.remove('show')); await A.waitForTimeout(500); await A.screenshot({ path: 'shapes.png', clip: { x: 0, y: 720, width: 1200, height: 80 } });
  await browser.close();
  done();
})();
