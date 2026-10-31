const { chromium } = require('playwright');
const { device, waitSynced, stroke } = require('./mock.js');
const newMap = async (A, name, type, extra) => {
  await A.goto('http://localhost:8765/#/'); await A.click('#newProject'); await A.fill('input[name=name]', name);
  await A.click(`#typeSeg [data-t=${type}]`);
  if (extra) await extra();
  await A.click('.modal button.primary'); await A.waitForSelector('.editor-canvas'); await A.waitForTimeout(400);
};
let CAT = null;
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  for (const dir of ['pack/Fantasy Stamps', 'pack2/City Bits']) {
    await A.goto('http://localhost:8765/#/library'); await A.setInputFiles('#pickFolder', dir);
    await A.waitForSelector('.modal input[name=pack]'); await A.click('.modal button.primary'); await A.waitForTimeout(2500);
  }
  await A.goto('http://localhost:8765/#/library/' + encodeURIComponent('City Bits'));
  await A.selectOption('#packType', 'city'); await A.waitForTimeout(300);
  await newMap(A, 'A world', 'world');
  await A.screenshot({ path: 'type-world.png' });
  await newMap(A, 'A city', 'city');
  await A.click('[data-tool=land]'); await A.click('[data-landmode=erase]');
  await A.$eval('.land-size', (r) => { r.value = 70; r.dispatchEvent(new Event('input')); });
  await stroke(A, [[200, 150], [400, 350], [500, 600], [650, 780]]);
  CAT = null; await A.click('[data-tool=stamp]'); await A.waitForSelector('.pk-browse .tile');
  console.log('city picker packs:', await A.$$eval('.pk-pack option', (o) => o.map((x) => x.textContent)));
  await A.click(`${CAT ? `.pk-section:has(.pk-cat-name:text-is("${CAT}")) ` : '.pk-browse '}.tile >> nth=0`); await A.click('[data-act=picker]');
  await A.mouse.click(700, 300); await A.mouse.click(820, 360);
  await A.waitForTimeout(300);
  await A.screenshot({ path: 'type-city.png' });
  await newMap(A, 'A battle', 'battlemap', async () => { await A.fill('#sizeBox input[name=across]', '24'); await A.fill('#sizeBox input[name=down]', '16'); await A.selectOption('#sizeBox select[name=px]', '100'); });
  const p = await A.evaluate(async () => { const s = await import('./js/store.js'); const id = location.hash.split('/p/')[1]; const pr = s.project(id); const st = (await s.getDoc(id)).objects.style; return [pr.type, pr.width, pr.height, st.surface, st.grid, st.gridSize]; });
  console.log('battlemap:', JSON.stringify(p));
  CAT = null; await A.click('[data-tool=stamp]'); if (await A.$('.picker[hidden]')) await A.click('[data-act=picker]'); await A.waitForSelector('.pk-browse .tile');
  console.log('battlemap picker packs:', await A.$$eval('.pk-pack option', (o) => o.map((x) => x.textContent)));
  await A.screenshot({ path: 'type-battle.png' });
  await A.goto('http://localhost:8765/#/'); await A.waitForTimeout(1200);
  console.log('cards:', await A.$$eval('.project-card .sub', (s) => s.map((x) => x.textContent)));
  await A.screenshot({ path: 'type-home.png' });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
