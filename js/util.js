import { icon } from './icons.js';

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ts).toLocaleDateString();
}

export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

// Simple promise-based modal. `body` is an HTML string; `onMount(el, close)`
// lets the caller wire up inputs. Resolves with whatever close() is given.
export function modal(title, body, { onMount, wide } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
      <div class="modal-body">${body}</div></div>`;
    const opener = document.activeElement;
    const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); opener?.focus?.(); resolve(v); };
    // Only the topmost dialog answers Escape.
    const onKey = (e) => { if (e.key === 'Escape' && root.lastElementChild === wrap) { e.stopImmediatePropagation(); close(null); } };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(null); });
    wrap.querySelector('[data-close]').onclick = () => close(null);
    document.addEventListener('keydown', onKey);
    root.appendChild(wrap);
    onMount?.(wrap.querySelector('.modal'), close);
    wrap.querySelector('input:not([type=hidden]),textarea,select')?.focus();
  });
}

export async function confirmDialog(message, okLabel = 'Delete', { title = 'Are you sure?', cancelLabel = 'Cancel', danger = true } = {}) {
  return modal(title, `<p>${esc(message)}</p>
    <div class="actions"><button class="btn quiet" data-no>${esc(cancelLabel)}</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`,
  { onMount: (m, close) => { m.querySelector('[data-no]').onclick = () => close(false); m.querySelector('[data-yes]').onclick = () => close(true); m.querySelector('[data-no]').focus(); } });
}

export function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
