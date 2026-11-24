// Listening stats (stats.fm-style): built from the on-device play log + your Plex history.
import { library } from './library.js';
import * as db from './db.js';

const DAY = 86400;
export const RANGES = [['4w', '4 weeks'], ['6m', '6 months'], ['1y', '12 months'], ['all', 'All time']];

function rangeStart(r, now) {
  return { '4w': now - 28 * DAY, '6m': now - 182 * DAY, '1y': now - 365 * DAY }[r] ?? 0;
}
const dayKey = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export async function allListens() {
  const log = await library.loadPlayLog();
  if (!library.plexHistory) library.plexHistory = (await db.kv.get('plexHistory'))?.list || [];
  const local = Object.values(log).flat();
  if (library._curListen && library._curListen[2] >= 20) local.push([...library._curListen]);
  // Plex history overlaps with plays this app reported to Plex: drop duplicates (same song within 15 min)
  const seen = new Map();
  for (const e of local) { const a = seen.get(e[0]) || []; a.push(e[1]); seen.set(e[0], a); }
  const plex = library.plexHistory.filter((e) => !(seen.get(e[0]) || []).some((t) => Math.abs(t - e[1]) < 900));
  return [...local, ...plex].filter((e) => library.track(e[0])).sort((a, b) => a[1] - b[1]);
}

