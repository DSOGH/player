// Lyrics: .lrc next to the file (NAS) → Plex → embedded tags → online lookup by title + artist (LRCLIB).
// Results (including "not found") are cached on the device.
import * as db from './db.js';
import { nasUrl, norm } from './util.js';
import { plex } from './plex.js';
import { settings } from './settings.js';

const mem = new Map();
const inflight = new Map();
const MISS_TTL = 7 * 86400000;

export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    const txt = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text: txt });
  }
  return lines.sort((a, b) => a.t - b.t);
}
function fromText(text, source) {
  if (!text) return null;
  const lines = parseLrc(text);
  if (lines.length) return { synced: true, lines, source };
  return { synced: false, lines: text.split(/\r?\n/).map((l) => ({ t: 0, text: l.trim() })), source };
}

// "Song (feat. X) - Remastered 2011 [Explicit]" → "Song"
export function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*[([](?:feat|ft|with|prod)\.?[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([][^)\]]*(?:remaster|version|edit|mix|live|explicit|clean|mono|stereo|deluxe|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(?:remaster|version|edit|mix|live|mono|stereo).*$/i, '')
    .replace(/^\d{1,3}[\s.\-_]+/, '')
    .trim();
}
export function mainArtist(s) {
  return String(s || '').split(/\s+(?:feat\.?|ft\.?|featuring|with|x|&|and)\s+|,|;|\//i)[0].trim();
}

async function lrclib(t) {
  const title = cleanTitle(t.title), artist = mainArtist(t.albumArtist || t.artist);
  if (!title || !artist || /^unknown/i.test(artist)) return null;
  const base = localStorage.getItem('lrclibBase') || 'https://lrclib.net';
  const pick = (j) => j && (j.syncedLyrics ? fromText(j.syncedLyrics, 'LRCLIB') : j.plainLyrics ? fromText(j.plainLyrics, 'LRCLIB') : null);
  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    if (t.album && !/^unknown/i.test(t.album)) q.set('album_name', t.album);
    if (t.duration) q.set('duration', Math.round(t.duration));
    const r = await fetch(`${base}/api/get?${q}`);
    if (r.ok) { const res = pick(await r.json()); if (res) return res; }
    // fuzzy search: closest duration wins, synced preferred
    const r2 = await fetch(`${base}/api/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
    if (!r2.ok) return null;
    const list = (await r2.json()) || [];
    const nt = norm(title);
    const scored = list.filter((x) => norm(x.trackName).includes(nt) || nt.includes(norm(x.trackName)))
      .map((x) => [(t.duration ? Math.abs((x.duration || 0) - t.duration) : 0) - (x.syncedLyrics ? 5 : 0), x])
      .filter(([s]) => s < 8)
      .sort((a, b) => a[0] - b[0]);
    return scored.length ? pick(scored[0][1]) : null;
  } catch (e) {
    return undefined; // network error: don't cache a miss
  }
}

export function cachedLyrics(t) { return mem.get(t.id) || null; }

export async function getLyrics(t, { online = settings.get('onlineLyrics') } = {}) {
  if (!t) return null;
  if (mem.has(t.id)) return mem.get(t.id);
  if (inflight.has(t.id)) return inflight.get(t.id);
  const p = (async () => {
    let out = null;
    if (t.lrc) {
      try { const r = await fetch(nasUrl(t.lrc)); if (r.ok) out = fromText(await r.text(), 'Lyrics file'); } catch (e) { /* */ }
      if (out && !out.synced) out = null;
    }
    if (!out && t.plex) out = fromText(await plex.lyrics(t), 'Plex');
    if (!out && t.lyrics) {
      const emb = fromText(t.lyrics, 'Embedded');
      if (emb?.synced) out = emb; else out = out || null;
      if (!out && !online) out = emb;
    }
    if (!out && online && !t.demo) {
      const key = 'lyr:' + t.id;
      const c = await db.kv.get(key);
      if (c && (c.found || Date.now() - c.at < MISS_TTL)) out = c.found ? c.data : null;
      else {
        const res = await lrclib(t);
        if (res !== undefined) await db.kv.set(key, { found: !!res, data: res, at: Date.now() });
        out = res || null;
      }
    }
    if (!out && t.lyrics) out = fromText(t.lyrics, 'Embedded');
    if (out) mem.set(t.id, out);
    else mem.set(t.id, null);
    return out;
  })();
  inflight.set(t.id, p);
  try { return await p; } finally { inflight.delete(t.id); }
}
