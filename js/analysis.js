// On-device audio analysis: BPM + beat grid, leading/trailing silence, fade-in/fade-out shape,
// and loudness (for auto-leveling files without ReplayGain). Results are cached per track.
import { library } from './library.js';
import { settings } from './settings.js';
import { nasUrl } from './util.js';
import { plex } from './plex.js';
import { onlineBpm, tempoRelation } from './bpm-online.js';
import { skv } from './db.js';
import { dlog } from './diag.js';
import { soundAI } from './sound-ai.js';

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

// ---- background downloads give way to the music ----
// When the playing song starts stuttering, every background download (measuring, preloading) is
// stopped and held back for a while, so the whole connection goes to what you're hearing.
let holdUntil = 0;
const bgCtls = new Set();
export function holdBackground(ms = 90000, { abort = true, release = false } = {}) {
  if (release) { holdUntil = Date.now(); return; }
  holdUntil = Math.max(holdUntil, Date.now() + ms);
  if (!abort) return;
  dlog('hold-downloads', { s: ms / 1000, stopped: bgCtls.size });
  for (const c of bgCtls) { try { c.abort(); } catch (e) { /* */ } }
  bgCtls.clear();
}
export const backgroundHeld = () => Date.now() < holdUntil;
let busyCheck = () => false;
export function setBusyCheck(fn) { busyCheck = fn; }
async function waitForGap(signal) {
  while (Date.now() < holdUntil || busyCheck()) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await new Promise((r) => setTimeout(r, 1500));
  }
}
export function isCached(t) { return library.isOffline(t) || cachedKeys.has(library.cacheKey(t)); }
const cachedKeys = new Set();

