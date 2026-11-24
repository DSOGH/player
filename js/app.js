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
import { initNowPlaying, openNP, closeNP, isOpen } from './ui/nowplaying.js';
import { initDual } from './ui/dual.js';
import { getList, actionSheet, prompt, toast, confirmSheet, haptic, art } from './ui/components.js';
import { plex } from './plex.js';
import { plexSignIn, plexSignOut, loadServers } from './ui/plex-view.js';
import { trackSrc } from './analysis.js';
import { optimizeOrder } from './dj.js';

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
    case 'library': return V.libraryView(a || 'albums');
    case 'album': return V.albumView(a);
    case 'artist': return V.artistView(a);
    case 'playlist': return V.playlistView(a);
    case 'liked': return V.likedView();
    case 'genre': return V.genreView(a);
    case 'mix': return V.mixView(a);
    case 'search': return V.searchView(searchQ);
    case 'settings': return settingsView(a || '');
    default: return V.home();
  }
}
const TAB_OF = { home: 'home', mix: 'home', library: 'library', album: 'library', artist: 'library', playlist: 'library', liked: 'library', genre: 'library', search: 'search', settings: 'settings' };

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
  const nav = changed && !keepScroll && prevPath ? navDirection(prevPath, path) : null;
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
let lastShown = null, activeVT = null;
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
    t.classList.toggle('on', on);
    t.querySelector('.tab-ic').innerHTML = icon(on && t.dataset.fill ? t.dataset.fill : t.dataset.icon);
  });
  if (keepScroll) main().scrollTop = prevScroll;
  else main().scrollTop = changed ? (scrollMem.get(path) || 0) : prevScroll;
  if (fade) v.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
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
    ],
  });
  if (v === 'next') { engine.playNext(a.tracks); toast('Playing next'); }
  if (v === 'queue') { engine.addToQueue(a.tracks); toast('Added to queue'); }
  if (v === 'playlist') addToPlaylist(a.tracks);
  if (v === 'download') toggleDownload(a.tracks);
  if (v === 'artist') location.hash = `#/artist/${a.artistId}`;
  if (v === 'djset') djSet(a.tracks, { context: { type: 'album', id: a.id, name: a.title } });
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
    case 'plex-signout': await plexSignOut(() => render({ keepScroll: false })); break;
    case 'plex-servers': loadServers(view()); break;
    case 'plex-sync': if (!plex.running) { plex.sync(); toast('Syncing with Plex…'); render({ keepScroll: true }); } break;
    case 'back': if (history.length > 1) history.back(); else location.hash = '#/home'; break;
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
    case 'clear-downloads':
      if (await confirmSheet('Remove all downloaded songs from this device?', 'Remove Downloads', true)) {
        await caches.delete('offline-tracks'); await library.refreshOffline(); toast('Downloads removed'); render({ keepScroll: true });
      }
      break;
    case 'clear-cache': await caches.delete('prefetch'); toast('Cache cleared'); render({ keepScroll: true }); break;
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
    case 'eq-preset': if (await eqPresetSheet()) render({ keepScroll: true }); break;
    default: break;
  }
}

function wireGlobal() {
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
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.row.track, .card')) e.preventDefault(); });

  main().addEventListener('scroll', onScroll, { passive: true });
  addEventListener('hashchange', () => {
    const p = parseHash();
    if (p === currentPath) return;
    if (isOpen() && !location.hash.endsWith('?np')) closeNP(true);
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); engine.toggle(); }
    else if (e.key === 'ArrowRight' && e.shiftKey) engine.next();
    else if (e.key === 'ArrowLeft' && e.shiftKey) engine.prev();
    else if (e.key === 'ArrowRight') engine.seek(engine.currentTime + 10);
    else if (e.key === 'ArrowLeft') engine.seek(engine.currentTime - 10);
    else if (e.key === 'Escape') closeNP();
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
  let relayWarned = false;
  plex.on('connection', () => {
    if (plex.cfg?.connKind === 'relay' && !relayWarned) {
      relayWarned = true;
      toast('Plex is using its Relay (speed-limited) — songs will start slowly. Turn on Remote Access in Plex for fast playback.', { ms: 8000 });
    }
  });
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
  engine.on('track', (t) => { if (t?.plex) { plex.enrich(t); plex.timeline(t, engine.playing ? 'playing' : 'paused', 0, t.duration); } });
  engine.on('state', () => { const t = engine.track; if (t?.plex) { plex.timelineAt = 0; plex.timeline(t, engine.playing ? 'playing' : 'paused', engine.currentTime, engine.duration); } });
  engine.on('time', () => { const t = engine.track; if (t?.plex && engine.playing) plex.timeline(t, 'playing', engine.currentTime, engine.duration); });
  engine.on('track', () => {
    $$('.row.track.playing').forEach((r) => r.classList.remove('playing'));
  });
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

function warmAllCovers() {
  const ids = [...new Set([...library.albums.values()].map((a) => a.artId).filter(Boolean))];
  // never compete with the music: wait while a song is loading or buffering
  warmCovers(ids, [200], { busy: () => engine.buffering || (engine.playing && engine.cur.el.readyState < 3) });
}

// ---------- boot ----------
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
  await settings.load();
  applyTheme();
  settings.on('change', (k) => {
    if (['theme', 'accent', 'gridCols', '*'].includes(k)) applyTheme();
    if (['albumSort', 'groupCompilations', 'showBadges', 'showBpm', 'gridCols', 'explicitPref', '*'].includes(k)) {
      if (k === 'groupCompilations' || k === 'explicitPref') library.build();
      if (!currentPath?.startsWith('settings')) rerender();
    }
  });
  await loadKnown();
  await library.load();
  await plex.load();
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