export async function computeStats(range = '4w') {
  const all = await allListens();
  const now = Date.now() / 1000;
  const from = rangeStart(range, now);
  const span = now - (from || (all[0]?.[1] ?? now));
  const inR = all.filter((e) => e[1] >= from);
  const prev = from ? all.filter((e) => e[1] >= from - (now - from) && e[1] < from) : [];

  const sum = (list) => list.reduce((s, e) => s + e[2], 0);
  const tally = (list, keyOf) => {
    const m = new Map();
    for (const e of list) {
      const t = library.track(e[0]);
      for (const k of [].concat(keyOf(t) || [])) {
        const v = m.get(k) || { key: k, plays: 0, sec: 0, first: e[1], last: e[1] };
        v.plays++; v.sec += e[2]; v.last = Math.max(v.last, e[1]); v.first = Math.min(v.first, e[1]);
        m.set(k, v);
      }
    }
    return [...m.values()].sort((a, b) => b.plays - a.plays || b.sec - a.sec);
  };

  const tracks = tally(inR, (t) => t.id).map((v) => ({ ...v, track: library.track(v.key) }));
  const artists = tally(inR, (t) => t.artistId).map((v) => ({ ...v, artist: library.artists.get(v.key) })).filter((v) => v.artist);
  const albums = tally(inR, (t) => t.albumId).map((v) => ({ ...v, album: library.album(v.key) })).filter((v) => v.album);
  const genres = tally(inR, (t) => (t.genre ? String(t.genre).split(/[;,/]/).map((g) => g.trim()).filter(Boolean).slice(0, 2) : [])).slice(0, 8);
  const decades = tally(inR, (t) => (t.year ? `${Math.floor(t.year / 10) * 10}s` : null)).sort((a, b) => a.key.localeCompare(b.key));

  // timeline: daily (4 weeks), weekly (6 months), monthly (longer)
  const bucket = range === '4w' ? 'day' : range === '6m' ? 'week' : 'month';
  const timeline = [];
  if (bucket === 'day') {
    for (let i = 27; i >= 0; i--) timeline.push({ key: dayKey(now - i * DAY), label: new Date((now - i * DAY) * 1000).getDate(), sec: 0 });
  } else if (bucket === 'week') {
    for (let i = 25; i >= 0; i--) { const t = now - i * 7 * DAY; timeline.push({ key: Math.floor((t - from) / (7 * DAY)), label: new Date(t * 1000).toLocaleDateString([], { month: 'short' }), sec: 0 }); }
  } else {
    const start = new Date((from || all[0]?.[1] || now) * 1000);
    const end = new Date(now * 1000);
    for (let y = start.getFullYear(), m = start.getMonth(); y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth()); m++) {
      if (m > 11) { m = 0; y++; }
      timeline.push({ key: `${y}-${m}`, label: new Date(y, m, 1).toLocaleDateString([], { month: 'short' }), year: y, sec: 0 });
      if (timeline.length > 120) break;
    }
  }
  const idx = new Map(timeline.map((b, i) => [b.key, i]));
  for (const e of inR) {
    const d = new Date(e[1] * 1000);
    const k = bucket === 'day' ? dayKey(e[1]) : bucket === 'week' ? Math.floor((e[1] - from) / (7 * DAY)) : `${d.getFullYear()}-${d.getMonth()}`;
    const i = idx.get(k);
    if (i != null) timeline[i].sec += e[2];
  }

  // when you listen
  const hours = Array(24).fill(0), weekdays = Array(7).fill(0);
  for (const e of inR) { const d = new Date(e[1] * 1000); hours[d.getHours()] += e[2]; weekdays[d.getDay()] += e[2]; }

  // streaks (days with at least one listen)
  const days = new Set(all.map((e) => dayKey(e[1])));
  for (const [d, s] of Object.entries(library.listen || {})) if (s > 60) days.add(d);
  let streak = 0;
  for (let i = 0; ; i++) { const k = dayKey(now - i * DAY); if (days.has(k)) streak++; else if (i > 0) break; if (i > 3650) break; }
  let longest = 0, run = 0, prevDay = null;
  for (const d of [...days].sort()) {
    const t = new Date(d + 'T12:00:00').getTime() / 1000;
    run = prevDay != null && Math.round((t - prevDay) / DAY) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run); prevDay = t;
  }

  // your sound
  let bpmSum = 0, bpmN = 0, lossless = 0, explicit = 0, energy = 0, energyN = 0;
  const keys = new Map();
  for (const e of inR) {
    const t = library.track(e[0]);
    const bpm = library.bpmOf(t);
    if (bpm) { bpmSum += bpm; bpmN++; }
    const an = library.analysis.get(t.id);
    if (an?.camelot) keys.set(an.camelot, (keys.get(an.camelot) || 0) + 1);
    if (an?.energy != null) { energy += an.energy; energyN++; }
    if (['FLAC', 'ALAC', 'WAV'].includes(t.codec)) lossless++;
    if (t.edition === 'explicit') explicit++;
  }
  // the one song you couldn't stop playing in a single day
  const perDay = new Map();
  for (const e of inR) { const k = dayKey(e[1]) + '|' + e[0]; perDay.set(k, (perDay.get(k) || 0) + 1); }
  const obsession = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];

  const mixes = {};
  for (const [k, v] of Object.entries(library.mixesDone || {})) if (k.startsWith('style:')) mixes[k.slice(6)] = v;
  const n = inR.length;
  return {
    range, empty: !n,
    minutes: Math.round(sum(inR) / 60), prevMinutes: Math.round(sum(prev) / 60),
    plays: n, prevPlays: prev.length,
    uniqueTracks: tracks.length, uniqueArtists: artists.length,
    tracks, artists, albums, genres, decades, timeline, bucket, hours, weekdays,
    streak, longest, perDayAvg: Math.round(sum(inR) / 60 / Math.max(1, span / DAY)),
    sound: {
      bpm: bpmN ? Math.round(bpmSum / bpmN) : 0,
      energy: energyN ? energy / energyN : null,
      key: [...keys.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      lossless: n ? lossless / n : 0, explicit: n ? explicit / n : 0,
    },
    obsession: obsession && obsession[1] >= 3 ? { track: library.track(obsession[0].split('|')[1]), day: obsession[0].split('|')[0], plays: obsession[1] } : null,
    mixes,
    hasPlexHistory: !!library.plexHistory?.length,
  };
}
