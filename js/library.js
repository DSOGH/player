// In-memory library model built from IndexedDB tracks.
import * as db from './db.js';
import { Emitter, hash, norm, sortKey, shuffleArr } from './util.js';
import { settings } from './settings.js';

const dirOf = (u) => u.replace(/[^/]*$/, '');

// ---- clean / explicit editions (works even when the server doesn't label them) ----
const ED_WORDS = 'explicit|clean|edited|dirty|censored|uncensored|clean version|explicit version|edited version|radio edit|clean edit|explicit edit';
const ED_TAG = new RegExp(`\\s*[\\[(](?:${ED_WORDS})[\\])]`, 'ig');
const ED_SUFFIX = /\s+-\s+(?:clean|explicit|edited)(?:\s+version)?\s*$/i;
export const stripEdition = (s) => String(s || '').replace(ED_TAG, '').replace(ED_SUFFIX, '').trim() || String(s || '');
function markerEdition(s) {
  const m = String(s || '').match(new RegExp(`[\\[(](${ED_WORDS})[\\])]|\\s-\\s(clean|explicit|edited)(?:\\s+version)?\\s*$`, 'i'));
  if (!m) return '';
  const w = (m[1] || m[2]).toLowerCase();
  return /explicit|dirty|uncensored/.test(w) ? 'explicit' : 'clean';
}
const CENSORED = /\b[a-z]+\*+[a-z]*\b|\b\*+[a-z]+/i; // F**k, s**t, *** — a clean edit
export function trackEdition(t) {
  if (t.advisory) return t.advisory;
  const m = markerEdition(t.title) || markerEdition(t.album) || markerEdition(decodeURIComponent((t.url || '').split('/').slice(-2, -1)[0] || '')) || markerEdition(t.file);
  if (m) return m;
  if (CENSORED.test(t.title)) return 'clean';
  return '';
}
const splitArtists = (s) => String(s || '').split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|;\s*/i).map((x) => x.trim()).filter(Boolean);

class Library extends Emitter {
  constructor() {
    super();
    this.tracks = new Map();
    this.albums = new Map();
    this.artists = new Map();
    this.genres = new Map();
    this.playlists = new Map();
    this.analysis = new Map();
    this.likes = new Set();
    this.stats = {};
    this.offline = new Set();
    this.recentSearches = [];
  }

  async load() {
    const [tracks, pls, an, likes, stats, rs, listen, mixes, edSet, edGuess] = await Promise.all([
      db.all('tracks'), db.all('playlists'), db.all('analysis'),
      db.kv.get('likes'), db.kv.get('stats'), db.kv.get('recentSearches'), db.kv.get('listen'), db.kv.get('mixes'),
      db.kv.get('editionSet'), db.kv.get('editionGuess'),
    ]);
    this.editionSet = edSet || {};     // your own choice per album (always wins)
    this.editionGuess = edGuess || {}; // worked out from lyrics / audio
    this.listen = listen || {};
    this.mixesDone = mixes || {};
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    this.playlists = new Map(pls.map((p) => [p.id, p]));
    this.analysis = new Map(an.map((a) => [a.id, a]));
    this.likes = new Set(likes || []);
    this.stats = stats || {};
    this.recentSearches = rs || [];
    await this.refreshOffline();
    this.build();
  }

  async reloadTracks() {
    const [tracks, pls] = await Promise.all([db.all('tracks'), db.all('playlists')]);
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    this.playlists = new Map(pls.map((p) => [p.id, p]));
    this.build();
  }

  // Cache key for downloads/preloads (Cache API needs an http(s) URL; Plex addresses change, so use a stable one)
  cacheKey(t) {
    if (t.plex) return new URL(`./__pc/${t.plex.server}${t.plex.part}`, location.href).href;
    return t.demo ? new URL(t.url, location.href).href : t.url;
  }
  isOffline(t) { return this.offline.has(this.cacheKey(t)); }
  async refreshOffline() {
    try {
      const c = await caches.open('offline-tracks');
      const ks = await c.keys();
      this.offline = new Set(ks.map((r) => r.url));
    } catch (e) { this.offline = new Set(); }
  }

