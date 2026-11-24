// On-device audio analysis: BPM + beat grid, leading/trailing silence, fade-in/fade-out shape,
// and loudness (for auto-leveling files without ReplayGain). Results are cached per track.
import { library } from './library.js';
import { settings } from './settings.js';
import { nasUrl } from './util.js';
import { plex } from './plex.js';

const SR = 11025;
const WIN = 256;               // ~23 ms envelope windows
const ANALYSIS_VERSION = 3;
const MAX_SECONDS = 20 * 60;   // skip very long files (mixes, audiobooks)
const inflight = new Map();
const PREFETCH_KEEP = 6;

export function trackSrc(t) {
  if (t.demo) return t.url;
  if (t.plex) return nasUrl(plex.connected ? plex.partUrl(t) : t.url, t.size, t.url);
  return nasUrl(t.url, t.size);
}
export function isAnalyzed(t) {
  const a = library.analysis.get(t.id);
  return a && a.v === ANALYSIS_VERSION;
}

function networkOk() {
  const c = navigator.connection;
  if (settings.get('analysisNetwork') === 'wifi' && c && (c.type === 'cellular' || c.saveData)) return false;
  return true;
}

// Download a track fully and keep it in the "prefetch" cache so playback starts instantly.
export async function fetchTrackBuffer(t) {
  const key = t.demo ? new URL(t.url, location.href).href : t.url;
  for (const name of ['offline-tracks', 'prefetch']) {
    const c = await caches.open(name);
    const hit = await c.match(key);
    if (hit) return hit.arrayBuffer();
  }
  const r = await fetch(trackSrc(t));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (!t.demo) {
    try {
      const c = await caches.open('prefetch');
      await c.put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }));
      const ks = await c.keys();
      for (let i = 0; i < ks.length - PREFETCH_KEEP; i++) await c.delete(ks[i]);
    } catch (e) { /* quota */ }
  }
  return blob.arrayBuffer();
}

export async function prefetchTrack(t) {
  if (!t || t.demo) return;
  const mode = settings.get('prefetch');
  if (mode === 'off') return;
  if (mode === 'wifi' && navigator.connection?.type === 'cellular') return;
  if (t.size > 300e6) return;
  try { await fetchTrackBuffer(t); } catch (e) { /* ignore */ }
}

export function analyze(t, { force = false } = {}) {
  if (!t) return Promise.resolve(null);
  if (!force && isAnalyzed(t)) return Promise.resolve(library.analysis.get(t.id));
  if (inflight.has(t.id)) return inflight.get(t.id);
  if (!force && !networkOk()) return Promise.resolve(null);
  if ((t.duration || 0) > MAX_SECONDS || t.size > 400e6) return Promise.resolve(null);
  const p = (async () => {
    try {
      const ab = await fetchTrackBuffer(t);
      const res = await analyzeBuffer(ab);
      if (!res) return null;
      const rec = { id: t.id, v: ANALYSIS_VERSION, ...res, at: Date.now() };
      library.setAnalysis(rec);
      return rec;
    } catch (e) {
      console.warn('analysis failed', t.title, e);
      return null;
    } finally {
      inflight.delete(t.id);
    }
  })();
  inflight.set(t.id, p);
  return p;
}

async function decode(ab) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  return ctx.decodeAudioData(ab);
}

async function lowpass(buf, freq) {
  const oc = new OfflineAudioContext(1, buf.length, SR);
  const src = oc.createBufferSource();
  src.buffer = buf;
  const f = oc.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = 0.7;
  src.connect(f).connect(oc.destination);
  src.start();
  const out = await oc.startRendering();
  return out.getChannelData(0);
}

