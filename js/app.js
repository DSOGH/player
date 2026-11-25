// App bootstrap, router, global actions
import { $, $$, html, icon, debounce, nasUrl, fmtBytes } from './util.js';
import * as db from './db.js';
import { settings } from './settings.js';
import { library } from './library.js';
import { engine } from './engine.js';
import { scanner } from './scanner.js';
import { loadKnown, artColors, warmCovers } from './art.js';
import { installDemo, removeDemo } from './demo.js';
import { sprite } from './ui/icons.js';
import * as V from './ui/views.js';
import { settingsView, bindSettings, eqPresetSheet, analyzeAll, APP_VERSION } from './ui/settings-view.js';
import { initNowPlaying, openNP, closeNP, isOpen, openCarMode } from './ui/nowplaying.js';
import { initDual } from './ui/dual.js';
import { getList, actionSheet, prompt, toast, confirmSheet, haptic, art, closeSheet } from './ui/components.js';
import { plex } from './plex.js';
import { plexSignIn, plexSignOut, loadServers } from './ui/plex-view.js';
import { trackSrc } from './analysis.js';
import { optimizeOrder } from './dj.js';
import { statsView, setStatsRange } from './ui/stats-view.js';
import { friends } from './friends.js';
import { friendsView, chatView, acceptView, drafts } from './ui/friends-view.js';
import { accounts, writeMeta } from './accounts.js';
import { compareVersions } from './editions.js';
import { cloud } from './cloud.js';
import { showLogin, noteAccount, connectSheet, restoreSheet } from './ui/accounts-view.js';

const main = () => $('#main');
const view = () => $('#view');
const scrollMem = new Map();
let currentPath = null;
let searchQ = '';

// ---------- service worker ----------
async function ensureSW() {
  if (!('serviceWorker' in navigator)) throw new Error('This browser doesn’t support service workers.');
  const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }
  if (!navigator.serviceWorker.controller) {
    if (!sessionStorage.getItem('sw-reload')) { sessionStorage.setItem('sw-reload', '1'); location.reload(); await new Promise(() => {}); }
  }
  sessionStorage.removeItem('sw-reload');
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) {
        toast('Update ready', { action: { label: 'Reload', run: () => location.reload() }, ms: 8000 });
      }
    });
  });
  return reg;
}

// Get the newest version of the app without touching anything you've set up: sign-ins, library, playlists,
// downloads, covers and BPM all live in on-device storage that this never clears, and the home-screen icon stays.
async function forceRefresh() {
  toast('Getting the latest version…', { ms: 6000 });
  try { await engine.saveNow(); } catch (e) { /* */ }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    await Promise.race([reg?.update(), new Promise((r) => setTimeout(r, 5000))]);
    const w = reg?.installing || reg?.waiting;
    if (w) {
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
    }
    // drop only the cached app files (never music, covers or your data)
    for (const k of await caches.keys()) if (k.startsWith('shell-')) await caches.delete(k);
  } catch (e) { /* offline: just reload what we have */ }
  location.reload();
}

// ---------- theme ----------
function applyTheme() {
  let t = settings.get('theme');
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = t === 'light' ? '#f6f6f8' : t === 'oled' ? '#000000' : '#0e0e12';
  applyAccent(lastColors);
  document.documentElement.style.setProperty('--cols', settings.get('gridCols'));
}
let lastColors = null;
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}
function applyAccent(colors) {
  lastColors = colors;
  const a = settings.get('accent');
  const light = document.documentElement.dataset.theme === 'light';
  let c = a !== 'dynamic' ? a : '#fa2d48';
  if (a === 'dynamic' && colors) {
    const [h, s, l] = hexToHsl(colors[1]);
    if (s > 0.18) {
      const L = light ? Math.min(0.48, Math.max(0.36, l)) : Math.min(0.7, Math.max(0.56, l));
      c = `hsl(${Math.round(h)} ${Math.round(Math.max(0.55, s) * 100)}% ${Math.round(L * 100)}%)`;
    }
  }
  document.documentElement.style.setProperty('--accent', c);
}

// ---------- router ----------
function parseHash() {
  const h = (location.hash || '#/home').replace(/^#\/?/, '').replace(/\?np$/, '');
  return h || 'home';
}
async function route(path) {
  const [p, a, b] = path.split('/');
  switch (p) {
    case 'home': return V.home();
    case 'library': return a === 'downloaded' ? V.downloadsView({ tab: true }) : V.libraryView(a || 'albums');
    case 'downloads': return V.downloadsView();
    case 'album': checkAlbumEditions(a); return V.albumView(a);
    case 'artist': return V.artistView(a);
    case 'playlist': return V.playlistView(a);
    case 'liked': return V.likedView();
    case 'genre': return V.genreView(a);
    case 'mix': return V.mixView(a);
    case 'search': return V.searchView(searchQ);
    case 'settings': return settingsView(a || '');
    case 'stats': return statsView();
    case 'friends': return friendsView();
    case 'chat': return chatView(a);
    case 'friend': return acceptView(path.slice('friend/'.length));
    default: return V.home();
  }
}
const TAB_OF = { downloads: 'downloads', friends: 'friends', chat: 'friends', friend: 'friends', stats: 'stats', home: 'home', mix: 'home', library: 'library', album: 'library', artist: 'library', playlist: 'library', liked: 'library', genre: 'library', search: 'search', settings: 'settings' };

async function render({ keepScroll = false } = {}) {
  const path = parseHash();
  const changed = path !== currentPath;
  if (changed && currentPath) scrollMem.set(currentPath, main().scrollTop);
  const prevScroll = main().scrollTop;
  currentPath = path;
  const prevPath = lastShown;
  const res = await route(path);
  if (path !== currentPath) return; // navigated again meanwhile
  lastShown = path;
  // native-feeling page motion: push in from the right going deeper, slide back going up, cross-fade between tabs
  let nav = changed && !keepScroll && prevPath ? navDirection(prevPath, path) : null;
  if (swipeBack) { swipeBack = false; nav = null; } // the system swipe already showed the motion
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (nav && document.startViewTransition && !reduce && !document.hidden) {
    activeVT?.skipTransition?.();
    document.documentElement.dataset.nav = nav;
    activeVT = document.startViewTransition(() => paint(path, res, { keepScroll, changed, prevScroll }));
    activeVT.finished.finally(() => { activeVT = null; delete document.documentElement.dataset.nav; });
    try { await activeVT.updateCallbackDone; } catch (e) { /* */ }
    return;
  }
  paint(path, res, { keepScroll, changed, prevScroll, fade: nav && !reduce });
}
let lastShown = null, activeVT = null, appBack = 0, swipeBack = false;
// Back/forward that the phone already animated itself (iOS edge swipe): don't animate a second time.
// Only the app's own back button (or a link) gets our slide.
let histSeq = 0;
addEventListener('popstate', (e) => {
  const traversal = e.state && e.state.vi != null; // going back/forward through history (new links have no state yet)
  swipeBack = !!(traversal && (e.hasUAVisualTransition || performance.now() - appBack > 600));
});
function tagHistory() {
  try { if (!history.state || history.state.vi == null) history.replaceState({ ...(history.state || {}), vi: ++histSeq }, ''); } catch (e) { /* */ }
}
function navDirection(from, to) {
  const a = from.split('/').filter(Boolean), b = to.split('/').filter(Boolean);
  const tabA = TAB_OF[a[0]] || 'home', tabB = TAB_OF[b[0]] || 'home';
  if (tabA !== tabB && b.length <= 2 && (b.length === 1 || b[0] === 'library')) return 'tab';
  const depth = (x) => (x[0] === 'library' ? x.length - 1 : x.length);
  if (to.startsWith(from + '/') || depth(b) > depth(a)) return 'fwd';
  if (from.startsWith(to + '/') || depth(b) < depth(a)) return 'back';
  return navStack.at(-2) === to ? 'back' : 'fwd';
}
const navStack = [];
function paint(path, res, { keepScroll, changed, prevScroll, fade = false }) {
  tagHistory();
  if (navStack.at(-2) === path) navStack.pop(); else if (navStack.at(-1) !== path) navStack.push(path);
  if (navStack.length > 30) navStack.shift();
  const v = view();
  const search = path === 'search';
  v.innerHTML = (search ? searchHeader() : '') + String(res.html);
  v.dataset.page = path.split('/')[0];
  if (!engine.track) document.title = res.title ? `${res.title} · Player` : 'Player';
  res.after?.(v);
  if (path.startsWith('settings')) bindSettings(v, { page: () => render({ keepScroll: true }), demo: toggleDemo });
  V.hydrateLazy(v);
  if (search) wireSearch(v);
  const tint = v.querySelector('[data-tint]');
  v.style.removeProperty('--tint');
  if (tint?.dataset.tint) artColors(tint.dataset.tint).then((c) => { if (c && currentPath === path) v.style.setProperty('--tint', c[1]); });
  const tab = TAB_OF[path.split('/')[0]] || 'home';
  $$('#tabs a').forEach((t) => {
    const on = t.dataset.tab === tab;
    if (on && !t.classList.contains('on')) t.querySelector('.tab-ic')?.animate?.([{ transform: 'scale(.78)' }, { transform: 'scale(1.12)', offset: 0.55 }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.3,1.4,.5,1)' });
    t.classList.toggle('on', on);
    t.querySelector('.tab-ic').innerHTML = icon(on && t.dataset.fill ? t.dataset.fill : t.dataset.icon);
  });
  if (keepScroll) main().scrollTop = prevScroll;
  else main().scrollTop = changed ? (scrollMem.get(path) || 0) : prevScroll;
  if (fade) v.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
  // content cascades in (Apple Music-style) on a new page
  if (changed && !keepScroll && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
    clearTimeout(v._enterT); v._enterT = setTimeout(() => v.classList.remove('enter'), 900);
  }
  onScroll();
}
const rerender = debounce(() => {
  // don't wipe forms the user is typing in
  if (currentPath === 'settings/source' || document.activeElement?.matches('input.text-input')) return;
  render({ keepScroll: true });
}, 600);

function searchHeader() {
  return html`<header class="page-head search-head"><h1 class="large-title">Search</h1></header>
  <div class="search-bar">${icon('search')}<input type="search" id="q" placeholder="Artists, songs, albums" value="${searchQ}" autocomplete="off" enterkeyhint="search">${searchQ ? html`<button class="icon-btn clear-q" data-a="clear-q">${icon('x')}</button>` : ''}</div>`.toString();
}
function wireSearch(v) {
  const q = $('#q', v);
  const run = debounce(async () => {
    searchQ = q.value;
    const res = V.searchView(searchQ);
    const box = $('[data-search-results]', v);
    const tmp = document.createElement('div');
    tmp.innerHTML = String(res.html);
    box.replaceWith(tmp.firstElementChild);
    V.hydrateLazy(v);
    const cl = $('.clear-q', v);
    if (searchQ && !cl) q.insertAdjacentHTML('afterend', html`<button class="icon-btn clear-q" data-a="clear-q">${icon('x')}</button>`.toString());
    else if (!searchQ && cl) cl.remove();
  }, 120);
  q.addEventListener('input', run);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { library.addRecentSearch(q.value); q.blur(); } });
  if (!searchQ && !matchMedia('(pointer: coarse)').matches) q.focus();
}

