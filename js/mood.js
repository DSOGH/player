// Moods and lyrics — the "vibe" side of the DJ.
//
// Every song gets a mood profile (0…1 for each mood) from everything the app knows about it:
// energy, tempo, major/minor key, genre, the words in its lyrics, and — when the sound AI has heard
// it — the neural network's party / dance / aggressive / relaxed / happy / voice scores (those count
// most). A set can stay in one mood, or travel from one mood to another a little at a time.
// Lyrics also link songs: shared themes between two songs, and a shared word right at the mix point
// (DJs love swapping songs on a word both of them sing).
import { library } from './library.js';
import { cachedLyrics } from './lyrics.js';

export const MOODS = [
  { id: 'party', name: 'Party', emoji: '🎉', energy: 78 },
  { id: 'hype', name: 'Hype', emoji: '🔥', energy: 85 },
  { id: 'happy', name: 'Feel-good', emoji: '☀️', energy: 65 },
  { id: 'chill', name: 'Chill', emoji: '🌊', energy: 42 },
  { id: 'love', name: 'Late night', emoji: '🌙', energy: 50 },
  { id: 'sad', name: 'In my feels', emoji: '🌧️', energy: 40 },
  { id: 'focus', name: 'Focus', emoji: '🎧', energy: 45 },
];
export const moodName = (id) => MOODS.find((m) => m.id === id)?.name || id;

