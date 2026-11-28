// Settings screens
import { html, raw, icon, fmtBytes, $, $$ } from '../util.js';
import { settings, EQ_FREQS, EQ_PRESETS, EQ_NAMES, DEFAULTS } from '../settings.js';
import { library } from '../library.js';
import { engine } from '../engine.js';
import { scanner } from '../scanner.js';
import { analyze, isAnalyzed, verifyBpm } from '../analysis.js';
import { accounts } from '../accounts.js';
import { cloud } from '../cloud.js';
import { saveSource, loadSource, testSource } from '../sources.js';
import * as db from '../db.js';
import { pageHeader, actionSheet, toast, confirmSheet } from './components.js';
import { plex } from '../plex.js';
import { brain } from '../dj-brain.js';
import { soundAI } from '../sound-ai.js';
import { plexPage, plexLogo } from './plex-view.js';
import { current as dualInfo } from './dual.js';

export const APP_VERSION = '1.42.0';

// ---------- controls ----------
const toggle = (k, label, sub = '') => html`<label class="set-row">
  <div class="set-text"><span>${label}</span>${sub ? html`<small>${sub}</small>` : ''}</div>
  <input type="checkbox" class="switch" data-set="${k}" ${settings.get(k) ? 'checked' : ''}>
</label>`;
const seg = (k, label, opts, sub = '') => html`<div class="set-row col">
  <div class="set-text"><span>${label}</span>${sub ? html`<small>${sub}</small>` : ''}</div>
  <div class="seg" data-seg="${k}">${opts.map(([v, l]) => html`<button class="${String(settings.get(k)) === String(v) ? 'on' : ''}" data-v="${v}">${l}</button>`)}</div>
</div>`;
const slider = (k, label, min, max, step, unit = '', sub = '') => html`<div class="set-row col">
  <div class="set-text"><span>${label}</span><b class="set-val" data-val="${k}">${fmtNum(settings.get(k))}${unit}</b>${sub ? html`<small>${sub}</small>` : ''}</div>
  <input type="range" class="range" data-range="${k}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${settings.get(k)}">
</div>`;
const text = (k, label, sub = '') => html`<div class="set-row col">
  <div class="set-text"><span>${label}</span>${sub ? html`<small>${sub}</small>` : ''}</div>
  <input class="text-input" data-text="${k}" value="${settings.get(k)}" autocomplete="off" autocapitalize="off" spellcheck="false">
</div>`;
// iOS-style colored icon tiles
const TILE = { server: '#0a84ff', mix: '#ff375f', eq: '#ff9f0a', library: '#bf5af2', palette: '#5e5ce6', sparkle: '#30b0c7', bpm: '#30d158', storage: '#8e8e93', info: '#8e8e93', refresh: '#64d2ff', car: '#ff9f0a', wifi: '#ff9f0a', download: '#30d158', trash: '#ff453a', timer: '#ff9f0a', switch: '#5e5ce6', lock: '#636366', user: '#5e5ce6' };
const tile = (ic) => (TILE[ic] ? `style="background:${TILE[ic]}"` : '');
const link = (href, ic, label, value = '') => html`<a class="set-row link" href="${href}">
  <span class="set-ic" ${raw(tile(ic))}>${icon(ic)}</span><div class="set-text"><span>${label}</span></div><span class="set-value">${value}</span>${icon('right', 'chev')}
</a>`;
const button = (a, ic, label, { danger = false, sub = '' } = {}) => html`<button class="set-row link${danger ? ' danger' : ''}" data-a="${a}">
  ${ic ? html`<span class="set-ic" ${raw(danger ? '' : tile(ic))}>${icon(ic)}</span>` : ''}<div class="set-text"><span>${label}</span>${sub ? html`<small>${sub}</small>` : ''}</div>
</button>`;
const group = (title, body, foot = '') => html`<section class="set-group">${title ? html`<h3>${title}</h3>` : ''}<div class="set-card">${body}</div>${foot ? html`<p class="set-foot">${raw(foot)}</p>` : ''}</section>`;
function fmtNum(v) { return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v; }

// ---------- pages ----------
export async function settingsView(page = '') {
  const fn = { '': root, sources, plex: plexPage, source, playback, sound, library: libraryPage, appearance, storage, about, extras, accounts: accountsPage }[page] || root;
  return fn();
}

