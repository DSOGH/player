// Walks the NAS, reads tags for new/changed files, and keeps the IndexedDB library in sync.
import * as db from './db.js';
import { makeSource } from './sources.js';
import { readTags } from './tags.js';
import { storeArt, loadKnown, hasArt } from './art.js';
import { hash, hashBytes, nasUrl, pool, Emitter } from './util.js';
import { settings } from './settings.js';

export const AUDIO_EXT = new Set(['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'alac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'webm', 'weba']);
const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const ext = (n) => (n.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const base = (n) => n.replace(/\.[^.]+$/, '');

function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

class Scanner extends Emitter {
  constructor() { super(); this.running = false; this.progress = null; }

  async run({ full = false } = {}) {
    if (this.running) return;
    const cfg = await db.kv.get('source');
    const src = makeSource(cfg);
    if (!src) return;
    this.running = true;
    this.abort = false;
    const p = this.progress = { phase: 'Looking for music', dirs: 0, found: 0, done: 0, total: 0, added: 0, removed: 0, errors: 0 };
    this.emit('progress', p);
    try {
      await loadKnown();
      const ignore = settings.get('ignoreFolders').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const artNames = settings.get('artNames').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

      // 1. walk
      const files = [];
      const folderArt = new Map();  // dir url -> image entry
      const lyricFiles = new Map(); // dir+basename -> lrc url
      const playlists = [];
      const seenDirs = new Set();
      const limit = limiter(4);
      const walk = async (dir) => {
        if (this.abort || seenDirs.has(dir)) return;
        seenDirs.add(dir);
        let entries;
        try { entries = await limit(() => src.list(dir)); } catch (e) {
          if (dir === cfg.url) throw e;
          p.errors++; return;
        }
        p.dirs++;
        const subdirs = [];
        let bestArt = null, bestScore = 99;
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name.startsWith('._')) continue;
          if (e.isDir) {
            if (ignore.includes(e.name.toLowerCase())) continue;
            subdirs.push(e.url);
            continue;
          }
          const x = ext(e.name);
          if (AUDIO_EXT.has(x)) { files.push({ ...e, dir }); p.found++; }
          else if (IMG_EXT.has(x)) {
            const b = base(e.name).toLowerCase();
            let score = artNames.indexOf(b);
            if (score < 0) score = artNames.some((n) => b.includes(n)) ? 50 : 90;
            if (score < bestScore) { bestScore = score; bestArt = e; }
          } else if (x === 'lrc') lyricFiles.set(dir + base(e.name).toLowerCase(), e.url);
          else if (x === 'm3u' || x === 'm3u8') playlists.push(e);
        }
        if (bestArt) folderArt.set(dir, bestArt);
        this.emit('progress', p);
        // walk subfolders (requests are capped by the limiter)
        await Promise.all(subdirs.map(walk));
      };
      await walk(cfg.url);
      if (this.abort) return;

      // 2. diff
      const existing = new Map((await db.all('tracks')).filter((t) => !t.plex).map((t) => [t.id, t]));
      const keep = new Set();
      const todo = [];
      for (const f of files) {
        const id = hash(f.url);
        keep.add(id);
        const old = existing.get(id);
        const lrc = lyricFiles.get(f.dir + base(f.name).toLowerCase()) || '';
        if (!full && old && old.size === f.size && (old.mtime === f.mtime || !f.mtime) && old.v === 2) {
          if (old.lrc !== lrc) { old.lrc = lrc; await db.put('tracks', old); }
          continue;
        }
        todo.push({ f, id, old, lrc });
      }
      const removed = [...existing.keys()].filter((id) => !keep.has(id) && !existing.get(id).demo && !existing.get(id).plex);
      await db.delMany('tracks', removed);
      p.removed = removed.length;
      p.total = todo.length;
      p.phase = todo.length ? 'Reading tags' : 'Up to date';
      this.emit('progress', p);

      // 3. read tags
      const batch = [];
      const folderArtDone = new Map();
      const flush = async () => {
        if (!batch.length) return;
        await db.putMany('tracks', batch.splice(0));
        this.emit('batch');
      };
      await pool(todo, 4, async ({ f, id, old, lrc }) => {
        if (this.abort) return;
        let meta = {};
        try { meta = await readTags(nasUrl(f.url, f.size), f.size, ext(f.name)); } catch (e) { p.errors++; meta = {}; }
        let artId = null;
        if (meta.picture) {
          artId = 'e' + hashBytes(meta.picture.data);
          if (!hasArt(artId)) artId = await storeArt(artId, new Blob([meta.picture.data], { type: meta.picture.mime }));
        }
        if (!artId && folderArt.has(f.dir)) {
          const img = folderArt.get(f.dir);
          if (!folderArtDone.has(f.dir)) {
            folderArtDone.set(f.dir, (async () => {
              const aid = 'f' + hash(img.url + img.size);
              if (hasArt(aid)) return aid;
              try {
                const r = await fetch(nasUrl(img.url, img.size));
                if (!r.ok) return null;
                return await storeArt(aid, await r.blob());
              } catch (e) { return null; }
            })());
          }
          artId = await folderArtDone.get(f.dir);
        }
        batch.push(buildTrack(f, id, meta, artId, lrc, cfg.url, old));
        p.done++;
        if (!old) p.added++;
        if (batch.length >= 25) await flush();
        this.emit('progress', p);
      });
      await flush();

      // 4. m3u playlists from the NAS
      if (playlists.length) await importM3U(playlists, files);

      p.phase = 'Done';
      await db.kv.set('lastScan', Date.now());
      this.emit('progress', p);
      this.emit('done', p);
    } catch (e) {
      p.phase = 'Error';
      p.error = e.message || String(e);
      this.emit('progress', p);
      this.emit('error', e);
    } finally {
      this.running = false;
    }
  }
  stop() { this.abort = true; }
}

