// Pure-math part of song analysis. Runs inside a Web Worker (analysis-worker.js) so it never
// freezes the UI or audio; also importable directly as a fallback.
const WIN = 256;

export function computeAnalysis({ channels, lp, SR, duration }) {
  const n = lp.length;
  // mono mix
  const mono = new Float32Array(n);
  for (const d of channels) for (let i = 0; i < n; i++) mono[i] += d[i] / channels.length;
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
  const key = detectKey(mono, first * WIN, (last + 1) * WIN, SR);
  // energy: loudness + rhythmic density, 0..1
  let onsetMean = 0;
  for (let f = a0; f < a1; f++) onsetMean += on[f];
  onsetMean /= Math.max(1, a1 - a0);
  const energy = Math.max(0, Math.min(1, 0.6 * ((loudnessDb + 30) / 22) + 0.4 * Math.min(1, onsetMean * 3)));
  // waveform for the scrubber: 400 peak values (0..100)
  const WAVE = 400, wave = new Array(WAVE);
  const per = Math.max(1, Math.floor(n / WAVE));
  let wmax = 1e-6;
  for (let k = 0; k < WAVE; k++) {
    let m = 0;
    const o = k * per;
    for (let i = 0; i < per; i += 4) { const v = Math.abs(mono[o + i] || 0); if (v > m) m = v; }
    wave[k] = m; if (m > wmax) wmax = m;
  }
  for (let k = 0; k < WAVE; k++) wave[k] = Math.round(Math.sqrt(wave[k] / wmax) * 100);
  // loudness envelope (RMS every 0.5 s, 0..100) — lets the DJ find drops / choruses
  const EH = Math.round(SR / 2), envN = Math.floor(n / EH), lenv = new Array(envN);
  let emax = 1e-9;
  for (let k = 0; k < envN; k++) {
    let sum = 0;
    const o = k * EH;
    for (let i = 0; i < EH; i += 2) { const v = mono[o + i] || 0; sum += v * v; }
    lenv[k] = Math.sqrt(sum / (EH / 2)); if (lenv[k] > emax) emax = lenv[k];
  }
  for (let k = 0; k < envN; k++) lenv[k] = Math.round((lenv[k] / emax) * 100);
  return {
    wave, loud: lenv,
    key: key?.name || '', camelot: key?.camelot || '', keyConf: key ? Math.round(key.conf * 100) / 100 : 0,
    energy: Math.round(energy * 100) / 100,
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

// ---------- musical key (chromagram + Krumhansl-Kessler profiles) ----------
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function corr(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / 12, mb = b.reduce((s, x) => s + x, 0) / 12;
  let n = 0, da = 0, dbb = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * dbb || 1);
}
export function detectKey(mono, from, to, SRK = 11025) {
  const N = 4096;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SRK) / N;
    if (f < 55 || f > 2000) continue;
    binPc[k] = ((Math.round(12 * Math.log2(f / 440) + 69) % 12) + 12) % 12;
  }
  const chroma = new Float64Array(12);
  const re = new Float32Array(N), im = new Float32Array(N);
  const step = N * 2;
  let frames = 0;
  for (let o = from; o + N < to && frames < 400; o += step) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = mono[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    if (e / N < 1e-5) continue;
    fft(re, im);
    const c = new Float64Array(12);
    for (let k = 1; k < N / 2; k++) { const pc = binPc[k]; if (pc >= 0) c[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]); }
    const mx = Math.max(...c) || 1;
    for (let i = 0; i < 12; i++) chroma[i] += c[i] / mx;
    frames++;
  }
  if (frames < 8) return null;
  const ch = Array.from(chroma);
  let best = null, second = -2;
  for (let r = 0; r < 12; r++) {
    for (const [prof, minor] of [[KK_MAJ, false], [KK_MIN, true]]) {
      const rot = prof.map((_, i) => prof[(i - r + 12) % 12]);
      const c = corr(ch, rot);
      if (!best || c > best.c) { if (best) second = Math.max(second, best.c); best = { c, r, minor }; }
      else second = Math.max(second, c);
    }
  }
  return {
    name: `${NOTES[best.r]} ${best.minor ? 'minor' : 'major'}`,
    camelot: (best.minor ? CAMELOT_MIN : CAMELOT_MAJ)[best.r],
    conf: Math.max(0, Math.min(1, (best.c - second) * 5 + best.c * 0.3)),
  };
}