// every account on this device, one tap to switch (the login screen handles PINs)
function accountsGroup() {
  const list = accounts.all, cur = accounts.activeId;
  const av = (a) => { const [c1, c2] = accounts.colors(a), n = accounts.label(a); return html`<span class="acct-av sm" style="--c1:${c1};--c2:${c2}">${a.thumb ? html`<img src="${a.thumb}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<em>${(n[0] || '♪').toUpperCase()}</em></span>`; };
  return html`<section class="set-group"><h3>Accounts</h3><div class="acct-strip">
    ${list.map((a) => html`<button class="acct-chip${a.id === cur ? ' on' : ''}" data-a="accounts">${av(a)}<b>${accounts.label(a)}</b>${a.pin ? icon('lock', 'chip-lock') : ''}</button>`)}
    <button class="acct-chip add" data-a="add-account"><span class="acct-av sm plus">${icon('plus')}</span><b>Add</b></button>
  </div><div class="set-card">
    ${button('accounts', 'switch', list.length > 1 ? 'Switch account' : 'Add another account', { sub: list.length > 1 ? `${list.length} accounts on this device · each keeps its own Plex, likes, stats and friends` : 'Someone else’s Plex, or a second library — each one stays signed in' })}
    ${list.length > 1 ? button('toggle-ask', 'user', `Ask who’s listening on open: ${accounts.ask ? 'On' : 'Off'}`, { sub: accounts.ask ? 'Shows the account picker every time the app opens' : 'Opens straight into the account you used last' }) : ''}
    ${accounts.hasPin(cur) ? button('lock-account', 'lock', 'Lock now', { sub: 'Shows the login screen; your PIN opens it again' }) : ''}
  </div></section>
  ${cloudGroup()}`;
}

function cloudGroup() {
  const st = cloud.state || {};
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`; };
  const where = [plex.connected ? 'your Plex' : '', cloud.ghToken ? 'GitHub' : ''].filter(Boolean).join(' and ');
  const status = !settings.get('cloudSync') ? 'Off' : st.error ? `Couldn’t save: ${st.error}` : st.at ? `Saved to ${st.where || where} ${ago(st.at)}` : where ? 'Not saved yet' : 'Sign in to Plex (or add GitHub) to turn this on';
  return group('Account cloud', html`
    <div class="set-row"><div class="set-text"><span class="cloud-status"><i class="cloud-dot${!settings.get('cloudSync') || !where ? ' off' : st.error ? ' err' : ''}"></i>${status}</span><small>Your account, settings, playlists, likes, friends and chats, listening stats, clean/explicit picks and tapped BPMs are backed up automatically. Sign in to the same Plex on another phone or computer — or tap Restore — and pick what to bring back.${cloud.trimmed ? ' Your full stats history is too big for Plex, so it keeps the latest months; add GitHub for all of it.' : ''}</small></div></div>
    ${toggle('cloudSync', 'Save my account to the cloud', 'Kept on your own Plex server (playlists called “Player sync” and “Player analysis”, which hold your account and every song’s BPM & key) — nothing goes anywhere else')}
    ${toggle('cloudStats', 'Combine stats from all devices', 'Off: Stats count this device (still backed up, and restorable). On: every device’s listening adds up')}
    ${where ? button('cloud-save', 'refresh', 'Sync now', { sub: st.pulled ? `Last brought in changes from ${st.from || 'another device'} ${ago(st.pulled)}` : 'Save this device and pick up changes from the others' }) : ''}
    ${where ? button('cloud-restore', 'download', 'Restore from cloud…', { sub: 'Choose what to bring back: settings, playlists & likes, stats, BPMs' }) : ''}
    ${(() => {
      const r = accounts.roster(); const list = r?.list || [];
      if (!list.length) return '';
      const mine = accounts.active?.cid, here = new Set(accounts.all.map((a) => a.cid));
      return html`<div class="set-row col"><div class="set-text"><span>Saved accounts</span><small>${list.length} account${list.length > 1 ? 's' : ''} on ${r.where || 'your Plex'} — each kept separately. Anyone can add theirs from the login screen.</small></div>
        <div class="cloud-list">${list.sort((a, b) => b.at - a.at).map((c) => html`<div class="cloud-acct"><span class="acct-av sm" style="--c1:${accounts.colors(c)[0]};--c2:${accounts.colors(c)[1]}"><em>${(c.name || '?')[0].toUpperCase()}</em></span>
          <span class="cloud-acct-t"><b>${c.name || 'Account'}</b><small>${c.cid === mine ? 'This account' : here.has(c.cid) ? 'On this device' : 'Not on this device'} · ${ago(c.at)}${c.device ? ` · ${c.device}` : ''}</small></span>
          ${c.cid === mine ? '' : html`<button class="dl-x" data-a="cloud-remove" data-cid="${c.cid}" data-name="${c.name}" aria-label="Remove from cloud">${icon('trash')}</button>`}</div>`)}</div></div>`;
    })()}
    ${button('cloud-github', 'server', cloud.ghToken ? 'GitHub backup: on' : 'Also back up to GitHub', { sub: cloud.ghToken ? 'A private Gist on your GitHub · tap to change or remove' : 'Optional — a private Gist. Works even without Plex (needs a GitHub token)' })}
  `);
}

function profileCard() {
  const u = plex.user;
  const name = accounts.active?.name || u?.name || u?.username || 'Your Music';
  const albums = library.albums?.size || 0, artists = library.artists?.size || 0;
  const w = library.weekStats?.() || { minutes: 0 };
  const where = plex.connected ? plex.cfg.server.name : 'This device';
  return html`<a class="set-profile" href="#/settings/accounts">
    ${u?.thumb ? html`<img class="sp-avatar" src="${u.thumb}" alt="" referrerpolicy="no-referrer">` : html`<div class="sp-avatar" style="background:linear-gradient(140deg,${accounts.colors(accounts.active)[0]},${accounts.colors(accounts.active)[1]})">${(name[0] || '♪').toUpperCase()}</div>`}
    <div class="sp-text"><b>${name}</b><small>${library.size.toLocaleString()} songs · ${albums.toLocaleString()} albums · ${artists.toLocaleString()} artists</small>
      <span class="sp-chips"><i>${where}</i><i>${Math.floor(w.minutes / 60)}h ${w.minutes % 60}m this week</i><i>v${APP_VERSION}</i></span></div>
    ${icon('right', 'chev')}</a>`;
}

async function root() {
  const src = await loadSource();
  const demo = await db.kv.get('demo');
  const srcLabel = plex.connected ? `Plex · ${plex.cfg.server.name}` : plex.signedIn ? 'Plex · choose server' : src?.url ? new URL(src.url).host : demo ? 'Demo library' : 'Not connected';
  const modeLabel = { smart: 'DJ Mix', crossfade: `Crossfade ${settings.get('crossfadeSec')}s`, off: 'Gapless' }[settings.get('transition')];
  const st = cloud.state || {};
  const nAcc = accounts.all.length;
  return {
    title: 'Settings',
    // what you change most comes first (the music and how the app looks), everything else after
    html: html`${pageHeader('Settings')}
    ${profileCard()}
    ${plex.connected && plex.cfg.connKind === 'relay' ? html`<a class="set-alert" href="#/settings/plex">
      <span class="set-alert-ic">${icon('wifi')}</span><div><b>Plex is on a slow connection</b><small>It’s using Plex Relay, so songs can start slowly. Tap to see how to fix it.</small></div>${icon('right', 'chev')}</a>` : ''}
    ${group('Music & app', html`
      ${link('#/settings/playback', 'mix', 'Playback & DJ', modeLabel)}
      ${link('#/settings/sound', 'eq', 'Sound & EQ', settings.get('eqOn') ? EQ_NAMES[settings.get('eqPreset')] : 'EQ off')}
      ${link('#/settings/appearance', 'palette', 'Appearance', 'Theme, layout, artwork')}
      ${link('#/settings/library', 'library', 'Library', `${library.size.toLocaleString()} songs`)}
      ${link('#/settings/sources', 'server', 'Music Sources', srcLabel)}`)}
    ${group('You', html`
      ${link('#/settings/accounts', 'user', 'Accounts & Cloud', `${nAcc} account${nAcc > 1 ? 's' : ''}${settings.get('cloudSync') && st.at ? ' · backed up' : ''}`)}
      ${link('#/stats', 'bpm', 'Your Stats', 'Top songs, artists, minutes')}
      ${link('#/downloads', 'download', 'Downloads', `${library.offline?.size || 0} songs`)}`)}
    ${group('More', html`
      ${link('#/settings/extras', 'sparkle', 'Extras', 'Gestures, Car Mode & more')}
      ${link('#/settings/storage', 'storage', 'Storage & Backup')}
      ${link('#/settings/about', 'info', 'About & Help')}`)}
    <div class="set-quick">
      <button class="set-quick-btn" data-a="rescan">${icon('refresh')}<span><b>${scanner.running ? 'Scanning…' : 'Scan for new music'}</b><small>${await lastScanText()}</small></span></button>
      <button class="set-quick-btn" data-a="force-refresh">${icon('download')}<span><b>Refresh app</b><small>v${APP_VERSION} · stays signed in</small></span></button>
    </div>
    <div class="bottom-pad"></div>`,
  };
}
async function accountsPage() {
  return {
    title: 'Accounts & Cloud',
    html: html`${pageHeader('Accounts & Cloud', { back: true })}
    ${accountsGroup()}
    ${group('This account', html`<div class="set-row"><div class="set-text"><span>Account ID</span><small>Every device signed in to this account (same Plex) shares this ID — friends, chats, playlists and settings follow it.</small></div><code class="acct-id">${cloud.cid()}</code></div>`)}
    <div class="bottom-pad"></div>`,
  };
}
async function lastScanText() {
  const t = await db.kv.get('lastScan');
  if (!t) return 'Never scanned';
  const m = Math.round((Date.now() - t) / 60000);
  return 'Last scan ' + (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`);
}

