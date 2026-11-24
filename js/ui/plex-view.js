// Plex sign-in flow + Plex settings page (account, server, libraries, sync)
import { html, icon, $, esc } from '../util.js';
import { plex, PlexError } from '../plex.js';
import { settings } from '../settings.js';
import { pageHeader, toast, confirmSheet, haptic } from './components.js';

export const plexLogo = (cls = '') => html`<svg class="plex-logo ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 2h5.3l7.7 10-7.7 10H5.5l7.7-10z" fill="currentColor"/></svg>`;

const sheet = () => $('#sheet');
function closeSheet() { sheet().classList.remove('open'); setTimeout(() => { if (!sheet().classList.contains('open')) sheet().innerHTML = ''; }, 260); }

// ---------- sign in ----------
let signing = null;
export async function plexSignIn({ onDone } = {}) {
  if (signing) return;
  // open the window synchronously (inside the tap) so it isn't blocked as a pop-up
  let win = null;
  try { win = window.open('', 'plexauth'); } catch (e) { win = null; }
  const ctrl = new AbortController();
  signing = ctrl;
  sheet().innerHTML = html`<div class="sheet-backdrop" data-x></div>
    <div class="sheet-panel dialog plex-sheet">
      <div class="plex-badge">${plexLogo()}</div>
      <div class="sheet-title big">Sign in with Plex</div>
      <p class="plex-sub" data-msg>Getting a sign-in code…</p>
      <div class="plex-code" data-code>····</div>
      <a class="btn pill primary plex-btn" data-open target="plexauth" rel="noopener" href="#" aria-disabled="true">${plexLogo()}Open Plex sign-in</a>
      <p class="plex-alt">Or on any device go to <b>plex.tv/link</b> and enter the code.</p>
      <div class="plex-wait"><div class="spinner"></div><span>Waiting for you to sign in…</span></div>
      <button class="sheet-cancel" data-x>Cancel</button>
    </div>`.toString();
  requestAnimationFrame(() => sheet().classList.add('open'));
  sheet().onclick = (e) => {
    if (e.target.closest('[data-x]')) { ctrl.abort(); try { win?.close(); } catch (er) { /* */ } closeSheet(); }
  };
  try {
    const pin = await plex.startPin();
    const url = plex.authUrl(pin);
    const a = $('[data-open]', sheet());
    if (a) { a.href = url; a.removeAttribute('aria-disabled'); }
    $('[data-code]', sheet()).textContent = pin.code;
    $('[data-msg]', sheet()).textContent = 'Approve this device in the Plex window that just opened.';
    if (win && !win.closed) { try { win.location.href = url; } catch (e) { /* */ } }
    const token = await plex.pollPin(pin, ctrl.signal);
    try { win?.close(); } catch (e) { /* */ }
    $('[data-msg]', sheet()).textContent = 'Signed in! Finding your servers…';
    const user = await plex.finishLogin(token);
    haptic(20);
    const servers = await plex.servers();
    closeSheet();
    toast(`Welcome, ${user.name}`);
    const online = servers.filter((s) => s.presence);
    if (servers.length === 1 || online.length === 1) {
      await connectAndSync(online[0] || servers[0], onDone);
    } else {
      location.hash = '#/settings/plex';
      onDone?.('pick');
    }
  } catch (e) {
    try { win?.close(); } catch (er) { /* */ }
    if (e.kind !== 'cancelled') {
      const m = $('[data-msg]', sheet());
      if (m) { m.textContent = e.message; m.classList.add('err'); $('.plex-wait', sheet())?.remove(); }
      else toast(e.message);
    }
  } finally {
    signing = null;
  }
}

export async function connectAndSync(server, onDone) {
  toast(`Connecting to ${server.name}…`, { ms: 6000 });
  try {
    const c = await plex.connect(server);
    const secs = await plex.sections();
    plex.cfg.sections = secs.map((s) => s.key);
    await plex.save();
    if (!secs.length) { toast('No music libraries on this server'); location.hash = '#/settings/plex'; return; }
    toast(`Connected ${c.relay ? 'via Plex Relay' : c.local ? 'on your network' : 'remotely'} · syncing your music…`, { ms: 4000 });
    plex.sync();
    location.hash = '#/home';
    onDone?.('sync');
  } catch (e) {
    toast(e.message, { ms: 6000 });
    location.hash = '#/settings/plex';
  }
}

// ---------- settings page ----------
const toggle = (k, label, sub = '') => html`<label class="set-row">
  <div class="set-text"><span>${label}</span>${sub ? html`<small>${sub}</small>` : ''}</div>
  <input type="checkbox" class="switch" data-set="${k}" ${settings.get(k) ? 'checked' : ''}>
</label>`;
const group = (title, body, foot = '') => html`<section class="set-group">${title ? html`<h3>${title}</h3>` : ''}<div class="set-card">${body}</div>${foot ? html`<p class="set-foot">${foot}</p>` : ''}</section>`;

