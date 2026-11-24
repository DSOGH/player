// DJ brain: harmonic (Camelot) compatibility, tempo distance, energy flow, word-play cues,
// and an optimizer that orders a set like a DJ would.
import { library } from './library.js';
import { analyze, isAnalyzed } from './analysis.js';
import { getLyrics, cachedLyrics, cleanTitle } from './lyrics.js';
import { norm } from './util.js';

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'my', 'me', 'you', 'your', 'i', 'it', 'is', 'be', 'we', 'us', 'oh', 'yeah', 'love', 'baby', 'girl', 'boy', 'feat', 'ft', 'remix', 'mix', 'edit', 'version', 'intro', 'outro', 'interlude', 'song']);
const words = (s) => norm(s).replace(/[^\p{L}\p{N}' ]/gu, ' ').split(/\s+/).filter(Boolean);

export function camelotParts(c) {
  const m = /^(\d{1,2})([AB])$/.exec(c || '');
  return m ? { n: +m[1], l: m[2] } : null;
}
// 1 = perfect, ~0.9 = adjacent/relative, low = clash, 0.6 = unknown
export function keyCompat(a, b) {
  const A = camelotParts(a), B = camelotParts(b);
  if (!A || !B) return 0.6;
  const d = Math.min((A.n - B.n + 12) % 12, (B.n - A.n + 12) % 12);
  if (d === 0 && A.l === B.l) return 1;
  if (d === 0) return 0.88;          // relative major/minor
  if (d === 1 && A.l === B.l) return 0.92; // ±1 on the wheel
  if (d === 2 && A.l === B.l) return 0.55; // energy boost
  if (d === 1) return 0.5;
  return 0.15;
}
export function tempoRatio(a, b) {
  if (!a || !b) return 0;
  let x = b;
  if (x / a > 1.4) x /= 2; else if (a / x > 1.4) x *= 2;
  return a / x;
}

// Where in A's lyrics is B's title sung? (word play cue)
export function titleKey(t) {
  const w = words(cleanTitle(t.title)).filter((x) => x.length > 1);
  if (!w.length) return null;
  const sig = w.filter((x) => !STOP.has(x) && x.length >= 4);
  if (w.length === 1 && (STOP.has(w[0]) || w[0].length < 4)) return null;
  return { phrase: w.join(' '), sig };
}
export function findCue(A, B, lyrA = cachedLyrics(A)) {
  if (!lyrA?.synced) return null;
  const k = titleKey(B);
  if (!k) return null;
  const dur = A.duration || 0;
  const lines = lyrA.lines;
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L.text || L.t < dur * 0.45 || (dur && L.t > dur - 6)) continue;
    const lw = ' ' + words(L.text).join(' ') + ' ';
    let score = 0;
    if (lw.includes(' ' + k.phrase + ' ')) score = 3 + k.phrase.split(' ').length;
    else if (k.sig.length && k.sig.every((s) => lw.includes(' ' + s + ' '))) score = 2 + k.sig.length;
    if (!score) continue;
    const next = lines.slice(i + 1).find((x) => x.t > L.t);
    const end = Math.min(next ? next.t : L.t + 4, L.t + 7);
    // lyric files only time whole lines: estimate when the title phrase finishes inside the line
    // (singing usually fills ~85% of the gap to the next line, roughly evenly by syllables/letters)
    const lwords = words(L.text);
    const target = k.phrase.split(' ');
    let lastIdx = -1;
    for (let w = 0; w + target.length <= lwords.length; w++) {
      if (target.every((x, j) => lwords[w + j] === x)) lastIdx = w + target.length - 1;
    }
    if (lastIdx < 0 && k.sig.length) lastIdx = Math.max(...k.sig.map((x) => lwords.lastIndexOf(x)));
    const chars = (arr) => arr.reduce((n, w) => n + w.length + 1, 0);
    const ratio = lastIdx >= 0 ? chars(lwords.slice(0, lastIdx + 1)) / Math.max(1, chars(lwords)) : 1;
    const sung = (end - L.t) * 0.85;
    const phraseEnd = L.t + Math.max(0.5, sung * ratio) + 0.18;
    if (ratio > 0.7) score += 1; // title at the end of the line = cleanest cut
    const cand = { t: L.t, end, phraseEnd: Math.min(phraseEnd, end), lineEnd: L.t + sung + 0.1, text: L.text, score, phrase: k.phrase, ratio };
    // prefer the last strong occurrence (closest to the end of the song)
    if (!best || score > best.score || (score === best.score && L.t > best.t)) best = cand;
  }
  return best;
}
// When does B sing its own title first? (so the drop lands on it)
export function titleEntry(B, lyrB = cachedLyrics(B)) {
  if (!lyrB?.synced) return null;
  const k = titleKey(B);
  if (!k) return null;
  const dur = B.duration || 0;
  for (const L of lyrB.lines) {
    if (dur && L.t > dur * 0.5) break;
    const lw = ' ' + words(L.text).join(' ') + ' ';
    if (lw.includes(' ' + k.phrase + ' ') || (k.sig.length && k.sig.every((s) => lw.includes(' ' + s + ' ')))) return L.t;
  }
  return null;
}