async function sources() {
  const src = await loadSource();
  const demo = await db.kv.get('demo');
  const nPlex = [...library.tracks.values()].filter((t) => t.plex).length;
  const nNas = [...library.tracks.values()].filter((t) => !t.plex && !t.demo).length;
  return {
    title: 'Music Sources',
    html: html`${pageHeader('Music Sources', { back: true })}
    ${group('', html`
      <a class="set-row link" href="#/settings/plex"><span class="set-ic plex-ic">${plexLogo()}</span>
        <div class="set-text"><span>Plex</span><small>${plex.connected ? `${plex.cfg.server.name} · ${nPlex} songs` : plex.signedIn ? `Signed in as ${plex.user?.name} · choose a server` : 'Sign in to use your Plex music library'}</small></div>${icon('right', 'chev')}</a>
      <a class="set-row link" href="#/settings/source"><span class="set-ic">${icon('server')}</span>
        <div class="set-text"><span>NAS folder</span><small>${src?.url ? `${new URL(src.url).host} · ${nNas} songs` : 'WebDAV or HTTP folder — no Plex needed'}</small></div>${icon('right', 'chev')}</a>
    `, 'You can use both at once — everything shows up in one library.')}
    ${group('Demo', html`${toggle('__demo', 'Demo library', 'Generated songs to try transitions & BPM')}`)}
    <div class="bottom-pad"></div>`,
    after(root) { const d = $('[data-set="__demo"]', root); if (d) d.checked = !!demo; },
  };
}