function onScroll() {
  const s = main().scrollTop;
  document.body.classList.toggle('scrolled', s > 30);
}

// ---------- downloads ----------
async function usedBytes() { try { return (await navigator.storage.estimate()).usage || 0; } catch (e) { return 0; } }
let downloading = false;
async function toggleDownload(tracks) {
  tracks = tracks.filter((t) => !t.demo);
  if (!tracks.length) { toast('Demo songs don’t need downloading'); return; }
  const all = tracks.every((t) => library.isOffline(t));
  const c = await caches.open('offline-tracks');
  if (all) {
    for (const t of tracks) await c.delete(library.cacheKey(t));
    navigator.serviceWorker?.controller?.postMessage({ type: 'cache-changed' });
    await library.refreshOffline();
    toast(`Removed ${tracks.length} download${tracks.length > 1 ? 's' : ''}`);
    rerender();
    return;
  }
  if (downloading) { toast('A download is already running'); return; }
  downloading = true;
  try { await navigator.storage?.persist?.(); } catch (e) { /* */ }
  const todo = tracks.filter((t) => !library.isOffline(t));
  let done = 0, bytes = 0;
  toast(`Downloading ${todo.length} song${todo.length > 1 ? 's' : ''}…`, { ms: 4000 });
  for (const t of todo) {
    try {
      const pre = await (await caches.open('prefetch')).match(library.cacheKey(t));
      const r = pre || await fetch(trackSrc(t));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      await c.put(library.cacheKey(t), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }));
      library.offline.add(library.cacheKey(t));
      navigator.serviceWorker?.controller?.postMessage({ type: 'cache-changed' });
      done++; bytes += blob.size;
      toast(`Downloading… ${done}/${todo.length}`, { ms: 4000 });
    } catch (e) {
      toast(e.name === 'QuotaExceededError' ? 'Out of storage space' : `Couldn’t download “${t.title}”`);
      if (e.name === 'QuotaExceededError') break;
    }
  }
  downloading = false;
  toast(`Downloaded ${done} song${done === 1 ? '' : 's'} · ${fmtBytes(bytes)}`);
  rerender();
}

// ---------- DJ sets ----------
let djBusy = false;
async function djSet(tracks, { first = null, context = null, mode = 'play' } = {}) {
  tracks = tracks.filter(Boolean);
  if (tracks.length < 2) { toast('Need at least 2 songs'); return; }
  if (djBusy) { toast('Already building a DJ set…'); return; }
  djBusy = true;
  const style = settings.get('djStyle');
  toast(`Building your DJ set from ${tracks.length} songs…`, { ms: 4000 });
  try {
    const { order, stats } = await optimizeOrder(tracks.slice(0, 200), {
      first, mode: style,
      onProgress: (n, total, label) => toast(`${label}… ${n}/${total}`, { ms: 4000 }),
    });
    if (mode === 'queue') engine.setUpNext(order.slice(1));
    else engine.playTracks(order, 0, { context: { ...(context || {}), name: `${context?.name || 'DJ Set'} · DJ order` } });
    const parts = [`${stats.harmonic}/${stats.transitions} harmonic`];
    if (style !== 'beats') parts.push(`${stats.wordplay} word play`);
    parts.push(`avg tempo change ${stats.avgTempoJump.toFixed(1)}%`);
    toast(`DJ order ready · ${parts.join(' · ')}`, { ms: 7000 });
  } catch (e) {
    toast('Couldn\u2019t build the DJ set');
  } finally { djBusy = false; }
}
function djOrderQueue() {
  const up = engine.upNext().slice(0, 150);
  djSet([engine.track, ...up], { first: engine.track, mode: 'queue' });
}

// ---------- playlists ----------
async function addToPlaylist(tracks) {
  const pls = [...library.playlists.values()].filter((p) => !p.source).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const v = await actionSheet({
    title: 'Add to Playlist',
    items: [{ icon: 'plus', label: 'New Playlist…', value: '__new' }, ...pls.map((p) => ({ icon: 'playlist', label: p.name, value: p.id, sub: `${p.trackIds.length} songs` }))],
  });
  if (!v) return;
  let p;
  if (v === '__new') {
    const name = await prompt({ title: 'New Playlist', placeholder: 'Playlist name', ok: 'Create' });
    if (!name) return;
    p = await library.createPlaylist(name, []);
  } else p = library.playlists.get(v);
  const ids = tracks.map((t) => t.id).filter((id) => !p.trackIds.includes(id));
  p.trackIds.push(...ids);
  await library.savePlaylist(p);
  toast(`Added to “${p.name}”`);
}

