// The same pictures in two packs (audit fix 3): importing a pack whose files
// are already in the library adds them to it too, and deleting one pack keeps
// the pictures the other still includes. They go for good only when no pack has them.
const { chromium } = require('playwright');
const { device, waitSynced, BASE } = require('./mock.js');
const { check, done } = require('./tlib.js');
(async () => {
  const browser = await chromium.launch();
  const A = await device(browser, 'A');
  await waitSynced(A);
  const importAs = async (dir, name) => {
    await A.goto(BASE + '#/library'); await A.waitForSelector('#pickFolder', { state: 'attached' });
    await A.evaluate(() => { document.querySelector('#toast').textContent = ''; }); // so the wait below sees this import's message
    await A.setInputFiles('#pickFolder', dir);
    await A.waitForSelector('.modal input[name=pack]');
    await A.fill('.modal input[name=pack]', name);
    await A.click('.modal button.primary');
    await A.waitForFunction(() => /^Imported/.test(document.querySelector('#toast').textContent), null, { timeout: 20000 });
    return A.$eval('#toast', (t) => t.textContent);
  };
  const packs = () => A.evaluate(async () => (await import('./js/assets.js')).packs().map((p) => `${p.name}:${p.count}`).sort());
  const live = () => A.evaluate(async () => (await import('./js/assets.js')).liveAssets().length);
  await importAs('pack3/Cities', 'Cities');
  const t2 = await importAs('pack3/Cities', 'Second copy');
  check('importing the same files as another pack adds them to it', JSON.stringify(await packs()) === '["Cities:16","Second copy:16"]', `${await packs()} (${t2})`);
  check('…stored once', await live() === 16, await live());
  // The second pack's page and picker show them.
  await A.goto(BASE + '#/library/' + encodeURIComponent('Second copy')); await A.waitForSelector('details.cat');
  check('the second pack\'s page lists its categories', (await A.$$eval('details.cat', (d) => d.map((x) => x.dataset.cat))).join() === 'babylonian,egyptian');
  // Delete the first pack: the second keeps everything.
  await A.evaluate(async () => (await import('./js/assets.js')).deletePack('Cities'));
  check('deleting one pack keeps the pictures the other includes', JSON.stringify(await packs()) === '["Second copy:16"]' && await live() === 16, `${await packs()} / ${await live()} live`);
  const purge = await A.evaluate(async () => [...(await (await import('./js/assets.js')).allStates()).values()].filter((s) => s.purgePending).length);
  check('…and nothing is queued for deletion from OneDrive', purge === 0, purge);
  // Delete one stamp from the remaining pack, then the pack.
  await A.evaluate(async () => { const A = await import('./js/assets.js'); await A.deleteAssets(A.liveAssets().filter((a) => /obelisk/.test(a.name)).map((a) => a.id), 'Second copy'); });
  check('deleting a stamp from the last pack that has it removes it', await live() === 14, await live());
  await A.evaluate(async () => (await import('./js/assets.js')).deletePack('Second copy'));
  check('deleting the last pack removes the rest', await live() === 0 && (await packs()).length === 0, `${await live()} live`);
  // A pack whose files are partly shared: moving within one pack leaves the other alone.
  await importAs('pack3/Cities', 'Cities');
  await importAs('pack3/Cities', 'Second copy');
  await A.evaluate(async () => { const A = await import('./js/assets.js'); await A.moveAssets(A.liveAssets().filter((a) => /well/.test(a.name)).map((a) => a.id), { pack: 'Second copy', category: 'water', stamp: '' }, 'Second copy'); });
  const where = await A.evaluate(async () => { const A = await import('./js/assets.js'); return A.livePlaced().filter((p) => /well/.test(p.name)).map((p) => `${p.pack}/${p.category}`).sort(); });
  check('moving a picture in one pack leaves it where it is in the other', JSON.stringify(where) === '["Cities/babylonian","Second copy/water"]', where.join());
  await browser.close();
  done();
})();