  build() {
    const groupComp = settings.get('groupCompilations');
    const albums = new Map();
    for (const t of this.tracks.values()) {
      const aa = t.albumArtist || (t.compilation && groupComp ? 'Various Artists' : '');
      // editions (clean/explicit) and different releases stay separate albums: Plex album id, or the
      // album folder (disc folders like "CD1"/"Disc 2" count as the same album)
      const folder = t.plex ? 'px' + (t.plex.album || '') : t.demo ? '' : dirOf(t.url).replace(/\/(?:cd|disc|disk)[\s_-]*\d+\/$/i, '/');
      const key = norm(t.album) + '|' + (aa ? norm(aa) : (t.demo ? norm(t.artist) : '')) + '|' + folder;
      const id = 'al' + hash(key);
      t.albumId = id;
      let a = albums.get(id);
      if (!a) {
        a = { id, title: t.album, artist: aa, tracks: [], year: 0, genre: '', artId: null, added: 0, duration: 0, artistsSeen: new Set() };
        albums.set(id, a);
      }
      a.tracks.push(t);
      a.artistsSeen.add(t.artist);
      a.year = Math.max(a.year, t.year || 0);
      a.genre ||= t.genre;
      a.artId ||= t.artId;
      a.added = Math.max(a.added, t.added || 0);
      a.duration += t.duration || 0;
      if (t.codec) a.codec ||= t.codec;
      a.hires = a.hires || (t.bitDepth >= 24 || t.sampleRate > 48000);
      a.lossless = (a.lossless ?? true) && ['FLAC', 'ALAC', 'WAV'].includes(t.codec);
    }
    const artists = new Map();
    const addArtist = (name, album, primary) => {
      if (!name) return;
      const id = 'ar' + hash(norm(name));
      let ar = artists.get(id);
      if (!ar) { ar = { id, name, albums: new Set(), appears: new Set(), tracks: [], artId: null }; artists.set(id, ar); }
      (primary ? ar.albums : ar.appears).add(album.id);
      if (primary && !ar.artId) ar.artId = album.artId;
      return ar;
    };
    for (const a of albums.values()) {
      if (!a.artist) a.artist = a.artistsSeen.size === 1 ? [...a.artistsSeen][0] : (a.artistsSeen.size > 3 ? 'Various Artists' : [...a.artistsSeen][0]);
      delete a.artistsSeen;
      a.tracks.sort((x, y) => (x.disc || 1) - (y.disc || 1) || (x.track || 999) - (y.track || 999) || sortKey(x.title).localeCompare(sortKey(y.title)));
      a.discs = new Set(a.tracks.map((t) => t.disc || 1)).size;
      a.artistId = 'ar' + hash(norm(a.artist));
      addArtist(a.artist, a, true);
      for (const t of a.tracks) {
        for (const n of splitArtists(t.artist)) {
          const ar = addArtist(n, a, norm(n) === norm(a.artist));
          ar.tracks.push(t);
        }
        t.artistId = 'ar' + hash(norm(splitArtists(t.artist)[0] || t.artist));
      }
    }
    for (const ar of artists.values()) {
      for (const id of ar.albums) ar.appears.delete(id);
      if (!ar.artId) { const first = albums.get([...ar.appears][0]); ar.artId = first?.artId || null; }
    }
    this.groupEditions(albums);
    this.plexThumbs = new Map();
    for (const t of this.tracks.values()) if (t.plexThumb && t.artId) this.plexThumbs.set(t.artId, t.plexThumb);
    const genres = new Map();
    for (const t of this.tracks.values()) {
      for (const g of String(t.genre || '').split(/[;,/]/).map((s) => s.trim()).filter(Boolean)) {
        const k = norm(g);
        let G = genres.get(k);
        if (!G) { G = { id: k, name: g, tracks: [], albums: new Set() }; genres.set(k, G); }
        G.tracks.push(t);
        G.albums.add(t.albumId);
      }
    }
    this.albums = albums;
    this.artists = artists;
    this.genres = genres;
    this.emit('change');
  }