async function source() {
  const s = (await loadSource()) || { type: 'webdav', url: '', username: '' };
  const demo = await db.kv.get('demo');
  return {
    title: 'NAS Folder',
    html: html`${pageHeader('NAS Folder', { back: true })}
    <form class="src-form" data-src-form>
      ${group('Connect to your NAS', html`
        <div class="set-row col">
          <div class="set-text"><span>Connection type</span></div>
          <div class="seg" data-src-type>
            <button type="button" class="${s.type !== 'http' ? 'on' : ''}" data-v="webdav">WebDAV</button>
            <button type="button" class="${s.type === 'http' ? 'on' : ''}" data-v="http">HTTP folder</button>
          </div>
        </div>
        <div class="set-row col"><div class="set-text"><span>Music folder address</span><small>Must be <b>https://</b> — e.g. https://nas.tail1234.ts.net:5006/music/</small></div>
          <input class="text-input" name="url" type="url" inputmode="url" value="${s.url || ''}" placeholder="https://your-nas:5006/music/" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
        <div class="set-row col"><div class="set-text"><span>Username</span></div>
          <input class="text-input" name="username" value="${s.username || ''}" autocomplete="username" autocapitalize="off" spellcheck="false"></div>
        <div class="set-row col"><div class="set-text"><span>Password</span><small>${s.auth ? 'Saved — leave blank to keep it' : 'Stored only on this device'}</small></div>
          <input class="text-input" name="password" type="password" autocomplete="current-password" placeholder="${s.auth ? '••••••••' : ''}"></div>
      `)}
      <div class="src-status" data-src-status></div>
      <div class="btn-row">
        <button type="button" class="btn pill" data-a="src-test">Test Connection</button>
        <button type="submit" class="btn pill primary">Save & Scan</button>
      </div>
    </form>
    ${group('Setup help', html`
      <div class="help">
        <p><b>WebDAV</b> works with Synology (WebDAV Server package), QNAP, TrueNAS, Unraid, Nextcloud and rclone. <b>HTTP folder</b> works with nginx/Caddy/Apache directory listings.</p>
        <p>Because this app runs on GitHub Pages, your NAS address needs <b>HTTPS</b> and must allow this site with <b>CORS</b>. The easiest way: run the ready-made container in the <code>nas/</code> folder of the repo, and reach it from anywhere with Tailscale.</p>
        <a class="btn pill" href="https://github.com/DSOGH/player#connect-your-nas" target="_blank" rel="noopener">Open the setup guide</a>
      </div>`)}
    <div class="bottom-pad"></div>`,
    after(root) {
      let type = s.type || 'webdav';
      $('[data-src-type]', root).addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        type = b.dataset.v;
        $$('[data-src-type] button', root).forEach((x) => x.classList.toggle('on', x === b));
      });
      const form = $('[data-src-form]', root);
      const status = $('[data-src-status]', root);
      const read = () => {
        const f = new FormData(form);
        return { type, url: String(f.get('url') || '').trim(), username: String(f.get('username') || '').trim(), password: String(f.get('password') || '') };
      };
      const apply = async () => {
        const v = read();
        if (!/^https?:\/\//i.test(v.url)) throw new Error('Enter the full address starting with https://');
        if (location.protocol === 'https:' && v.url.startsWith('http:')) {
          throw new Error('Your browser blocks plain http:// from an https site. Use an https:// address for your NAS (see the setup guide — Tailscale gives you one for free).');
        }
        const keepAuth = !v.password && s.auth && v.username === s.username;
        const saved = await saveSource(v);
        if (keepAuth) { saved.auth = s.auth; await db.kv.set('source', saved); navigator.serviceWorker?.controller?.postMessage({ type: 'config-changed' }); }
        await new Promise((r) => setTimeout(r, 80));
        return saved;
      };
      const test = async () => {
        status.className = 'src-status busy';
        status.innerHTML = '<div class="spinner"></div> Connecting…';
        try {
          const cfg = await apply();
          const r = await testSource(cfg);
          status.className = 'src-status ok';
          status.innerHTML = html`${icon('check')} Connected — found ${r.dirs} folders and ${r.files} files at the top level.`.toString();
          return true;
        } catch (e) {
          status.className = 'src-status err';
          status.innerHTML = html`${icon('x')} ${e.message}`.toString();
          return false;
        }
      };
      root.querySelector('[data-a="src-test"]').addEventListener('click', (e) => { e.stopPropagation(); test(); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (await test()) {
          toast('Scanning your NAS…');
          scanner.run();
          location.hash = '#/home';
        }
      });
    },
  };
}

function playback() {
  const tm = settings.get('transition');
  return {
    title: 'Playback & DJ',
    html: html`${pageHeader('Playback & DJ', { back: true })}
    ${group('Between songs', html`
      ${seg('transition', 'Mode', [['smart', 'DJ Mix'], ['crossfade', 'Crossfade'], ['off', 'Gapless']],
        { smart: 'Mixes like a DJ: beat-matched, tempo-synced blends with a bass swap when tempos line up; filter sweeps when they don’t; echo-outs for hard endings. Albums stay gapless.', crossfade: 'Classic crossfade for a fixed time, like Spotify.', off: 'No overlap — songs play back-to-back.' }[tm])}
      ${slider('crossfadeSec', tm === 'smart' ? 'Mix length' : 'Crossfade length', 1, 16, 0.5, 's')}
      ${tm === 'smart' ? html`${seg('djStyle', 'DJ style', [['beats', 'Beat match'], ['auto', 'Auto'], ['wordplay', 'Word play']],
          { auto: 'Beat-matched blends, plus word play only when two songs line up really cleanly in their lyrics.', beats: 'Always mix on the beat: tempo-synced, phrase-aligned blends with a bass swap.', wordplay: 'Finds the same words in both songs: the beat drops out, the vocal is isolated, and the next song picks up singing those exact words.' }[settings.get('djStyle')])}` : ''}
    `)}
    ${tm === 'smart' ? group('DJ Cook It Up', html`
      ${button('cook-it-up', 'sparkle', 'Start DJ Cook It Up', { sub: 'Your whole library as a DJ set — songs picked to fit each other, mixed on the beat' })}
      ${seg('cookLevel', 'Style', [['smooth', 'Smooth'], ['club', 'Club'], ['hype', 'Hype'], ['wild', 'Wild']], { club: 'Like a club DJ: songs picked to fit, mixed on the beat — and it isn’t afraid to leave a song as early as halfway when that’s the best moment.', smooth: 'A real DJ set: each next song is picked to fit (tempo, key, genre, energy) and mixed slowly on the beat — long EQ blends, vocal bridges (one song singing over the other’s beat) and beat swaps. No cuts, no slides.', hype: 'Keeps the energy up: leaves songs early on a strong part, comes in on the next song’s big part, short tight blends and echo throws.', wild: 'Party tricks: loop rolls, brakes, spin-backs, risers, at random points in songs.' }[settings.get('cookLevel') || 'smooth'])}
    `) : ''}
    ${tm === 'smart' ? group('AI DJ', html`
      ${toggle('djLearn', 'Learn my taste', `A small AI on this phone learns from 👍 / 👎 on mixes, skips, likes and what you let play — and picks songs and mixes the way you like. ${(() => { const sm = brain.summary(); return sm ? `Learned from ${sm.n} mixes${sm.likes.length ? ` · you like ${sm.likes.join(', ')}` : ''}${sm.dislikes.length ? ` · not ${sm.dislikes.join(', ')}` : ''}.` : 'Still learning — rate a few mixes.'; })()}`)}
      ${toggle('soundAI', 'Sound AI', `A music neural network (MusiCNN) listens to each song on the phone: how it sounds, party / dance / mood / vocals — so songs that belong together get played together. Downloads ~4.5 MB once. ${soundAI.state === 'ready' ? `Ready · ${[...library.analysis.values()].filter((a) => a.ai?.v).length} songs heard.` : soundAI.state === 'error' ? `Couldn’t load: ${soundAI.err}` : soundAI.state === 'loading' ? 'Loading…' : ''}`)}
      ${button('reset-dj-brain', 'refresh', 'Forget what it learned', { sub: 'The DJ goes back to its own rules' })}
    `) : ''}
    ${group('Playing', html`
      ${toggle('skipFade', 'Fade when skipping', 'Off = the next song starts instantly when you press ⏭ / ⏮')}
      ${settings.get('skipFade') ? slider('skipFadeSec', 'Skip fade length', 0.3, 3, 0.1, 's') : ''}
      ${toggle('autoplay', 'Autoplay', 'When your queue ends, keep playing similar music')}
      ${seg('shuffleMode', 'Shuffle style', [['random', 'Random'], ['flow', 'BPM flow']], 'BPM flow orders shuffled songs so tempos change smoothly')}
      ${toggle('onlineLyrics', 'Online lyrics', 'Find synced lyrics (LRCLIB) when your files and Plex don’t have them')}
    `)}
    <details class="set-more">
      <summary><span>Fine-tuning</span><small>DJ effects, tempo, BPM detection, fades & more</small></summary>
      ${group('DJ', html`
        ${toggle('harmonicMix', 'Harmonic mixing', 'Long blends when keys agree, quick ones when they clash')}
        ${toggle('djEffects', 'DJ effects', 'Bass swaps, filter sweeps and echo outs (needs the Enhanced audio engine)')}
        ${toggle('beatMatch', 'Beat-matched mixing', 'Line mixes up on the beat when two songs have similar tempos')}
        ${toggle('dropAlign', 'Land the drop', 'The next song’s drop or chorus hits right as the old one finishes')}
        ${toggle('vocalAware', 'Keep vocals apart', 'Blends where only one song is singing (uses synced lyrics)')}
        ${toggle('vocalStrip', 'Cut vocals when they’d clash', 'The outgoing song drops its vocals and only its beat blends in')}
        ${seg('fadeCurve', 'Fade curve', [['equalpower', 'Equal power'], ['scurve', 'S-curve'], ['linear', 'Linear']])}
        ${toggle('gaplessAlbums', 'Gapless albums', 'Never mix between consecutive tracks of the same album')}
        ${toggle('skipSilence', 'Trim silence', 'Skip dead air at the start and end of songs')}
      `)}
      ${group('Tempo & BPM', html`
        ${toggle('tempoMatch', 'Tempo matching', 'Gently speed up or slow down the incoming song during the mix, then glide back')}
        ${slider('tempoMatchMax', 'Max tempo change', 1, 12, 1, '%', 'Small = you never notice it; songs further apart get a different kind of mix.')}
        ${seg('bpmDetect', 'BPM detection', [['auto', 'Automatic'], ['manual', 'On demand'], ['off', 'Off']])}
        ${toggle('onlineBpm', 'Look up BPM online', 'Checks each song’s tempo against Deezer once and saves it')}
        ${toggle('preferBpmTag', 'Prefer BPM tags', 'Use the BPM from your file tags when present')}
        ${seg('analysisNetwork', 'Analyze songs on', [['any', 'Any network'], ['wifi', 'Wi-Fi only']])}
      `)}
      ${group('More', html`
        ${toggle('pauseFade', 'Soft pause', 'Fade out/in on pause and play')}
        ${slider('prevRestarts', 'Previous restarts song after', 1, 10, 1, 's')}
        ${toggle('resumeSession', 'Resume where you left off')}
      `)}
    </details>
    <div class="bottom-pad"></div>`,
  };
}

