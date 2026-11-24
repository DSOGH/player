// Reusable UI pieces: artwork, rows, cards, sheets, toasts, dialogs.
import { html, raw, esc, icon, fmtTime, $ } from '../util.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { engine } from '../engine.js';
import { artUrl } from '../art.js';

// ---------- lists registry (so a tapped row knows what to queue) ----------
const lists = new Map();
let listSeq = 0;
export function regList(tracks, context) {
  const key = 'L' + ++listSeq;
  lists.set(key, { ids: tracks.map((t) => t.id), context });
  if (lists.size > 60) lists.delete(lists.keys().next().value);
  return key;
}
export function getList(key) { return lists.get(key); }

export function haptic(ms = 8) {
  if (settings.get('haptics') && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* */ } }
}

// ---------- art ----------
const seenArt = new Set();
window.__seenArt = seenArt;
export function preloadArt(id, sizes = [200, 640]) {
  if (!id) return;
  for (const sz of sizes) {
    const src = artUrl(id, sz);
    if (seenArt.has(src)) continue;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => seenArt.add(src);
    img.src = src;
  }
}
export function art(id, cls = '', alt = '') {
  if (!id) return html`<div class="art ${cls} art-empty">${icon('note')}</div>`;
  const big = /hero|np-art|card|top-art|avatar/.test(cls);
  const src = artUrl(id, big ? 640 : 200);
  // covers already shown this session appear immediately; new ones fade in once decoded (no pop-in)
  const seen = seenArt.has(src);
  return html`<div class="art ${cls}"><img src="${src}" alt="${alt}" ${seen ? '' : 'loading="lazy"'} decoding="${seen ? 'sync' : 'async'}" class="${seen ? 'in' : ''}" referrerpolicy="no-referrer" onload="this.classList.add('in');window.__seenArt?.add(this.getAttribute('src'))" onerror="this.parentNode.classList.add('art-empty');this.remove()"></div>`;
}

export function badges(t, { compact = false } = {}) {
  if (!settings.get('showBadges') || !t) return '';
  const out = [];
  const lossless = ['FLAC', 'ALAC', 'WAV'].includes(t.codec);
  if (lossless && (t.bitDepth >= 24 || t.sampleRate > 48000)) out.push(html`<span class="badge hires">${icon('lossless')}Hi-Res Lossless</span>`);
  else if (lossless) out.push(html`<span class="badge">${icon('lossless')}Lossless</span>`);
  else if (!compact && t.codec) out.push(html`<span class="badge dim">${t.codec}${t.bitrate ? ' ' + t.bitrate + ' kbps' : ''}</span>`);
  return out;
}

export function formatLine(t) {
  if (!t) return '';
  const parts = [t.codec];
  if (t.bitDepth && ['FLAC', 'ALAC', 'WAV'].includes(t.codec)) parts.push(`${t.bitDepth}-bit`);
  if (t.sampleRate) parts.push(`${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz`);
  if (t.bitrate && !['FLAC', 'ALAC', 'WAV'].includes(t.codec)) parts.push(`${t.bitrate} kbps`);
  return parts.filter(Boolean).join(' · ');
}

// ---------- rows & cards ----------
export function bpmChip(t) {
  if (!settings.get('showBpm')) return '';
  const bpm = library.bpmOf(t);
  if (!bpm) return '';
  const k = library.analysis.get(t.id)?.camelot;
  return html`<span class="bpmchip">${Math.round(bpm)}${k ? html`<i>${k}</i>` : ''}</span>`;
}
export function trackRow(t, i, listKey, { num = false, showArt = true, showAlbum = false, extra = '' } = {}) {
  const playing = engine.track?.id === t.id;
  const liked = library.likes.has(t.id);
  const off = library.isOffline(t);
  return html`<div class="row track${playing ? ' playing' : ''}" data-a="play-list" data-list="${listKey}" data-i="${i}" data-tid="${t.id}">
    ${num ? html`<div class="num">${playing ? html`<span class="eqbars"><i></i><i></i><i></i></span>` : t.track || ''}</div>` : ''}
    ${showArt && !num ? art(t.artId, 'sm') : ''}
    <div class="meta">
      <div class="t1">${t.title}${t.edition === 'explicit' ? html`<span class="ebadge" title="Explicit">E</span>` : ''}</div>
      <div class="t2">${liked ? html`<span class="mini-heart">${icon('heart-fill')}</span>` : ''}${off ? html`<span class="mini-dl">${icon('downloaded')}</span>` : ''}${showAlbum ? `${t.artist} · ${t.album}` : t.artist}</div>
    </div>
    ${bpmChip(t)}
    ${raw(extra)}
    <button class="icon-btn more" data-a="track-menu" data-tid="${t.id}" aria-label="More">${icon('more')}</button>
  </div>`;
}

