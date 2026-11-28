// Sound AI — a pre-trained music neural network (MusiCNN, by the Music Technology Group, UPF Barcelona,
// trained on a million songs) that runs on the phone with TensorFlow.js. It listens to a few seconds
// from 8 places in each song and gives:
//   • a 200-number "fingerprint" of how the song sounds (two songs with close fingerprints sound alike)
//   • party, danceability, aggressive, relaxed, happy, and voice-vs-instrumental scores
// The DJ uses these to choose songs that belong together and keep the mood flowing.
// Downloaded once (~4.5 MB) and kept on the phone; free, no account, nothing leaves the phone.
// Models: Essentia (CC BY-NC-SA 4.0, personal use).
import { settings } from './settings.js';
import { dlog } from './diag.js';

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const BASE = 'https://essentia.upf.edu/models';
const EMBED_ZIP = `${BASE}/autotagging/msd/msd-musicnn-1-tfjs.zip`;
const HEADS = { party: 'mood_party', dance: 'danceability', aggr: 'mood_aggressive', relax: 'mood_relaxed', happy: 'mood_happy', voice: 'voice_instrumental' };
const POS = { party: 'party', dance: 'danceable', aggr: 'aggressive', relax: 'relaxed', happy: 'happy', voice: 'voice' };
const NEG = { party: 'non_party', dance: 'not_danceable', aggr: 'not_aggressive', relax: 'non_relaxed', happy: 'non_happy', voice: 'instrumental' };
const headDir = (h) => `${BASE}/classification-heads/${h}/${h}-msd-musicnn-1-tfjs/`;
const headMeta = (h) => `${BASE}/classification-heads/${h}/${h}-msd-musicnn-1.json`;
export const AI_VERSION = 1;

