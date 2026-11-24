// In-memory library model built from IndexedDB tracks.
import * as db from './db.js';
import { Emitter, hash, norm, sortKey, shuffleArr } from './util.js';
import { settings } from './settings.js';

const dirOf = (u) => u.replace(/[^/]*$/, '');
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
    const [tracks, pls, an, likes, stats, rs] = await Promise.all([
      db.all('tracks'), db.all('playlists'), db.all('analysis'),
      db.kv.get('likes'), db.kv.get('stats'), db.kv.get('recentSearches'),
    ]);
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
      const key = norm(t.album) + '|' + (aa ? norm(aa) : (t.demo ? norm(t.artist) : dirOf(t.url)));
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

  // ---- accessors ----
  track(id) { return this.tracks.get(id); }
  album(id) { return this.albums.get(id); }
  artist(id) { return this.artists.get(id); }
  get size() { return this.tracks.size; }

  bpmOf(t) {
    if (!t) return 0;
    const an = this.analysis.get(t.id);
    if (settings.get('preferBpmTag') && t.bpm) return t.bpm;
    return an?.bpm || t.bpm || 0;
  }

  sortedAlbums(sort = settings.get('albumSort')) {
    const list = [...this.albums.values()];
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
    return [...this.tracks.values()].sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
  }
  artistAlbums(ar) {
    return [...ar.albums].map((id) => this.albums.get(id)).filter(Boolean).sort((a, b) => b.year - a.year);
  }
  artistTopTracks(ar, n = 10) {
    const seen = new Set();
    return [...ar.tracks].filter((t) => !seen.has(t.id) && seen.add(t.id))
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
      const s = score([[t.title, 3], [t.artist, 1.5], [t.album, 1]]);
      if (s) tracks.push([s + (this.stats[t.id]?.p || 0) * 0.1, t]);
    }
    for (const a of this.albums.values()) {
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
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => this.albums.get(id)).filter(Boolean);
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
    const all = [...this.tracks.values()];
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
      if (exclude.has(t.id) || t.id === seed.id) continue;
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