// ---------- menus ----------
async function trackMenu(t, ctx = {}) {
  const liked = library.likes.has(t.id);
  const off = library.isOffline(t);
  const items = [
    { icon: 'play-next', label: 'Play Next', value: 'next' },
    { icon: 'add-queue', label: 'Add to Queue', value: 'queue' },
    ...(friends.list.length ? [{ icon: 'friends', label: 'Send to Friend…', value: 'send' }] : []),
    { icon: 'add-playlist', label: 'Add to Playlist…', value: 'playlist' },
    { icon: liked ? 'heart-fill' : 'heart', label: liked ? 'Unlike' : 'Like', value: 'like' },
    { icon: off ? 'downloaded' : 'download', label: off ? 'Remove Download' : 'Download', value: 'download' },
    { sep: true },
    { icon: 'album', label: 'Go to Album', value: 'album' },
    { icon: 'artist', label: 'Go to Artist', value: 'artist' },
    { icon: 'mix', label: 'Start Radio', value: 'radio', sub: 'Similar genre, artist & tempo' },
  ];
  if (ctx.playlist && !library.playlists.get(ctx.playlist)?.source) items.push({ icon: 'trash', label: 'Remove from Playlist', value: 'rmpl', danger: true });
  const v = await actionSheet({ header: html`<div class="sheet-track">${art(t.artId, 'sm')}<div><b>${t.title}</b><span>${t.artist} · ${t.album}</span></div></div>`, items });
  switch (v) {
    case 'next': engine.playNext([t]); toast('Playing next'); break;
    case 'queue': engine.addToQueue([t]); toast('Added to queue'); break;
    case 'send': {
      const fv = await actionSheet({ header: html`<div class="sheet-track"><div><b>Send “${t.title}”</b><span>to a friend</span></div></div>`, items: friends.list.map((f) => ({ icon: 'friends', label: friends.nameOf(f), value: f.id })) });
      const f = fv && friends.friend(fv);
      if (!f) break;
      const at = engine.track?.id === t.id && engine.currentTime > 3 ? engine.currentTime : 0;
      friends.sendSong(f, t, at);
      toast(`Sent to ${friends.nameOf(f)}${at ? ` from ${fmtTimeShort(at)}` : ''}`);
      break;
    }
    case 'playlist': addToPlaylist([t]); break;
    case 'like': library.toggleLike(t.id); rerender(); break;
    case 'download': toggleDownload([t]); break;
    case 'album': closeNP(); location.hash = `#/album/${t.albumId}`; break;
    case 'artist': closeNP(); location.hash = `#/artist/${t.artistId}`; break;
    case 'radio': engine.playTracks([t, ...library.radioFrom(t, new Set([t.id]), 40)], 0, { context: { type: 'radio', name: `${t.title} Radio` } }); break;
    case 'rmpl': {
      const p = library.playlists.get(ctx.playlist);
      if (p) { const i = p.trackIds.indexOf(t.id); if (i >= 0) p.trackIds.splice(i, 1); await library.savePlaylist(p); render({ keepScroll: true }); }
      break;
    }
    default: break;
  }
}
async function albumMenu(a) {
  const off = a.tracks.every((t) => library.isOffline(t));
  const v = await actionSheet({
    header: html`<div class="sheet-track">${art(a.artId, 'sm')}<div><b>${a.title}</b><span>${a.artist}</span></div></div>`,
    items: [
      { icon: 'play-next', label: 'Play Next', value: 'next' },
      { icon: 'add-queue', label: 'Add to Queue', value: 'queue' },
      { icon: 'add-playlist', label: 'Add to Playlist…', value: 'playlist' },
      { icon: off ? 'downloaded' : 'download', label: off ? 'Remove Download' : 'Download Album', value: 'download' },
      { icon: 'artist', label: 'Go to Artist', value: 'artist' },
      { icon: 'mix', label: 'Play as DJ Set', value: 'djset', sub: 'Reorder by tempo, key & energy' },
      { icon: 'bpm', label: 'Analyze Album', value: 'analyze', sub: 'BPM, key, silences, loudness' },
      { sep: true },
      { icon: 'info', label: a.edition === 'clean' ? 'Marked: Clean version' : a.edition === 'explicit' ? 'Marked: Explicit version' : 'Clean or Explicit?', value: 'edition', sub: library.editionSet?.[a.id] ? 'Set by you — tap to change' : 'Tap to set it yourself if it’s wrong' },
    ],
  });
  if (v === 'next') { engine.playNext(a.tracks); toast('Playing next'); }
  if (v === 'queue') { engine.addToQueue(a.tracks); toast('Added to queue'); }
  if (v === 'playlist') addToPlaylist(a.tracks);
  if (v === 'download') toggleDownload(a.tracks);
  if (v === 'artist') location.hash = `#/artist/${a.artistId}`;
  if (v === 'djset') djSet(a.tracks, { context: { type: 'album', id: a.id, name: a.title } });
  if (v === 'edition') {
    const e = await actionSheet({ header: html`<div class="sheet-track"><div><b>${a.title}</b><span>Which version is this?</span></div></div>`, items: [
      { icon: 'info', label: 'Explicit', value: 'explicit' },
      { icon: 'info', label: 'Clean', value: 'clean' },
      { icon: 'refresh', label: 'Work it out automatically', value: 'auto' },
    ] });
    if (e) {
      await library.setEdition(a.id, e === 'auto' ? null : e);
      // the other version of this album is the opposite
      const other = a.editions?.find((x) => x.id !== a.id);
      if (other && e !== 'auto') await library.setEdition(other.id, e === 'clean' ? 'explicit' : 'clean');
      if (other && e === 'auto') await library.setEdition(other.id, null);
      toast(e === 'auto' ? 'Back to automatic' : `Marked as ${e}`);
      rerender();
    }
  }
  if (v === 'analyze') {
    const { analyze } = await import('./analysis.js');
    toast(`Analyzing ${a.tracks.length} songs…`);
    for (const t of a.tracks) await analyze(t, { force: true });
    toast('Album analyzed');
    rerender();
  }
}
async function playlistMenu(p) {
  const tracks = library.playlistTracks(p);
  const v = await actionSheet({
    title: p.name,
    items: [
      { icon: 'mix', label: 'Play as DJ Set', value: 'djset', sub: 'Reorder by tempo, key, energy & lyrics' },
      { icon: 'play-next', label: 'Play Next', value: 'next' },
      { icon: 'add-queue', label: 'Add to Queue', value: 'queue' },
      { icon: 'download', label: 'Download / Remove Download', value: 'download' },
      ...(p.source ? [{ icon: 'add-playlist', label: 'Copy to New Playlist', value: 'copy' }] : [
        { icon: 'edit', label: 'Rename', value: 'rename' },
        { icon: 'trash', label: 'Delete Playlist', value: 'delete', danger: true }]),
    ],
  });
  if (v === 'next') engine.playNext(tracks);
  if (v === 'queue') engine.addToQueue(tracks);
  if (v === 'download') toggleDownload(tracks);
  if (v === 'djset') djSet(tracks, { context: { type: 'playlist', id: p.id, name: p.name } });
  if (v === 'copy') {
    const np = await library.createPlaylist(`${p.name} (copy)`, [...p.trackIds]);
    location.hash = `#/playlist/${np.id}`;
  }
  if (v === 'rename') {
    const name = await prompt({ title: 'Rename Playlist', value: p.name });
    if (name) { p.name = name; await library.savePlaylist(p); render({ keepScroll: true }); }
  }
  if (v === 'delete' && await confirmSheet(`Delete “${p.name}”?`, 'Delete Playlist', true)) {
    await library.deletePlaylist(p.id);
    history.back();
  }
}

// ---------- demo ----------
async function toggleDemo(on) {
  if (on) {
    toast('Building demo library…');
    await installDemo();
    await loadKnown();
  } else {
    if (engine.track?.demo) { engine.pause(); }
    await removeDemo();
  }
  await library.reloadTracks();
  toast(on ? 'Demo library ready' : 'Demo library removed');
  if (on && parseHash() !== 'home') location.hash = '#/home';
  else render({ keepScroll: true });
}

