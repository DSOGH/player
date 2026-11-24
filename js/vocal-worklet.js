// Real-time vocal isolation (AudioWorklet).
// STFT center-channel extraction: lead vocals sit in the middle of a stereo mix, so for every
// frequency bin we measure how "centered" the energy is (mid vs. side) and build a soft mask,
// limited to the vocal range and smoothed over time. Output 0 = isolated vocal, output 1 = the
// instrumental (the same mask removed from both channels — a "karaoke" version).
// Idle (no work) unless the engine activates it for a word-play transition.
const N = 2048, HOP = 512, BINS = N / 2 + 1;

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

class VocalSplit extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.strength = 1;
    this.port.onmessage = (e) => {
      if ('active' in e.data) { this.active = e.data.active; if (!this.active) this.reset(); }
      if ('strength' in e.data) this.strength = e.data.strength;
    };
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    this.band = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const f = (k * sampleRate) / N;
      this.band[k] = smooth(110, 260, f) * (1 - smooth(6500, 10000, f));
    }
    this.L = new Float32Array(N); this.R = new Float32Array(N);
    this.reL = new Float64Array(N); this.imL = new Float64Array(N);
    this.reR = new Float64Array(N); this.imR = new Float64Array(N);
    this.vr = new Float64Array(N); this.vi = new Float64Array(N);
    this.ar = new Float64Array(N); this.ai = new Float64Array(N);
    this.br = new Float64Array(N); this.bi = new Float64Array(N);
    this.mask = new Float32Array(BINS);
    this.olaV = new Float32Array(N); this.olaIL = new Float32Array(N); this.olaIR = new Float32Array(N);
    const CAP = 8192;
    this.cap = CAP;
    this.qV = new Float32Array(CAP); this.qIL = new Float32Array(CAP); this.qIR = new Float32Array(CAP);
    this.reset();
  }
  reset() {
    this.staged = 0; this.qr = 0; this.qw = 0; this.qn = 0;
    this.L.fill(0); this.R.fill(0); this.mask.fill(0);
    this.olaV.fill(0); this.olaIL.fill(0); this.olaIR.fill(0);
  }
  frame() {
    const { win, L, R, reL, imL, reR, imR, vr, vi, ar, ai, br, bi, mask, band } = this;
    for (let i = 0; i < N; i++) { reL[i] = L[i] * win[i]; imL[i] = 0; reR[i] = R[i] * win[i]; imR[i] = 0; }
    fft(reL, imL, false); fft(reR, imR, false);
    const st = this.strength;
    for (let k = 0; k < BINS; k++) {
      const mr = (reL[k] + reR[k]) * 0.5, mi = (imL[k] + imR[k]) * 0.5;
      const sr = (reL[k] - reR[k]) * 0.5, si = (imL[k] - imR[k]) * 0.5;
      const pm = mr * mr + mi * mi, ps = sr * sr + si * si;
      const c = pm / (pm + ps + 1e-12);              // 1 = dead center, 0.5 = wide, 0 = out of phase
      let m = Math.min(1, Math.max(0, (c - 0.58) / 0.38));
      m = m * m * band[k] * st;
      mask[k] = mask[k] * 0.55 + m * 0.45;          // temporal smoothing cuts "musical noise"
      const g = mask[k];
      vr[k] = mr * g; vi[k] = mi * g;
      ar[k] = reL[k] - vr[k]; ai[k] = imL[k] - vi[k];
      br[k] = reR[k] - vr[k]; bi[k] = imR[k] - vi[k];
    }
    for (let k = 1; k < N / 2; k++) {               // conjugate-symmetric upper half
      const j = N - k;
      vr[j] = vr[k]; vi[j] = -vi[k]; ar[j] = ar[k]; ai[j] = -ai[k]; br[j] = br[k]; bi[j] = -bi[k];
    }
    fft(vr, vi, true); fft(ar, ai, true); fft(br, bi, true);
    const { olaV, olaIL, olaIR } = this;
    for (let i = 0; i < N; i++) {
      const w = win[i] * 0.5; // sqrt-hann × sqrt-hann = hann; 75% overlap sums to 2
      olaV[i] += vr[i] * w; olaIL[i] += ar[i] * w; olaIR[i] += br[i] * w;
    }
    // first HOP samples are finished → queue them
    for (let i = 0; i < HOP; i++) {
      const p = this.qw;
      this.qV[p] = olaV[i]; this.qIL[p] = olaIL[i]; this.qIR[p] = olaIR[i];
      this.qw = (p + 1) % this.cap;
    }
    this.qn = Math.min(this.cap, this.qn + HOP);
    olaV.copyWithin(0, HOP); olaIL.copyWithin(0, HOP); olaIR.copyWithin(0, HOP);
    olaV.fill(0, N - HOP); olaIL.fill(0, N - HOP); olaIR.fill(0, N - HOP);
    L.copyWithin(0, HOP); R.copyWithin(0, HOP);
  }
  process(inputs, outputs) {
    if (!this.active) return true;
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const inL = inp[0], inR = inp[1] || inp[0];
    const n = inL.length;
    for (let i = 0; i < n; i++) {
      this.L[N - HOP + this.staged] = inL[i];
      this.R[N - HOP + this.staged] = inR[i];
      if (++this.staged === HOP) { this.staged = 0; this.frame(); }
    }
    const [v0, v1] = outputs[0];
    const [i0, i1] = outputs[1];
    for (let i = 0; i < n; i++) {
      if (this.qn > 0) {
        const p = this.qr;
        const v = this.qV[p];
        if (v0) v0[i] = v; if (v1) v1[i] = v;
        if (i0) i0[i] = this.qIL[p]; if (i1) i1[i] = this.qIR[p];
        this.qr = (p + 1) % this.cap; this.qn--;
      }
    }
    return true;
  }
}
registerProcessor('vocal-split', VocalSplit);