function ago(t) {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`;
}

export function plexPage() {
  if (!plex.signedIn) {
    return {
      title: 'Plex',
      html: html`${pageHeader('Plex', { back: true })}
      <div class="plex-hero">
        <div class="plex-badge big">${plexLogo()}</div>
        <h2>Sign in with Plex</h2>
        <p>Use the music library from your Plex Media Server — the same one Plexamp plays. Sign in once and the app finds your server and connects securely, at home or away.</p>
        <button class="btn pill primary big plex-btn" data-a="plex-signin">${plexLogo()}Sign in with Plex</button>
      </div>
      ${group('', html`<div class="help"><p>Streams your original files — FLAC and hi-res stay lossless. Plays, loves and playlists stay in sync with Plex. All the transitions, BPM and EQ features work the same.</p></div>`)}
      <div class="bottom-pad"></div>`,
    };
  }
  const u = plex.user || {};
  const s = plex.cfg.server;
  return {
    title: 'Plex',
    html: html`${pageHeader('Plex', { back: true })}
    <div class="plex-account">
      ${u.thumb ? html`<img class="plex-avatar" src="${u.thumb}" alt="" referrerpolicy="no-referrer">` : html`<div class="plex-avatar">${esc((u.name || '?')[0])}</div>`}
      <div><b>${u.name}</b><span>${u.email || u.username || ''}</span></div>
      <button class="btn pill ghost" data-a="plex-signout">Sign Out</button>
    </div>
    ${s ? group('Server', html`
      <div class="set-row"><span class="set-ic plex-ic">${plexLogo()}</span><div class="set-text"><span>${s.name}</span><small data-conn>${{ local: 'Connected on your network', remote: 'Connected remotely', relay: 'Connected via Plex Relay (limited speed)' }[plex.cfg.connKind] || 'Connected'}</small></div></div>
      <button class="set-row link" data-a="plex-servers"><div class="set-text"><span class="accent">Change Server…</span></div></button>`) : ''}
    <section class="set-group" data-servers ${s ? 'hidden' : ''}><h3>Choose a server</h3><div class="set-card" data-server-list><div class="set-row"><div class="spinner"></div><div class="set-text"><span>Looking for your servers…</span></div></div></div></section>
    ${s ? html`<section class="set-group"><h3>Music libraries</h3><div class="set-card" data-sections><div class="set-row"><div class="spinner"></div></div></div></section>` : ''}
    ${s ? group('Sync', html`
      <button class="set-row link" data-a="plex-sync"><span class="set-ic">${icon('refresh')}</span><div class="set-text"><span>${plex.running ? 'Syncing…' : 'Sync Now'}</span><small>Last synced ${ago(plex.cfg.lastSync)}</small></div></button>
      ${toggle('plexSyncOnLaunch', 'Sync when the app opens', 'Picks up new music you added to Plex')}
      ${toggle('plexReport', 'Share playback with Plex', 'Shows “Now Playing” in Plex and adds plays to your history, like Plexamp')}
    `, 'Loves (♥) sync both ways. Plex playlists appear in your Library.') : ''}
    <div class="bottom-pad"></div>`,
    async after(root) {
      if (!s) loadServers(root);
      else loadSections(root);
    },
  };
}

export async function loadServers(root) {
  const box = $('[data-servers]', root);
  if (!box) return;
  box.hidden = false;
  const list = $('[data-server-list]', box);
  let servers;
  try { servers = await plex.servers(); } catch (e) {
    list.innerHTML = html`<div class="set-row"><div class="set-text"><span>${e.message}</span></div></div>`.toString();
    return;
  }
  if (!servers.length) {
    list.innerHTML = html`<div class="set-row"><div class="set-text"><span>No servers on this account</span><small>Sign in with the account that owns or has access to your Plex Media Server.</small></div></div>`.toString();
    return;
  }
  list.innerHTML = servers.map((sv, i) => html`<button class="set-row link" data-srv="${i}">
    <span class="set-ic plex-ic">${plexLogo()}</span>
    <div class="set-text"><span>${sv.name}${plex.cfg.server?.id === sv.id ? ' ✓' : ''}</span><small>${sv.owned ? 'Your server' : 'Shared with you'} · ${sv.presence ? 'Online' : 'Offline'}${sv.version ? ` · Plex ${sv.version.split('-')[0]}` : ''}</small></div>
    ${icon('right', 'chev')}</button>`).join('');
  list.onclick = async (e) => {
    const b = e.target.closest('[data-srv]');
    if (!b) return;
    b.querySelector('small').textContent = 'Connecting…';
    await connectAndSync(servers[+b.dataset.srv]);
  };
}

async function loadSections(root) {
  const box = $('[data-sections]', root);
  if (!box) return;
  let secs;
  try { await plex.ensureConnection(); secs = await plex.sections(); } catch (e) {
    box.innerHTML = html`<div class="set-row"><div class="set-text"><span>Can’t reach the server right now</span><small>${e.message}</small></div></div>`.toString();
    return;
  }
  const on = new Set(plex.cfg.sections?.length ? plex.cfg.sections : secs.map((x) => x.key));
  box.innerHTML = secs.length ? secs.map((x) => html`<label class="set-row"><div class="set-text"><span>${x.title}</span></div>
    <input type="checkbox" class="switch" data-sec="${x.key}" ${on.has(x.key) ? 'checked' : ''}></label>`).join('')
    : html`<div class="set-row"><div class="set-text"><span>No music libraries on this server</span></div></div>`.toString();
  box.onchange = async () => {
    plex.cfg.sections = [...box.querySelectorAll('[data-sec]')].filter((i) => i.checked).map((i) => i.dataset.sec);
    await plex.save();
    toast('Libraries updated · syncing…');
    plex.sync();
  };
}

export async function plexSignOut(after) {
  if (!(await confirmSheet('Sign out of Plex? Songs from Plex will be removed from this device (your Plex server isn’t touched).', 'Sign Out', true))) return;
  await plex.signOut();
  toast('Signed out of Plex');
  after?.();
}

export { PlexError };