const fmtTimeShort = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
// ---------- global actions ----------
async function doAction(a, el, e) {
  const d = el.dataset;
  switch (a) {
    case 'play-list': {
      const L = getList(d.list);
      if (!L) return;
      const tracks = L.ids.map((id) => library.track(id)).filter(Boolean);
      engine.playTracks(tracks, +d.i, { context: L.context });
      haptic();
      break;
    }
    case 'play-all': case 'shuffle-all': {
      const L = getList(d.list);
      if (!L) return;
      const tracks = L.ids.map((id) => library.track(id)).filter(Boolean);
      engine.playTracks(tracks, a === 'shuffle-all' ? -1 : 0, { context: L.context, shuffle: a === 'shuffle-all' ? true : false });
      if (a === 'shuffle-all') engine.shuffle = true;
      haptic();
      break;
    }
    case 'track-menu': {
      e.stopPropagation();
      const t = library.track(d.tid);
      const pl = currentPath.startsWith('playlist/') ? currentPath.split('/')[1] : null;
      if (t) trackMenu(t, { playlist: pl });
      break;
    }
    case 'dj-list': {
      const L = getList(d.list);
      if (L) djSet(L.ids.map((id) => library.track(id)), { context: L.context });
      break;
    }
    case 'album-menu': { const al = library.album(d.id); if (al) albumMenu(al); break; }
    case 'playlist-menu': { const p = library.playlists.get(d.id); if (p) playlistMenu(p); break; }
    case 'download-album': { const al = library.album(d.id); if (al) toggleDownload(al.tracks); break; }
    case 'new-playlist': {
      const name = await prompt({ title: 'New Playlist', placeholder: 'Playlist name', ok: 'Create' });
      if (name) { const p = await library.createPlaylist(name); location.hash = `#/playlist/${p.id}`; }
      break;
    }
    case 'album-sort': {
      const cur = settings.get('albumSort');
      const v = await actionSheet({ title: 'Sort albums by', items: [['added', 'Recently Added'], ['title', 'Title'], ['artist', 'Artist'], ['year', 'Year']].map(([k, l]) => ({ label: l, value: k, active: k === cur })) });
      if (v) { settings.set('albumSort', v); render({ keepScroll: false }); }
      break;
    }
    case 'demo': await toggleDemo(true); break;
    case 'plex-signin': plexSignIn(); break;
    case 'cook-it-up': {
      if (!engine.cookItUp()) { toast('Add some music first'); break; }
      haptic(25); toast('🔥 DJ Cook It Up — your whole library, wild transitions', { ms: 3500 });
      if (settings.get('engine') !== 'enhanced' && /iPhone|iPad/.test(navigator.userAgent)) toast('Tip: turn on Enhanced audio for the full effects on iPhone', { ms: 5000 });
      break;
    }
    case 'toggle-ask': accounts.ask = !accounts.ask; toast(accounts.ask ? 'The app will ask who’s listening when it opens' : 'The app opens straight into your last account'); render({ keepScroll: true }); break;
    case 'cloud-remove': {
      const name = el.dataset.name || 'this account';
      if (!(await confirmSheet(`Remove “${name}” from the cloud? It stays on any device that has it (and is saved again from there).`, 'Remove', true))) break;
      try { await cloud.removeProfile(el.dataset.cid); toast(`Removed ${name} from the cloud`); } catch (e) { toast('Couldn’t remove it: ' + (e.message || 'error')); }
      render({ keepScroll: true });
      break;
    }
    case 'cloud-save': {
      toast('Syncing…'); cloud.firstOk = true;
      const r = await cloud.syncNow();
      toast(cloud.state.error ? `Couldn’t sync: ${cloud.state.error}` : r ? 'Synced with your other devices' : 'Saved'); render({ keepScroll: true });
      break;
    }
    case 'cloud-restore': {
      const r = await cloud.fetchRemote();
      if (!cloud.listProfiles(r).length) { toast('Nothing saved in the cloud yet'); break; }
      offerRestore(r, { manual: true });
      break;
    }
    case 'cloud-github': {
      const tok = await prompt({ title: 'GitHub token', placeholder: 'github_pat_… (Gists: read & write) — empty to remove', value: cloud.ghToken ? '••••••' : '', ok: 'Save' });
      if (tok == null || tok === '••••••') break;
      try {
        await cloud.setGithub(tok); cloud.firstOk = true;
        if (tok.trim()) { const r = await cloud.fetchRemote().catch(() => null); toast('GitHub connected'); if (cloud.listProfiles(r).length && !cloud.state.at) offerRestore(r); else cloud.push(); }
        else toast('GitHub backup removed');
      } catch (e) { toast(e.message || 'GitHub didn’t accept that token'); await cloud.setGithub('').catch(() => {}); }
      render({ keepScroll: true });
      break;
    }
    case 'accounts': try { await engine.saveNow(); } catch (e) { /* */ } showLogin(); break;
    case 'add-account': try { await engine.saveNow(); } catch (e) { /* */ } showLogin().then(() => document.querySelector('#login [data-l="add"]')?.click()); break;
    case 'lock-account': {
      try { await engine.saveNow(); library.saveLog(); } catch (e) { /* */ }
      accounts.lock(); sessionStorage.removeItem('picked'); location.reload();
      break;
    }
    case 'plex-signout': await plexSignOut(() => render({ keepScroll: false })); break;
    case 'plex-servers': loadServers(view()); break;
    case 'plex-sync': if (!plex.running) { plex.sync(); toast('Syncing with Plex…'); render({ keepScroll: true }); } break;
    case 'back': appBack = performance.now(); if (history.length > 1) history.back(); else location.hash = '#/home'; break;
    case 'search-q': searchQ = d.q; render({ keepScroll: false }); break;
    case 'clear-q': searchQ = ''; render({ keepScroll: false }); break;
    case 'clear-recent': library.recentSearches = []; db.kv.set('recentSearches', []); render({ keepScroll: true }); break;
    case 'remix': V.refreshMix(d.id); render({ keepScroll: true }); break;
    case 'rescan': case 'rescan-full': {
      const src = await db.kv.get('source');
      if (!src?.url) { location.hash = '#/settings/source'; toast('Connect your NAS first'); break; }
      scanner.run({ full: a === 'rescan-full' });
      toast(a === 'rescan-full' ? 'Full rescan started' : 'Looking for new music…');
      if (!currentPath.startsWith('settings')) render({ keepScroll: true });
      break;
    }
    case 'analyze-all': {
      if (analyzeAll.running) { analyzeAll.stop = true; toast('Stopping analysis…'); break; }
      analyzeAll.running = true;
      toast('Analyzing your library in the background…');
      await analyzeAll((n, total) => { if (n % 5 === 0 || n === total) toast(`Analyzed ${n} of ${total} songs`, { ms: 2000 }); });
      analyzeAll.running = false;
      toast('Library analysis finished');
      break;
    }
    case 'clear-library':
      if (await confirmSheet('Clear the library index? You can rescan any time.', 'Clear Library', true)) {
        engine.pause();
        await db.clear('tracks');
        await library.reloadTracks();
        toast('Library cleared');
        render({ keepScroll: true });
      }
      break;
    case 'persist': {
      const ok = await navigator.storage?.persist?.();
      toast(ok ? 'Downloads are protected' : 'The browser declined — installing the app to your home screen usually allows it');
      render({ keepScroll: true });
      break;
    }
    case 'clear-downloads': {
      const n = library.offline.size;
      if (!n) { toast('Nothing is downloaded'); break; }
      if (await confirmSheet(`Remove all ${n} downloaded song${n > 1 ? 's' : ''} from this device? They stay in your library and stream again.`, 'Remove Downloads', true)) {
        const before = await usedBytes();
        // really delete the files (not just hide them): the whole cache goes, plus the preloaded copies
        await caches.delete('offline-tracks'); await caches.delete('prefetch');
        navigator.serviceWorker?.controller?.postMessage({ type: 'cache-changed' });
        await library.refreshOffline();
        const freed = Math.max(0, before - await usedBytes());
        toast(freed > 1e6 ? `Downloads removed · ${fmtBytes(freed)} freed` : 'Downloads removed · space frees up in a moment'); render({ keepScroll: true });
      }
      break;
    }
    case 'dl-remove': {
      const ts = (el.dataset.ids || '').split(',').map((id) => library.track(id)).filter((t) => t && library.isOffline(t));
      if (ts.length) { haptic(10); await toggleDownload(ts); }
      break;
    }
    case 'clear-preload': case 'clear-cache': await caches.delete('prefetch'); navigator.serviceWorker?.controller?.postMessage({ type: 'cache-changed' }); toast('Preloaded songs cleared'); render({ keepScroll: true }); break;
    case 'clear-covers': await caches.delete('plexart-v1'); toast('Cover cache cleared'); render({ keepScroll: true }); break;
    case 'clear-analysis':
      if (await confirmSheet('Clear BPM & transition analysis for all songs?', 'Clear Analysis', true)) {
        await db.clear('analysis'); library.analysis.clear(); toast('Analysis cleared');
      }
      break;
    case 'export': {
      const data = {
        app: 'player', version: APP_VERSION, exported: new Date().toISOString(),
        settings: settings.v, playlists: [...library.playlists.values()].filter((p) => p.source !== 'nas'),
        likes: [...library.likes].map((id) => library.track(id)?.url).filter(Boolean),
        playlistUrls: Object.fromEntries([...library.playlists.values()].map((p) => [p.id, p.trackIds.map((id) => library.track(id)?.url).filter(Boolean)])),
        // measured BPM / key / beat grids, so a new phone doesn't have to analyse everything again
        analysis: [...library.analysis.values()].map((a) => { const u = library.track(a.id)?.url; if (!u) return null; const { waveform, ...rest } = a; return { ...rest, url: u, waveform: waveform ? Array.from(waveform) : undefined }; }).filter(Boolean),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const aEl = document.createElement('a');
      aEl.href = URL.createObjectURL(blob);
      aEl.download = `player-backup-${new Date().toISOString().slice(0, 10)}.json`;
      aEl.click();
      setTimeout(() => URL.revokeObjectURL(aEl.href), 2000);
      break;
    }
    case 'import': {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'application/json,.json';
      inp.onchange = async () => {
        try {
          const data = JSON.parse(await inp.files[0].text());
          const byUrl = new Map([...library.tracks.values()].map((t) => [t.url, t.id]));
          if (data.settings) { for (const [k, v] of Object.entries(data.settings)) settings.set(k, v); }
          if (data.likes) { data.likes.forEach((u) => { const id = byUrl.get(u); if (id) library.likes.add(id); }); db.kv.set('likes', [...library.likes]); }
          let nA = 0;
          for (const a of data.analysis || []) {
            const id = byUrl.get(a.url);
            if (!id) continue;
            const { url, ...rest } = a;
            const cur = library.analysis.get(id);
            if (cur && !rest.tapped && (cur.v || 0) >= (rest.v || 0)) continue;
            library.setAnalysis({ ...rest, id }); nA++;
          }
          if (nA) toast(`Restored BPM & key for ${nA} songs`);
          for (const p of data.playlists || []) {
            const urls = data.playlistUrls?.[p.id];
            if (urls) p.trackIds = urls.map((u) => byUrl.get(u)).filter(Boolean);
            await library.savePlaylist(p);
          }
          toast('Backup imported');
          applyTheme();
          render({ keepScroll: true });
        } catch (err) { toast('That file isn’t a valid backup'); }
      };
      inp.click();
      break;
    }
    case 'reset-settings':
      if (await confirmSheet('Reset all settings to defaults?', 'Reset', true)) { settings.reset(); applyTheme(); render({ keepScroll: true }); toast('Settings reset'); }
      break;
    case 'check-update': {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
      toast(reg?.installing || reg?.waiting ? 'Updating…' : 'You’re on the latest version');
      break;
    }
    case 'force-refresh': await forceRefresh(); break;
    case 'fr-setup': {
      const n = document.querySelector('#fr-name')?.value.trim();
      await friends.setup(n || plex.user?.name || 'Me');
      render({ keepScroll: true });
      break;
    }
    case 'fr-share': case 'fr-add': {
      const { code, link } = await friends.createInvite();
      const text = `Add me on Player 🎧 ${link}`;
      if (navigator.share) { try { await navigator.share({ title: 'Player', text: 'Add me on Player 🎧', url: link }); break; } catch (er) { if (er.name === 'AbortError') break; } }
      try { await navigator.clipboard.writeText(text); toast('Invite link copied — paste it to a friend'); } catch (er) { await prompt({ title: 'Your friend code', value: code, ok: 'Done' }); }
      break;
    }
    case 'fr-enter': {
      const code = await prompt({ title: 'Enter a friend code', placeholder: 'Paste the code or link', ok: 'Add' });
      if (!code) break;
      try { const f = await friends.acceptInvite(code); toast(`You and ${friends.nameOf(f)} are now friends`); location.hash = `#/chat/${f.id}`; } catch (er) { toast(er.message); }
      break;
    }
    case 'fr-accept': {
      if (!friends.ready) await friends.setup(plex.user?.name || 'Me');
      try { const f = await friends.acceptInvite(d.code); toast(`You and ${friends.nameOf(f)} are now friends`); location.replace(`#/chat/${f.id}`); } catch (er) { toast(er.message); }
      break;
    }
    case 'fr-notify': {
      if (friends.pushOn) { await friends.disablePush(); settings.set('friendNotify', false); toast('Message notifications off'); render({ keepScroll: true }); break; }
      if (!('Notification' in window)) { toast('Add Player to your Home Screen first — iPhone only allows notifications for home-screen apps'); break; }
      // must be the first thing after the tap, or iPhone won't show the Allow prompt
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications are blocked — turn them on in iPhone Settings → Notifications → Player'); render({ keepScroll: true }); break; }
      settings.set('friendNotify', true);
      try {
        await friends.enablePush();
        toast('Message notifications on — even when Player is closed');
      } catch (er) {
        console.warn('push', er);
        toast(er.message === 'relay-no-push' ? 'Your message relay doesn’t support push — notifications only while Player is open' : `Couldn’t turn on push: ${er.message || er}`, { ms: 9000 });
      }
      render({ keepScroll: true });
      break;
    }
    case 'fr-copy': try { await navigator.clipboard.writeText(d.code); toast('Code copied'); } catch (er) { await prompt({ title: 'Friend code', value: d.code, ok: 'Done' }); } break;
    case 'fr-rename': {
      const n = await prompt({ title: 'Your name', value: friends.me.name, ok: 'Save' });
      if (n) { await friends.setup(n); render({ keepScroll: true }); }
      break;
    }
    case 'fr-menu': {
      const f = friends.friend(d.fid);
      if (!f) break;
      const v = await actionSheet({ header: html`<div class="sheet-track"><div><b>${friends.nameOf(f)}</b><span>${f.nick ? `Calls themselves ${f.name}` : 'Friend'}</span></div></div>`, items: [
        { icon: 'edit', label: 'Rename', value: 'rename' },
        { icon: 'trash', label: 'Remove Friend', value: 'remove', danger: true },
      ] });
      if (v === 'rename') {
        const n = await prompt({ title: `Name for ${f.name}`, value: friends.nameOf(f), placeholder: f.name, ok: 'Save' });
        if (n !== null && n !== undefined) { await friends.rename(f.id, n === f.name ? '' : n); toast('Saved'); render({ keepScroll: true }); }
      }
      if (v === 'remove' && await confirmSheet(`Remove ${friends.nameOf(f)}? Your chat is deleted from this phone.`, 'Remove', true)) { await friends.remove(f.id); location.hash = '#/friends'; }
      break;
    }
    case 'ch-send': {
      const f = friends.friend(d.fid), inp = document.querySelector('#ch-input');
      const text = inp?.value.trim();
      if (!f || !text) break;
      inp.value = ''; drafts.delete(f.id);
      haptic(8);
      friends.sendText(f, text);
      inp.focus();
      break;
    }
    case 'ch-attach': {
      const f = friends.friend(d.fid);
      if (!f) break;
      const cur = engine.track;
      const items = [];
      if (cur) {
        items.push({ icon: 'play', label: `${cur.title} — from the start`, value: 'cur0' });
        if (engine.currentTime > 3) items.push({ icon: 'timer', label: `${cur.title} — from ${fmtTimeShort(engine.currentTime)}`, value: 'curT' });
        items.push({ icon: 'edit', label: 'Pick a moment…', value: 'curPick' });
        items.push({ sep: true });
      }
      const recent = library.recentlyPlayed(8).filter((t) => t.id !== cur?.id).slice(0, 6);
      recent.forEach((t, i) => items.push({ icon: 'note', label: `${t.title} — ${t.artist}`, value: 'r' + i }));
      if (!items.length) { toast('Play a song first, then share it here'); break; }
      const v = await actionSheet({ header: html`<div class="sheet-track"><div><b>Send a song</b><span>to ${friends.nameOf(f)}</span></div></div>`, items });
      if (!v) break;
      let t = cur, at = 0;
      if (v === 'curT') at = engine.currentTime;
      else if (v === 'curPick') {
        const ans = await prompt({ title: 'Start at (m:ss)', value: fmtTimeShort(engine.currentTime), ok: 'Send' });
        if (!ans) break;
        const [mm, ss] = ans.includes(':') ? ans.split(':') : [0, ans];
        at = Math.min((+mm || 0) * 60 + (+ss || 0), (cur.duration || 9999) - 1);
      } else if (v[0] === 'r') t = recent[+v.slice(1)];
      const note = document.querySelector('#ch-input')?.value.trim() || '';
      if (note) { document.querySelector('#ch-input').value = ''; drafts.delete(f.id); }
      friends.sendSong(f, t, at, note);
      break;
    }
    case 'ch-play': {
      const t = library.track(d.tid);
      if (!t) break;
      engine.playTracks([t], 0, { context: { type: 'friend', name: 'Shared by a friend' } });
      const at = +d.at || 0;
      if (at > 0) { const go = () => engine.seek(at); setTimeout(go, 250); setTimeout(() => { if (engine.currentTime < at - 2) go(); }, 1200); }
      break;
    }
    case 'ch-search': searchQ = d.q; location.hash = '#/search'; break;
    case 'ch-retry': friends.retry(d.fid, d.mid); break;
    case 'open-stats': location.hash = '#/stats'; break;
    case 'stats-range': setStatsRange(el.dataset.v); render({ keepScroll: true }); break;
    case 'stats-import': {
      toast('Reading your Plex history…', { ms: 4000 });
      try { const n = await plex.importHistory(); toast(n ? `Added ${n.toLocaleString()} plays from Plex` : 'No Plex history found for your music'); } catch (e) { toast('Couldn’t read history from Plex'); }
      if (currentPath === 'stats') render({ keepScroll: true });
      break;
    }
    case 'car-mode': if (engine.track) openCarMode(); else toast('Play something first'); break;
    case 'eq-preset': if (await eqPresetSheet()) render({ keepScroll: true }); break;
    default: break;
  }
}

function wireGlobal() {
  // switching between versions of an album replaces the page, so Back goes to where you came from
  document.addEventListener('click', (e) => {
    const rep = e.target.closest?.('a[data-replace]');
    if (!rep || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    if (rep.classList.contains('on')) return;
    location.replace(rep.getAttribute('href'));
  }, true);
  document.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const el = e.target.closest('[data-a]');
    if (!el || el.closest('#np') || el.closest('#mini')) return;
    e.preventDefault();
    doAction(el.dataset.a, el, e);
  }, true);
  // long-press for context menus
  let lpTimer = null, lpStart = null;
  let suppressClick = false;
  document.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row.track, .card[href^="#/album/"]');
    if (!row || e.target.closest('button.more')) return;
    lpStart = [e.clientX, e.clientY];
    lpTimer = setTimeout(() => {
      lpTimer = null;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 800);
      haptic(18);
      if (row.dataset.tid) {
        const t = library.track(row.dataset.tid);
        const pl = currentPath.startsWith('playlist/') ? currentPath.split('/')[1] : null;
        if (t) trackMenu(t, { playlist: pl });
      } else {
        const al = library.album(row.getAttribute('href').split('/')[2]);
        if (al) albumMenu(al);
      }
    }, 480);
  });
  const cancelLp = (e) => {
    if (!lpTimer) return;
    if (e.type === 'pointermove' && lpStart && Math.hypot(e.clientX - lpStart[0], e.clientY - lpStart[1]) < 10) return;
    clearTimeout(lpTimer); lpTimer = null;
  };
  document.addEventListener('pointermove', cancelLp, { passive: true });
  document.addEventListener('pointerup', cancelLp);
  document.addEventListener('pointercancel', cancelLp);
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row.track, .card[href^="#/album/"]');
    if (!row) { if (e.target.closest('.card')) e.preventDefault(); return; }
    e.preventDefault();
    clearTimeout(lpTimer); lpTimer = null;
    if (e.pointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents) return; // long-press already handles touch
    if (row.dataset.tid) {
      const t = library.track(row.dataset.tid);
      const pl = currentPath.startsWith('playlist/') ? currentPath.split('/')[1] : null;
      if (t) trackMenu(t, { playlist: pl });
    } else {
      const al = library.album(row.getAttribute('href').split('/')[2]);
      if (al) albumMenu(al);
    }
  });
  // keyboard shortcuts (computers / iPad keyboards)
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.altKey) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'f') { e.preventDefault(); location.hash = '#/search'; setTimeout(() => document.querySelector('#view input[type=search], #view .search-input, #view input')?.focus(), 80); return; }
    if (mod) return;
    if (k === '/') { e.preventDefault(); location.hash = '#/search'; setTimeout(() => document.querySelector('#view input')?.focus(), 80); return; }
    if (document.querySelector('#sheet.open')) { if (k === 'Escape') closeSheet(null); return; }
    if (!engine.track && k !== 'Escape') return;
    const step = settings.get('seekStep') || 15;
    switch (k) {
      case ' ': case 'k': e.preventDefault(); engine.toggle(); break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) engine.next(); else engine.seek(engine.currentTime + step); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) engine.prev(); else engine.seek(engine.currentTime - step); break;
      case 'n': case 'MediaTrackNext': engine.next(); break;
      case 'p': case 'MediaTrackPrevious': engine.prev(); break;
      case 'ArrowUp': e.preventDefault(); engine.setVolume?.(Math.min(1, (engine.volume ?? 1) + 0.05)); toast(`Volume ${Math.round((engine.volume ?? 1) * 100)}%`, { ms: 700 }); break;
      case 'ArrowDown': e.preventDefault(); engine.setVolume?.(Math.max(0, (engine.volume ?? 1) - 0.05)); toast(`Volume ${Math.round((engine.volume ?? 1) * 100)}%`, { ms: 700 }); break;
      case 'l': if (engine.track) { const on = library.toggleLike(engine.track.id); toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs', { ms: 1200 }); } break;
      case 's': engine.toggleShuffle(); toast(engine.shuffle ? 'Shuffle on' : 'Shuffle off', { ms: 900 }); break;
      case 'Escape': if (isOpen()) closeNP(); break;
    }
  });

  // Swipe a song: right → Add to Queue, left → Add to Playlist. Follows the finger 1:1 (drawn once per
  // frame), the color and icon grow with the swipe, a tap of haptics when it locks in, then a smooth glide back.
  let sw = null;
  const SW_ARM = 84;
  document.addEventListener('pointerdown', (e) => {
    if (!settings.get('rowSwipe') || e.pointerType === 'mouse') return;
    const row = e.target.closest('.row.track');
    if (!row || row.closest('#np, #sheet') || e.target.closest('button') || row.classList.contains('swiping')) return;
    sw = { row, x0: e.clientX, y0: e.clientY, id: e.pointerId, axis: null, dx: 0, armed: 0, raf: 0 };
  }, { passive: true });
  const swDraw = () => {
    const s2 = sw;
    if (!s2 || !s2.under) return;
    s2.raf = 0;
    const d = s2.dx, w = s2.row.offsetWidth;
    s2.row.style.transform = `translate3d(${d}px,0,0)`;
    const p = Math.min(1, Math.abs(d) / SW_ARM);
    const u = s2.under;
    u.dataset.dir = d > 0 ? 'queue' : 'playlist';
    u.style.setProperty('--p', p.toFixed(3));
    // the icon rides just behind the row's edge
    const ic = u.querySelector(d > 0 ? '.su-q' : '.su-p');
    const off = Math.max(0, Math.abs(d) - 64) * 0.5;
    if (ic) ic.style.transform = `translate3d(${d < 0 ? -off : off}px,0,0) scale(${(0.7 + 0.3 * p).toFixed(3)})`;
    const armed = Math.abs(d) > SW_ARM ? Math.sign(d) : 0;
    if (armed !== s2.armed) {
      s2.armed = armed;
      u.classList.toggle('armed', !!armed);
      if (armed) { haptic(12); ic?.animate?.([{ scale: '1' }, { scale: '1.25' }, { scale: '1' }], { duration: 260, easing: 'cubic-bezier(.3,1.6,.5,1)' }); }
    }
    void w;
  };
  document.addEventListener('pointermove', (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const mx = e.clientX - sw.x0, my = e.clientY - sw.y0;
    if (!sw.axis) {
      if (Math.hypot(mx, my) < 10) return;
      sw.axis = Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : 'y';
      if (sw.axis === 'y') { sw = null; return; }
      clearTimeout(lpTimer); lpTimer = null;
      sw.x0 = e.clientX - Math.sign(mx) * 2; // no jump when the swipe starts
      const r = sw.row, par = r.offsetParent || r.parentNode;
      const under = document.createElement('div');
      under.className = 'swipe-under';
      under.style.cssText = `top:${r.offsetTop}px;left:${r.offsetLeft}px;width:${r.offsetWidth}px;height:${r.offsetHeight}px`;
      under.innerHTML = html`<span class="su-q">${icon('add-queue')}<b>Add to Queue</b></span><span class="su-p"><b>Add to Playlist</b>${icon('add-playlist')}</span>`.toString();
      par.appendChild(under);
      sw.under = under;
      r.classList.add('swiping');
    }
    const raw = e.clientX - sw.x0;
    const lim = sw.row.offsetWidth * 0.45;
    sw.dx = Math.sign(raw) * (Math.abs(raw) < lim ? Math.abs(raw) : lim + (Math.abs(raw) - lim) * 0.2);
    if (!sw.raf) sw.raf = requestAnimationFrame(swDraw);
  }, { passive: true });
  const swEnd = (e) => {
    if (!sw || (e.pointerId !== undefined && e.pointerId !== sw.id)) return;
    const s2 = sw; sw = null;
    if (s2.axis !== 'x') return;
    cancelAnimationFrame(s2.raf);
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 350);
    const t = library.track(s2.row.dataset.tid);
    const go = e.type !== 'pointercancel' ? s2.armed : 0;
    if (go) {
      s2.under.classList.add('done');
      const ic = s2.under.querySelector(go > 0 ? '.su-q' : '.su-p');
      if (ic) ic.innerHTML = icon('check') + `<b>${go > 0 ? 'Queued' : 'Choose playlist'}</b>`;
    }
    const back = s2.row.animate([{ transform: `translate3d(${s2.dx}px,0,0)` }, { transform: 'translate3d(0,0,0)' }],
      { duration: go ? 380 : 300, delay: go ? 140 : 0, easing: 'cubic-bezier(.22,.9,.3,1)', fill: 'backwards' });
    s2.row.style.transform = '';
    s2.under.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: go ? 360 : 180, fill: 'forwards' });
    back.finished.finally(() => setTimeout(() => { s2.row.classList.remove('swiping'); s2.under?.remove(); }, 200));
    if (t && go > 0) { engine.addToQueue([t]); toast(`Added “${t.title}” to queue`); }
    else if (t && go < 0) setTimeout(() => addToPlaylist([t]), 260);
  };
  document.addEventListener('pointerup', swEnd);
  document.addEventListener('pointercancel', swEnd);

  main().addEventListener('scroll', onScroll, { passive: true });
  addEventListener('hashchange', () => {
    const p = parseHash();
    if (document.querySelector('#sheet.open')) closeSheet(null); // leaving the page closes any open menu
    if (p === currentPath) { swipeBack = false; return; }
    if (isOpen() && !location.hash.endsWith('?np')) closeNP(true);
    render();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
}

function wireEngineEvents() {
  let lastErr = 0, errCount = 0;
  engine.on('error', (t) => {
    const now = Date.now();
    errCount = now - lastErr < 8000 ? errCount + 1 : 1;
    lastErr = now;
    if (errCount > 1) return; // one message per burst, not one per song
    const offline = !navigator.onLine;
    const where = t?.plex ? 'your Plex server' : 'your NAS';
    toast(offline ? `You’re offline — “${t?.title}” isn’t downloaded` : `Skipped “${t?.title || 'song'}” — couldn’t reach it on ${where}`);
  });
  // network changed (Wi-Fi ↔ cellular) or app came back from the background: re-find the Plex server
  const recheck = () => { if (plex.connected) plex.reconnect(); };
  plex.on('connection', () => { if (currentPath?.startsWith('settings')) render({ keepScroll: true }); });
  addEventListener('online', recheck);
  navigator.connection?.addEventListener?.('change', recheck);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (Date.now() - hiddenAt > 60000) recheck();
  });
  engine.on('sleep', () => toast('Sleep timer — paused'));
  let fellBack = false;
  engine.on('fallback', () => { if (!fellBack) { fellBack = true; toast('Playing Plex directly — EQ & DJ effects are limited on this server', { ms: 4000 }); } });
  // Plex: fill in hi-res info/loudness/lyrics and report "now playing"
  engine.on('track', (t) => friends.shareNowPlaying(t));
  // friends: live chat updates, unread badge, a toast when a message arrives elsewhere in the app
  const badge = () => { const b = document.querySelector('#tabs .tab-badge'); if (!b) return; const n = friends.unread; b.hidden = !n; b.textContent = n > 9 ? '9+' : n; };
  friends.on('change', () => { badge(); if (currentPath === 'friends') rerender(); });
  settings.on('change', (k) => { if (k === 'friendRelay') friends.reconnect(); if (['layoutMode', 'deskFrame', 'deskWidth', 'deskPlayerW', 'deskSidebar', 'dualSwap'].includes(k)) dispatchEvent(new Event('resize')); });
  friends.on('friend', (f) => { toast(`${friends.nameOf(f)} accepted your invite 🎉`); if (currentPath === 'friends') render({ keepScroll: true }); });
  friends.on('message', (fid, m, incoming) => {
    badge();
    if (currentPath === 'chat/' + fid) {
      const atBottom = main().scrollHeight - main().scrollTop - main().clientHeight < 120;
      render({ keepScroll: true }).then(() => { if (atBottom || !incoming) main().scrollTo({ top: main().scrollHeight, behavior: 'smooth' }); });
      if (incoming) haptic(10);
    } else if (incoming && document.hidden && !friends.pushOn && settings.get('friendNotify') && 'Notification' in window && Notification.permission === 'granted') {
      // app in the background (e.g. playing music): a real iPhone notification
      const f = friends.friend(fid);
      navigator.serviceWorker?.ready.then((reg) => reg.showNotification(friends.nameOf(f), {
        body: m.type === 'song' ? `♪ ${m.song.title} — ${m.song.artist}${m.song.at ? ` (from ${fmtTimeShort(m.song.at)})` : ''}${m.note ? `\n${m.note}` : ''}` : m.text,
        tag: 'chat-' + fid, renotify: true, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url: `#/chat/${fid}` },
      })).catch(() => {});
    } else if (incoming) {
      const f = friends.friend(fid);
      toast(`${friends.nameOf(f)}: ${m.type === 'song' ? '♪ ' + m.song.title : m.text}`.slice(0, 90), { action: { label: 'Open', run: () => { location.hash = '#/chat/' + fid; } }, ms: 5000 });
    }
  });
  addEventListener('hashchange', () => { if (!location.hash.startsWith('#/chat/')) friends.viewing = null; });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url;
    if (e.data?.type === 'relay-ping' && friends.me) friends.poll(friends.me.last || '12h');
  });
  // switches on non-settings pages (e.g. Friends)
  document.addEventListener('change', (e) => {
    const sw = e.target.closest?.('#view [data-set]');
    if (sw && !currentPath?.startsWith('settings')) settings.set(sw.dataset.set, sw.type === 'checkbox' ? sw.checked : sw.value);
  });
  engine.on('track', (t) => { if (t?.plex) { plex.enrich(t); plex.timeline(t, engine.playing ? 'playing' : 'paused', 0, t.duration); } });
  engine.on('state', () => { const t = engine.track; if (t?.plex) { plex.timelineAt = 0; plex.timeline(t, engine.playing ? 'playing' : 'paused', engine.currentTime, engine.duration); } });
  engine.on('time', () => { const t = engine.track; if (t?.plex && engine.playing) plex.timeline(t, 'playing', engine.currentTime, engine.duration); });
  // keep every visible song list in step with what's actually playing (color + playing bars)
  const markPlaying = () => {
    const id = engine.track?.id;
    $$('.row.track').forEach((r) => {
      const on = !!id && r.dataset.tid === id;
      if (r.classList.contains('playing') === on && (!on || r.querySelector('.num .eqbars') || !r.querySelector('.num'))) return;
      r.classList.toggle('playing', on);
      const num = r.querySelector('.num');
      if (num) num.innerHTML = on ? '<span class="eqbars"><i></i><i></i><i></i></span>' : (r.dataset.num || '');
    });
  };
  engine.on('track', markPlaying);
  engine.on('transition', markPlaying);
}