export async function analyzeBuffer(ab) {
  const buf = await decode(ab);
  const n = buf.length;
  if (n < SR * 3) return null;
  const duration = buf.duration;
  // mono mix
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  const W = Math.floor(n / WIN);
  const env = new Float32Array(W);      // power per window
  let peak = 0;
  for (let w = 0; w < W; w++) {
    let s = 0;
    const o = w * WIN;
    for (let i = 0; i < WIN; i++) { const v = mono[o + i]; s += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    env[w] = s / WIN;
  }
  const wsec = WIN / SR;
  const toDb = (p) => 10 * Math.log10(p + 1e-12);
  // silence threshold relative to the track's loudest part
  let maxP = 0;
  for (const p of env) if (p > maxP) maxP = p;
  const thr = Math.max(maxP * 10 ** (-48 / 10), 10 ** (-70 / 10));
  let first = 0, last = W - 1;
  while (first < W && env[first] < thr) first++;
  while (last > first && env[last] < thr) last--;
  const leadIn = Math.max(0, first * wsec - 0.02);
  const tailOut = Math.min(duration, (last + 1) * wsec + 0.05);

  // gated loudness over the body
  let sum = 0, cnt = 0;
  const gate = maxP * 10 ** (-30 / 10);
  for (let w = first; w <= last; w++) if (env[w] > gate) { sum += env[w]; cnt++; }
  const loud = cnt ? sum / cnt : maxP;
  const loudnessDb = toDb(loud);

  // smoothed (3 s) envelope to find fade-in end / fade-out start
  const S = Math.max(1, Math.round(3 / wsec));
  const sm = new Float32Array(W);
  let acc = 0;
  for (let w = 0; w < W; w++) {
    acc += env[w];
    if (w >= S) acc -= env[w - S];
    sm[w] = acc / Math.min(w + 1, S);
  }
  // reference: median-ish of the middle half
  const mid = Array.from(sm.subarray(Math.floor(W * 0.25), Math.floor(W * 0.75))).sort((a, b) => a - b);
  const ref = mid[Math.floor(mid.length * 0.5)] || loud;
  const near = ref * 10 ** (-5 / 10);
  // sm[w] is the average of the 3 s *ending* at w; shift by S/2 to center it
  let fo = last;
  while (fo > first && sm[Math.min(W - 1, fo + (S >> 1))] < near) fo--;
  const fadeOutStart = Math.min(tailOut, fo * wsec);
  let fi = first;
  while (fi < last && sm[Math.min(W - 1, fi + (S >> 1))] < near) fi++;
  const fadeInEnd = Math.max(leadIn, fi * wsec);

  // ---- tempo ----
  const lp = await lowpass(buf, 180);
  const HOP = 110; // 100 frames/s at 11025
  const F = Math.floor(n / HOP);
  const onset = new Float32Array(F);
  let prevA = 0, prevB = 0;
  for (let f = 0; f < F; f++) {
    let a = 0, b = 0;
    const o = f * HOP;
    for (let i = 0; i < HOP; i++) { const x = mono[o + i], y = lp[o + i]; a += x * x; b += y * y; }
    a = Math.log1p(a * 100); b = Math.log1p(b * 400);
    onset[f] = Math.max(0, a - prevA) + 1.5 * Math.max(0, b - prevB);
    prevA = a; prevB = b;
  }
  // remove local mean (adaptive threshold)
  const on = new Float32Array(F);
  const M = 25;
  let ms = 0;
  for (let f = 0; f < F; f++) {
    ms += onset[f];
    if (f >= M) ms -= onset[f - M];
    on[f] = Math.max(0, onset[f] - ms / Math.min(f + 1, M));
  }
  const fps = SR / HOP;
  // autocorrelation over the body of the track
  const a0 = Math.floor(fadeInEnd * fps), a1 = Math.min(F, Math.floor(fadeOutStart * fps));
  const seg = on.subarray(a0, Math.max(a0 + 1, Math.min(a1, a0 + Math.floor(120 * fps))));
  const minLag = Math.floor((60 / 200) * fps), maxLag = Math.ceil((60 / 60) * fps);
  const ac = new Float32Array(maxLag + 2);
  for (let L = minLag - 1; L <= maxLag + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < seg.length; i++) s += seg[i] * seg[i + L];
    ac[L] = s / Math.max(1, seg.length - L);
  }
  let bestL = 0, bestS = -1, sumS = 0, cntS = 0;
  for (let L = minLag; L <= maxLag; L++) {
    const bpm = (60 * fps) / L;
    // tempo prior centred on 120 BPM, plus support from the double period
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.8) ** 2);
    const s = (ac[L] + 0.5 * (ac[2 * L] || 0)) * prior;
    sumS += s; cntS++;
    if (s > bestS) { bestS = s; bestL = L; }
  }
  let bpm = 0, conf = 0, beatOffset = 0;
  if (bestL) {
    // parabolic refinement
    const y0 = ac[bestL - 1], y1 = ac[bestL], y2 = ac[bestL + 1];
    const d = (y0 - 2 * y1 + y2) !== 0 ? 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) : 0;
    let period = bestL + Math.max(-0.5, Math.min(0.5, d));
    // comb-filter refinement over the full body: search ±3% for the best grid
    let bestP = period, bestPhase = 0, bestScore = -1;
    for (let p = period * 0.97; p <= period * 1.03; p += period * 0.0025) {
      for (let ph = 0; ph < p; ph += 1) {
        let s = 0;
        for (let x = a0 + ph; x < a1; x += p) s += on[Math.round(x)] || 0;
        if (s > bestScore) { bestScore = s; bestP = p; bestPhase = ph; }
      }
    }
    period = bestP;
    bpm = (60 * fps) / period;
    while (bpm < 70) bpm *= 2;
    while (bpm > 190) bpm /= 2;
    conf = Math.min(1, (bestS / (sumS / cntS) - 1) / 3);
    // first beat at or after the music starts
    const pSec = period / fps;
    let t0 = (a0 + bestPhase) / fps;
    while (t0 - pSec >= leadIn) t0 -= pSec;
    beatOffset = t0;
  }
  return {
    bpm: Math.round(bpm * 10) / 10,
    bpmConf: Math.round(conf * 100) / 100,
    beatOffset: Math.round(beatOffset * 1000) / 1000,
    leadIn: Math.round(leadIn * 100) / 100,
    tailOut: Math.round(tailOut * 100) / 100,
    fadeInEnd: Math.round(fadeInEnd * 100) / 100,
    fadeOutStart: Math.round(fadeOutStart * 100) / 100,
    loudnessDb: Math.round(loudnessDb * 10) / 10,
    peakDb: Math.round(toDb(peak * peak) * 10) / 10,
    duration: Math.round(duration * 100) / 100,
  };
}
