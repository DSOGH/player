// "Who's listening?" — the account picker / login screen (launch, Settings, sidebar), PIN pad,
// add / edit accounts, and the first-run "connect your music" step for a brand-new account.
import { html, icon, $, $$ } from '../util.js';
import { accounts, COLORS } from '../accounts.js';
import { openedName } from '../db.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
let root = null, resolveBoot = null, mode = 'boot', manage = false, keyHandler = null;

function avatar(a, size = '') {
  const [c1, c2] = accounts.colors(a);
  const name = accounts.label(a);
  return html`<span class="acct-av ${size}" style="--c1:${c1};--c2:${c2}">
    ${a.thumb ? html`<img src="${a.thumb}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <em>${(name.trim()[0] || '♪').toUpperCase()}</em>
    ${a.pin ? html`<i class="acct-lock">${icon('lock')}</i>` : ''}</span>`;
}
function sub(a) {
  if (a.server) return `Plex · ${a.server}`;
  if (a.plexName) return `Plex · ${a.plexName}`;
  if (a.nas) return 'NAS library';
  return a.songs ? `${a.songs.toLocaleString()} songs` : 'New account';
}

function pickerHTML() {
  const list = accounts.all, cur = accounts.activeId;
  return html`<div class="login-stage" data-stage="pick">
    <img class="login-logo" src="icons/icon-192.png" alt="">
    <h1 class="login-title">${manage ? 'Manage accounts' : 'Who’s listening?'}</h1>
    <p class="login-sub">${manage ? 'Tap an account to rename it, change its colour, lock it or remove it.' : list.length > 1 ? 'Every account has its own music, likes, stats and friends.' : 'Add an account for someone else — or a second Plex.'}</p>
    <div class="login-grid${manage ? ' managing' : ''}">
      ${list.map((a, i) => html`<button class="acct${a.id === cur && mode !== 'boot' ? ' current' : ''}" data-l="${manage ? 'edit' : 'pick'}" data-id="${a.id}" style="--i:${i}">
        ${avatar(a)}${manage ? html`<span class="acct-badge">${icon('edit')}</span>` : ''}
        <b>${accounts.label(a)}</b><small>${a.id === cur && mode !== 'boot' ? 'Using now' : sub(a)}</small></button>`)}
      ${manage ? '' : html`<button class="acct add" data-l="add" style="--i:${list.length}"><span class="acct-av plus">${icon('plus')}</span><b>Add account</b><small>Plex or NAS</small></button>`}
    </div>
    <div class="login-foot">
      <button class="login-link" data-l="manage">${manage ? 'Done' : 'Manage accounts'}</button>
      ${mode !== 'boot' ? html`<button class="login-link" data-l="close">Cancel</button>` : ''}
    </div>
    ${mode === 'boot' && list.length > 1 ? html`<label class="login-ask"><input type="checkbox" data-l="ask" ${accounts.ask ? 'checked' : ''}> Ask every time the app opens</label>` : ''}
  </div>`;
}

function pinHTML(a, title = '') {
  return html`<div class="login-stage" data-stage="pin" data-id="${a.id}">
    ${avatar(a, 'big')}
    <h1 class="login-title sm">${title || `Hi, ${accounts.label(a)}`}</h1>
    <p class="login-sub" data-msg>Enter your PIN</p>
    <div class="pin-dots">${[0, 1, 2, 3].map(() => html`<i></i>`)}</div>
    <div class="pin-pad">${KEYS.map((k) => k === '' ? html`<span></span>` : html`<button class="pin-key${k === 'del' ? ' del' : ''}" data-k="${k}" aria-label="${k === 'del' ? 'Delete' : k}">${k === 'del' ? icon('back') : k}</button>`)}</div>
    <div class="login-foot"><button class="login-link" data-l="back">Back</button></div>
  </div>`;
}

function formHTML(a) {
  const isNew = !a, cur = accounts.activeId;
  const color = a?.color ?? (accounts.all.length % COLORS.length);
  return html`<form class="login-stage login-form" data-stage="form" data-id="${a?.id || ''}" autocomplete="off">
    <div class="form-av" data-av>${avatar(a || { name: '', color })}</div>
    <h1 class="login-title sm">${isNew ? 'New account' : 'Edit account'}</h1>
    <input class="login-input" name="name" maxlength="24" placeholder="Name" value="${a?.name || a?.plexName || ''}" ${isNew ? 'autofocus' : ''} enterkeyhint="done">
    <div class="swatches">${COLORS.map(([c1, c2], i) => html`<button type="button" class="sw${i === color ? ' on' : ''}" data-color="${i}" style="--c1:${c1};--c2:${c2}" aria-label="Colour ${i + 1}"></button>`)}</div>
    <label class="login-row"><span>${icon('lock')}<b>Lock with a PIN</b><small>Asks for 4 digits when you switch to it</small></span><input type="checkbox" class="switch" name="pin" ${a?.pin ? 'checked' : ''}></label>
    <button class="btn pill primary login-go" type="submit">${isNew ? 'Create & connect music' : 'Save'}</button>
    ${!isNew && a.id !== cur ? html`<button class="login-link danger" type="button" data-l="remove" data-id="${a.id}">Remove from this device</button>` : ''}
    ${!isNew && a.id === cur && accounts.all.length > 1 ? html`<p class="login-note">This is the account you’re using. Switch to another one to remove it.</p>` : ''}
    <div class="login-foot"><button class="login-link" type="button" data-l="back">Back</button></div>
  </form>`;
}

function stage(markup, dir = 'fwd') {
  const host = $('.login-inner', root);
  const old = host.firstElementChild;
  const tmp = document.createElement('div');
  tmp.innerHTML = markup.toString();
  const el = tmp.firstElementChild;
  el.classList.add('enter-' + dir);
  host.appendChild(el);
  if (old) { old.classList.add('leave-' + dir); setTimeout(() => old.remove(), 380); }
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('enter-' + dir)));
  setTimeout(() => el.querySelector('[autofocus]')?.focus({ preventScroll: true }), 60);
  return el;
}

// typed PIN → resolves true when correct (or when a new one has been chosen twice)
function pinFlow(a, { create = false } = {}) {
  return new Promise((res) => {
    const el = stage(pinHTML(a, create ? 'Choose a PIN' : ''));
    if (create) $('[data-msg]', el).textContent = 'Pick 4 digits you’ll remember';
    let val = '', first = '';
    const dots = $$('.pin-dots i', el), msg = $('[data-msg]', el);
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < val.length));
    const press = async (k) => {
      if (k === 'del') { val = val.slice(0, -1); paint(); return; }
      if (val.length >= 4 || !/^\d$/.test(k)) return;
      val += k; paint(); navigator.vibrate?.(8);
      if (val.length < 4) return;
      if (create) {
        if (!first) { first = val; val = ''; setTimeout(() => { paint(); msg.textContent = 'Type it again to confirm'; }, 160); return; }
        if (val === first) { cleanup(); res(val); return; }
        first = ''; val = ''; shake(el, 'Those didn’t match — try again'); setTimeout(paint, 300); return;
      }
      if (await accounts.checkPin(a.id, val)) { el.classList.add('ok'); cleanup(); setTimeout(() => res(true), 180); }
      else { val = ''; shake(el, 'Wrong PIN — try again'); setTimeout(paint, 300); }
    };
    function shake(e, m) { e.classList.remove('shake'); void e.offsetWidth; e.classList.add('shake'); msg.textContent = m; navigator.vibrate?.([30, 40, 30]); }
    el.addEventListener('click', (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k != null) press(k);
      if (e.target.closest('[data-l="back"]')) { cleanup(); res(false); }
    });
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Escape') { cleanup(); res(false); }
    };
    addEventListener('keydown', onKey, true);
    function cleanup() { removeEventListener('keydown', onKey, true); }
  });
}

function formFlow(a) {
  return new Promise((res) => {
    const el = stage(formHTML(a));
    let color = a?.color ?? (accounts.all.length % COLORS.length);
    const repaintAv = () => {
      const name = el.elements.name.value;
      $('[data-av]', el).innerHTML = avatar({ ...(a || {}), name, color, pin: el.elements.pin.checked }).toString();
    };
    el.addEventListener('input', repaintAv);
    el.addEventListener('click', async (e) => {
      const sw = e.target.closest('[data-color]');
      if (sw) {
        color = +sw.dataset.color; $$('.sw', el).forEach((x) => x.classList.toggle('on', x === sw)); repaintAv();
        const [c1, c2] = COLORS[color]; root.style.setProperty('--c1', c1); root.style.setProperty('--c2', c2);
      }
      if (e.target.closest('[data-l="back"]')) res(null);
      const rm = e.target.closest('[data-l="remove"]');
      if (rm) {
        if (rm.dataset.armed !== '1') { rm.dataset.armed = '1'; rm.textContent = 'Tap again to remove — its library, likes and stats on this device are deleted'; return; }
        rm.textContent = 'Removing…';
        await accounts.remove(a.id);
        res({ removed: true });
      }
    });
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = el.elements.name.value.trim();
      if (!name && !a?.plexName) { el.elements.name.focus(); el.elements.name.classList.add('need'); return; }
      res({ name, color, pin: el.elements.pin.checked });
    });
  });
}

async function onPick(id) {
  const a = accounts.get(id);
  if (!a) return;
  if (mode !== 'boot' && id === accounts.activeId) { close(); return; }
  if (a.pin && !accounts.isUnlocked(id)) {
    const ok = await pinFlow(a);
    if (!ok) { stage(pickerHTML(), 'back'); return; }
    accounts.markUnlocked(id);
  }
  enter(id);
}

function enter(id, then = '') {
  try { sessionStorage.setItem('picked', id); } catch (e) { /* */ }
  // at launch nothing has opened a database yet, so the app can simply start as this account
  if (mode === 'boot' && !openedName()) {
    accounts.choose(id);
    if (then) sessionStorage.setItem('afterSwitch', then);
    root.classList.add('leaving');
    setTimeout(() => { root.remove(); root = null; }, 450);
    removeEventListener('keydown', keyHandler, true);
    resolveBoot?.(id);
    return;
  }
  root.classList.add('leaving');
  accounts.switchTo(id, { then });
}

async function onEdit(id) {
  const a = id ? accounts.get(id) : null;
  const r = await formFlow(a);
  if (!r) { stage(pickerHTML(), 'back'); return; }
  if (r.removed) { stage(pickerHTML(), 'back'); return; }
  let target = id;
  if (!a) target = accounts.add({ name: r.name, color: r.color });
  else accounts.update(id, { name: r.name, color: r.color });
  const had = accounts.hasPin(target);
  if (r.pin && !had) {
    const pin = await pinFlow(accounts.get(target), { create: true });
    if (pin) await accounts.setPin(target, pin);
  } else if (!r.pin && had) await accounts.setPin(target, '');
  if (!a) { accounts.markUnlocked(target); enter(target, 'connect'); return; }
  stage(pickerHTML(), 'back');
}

function close() {
  if (!root) return;
  removeEventListener('keydown', keyHandler, true);
  root.classList.add('leaving');
  const r = root; root = null;
  setTimeout(() => r.remove(), 450);
}

// Shows the login screen. At launch it resolves once an account is chosen; from inside the app,
// choosing another account restarts the app as that account.
export function showLogin({ boot = false } = {}) {
  mode = boot ? 'boot' : 'app'; manage = false;
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'login';
  root.className = 'login';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Choose an account');
  const [c1, c2] = accounts.colors(accounts.active);
  root.style.setProperty('--c1', c1); root.style.setProperty('--c2', c2);
  root.innerHTML = '<div class="login-bg"><i></i><i></i><i></i></div><div class="login-inner"></div>';
  document.body.appendChild(root);
  stage(pickerHTML(), 'none');
  requestAnimationFrame(() => root?.classList.add('in'));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-l]');
    if (!b || !root?.contains(b)) return;
    const l = b.dataset.l;
    if (l === 'pick') onPick(b.dataset.id);
    else if (l === 'edit') onEdit(b.dataset.id);
    else if (l === 'add') onEdit(null);
    else if (l === 'manage') { manage = !manage; stage(pickerHTML(), manage ? 'fwd' : 'back'); }
    else if (l === 'close') close();
  });
  root.addEventListener('change', (e) => { if (e.target.matches('[data-l="ask"]')) accounts.ask = e.target.checked; });
  // keyboard: 1–9 picks an account, N adds one, Esc closes
  keyHandler = (e) => {
    if (!root || $('.login-stage[data-stage="pick"]:not([class*="leave"])', root) == null || e.target.matches?.('input')) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= accounts.all.length && !manage) { e.preventDefault(); onPick(accounts.all[n - 1].id); }
    else if (e.key === 'Escape' && mode !== 'boot') close();
  };
  addEventListener('keydown', keyHandler, true);
  return boot ? new Promise((r) => { resolveBoot = r; }) : Promise.resolve();
}

// keep each account's tile up to date (Plex name/avatar, server, song count)
export function noteAccount({ plexUser, server, songs, nas }) {
  const a = accounts.active;
  if (!a) return;
  const patch = { plexName: plexUser?.name || '', thumb: plexUser?.thumb || '', server: server || '', songs: songs || 0, nas: !!nas };
  if (!a.name && plexUser?.name) patch.name = plexUser.name;
  accounts.update(a.id, patch);
}

// a brand-new account opens on this: pick where its music comes from
export function connectSheet({ plexSignIn }) {
  const sheet = $('#sheet');
  const a = accounts.active;
  const [c1, c2] = accounts.colors(a);
  sheet.innerHTML = html`<div class="sheet-backdrop" data-x></div>
    <div class="sheet-panel dialog connect-sheet" style="--c1:${c1};--c2:${c2}">
      ${avatar(a, 'big')}
      <div class="sheet-title big">Welcome, ${accounts.label(a)}</div>
      <p class="plex-sub">Connect this account’s music. Already use Player on another device? Sign in with the same Plex and your account — playlists, BPMs, settings — comes right back.</p>
      <button class="btn pill primary connect-btn" data-c="plex"><svg class="plex-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 2h5.3l7.7 10-7.7 10H5.5l7.7-10z" fill="currentColor"/></svg>Sign in with Plex</button>
      <button class="btn pill ghost connect-btn" data-c="nas">${icon('server')}Use a NAS folder</button>
      <button class="sheet-cancel" data-x>Later</button>
    </div>`.toString();
  requestAnimationFrame(() => sheet.classList.add('open'));
  const shut = () => { sheet.classList.remove('open'); setTimeout(() => { if (!sheet.classList.contains('open')) sheet.innerHTML = ''; }, 260); };
  sheet.onclick = (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'plex') plexSignIn(); // opens the Plex window inside this tap so it isn't blocked
    else if (c === 'nas') { shut(); location.hash = '#/settings/source'; }
    else if (e.target.closest('[data-x]')) shut();
  };
}

export { accounts };

// Signed in to a Plex (or GitHub) that has Player accounts saved → pick one to bring back
// `box` = { list: [profile data…], where, here: Set of ids already on this device, mine: this account's id }
export function restoreSheet(box, { restore, fresh }) {
  const sheet = $('#sheet');
  const list = box.list || [];
  if (!list.length) return;
  let sel = list.find((d) => d.cid === box.mine) || list.find((d) => !box.here?.has(d.cid)) || list[0];
  const ago = (t) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const partsOf = (d) => {
    const nPlays = Object.values(d.statsBy || {}).reduce((n, v) => n + Object.values(v.plays || {}).reduce((m, arr) => m + arr.length, 0), 0) + Object.values(d.plays || {}).reduce((m, arr) => m + arr.length, 0);
    const nDev = Object.keys(d.statsBy || {}).length;
    return [
      ['profile', 'Name, colour & PIN', d.profile?.name || ''],
      ['settings', 'Settings', d.settings ? 'DJ, sound, look & everything else' : ''],
      ['music', 'Playlists & likes', [d.playlists?.length ? `${d.playlists.length} playlist${d.playlists.length > 1 ? 's' : ''}` : '', d.likes?.length ? `${d.likes.length} likes` : ''].filter(Boolean).join(' · ')],
      ['dj', 'BPMs & clean/explicit picks', Object.keys(d.bpm || {}).length ? `${Object.keys(d.bpm).length} tapped BPMs` : ''],
      ['friends', 'Friends & chats', d.friends?.list?.length ? `${d.friends.list.length} friend${d.friends.list.length > 1 ? 's' : ''}${Object.keys(d.friends.chats || {}).length ? ' · recent messages' : ''}` : ''],
      ['stats', 'Listening stats', nPlays ? `${nPlays.toLocaleString()} plays${nDev > 1 ? ` from ${nDev} devices` : ''}` : ''],
    ].filter(([k, , sub]) => k === 'profile' || k === 'settings' ? true : !!sub);
  };
  const draw = () => {
    const p = sel.profile || {};
    const a = { name: p.name || 'Your account', color: p.color ?? 1 };
    const [c1, c2] = accounts.colors(a);
    sheet.innerHTML = html`<div class="sheet-backdrop"></div>
      <div class="sheet-panel dialog connect-sheet" style="--c1:${c1};--c2:${c2}">
        ${list.length > 1 ? html`<div class="restore-who">${list.map((d) => { const pp = d.profile || {}, aa = { name: pp.name || 'Account', color: pp.color ?? 1 }; return html`<button class="restore-acct${d === sel ? ' on' : ''}" data-cid="${d.cid}">${avatar(aa, 'sm')}<span><b>${accounts.label(aa)}</b><small>${box.here?.has(d.cid) ? 'On this device' : d.cid === box.mine ? 'This account' : ago(d.at)}</small></span></button>`; })}</div>`
          : avatar(a, 'big')}
        <div class="sheet-title big">${list.length > 1 ? `${list.length} accounts saved` : `Welcome back${p.name ? `, ${p.name}` : ''}`}</div>
        <p class="plex-sub">${list.length > 1 ? `Pick yours — each account is kept separately on ${box.where === 'GitHub' ? 'GitHub' : 'your Plex'}, nothing overwrites another. ` : `Your Player account is saved on ${box.where === 'GitHub' ? 'GitHub' : 'your Plex'}. `}<b>${accounts.label(a)}</b> was saved${sel.device ? ` from ${sel.device}` : ''}${sel.at ? ` (${ago(sel.at)})` : ''}.</p>
        <div class="restore-parts">${partsOf(sel).map(([k, l, sub]) => html`<label class="restore-part"><input type="checkbox" value="${k}" checked><span><b>${l}</b>${sub ? html`<small>${sub}</small>` : ''}</span></label>`)}</div>
        <button class="btn pill primary connect-btn restore-go" data-c="restore">${icon('download')}Restore ${accounts.label(a)}</button>
        <button class="sheet-cancel" data-c="fresh">Start fresh as a new account</button>
      </div>`.toString();
  };
  draw();
  requestAnimationFrame(() => sheet.classList.add('open'));
  const shut = () => { sheet.classList.remove('open'); setTimeout(() => { if (!sheet.classList.contains('open')) sheet.innerHTML = ''; }, 260); };
  sheet.onclick = async (e) => {
    const who = e.target.closest('[data-cid]');
    if (who) { sel = list.find((d) => d.cid === who.dataset.cid) || sel; draw(); return; }
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'restore') {
      const parts = [...sheet.querySelectorAll('.restore-part input:checked')].map((x) => x.value);
      if (!parts.length) return;
      e.target.closest('button').textContent = 'Restoring…'; await restore(sel, parts); shut();
    } else if (c === 'fresh') { shut(); fresh(); }
  };
}