function wireScanner() {
  const reload = debounce(async () => { await library.reloadTracks(); rerender(); }, 1500);
  scanner.on('progress', (p) => {
    const b = $('[data-scan-banner]');
    if (b) {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      b.querySelector('b').textContent = p.phase;
      b.querySelector('span').textContent = p.total ? `${p.done} of ${p.total} songs · ${pct}%` : `${p.found} songs in ${p.dirs} folders`;
    }
  });
  scanner.on('batch', reload);
  plex.on('batch', reload);
  plex.on('progress', (p) => {
    let b = $('[data-scan-banner]');
    if (!b && (currentPath === 'home' || currentPath?.startsWith('library'))) { rerender(); return; }
    if (b && p.total) {
      b.querySelector('b').textContent = p.phase;
      b.querySelector('span').textContent = `${p.done} of ${p.total} songs from ${plex.cfg?.server?.name || 'Plex'}`;
    }
  });
  plex.on('done', async (p) => {
    await loadKnown();
    await library.reloadTracks();
    render({ keepScroll: true });
    if (p.added || p.removed) toast(`Plex synced · ${p.added} new${p.removed ? `, ${p.removed} removed` : ''}`);
    warmAllCovers();
    setTimeout(resolveEditions, 3000);
  });
  plex.on('error', (e) => {
    toast(e.message || 'Plex sync failed', { action: { label: 'Plex', run: () => { location.hash = '#/settings/plex'; } }, ms: 6000 });
    render({ keepScroll: true });
  });
  plex.on('auth', () => { if (currentPath?.startsWith('settings') || currentPath === 'home') render({ keepScroll: true }); });
  scanner.on('done', async (p) => {
    await loadKnown();
    await library.reloadTracks();
    render({ keepScroll: true });
    if (p.added || p.removed) toast(`Library updated · ${p.added} new${p.removed ? `, ${p.removed} removed` : ''}`);
  });
  scanner.on('error', (e) => {
    toast(e.message || 'Scan failed', { action: { label: 'Settings', run: () => { location.hash = '#/settings/source'; } }, ms: 6000 });
    render({ keepScroll: true });
  });
}

