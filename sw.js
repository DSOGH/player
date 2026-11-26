/* Service worker:
 *  - caches the app so it opens instantly and works offline
 *  - ./__nas?u=<url>  proxies requests to your NAS, adding your login (Basic auth) and
 *                     fixing up Range/seek headers; serves downloaded tracks from cache
 *  - ./__art/<id>     artwork from IndexedDB
 *  - ./__demo/<n>.wav generated demo music
 */
const VERSION = 'v1.31.0';
const SHELL_CACHE = 'shell-' + VERSION;
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/util.js', './js/db.js', './js/settings.js', './js/sources.js', './js/tags.js',
  './js/scanner.js', './js/library.js', './js/art.js', './js/analysis.js', './js/engine.js', './js/demo.js',
  './js/demo-synth.js', './js/plex.js', './js/lyrics.js', './js/dj.js', './js/analysis-core.js', './js/analysis-worker.js', './js/ui/djbooth.js', './js/vocal-worklet.js', './js/ui/views.js', './js/ui/nowplaying.js', './js/ui/settings-view.js', './js/ui/components.js',
  './js/ui/icons.js', './js/ui/dual.js', './js/ui/plex-view.js', './js/ui/stats-view.js', './js/stats.js', './js/friends.js', './js/ui/friends-view.js', './js/bpm-online.js', './js/accounts.js', './js/ui/accounts-view.js', './js/editions.js', './js/cloud.js', 
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
];

importScripts('./js/demo-synth.js');