export function info(t) {
  const a = library.analysis.get(t.id) || {};
  return { bpm: library.bpmOf(t), camelot: a.camelot || '', energy: a.energy ?? 0.5, a };
}

// Cost of playing B right after A (lower is better)
export function transitionCost(A, B, mode = 'auto') {
  const a = info(A), b = info(B);
  let cost = 0;
  const r = tempoRatio(a.bpm, b.bpm);
  if (r) cost += Math.min(4, Math.abs(r - 1) * 40); // 1% tempo jump ≈ 0.4
  else cost += 1.2;
  cost += (1 - keyCompat(a.camelot, b.camelot)) * 2.2;
  const de = b.energy - a.energy;
  cost += de < -0.12 ? (-de - 0.12) * 4 : de > 0.2 ? (de - 0.2) * 3 : 0;
  if (mode !== 'beats') {
    const cue = findHandoff(A, B) || findCue(A, B);
    if (cue) cost -= mode === 'wordplay' ? 6 : 2.5;
  }
  return cost;
}

// Order tracks into a DJ set. Keeps `first` (if given) at the start.
export async function optimizeOrder(tracks, { first = null, mode = 'auto', onProgress = () => {}, signal } = {}) {
  const list = [...new Map(tracks.map((t) => [t.id, t])).values()];
  const all = first ? [first, ...list.filter((t) => t.id !== first.id)] : list;
  const need = all.filter((t) => !isAnalyzed(t) && !(t.bpm && library.analysis.get(t.id)?.camelot));
  let done = 0;
  const total = need.length + (mode !== 'beats' ? all.length : 0);
  const step = (label) => onProgress(++done, total, label);
  // analyze a few at a time
  const queue = [...need];
  await Promise.all([0, 1].map(async () => {
    while (queue.length && !signal?.aborted) { const t = queue.shift(); await analyze(t, { force: true }); step('Analyzing'); }
  }));
  if (mode !== 'beats') {
    const lq = [...all];
    await Promise.all([0, 1, 2].map(async () => {
      while (lq.length && !signal?.aborted) { const t = lq.shift(); await getLyrics(t); step('Reading lyrics'); }
    }));
  }
  if (signal?.aborted || all.length < 3) return { order: all, stats: stats(all, mode) };
  const n = all.length;
  const C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : transitionCost(all[i], all[j], mode))));
  // greedy from the start (or the calmest track), then 2-opt / or-opt improvements
  let start = 0;
  if (!first) { let lo = Infinity; all.forEach((t, i) => { const e = info(t).energy + (info(t).bpm || 120) / 1000; if (e < lo) { lo = e; start = i; } }); }
  const used = new Array(n).fill(false);
  const path = [start]; used[start] = true;
  while (path.length < n) {
    const i = path[path.length - 1];
    let bj = -1, bc = Infinity;
    for (let j = 0; j < n; j++) if (!used[j] && C[i][j] < bc) { bc = C[i][j]; bj = j; }
    path.push(bj); used[bj] = true;
  }
  // or-opt: move one song to a better spot (delta-evaluated, keeps the opener fixed)
  const c2 = (x, y) => (x === undefined || y === undefined ? 0 : C[x][y]);
  let improved = true, iter = 0;
  while (improved && iter++ < 40) {
    improved = false;
    for (let i = 1; i < n; i++) {
      const x = path[i];
      const removeGain = c2(path[i - 1], x) + c2(x, path[i + 1]) - c2(path[i - 1], path[i + 1]);
      let bestJ = -1, bestDelta = -1e-6;
      for (let j = 1; j <= n; j++) {
        if (j === i || j === i + 1) continue;
        // insert x between path[j-1] and path[j] (indices in the original path)
        const L = path[j - 1], R = path[j];
        const add = c2(L, x) + c2(x, R) - c2(L, R);
        const delta = add - removeGain;
        if (delta < bestDelta) { bestDelta = delta; bestJ = j; }
      }
      if (bestJ > 0) {
        path.splice(i, 1);
        path.splice(bestJ > i ? bestJ - 1 : bestJ, 0, x);
        improved = true;
      }
    }
  }
  const order = path.map((i) => all[i]);
  return { order, stats: stats(order, mode) };
}