// clean vs explicit when nothing in the files/Plex says so: each version's own lyrics, then its audio
async function resolveEditions(only = null) {
  const lyricsOf = async (t) => {
    if (t.lyrics) return t.lyrics;
    if (t.plex && plex.connected) return plex.lyrics(t);
    if (t.lrc) { const r = await fetch(nasUrl(t.lrc)); return r.ok ? r.text() : ''; }
    return '';
  };
  const cellular = navigator.connection?.type === 'cellular' || navigator.connection?.saveData;
  // listening to two versions downloads whole songs: never while music is playing (it would compete with
  // the song for the connection and make starts lag), and it stops the moment you press play
  const ctl = new AbortController();
  const stop = () => { if (engine.playing) ctl.abort(); };
  const unsub = engine.on('state', stop);
  const compareAudio = settings.get('editionAudio') && !engine.playing && !(cellular && settings.get('analysisNetwork') === 'wifi') ? compareVersions : null;
  try { if (await library.resolveEditions({ lyricsOf, compareAudio, only, max: only ? 1 : 4, signal: ctl.signal })) rerender(); } catch (e) { console.warn('editions', e); }
  unsub();
}
// opening an album whose two versions aren't told apart yet → listen to them right away
const edChecked = new Set();
function checkAlbumEditions(id) {
  const a = library.album(id);
  if (!a?.editions || a.editions.length !== 2 || a.editions.every((e) => e.edition !== 'version') || edChecked.has(id)) return;
  a.editions.forEach((e) => edChecked.add(e.id));
  setTimeout(() => resolveEditions(id), 1200);
}

