// Plex: sign in with your Plex account (PIN flow, same as Plexamp/Plex Web), discover your servers,
// pick a music library and sync it. Streams the original files straight from your Plex Media Server
// over its secure plex.direct address, so no NAS/HTTPS/CORS setup is needed.
import * as db from './db.js';
import { Emitter, hash, sleep } from './util.js';
import { library } from './library.js';
import { settings } from './settings.js';
import { loadKnown, setArtResolver } from './art.js';

const PRODUCT = 'Player';
const VERSION = '1.1.0';
// test hook: lets the test-suite point at a mock plex.tv
const TV = () => localStorage.getItem('plexTvBase') || 'https://plex.tv';
const AUTH_APP = () => localStorage.getItem('plexAuthBase') || 'https://app.plex.tv/auth';

export function clientId() {
  let id = localStorage.getItem('plexClientId');
  if (!id) {
    id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem('plexClientId', id);
  }
  return id;
}
export function deviceName() {
  const ua = navigator.userAgent;
  if (/Surface Duo/i.test(ua)) return 'Surface Duo';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  return 'Web';
}
// every network call gets a deadline, so nothing can hang forever on a dead route
function withTimeout(ms, outer) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  outer?.addEventListener?.('abort', () => c.abort(), { once: true });
  c.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return c.signal;
}
function tvHeaders(token) {
  const h = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Browser',
    'X-Plex-Device-Name': `${PRODUCT} (${deviceName()})`,
    'X-Plex-Model': 'hosted',
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

const CODECS = { flac: 'FLAC', alac: 'ALAC', aac: 'AAC', mp3: 'MP3', vorbis: 'Vorbis', opus: 'Opus', pcm: 'WAV', wav: 'WAV', wma: 'WMA', ape: 'APE', dca: 'DTS', ac3: 'AC3', eac3: 'EAC3' };
const codecName = (c) => CODECS[String(c || '').toLowerCase()] || String(c || '').toUpperCase();

export class PlexError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

class Plex extends Emitter {
  constructor() {
    super();
    this.cfg = null;
    this.running = false;
    this.progress = null;
    this.enriched = new Map();
    this.timelineAt = 0;
  }

  async load() {
    this.cfg = (await db.kv.get('plex')) || null;
    this.startUpgradeLoop();
    if (this.connected && this.cfg.connKind === 'relay') setTimeout(() => this.checkConnections().catch(() => {}), 4000);
    // covers load straight from the Plex server (no CORS needed for <img>)
    setArtResolver((id, size) => {
      const th = library.plexThumbs?.get(id);
      if (!th || !this.cfg?.server) return null;
      const px = size >= 900 ? 1024 : size >= 500 ? 640 : size >= 250 ? 360 : 200;
      // through the service worker: stored on the phone after the first load, instant afterwards
      if (navigator.serviceWorker?.controller) return `./__pa/${px}/${encodeURIComponent(th)}`;
      return this.connected ? this.artSrc(th, px) : null;
    });
    library.on('liked', (id, on) => this.rate(library.track(id), on));
    library.on('played', (id) => this.scrobble(library.track(id)));
  }
  async save() {
    await db.kv.set('plex', this.cfg);
    navigator.serviceWorker?.controller?.postMessage({ type: 'config-changed' });
  }
  get signedIn() { return !!this.cfg?.token && !this.cfg?.expired; }
  get connected() { return !!(this.cfg?.token && !this.cfg?.expired && this.cfg?.base && this.cfg?.server); }
  get user() { return this.cfg?.user || null; }

  // ---------- auth ----------
  async startPin() {
    let r;
    try { r = await fetch(`${TV()}/api/v2/pins?strong=false`, { method: 'POST', headers: tvHeaders() }); }
    catch (e) { throw new PlexError('network', 'Couldn’t reach plex.tv. Check your internet connection.'); }
    if (!r.ok) throw new PlexError('http', `plex.tv responded with ${r.status}`);
    const j = await r.json();
    return { id: j.id, code: j.code, expires: Date.now() + (j.expiresIn || 900) * 1000 };
  }
  authUrl(pin) {
    const p = new URLSearchParams({
      clientID: clientId(), code: pin.code,
      'context[device][product]': PRODUCT, 'context[device][platform]': 'Web', 'context[device][device]': deviceName(),
    });
    return `${AUTH_APP()}#?${p}`;
  }
  async pollPin(pin, signal) {
    while (!signal?.aborted && Date.now() < pin.expires) {
      try {
        const r = await fetch(`${TV()}/api/v2/pins/${pin.id}`, { headers: tvHeaders() });
        if (r.ok) {
          const j = await r.json();
          if (j.authToken) return j.authToken;
        } else if (r.status === 404) throw new PlexError('expired', 'The sign-in code expired. Try again.');
      } catch (e) { if (e instanceof PlexError) throw e; }
      await sleep(2000);
    }
    if (signal?.aborted) throw new PlexError('cancelled', 'Cancelled');
    throw new PlexError('expired', 'The sign-in code expired. Try again.');
  }
  async finishLogin(token) {
    const r = await fetch(`${TV()}/api/v2/user`, { headers: tvHeaders(token) });
    if (!r.ok) throw new PlexError('auth', 'Plex didn’t accept the sign-in. Try again.');
    const u = await r.json();
    const keep = this.cfg?.server && this.cfg?.user?.id === undefined ? null : this.cfg;
    this.cfg = {
      ...(keep?.server ? { server: keep.server, base: keep.base, sections: keep.sections, connKind: keep.connKind, lastSync: keep.lastSync } : {}),
      token,
      user: { id: u.id, name: u.friendlyName || u.title || u.username, username: u.username, email: u.email, thumb: u.thumb },
    };
    if (!this.cfg.server) Object.assign(this.cfg, { server: null, base: null, sections: [] });
    if (this.cfg.server && keep?.user?.id !== u.id) Object.assign(this.cfg, { server: null, base: null, sections: [] });
    await this.save();
    // ask the browser to never clear our storage (keeps you signed in + downloads safe)
    try { await navigator.storage?.persist?.(); } catch (e) { /* */ }
    this.emit('auth');
    return this.cfg.user;
  }
  async signOut() {
    const ids = [...library.tracks.values()].filter((t) => t.plex).map((t) => t.id);
    await db.delMany('tracks', ids);
    for (const p of [...library.playlists.values()]) if (p.source === 'plex') await db.del('playlists', p.id);
    this.cfg = null;
    await db.kv.del('plex');
    navigator.serviceWorker?.controller?.postMessage({ type: 'config-changed' });
    await library.reloadTracks();
    this.emit('auth');
  }

  // ---------- servers ----------
  async servers() {
    const r = await fetch(`${TV()}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`, { headers: tvHeaders(this.cfg.token), signal: withTimeout(15000) });
    if (r.status === 401) throw new PlexError('auth', 'Your Plex sign-in expired. Sign in again.');
    if (!r.ok) throw new PlexError('http', `plex.tv responded with ${r.status}`);
    const list = await r.json();
    return list.filter((d) => String(d.provides || '').includes('server')).map((d) => ({
      id: d.clientIdentifier, name: d.name, owned: !!d.owned, presence: d.presence !== false,
      product: d.product, version: d.productVersion, platform: d.platform,
      token: d.accessToken || this.cfg.token,
      connections: (d.connections || []).map((c) => ({ uri: c.uri, local: !!c.local, relay: !!c.relay, protocol: c.protocol })),
    }));
  }
  // Try every secure address for the server at once and use the first that answers
  // (local network first, then remote, then Plex Relay).
  async pickConnection(server, { record = true } = {}) {
    const http = location.protocol === 'http:';
    const conns = server.connections.filter((c) => http || c.uri.startsWith('https:'));
    if (!conns.length) throw new PlexError('nohttps', 'This server has no secure connection. In Plex settings, set “Secure connections” to Preferred.');
    const rank = (c) => (c.relay ? 2 : c.local ? 0 : 1);
    conns.sort((a, b) => rank(a) - rank(b));
    const ctrl = new AbortController();
    const diag = conns.map((c) => ({ uri: c.uri, kind: c.relay ? 'relay' : c.local ? 'local' : 'remote', ok: null, ms: 0 }));
    const tries = conns.map((c, i) => (async () => {
      await sleep(rank(c) * 400 + i * 40);
      if (ctrl.signal.aborted) throw new Error('aborted');
      const t0 = performance.now();
      try {
        const r = await fetch(`${c.uri}/identity?X-Plex-Token=${encodeURIComponent(server.token)}`, {
          headers: { Accept: 'application/json' }, signal: withTimeout(8000, ctrl.signal),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        diag[i].ok = true; diag[i].ms = Math.round(performance.now() - t0);
        return c;
      } catch (e) {
        if (!ctrl.signal.aborted) { diag[i].ok = false; diag[i].ms = Math.round(performance.now() - t0); }
        throw e;
      }
    })());
    const direct = tries.filter((_, i) => !conns[i].relay);
    try {
      let c = await Promise.any(tries);
      // the Relay is speed-limited: if it answered first, give a direct route a little longer to answer
      if (c.relay && direct.length) {
        try { c = await Promise.race([Promise.any(direct), sleep(2500).then(() => { throw new Error('slow'); })]); } catch (e) { /* stay on relay */ }
      }
      // give the others a moment to report (for the connection check in Settings), then stop them
      setTimeout(() => ctrl.abort(), 3000);
      if (record) { this.diag = { at: Date.now(), list: diag }; this.emit('diag'); }
      return c;
    } catch (e) {
      if (record) { this.diag = { at: Date.now(), list: diag }; this.emit('diag'); }
      throw new PlexError('unreachable', `Couldn’t reach “${server.name}”. Make sure it’s on and Remote Access is enabled in Plex.`);
    }
  }
  // Full connection check for Settings: tries every route and waits for all of them
  async checkConnections() {
    if (!this.connected) return null;
    const s = (await this.servers()).find((x) => x.id === this.cfg.server.id);
    if (!s) return null;
    const list = await Promise.all(s.connections.filter((c) => location.protocol === 'http:' || c.uri.startsWith('https:')).map(async (c) => {
      const t0 = performance.now();
      let ok = false;
      try { ok = (await fetch(`${c.uri}/identity?X-Plex-Token=${encodeURIComponent(s.token)}`, { headers: { Accept: 'application/json' }, signal: withTimeout(8000) })).ok; } catch (e) { /* */ }
      return { uri: c.uri, kind: c.relay ? 'relay' : c.local ? 'local' : 'remote', ok, ms: Math.round(performance.now() - t0) };
    }));
    this.diag = { at: Date.now(), list };
    this.emit('diag');
    // switch to the best working route right away
    const best = ['local', 'remote', 'relay'].map((k) => list.filter((x) => x.ok && x.kind === k).sort((a, b) => a.ms - b.ms)[0]).find(Boolean);
    if (best && best.uri.replace(/\/$/, '') !== this.cfg.base) {
      this.cfg.base = best.uri.replace(/\/$/, '');
      this.cfg.connKind = best.kind;
      await this.save();
      this.emit('connection');
    }
    return this.diag;
  }
  // While stuck on the Relay, keep looking for a direct route in the background
  startUpgradeLoop() {
    clearInterval(this._upgrade);
    this._upgrade = setInterval(async () => {
      if (!this.connected || this.cfg.connKind !== 'relay' || document.hidden) return;
      try {
        const s = (await this.servers()).find((x) => x.id === this.cfg.server.id);
        if (!s) return;
        const c = await this.pickConnection({ ...s, connections: s.connections.filter((x) => !x.relay) }, { record: false });
        if (c && !c.relay) {
          this.cfg.base = c.uri.replace(/\/$/, '');
          this.cfg.connKind = c.local ? 'local' : 'remote';
          await this.save();
          this.emit('connection');
        }
      } catch (e) { /* still no direct route */ }
    }, 90000);
  }
  async connect(server) {
    const c = await this.pickConnection(server);
    this.cfg.server = { id: server.id, name: server.name, owned: server.owned, token: server.token };
    this.cfg.base = c.uri.replace(/\/$/, '');
    this.cfg.connKind = c.relay ? 'relay' : c.local ? 'local' : 'remote';
    await this.save();
    this.emit('connection');
    return c;
  }
  async ensureConnection() {
    if (!this.connected) throw new PlexError('setup', 'Choose a Plex server first.');
    try {
      const r = await fetch(`${this.cfg.base}/identity?X-Plex-Token=${encodeURIComponent(this.cfg.server.token)}`, {
        headers: { Accept: 'application/json' }, signal: withTimeout(4000),
      });
      if (r.ok) return;
    } catch (e) { /* fall through and re-resolve */ }
    const s = (await this.servers()).find((x) => x.id === this.cfg.server.id);
    if (!s) throw new PlexError('gone', 'Your Plex server isn’t available on this account anymore.');
    await this.connect(s);
  }

  // ---------- server API ----------
  q(params = {}) {
    return new URLSearchParams({
      ...params,
      'X-Plex-Token': this.cfg.server.token,
      'X-Plex-Client-Identifier': clientId(),
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': VERSION,
      'X-Plex-Platform': 'Web',
      'X-Plex-Device-Name': `${PRODUCT} (${deviceName()})`,
    }).toString();
  }
  async api(path, params = {}, method = 'GET', ms = 0) {
    let r;
    try {
      r = await fetch(`${this.cfg.base}${path}${path.includes('?') ? '&' : '?'}${this.q(params)}`, { method, headers: { Accept: 'application/json' }, signal: withTimeout(ms || (method === 'GET' ? 30000 : 15000)) });
    } catch (e) {
      throw new PlexError('unreachable', e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Your Plex server is taking too long to answer.' : 'Couldn’t reach your Plex server.');
    }
    if (r.status === 401) throw new PlexError('auth', 'Plex rejected the request. Sign in again.');
    if (!r.ok) throw new PlexError('http', `Plex server responded with ${r.status}`);
    const txt = await r.text();
    if (!txt) return {};
    try { return JSON.parse(txt).MediaContainer || {}; } catch (e) { return {}; }
  }
  async sections() {
    const mc = await this.api('/library/sections', {}, 'GET', 15000);
    return (mc.Directory || []).filter((d) => d.type === 'artist').map((d) => ({ key: String(d.key), title: d.title, agent: d.agent }));
  }
  partUrl(t) {
    return `${this.cfg.base}${t.plex.part}?download=0&${this.q()}`;
  }
  // Server-side conversion to MP3 — the fallback for files the phone can't decode itself
  transcodeUrl(t) {
    return `${this.cfg.base}/music/:/transcode/universal/start.mp3?${this.q({
      path: `/library/metadata/${t.plex.key}`, mediaIndex: 0, partIndex: 0, protocol: 'http',
      directPlay: 0, directStream: 0, hasMDE: 1, musicBitrate: 320, audioBitrate: 320,
      session: `${clientId()}-${t.plex.key}`,
    })}`;
  }
  // A small copy just for measuring BPM / key / beats (a 96 kbps MP3 is ~3 MB instead of 30–100 MB of
  // FLAC), on its own transcode session so it never interrupts what's playing
  liteUrl(t) {
    return `${this.cfg.base}/music/:/transcode/universal/start.mp3?${this.q({
      path: `/library/metadata/${t.plex.key}`, mediaIndex: 0, partIndex: 0, protocol: 'http',
      directPlay: 0, directStream: 0, hasMDE: 1, musicBitrate: 96, audioBitrate: 96,
      session: `${clientId()}-an-${t.plex.key}`,
    })}`;
  }
  // Re-check the server address (e.g. after leaving home Wi-Fi). Returns true if the address changed.
  async reconnect() {
    if (!this.connected) return false;
    if (this._reconnecting) return this._reconnecting;
    const before = this.cfg.base;
    this._reconnecting = this.ensureConnection().then(() => this.cfg.base !== before).catch(() => false)
      .finally(() => { this._reconnecting = null; });
    return this._reconnecting;
  }
  artSrc(thumb, size = 640) {
    return `${this.cfg.base}/photo/:/transcode?${this.q({ width: size, height: size, minSize: 1, upscale: 1, url: thumb })}`;
  }

  // ---------- sync ----------
  async pageAll(path, params, onPage) {
    const size = 500;
    let start = 0, total = Infinity;
    const out = [];
    while (start < total) {
      const mc = await this.api(path, { ...params, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
      const items = mc.Metadata || [];
      total = mc.totalSize ?? (items.length < size ? start + items.length : Infinity);
      out.push(...items);
      start += items.length;
      onPage?.(out.length, total);
      if (!items.length) break;
    }
    return out;
  }

  // Your listening history from Plex (Plexamp and every other Plex app) → seeds Stats with years of plays
  async importHistory() {
    if (!this.connected) return 0;
    const byKey = new Map();
    for (const t of library.tracks.values()) if (t.plex?.key) byKey.set(String(t.plex.key), t);
    if (!byKey.size) return 0;
    const sections = this.cfg.sections?.length ? this.cfg.sections : (await this.sections()).map((x) => x.key);
    const out = [];
    for (const sec of sections) {
      let items = [];
      try { items = await this.pageAll('/status/sessions/history/all', { sort: 'viewedAt:desc', librarySectionID: sec }); } catch (e) { continue; }
      for (const it of items) {
        if (this.cfg.server.owned && it.accountID != null && +it.accountID !== 1) continue; // only your own plays
        const t = byKey.get(String(it.ratingKey));
        if (!t || !it.viewedAt) continue;
        out.push([t.id, +it.viewedAt, Math.round(t.duration || 180)]);
      }
    }
    await db.kv.set('plexHistory', { at: Date.now(), list: out });
    library.plexHistory = out;
    library.emit('stats');
    return out.length;
  }

  async sync() {
    if (this.running || !this.connected) return;
    this.running = true;
    const p = this.progress = { phase: 'Connecting to Plex', done: 0, total: 0, added: 0, removed: 0 };
    this.emit('progress', p);
    const slow = setTimeout(() => { if (p.phase === 'Connecting to Plex') { p.phase = 'Still connecting to your Plex server…'; this.emit('progress', p); } }, 8000);
    try {
      await Promise.race([
        this.ensureConnection(),
        sleep(30000).then(() => { throw new PlexError('unreachable', `Couldn’t reach “${this.cfg.server?.name || 'your server'}”. Check it’s on, then try Sync again.`); }),
      ]);
      clearTimeout(slow);
      const server = this.cfg.server;
      let sections = this.cfg.sections?.length ? this.cfg.sections : (await this.sections()).map((s) => s.key);
      if (!sections.length) throw new PlexError('nomusic', 'This server has no music libraries.');
      const existing = new Map((await db.all('tracks')).filter((t) => t.plex?.server === server.id).map((t) => [t.id, t]));
      const seen = new Set();
      const artRecs = new Map();
      await loadKnown();
      const knownArt = new Set(await db.keys('art'));
      const likes = new Set(library.likes);
      for (const sid of sections) {
        p.phase = 'Reading albums';
        this.emit('progress', p);
        const albums = new Map();
        for (const a of await this.pageAll(`/library/sections/${sid}/all`, { type: 9 })) {
          albums.set(String(a.ratingKey), {
            genre: (a.Genre || []).map((g) => g.tag).join('; '), year: a.year || 0, thumb: a.thumb, title: a.title,
            artist: a.parentTitle, loved: (a.userRating || 0) >= 8,
          });
        }
        // the artist's genres: the fallback for albums Plex has no genre for
        const artistG = new Map();
        try { for (const a of await this.pageAll(`/library/sections/${sid}/all`, { type: 8 })) artistG.set(String(a.ratingKey), (a.Genre || []).map((g) => g.tag).join('; ')); } catch (e) { /* older servers */ }
        p.phase = 'Reading songs';
        const items = await this.pageAll(`/library/sections/${sid}/all`, { type: 10 }, (n, total) => {
          p.done = n; p.total = isFinite(total) ? total : n; this.emit('progress', p);
        });
        const batch = [];
        for (const it of items) {
          const m = it.Media?.[0], part = m?.Part?.[0];
          if (!part?.key) continue;
          const id = 'px' + hash(server.id + ':' + it.ratingKey);
          seen.add(id);
          const al = albums.get(String(it.parentRatingKey));
          const thumb = it.parentThumb || al?.thumb || it.thumb || it.grandparentThumb;
          const artId = thumb ? 'px' + hash(server.id + thumb) : null;
          if (artId && !knownArt.has(artId)) artRecs.set(artId, { id: artId, src: thumb });
          const old = existing.get(id);
          const st = old?.plexStreamInfo ? old : null;
          const rec = {
            id, v: 2, src: 'plex',
            plex: { key: String(it.ratingKey), part: part.key, server: server.id, album: String(it.parentRatingKey || '') },
            url: `plex://${server.id}${part.key}`,
            size: part.size || 0,
            mtime: (it.updatedAt || 0) * 1000,
            added: (it.addedAt || 0) * 1000,
            title: it.title || 'Untitled',
            artist: it.originalTitle || it.grandparentTitle || 'Unknown Artist',
            albumArtist: it.grandparentTitle || '',
            album: it.parentTitle || 'Unknown Album',
            track: it.index || 0, trackTotal: 0,
            disc: it.parentIndex || 1, discTotal: 0,
            year: it.parentYear || al?.year || it.year || 0,
            genre: al?.genre || '',
            artistGenre: artistG.get(String(it.grandparentRatingKey)) || '',
            bpm: old?.bpm || 0,
            compilation: false,
            rgTrack: st?.rgTrack, rgAlbum: st?.rgAlbum, rgTrackPeak: st?.rgTrackPeak, rgAlbumPeak: st?.rgAlbumPeak,
            duration: (it.duration || m.duration || 0) / 1000,
            codec: codecName(m.audioCodec || part.container),
            sampleRate: st?.sampleRate || 0,
            bitDepth: st?.bitDepth || 0,
            channels: m.audioChannels || 0,
            bitrate: m.bitrate || 0,
            lyrics: '', lrc: '',
            artId,
            plexThumb: thumb || '',
            file: (part.file || '').split(/[\\/]/).pop() || '',
            plexStreamInfo: st?.plexStreamInfo || false,
            plexLyrics: st?.plexLyrics,
          };
          if ((it.userRating || 0) >= 8) likes.add(id);
          if (!old) p.added++;
          batch.push(rec);
          if (batch.length >= 400) { await db.putMany('tracks', batch.splice(0)); this.emit('batch'); }
        }
        await db.putMany('tracks', batch);
      }
      if (artRecs.size) await db.putMany('art', [...artRecs.values()]);
      const removed = [...existing.keys()].filter((id) => !seen.has(id));
      await db.delMany('tracks', removed);
      p.removed = removed.length;
      // loves from Plex
      library.likes = likes;
      await db.kv.set('likes', [...likes]);
      // playlists
      p.phase = 'Reading playlists';
      this.emit('progress', p);
      await this.syncPlaylists(server);
      p.phase = 'Done';
      this.cfg.lastSync = Date.now();
      await this.save();
      this.emit('progress', p);
      this.emit('done', p);
    } catch (e) {
      p.phase = 'Error';
      p.error = e.message;
      if (e.kind === 'auth') { this.cfg.expired = true; await this.save(); }
      this.emit('progress', p);
      this.emit('error', e);
    } finally {
      clearTimeout(slow);
      this.running = false;
    }
  }

  async syncPlaylists(server) {
    let mc;
    try { mc = await this.api('/playlists', { playlistType: 'audio' }); } catch (e) { return; }
    const keep = new Set();
    for (const pl of mc.Metadata || []) {
      if (pl.title === 'Player sync' || /^Player analysis( \(\d+\))?$/.test(pl.title)) continue; // where your Player account is kept (cloud.js), not music
      try {
        const items = await this.pageAll(`/playlists/${pl.ratingKey}/items`, {});
        const ids = items.map((it) => 'px' + hash(server.id + ':' + it.ratingKey));
        const id = 'pxpl' + hash(server.id + ':' + pl.ratingKey);
        keep.add(id);
        await db.put('playlists', {
          id, name: pl.title, trackIds: ids, source: 'plex', smart: !!pl.smart,
          created: (pl.addedAt || 0) * 1000, updated: (pl.updatedAt || 0) * 1000,
        });
      } catch (e) { /* skip one playlist */ }
    }
    for (const p of await db.all('playlists')) if (p.source === 'plex' && !keep.has(p.id)) await db.del('playlists', p.id);
  }

  // ---------- per-track details (audio format, loudness, lyrics) ----------
  async enrich(t) {
    if (!t?.plex || !this.connected) return t;
    if (t.plexStreamInfo) return t;
    if (this.enriched.has(t.id)) return this.enriched.get(t.id);
    const p = (async () => {
      try {
        const mc = await this.api(`/library/metadata/${t.plex.key}`);
        const it = mc.Metadata?.[0];
        const part = it?.Media?.[0]?.Part?.[0];
        const streams = part?.Stream || [];
        const audio = streams.find((s) => s.streamType === 2) || {};
        const lyr = streams.find((s) => s.streamType === 4);
        if (audio.samplingRate) t.sampleRate = audio.samplingRate;
        if (audio.bitDepth) t.bitDepth = audio.bitDepth;
        if (audio.channels) t.channels = audio.channels;
        if (audio.bitrate && !t.bitrate) t.bitrate = audio.bitrate;
        // Plex's own loudness analysis (same values Plexamp uses for leveling)
        if (audio.gain !== undefined) t.rgTrack = +audio.gain;
        if (audio.albumGain !== undefined) t.rgAlbum = +audio.albumGain;
        if (audio.peak !== undefined) t.rgTrackPeak = +audio.peak;
        if (audio.albumPeak !== undefined) t.rgAlbumPeak = +audio.albumPeak;
        if (lyr?.key) t.plexLyrics = { key: lyr.key, format: (lyr.format || lyr.codec || '').toLowerCase() };
        if (!t.genre && it?.Genre?.length) t.genre = it.Genre.map((g) => g.tag).join('; ');
        t.plexStreamInfo = true;
        await db.put('tracks', t);
        library.emit('analysis', t.id);
      } catch (e) { /* offline etc. */ }
      return t;
    })();
    this.enriched.set(t.id, p);
    return p;
  }
  async lyrics(t) {
    if (!this.connected) return null;
    try { await this.enrich(t); } catch (e) { return null; }
    if (!t.plexLyrics?.key) return null;
    try {
      const r = await fetch(`${this.cfg.base}${t.plexLyrics.key}?${this.q()}`, { headers: { Accept: 'text/plain' }, signal: withTimeout(8000) });
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { return null; }
  }

  // ---------- sync back to Plex ----------
  async scrobble(t) {
    if (!t?.plex || !this.connected || !settings.get('plexReport')) return;
    try { await this.api('/:/scrobble', { key: t.plex.key, identifier: 'com.plexapp.plugins.library' }); } catch (e) { /* */ }
  }
  async rate(t, on) {
    if (!t?.plex || !this.connected) return;
    try { await this.api('/:/rate', { key: t.plex.key, identifier: 'com.plexapp.plugins.library', rating: on ? 10 : -1 }, 'PUT'); } catch (e) { /* */ }
  }
  // "Now playing" in the Plex dashboard / other Plex apps
  async timeline(t, state, timeSec, durSec) {
    if (!t?.plex || !this.connected || !settings.get('plexReport')) return;
    const now = Date.now();
    if (state === 'playing' && now - this.timelineAt < 9000) return;
    this.timelineAt = now;
    try {
      await this.api('/:/timeline', {
        ratingKey: t.plex.key, key: `/library/metadata/${t.plex.key}`, state,
        time: Math.round(timeSec * 1000), duration: Math.round(durSec * 1000), hasMDE: 1,
      });
    } catch (e) { /* */ }
  }
}

export const plex = new Plex();