  // Pair up clean/explicit editions of the same album and decide which one to show.
  groupEditions(albums) {
    const groups = new Map();
    for (const a of albums.values()) {
      a.rawTitle = a.rawTitle || a.title;
      const counts = { explicit: 0, clean: 0 };
      for (const t of a.tracks) { const e = trackEdition(t); t.edition = e; if (e) counts[e]++; }
      a.edition = this.editionSet?.[a.id] || markerEdition(a.rawTitle) || (counts.explicit > counts.clean ? 'explicit' : counts.clean > counts.explicit ? 'clean' : '') || this.editionGuess?.[a.id] || '';
      if (this.editionSet?.[a.id]) for (const t of a.tracks) t.edition = a.edition;
      if (a.edition) for (const t of a.tracks) if (!t.edition) t.edition = a.edition;
      a.title = stripEdition(a.rawTitle);
      const k = norm(a.title) + '|' + norm(a.artist);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    const pref = settings.get('explicitPref');
    this.hiddenAlbums = new Set();
    this.hiddenTracks = new Set();
    for (const g of groups.values()) {
      if (g.length < 2) { g[0].editions = null; continue; }
      // infer the unlabeled one from the labeled one; else the one with censored titles is clean
      const known = g.filter((a) => a.edition);
      if (known.length === 1 && g.length === 2) g.find((a) => !a.edition).edition = known[0].edition === 'clean' ? 'explicit' : 'clean';
      if (!known.length && g.length === 2) {
        const stars = g.map((a) => a.tracks.filter((t) => /\*/.test(t.title)).length);
        if (stars[0] !== stars[1]) { g[stars[0] > stars[1] ? 0 : 1].edition = 'clean'; g[stars[0] > stars[1] ? 1 : 0].edition = 'explicit'; }
      }
      for (const a of g) {
        a.editions = g.map((x) => ({ id: x.id, edition: x.edition || 'version' }));
        for (const t of a.tracks) if (!t.edition && a.edition) t.edition = a.edition;
      }
      if (pref === 'both') continue;
      const keep = g.find((a) => a.edition === pref) || g.find((a) => a.edition && a.edition !== (pref === 'clean' ? 'explicit' : 'clean')) || g[0];
      for (const a of g) if (a !== keep && a.edition !== keep.edition) { this.hiddenAlbums.add(a.id); a.tracks.forEach((t) => this.hiddenTracks.add(t.id)); }
    }
  }
  visible(t) { return !this.hiddenTracks?.has(t.id); }

  // You know best: mark an album as the clean or explicit version
  async setEdition(albumId, ed) {
    if (ed) this.editionSet[albumId] = ed; else delete this.editionSet[albumId];
    await db.kv.set('editionSet', this.editionSet);
    this.build();
    this.emit('change');
  }
  // Two versions of an album and nothing says which is which: work it out from each version's own
  // lyrics (swear words vs. censored ones) and, failing that, from the audio (clean edits drop out
  // where words were removed).
  async resolveEditions({ lyricsOf } = {}) {
    const PROF = /\b(fuck\w*|motherf\w*|shit\w*|bitch\w*|nigga\w*|pussy|dick|cunt|whore)\b/i;
    const CENS = /\b[a-z]+\*+[a-z]*\b|\b\*+[a-z]+|\b[a-z]\*\*\*/i;
    const groups = new Map();
    for (const a of this.albums.values()) {
      if (!a.editions || a.editions.length !== 2) continue;
      const k = a.editions.map((e) => e.id).sort().join('|');
      if (!groups.has(k)) groups.set(k, a.editions.map((e) => this.albums.get(e.id)).filter(Boolean));
    }
    let changed = false;
    for (const g of groups.values()) {
      if (g.length !== 2 || g.some((a) => this.editionSet[a.id]) || (g[0].edition && g[1].edition && g[0].edition !== g[1].edition && !this.editionGuess[g[0].id])) continue;
      // 1) lyrics that belong to each file
      const score = [0, 0];
      if (lyricsOf) {
        for (let i = 0; i < 2; i++) {
          for (const t of g[i].tracks.slice(0, 6)) {
            let txt = '';
            try { txt = (await lyricsOf(t)) || ''; } catch (e) { /* */ }
            if (PROF.test(txt)) score[i] += 2;
            if (CENS.test(txt)) score[i] -= 2;
          }
        }
      }
      // 2) audio: matching songs in both versions, where one version suddenly drops in loudness
      if (score[0] === score[1]) {
        for (const t0 of g[0].tracks) {
          const t1 = g[1].tracks.find((x) => norm(x.title) === norm(t0.title));
          const A = this.analysis.get(t0.id)?.loud, B = t1 && this.analysis.get(t1.id)?.loud;
          if (!A || !B || Math.abs(A.length - B.length) > 6) continue;
          let dA = 0, dB = 0;
          for (let i = 1; i < Math.min(A.length, B.length) - 1; i++) {
            if (B[i] - A[i] > 22 && B[i - 1] - A[i - 1] < 10) dA++; // short dip in version 0
            if (A[i] - B[i] > 22 && A[i - 1] - B[i - 1] < 10) dB++;
          }
          if (dA >= 2 && dA > dB * 2) score[0] -= 1; else if (dB >= 2 && dB > dA * 2) score[1] -= 1;
        }
      }
      if (score[0] === score[1]) continue;
      const ex = score[0] > score[1] ? 0 : 1;
      this.editionGuess[g[ex].id] = 'explicit';
      this.editionGuess[g[1 - ex].id] = 'clean';
      changed = true;
    }
    if (changed) { await db.kv.set('editionGuess', this.editionGuess); this.build(); this.emit('change'); }
    return changed;
  }

  // ---- accessors ----
  track(id) { return this.tracks.get(id); }
  album(id) { return this.albums.get(id); }
  artist(id) { return this.artists.get(id); }
  get size() { return this.tracks.size; }

  bpmOf(t) {
    if (!t) return 0;
    const an = this.analysis.get(t.id);
    // tapped or online-confirmed tempos are the truth; then your tags; then what the audio says
    if (an?.bpm && (an.tapped || an.bpmSrc === 'online')) return an.bpm;
    if (settings.get('preferBpmTag') && t.bpm) return t.bpm;
    return an?.bpm || t.bpm || 0;
  }

  sortedAlbums(sort = settings.get('albumSort')) {
    const list = [...this.albums.values()].filter((a) => !this.hiddenAlbums?.has(a.id));
    const by = {
      title: (a, b) => sortKey(a.title).localeCompare(sortKey(b.title)),
      artist: (a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || (a.year - b.year),
      year: (a, b) => (b.year - a.year) || sortKey(a.title).localeCompare(sortKey(b.title)),
      added: (a, b) => b.added - a.added,
    }[sort] || ((a, b) => 0);
    return list.sort(by);
  }
  sortedArtists() {
    return [...this.artists.values()].filter((a) => a.albums.size || a.tracks.length)
      .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
  }
  sortedTracks() {
    return [...this.tracks.values()].filter((t) => this.visible(t)).sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
  }
  artistAlbums(ar) {
    return [...ar.albums].filter((id) => !this.hiddenAlbums?.has(id)).map((id) => this.albums.get(id)).filter(Boolean).sort((a, b) => b.year - a.year);
  }
  artistTopTracks(ar, n = 10) {
    const seen = new Set();
    return [...ar.tracks].filter((t) => this.visible(t) && !seen.has(t.id) && seen.add(t.id))
      .sort((a, b) => (this.stats[b.id]?.p || 0) - (this.stats[a.id]?.p || 0) || (this.likes.has(b.id) - this.likes.has(a.id)))
      .slice(0, n);
  }

  // ---- search ----
  search(q) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    const score = (fields) => {
      let s = 0;
      for (const term of terms) {
        let best = 0;
        for (const [txt, w] of fields) {
          const n = norm(txt);
          if (!n) continue;
          if (n === term) best = Math.max(best, 10 * w);
          else if (n.startsWith(term)) best = Math.max(best, 6 * w);
          else if (n.includes(' ' + term)) best = Math.max(best, 4 * w);
          else if (n.includes(term)) best = Math.max(best, 2 * w);
        }
        if (!best) return 0;
        s += best;
      }
      return s;
    };
    const tracks = [], albums = [], artists = [];
    for (const t of this.tracks.values()) {
      if (!this.visible(t)) continue;
      const s = score([[t.title, 3], [t.artist, 1.5], [t.album, 1]]);
      if (s) tracks.push([s + (this.stats[t.id]?.p || 0) * 0.1, t]);
    }
    for (const a of this.albums.values()) {
      if (this.hiddenAlbums?.has(a.id)) continue;
      const s = score([[a.title, 3], [a.artist, 1.5]]);
      if (s) albums.push([s, a]);
    }
    for (const a of this.artists.values()) {
      const s = score([[a.name, 3]]);
      if (s) artists.push([s + a.albums.size * 0.2, a]);
    }
    const pls = [...this.playlists.values()].filter((p) => score([[p.name, 1]]));
    const srt = (arr) => arr.sort((a, b) => b[0] - a[0]).map((x) => x[1]);
    const T = srt(tracks), A = srt(albums), R = srt(artists);
    const cand = [[R[0], (artists[0]?.[0] || 0) * 1.1, 'artist'], [A[0], albums[0]?.[0] || 0, 'album'], [T[0], tracks[0]?.[0] || 0, 'track']]
      .filter((c) => c[0]).sort((a, b) => b[1] - a[1]);
    return { top: cand[0] ? { kind: cand[0][2], item: cand[0][0] } : null, tracks: T.slice(0, 50), albums: A.slice(0, 30), artists: R.slice(0, 20), playlists: pls };
  }
  addRecentSearch(q) {
    q = q.trim();
    if (!q) return;
    this.recentSearches = [q, ...this.recentSearches.filter((x) => x !== q)].slice(0, 10);
    db.kv.set('recentSearches', this.recentSearches);
  }

  // ---- likes / stats ----
  toggleLike(id) {
    if (this.likes.has(id)) this.likes.delete(id); else this.likes.add(id);
    db.kv.set('likes', [...this.likes]);
    this.emit('likes');
    this.emit('liked', id, this.likes.has(id));
    return this.likes.has(id);
  }
  // listening stats: seconds per day + DJ mixes
  addListening(sec, id = null) {
    const day = new Date().toISOString().slice(0, 10);
    const L = this.listen || (this.listen = {});
    L[day] = (L[day] || 0) + sec;
    if (id) this.logListen(id, sec);
    if (!this._lsave || Date.now() - this._lsave > 15000) { this._lsave = Date.now(); db.kv.set('listen', L); this.saveLog(); }
  }

  // ---- play log (for Stats): one entry per listen [trackId, startedAt (s), secondsListened], kept per month ----
  logListen(id, sec) {
    const cur = this._curListen;
    if (!cur || cur[0] !== id || Date.now() / 1000 - (cur[1] + cur[2]) > 600) {
      this.flushListen();
      this._curListen = [id, Math.round(Date.now() / 1000 - sec), 0];
    }
    this._curListen[2] += sec;
  }
  flushListen() {
    const c = this._curListen;
    this._curListen = null;
    if (!c || c[2] < 20) return; // under 20 s doesn't count as a listen
    c[2] = Math.round(c[2]);
    const m = new Date(c[1] * 1000).toISOString().slice(0, 7);
    const log = this.playLog || (this.playLog = {});
    (log[m] || (log[m] = [])).push(c);
    this._dirtyMonths = (this._dirtyMonths || new Set()).add(m);
    this.saveLog();
  }
  saveLog() {
    // persist the song in progress too, so a closed app never loses it
    const c = this._curListen;
    db.kv.set('listen:cur', c && c[2] >= 20 ? c : null);
    // never write a month before the saved history is loaded — that would replace it with just this session
    if (!this._logLoaded) { this.loadPlayLog().then(() => this.saveLog()); return; }
    for (const m of this._dirtyMonths || []) db.kv.set('plays:' + m, this.playLog[m]);
    this._dirtyMonths = new Set();
  }
  async loadPlayLog() {
    if (this._logLoaded) return this.playLog;
    if (this._logLoading) return this._logLoading;
    this._logLoading = this._loadPlayLog().finally(() => { this._logLoading = null; });
    return this._logLoading;
  }
  async _loadPlayLog() {
    const keys = (await db.keys('kv')).filter((k) => String(k).startsWith('plays:'));
    const log = {};
    await Promise.all(keys.map(async (k) => { log[k.slice(6)] = (await db.kv.get(k)) || []; }));
    // merge with anything recorded this session before the log was loaded
    for (const [m, arr] of Object.entries(this.playLog || {})) {
      const have = new Set((log[m] || []).map((e) => e[0] + ':' + e[1]));
      log[m] = [...(log[m] || []), ...arr.filter((e) => !have.has(e[0] + ':' + e[1]))];
    }
    const pending = await db.kv.get('listen:cur');
    if (pending && !this._curListen) {
      const m = new Date(pending[1] * 1000).toISOString().slice(0, 7);
      const arr = log[m] || (log[m] = []);
      if (!arr.some((e) => e[0] === pending[0] && e[1] === pending[1])) arr.push(pending);
      db.kv.set('plays:' + m, arr); db.kv.set('listen:cur', null);
    }
    this.playLog = log;
    this._logLoaded = true;
    for (const m of Object.keys(this.playLog)) if ((this._dirtyMonths || new Set()).has(m)) db.kv.set('plays:' + m, this.playLog[m]);
    this._dirtyMonths = new Set();
    return log;
  }
  addMix(style) {
    const M = this.mixesDone || (this.mixesDone = {});
    const day = new Date().toISOString().slice(0, 10);
    M[day] = (M[day] || 0) + 1;
    M['style:' + style] = (M['style:' + style] || 0) + 1;
    db.kv.set('mixes', M);
  }
  weekStats() {
    const days = [...Array(7)].map((_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const sec = days.reduce((s, d) => s + (this.listen?.[d] || 0), 0);
    const mixes = days.reduce((s, d) => s + (this.mixesDone?.[d] || 0), 0);
    const weekAgo = Date.now() - 7 * 86400000;
    const artists = new Map();
    let plays = 0;
    for (const [id, st] of Object.entries(this.stats)) {
      if (st.l < weekAgo) continue;
      const t = this.tracks.get(id);
      if (!t) continue;
      plays++;
      artists.set(t.artistId, (artists.get(t.artistId) || 0) + 1);
    }
    const top = [...artists.entries()].sort((a, b) => b[1] - a[1])[0];
    return { minutes: Math.round(sec / 60), mixes, plays, topArtist: top ? this.artists.get(top[0]) : null, byDay: days.map((d) => Math.round((this.listen?.[d] || 0) / 60)).reverse() };
  }
  recordPlay(id) {
    const s = this.stats[id] || { p: 0, l: 0 };
    s.p++; s.l = Date.now();
    this.stats[id] = s;
    db.kv.set('stats', this.stats);
    this.emit('played', id);
  }
  recentAlbums(n = 12) {
    const seen = new Map();
    for (const [id, s] of Object.entries(this.stats)) {
      const t = this.tracks.get(id);
      if (!t) continue;
      seen.set(t.albumId, Math.max(seen.get(t.albumId) || 0, s.l));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => this.albums.get(id)).filter((a) => a && !this.hiddenAlbums?.has(a.id)).slice(0, n);
  }
  mostPlayed(n = 25) {
    return Object.entries(this.stats).sort((a, b) => b[1].p - a[1].p).slice(0, n)
      .map(([id]) => this.tracks.get(id)).filter(Boolean);
  }
  recentlyAdded(n = 20) { return this.sortedAlbums('added').slice(0, n); }
  recentlyPlayed(n = 100) {
    return Object.entries(this.stats).sort((a, b) => b[1].l - a[1].l).slice(0, n)
      .map(([id]) => this.tracks.get(id)).filter(Boolean);
  }

  // ---- playlists ----
  async savePlaylist(p) {
    p.updated = Date.now();
    this.playlists.set(p.id, p);
    await db.put('playlists', p);
    this.emit('playlists');
  }
  async createPlaylist(name, trackIds = []) {
    const p = { id: 'pl' + Date.now().toString(36), name, trackIds, created: Date.now() };
    await this.savePlaylist(p);
    return p;
  }
  async deletePlaylist(id) {
    this.playlists.delete(id);
    await db.del('playlists', id);
    this.emit('playlists');
  }
  playlistTracks(p) { return p.trackIds.map((id) => this.tracks.get(id)).filter(Boolean); }

  // ---- analysis ----
  setAnalysis(a) {
    this.analysis.set(a.id, a);
    db.put('analysis', a);
    this.emit('analysis', a.id);
  }

  // ---- mixes ----
  mixes() {
    const out = [];
    const all = [...this.tracks.values()];
    if (!all.length) return out;
    const withBpm = all.filter((t) => this.bpmOf(t));
    if (withBpm.length >= 8) {
      const bands = [
        { id: 'bpm-chill', name: 'Chill', sub: 'Under 100 BPM', test: (b) => b < 100, colors: ['#3a7bd5', '#00d2ff'] },
        { id: 'bpm-groove', name: 'Groove', sub: '100–124 BPM', test: (b) => b >= 100 && b < 125, colors: ['#8e2de2', '#f000ff'] },
        { id: 'bpm-energy', name: 'Energy', sub: '125+ BPM', test: (b) => b >= 125, colors: ['#f12711', '#f5af19'] },
      ];
      for (const b of bands) {
        const n = withBpm.filter((t) => b.test(this.bpmOf(t))).length;
        if (n >= 4) out.push({ ...b, count: n, kind: 'bpm' });
      }
    }
    const gs = [...this.genres.values()].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 6);
    const palette = [['#ff512f', '#dd2476'], ['#1d976c', '#93f9b9'], ['#4568dc', '#b06ab3'], ['#f7971e', '#ffd200'], ['#00b09b', '#96c93d'], ['#c33764', '#1d2671']];
    gs.forEach((g, i) => out.push({ id: 'genre-' + g.id, name: g.name + ' Mix', sub: `${g.tracks.length} songs`, colors: palette[i % palette.length], kind: 'genre', genre: g.id }));
    out.push({ id: 'discover', name: 'Deep Cuts', sub: 'Songs you rarely play', colors: ['#232526', '#6a6a6a'], kind: 'discover' });
    return out;
  }
  mixTracks(mix, n = 60) {
    const all = [...this.tracks.values()].filter((t) => this.visible(t));
    let pool = all;
    if (mix.kind === 'bpm') {
      const b = this.mixes().find((m) => m.id === mix.id) || mix;
      const test = { 'bpm-chill': (x) => x < 100, 'bpm-groove': (x) => x >= 100 && x < 125, 'bpm-energy': (x) => x >= 125 }[mix.id] || b.test;
      pool = all.filter((t) => { const x = this.bpmOf(t); return x && test(x); });
      return this.flowOrder(shuffleArr(pool).slice(0, n));
    }
    if (mix.kind === 'genre') pool = this.genres.get(mix.genre)?.tracks || [];
    if (mix.kind === 'discover') pool = all.filter((t) => (this.stats[t.id]?.p || 0) < 2);
    return shuffleArr([...pool]).slice(0, n);
  }
  // Greedy BPM-flow ordering: each next track is close in tempo to the previous one
  flowOrder(list, first = null) {
    const rest = [...list];
    const out = [];
    let cur = first || rest.shift();
    if (!first && cur) out.push(cur);
    while (rest.length) {
      const b = this.bpmOf(cur) || 120;
      let bi = 0, bs = Infinity;
      for (let i = 0; i < rest.length; i++) {
        let x = this.bpmOf(rest[i]) || 120;
        if (x > b * 1.5) x /= 2; else if (x < b / 1.5) x *= 2;
        const s = Math.abs(x - b) + Math.random() * 6;
        if (s < bs) { bs = s; bi = i; }
      }
      cur = rest.splice(bi, 1)[0];
      out.push(cur);
    }
    return out;
  }
  // Similar-music radio for autoplay
  radioFrom(seed, exclude = new Set(), n = 25) {
    if (!seed) return shuffleArr([...this.tracks.values()]).slice(0, n);
    const b = this.bpmOf(seed);
    const scored = [];
    for (const t of this.tracks.values()) {
      if (exclude.has(t.id) || t.id === seed.id || !this.visible(t)) continue;
      let s = Math.random() * 2;
      if (t.genre && seed.genre && norm(t.genre) === norm(seed.genre)) s += 4;
      if (t.artistId === seed.artistId) s += 2.5;
      if (t.albumId === seed.albumId) s += 1;
      const tb = this.bpmOf(t);
      if (b && tb) s += Math.max(0, 3 - Math.abs(tb - b) / 6);
      if (t.year && seed.year) s += Math.max(0, 1.5 - Math.abs(t.year - seed.year) / 8);
      if (this.likes.has(t.id)) s += 1;
      scored.push([s, t]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, n * 2).map((x) => x[1]).sort(() => Math.random() - 0.5).slice(0, n);
  }
}

export const library = new Library();