// ---------- downloads (kept on the phone) ----------
async function fetchCached(url, type = 'arrayBuffer') {
  let c = null;
  try { c = await caches.open('ai-models'); } catch (e) { /* */ }
  let r = c && (await c.match(url));
  if (!r) {
    r = await fetch(url, { mode: 'cors' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('/').pop()}`);
    if (c) { try { await c.put(url, r.clone()); } catch (e) { /* storage full: fine */ } }
  }
  return r[type]();
}

// ---------- a small zip reader (the base model is published as a .zip) ----------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true);
    const data = u8.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    files.set(name.split('/').pop(), method === 0 ? data.slice() : method === 8 ? await inflateRaw(data) : null);
  }
  return files;
}

// ---------- the network ----------
let tfP = null;
function loadTF() {
  if (window.tf) return Promise.resolve(window.tf);
  if (tfP) return tfP;
  tfP = (async () => {
    const code = await fetchCached(TF_URL, 'text');
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = () => rej(new Error('tf failed to load')); document.head.appendChild(s); });
    const tf = window.tf;
    try { await tf.setBackend('webgl'); } catch (e) { try { await tf.setBackend('cpu'); } catch (e2) { /* */ } }
    await tf.ready();
    return tf;
  })();
  tfP.catch(() => { tfP = null; });
  return tfP;
}
// a graph model from its model.json + weight files
async function graphFrom(tf, json, getBin) {
  const specs = [], parts = [];
  for (const g of json.weightsManifest) { specs.push(...g.weights); for (const path of g.paths) parts.push(new Uint8Array(await getBin(path))); }
  const total = parts.reduce((s, b) => s + b.length, 0), data = new Uint8Array(total);
  let o = 0; for (const b of parts) { data.set(b, o); o += b.length; }
  return tf.loadGraphModel(tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: specs, weightData: data.buffer, format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy, signature: json.signature, userDefinedMetadata: json.userDefinedMetadata }));
}

class SoundAI {
  constructor() { this.state = 'off'; this.models = null; this.err = null; this.queue = []; this.busy = false; this.done = 0; }
  get on() { return settings.get('soundAI') !== false && typeof window !== 'undefined' && !!window.DecompressionStream && !(this._retryAt && Date.now() < this._retryAt); }
  // (tests can plug in their own models)
  useModels(m) { this.models = m; this.state = 'ready'; }
  setBusy(fn) { this.busy2 = fn; }
  async ready() {
    if (this.models) return this.models;
    if (!this.on) return null;
    if (this._loading) return this._loading;
    this.state = 'loading';
    this._loading = (async () => {
      const t0 = performance.now();
      const tf = await loadTF();
      const files = await unzip(await fetchCached(EMBED_ZIP));
      const mj = files.get('model.json');
      if (!mj) throw new Error('model.json missing in zip');
      const embed = await graphFrom(tf, JSON.parse(new TextDecoder().decode(mj)), async (p) => files.get(p.split('/').pop()));
      const heads = {};
      for (const [k, h] of Object.entries(HEADS)) {
        try {
          const json = await fetchCached(headDir(h) + 'model.json', 'json');
          const model = await graphFrom(tf, json, (p) => fetchCached(headDir(h) + p));
          let pos = null;
          try { const meta = await fetchCached(headMeta(h), 'json'); pos = (meta.classes || []).indexOf(POS[k]); } catch (e) { /* */ }
          // (Essentia lists the two classes alphabetically, when the description file can't be read)
          if (pos == null || pos < 0) pos = [POS[k], NEG[k]].sort().indexOf(POS[k]);
          heads[k] = { model, pos };
        } catch (e) { dlog('ai-head-skip', { head: h, why: e.message }); }
      }
      this.models = { tf, embed, heads };
      this.state = 'ready';
      dlog('ai-ready', { s: (performance.now() - t0) / 1000, heads: Object.keys(heads).length });
      return this.models;
    })();
    try { return await this._loading; } catch (e) {
      this.state = 'error'; this.err = e.message; dlog('ai-unavailable', { why: e.message });
      this._loading = null; this._retryAt = Date.now() + 10 * 60 * 1000;
      return null;
    }
  }

  // ---------- listening ----------
  // MusiCNN's input: 16 kHz mono → 512-point frames every 256 samples (Hann) → power spectrum →
  // 96 mel bands (0–8 kHz, Slaney) → log10(1 + 10000·x), in patches of 187 frames (~3 s)
  melPatches(x, nPatch = 8) {
    const N = 512, H = 256, F = 187, B = 96, SR = 16000;
    const span = (F - 1) * H + N;
    if (x.length < span) return [];
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const fb = melBank(N, SR, B);
    const re = new Float32Array(N), im = new Float32Array(N), pw = new Float32Array(N / 2 + 1);
    const lo = Math.floor(x.length * 0.08), hi = Math.max(lo, x.length - span - Math.floor(x.length * 0.06));
    const n = Math.max(1, Math.min(nPatch, Math.floor((hi - lo) / span) || 1));
    const out = [];
    for (let k = 0; k < n; k++) {
      const st = n === 1 ? Math.floor((x.length - span) / 2) : Math.round(lo + ((hi - lo) * k) / (n - 1));
      const patch = new Float32Array(F * B);
      for (let f = 0; f < F; f++) {
        const s0 = st + f * H;
        for (let i = 0; i < N; i++) { re[i] = (x[s0 + i] || 0) * win[i]; im[i] = 0; }
        fft(re, im);
        for (let b = 0; b <= N / 2; b++) pw[b] = re[b] * re[b] + im[b] * im[b];
        for (let m = 0; m < B; m++) {
          const [b0, w] = fb[m];
          let e = 0; for (let j = 0; j < w.length; j++) e += pw[b0 + j] * w[j];
          patch[f * B + m] = Math.log10(1 + 10000 * e);
        }
      }
      out.push(patch);
    }
    return out;
  }
  // run the network on a song's audio (16 kHz mono)
  async listen(x) {
    const M = await this.ready();
    if (!M) return null;
    const patches = this.melPatches(x);
    if (!patches.length) return null;
    const { tf, embed, heads } = M;
    const flat = new Float32Array(patches.length * 187 * 96);
    patches.forEach((p, i) => flat.set(p, i * 187 * 96));
    const input = tf.tensor3d(flat, [patches.length, 187, 96]);
    let emb;
    try {
      emb = await runNode(embed, input, 'model/dense/BiasAdd');
      const res = { v: AI_VERSION };
      const e = await emb.mean(0).data();
      let norm = 0; for (const v of e) norm += v * v; norm = Math.sqrt(norm) || 1;
      res.emb = packEmb(Array.from(e, (v) => v / norm));
      for (const [k, { model, pos }] of Object.entries(heads)) {
        try { const o = await runNode(model, emb); const pr = await o.mean(0).data(); o.dispose(); res[k] = Math.round(pr[pos] * 100) / 100; } catch (er) { /* */ }
      }
      return res;
    } finally { input.dispose(); emb?.dispose?.(); }
  }
  // queue a song's audio (any ArrayBuffer of an audio file) — one at a time, never in the background
  add(t, buf, onDone) {
    if (!this.on || (this._retryAt && Date.now() < this._retryAt)) return;
    this.queue = this.queue.filter((q) => q.t.id !== t.id);
    this.queue.push({ t, buf, onDone });
    if (this.queue.length > 4) this.queue.shift();
    this.pump();
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        // never while the phone is locked or two songs are being mixed — the music always comes first
        if (document.visibilityState === 'hidden' || this.busy2?.()) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        const { t, buf, onDone } = this.queue.shift();
        const t0 = performance.now();
        try {
          const x = await decode16k(buf);
          const r = await this.listen(x);
          if (r) { this.done++; onDone?.(r); dlog('ai-listened', { song: t.title, ms: performance.now() - t0, party: r.party, dance: r.dance }); }
          else if (this.state === 'error') { this.queue = []; break; }
        } catch (e) { dlog('ai-song-fail', { song: t.title, why: e.message }); }
        await new Promise((r) => setTimeout(r, 300)); // (let the music breathe between songs)
      }
    } finally { this.busy = false; }
  }
}

async function runNode(model, input, node) {
  try { return node ? model.execute(input, node) : model.execute(input); }
  catch (e) { return node ? model.executeAsync(input, node) : model.executeAsync(input); }
}
async function decode16k(buf) {
  const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new C(1, 1, 16000);
  const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); });
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const a = ab.getChannelData(0), b = ab.getChannelData(1), x = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) x[i] = (a[i] + b[i]) * 0.5;
  return x;
}
// Slaney mel filters with area normalisation (what MusiCNN was trained with)
function melBank(N, sr, B) {
  const hz2mel = (f) => (f < 1000 ? (3 * f) / 200 : 15 + 27 * Math.log(f / 1000) / Math.log(6.4));
  const mel2hz = (m) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) * (m - 15)) / 27));
  const m0 = hz2mel(0), m1 = hz2mel(sr / 2);
  const pts = []; for (let i = 0; i < B + 2; i++) pts.push(mel2hz(m0 + ((m1 - m0) * i) / (B + 1)));
  const binHz = sr / N, bank = [];
  for (let m = 0; m < B; m++) {
    const a = pts[m], c = pts[m + 1], d = pts[m + 2], norm = 2 / (d - a);
    const b0 = Math.floor(a / binHz), b1 = Math.min(N / 2, Math.ceil(d / binHz));
    const w = [];
    for (let b = b0; b <= b1; b++) { const f = b * binHz; w.push(Math.max(0, Math.min((f - a) / (c - a), (d - f) / (d - c))) * norm); }
    bank.push([b0, w]);
  }
  return bank;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
// fingerprint ↔ a short string (one signed byte per number) so it's tiny to store and sync
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function packEmb(v) {
  const bytes = v.map((x) => Math.max(-127, Math.min(127, Math.round(x * 400))) & 255);
  let s = ''; for (let i = 0; i < bytes.length; i += 3) { const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0); s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]; }
  return s;
}
export function unpackEmb(s, len = 200) {
  if (!s) return null;
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | (B64.indexOf(s[i + 2]) << 6) | B64.indexOf(s[i + 3]);
    for (const b of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) if (out.length < len) out.push(((b << 24) >> 24) / 400);
  }
  return out;
}
const embCache = new Map();
// how alike two songs sound, 0…1 (null when either hasn't been heard yet)
export function soundSim(a, b) {
  if (!a?.ai?.emb || !b?.ai?.emb) return null;
  const ea = embCache.get(a.ai.emb) || (embCache.set(a.ai.emb, unpackEmb(a.ai.emb)), embCache.get(a.ai.emb));
  const eb = embCache.get(b.ai.emb) || (embCache.set(b.ai.emb, unpackEmb(b.ai.emb)), embCache.get(b.ai.emb));
  let d = 0, na = 0, nb = 0; for (let i = 0; i < ea.length; i++) { d += ea[i] * eb[i]; na += ea[i] * ea[i]; nb += eb[i] * eb[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}
export const soundAI = new SoundAI();