function warmAllCovers() {
  const ids = [...new Set([...library.albums.values()].map((a) => a.artId).filter(Boolean))];
  // never compete with the music: wait while a song is loading or buffering
  warmCovers(ids, [200], { busy: () => engine.buffering || (engine.playing && engine.cur.el.readyState < 3) });
}

// ---------- boot ----------
let cloudAsked = false;
// the accounts saved in the cloud: pick one to bring onto this device's account (or start a new one).
// Each account has its own id there, so restoring or saving one never overwrites another.
function offerRestore(r, { manual = false } = {}) {
  const here = new Set(accounts.all.filter((a) => a.id !== accounts.activeId && a.cid).map((a) => a.cid));
  restoreSheet({ list: cloud.listProfiles(r), where: r.where, here, mine: accounts.active?.cid }, {
    restore: async (d, parts) => {
      cloud.firstOk = true;
      await cloud.apply(d, { full: true, parts });
      // copied from an account that's also on this device: this one becomes its own account (own id)
      if (here.has(d.cid)) { accounts.update(accounts.activeId, { cid: '' }); cloud.remoteStats = null; }
      applyTheme(); paintAccountChip();
      toast(manual ? `Restored ${d.profile?.name || 'account'}` : `Welcome back${d.profile?.name ? ', ' + d.profile.name : ''} — your Player account is restored`);
      rerender(); cloud.schedule(4000);
    },
    fresh: () => {
      // a brand-new id: this account is saved next to the others, never on top of them
      if (!manual || here.has(accounts.active?.cid)) accounts.update(accounts.activeId, { cid: '' });
      cloud.firstOk = true; cloud.remoteStats = null; cloud.schedule(3000);
    },
  });
}
async function checkCloud() {
  if (!cloud.enabled || (!plex.connected && !cloud.ghToken) || cloud.busy) return;
  try {
    if (!cloud.state.at) {
      if (cloudAsked) return;
      cloudAsked = true;
      const r = await cloud.fetchRemote();
      if (cloud.listProfiles(r).length) offerRestore(r);
      else { cloud.firstOk = true; cloud.schedule(30000); }
      return;
    }
    const r = await cloud.syncNow();
    if (r) { paintAccountChip(); rerender(); }
  } catch (e) { console.warn('cloud', e); }
}

