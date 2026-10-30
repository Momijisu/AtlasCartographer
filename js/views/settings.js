// Settings: OneDrive, installing, appearance and version.
import * as store from '../store.js';
import * as auth from '../auth.js';
import * as sync from '../sync.js';
import { $, esc, toast, timeAgo, confirmDialog } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';
import { landDetail } from '../render.js';

export function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('ac.theme') || 'dark';
  const light = getComputedStyle(document.documentElement).colorScheme === 'light';
  document.querySelector('meta[name="theme-color"]').content = light ? '#e6dcc8' : '#161411';
}

export function viewSettings(view) {
  setTitle('Settings');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const edge = /Edg/i.test(ua);
  const android = /android/i.test(ua);
  view.innerHTML = `<div class="settings">
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="panel" id="oneDriveCard"></div>
    <div class="panel">
      <h2>Install the app</h2>
      ${standalone ? `<p>${icon('check')} You’re using the installed app.</p>` : `
        <p id="installRow" ${state.installPrompt ? '' : 'hidden'}><button class="btn primary" id="installBtn">${icon('download-simple')} Install AtlasCartographer</button></p>
        <p class="muted">${ios
          ? `Tap <b>Share</b>${edge ? ' (in Edge, menu ⋯ → Share)' : ''} → <b>Add to Home Screen</b>. Before iOS 16.4, use Safari.`
          : android && edge
            ? 'Menu <b>⋯</b> → <b>Add to phone</b> (or <b>Install app</b>). If it’s missing, reload and try again.'
            : android
              ? 'Menu ⋮ → <b>Install app</b>.'
              : 'Use the install icon in the address bar, or menu → <b>Apps</b> → <b>Install AtlasCartographer</b>.'}</p>`}
      <p class="muted small">Works offline. Changes sync to OneDrive when you’re online.</p>
    </div>
    <div class="panel">
      <h2>Appearance</h2>
      <div class="seg" id="themeSeg">
        <button data-t="dark">Nocturne</button>
        <button data-t="light">Vellum</button>
        <button data-t="auto">Match device</button>
      </div>
      <div class="field-label" style="margin-top:1.2rem">Land detail in the editor</div>
      <div class="seg" id="detailSeg">
        <button data-d="auto">Automatic</button>
        <button data-d="standard">Standard</button>
        <button data-d="full">Full</button>
      </div>
      <p class="muted small">Full draws coastlines at the map’s own resolution, sharp at any zoom; Standard uses far less memory. Automatic picks Standard on phones and tablets and Full elsewhere. Exports are always full.</p>
    </div>
    <div class="panel" id="aboutCard">
      <h2>About this app</h2>
      <dl class="about-list">
        <dt>Version</dt><dd><b>${esc(self.AC_VERSION || '?')}</b> <span class="muted">· built ${esc(self.AC_BUILD || '?')}</span></dd>
        <dt>Offline cache</dt><dd id="cacheVer" class="muted">checking…</dd>
        <dt>Latest online</dt><dd id="latestVer" class="muted">—</dd>
      </dl>
      <div class="actions left">
        <button class="btn" id="checkUpd">${icon('arrows-clockwise')} Check for updates</button>
        <button class="btn primary" id="doUpd" hidden>${icon('download-simple')} Update now</button>
        <button class="btn quiet" id="resetCache" title="Clears downloaded app files only. Your maps and art are not affected.">Reset offline cache</button>
      </div>
      <p class="muted small">Resetting the cache re-downloads the app. Your maps, art and settings aren’t touched.</p>
    </div>
  </div>`;
  renderOneDriveCard();
  const seg = $('#themeSeg');
  const mark = () => { for (const b of seg.children) b.classList.toggle('on', b.dataset.t === (localStorage.getItem('ac.theme') || 'dark')); };
  seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    localStorage.setItem('ac.theme', b.dataset.t);
    applyTheme(); mark();
  };
  mark();
  const dseg = $('#detailSeg');
  const markD = () => { for (const b of dseg.children) b.classList.toggle('on', b.dataset.d === landDetail()); };
  dseg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try { localStorage.setItem('ac.landDetail', b.dataset.d); } catch { /* private mode */ }
    markD();
  };
  markD();
  $('#installBtn')?.addEventListener('click', () => state.promptInstall().then(() => state.route()));
  wireAbout();
}

