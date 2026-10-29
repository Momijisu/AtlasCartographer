// Settings: OneDrive, installing, appearance and version.
import * as store from '../store.js';
import * as auth from '../auth.js';
import * as sync from '../sync.js';
import { $, esc, toast, timeAgo, confirmDialog } from '../util.js';
import { icon } from '../icons.js';
import { setTitle, state } from '../ui.js';

export function applyTheme() {
  document.documentElement.dataset.theme = localStorage.getItem('ac.theme') || 'dark';
  const light = getComputedStyle(document.documentElement).colorScheme === 'light';
  document.querySelector('meta[name="theme-color"]').content = light ? '#e6dcc8' : '#161411';
}

export function viewSettings(view) {
  setTitle('Settings');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  view.innerHTML = `<div class="settings">
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="panel" id="oneDriveCard"></div>
    <div class="panel">
      <h2>Install the app</h2>
      ${standalone ? `<p>${icon('check')} You’re using the installed app.</p>` : `
        ${state.installPrompt ? `<p><button class="btn primary" id="installBtn">${icon('download-simple')} Install AtlasCartographer</button></p>` : ''}
        <p class="muted">${ios ? 'Tap <b>Share</b> → <b>Add to Home Screen</b>.' : 'Use the install icon in the address bar, or the browser menu → <b>Install app</b>.'}</p>`}
      <p class="muted small">Works offline. Changes sync to OneDrive when you’re online.</p>
    </div>
    <div class="panel">
      <h2>Appearance</h2>
      <div class="seg" id="themeSeg">
        <button data-t="dark">Nocturne</button>
        <button data-t="light">Vellum</button>
        <button data-t="auto">Match device</button>
      </div>
    </div>
    <p class="muted small center">AtlasCartographer ${esc(self.AC_VERSION)} · ${esc(self.AC_BUILD)}</p>
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
  $('#installBtn')?.addEventListener('click', () => state.promptInstall().then(() => state.route()));
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
      <p>Status: <b class="status-${st.state}">${esc({ synced: 'Up to date', syncing: 'Syncing…', pending: 'Changes waiting to upload', offline: 'Offline', error: 'Error' }[st.state] || st.state)}</b>
      <span class="muted">· last synced ${timeAgo(store.meta.lastSync)}</span></p>
      ${st.state === 'error' ? `<p class="warn">${esc(st.message)}</p>` : ''}
      <p><button class="btn primary" id="syncNowBtn">${icon('arrows-clockwise')} Sync now</button> <button class="btn quiet" id="disconnectBtn">Disconnect</button></p>`;
  }
  el.innerHTML = `<h2>OneDrive sync</h2>${main}
    <details ${cid ? '' : 'open'}><summary>Microsoft app registration</summary>
      ${auth.builtInClientId ? '' : `<label>Application (client) ID<input id="cidInput" value="${esc(cid)}" placeholder="00000000-0000-0000-0000-000000000000"></label>
      <button class="btn small" id="saveCid">Save client ID</button>`}
      <p class="small">The registration needs this address as a redirect URI (platform: <b>Single-page application</b>):<br><code class="copy">${esc(auth.redirectUri())}</code> <button class="btn small quiet" id="copyRuri">Copy</button></p>
    </details>`;
  $('#connectBtn')?.addEventListener('click', () => auth.signIn().catch((e) => toast(e.message)));
  $('#syncNowBtn')?.addEventListener('click', () => sync.sync());
  $('#disconnectBtn')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Disconnect OneDrive on this device? Your maps stay here and in OneDrive.', 'Disconnect'))) return;
    auth.signOut();
    // Next time, merge with whatever OneDrive holds from scratch.
    await store.saveMeta({ eTags: {}, folders: 0 });
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