self.addEventListener('install', (e) => {
  // cache:'reload' bypasses the browser's HTTP cache so an update never mixes old and new files
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// ---------- IndexedDB (same schema as js/db.js) ----------
// Each account on this device has its own database; the page records which one is in use in a tiny
// shared "nasplayer-meta" database so the worker always reads the right account's settings.
let dbp, dbHandle = null;
function metaActive() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('nasplayer-meta', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => {
        const d = r.result;
        try {
          const q = d.transaction('kv').objectStore('kv').get('activeDb');
          q.onsuccess = () => { d.close(); res(q.result || 'nasplayer'); };
          q.onerror = () => { d.close(); res('nasplayer'); };
        } catch (e) { d.close(); res('nasplayer'); }
      };
      r.onerror = () => res('nasplayer');
    } catch (e) { res('nasplayer'); }
  });
}
function idb() {
  if (dbp) return dbp;
  dbp = metaActive().then((name) => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['tracks', 'art', 'analysis', 'playlists']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => { const d = r.result; dbHandle = d; d.onversionchange = () => { d.close(); if (dbHandle === d) { dbHandle = null; dbp = null; } }; res(d); };
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  return dbp;
}
async function idbGet(store, key) {
  const d = await idb();
  return new Promise((res, rej) => {
    const q = d.transaction(store).objectStore(store).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

let cfg = null, plexCfg = null;
async function getCfg() {
  if (!cfg) cfg = (await idbGet('kv', 'source')) || {};
  return cfg;
}
async function getPlex() {
  if (!plexCfg) plexCfg = (await idbGet('kv', 'plex')) || {};
  return plexCfg;
}
async function idbPut(store, val) {
  const d = await idb();
  return new Promise((res, rej) => {
    const q = d.transaction(store, 'readwrite').objectStore(store).put(val);
    q.onsuccess = () => res();
    q.onerror = () => rej(q.error);
  });
}
// ---- downloaded / preloaded Plex songs (served when the player asks the Plex server for them) ----
let plexKeys = null, plexServerId = null;
async function loadPlexKeys() {
  const set = new Set();
  for (const name of ['offline-tracks', 'prefetch']) {
    try { for (const r of await (await caches.open(name)).keys()) if (r.url.includes('/__pc/')) set.add(r.url); } catch (e) { /* */ }
  }
  plexKeys = set;
  try { plexServerId = (await getPlex()).server?.id || null; } catch (e) { plexServerId = null; }
}
loadPlexKeys();
const scopeBase = () => self.registration.scope;
function plexKeyFor(url) {
  if (!plexServerId) return null;
  return `${scopeBase()}__pc/${plexServerId}${url.pathname}`;
}
async function fromCachesByKey(key, req) {
  for (const name of ['offline-tracks', 'prefetch']) {
    const hit = await (await caches.open(name)).match(key);
    if (hit) return blobResponse(await hit.blob(), req, hit.headers.get('content-type') || 'audio/mpeg');
  }
  return null;
}

self.addEventListener('message', (e) => {
  if (e.data?.type === 'cache-changed') loadPlexKeys();
  if (e.data?.type === 'config-changed') { cfg = null; plexCfg = null; loadPlexKeys(); }
  if (e.data?.type === 'account-changed') { try { dbHandle?.close(); } catch (er) { /* */ } dbHandle = null; dbp = null; cfg = null; plexCfg = null; loadPlexKeys(); }
  if (e.data?.type === 'skip-waiting') self.skipWaiting();
});

const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', weba: 'audio/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function guessType(url, given) {
  if (given && !/octet-stream|text\/plain/.test(given)) return given;
  const ext = (new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  return MIME[ext] || given || 'application/octet-stream';
}

function parseRange(h, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(h || '');
  if (!m) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1; }
  return { start, end };
}
async function blobResponse(blob, req, type) {
  const size = blob.size;
  const r = req.headers.get('range');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (!r) return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  const rg = parseRange(r, size);
  if (!rg || rg.start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(rg.start, rg.end + 1), {
    status: 206,
    headers: { ...base, 'Content-Length': String(rg.end - rg.start + 1), 'Content-Range': `bytes ${rg.start}-${rg.end}/${size}` },
  });
}

async function nas(req, url) {
  const target = url.searchParams.get('u');
  const size = parseInt(url.searchParams.get('s') || '0', 10);
  const cacheKey = url.searchParams.get('k') || target;
  if (!target) return new Response('missing u', { status: 400 });
  const method = req.method;
  if (method === 'GET') {
    for (const name of ['offline-tracks', 'prefetch']) {
      try {
        const c = await caches.open(name);
        const hit = await c.match(cacheKey);
        if (hit) return blobResponse(await hit.blob(), req, guessType(target, hit.headers.get('content-type')));
      } catch (e) { /* ignore */ }
    }
  }
  if (target.startsWith('plex://')) return new Response('offline', { status: 503 });
  const c = await getCfg();
  const headers = new Headers();
  for (const h of ['range', 'depth', 'content-type', 'accept']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  let sameNas = false;
  try { sameNas = c.url && new URL(target).origin === new URL(c.url).origin; } catch (e) { /* */ }
  if (c.auth && sameNas) headers.set('Authorization', c.auth);
  const init = { method, headers, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow' };
  if (method !== 'GET' && method !== 'HEAD') init.body = await req.text();
  let r;
  try { r = await fetch(target, init); } catch (e) {
    return new Response(JSON.stringify({ error: 'network', message: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
  const out = new Headers();
  const type = guessType(target, r.headers.get('content-type'));
  out.set('Content-Type', type);
  const len = r.headers.get('content-length');
  if (len) out.set('Content-Length', len);
  for (const h of ['last-modified', 'etag']) { const v = r.headers.get(h); if (v) out.set(h, v); }
  out.set('Accept-Ranges', 'bytes');
  if (r.status === 206) {
    let cr = r.headers.get('content-range');
    if (!cr) {
      // header not exposed by the NAS's CORS config — rebuild it
      const rg = /bytes=(\d+)-/.exec(req.headers.get('range') || '');
      const start = rg ? parseInt(rg[1], 10) : 0;
      const l = len ? parseInt(len, 10) : 0;
      cr = `bytes ${start}-${start + l - 1}/${size || '*'}`;
    }
    out.set('Content-Range', cr);
  }
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
}

async function art(id) {
  try {
    const rec = await idbGet('art', id);
    if (!rec) return new Response(null, { status: 404 });
    if (!rec.blob && rec.src) {
      // Plex artwork: fetch a 640px version once, then keep it on the device
      const p = await getPlex();
      if (!p.base || !p.server) return new Response(null, { status: 404 });
      const q = new URLSearchParams({ width: 640, height: 640, minSize: 1, upscale: 1, url: rec.src, 'X-Plex-Token': p.server.token });
      const r = await fetch(`${p.base}/photo/:/transcode?${q}`, { mode: 'cors', credentials: 'omit' });
      if (!r.ok) return new Response(null, { status: 404 });
      rec.blob = await r.blob();
      idbPut('art', rec).catch(() => {});
    }
    return new Response(rec.blob, { headers: { 'Content-Type': rec.blob.type || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch (e) { return new Response(null, { status: 404 }); }
}

// Plex covers: kept on the device after the first view (keyed without the server address/token, so they
// survive network changes and load instantly — even offline).
const ART_CACHE = 'plexart-v1';
async function plexArt(req, url) {
  const cache = await caches.open(ART_CACHE);
  const key = url.origin + url.pathname;
  const hit = await cache.match(key);
  if (hit) return hit;
  const [, size, thumb] = url.pathname.match(/__pa\/(\d+)\/(.+)$/) || [];
  const p = await getPlex();
  if (!thumb || !p.base || !p.server) return new Response(null, { status: 404 });
  const q = new URLSearchParams({ width: size, height: size, minSize: 1, upscale: 1, url: decodeURIComponent(thumb), 'X-Plex-Token': p.server.token });
  const src = `${p.base}/photo/:/transcode?${q}`;
  let r;
  try { r = await fetch(src, { mode: 'cors', credentials: 'omit' }); } catch (e) { r = null; }
  if (r && r.ok) {
    const blob = await r.blob();
    const res = new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg', 'Cache-Control': 'max-age=31536000, immutable' } });
    cache.put(key, res.clone()).catch(() => {});
    return res;
  }
  // server without CORS: let the browser load it directly (not stored)
  try { return await fetch(src, { mode: 'no-cors', credentials: 'omit' }); } catch (e) { return new Response(null, { status: 404 }); }
}

const demoCache = new Map();
async function demo(req, url) {
  const key = url.pathname + url.search;
  let blob = demoCache.get(key);
  if (!blob) {
    const q = Object.fromEntries(url.searchParams);
    const p = {};
    for (const [k, v] of Object.entries(q)) p[k] = k === 'style' ? v : parseFloat(v);
    blob = new Blob([self.demoSynth(p)], { type: 'audio/wav' });
    demoCache.set(key, blob);
    if (demoCache.size > 12) demoCache.delete(demoCache.keys().next().value);
  }
  return blobResponse(blob, req, 'audio/wav');
}

// App files: network first (always the latest version), falling back to the cache when offline/slow.
async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const r = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500)),
    ]);
    if (r.ok && r.type === 'basic') cache.put(req, r.clone());
    if (r.ok) return r;
    throw new Error('HTTP ' + r.status);
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || new Response('Offline', { status: 503 });
    return fetch(req).catch(() => new Response(null, { status: 504 }));
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) {
    // a Plex song that's downloaded or preloaded → play it from the device
    if (url.pathname.startsWith('/library/parts/') && e.request.method === 'GET') {
      const key = plexKeyFor(url);
      if (key && plexKeys?.has(key)) e.respondWith(fromCachesByKey(key, e.request).then((r) => r || fetch(e.request)));
      else if (!self.navigator.onLine && key) e.respondWith(fromCachesByKey(key, e.request).then((r) => r || new Response(null, { status: 503 })));
    }
    return;
  }
  const p = url.pathname;
  if (p.includes('/__pc/')) return e.respondWith(fromCachesByKey(url.href, e.request).then((r) => r || new Response(null, { status: 503 })));
  if (p.endsWith('/__nas')) return e.respondWith(nas(e.request, url));
  if (p.includes('/__pa/')) return e.respondWith(plexArt(e.request, url));
  if (p.includes('/__art/')) return e.respondWith(art(decodeURIComponent(p.split('/__art/')[1])));
  if (p.includes('/__demo/')) return e.respondWith(demo(e.request, url));
  if (e.request.method === 'GET') e.respondWith(shell(e.request));
});

// ---- friend messages pushed by the relay (ntfy Web Push): decrypt on the phone, show the notification ----
const b64uDec = (x) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((x.length + 3) % 4)), (c) => c.charCodeAt(0));
async function friendNote(raw) {
  const env = JSON.parse(raw);
  const list = (await idbGet('kv', 'friends:list')) || [];
  const pending = (await idbGet('kv', 'friends:pending')) || [];
  const f = list.find((x) => x.kid === env.k);
  const keyB64 = f?.key || pending.find((x) => x.kid === env.k)?.key;
  if (!keyB64) return null;
  const key = await crypto.subtle.importKey('raw', b64uDec(keyB64), 'AES-GCM', false, ['decrypt']);
  const m = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDec(env.iv) }, key, b64uDec(env.c))));
  if (m.type === 'hello') return { title: 'New friend', body: `${m.name || 'Someone'} added you on Player`, url: '#/friends', tag: 'hello' };
  if (!f) return null;
  const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const body = m.type === 'song'
    ? `♪ ${m.song.title} — ${m.song.artist}${m.song.at ? ` (from ${fmt(m.song.at)})` : ''}${m.note ? `\n${m.note}` : ''}`
    : String(m.text || 'New message');
  return { title: f.nick || f.name, body, url: `#/chat/${f.id}`, tag: 'chat-' + f.id };
}
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch (er) { try { d = { message: e.data.text() }; } catch (er2) { /* */ } }
    if (d.event === 'subscription_expiring') {
      return self.registration.showNotification('Player', { body: 'Open Player to keep message notifications on', tag: 'push-renew', icon: './icons/icon-192.png' });
    }
    const msg = d.message && typeof d.message === 'object' ? d.message : d; // ntfy: { event, message: { … } }
    let n = null;
    try { n = await friendNote(msg.message); } catch (er) { /* not ours / can't decrypt */ }
    n = n || { title: 'Player', body: 'New message', url: '#/friends', tag: 'chat' };
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) c.postMessage({ type: 'relay-ping' }); // an open app fetches it right away
    return self.registration.showNotification(n.title, { body: n.body, tag: n.tag, renotify: true, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url: n.url } });
  })());
});

// tapping a message notification opens that chat
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '#/friends';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { c.postMessage({ type: 'open', url }); if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./' + url);
  })());
});