function sound() {
  const preset = settings.get('eqPreset');
  const bands = preset === 'custom' ? settings.get('eqBands') : EQ_PRESETS[preset] || EQ_PRESETS.flat;
  return {
    title: 'Sound',
    html: html`${pageHeader('Sound & EQ', { back: true })}
    ${group('Volume leveling', html`
      ${seg('leveling', 'Leveling', [['smart', 'Smart'], ['track', 'Track'], ['album', 'Album'], ['off', 'Off']], 'Uses ReplayGain tags. Smart uses album gain when you play an album in order, track gain otherwise.')}
      ${slider('levelPreamp', 'Pre-amp', -12, 12, 0.5, ' dB')}
      ${toggle('autoLevel', 'Auto-level untagged songs', 'Measure loudness on-device for files without ReplayGain')}
      ${toggle('limiter', 'Prevent clipping', 'Soft limiter on the output')}
    `)}
    ${group('Equalizer', html`
      ${toggle('eqOn', 'Equalizer')}
      <button class="set-row link" data-a="eq-preset"><div class="set-text"><span>Preset</span></div><span class="set-value">${EQ_NAMES[preset]}</span>${icon('right', 'chev')}</button>
      <div class="eq${settings.get('eqOn') ? '' : ' off'}">
        ${EQ_FREQS.map((f, i) => html`<div class="eq-band">
          <span class="eq-db" data-eqv="${i}">${bands[i] > 0 ? '+' : ''}${bands[i]}</span>
          <input type="range" class="eq-slider" data-eq="${i}" min="-12" max="12" step="0.5" value="${bands[i]}" orient="vertical">
          <span class="eq-f">${f >= 1000 ? f / 1000 + 'k' : f}</span>
        </div>`)}
      </div>
    `)}
    ${group('Output', html`
      ${seg('engine', 'Audio engine', [['enhanced', 'Enhanced'], ['simple', 'Simple']], 'Enhanced enables EQ, leveling boost, limiter and sample-accurate fades. Simple uses the plain media player (try it if audio cuts out in the background). Takes effect after reopening the app.')}
      ${toggle('mono', 'Mono audio')}
      ${toggle('showVolume', 'Show volume slider in player')}
    `)}
    <div class="bottom-pad"></div>`,
    after(root) {
      root.addEventListener('input', (e) => {
        const s = e.target.closest('[data-eq]');
        if (!s) return;
        const cur = settings.get('eqPreset') === 'custom' ? [...settings.get('eqBands')] : [...(EQ_PRESETS[settings.get('eqPreset')] || EQ_PRESETS.flat)];
        cur[+s.dataset.eq] = +s.value;
        settings.set('eqBands', cur);
        if (settings.get('eqPreset') !== 'custom') settings.set('eqPreset', 'custom');
        if (!settings.get('eqOn')) settings.set('eqOn', true);
        root.querySelector(`[data-eqv="${s.dataset.eq}"]`).textContent = (s.value > 0 ? '+' : '') + s.value;
        const pv = root.querySelector('[data-a="eq-preset"] .set-value'); if (pv) pv.textContent = 'Custom';
        root.querySelector('.eq').classList.remove('off');
        const sw = root.querySelector('[data-set="eqOn"]'); if (sw) sw.checked = true;
      });
    },
  };
}