// sidebar (computer) account button: avatar + name, opens the login screen
function paintAccountChip() {
  const tabs = $('#tabs');
  if (!tabs) return;
  let b = $('.side-acct', tabs);
  if (!b) { tabs.insertAdjacentHTML('beforeend', '<button class="side-acct side-only" data-a="accounts" aria-label="Switch account"></button>'); b = $('.side-acct', tabs); }
  const a = accounts.active, [c1, c2] = accounts.colors(a), name = accounts.label(a);
  b.style.setProperty('--c1', c1); b.style.setProperty('--c2', c2);
  b.innerHTML = html`<span class="sa-av">${a.thumb ? html`<img src="${a.thumb}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<em>${(name[0] || '♪').toUpperCase()}</em></span><span class="sa-txt"><b>${name}</b><small>${accounts.all.length > 1 ? 'Switch account' : 'Add account'}</small></span>${icon('switch')}`.toString();
}

async function boot() {
  // home-screen app (no browser bars): lay out against the full screen
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('standalone', standalone);
  if (standalone && !CSS.supports('height', '100lvh')) {
    const fit = () => document.documentElement.style.setProperty('height', `${Math.max(innerHeight, document.documentElement.clientHeight)}px`);
    fit(); addEventListener('resize', fit);
  }
  document.body.insertAdjacentHTML('afterbegin', sprite());
  try { await ensureSW(); } catch (e) {
    $('#view').innerHTML = `<div class="empty"><h3>Can’t start</h3><p>${e.message}</p></div>`;
    return;
  }
  // accounts: show "Who's listening?" before any account's data is opened
  if (accounts.needsPicker()) {
    $('#view').innerHTML = '';
    document.body.classList.add('ready');
    await showLogin({ boot: true });
  } else { try { sessionStorage.setItem('picked', accounts.activeId); } catch (e) { /* */ } }
  await writeMeta();
  navigator.serviceWorker?.controller?.postMessage({ type: 'account-changed' });
  await settings.load();
  applyTheme();
  settings.on('change', (k) => {
    if (['theme', 'accent', 'gridCols', '*'].includes(k)) applyTheme();
    if (['albumSort', 'groupCompilations', 'showBadges', 'showBpmRows', 'gridCols', 'explicitPref', '*'].includes(k)) {
      if (k === 'groupCompilations' || k === 'explicitPref') library.build();
      if (!currentPath?.startsWith('settings')) rerender();
    }
  });
  await loadKnown();
  await library.load();
  await plex.load();
  await cloud.load().catch(() => {});
  friends.load().catch(() => {});
  library.loadPlayLog().catch(() => {}); // stats history must be loaded before new listens are saved
  // save listening stats whenever the app is closed or sent to the background
  const flushStats = () => { try { library.saveLog(); db.kv.set('listen', library.listen || {}); } catch (e) { /* */ } };
  addEventListener('pagehide', flushStats);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushStats(); });
  initNowPlaying({ addToPlaylist, toggleDownload, onAccent: applyAccent, djOrderQueue });
  initDual((mode) => {
    if (mode !== 'single') { closeNP(true); }
    document.body.classList.toggle('np-docked', mode !== 'single');
  });
  wireGlobal();
  wireEngineEvents();
  wireScanner();
  library.on('likes', () => { if (currentPath === 'liked') rerender(); });
  library.on('playlists', () => { if (currentPath?.startsWith('library/playlists')) rerender(); });
  await render();
  await engine.restore();
  document.body.classList.add('ready');
  paintAccountChip();
  // keep this account's tile on the login screen current (Plex name + avatar, server, song count)
  let nasSrc = null;
  const note = () => { noteAccount({ plexUser: plex.user, server: plex.cfg?.server?.name, songs: library.size, nas: !plex.connected && !!nasSrc?.url }); paintAccountChip(); };
  db.kv.get('source').then((v) => { nasSrc = v; note(); });
  plex.on('auth', note);
  plex.on('done', note);
  friends.on('cloud-ping', () => setTimeout(checkCloud, 1500)); // another device of this account just saved
  // your Player account in the cloud: restore it on a new device, keep devices in step afterwards
  plex.on('connection', () => setTimeout(checkCloud, 1500));
  plex.on('done', () => cloud.schedule(5000));
  if (plex.connected || cloud.ghToken) setTimeout(checkCloud, 5000);
  // an account just added from the cloud (login screen): bring everything it saved into it
  if (sessionStorage.getItem('afterSwitch') === 'restore') {
    sessionStorage.removeItem('afterSwitch');
    (async () => {
      for (let i = 0; i < 20 && !plex.connected && !cloud.ghToken; i++) await new Promise((r) => setTimeout(r, 500));
      const r = await cloud.fetchRemote().catch(() => null);
      const d = r?.c?.profiles?.[accounts.active?.cid];
      cloudAsked = true; cloud.firstOk = true;
      if (d) { await cloud.apply(d, { full: true }); applyTheme(); paintAccountChip(); toast(`Welcome back${d.profile?.name ? ', ' + d.profile.name : ''} — everything’s restored`); rerender(); }
      if (plex.connected && !library.size) plex.sync();
    })();
  }
  // keep this device in step while it's open (friends, playlists, likes from your other devices)
  let lastSync = Date.now();
  const tickSync = () => { if (!document.hidden && Date.now() - lastSync > 45000 && cloud.state.at) { lastSync = Date.now(); checkCloud(); } };
  document.addEventListener('visibilitychange', tickSync);
  setInterval(tickSync, 120000);
  if (sessionStorage.getItem('afterSwitch') === 'connect') {
    sessionStorage.removeItem('afterSwitch');
    if (!plex.signedIn && !library.size) setTimeout(() => connectSheet({ plexSignIn }), 500);
  }
  const src = await db.kv.get('source');
  if (src?.url && settings.get('scanOnLaunch')) setTimeout(() => scanner.run(), 1500);
  setTimeout(warmAllCovers, 8000);
  if (plex.connected) {
    const pt = [...library.tracks.values()].filter((t) => t.plex);
    const stale = !pt.length || pt.some((t) => !t.plexThumb && t.artId);
    if (stale || settings.get('plexSyncOnLaunch')) setTimeout(() => plex.sync(), stale ? 300 : 2500);
  }
}

boot();
