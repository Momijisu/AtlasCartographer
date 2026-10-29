// Boot, routing and the top bar.
//   #/            projects
//   #/p/<id>      the editor
//   #/library     art library; #/library/<pack> one pack
//   #/settings    settings
import * as store from './store.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import { $, toast, timeAgo } from './util.js';
import { icon } from './icons.js';
import { viewHome } from './views/home.js';
import { viewEditor } from './views/editor.js';
import { viewLibrary, viewPack } from './views/library.js';
import { loadAssets } from './assets.js';
import * as assetsync from './assetsync.js';
import * as images from './images.js';
import { viewSettings, renderOneDriveCard, applyTheme } from './views/settings.js';
import { state } from './ui.js';

async function boot() {
  applyTheme();
  let authError = null, returned = null;
  try { returned = await auth.handleRedirect(); } catch (e) { authError = e; }
  await store.load();
  await loadAssets();
  wireChrome();
  store.onChange((e) => {
    if (e.local) return;
    if (state.onRemote) state.onRemote(e);
    else route();
  });
  sync.onStatus(renderSyncBadge);
  // Art that just arrived may be what a stamp was waiting for.
  assetsync.onProgress((p, fresh) => { if (fresh) images.retryMissing(); });
  sync.start();
  // Keep the OneDrive sign-in alive in the background (see auth.renewSilently).
  const renew = async () => { if (auth.needsRenewal() && await auth.renewSilently()) sync.sync(); };
  renew();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renew(); });
  setInterval(renew, 60 * 60e3);
  addEventListener('hashchange', route);
  route();
  if (authError) toast('Sign-in failed: ' + authError.message, 7000);
  else if (returned && !returned.silent) toast('Connected to OneDrive');
  if ('serviceWorker' in navigator) {
    // When an updated version takes over, reload once so old and new files never mix.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    // updateViaCache 'none': always fetch sw.js and js/version.js fresh when checking for updates.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      const check = () => { if (navigator.onLine) reg.update().catch(() => {}); };
      setInterval(check, 30 * 60e3);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    }).catch((e) => console.warn('SW registration failed', e));
  }
  navigator.storage?.persist?.();
}

// Keep the install event so we can offer our own Install button, but don't
// preventDefault(): that would hide the browser's own install prompt/menu entry.
addEventListener('beforeinstallprompt', (e) => { state.installPrompt = e; showInstallButton(); });
// An offer made before this module ran was kept by the first script in index.html.
if (window.acInstallPrompt) state.installPrompt = window.acInstallPrompt;
addEventListener('appinstalled', () => { state.installPrompt = null; window.acInstallPrompt = null; showInstallButton(); });

// The browser's install offer can arrive after a page is drawn: show or hide
// both Install buttons (top bar, and Settings if it's open) whenever it changes.
function showInstallButton() {
  for (const id of ['installTop', 'installRow']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !state.installPrompt;
  }
}

async function promptInstall() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  window.acInstallPrompt = null;
  showInstallButton();
}

function wireChrome() {
  $('#settingsBtn').innerHTML = icon('gear-six');
  $('#libraryBtn').innerHTML = icon('squares-four');
  $('#mapsBtn').innerHTML = icon('folder');
  $('#installTop').onclick = promptInstall;
  showInstallButton();
  $('#syncBtn').onclick = () => {
    const st = sync.getStatus().state;
    if (st === 'reauth') auth.signIn().catch((e) => toast(e.message)); // straight back in, no picker
    else if (st === 'off' || st === 'error') location.hash = '#/settings';
    else sync.sync();
  };
}

function renderSyncBadge({ state: st, message }) {
  const btn = $('#syncBtn');
  const labels = {
    off: ['cloud-slash', 'Local only'], syncing: ['arrows-clockwise', 'Syncing'], synced: ['cloud-check', 'Synced'],
    pending: ['cloud-arrow-up', 'Unsynced'], offline: ['cloud-slash', 'Offline'], error: ['warning', 'Sync error'], reauth: ['warning', 'Reconnect'], busy: ['arrows-clockwise', 'Busy'],
  };
  const [ic, text] = labels[st];
  btn.className = 'sync-badge ' + st;
  btn.innerHTML = `${icon(ic)}<span class="sync-text">${text}</span>`;
  btn.title = message || (st === 'synced' ? 'Synced with OneDrive ' + timeAgo(store.meta.lastSync) : text);
  if ($('#oneDriveCard')) renderOneDriveCard();
}

async function route() {
  state.cleanup?.();
  state.cleanup = null;
  state.onRemote = null;
  document.body.classList.remove('editing');
  $('#topSlot').innerHTML = '';
  const view = $('#view');
  const h = location.hash.replace(/^#\/?/, '');
  const [page, id] = h.split('/');
  try {
    if (page === 'p' && id) await viewEditor(view, id);
    else if (page === 'settings') viewSettings(view);
    else if (page === 'library' && id) await viewPack(view, decodeURIComponent(h.slice('library/'.length)));
    else if (page === 'library') await viewLibrary(view);
    else viewHome(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty-state"><h2>Something went wrong</h2><p>${e.message}</p><p><a href="#/">Back to your maps</a></p></div>`;
  }
}
state.route = route;
state.promptInstall = promptInstall;

boot();