function libraryPage() {
  const total = library.size;
  const analyzed = [...library.tracks.values()].filter(isAnalyzed).length;
  return {
    title: 'Library',
    html: html`${pageHeader('Library', { back: true })}
    ${group('Your library', html`
      <div class="stats"><div><b>${total}</b><span>Songs</span></div><div><b>${library.albums.size}</b><span>Albums</span></div><div><b>${library.artists.size}</b><span>Artists</span></div><div><b>${analyzed}</b><span>Analyzed</span></div></div>
      ${button('rescan', 'refresh', 'Scan for new music', { sub: 'Only reads new or changed files' })}
      ${button('rescan-full', 'refresh', 'Full rescan', { sub: 'Re-read every file’s tags and artwork' })}
      ${button('analyze-all', 'bpm', 'Analyze whole library', { sub: 'Detect BPM, silences and loudness for every song and check each tempo online (downloads each file once — best on Wi-Fi)' })}
    `)}
    ${group('Organizing', html`
      ${seg('explicitPref', 'Explicit / clean albums', [['explicit', 'Explicit'], ['clean', 'Clean'], ['both', 'Show both']], 'When an album exists in both versions, show this one in your library, search, mixes and radio. Detected from tags, “(Clean)” / “[Explicit]” in names, and censored titles — even if Plex doesn’t label them. Album pages have a switch for the other version.')}
      ${toggle('groupCompilations', 'Group compilations', 'Albums tagged as compilations appear under “Various Artists”')}
      ${seg('albumSort', 'Sort albums by', [['added', 'Added'], ['title', 'Title'], ['artist', 'Artist'], ['year', 'Year']])}
      ${toggle('scanOnLaunch', 'Check for new music on launch')}
      ${text('artNames', 'Folder artwork names', 'Images in an album folder used when a file has no embedded art')}
      ${text('ignoreFolders', 'Ignore folders', 'Comma-separated folder names to skip')}
    `)}
    ${group('', html`${button('clear-library', 'trash', 'Clear library index', { danger: true, sub: 'Your files on the NAS are never touched' })}`)}
    <div class="bottom-pad"></div>`,
  };
}

function appearance() {
  const acc = settings.get('accent');
  const swatches = ['dynamic', '#fa2d48', '#1ed760', '#0a84ff', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff375f', '#ffd60a'];
  return {
    title: 'Appearance',
    html: html`${pageHeader('Appearance', { back: true })}
    ${group('Theme', html`
      ${seg('theme', 'Theme', [['dark', 'Dark'], ['oled', 'Black'], ['light', 'Light'], ['auto', 'Auto']])}
      <div class="set-row col"><div class="set-text"><span>Accent color</span><small>Dynamic picks a color from the current album art</small></div>
        <div class="swatches">${swatches.map((c) => html`<button class="swatch${acc === c ? ' on' : ''}${c === 'dynamic' ? ' dyn' : ''}" data-accent="${c}" style="${c !== 'dynamic' ? `background:${c}` : ''}" aria-label="${c}">${c === 'dynamic' ? icon('smart') : ''}</button>`)}</div></div>
      ${seg('npBackground', 'Player background', [['animated', 'Animated'], ['static', 'Artwork'], ['plain', 'Plain']])}
      ${toggle('artShrinkOnPause', 'Shrink artwork when paused')}
      ${toggle('reactiveArt', 'Reactive artwork', 'Artwork pulses gently with the beat')}
      ${seg('pulseMode', 'Pulse follows', [['bpm', 'BPM'], ['beat', 'Real beat'], ['both', 'Both']], 'BPM: a steady hit on every beat of the song’s tempo. Real beat: reacts to the kick drum you actually hear. Both: on the tempo, but only as hard as the drums are hitting — calm in quiet parts.')}
      ${seg('pulseAmount', 'Pulse strength', [['subtle', 'Subtle'], ['normal', 'Normal'], ['strong', 'Strong']])}
      ${toggle('artSwipe', 'Swipe artwork to skip', 'Swipe the album art left or right in the player')}
      ${seg('visualizer', 'Visualizer', [['bars', 'Spectrum'], ['off', 'Off']], 'Live frequency bars behind the player controls')}
      ${toggle('waveform', 'Waveform scrubber', 'Shows the song’s waveform with the DJ’s mix point and lyric cue marked')}
    `)}
    ${group('Library', html`
      ${seg('gridCols', 'Album grid', [[2, 'Large'], [3, 'Small']])}
      ${toggle('showBadges', 'Show quality badges', 'Lossless / Hi-Res Lossless')}
      ${toggle('showBpmRows', 'Show BPM & key on songs', 'Measured once and saved on this phone')}
      ${toggle('showBpm', 'Show BPM in player')}
      ${toggle('showNextTransition', 'Show upcoming transition', 'e.g. “Next: … · Beat-matched 124 BPM”')}
    `)}
    ${group('Computer & wide screens', html`
      ${seg('layoutMode', 'Layout', [['auto', 'Automatic'], ['desktop', 'Computer'], ['mobile', 'Phone']], 'Automatic picks the computer layout (sidebar + player column) in desktop browsers like Chrome, Brave, Edge and Safari')}
      ${seg('deskWidth', 'Content width', [['auto', 'Smart'], ['comfortable', 'Narrow'], ['wide', 'Wide'], ['full', 'Full']], 'Smart: album grids use the whole width, lists and settings stay at a readable width')}
      ${seg('deskFrame', 'Ultrawide monitors', [['full', 'Use full width'], ['centered', 'Centered frame']], 'Centered frame keeps the whole app in the middle 2560 px of very wide screens (like Samsung Odyssey)')}
      ${seg('deskPlayerW', 'Player column', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']])}
      ${toggle('dualSwap', 'Player on the left', 'Put the player column on the left side')}
      ${toggle('deskSidebar', 'Sidebar', 'Navigation on the left instead of tabs at the bottom')}
    `)}
    ${group('Device', html`
      ${seg('dualScreen', 'Dual-screen layout', [['auto', 'Split at hinge'], ['span', 'Span over hinge'], ['off', 'Off']], 'iPhone Duo, Surface Duo and other foldables: library on one side of the fold, player on the other. “Span over hinge” ignores the fold.')}
      <div class="set-row col"><div class="set-text"><span>Detected</span><small data-dual-info>${dualInfo.mode === 'single' ? 'Single screen right now — span the app across both screens to adjust' : `${dualInfo.device || 'Dual screen'} · split at ${typeof (dualInfo.leftW || dualInfo.topH) === 'string' ? 'the middle' : (+dualInfo.leftW || +dualInfo.topH || 0).toFixed(1) + 'px'} · hinge ${(+dualInfo.hinge).toFixed(1)}px`}</small></div></div>
      ${toggle('dualSwap', 'Swap sides', 'Put the player on the left (or on top when rotated) and the library on the other side')}
      ${slider('dualShift', 'Nudge split', -40, 40, 0.5, 'px', 'Move the split left/right (up/down when rotated) until it sits exactly on the hinge')}
      ${slider('dualHinge', 'Hinge gap', -1, 60, 0.5, 'px', '−1 = automatic (iPhone Duo has no gap; Surface Duo 34px, Duo 2 26.4px)')}
      ${toggle('haptics', 'Haptic feedback')}
    `)}
    <div class="bottom-pad"></div>`,
    after(root) {
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-accent]');
        if (!b) return;
        settings.set('accent', b.dataset.accent);
        $$('[data-accent]', root).forEach((x) => x.classList.toggle('on', x === b));
      });
    },
  };
}

