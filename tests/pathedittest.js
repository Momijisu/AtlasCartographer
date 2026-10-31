const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
const get = (p, kind) => p.evaluate(async (kind) => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; return s.liveObjects(await s.getDoc(id)).filter((o) => o.kind === kind); }, kind);
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  await A.click('#mapsBtn'); // the new folder button goes home
  console.log('maps button url:', A.url());
  await A.click('#newProject'); await A.fill('input[name=name]', 'Paths edit'); await A.click('.modal button.primary');
  await A.waitForSelector('.editor-canvas');
  await A.click('[data-tool=path]'); await A.click('[data-pathstyle=road]');
  await stroke(A, [[300, 400], [450, 300], [600, 420], [750, 330], [900, 420]]);
  let [path] = await get(A, 'path');
  console.log('points after simplify:', path.points.length / 2);
  await A.click('[data-tool=select]');
  await A.mouse.click(450, 302); // on the line
  console.log('path selected:', await A.$eval('[data-act=delete]', (b) => !b.hidden && !b.disabled));
  // drag a node: find its screen position
  const nodes = await A.evaluate(() => null);
  const scr = await A.evaluate(async () => { const c = document.querySelector('.editor-canvas').getBoundingClientRect(); return [c.left, c.top]; });
  // Node 1 sits near (450,300) on screen: drag it up
  path = (await get(A, 'path'))[0];
  const toScreen = await A.evaluate(() => 0);
  await A.mouse.move(450, 300); await A.mouse.down(); await A.mouse.move(450, 220, { steps: 5 }); await A.mouse.up();
  let p2 = (await get(A, 'path'))[0];
  console.log('node moved:', JSON.stringify(path.points.slice(0, 4)), '->', JSON.stringify(p2.points.slice(0, 4)));
  await A.screenshot({ path: 'pathedit.png' });
  // alt-click to remove the node we just moved
  await A.keyboard.down('Alt'); await A.mouse.click(450, 220); await A.keyboard.up('Alt');
  console.log('after remove:', (await get(A, 'path'))[0].points.length / 2, 'points');
  // adjust: switch to river, wider
  await A.click('[data-act=adjust]');
  await A.selectOption('.adjust-panel select[name=pathStyle]', 'river');
  console.log('style now:', (await get(A, 'path'))[0].style);
  // text along a curve
  await A.click('[data-tool=text]');
  await stroke(A, [[300, 600], [500, 520], [700, 560], [900, 640]]);
  await A.waitForSelector('.label-form');
  await A.fill('.label-form input[name=text]', 'The Winding Road of Kings');
  await A.click('.label-form button.primary');
  await A.waitForTimeout(400);
  const [lab] = await get(A, 'label');
  console.log('label along points:', lab.along && lab.along.length / 2);
  await A.screenshot({ path: 'textpath.png' });
  await A.keyboard.press('Control+z'); await A.keyboard.press('Control+z'); await A.keyboard.press('Control+z');
  console.log('after 3 undos:', (await get(A, 'path'))[0].points.length / 2, 'path points,', (await get(A, 'label')).length, 'labels');
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
