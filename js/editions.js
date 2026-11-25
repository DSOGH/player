// Tells a clean edit from the explicit original by listening: the same song in both versions is lined
// up and its vocal band compared moment by moment. Where one version suddenly drops out (a muted or
// cut word) while the other keeps singing, that one is the clean edit. Identical audio = same edition.
import { fetchTrackBuffer } from './analysis.js';

const SR = 11025, HOP = 0.05; // 50 ms frames

async function vocalEnv(ab) {
  const tmp = new OfflineAudioContext(1, 1, SR);
  const buf = await tmp.decodeAudioData(ab);
  const oc = new OfflineAudioContext(1, buf.length, SR);   // stereo → mono = the centre, where vocals sit
  const src = oc.createBufferSource(); src.buffer = buf;
  const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 280;
  const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
  src.connect(hp).connect(lp).connect(oc.destination); src.start();
  const x = (await oc.startRendering()).getChannelData(0);
  const H = Math.round(SR * HOP), n = Math.floor(x.length / H), env = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0; const o = k * H;
    for (let i = 0; i < H; i += 2) s += x[o + i] * x[o + i];
    env[k] = 10 * Math.log10(s / (H / 2) + 1e-10);
  }
  return env;
}
const median = (a) => { const s = Array.from(a).sort((p, q) => p - q); return s[s.length >> 1] || 0; };

export function compareEnvs(A, B) {
  // line the two up (one may have a little more silence at the start)
  const span = Math.min(A.length, B.length, 1800), W = 40;
  const mA = median(A.subarray(0, span)), mB = median(B.subarray(0, span));
  let best = 0, bestC = -Infinity;
  for (let lag = -W; lag <= W; lag++) {
    let c = 0;
    for (let i = W; i < span - W; i++) c += (A[i] - mA) * (B[i + lag] - mB);
    if (c > bestC) { bestC = c; best = lag; }
  }
  const d = [], loud = [];
  for (let i = Math.max(0, -best); i < A.length && i + best < B.length; i++) { d.push(A[i] - B[i + best]); loud.push(Math.max(A[i], B[i + best])); }
  if (d.length < 200) return null;
  const off = median(d), lm = median(loud);
  let diff = 0, evA = 0, evB = 0, runA = 0, runB = 0;
  const close = () => { if (runA >= 2 && runA <= 30) evA++; if (runB >= 2 && runB <= 30) evB++; runA = runB = 0; };
  for (let i = 0; i < d.length; i++) {
    const x = d[i] - off;
    if (loud[i] < lm - 14) { close(); continue; }     // both quiet: nothing to compare
    if (Math.abs(x) > 6) diff++;
    if (x < -14) { if (runB) close(); runA++; }        // A dropped out here, B didn't
    else if (x > 14) { if (runA) close(); runB++; }
    else close();
  }
  close();
  return { dropsA: evA, dropsB: evB, same: diff / d.length < 0.006 };
}

// → { dropsA, dropsB, same } for one song that exists in both versions (or null)
export async function compareVersions(t0, t1, signal) {
  const a = await fetchTrackBuffer(t0, signal, { store: false });
  const A = await vocalEnv(a);
  const b = await fetchTrackBuffer(t1, signal, { store: false });
  const B = await vocalEnv(b);
  return compareEnvs(A, B);
}