const LEX = {
  party: 'party club dance dancing floor night tonight drink drinks shots bottle turn turnt lit dj bass beat drop jump hands up wild crazy celebrate weekend friday saturday',
  hype: 'money cash bands boss king queen win winning grind hustle fight fire gun guns real hard beast savage top rich flex run kill riot war rage',
  happy: 'happy smile sun sunshine good feel feeling alive free shine bright summer joy fun laugh beautiful wonderful golden sweet best',
  love: 'love baby babe kiss touch hold heart body slow close mine yours forever lover darling desire need want honey tonight',
  sad: 'cry crying tears alone lonely gone lost hurt pain broken goodbye miss missing sorry rain cold empty heartbreak die dying remember never',
};
const LEXSET = Object.fromEntries(Object.entries(LEX).map(([k, v]) => [k, new Set(v.split(' '))]));
const STOP = new Set('the a an and or but to of in on at for with from by is are was were be been am i im you your yours me my we our us they them their he she him her it its this that these those so just like oh yeah ooh ah uh hey na la do dont did does not no yes all can cant will wont would could should get got go going gonna wanna let lets know now up down out over again what when where who why how there here then than too very one two way make made say said see come came take back cause cuz ya yo em'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').match(/[a-z]{3,}/g) || [];

const lyricCache = new Map();
// a song's lyric fingerprint: its theme words and how much of each mood its words carry
export function lyricInfo(t) {
  const L = cachedLyrics(t);
  if (!L?.lines?.length) return null;
  const hit = lyricCache.get(t.id);
  if (hit && hit.L === L) return hit.v;
  const counts = new Map(), mood = { party: 0, hype: 0, happy: 0, love: 0, sad: 0 };
  let n = 0;
  for (const l of L.lines) for (const w of words(l.text)) {
    n++;
    for (const k in LEXSET) if (LEXSET[k].has(w)) mood[k]++;
    if (!STOP.has(w) && w.length >= 4) counts.set(w, (counts.get(w) || 0) + 1);
  }
  for (const k in mood) mood[k] = n ? Math.min(1, (mood[k] / n) * 25) : 0;
  const themes = new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w));
  const v = { mood, themes, synced: !!L.synced, lines: L.lines };
  lyricCache.set(t.id, { L, v });
  return v;
}
// how much two songs' lyrics are about the same things (0…1)
export function lyricThemeFit(a, b) {
  const A = lyricInfo(a), B = lyricInfo(b);
  if (!A || !B || !A.themes.size || !B.themes.size) return null;
  let s = 0; for (const w of A.themes) if (B.themes.has(w)) s++;
  return Math.min(1, s / 6);
}
// a word sung by the outgoing song just before it leaves AND by the next song just after it comes in
export function lyricLink(a, b, outAt, inAt, win = 12) {
  const A = lyricInfo(a), B = lyricInfo(b);
  if (!A?.synced || !B?.synced) return null;
  const tail = A.lines.filter((l) => l.t >= outAt - win && l.t <= outAt + 2);
  const head = B.lines.filter((l) => l.t >= inAt - 1 && l.t <= inAt + win);
  if (!tail.length || !head.length) return null;
  const tw = new Set(tail.flatMap((l) => words(l.text)).filter((w) => !STOP.has(w) && w.length >= 4));
  for (const l of head) for (const w of words(l.text)) if (tw.has(w)) return w;
  return null;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const GENRE_MOOD = {
  hiphop: { party: 0.5, hype: 0.8 }, electronic: { party: 0.9, hype: 0.5, focus: 0.4 }, latin: { party: 0.8, happy: 0.6, love: 0.3 }, afro: { party: 0.8, happy: 0.6 },
  rnb: { love: 0.9, chill: 0.4, sad: 0.3 }, pop: { happy: 0.6, party: 0.4, love: 0.3 }, rock: { hype: 0.6 }, metal: { hype: 1 }, indie: { chill: 0.5, sad: 0.4 },
  folk: { chill: 0.7, sad: 0.4 }, country: { happy: 0.4, sad: 0.4 }, jazz: { chill: 0.8, focus: 0.6, love: 0.4 }, classical: { focus: 1, chill: 0.7 },
  soundtrack: { focus: 0.8 }, gospel: { happy: 0.6 }, kpop: { party: 0.6, happy: 0.7 }, kids: { happy: 0.8 }, holiday: { happy: 0.8 },
};
const profCache = new Map();
// a song's mood profile: { party, hype, happy, chill, love, sad, focus }, each 0…1
export function moodOf(t) {
  if (!t) return null;
  const a = library.analysis.get(t.id), ai = a?.ai, lyr = lyricInfo(t);
  const key = `${a?.at || 0}|${ai ? 1 : 0}|${lyr ? 1 : 0}`;
  const hit = profCache.get(t.id);
  if (hit && hit.key === key) return hit.v;
  let E = null;
  if (a?.loud?.length) { let s = 0; for (const v of a.loud) s += v; E = clamp01((s / a.loud.length - 35) / 50); }
  else if (a?.energy != null) E = clamp01(a.energy);
  const e = E ?? 0.55;
  let bpm = library.bpmOf(t) || 0; if (bpm > 150) bpm /= 2; // (half-time feel for very fast songs)
  const fast = bpm ? clamp01((bpm - 95) / 35) : 0.5;
  const minor = a?.camelot ? (/A$/.test(a.camelot) ? 1 : 0) : 0.5;
  const g = GENRE_MOOD[t.genreFamily] || {};
  const L = lyr?.mood || {};
  const m = {
    party: 0.35 * e + 0.2 * fast + 0.3 * (g.party || 0) + 0.25 * (L.party || 0),
    hype: 0.45 * e + 0.15 * fast + 0.3 * (g.hype || 0) + 0.2 * (L.hype || 0) + 0.1 * minor,
    happy: 0.3 * (1 - minor) + 0.2 * e + 0.25 * (g.happy || 0) + 0.3 * (L.happy || 0),
    chill: 0.5 * (1 - e) + 0.2 * (1 - fast) + 0.3 * (g.chill || 0),
    love: 0.25 * (1 - Math.abs(e - 0.45) * 2) + 0.15 * (1 - fast) + 0.3 * (g.love || 0) + 0.4 * (L.love || 0),
    sad: 0.35 * minor + 0.3 * (1 - e) + 0.15 * (g.sad || 0) + 0.4 * (L.sad || 0),
    focus: 0.35 * (1 - e) + 0.4 * (g.focus || 0) + 0.15 * (lyr ? 0 : 0.6),
  };
  // the sound AI heard it: its judgement counts most
  if (ai) {
    const mix = (k, v, w = 0.6) => { if (v != null) m[k] = m[k] * (1 - w) + v * w; };
    mix('party', ai.party != null && ai.dance != null ? (ai.party + ai.dance) / 2 : ai.party);
    mix('hype', ai.aggr != null ? Math.max(ai.aggr, (ai.party ?? 0) * 0.6) : null);
    mix('happy', ai.happy);
    mix('chill', ai.relax);
    mix('sad', ai.happy != null && ai.relax != null ? (1 - ai.happy) * 0.6 + ai.relax * 0.3 : null, 0.4);
    mix('focus', ai.voice != null ? (1 - ai.voice) * 0.7 + (ai.relax ?? 0.5) * 0.3 : null);
  }
  for (const k in m) m[k] = clamp01(m[k]);
  profCache.set(t.id, { key, v: m });
  return m;
}
// how well a song fits a mood (0…1): its score in that mood, relative to its other moods
export function moodFit(t, id) {
  const m = moodOf(t);
  if (!m || !id) return 0.5;
  const v = m[id] ?? 0.5;
  const others = Object.entries(m).filter(([k]) => k !== id).map(([, x]) => x);
  const top = Math.max(...others);
  return clamp01(0.5 + (v - top) * 0.8 + (v - 0.5) * 0.6);
}
// where a set is on its way from one mood to another: which mood it's aiming for right now and the
// energy that goes with it. A journey takes `len` songs.
export function moodTarget(moods, n, len = 10) {
  if (!moods?.length) return null;
  if (moods.length === 1) return { weights: { [moods[0]]: 1 }, energy: MOODS.find((x) => x.id === moods[0])?.energy, progress: 1 };
  const p = Math.min(1, n / len);
  const [a, b] = moods;
  const eA = MOODS.find((x) => x.id === a)?.energy ?? 60, eB = MOODS.find((x) => x.id === b)?.energy ?? 60;
  return { weights: { [a]: 1 - p, [b]: p }, energy: eA + (eB - eA) * p, progress: p };
}
export function moodScore(t, target) {
  if (!target) return 0;
  let s = 0; for (const [id, w] of Object.entries(target.weights)) s += moodFit(t, id) * w;
  return s;
}