async function storage() {
  let usage = 0, quota = 0;
  try { const e = await navigator.storage.estimate(); usage = e.usage || 0; quota = e.quota || 0; } catch (e) { /* */ }
  const dl = [...library.tracks.values()].filter((t) => library.isOffline(t));
  const dlSize = dl.reduce((s, t) => s + (t.size || 0), 0);
  const persisted = await navigator.storage?.persisted?.();
  return {
    title: 'Storage',
    html: html`${pageHeader('Downloads & Storage', { back: true })}
    ${group('', html`<a class="set-row link" href="#/downloads"><span class="set-ic" style="background:#30d158">${icon('downloaded')}</span><div class="set-text"><span>Manage downloads</span><small>See what’s saved, what it takes up, how it works — and remove it</small></div>${icon('right', 'chev')}</a>`)}
    ${group('Storage', html`
      <div class="stats"><div><b>${dl.length}</b><span>Downloaded</span></div><div><b>${fmtBytes(dlSize)}</b><span>Downloads</span></div><div><b>${fmtBytes(usage)}</b><span>Total used</span></div></div>
      <div class="meter"><i style="width:${quota ? Math.min(100, (usage / quota) * 100) : 0}%"></i></div>
      <p class="set-foot inline">${fmtBytes(quota)} available to this app${persisted ? ' · protected from automatic cleanup' : ''}</p>
      ${persisted ? '' : button('persist', 'check', 'Keep downloads safe', { sub: 'Ask the browser not to clear downloads when space is low' })}
    `)}
    ${group('Streaming', html`
      ${seg('prefetch', 'Preload next song', [['any', 'Always'], ['wifi', 'Wi-Fi only'], ['off', 'Never']], 'Loads the next song fully ahead of time for instant, glitch-free transitions')}
    `)}
    ${group('', html`
      ${button('clear-downloads', 'trash', 'Remove all downloads', { danger: true })}
      ${button('clear-preload', 'trash', 'Clear preloaded songs')}
      ${button('clear-covers', 'trash', 'Clear cover cache')}
      ${button('clear-analysis', 'trash', 'Clear song analysis', { sub: 'BPM, silences and loudness will be measured again' })}
    `)}
    ${group('Backup', html`
      ${button('export', 'download', 'Export settings, playlists, likes & BPM')}
      ${button('import', 'refresh', 'Import backup…')}
      ${button('reset-settings', 'refresh', 'Reset all settings', { danger: true })}
    `)}
    <div class="bottom-pad"></div>`,
  };
}

function extras() {
  return {
    title: 'Extras',
    html: html`${pageHeader('Extras', { back: true })}
    ${group('Gestures', html`
      ${toggle('likeBurst', 'Heart burst', 'A little burst of hearts when you like a song')}
      ${toggle('rowSwipe', 'Swipe songs', 'Swipe a song right to add it to the queue, left to add it to a playlist')}
      ${toggle('doubleTapSeek', 'Double-tap to jump', 'Double-tap the left or right side of the artwork to jump back or forward')}
      ${seg('seekStep', 'Jump length', [[10, '10s'], [15, '15s'], [30, '30s']])}
      ${toggle('artSwipe', 'Swipe artwork to skip', 'Swipe the album art left or right in the player')}
      ${toggle('miniPrev', 'Back button in mini player', 'Shows ⏮ next to play and skip at the bottom')}
    `)}
    ${group('Lock screen, CarPlay & headphones', html`
      ${seg('lockButtons', 'Side buttons', [['tracks', 'Skip songs'], ['seek', 'Jump in song']], 'What the ⏮ ⏭ buttons do outside the app')}
    `)}
    ${group('Player', html`
      ${toggle('autoLyrics', 'Open lyrics automatically', 'Shows time-synced lyrics as soon as a song that has them starts')}
      ${toggle('keepAwake', 'Keep screen on', 'While the player is open and music is playing')}
      ${toggle('smartResume', 'Smart resume', 'After a pause longer than 10 minutes, start 3 seconds earlier so you don’t lose your place')}
    `)}
    ${group('Friends', html`
      ${text('friendRelay', 'Message relay', 'Where encrypted chat messages pass through (ntfy). Default https://ntfy.sh keeps them a few hours. To use your own, run ntfy on your NAS (tiny) and put its https address here — your friends need the same one.')}
    `)}
    ${group('Car Mode', html`
      ${toggle('carButton', 'Car Mode in player menu', 'Huge buttons and big text for the road — the screen stays on')}
      ${toggle('carLyrics', 'Lyrics in Car Mode', 'Big, glanceable synced lyrics next to the controls')}
      ${button('car-mode', 'car', 'Open Car Mode now')}
    `)}
    <div class="bottom-pad"></div>`,
  };
}