// Version, offline cache and updates (as in WorldAtlas).
function wireAbout() {
  const running = self.AC_VERSION;
  const cacheEl = $('#cacheVer');
  const showCache = async (retry) => {
    try {
      const keys = (await caches.keys()).filter((k) => k.startsWith('cartographer-'));
      const cached = keys.map((k) => k.slice('cartographer-'.length));
      cacheEl.textContent = !keys.length ? 'downloading for offline use…'
        : cached.includes(running) ? `${running} · matches` : `${cached.join(', ')} · updating to ${running}…`;
      // On a first visit the cache is still being filled; look again once it's ready.
      if (retry && (!keys.length || !cached.includes(running))) {
        navigator.serviceWorker?.ready.then(() => setTimeout(() => { if (cacheEl.isConnected) showCache(false); }, 1500));
      }
    } catch { cacheEl.textContent = 'unavailable in this browser'; }
  };
  showCache(true);
  const latestEl = $('#latestVer');
  const check = async () => {
    latestEl.textContent = 'checking…';
    try {
      const text = await (await fetch(`js/version.js?check=${Date.now()}`, { cache: 'no-store' })).text();
      const latest = text.match(/AC_VERSION\s*=\s*'([^']+)'/)?.[1];
      if (!latest) throw new Error('unreadable');
      const behind = latest !== running;
      latestEl.innerHTML = behind ? `<b class="warn">${esc(latest)}</b> · an update is available` : `${esc(latest)} · you’re up to date`;
      $('#doUpd').hidden = !behind;
    } catch {
      latestEl.textContent = navigator.onLine ? 'couldn’t check right now' : 'offline: connect to check';
    }
  };
  $('#checkUpd').onclick = check;
  $('#doUpd').onclick = async () => {
    $('#doUpd').disabled = true;
    $('#doUpd').textContent = 'Updating…';
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update().catch(() => {});
    // The new version takes over and the page reloads itself; reload anyway if that takes too long.
    setTimeout(() => location.reload(), 6000);
  };
  $('#resetCache').onclick = async () => {
    if (!(await confirmDialog('Clear the app’s downloaded files and reload? Your maps, art and settings stay.', 'Reset and reload', { title: 'Reset offline cache', danger: false }))) return;
    try {
      for (const k of await caches.keys()) if (k.startsWith('cartographer-')) await caches.delete(k);
      for (const r of (await navigator.serviceWorker?.getRegistrations()) || []) if (r.scope === new URL('./', location.href).href) await r.unregister();
    } catch { /* ignore */ }
    location.reload();
  };
  if (navigator.onLine) check();
}

export function renderOneDriveCard() {
  const el = $('#oneDriveCard');
  if (!el) return;
  const st = sync.getStatus();
  const acct = auth.account();
  const cid = auth.clientId();
  const folder = 'a private folder in your OneDrive, under <b>Apps</b>';
  let main;
  if (!cid) {
    main = `<p>Syncing uses ${folder}. It needs a Microsoft app registration (see the README). Paste its Application (client) ID below.</p>`;
  } else if (st.state === 'off') {
    main = `<p>Sign in with Microsoft to sync your maps through ${folder}.</p>
      <p><button class="btn primary" id="connectBtn">${icon('cloud-check')} Connect OneDrive</button></p>`;
  } else if (st.state === 'reauth') {
    main = `<p class="warn">${esc(st.message || 'Your OneDrive session expired.')}</p>
      <p><button class="btn primary" id="connectBtn">Reconnect OneDrive</button> <button class="btn quiet" id="disconnectBtn">Disconnect</button></p>`;
  } else {
    main = `<p>Connected as <b>${esc(acct?.name || '')}</b> <span class="muted">${esc(acct?.username || '')}</span></p>
      <p>Status: <b class="status-${st.state}">${esc({ synced: 'Up to date', syncing: 'Syncing…', pending: 'Changes waiting to upload', offline: 'Offline', error: 'Error', busy: 'OneDrive busy, trying again shortly' }[st.state] || st.state)}</b>
      <span class="muted">· last synced ${timeAgo(store.meta.lastSync)}</span></p>
      ${st.state === 'error' || st.state === 'busy' ? `<p class="${st.state === 'error' ? 'warn' : 'muted'}">${esc(st.message)}</p>` : ''}
      <p><button class="btn primary" id="syncNowBtn">${icon('arrows-clockwise')} Sync now</button> <button class="btn quiet" id="disconnectBtn">Disconnect</button></p>`;
  }
  el.innerHTML = `<h2>OneDrive sync</h2>${main}
    <details ${cid ? '' : 'open'}><summary>Microsoft app registration</summary>
      ${auth.builtInClientId ? '' : `<label>Application (client) ID<input id="cidInput" value="${esc(cid)}" placeholder="00000000-0000-0000-0000-000000000000"></label>
      <button class="btn small" id="saveCid">Save client ID</button>`}
      <p class="small">The registration needs this address as a redirect URI (platform: <b>Single-page application</b>):<br><code class="copy">${esc(auth.redirectUri())}</code> <button class="btn small quiet" id="copyRuri">Copy</button></p>
    </details>`;
  $('#connectBtn')?.addEventListener('click', () => auth.signIn().catch((e) => toast(e.message)));
  $('#syncNowBtn')?.addEventListener('click', () => sync.sync({ force: true }));
  $('#disconnectBtn')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Disconnect OneDrive on this device? Your maps stay here and in OneDrive. If you connect a different Microsoft account later, everything on this device (maps and art) is uploaded to it afresh.', 'Disconnect'))) return;
    const last = auth.account()?.username?.toLowerCase() || null;
    auth.signOut();
    // Next time, merge with whatever OneDrive holds from scratch. Remember who
    // this was: another account has none of it, and gets all of it.
    await store.saveMeta({ eTags: {}, lastAccount: last });
    sync.refreshStatus();
  });
  $('#saveCid')?.addEventListener('click', () => {
    auth.setClientId($('#cidInput').value);
    toast('Saved');
    sync.refreshStatus();
    renderOneDriveCard();
  });
  $('#copyRuri')?.addEventListener('click', () => navigator.clipboard?.writeText(auth.redirectUri()).then(() => toast('Copied')));
}