export function stats(order, mode = 'auto') {
  let harmonic = 0, wp = 0, jumps = 0, cnt = 0;
  for (let k = 0; k + 1 < order.length; k++) {
    const a = info(order[k]), b = info(order[k + 1]);
    if (keyCompat(a.camelot, b.camelot) >= 0.85) harmonic++;
    const r = tempoRatio(a.bpm, b.bpm);
    if (r) { jumps += Math.abs(r - 1) * 100; cnt++; }
    if (mode !== 'beats' && (findHandoff(order[k], order[k + 1]) || findCue(order[k], order[k + 1]))) wp++;
  }
  return { transitions: Math.max(0, order.length - 1), harmonic, wordplay: wp, avgTempoJump: cnt ? jumps / cnt : 0 };
}

// ---------- word handoff: the same words in both songs ----------
// Finds a word or phrase sung near the end of A that B also sings early on, and estimates
// (from line timings) when the shared words start in each song, so B can pick up the vocal
// exactly where A's leaves off.
function lineTimes(lines, i) {
  const L = lines[i];
  const next = lines.slice(i + 1).find((x) => x.t > L.t);
  const end = Math.min(next ? next.t : L.t + 4, L.t + 7);
  return { start: L.t, end, sung: (end - L.t) * 0.85 };
}
function posInLine(ws, from, to) {
  const chars = (arr) => arr.reduce((n, w) => n + w.length + 1, 0);
  const total = Math.max(1, chars(ws));
  return { a: chars(ws.slice(0, from)) / total, b: chars(ws.slice(0, to)) / total };
}
export function findHandoff(A, B, lyrA = cachedLyrics(A), lyrB = cachedLyrics(B)) {
  if (!lyrA?.synced || !lyrB?.synced) return null;
  const durA = A.duration || 0, durB = B.duration || 0;
  const LA = lyrA.lines, LB = lyrB.lines;
  const index = new Map();
  LB.forEach((L, li) => {
    if (!L.text || L.t < 1.5 || (durB && L.t > durB * 0.6)) return;
    const ws = words(L.text);
    ws.forEach((w, i) => {
      if (w.length < 3 || STOP.has(w)) return;
      if (!index.has(w)) index.set(w, []);
      index.get(w).push({ li, i, ws });
    });
  });
  let best = null;
  LA.forEach((L, li) => {
    if (!L.text || L.t < Math.max(25, durA * 0.4) || (durA && L.t > durA - 8)) return;
    const wsA = words(L.text);
    wsA.forEach((w, i) => {
      const hits = index.get(w);
      if (!hits) return;
      for (const m of hits) {
        let back = 0, len = 1;
        while (i - back - 1 >= 0 && m.i - back - 1 >= 0 && wsA[i - back - 1] === m.ws[m.i - back - 1]) back++;
        while (i + len < wsA.length && m.i + len < m.ws.length && wsA[i + len] === m.ws[m.i + len]) len++;
        const a0 = i - back, a1 = i + len, b0 = m.i - back;
        const phrase = wsA.slice(a0, a1);
        const content = phrase.filter((x) => !STOP.has(x) && x.length >= 3);
        if (!content.length || (phrase.length === 1 && w.length < 4)) continue;
        const pa = posInLine(wsA, a0, a1), pb = posInLine(m.ws, b0, b0 + phrase.length);
        // clean cuts only: the shared words must finish A's line and open B's line
        if (a1 < wsA.length - 1 || b0 > 1) continue;
        const ta = lineTimes(LA, li), tb = lineTimes(LB, m.li);
        let score = phrase.length * 3 + content.reduce((s, x) => s + Math.min(3, x.length / 3), 0);
        score += pa.a > 0.25 ? 1.5 : 0;          // some vocal before the shared words = a nice acapella lead-in
        score += (1 - pb.a) * 2;                 // B line starts with the shared words = precise entry
        score += (L.t / (durA || 1)) * 1.5;      // later in A is better
        score -= (LB[m.li].t / (durB || 1)) * 2; // earlier in B is better
        if (!best || score > best.score) {
          best = {
            score, phrase: phrase.join(' '),
            aLine: { t: ta.start, text: L.text }, aStart: ta.start + ta.sung * pa.a, aEnd: ta.start + ta.sung * pa.b + 0.15,
            cut: ta.start + ta.sung + 0.1, // end of A's sung line
            bLine: { t: tb.start, text: LB[m.li].text }, bStart: tb.start + tb.sung * pb.a,
          };
        }
      }
    });
  });
  return best && best.score >= 6 ? best : null;
}
