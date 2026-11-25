// On-device audio analysis: BPM + beat grid, leading/trailing silence, fade-in/fade-out shape,
// and loudness (for auto-leveling files without ReplayGain). Results are cached per track.
import { library } from './library.js';
import { settings } from './settings.js';
import { nasUrl } from './util.js';
import { plex } from './plex.js';
import { onlineBpm, tempoRelation } from './bpm-online.js';

const SR = 11025;
const WIN = 256;               // ~23 ms envelope windows
const ANALYSIS_VERSION = 6;
const MAX_SECONDS = 20 * 60;   // skip very long files (mixes, audiobooks)
const inflight = new Map();
const PREFETCH_KEEP = 6;

export function trackSrc(t) {
  if (t.demo) return t.url;
  // Plex: stream straight from the server (the service worker serves it from cache when downloaded)
  if (t.plex) return plex.connected ? plex.partUrl(t) : library.cacheKey(t);
  return nasUrl(t.url, t.size);
}
// Results are kept forever: an app update never throws away BPM/key/beat grids that were already measured.
const MIN_USABLE = 4;
export function isAnalyzed(t) {
  const a = library.analysis.get(t.id);
  return !!a && a.v >= MIN_USABLE;
}

function networkOk() {
  const c = navigator.connection;
  if (settings.get('analysisNetwork') === 'wifi' && c && (c.type === 'cellular' || c.saveData)) return false;
  return true;
}

// Download a track fully and keep it in the "prefetch" cache so playback starts instantly.
export async function fetchTrackBuffer(t, signal, { store = true } = {}) {
  const key = library.cacheKey(t);
  for (const name of ['offline-tracks', 'prefetch']) {
    const c = await caches.open(name);
    const hit = await c.match(key);
    if (hit) return hit.arrayBuffer();
  }
  const r = await fetch(trackSrc(t), signal ? { signal } : undefined);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (!t.demo && store) {
    try {
      const c = await caches.open('prefetch');
      await c.put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }));
      const ks = await c.keys();
      for (let i = 0; i < ks.length - PREFETCH_KEEP; i++) await c.delete(ks[i]);
      navigator.serviceWorker?.controller?.postMessage({ type: 'cache-changed' });
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

export function analyze(t, { force = false, signal = null } = {}) {
  if (!t) return Promise.resolve(null);
  if (!force && isAnalyzed(t)) return Promise.resolve(library.analysis.get(t.id));
  if (inflight.has(t.id)) return inflight.get(t.id);
  if (!force && !networkOk()) return Promise.resolve(null);
  if ((t.duration || 0) > MAX_SECONDS || t.size > 400e6) return Promise.resolve(null);
  const p = (async () => {
    try {
      // the online tempo is looked up while the song downloads; it steers detection to the right
      // octave (no more half-time / double-time), and the audio still sets the exact value and beat grid
      const ob = onlineBpm(t);
      const ab = await fetchTrackBuffer(t, signal);
      const online = await Promise.race([ob, new Promise((r) => setTimeout(() => r(0), 5000))]);
      const tag = t.bpm >= 40 && t.bpm <= 250 ? t.bpm : 0;
      const hint = online || tag;
      const res = await analyzeBuffer(ab, hint);
      if (!res) return null;
      const rec = { id: t.id, v: ANALYSIS_VERSION, ...res, at: Date.now(), bpmOnline: online || 0, ochk: online ? 1 : 0,
        bpmSrc: online ? 'online' : tag ? 'tag' : 'audio' };
      if (!online) ob.then((b) => { if (b && library.analysis.get(t.id) === rec) Object.assign(rec, { bpmOnline: b, ochk: 1 }) && library.setAnalysis(rec); });
      // a BPM you tapped in yourself always wins over detection
      const old = library.analysis.get(t.id);
      if (old?.tapped && old.bpm) {
        const r = old.bpm / (rec.bpm || old.bpm);
        Object.assign(rec, { bpm: old.bpm, bpmConf: 1, tapped: true });
        if (Math.abs(r - 1) > 0.03) rec.beatOffset = old.beatOffset ?? rec.beatOffset;
      }
      library.setAnalysis(rec);
      return rec;
    } catch (e) {
      if (e?.name !== 'AbortError') console.warn('analysis failed', t.title, e);
      return null;
    } finally {
      inflight.delete(t.id);
    }
  })();
  inflight.set(t.id, p);
  return p;
}

// Songs measured before online tempos existed get checked once: if the stored BPM disagrees with the
// online one, the song is re-measured with the online tempo as its guide (cached audio → no new download).
const verifying = new Set();
export async function verifyBpm(t, { reanalyze = true } = {}) {
  const a = t && library.analysis.get(t.id);
  if (!a || a.ochk || a.tapped || verifying.has(t.id) || !settings.get('onlineBpm')) return a;
  verifying.add(t.id);
  try {
    const online = await onlineBpm(t);
    const cur = library.analysis.get(t.id);
    if (cur !== a) return cur;
    if (!online) { if (navigator.onLine) library.setAnalysis({ ...a, ochk: 1 }); return a; }
    const f = tempoRelation(a.bpm, online);
    if (f === 1) { library.setAnalysis({ ...a, ochk: 1, bpmOnline: online, bpmSrc: 'online' }); return library.analysis.get(t.id); }
    // half-time read: every detected beat is still a real beat, so the grid survives a simple ×2
    const quick = f === 2 ? { ...a, bpm: Math.round(a.bpm * 20) / 10, ochk: 1, bpmOnline: online, bpmSrc: 'online', bpmFixed: a.bpm } : { ...a, bpmOnline: online, ochk: 0 };
    library.setAnalysis(quick);
    if (reanalyze && f !== 2) { const r = await analyze(t, { force: true }); if (r) { r.bpmFixed = a.bpm; library.setAnalysis(r); } return r || quick; }
    return quick;
  } catch (e) { return a; }
  finally { verifying.delete(t.id); }
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

export async function analyzeBuffer(ab, hint = 0) {
  const buf = await decode(ab);
  if (buf.length < SR * 3) return null;
  const lp = await lowpass(buf, 180);
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
  return runCore({ channels, lp: lp.slice(), SR, duration: buf.duration, hint });
}

// heavy math runs in a background thread
let worker = null, seq = 0;
const waiting = new Map();
function runCore(job) {
  try {
    if (!worker) {
      worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); e.data.error ? w.rej(new Error(e.data.error)) : w.res(e.data.result); } };
      worker.onerror = () => { for (const w of waiting.values()) w.rej(new Error('worker')); waiting.clear(); worker = null; };
    }
    const id = ++seq;
    return new Promise((res, rej) => {
      waiting.set(id, { res, rej });
      worker.postMessage({ id, job }, [...job.channels.map((c) => c.buffer), job.lp.buffer]);
    }).catch(() => import('./analysis-core.js').then((m) => m.computeAnalysis(job)));
  } catch (e) {
    return import('./analysis-core.js').then((m) => m.computeAnalysis(job));
  }
}