export function albumCard(a, { sub = 'artist' } = {}) {
  const s = sub === 'year' ? (a.year || '') : sub === 'none' ? '' : a.artist;
  return html`<a class="card" href="#/album/${a.id}">
    ${art(a.artId, 'card-art', a.title)}
    <div class="c1">${a.title}${a.edition === 'explicit' ? html`<span class="ebadge">E</span>` : a.edition === 'clean' && a.editions ? html`<span class="ebadge clean">C</span>` : ''}</div>
    ${s ? html`<div class="c2">${s}</div>` : ''}
  </a>`;
}
export function artistCard(ar) {
  return html`<a class="card artist-card" href="#/artist/${ar.id}">
    ${art(ar.artId, 'card-art round', ar.name)}
    <div class="c1">${ar.name}</div>
  </a>`;
}
export function mixCard(m) {
  return html`<a class="card mix-card" href="#/mix/${m.id}">
    <div class="art card-art mix-art" style="background:linear-gradient(135deg,${m.colors[0]},${m.colors[1]})">
      <div class="mix-label">${m.name}</div>
      <div class="mix-icon">${icon(m.kind === 'bpm' ? 'bpm' : m.kind === 'genre' ? 'genre' : 'mix')}</div>
    </div>
    <div class="c1">${m.name}</div><div class="c2">${m.sub}</div>
  </a>`;
}
export function shelf(title, items, { href = '', cls = '' } = {}) {
  if (!items.length) return '';
  return html`<section class="shelf ${cls}">
    <div class="shelf-head"><h2>${title}</h2>${href ? html`<a class="see-all" href="${href}">See All</a>` : ''}</div>
    <div class="scroller">${items}</div>
  </section>`;
}

// ---------- sheets ----------
let sheetResolve = null;
export function closeSheet(v) {
  const root = $('#sheet');
  root.classList.remove('open');
  setTimeout(() => { if (!root.classList.contains('open')) root.innerHTML = ''; }, 260);
  const r = sheetResolve; sheetResolve = null;
  r?.(v);
}
// items: [{icon, label, value, danger, sub}], header: html
export function actionSheet({ header = '', items = [], title = '' }) {
  return new Promise((resolve) => {
    if (sheetResolve) closeSheet();
    sheetResolve = resolve;
    const root = $('#sheet');
    root.innerHTML = html`<div class="sheet-backdrop" data-sheet-close></div>
      <div class="sheet-panel" role="dialog">
        <div class="grabber"></div>
        ${header}
        ${title ? html`<div class="sheet-title">${title}</div>` : ''}
        <div class="sheet-items">
        ${items.map((it, i) => it.sep ? html`<div class="sheet-sep"></div>` : html`<button class="sheet-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}" data-sheet-i="${i}">
          ${it.icon ? icon(it.icon) : ''}<span class="si-label">${it.label}${it.sub ? html`<small>${it.sub}</small>` : ''}</span>${it.active ? icon('check', 'si-check') : ''}
        </button>`)}
        </div>
        <button class="sheet-cancel" data-sheet-close>Cancel</button>
      </div>`;
    requestAnimationFrame(() => root.classList.add('open'));
    root.onclick = (e) => {
      const it = e.target.closest('[data-sheet-i]');
      if (it) { haptic(); const item = items[+it.dataset.sheetI]; closeSheet(item.value ?? item.label); return; }
      if (e.target.closest('[data-sheet-close]')) closeSheet(null);
    };
  });
}

export function prompt({ title, value = '', placeholder = '', ok = 'Save' }) {
  return new Promise((resolve) => {
    if (sheetResolve) closeSheet();
    sheetResolve = resolve;
    const root = $('#sheet');
    root.innerHTML = html`<div class="sheet-backdrop" data-sheet-close></div>
      <form class="sheet-panel dialog" role="dialog">
        <div class="sheet-title big">${title}</div>
        <input class="text-input" name="v" value="${value}" placeholder="${placeholder}" autocomplete="off">
        <div class="dialog-btns"><button type="button" class="btn ghost" data-sheet-close>Cancel</button><button class="btn primary" type="submit">${ok}</button></div>
      </form>`;
    requestAnimationFrame(() => { root.classList.add('open'); setTimeout(() => root.querySelector('input').focus(), 200); });
    root.onclick = (e) => { if (e.target.closest('[data-sheet-close]')) closeSheet(null); };
    root.querySelector('form').onsubmit = (e) => { e.preventDefault(); closeSheet(root.querySelector('input').value.trim() || null); };
  });
}

export async function confirmSheet(title, okLabel = 'OK', danger = false) {
  const v = await actionSheet({ title, items: [{ label: okLabel, value: 'ok', danger }] });
  return v === 'ok';
}

// ---------- toast ----------
let toastTimer;
export function toast(msg, { action = null, ms = 2600 } = {}) {
  const el = $('#toast');
  el.innerHTML = html`<span>${msg}</span>${action ? html`<button class="toast-btn">${action.label}</button>` : ''}`;
  el.classList.add('show');
  if (action) el.querySelector('.toast-btn').onclick = () => { action.run(); el.classList.remove('show'); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function empty(iconName, title, text, btn = '') {
  return html`<div class="empty">${icon(iconName, 'empty-ic')}<h3>${title}</h3><p>${text}</p>${raw(btn)}</div>`;
}

export function pageHeader(title, { back = false, actions = '' } = {}) {
  return html`<header class="page-head${back ? ' with-back' : ''}">
    ${back ? html`<button class="icon-btn back" data-a="back" aria-label="Back">${icon('back')}</button>` : ''}
    <h1 class="large-title">${title}</h1>
    <div class="head-actions">${raw(actions)}</div>
  </header>`;
}

export { fmtTime, esc };