// Download a track fully and keep it in the "prefetch" cache so playback starts instantly.
export async function fetchTrackBuffer(t, signal, { store = true, urgent = false } = {}) {
  const key = library.cacheKey(t);
  for (const name of ['offline-tracks', 'prefetch']) {
    const c = await caches.open(name);
    const hit = await c.match(key);
    if (hit) return hit.arrayBuffer();
  }
  // background download: waits for a quiet moment and stops the moment the music needs the connection
  if (!urgent) await waitForGap(signal);
  const ctl = new AbortController();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
  if (!urgent) bgCtls.add(ctl);
  let blob;
  try {
    const r = await fetch(trackSrc(t), { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    blob = await r.blob();
  } finally { bgCtls.delete(ctl); }
  if (!t.demo && store) {
    try {
      const c = await caches.open('prefetch');
      await c.put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }));
      cachedKeys.add(key);
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
  if (t.size > 40e6) return; // a huge lossless file: the player streams it itself (a full copy only fights the music)
  try { await fetchTrackBuffer(t); } catch (e) { /* ignore */ }
}

// ---- fast measuring ----
// Big lossless files are measured from a small MP3 copy made by Plex. An MP3 can start a few ms late
// (encoder delay), which would put the beat grid off — so that delay is measured once, on one song,
// against the original file, and taken off every song measured this way.
const LITE_MIN = 12e6;
export function useLite(t) { return !!(t?.plex && plex.connected && (t.size || 0) > LITE_MIN && settings.get('fastAnalysis') !== false); }
async function cachedOriginal(t) {
  for (const name of ['offline-tracks', 'prefetch']) {
    const hit = await (await caches.open(name)).match(library.cacheKey(t));
    if (hit) return hit.arrayBuffer();
  }
  return null;
}
async function fetchLite(t, signal, urgent = false) {
  if (!urgent) await waitForGap(signal);
  const ctl = new AbortController();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
  if (!urgent) bgCtls.add(ctl);
  const tm = setTimeout(() => ctl.abort(), 45000); // Plex taking too long making the copy: try another time
  const t0 = performance.now();
  let ab;
  try {
    const r = await fetch(plex.liteUrl(t), { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    ab = await r.arrayBuffer();
  } finally { clearTimeout(tm); bgCtls.delete(ctl); }
  dlog('lite-copy', { song: t.title, mb: ab.byteLength / 1e6, s: (performance.now() - t0) / 1000 });
  if (ab.byteLength < 20000) throw new Error('short');
  return ab;
}
const DELAY_KEY = () => 'liteDelay:' + (plex.cfg?.server?.id || '');
let liteDelay;
async function getDelay() { if (liteDelay === undefined) liteDelay = (await skv.get(DELAY_KEY())) ?? null; return liteDelay; }
const shiftRec = (rec, d) => {
  if (!d) return rec;
  const beat = rec.bpm ? 60 / rec.bpm : 0;
  let off = (rec.beatOffset || 0) - d;
  if (beat) off = ((off % beat) + beat) % beat;
  const sh = Math.round(d * 2);
  return { ...rec, beatOffset: Math.round(off * 1000) / 1000, leadIn: Math.max(0, (rec.leadIn || 0) - d), tailOut: (rec.tailOut || 0) - d,
    fadeInEnd: Math.max(0, (rec.fadeInEnd || 0) - d), fadeOutStart: (rec.fadeOutStart || 0) - d, loud: sh > 0 && rec.loud ? rec.loud.slice(sh) : rec.loud };
};
let calibrating = false;
async function calibrate(t, liteRec) {
  if (calibrating || !networkOk() || navigator.connection?.type === 'cellular' || (t.size || 0) > 150e6) return;
  calibrating = true;
  try {
    const ab = await fetchTrackBuffer(t);
    const res = await analyzeBuffer(ab, liteRec.bpm);
    if (!res?.bpm || Math.abs(res.bpm - liteRec.bpm) > 0.6) return;
    const beat = 60 / res.bpm;
    let d = (liteRec.beatOffset || 0) - res.beatOffset;
    d = ((d % beat) + beat * 1.5) % beat - beat / 2; // nearest, either way
    if (Math.abs(d) > 0.12) return;
    liteDelay = Math.round(d * 1000) / 1000;
    await skv.set(DELAY_KEY(), liteDelay);
    // this song: the exact measurement from the original; every song measured from a copy: corrected
    library.setAnalysis({ ...liteRec, ...res, lite: 0 });
    for (const a of [...library.analysis.values()]) if (a.lite && !a.liteFixed) library.setAnalysis({ ...shiftRec(a, liteDelay), liteFixed: 1 });
  } catch (e) { /* try again another time */ } finally { calibrating = false; }
}

// ---- the sound AI ----
function listenTo(t, buf) {
  soundAI.add(t, buf, (ai) => {
    const a = library.analysis.get(t.id);
    if (a) library.setAnalysis({ ...a, ai });
  });
}
// a song that's measured but hasn't been listened to by the sound AI yet: fetch a copy for it
// (the small Plex copy, or the file if it's on the phone / not huge) — the playing and next songs only
const aiAsked = new Set();
export async function hearWithAI(t) {
  if (!soundAI.on || !t || t.demo || aiAsked.has(t.id)) return;
  const a = library.analysis.get(t.id);
  if (!a || a.ai?.v) return;
  aiAsked.add(t.id);
  try {
    let ab = await cachedOriginal(t);
    if (!ab && useLite(t)) { try { ab = await fetchLite(t); } catch (e) { /* */ } }
    if (!ab && (t.size || 0) < 40e6) ab = await fetchTrackBuffer(t, null, { store: true });
    if (ab) listenTo(t, ab);
  } catch (e) { aiAsked.delete(t.id); }
}

// songs measured from a copy (here or on another device) before the delay was known get corrected
export async function fixLite() {
  const d = await getDelay();
  if (d == null) return;
  for (const a of [...library.analysis.values()]) if (a.lite && !a.liteFixed) library.setAnalysis({ ...shiftRec(a, d), liteFixed: 1 });
}

export function analyze(t, { force = false, signal = null, urgent = false } = {}) {
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
      // the original if it's already on the phone; otherwise a small copy for big lossless files
      let ab = useLite(t) ? await cachedOriginal(t) : null, lite = false;
      if (!ab && useLite(t)) {
        try { ab = await fetchLite(t, signal, urgent); lite = true; } catch (e) {
          if (signal?.aborted) throw e;
          // no small copy: only a moderately sized original is downloaded instead (never a 100 MB one)
          if ((t.size || 0) > 40e6) { dlog('measure-skip', { song: t.title, mb: (t.size || 0) / 1e6, why: e?.message || e?.name }); return null; }
        }
      }
      if (!ab) ab = await fetchTrackBuffer(t, signal, { urgent });
      const online = await Promise.race([ob, new Promise((r) => setTimeout(() => r(0), 5000))]);
      const tag = t.bpm >= 40 && t.bpm <= 250 ? t.bpm : 0;
      const hint = online || tag;
      const tA = performance.now();
      // (the sound AI listens to its own copy: measuring uses this one up)
      const forAI = soundAI.on && ab.byteLength < 45e6 ? ab.slice(0) : null;
      let res = await analyzeBuffer(ab, hint);
      dlog('measured', { song: t.title, mb: ab.byteLength / 1e6, ms: performance.now() - tA, bpm: res?.bpm || 0 });
      if (!res) return null;
      let fixed = 0;
      if (lite) { const d = await getDelay(); if (d != null) { res = shiftRec(res, d); fixed = 1; } }
      const rec = { id: t.id, v: ANALYSIS_VERSION, ...res, at: Date.now(), bpmOnline: online || 0, ochk: online ? 1 : 0,
        bpmSrc: online ? 'online' : tag ? 'tag' : 'audio', ...(lite ? { lite: 1, liteFixed: fixed } : {}) };
      if (lite && !fixed) setTimeout(() => calibrate(t, rec), 4000);
      if (!online) ob.then((b) => { if (b && library.analysis.get(t.id) === rec) Object.assign(rec, { bpmOnline: b, ochk: 1 }) && library.setAnalysis(rec); });
      // a BPM you tapped in yourself always wins over detection
      const old = library.analysis.get(t.id);
      if (old?.tapped && old.bpm) {
        const r = old.bpm / (rec.bpm || old.bpm);
        Object.assign(rec, { bpm: old.bpm, bpmConf: 1, tapped: true });
        if (Math.abs(r - 1) > 0.03) rec.beatOffset = old.beatOffset ?? rec.beatOffset;
      }
      if (old?.ai) rec.ai = old.ai;
      library.setAnalysis(rec);
      if (forAI && !rec.ai) listenTo(t, forAI);
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

