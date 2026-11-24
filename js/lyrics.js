// Lyrics: .lrc next to the file (NAS) → Plex → embedded tags → online lookup by title + artist (LRCLIB).
// Results (including "not found") are cached on the device.
import * as db from './db.js';
import { nasUrl, norm } from './util.js';
import { plex } from './plex.js';
import { settings } from './settings.js';

const mem = new Map();
const inflight = new Map();
const MISS_TTL = 86400000; // retry songs without lyrics daily (LRCLIB grows)
const KEY = 'lyr2:';

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
// Plex can hand back its lyrics as XML (<Line startOffset><Span text/></Line>) instead of LRC text
function fromPlexXml(text) {
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const lines = [...doc.querySelectorAll('Line')].map((l) => ({
      t: l.hasAttribute('startOffset') ? +l.getAttribute('startOffset') / 1000 : NaN,
      text: [...l.querySelectorAll('Span')].map((sp) => sp.getAttribute('text') || '').join('').trim(),
    }));
    if (!lines.length) return null;
    const synced = lines.every((l) => isFinite(l.t));
    return { synced, lines: synced ? lines.sort((a, b) => a.t - b.t) : lines.map((l) => ({ t: 0, text: l.text })), source: 'Plex' };
  } catch (e) { return null; }
}
function fromText(text, source) {
  if (!text || !String(text).trim()) return null;
  if (/^\s*<\?xml|^\s*<MediaContainer/i.test(text)) return fromPlexXml(text);
  // drop LRC metadata lines ([ar:..], [ti:..], [offset:..]) but honour the offset
  const off = /\[offset:\s*([+-]?\d+)\]/i.exec(text);
  if (off) {
    const res = fromText(text.replace(/\[offset:[^\]]*\]/ig, ''), source);
    if (res?.synced) res.lines.forEach((l) => { l.t = Math.max(0, l.t + +off[1] / 1000); });
    return res;
  }
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

export function forgetLyrics(t) { if (t) { mem.delete(t.id); db.kv.set(KEY + t.id, null); } }

export async function getLyrics(t, { online = settings.get('onlineLyrics'), fresh = false } = {}) {
  if (!t) return null;
  if (!fresh && mem.has(t.id)) return mem.get(t.id);
  if (inflight.has(t.id)) return inflight.get(t.id);
  const p = (async () => {
    let netErr = false;
    let out = null, plain = null;
    const take = (res) => { if (!res) return; if (res.synced) { if (!out) out = res; } else if (!plain) plain = res; };
    if (t.lrc) {
      try { const r = await fetch(nasUrl(t.lrc)); if (r.ok) take(fromText(await r.text(), 'Lyrics file')); } catch (e) { netErr = true; }
    }
    if (!out && t.plex && plex.signedIn) {
      try { take(fromText(await plex.lyrics(t), 'Plex')); } catch (e) { netErr = true; }
    }
    if (!out && t.lyrics) take(fromText(t.lyrics, 'Embedded'));
    // only plain (unsynced) words so far → look online for a time-synced version
    if (!out && online && !t.demo) {
      const key = KEY + t.id;
      const c = fresh ? null : await db.kv.get(key);
      if (c && (c.found || Date.now() - c.at < MISS_TTL)) take(c.found ? c.data : null);
      else {
        const res = await lrclib(t);
        if (res === undefined) netErr = true;
        else await db.kv.set(key, { found: !!res, data: res, at: Date.now() });
        take(res);
      }
    }
    out = out || plain;
    // a network hiccup isn't "no lyrics": try again next time instead of remembering the miss
    if (out || !netErr) mem.set(t.id, out);
    return out;
  })();
  inflight.set(t.id, p);
  try { return await p; } finally { inflight.delete(t.id); }
}