function about() {
  return {
    title: 'About',
    html: html`${pageHeader('About', { back: true })}
    <div class="about">
      <div class="about-icon"><img src="./icons/icon-192.png" alt=""></div>
      <h2>Player</h2>
      <p>Version ${APP_VERSION}</p>
      <p class="dim">A music player that streams straight from your NAS. Everything — tags, artwork, BPM, transitions — happens on your phone.</p>
    </div>
    ${group('Help', html`
      <a class="set-row link" href="https://github.com/DSOGH/player#connect-your-nas" target="_blank" rel="noopener"><span class="set-ic">${icon('server')}</span><div class="set-text"><span>NAS setup guide</span></div>${icon('right', 'chev')}</a>
      <a class="set-row link" href="https://github.com/DSOGH/player#install-on-your-phone" target="_blank" rel="noopener"><span class="set-ic">${icon('plus')}</span><div class="set-text"><span>Add to Home Screen</span></div>${icon('right', 'chev')}</a>
      <a class="set-row link" href="https://github.com/DSOGH/player" target="_blank" rel="noopener"><span class="set-ic">${icon('info')}</span><div class="set-text"><span>Source code</span></div>${icon('right', 'chev')}</a>
      ${button('force-refresh', 'refresh', 'Refresh App', { sub: 'Loads the newest version — stays signed in' })}
      ${button('copy-diag', 'copy', 'Copy playback report', { sub: 'If music lags, freezes or skips: copy this and paste it in a message' })}
    `)}
    ${group('Tips', html`<div class="help">
      <p>• Swipe the mini player left/right to skip. Swipe the player down to close it.</p>
      <p>• Long-press any song for options.</p>
      <p>• Tap the transition button in the player to switch between Smart, Crossfade and Gapless.</p>
      <p>• Put a <code>.lrc</code> file next to a song (same name) for synced lyrics.</p>
      <p>• On Surface Duo, span the app across both screens for library + player side by side.</p>
    </div>`)}
    <div class="bottom-pad"></div>`,
  };
}

// ---------- shared binding for all settings pages ----------
export function bindSettings(root, rerender) {
  root.addEventListener('change', async (e) => {
    const sw = e.target.closest('[data-set]');
    if (sw) {
      const k = sw.dataset.set;
      if (k === '__demo') { rerender.demo(sw.checked); return; }
      settings.set(k, sw.checked);
      if (k === 'eqOn') root.querySelector('.eq')?.classList.toggle('off', !sw.checked);
      return;
    }
    const tx = e.target.closest('[data-text]');
    if (tx) settings.set(tx.dataset.text, tx.value.trim());
  });
  root.addEventListener('input', (e) => {
    const r = e.target.closest('[data-range]');
    if (!r) return;
    const k = r.dataset.range;
    const v = +r.value;
    settings.set(k, v);
    const lab = root.querySelector(`[data-val="${k}"]`);
    if (lab) lab.textContent = k === 'dualHinge' && v < 0 ? 'Auto' : fmtNum(v) + (r.dataset.unit || '');
    if (k === 'dualShift' || k === 'dualHinge') setTimeout(() => {
      const el = root.querySelector('[data-dual-info]');
      if (el && dualInfo.mode !== 'single') el.textContent = `${dualInfo.device || 'Dual screen'} · split at ${typeof (dualInfo.leftW || dualInfo.topH) === 'string' ? 'the middle' : (+dualInfo.leftW || +dualInfo.topH || 0).toFixed(1) + 'px'} · hinge ${(+dualInfo.hinge).toFixed(1)}px`;
    }, 50);
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg] button');
    if (!b) return;
    const k = b.closest('[data-seg]').dataset.seg;
    const raw = b.dataset.v;
    const v = typeof DEFAULTS[k] === 'number' ? +raw : raw;
    settings.set(k, v);
    $$('button', b.parentNode).forEach((x) => x.classList.toggle('on', x === b));
    if (k === 'transition' || k === 'djStyle' || k === 'cookLevel' || k === 'skipFade') rerender.page();
  });
}

export async function eqPresetSheet() {
  const cur = settings.get('eqPreset');
  const v = await actionSheet({ title: 'Equalizer preset', items: Object.keys(EQ_NAMES).map((k) => ({ label: EQ_NAMES[k], value: k, active: k === cur })) });
  if (!v) return false;
  settings.set('eqPreset', v);
  if (v !== 'flat' && !settings.get('eqOn')) settings.set('eqOn', true);
  return true;
}

export async function analyzeAll(onProgress) {
  const all = [...library.tracks.values()];
  const todo = all.filter((t) => !isAnalyzed(t) || !library.analysis.get(t.id)?.ochk);
  let done = 0;
  for (const t of todo) {
    if (analyzeAll.stop) break;
    if (isAnalyzed(t)) await verifyBpm(t); else await analyze(t, { force: true });
    done++;
    onProgress(done, todo.length);
  }
  analyzeAll.stop = false;
  return done;
}

export { confirmSheet, engine };