function fromPath(url, root) {
  // Artist/Album/01 - Title.flac fallback
  let rel = decodeURIComponent(url.startsWith(root) ? url.slice(root.length) : new URL(url).pathname);
  const parts = rel.split('/').filter(Boolean);
  const file = base(parts.pop() || '');
  const album = parts.pop() || '';
  const artist = parts.pop() || '';
  const m = file.match(/^(?:(\d{1,2})[-.](\d{1,3})|(\d{1,3}))?[\s._-]*(?:(.+?)\s+-\s+)?(.+)$/);
  let track = 0, disc = 0, title = file, fArtist = '';
  if (m) {
    disc = m[1] ? +m[1] : 0;
    track = +(m[2] || m[3] || 0);
    fArtist = m[4] || '';
    title = m[5] || file;
  }
  return { title, album, artist: fArtist || artist, track, disc };
}

function buildTrack(f, id, meta, artId, lrc, root, old) {
  const fp = fromPath(f.url, root);
  const artist = meta.artist || meta.albumArtist || fp.artist || 'Unknown Artist';
  return {
    id, v: 2,
    url: f.url,
    size: meta.size || f.size || 0,
    mtime: f.mtime || 0,
    added: old?.added || f.mtime || Date.now(),
    title: meta.title || fp.title,
    artist,
    albumArtist: meta.albumArtist || '',
    album: meta.album || fp.album || 'Unknown Album',
    track: meta.track || fp.track || 0,
    trackTotal: meta.trackTotal || 0,
    disc: meta.disc || fp.disc || 1,
    discTotal: meta.discTotal || 0,
    year: meta.year || 0,
    genre: meta.genre || '',
    bpm: meta.bpm || 0,
    compilation: !!meta.compilation,
    rgTrack: meta.rgTrack, rgAlbum: meta.rgAlbum, rgTrackPeak: meta.rgTrackPeak, rgAlbumPeak: meta.rgAlbumPeak,
    duration: meta.duration || old?.duration || 0,
    codec: meta.codec || ext(f.name).toUpperCase(),
    sampleRate: meta.sampleRate || 0,
    bitDepth: meta.bitDepth || 0,
    channels: meta.channels || 0,
    bitrate: meta.bitrate || 0,
    lyrics: meta.lyrics ? meta.lyrics.slice(0, 20000) : '',
    lrc,
    artId: artId || null,
    file: f.name,
  };
}

async function importM3U(list, files) {
  const byPath = new Map(files.map((f) => [decodeURIComponent(new URL(f.url).pathname), hash(f.url)]));
  for (const pl of list) {
    try {
      const r = await fetch(nasUrl(pl.url));
      if (!r.ok) continue;
      const text = await r.text();
      const ids = [];
      for (let line of text.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        line = line.replace(/\\/g, '/');
        let abs;
        try { abs = decodeURIComponent(new URL(line, pl.url).pathname); } catch (e) { continue; }
        let id = byPath.get(abs);
        if (!id) {
          // match by trailing path segments (playlists made on another machine)
          const tail = line.split('/').slice(-3).join('/').toLowerCase();
          for (const [p, i] of byPath) if (p.toLowerCase().endsWith(tail)) { id = i; break; }
        }
        if (id) ids.push(id);
      }
      if (ids.length) {
        const id = 'm3u-' + hash(pl.url);
        const old = await db.get('playlists', id);
        await db.put('playlists', {
          id, name: base(pl.name), trackIds: ids, created: old?.created || Date.now(), updated: Date.now(), source: 'nas',
        });
      }
    } catch (e) { /* skip */ }
  }
}

export const scanner = new Scanner();
