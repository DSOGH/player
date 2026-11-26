// Playback engine: two decks (audio elements) routed through Web Audio for sample-accurate fades,
// ReplayGain/auto leveling, EQ and a limiter. Handles gapless, crossfade and "smart" transitions
// (silence trimming, fade-aware overlaps, album awareness, beat-matched + tempo-matched mixing).
import { settings, EQ_FREQS, EQ_PRESETS } from './settings.js';
import { library } from './library.js';
import { analyze, prefetchTrack, trackSrc, isAnalyzed, verifyBpm, fetchTrackBuffer } from './analysis.js';
import { onlineBpm, onlineBpmCached } from './bpm-online.js';
import { Emitter, shuffleArr, clamp } from './util.js';
import * as db from './db.js';
import { artUrl, lockScreenArtwork } from './art.js';
import { findCue, findHandoff, titleEntry, keyCompat } from './dj.js';
import { getLyrics, cachedLyrics } from './lyrics.js';
import { plex } from './plex.js';

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 0.1s of silence, used to unlock audio elements inside a tap (iOS only lets elements started by a tap play later on their own)
const SILENT = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

const dbToLin = (db) => Math.pow(10, db / 20);

// Where the next song "drops" (first big, lasting jump in loudness in its first half), snapped to
// its bar grid — so a blend can finish exactly as the drop hits, like a DJ would time it
function findDrop(a, bpm) {
  const L = a?.loud;
  if (!L || !bpm || L.length < 40) return null;
  const bar = 240 / bpm, perBar = bar * 2; // envelope has 2 points per second
  const mean = (i0, i1) => { let s = 0, c = 0; for (let i = Math.max(0, Math.floor(i0)); i < Math.min(L.length, Math.ceil(i1)); i++) { s += L[i]; c++; } return c ? s / c : 0; };
  let mx = 0; for (const v of L) if (v > mx) mx = v;
  const limit = Math.min(L.length * 0.5, 240);
  for (let i = Math.ceil(perBar * 4); i < limit; i++) {
    const before = mean(i - perBar * 8, i), after = mean(i, i + perBar * 4);
    if (after >= before * 1.4 && after >= mx * 0.6 && after - before >= 12) {
      // the exact spot: the steepest rise within the next few bars
      let j = i, best = -1;
      for (let k = i; k < Math.min(L.length - 1, i + perBar * 4); k++) { const r = L[k + 1] - L[k]; if (r > best) { best = r; j = k + 1; } }
      const off = a.beatOffset || 0;
      const t = off + Math.round((j / 2 - off) / bar) * bar;
      return t > 6 ? t : null;
    }
  }
  return null;
}
// Where the singing is, from synced lyrics: [[start, end], …] in track seconds (each line lasts until the
// next one, at most 6 s)
function vocalSpans(lyr) {
  if (!lyr?.synced) return null;
  const L = lyr.lines, out = [];
  for (let i = 0; i < L.length; i++) {
    if (!L[i].text) continue;
    const next = L[i + 1]?.t ?? L[i].t + 4;
    out.push([L[i].t, Math.min(next, L[i].t + 6)]);
  }
  return out.length ? out : null;
}
// Seconds during a blend where both songs are singing and both are clearly audible (the outgoing song
// is loud for the first ~80%, the incoming one from ~25%)
function vocalClash(vA, vB, ms, aRate, bS, bRate, ov) {
  const a = vA.map(([x, y]) => [(x - ms) / aRate, (y - ms) / aRate]).filter(([x, y]) => y > ov * 0.25 && x < ov * 0.8);
  const b = vB.map(([x, y]) => [(x - bS) / bRate, (y - bS) / bRate]).filter(([x, y]) => y > ov * 0.25 && x < ov * 0.8);
  let sum = 0;
  for (const [x1, y1] of a) for (const [x2, y2] of b) sum += Math.max(0, Math.min(y1, y2, ov * 0.8) - Math.max(x1, x2, ov * 0.25));
  return sum;
}
const BASS_CUT = -26;      // dB, low-shelf cut used for DJ "bass swaps"
const HP_OFF = 12, LP_OFF = 22000;

class Deck {
  constructor(name) {
    this.name = name;
    this.track = null;
    this.token = 0;
    this.fadeVal = 1;  // used when the deck isn't routed through Web Audio
    this.rgLin = 1;
    this.fadeTimer = null;
    this.rateTimer = null;
    // Two elements per deck, both created (and unlocked by the first tap) up front: iOS won't let
    // an element created later start playing on its own, which made fallbacks silently fail.
    this.els = { false: this.mk(false), true: this.mk(true) };
    this.el = this.els.false;
    this.raw = false;
    this.node = null;
  }
  mk(raw) {
    const el = new Audio();
    if (!raw) el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.preservesPitch = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    return el;
  }
  // raw = plain element without CORS (works with any Plex server, but no Web Audio effects)
  make(raw) {
    this.el = this.els[raw];
    this.raw = raw;
  }
  get fx() { return !this.raw && !!this.node; }
  get unlocked() { return !!(this.els.false._unlocked && this.els.true._unlocked); }
  load(track, startAt = 0, src = null) {
    this.token++;
    if (!src) this.attempt = 0;
    this.switching = true;
    setTimeout(() => { this.switching = false; }, 60);
    this.track = track;
    clearInterval(this.rateTimer);
    this.el.playbackRate = 1;
    this.el.defaultPlaybackRate = 1;
    // a deck left running silently after a mix (iPhone, see softUnload) is put to use again
    for (const e of Object.values(this.els)) { if (e !== this.el && e._silentTail) { e._silentTail = false; try { e.pause(); } catch (er) { /* */ } } }
    this.el._silentTail = false;
    this.el.src = (src || trackSrc(track)) + (startAt > 0.05 ? `#t=${startAt.toFixed(3)}` : '');
    this.el.load();
    this.wantStart = startAt;
    if (startAt > 0.05) {
      const tok = this.token, el = this.el;
      const fix = () => {
        if (tok !== this.token) return;
        if (Math.abs(el.currentTime - startAt) > 0.25) { try { el.currentTime = startAt; } catch (e) { /* */ } }
      };
      el.addEventListener('loadedmetadata', fix, { once: true });
    }
  }
  // iPhone / CarPlay: stopping or emptying the old song's player right after a mix makes iOS think the
  // music paused (wrong button in CarPlay, a click, sometimes it really stops). So the old song just
  // keeps running silently until its own end, or until this deck is needed for the next song.
  // iPhone: after a mix the old song's player is only ever PAUSED — never emptied (removing its source
  // and reloading it is what made iOS end the whole audio session: the music stopped after a mix).
  // It's already silent through Web Audio; 3 s later, once the new song owns Now Playing, it's paused.
  softUnload() {
    this.token++;
    this.track = null;
    clearInterval(this.fadeTimer);
    clearInterval(this.rateTimer);
    const el = this.el, tok = this.token;
    if (this.raw) { try { el.pause(); } catch (e) { /* */ } return; }
    el._silentTail = true;
    setTimeout(() => { if (el._silentTail && this.token === tok) { el._silentTail = false; try { el.pause(); } catch (e) { /* */ } } }, 3000);
  }
  unload() {
    this.token++;
    this.track = null;
    clearInterval(this.fadeTimer);
    clearInterval(this.rateTimer);
    try { this.el.pause(); } catch (e) { /* */ }
    this.el.removeAttribute('src');
    try { this.el.load(); } catch (e) { /* */ }
  }
}

class Engine extends Emitter {
  constructor() {
    super();
    this.decks = [new Deck('A'), new Deck('B')];
    this.ai = 0;
    this.queue = [];
    this.index = -1;
    this.origQueue = null;
    this.shuffle = false;
    this.repeat = 'off'; // off | all | one
    this.context = null; // { type, id, name }
    this.ctx = null;
    this.plan = null;
    this.upcoming = null;     // { index, track }
    this.planTimer = null;
    this.transition = null;
    this.errors = 0;
    this.sleepAt = 0;
    this.sleepEndOfTrack = false;
    this.volume = 1;
    this.playing = false;
    this.autoplayFrom = -1;
    this.decks.forEach((d) => this.wireDeck(d));
    this.tickTimer = setInterval(() => this.tick(), 200);
    settings.on('change', (k) => this.onSetting(k));
    library.on('analysis', (id) => this.onAnalysis(id));
    plex.on?.('connection', () => { this._corsOk = undefined; });
    this.saveState = this.debouncedSave();
    this.skipToken = 0;
  }

  get cur() { return this.decks[this.ai]; }
  get other() { return this.decks[1 - this.ai]; }
  get track() { return this.cur.track; }
  get enhanced() { return !!this.ctx; }
  // while a seek is still loading, report where you asked to go (the slider/clock jump there immediately)
  get currentTime() {
    const d = this.cur;
    // (a seek / a start point is shown right away, also while the song is still loading)
    if (this._seekTo != null && this._seekDeck === d && performance.now() - this._seekAt < 4000
      && (d.el.seeking || performance.now() - this._seekAt < 250 || (d.el.readyState < 2 && performance.now() - this._seekAt < 4000))) return this._seekTo;
    const ct = d.el.currentTime || 0;
    const now = performance.now(), r = d.el.playbackRate || 1;
    // A smooth clock for the scrubber, lyrics and the DJ: iPhone reports the position in coarse, uneven
    // steps (worse while two songs play during a mix), so position = last known point + elapsed time ×
    // speed, gently pulled toward what the player reports; a real jump (seek, new song) resets it.
    let m = this._pm;
    if (!m || m.d !== d || m.tok !== d.token || !this.playing || d.el.paused || d.el.seeking) {
      this._pm = { d, tok: d.token, pos: ct, at: now, r, ct };
      return ct;
    }
    let pred = m.pos + ((now - m.at) / 1000) * m.r;
    if (Math.abs(r - m.r) > 0.0005) { m.pos = pred; m.at = now; m.r = r; }
    if (ct !== m.ct) {
      m.ct = ct; m.ctAt = now;
      const err = ct - pred;
      if (Math.abs(err) > 0.35) { m.pos = ct; m.at = now; pred = ct; }      // a real jump
      else { m.pos = pred + err * 0.2; m.at = now; pred = m.pos; }       // drift: ease toward it
    } else if (now - (m.ctAt || m.at) > 450 && !this.audible()) {
      // the player's clock stopped and nothing is coming out: it's buffering, so the clock waits too
      m.pos = Math.min(pred, ct + 0.3); m.at = now; pred = m.pos;
    }
    return Math.max(0, Math.min(pred, this.duration || Infinity));
  }
  // is sound actually coming out right now? (tells a frozen clock apart from real buffering)
  audible() {
    const now = performance.now();
    if (this._audAt && now - this._audAt < 120) return this._aud;
    this._audAt = now;
    if (!this.analyser || !this.ctx || this.ctx.state !== 'running') return (this._aud = false);
    const buf = this._audBuf || (this._audBuf = new Float32Array(512));
    this.analyser.getFloatTimeDomainData(buf);
    let pk = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i] < 0 ? -buf[i] : buf[i]; if (v > pk) pk = v; }
    return (this._aud = pk > 0.004);
  }
  get duration() { return this.durationOf(this.cur); }
  durationOf(d) {
    const x = d.el.duration;
    return isFinite(x) && x > 0 ? x : d.track?.duration || 0;
  }

  // ---------- audio graph ----------
  ensureGraph() {
    if (this.ctx || settings.get('engine') !== 'enhanced') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC({ latencyHint: 'playback' });
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.eq = EQ_FREQS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      });
      this.eqPre = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      this.volNode = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      // echo bus for "echo out" transitions: delay with filtered feedback
      this.echoIn = ctx.createGain();
      this.echoDelay = ctx.createDelay(3);
      this.echoFb = ctx.createGain();
      this.echoTone = ctx.createBiquadFilter();
      this.echoTone.type = 'lowpass'; this.echoTone.frequency.value = 3200;
      this.echoFb.gain.value = 0.5;
      this.echoIn.connect(this.echoDelay);
      this.echoDelay.connect(this.echoTone).connect(this.echoFb).connect(this.echoDelay);
      this.echoTone.connect(this.input);
      for (const d of this.decks) this.attachNodes(d);
      // real-time vocal isolation for word-play transitions
      this.voxReady = false;
      if (ctx.audioWorklet) {
        ctx.audioWorklet.addModule(new URL('./vocal-worklet.js', import.meta.url).href).then(() => {
          this.voxReady = true;
          for (const d of this.decks) this.attachVox(d);
          if (this.upcoming) this.computePlan();
        }).catch((e) => console.warn('vocal isolation unavailable', e));
      }
      this.rewire();
      this.applyEq();
      this.applyMono();
      this.volNode.gain.value = this.volume * this.volume;
      for (const d of this.decks) { d.el.volume = d.fx ? 1 : d.el.volume; if (d.track) this.applyDeckGain(d); }
      ctx.addEventListener?.('statechange', () => this.emit('state'));
    } catch (e) {
      console.warn('Web Audio unavailable, using simple engine', e);
      this.ctx = null;
    }
  }
  attachNodes(d) {
    const ctx = this.ctx;
    if (!ctx || d.node) return;
    d.node = ctx.createMediaElementSource(d.els.false);
    d.rg = ctx.createGain();
    d.bass = ctx.createBiquadFilter(); d.bass.type = 'lowshelf'; d.bass.frequency.value = 180; d.bass.gain.value = 0;
    d.hp = ctx.createBiquadFilter(); d.hp.type = 'highpass'; d.hp.frequency.value = HP_OFF; d.hp.Q.value = 0.7;
    d.lp = ctx.createBiquadFilter(); d.lp.type = 'lowpass'; d.lp.frequency.value = LP_OFF; d.lp.Q.value = 0.7;
    d.fade = ctx.createGain();
    d.send = ctx.createGain(); d.send.gain.value = 0;
    // constant delay equal to the vocal isolator's latency, so dry and isolated vocal stay sample-aligned
    d.lat = ctx.createDelay(0.2); d.lat.delayTime.value = 2048 / ctx.sampleRate;
    // dry = the normal signal; during a vocal-free blend it hands over to the instrumental from the isolator
    d.dry = ctx.createGain();
    d.mid = ctx.createBiquadFilter(); d.mid.type = 'peaking'; d.mid.frequency.value = 1100; d.mid.Q.value = 0.7; d.mid.gain.value = 0;
    d.node.connect(d.rg).connect(d.lat).connect(d.dry).connect(d.bass).connect(d.mid).connect(d.hp).connect(d.lp).connect(d.fade).connect(this.input);
    d.fade.connect(d.send).connect(this.echoIn);
    // "karaoke" underlay: side signal (L-R removes centered vocals) + the low end, cheap native nodes
    d.instGain = ctx.createGain(); d.instGain.gain.value = 0;
    const sp = ctx.createChannelSplitter(2), inv = ctx.createGain(), side = ctx.createGain(), low = ctx.createBiquadFilter();
    inv.gain.value = -1; side.gain.value = 0.8; low.type = 'lowpass'; low.frequency.value = 150;
    d.lat.connect(sp); sp.connect(side, 0); sp.connect(inv, 1); inv.connect(side);
    d.lat.connect(low);
    side.connect(d.instGain); low.connect(d.instGain);
    d.instGain.connect(this.input);
    d.kara = [sp, inv, side, low];
    if (this.voxReady) this.attachVox(d);
  }
  attachVox(d) {
    const ctx = this.ctx;
    if (!ctx || !d.node || d.vox || !this.voxReady) return;
    try {
      d.vox = new AudioWorkletNode(ctx, 'vocal-split', { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 2] });
      d.voxGain = ctx.createGain(); d.voxGain.gain.value = 0;
      d.voxSend = ctx.createGain(); d.voxSend.gain.value = 0;
      d.rg.connect(d.vox);
      d.vox.connect(d.voxGain, 0);
      // instrumental (vocals removed) joins the normal chain, so filters / fades / bass swaps still apply
      d.instV = ctx.createGain(); d.instV.gain.value = 0;
      d.vox.connect(d.instV, 1);
      d.instV.connect(d.bass);
      d.voxGain.connect(this.input);
      d.voxGain.connect(d.voxSend).connect(this.echoIn);
    } catch (e) { d.vox = null; }
  }
  voxActive(d, on) { try { d.vox?.port.postMessage({ active: on }); } catch (e) { /* */ } }
  detachNodes(d) {
    this.voxActive(d, false);
    for (const k of d.kara || []) { try { k.disconnect(); } catch (e) { /* */ } }
    d.kara = null;
    for (const n of ['node', 'rg', 'lat', 'bass', 'hp', 'lp', 'fade', 'send', 'vox', 'voxGain', 'instGain', 'voxSend']) { try { d[n]?.disconnect(); } catch (e) { /* */ } d[n] = null; }
  }
  // Swap a deck's <audio> element when it needs to change between Web Audio (CORS) and raw mode.
  prepareDeck(d, track, forceRaw = false) {
    const raw = forceRaw || settings.get('engine') !== 'enhanced' || !!(track?.plex && this.plexNoCors);
    if (d.raw === raw) return;
    try { d.el.pause(); d.el.removeAttribute('src'); d.el.load(); } catch (e) { /* */ }
    d.make(raw);
    if (!raw && this.ctx) this.attachNodes(d);
    d.el.volume = d.fx ? 1 : clamp(d.rgLin * d.fadeVal * this.volume, 0, 1);
  }
  loadDeck(d, track, startAt = 0) {
    this.prepareDeck(d, track);
    this.resetFx(d);
    d.load(track, startAt);
  }
  resetFx(d) {
    if (!d.node || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [p, v] of [[d.bass.gain, 0], [d.hp.frequency, HP_OFF], [d.lp.frequency, LP_OFF], [d.send.gain, 0],
      [d.instGain.gain, 0], ...(d.dry ? [[d.dry.gain, 1]] : []), ...(d.mid ? [[d.mid.gain, 0]] : []), ...(d.vox ? [[d.voxGain.gain, 0], [d.voxSend.gain, 0], ...(d.instV ? [[d.instV.gain, 0]] : [])] : [])]) {
      p.cancelScheduledValues(0);
      p.setValueAtTime(v, now);
    }
    this.voxActive(d, false);
  }
  rewire() {
    if (!this.ctx) return;
    const chain = [this.input];
    try { this.input.disconnect(); } catch (e) { /* */ }
    this.eq.forEach((b) => { try { b.disconnect(); } catch (e) { /* */ } });
    try { this.eqPre.disconnect(); this.limiter.disconnect(); this.volNode.disconnect(); this.analyser.disconnect(); } catch (e) { /* */ }
    if (settings.get('eqOn')) chain.push(this.eqPre, ...this.eq);
    if (settings.get('limiter')) chain.push(this.limiter);
    chain.push(this.volNode, this.analyser);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    this.analyser.connect(this.ctx.destination);
  }
  applyEq() {
    if (!this.ctx) return;
    const preset = settings.get('eqPreset');
    const bands = preset === 'custom' || !EQ_PRESETS[preset] ? settings.get('eqBands') : EQ_PRESETS[preset];
    const t = this.ctx.currentTime;
    bands.forEach((g, i) => this.eq[i].gain.setTargetAtTime(g, t, 0.05));
    // headroom so boosts don't clip
    const maxBoost = Math.max(0, ...bands);
    this.eqPre.gain.setTargetAtTime(dbToLin(-maxBoost * 0.6), t, 0.05);
  }
  applyMono() {
    if (!this.ctx) return;
    const mono = settings.get('mono');
    this.input.channelCount = mono ? 1 : 2;
    this.input.channelCountMode = mono ? 'explicit' : 'max';
    this.input.channelInterpretation = 'speakers';
  }
  async resume() {
    if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* */ } }
  }

  // ---------- gains ----------
  isAlbumContext(t) {
    if (this.context?.type === 'album' && !this.shuffle) return true;
    const q = this.queue;
    const prev = library.track(q[this.index - 1]), nxt = library.track(q[this.index + 1]);
    return (prev && prev.albumId === t.albumId) || (nxt && nxt.albumId === t.albumId);
  }
  gainDbFor(t) {
    const mode = settings.get('leveling');
    if (!t || mode === 'off') return 0;
    const album = mode === 'album' || (mode === 'smart' && this.isAlbumContext(t));
    let g = album ? (t.rgAlbum ?? t.rgTrack) : (t.rgTrack ?? t.rgAlbum);
    let peak = album ? (t.rgAlbumPeak ?? t.rgTrackPeak) : (t.rgTrackPeak ?? t.rgAlbumPeak);
    if (g === undefined && settings.get('autoLevel')) {
      const an = library.analysis.get(t.id);
      if (an?.loudnessDb) { g = clamp(-16 - an.loudnessDb, -14, 8); peak = dbToLin(an.peakDb); }
    }
    if (g === undefined) return 0;
    g += settings.get('levelPreamp');
    if (!settings.get('limiter') && peak > 0) g = Math.min(g, -20 * Math.log10(peak));
    return clamp(g, -24, 12);
  }
  applyDeckGain(d, smooth = false) {
    const g = dbToLin(this.gainDbFor(d.track));
    if (d.fx) {
      if (smooth) d.rg.gain.setTargetAtTime(g, this.ctx.currentTime, 0.4);
      else d.rg.gain.value = g;
    } else {
      d.rgLin = Math.min(1, g);
      this.applySimpleVolume(d);
    }
  }
  applySimpleVolume(d) {
    d.el.volume = clamp(d.rgLin * d.fadeVal * this.volume, 0, 1);
  }
  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.ctx) this.volNode.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.03);
    this.decks.forEach((d) => { if (!d.fx) this.applySimpleVolume(d); });
    db.kv.set('volume', this.volume);
    this.emit('volume', this.volume);
  }

  // ---------- fades ----------
  curve(from, to, n, shape) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      let s;
      if (shape === 'linear') s = x;
      else if (shape === 'scurve') s = x * x * (3 - 2 * x);
      else s = to > from ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2);
      c[i] = from + (to - from) * s;
    }
    return c;
  }
  fade(d, to, dur, { delay = 0, shape = settings.get('fadeCurve') } = {}) {
    clearInterval(d.fadeTimer);
    if (d.fx) {
      const g = d.fade.gain;
      const now = this.ctx.currentTime;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now); else g.cancelScheduledValues(now);
      const from = g.value;
      if (dur <= 0.005) { g.setValueAtTime(to, now + 0.002 + delay); }
      else g.setValueCurveAtTime(this.curve(from, to, 128, shape), now + 0.004 + delay, dur);
    } else {
      const from = d.fadeVal;
      const t0 = performance.now() + delay * 1000;
      const c = this.curve(from, to, 128, shape);
      if (dur <= 0.005 && !delay) { d.fadeVal = to; this.applySimpleVolume(d); return; }
      d.fadeTimer = setInterval(() => {
        const x = (performance.now() - t0) / (dur * 1000);
        if (x < 0) return;
        d.fadeVal = x >= 1 ? to : c[Math.floor(x * 127)];
        this.applySimpleVolume(d);
        if (x >= 1) clearInterval(d.fadeTimer);
      }, 25);
    }
  }
  setFade(d, v) {
    clearInterval(d.fadeTimer);
    if (d.fx) {
      const g = d.fade.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(0);
      g.setValueAtTime(v, now);
      g.value = v;
    } else { d.fadeVal = v; this.applySimpleVolume(d); }
  }
  // Speed glides use a few discrete steps: every playbackRate change re-tunes the browser's
  // pitch-preserving stretcher and can click, so fewer, bigger steps sound cleaner than many tiny ones.
  rampRate(d, to, sec) {
    clearInterval(d.rateTimer);
    const from = d.el.playbackRate;
    if (Math.abs(from - to) < 0.001) return;
    const steps = IOS ? 1 : Math.max(1, Math.min(4, Math.round(Math.abs(to - from) / 0.012)));
    let k = 0;
    const step = () => {
      k++;
      d.el.playbackRate = from + ((to - from) * k) / steps;
      if (k >= steps) { clearInterval(d.rateTimer); if (d === this.cur) this.updatePosition(); }
    };
    if (sec <= 0.3 || steps === 1) { k = steps - 1; step(); return; }
    d.rateTimer = setInterval(step, (sec * 1000) / steps);
  }

  // ---------- deck events ----------
  // A song failed to load: work through every way of getting it to play before giving up.
  //  1. re-find the Plex server (network changed: home Wi-Fi ↔ cellular)
  //  2. plain playback without Web Audio (server blocks cross-origin audio)
  //  3. ask Plex to convert it to MP3 (format the phone can't decode)
  //  4. skip, with one message
  async corsOk(url) {
    if (this._corsOk !== undefined) return this._corsOk;
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-1' }, mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(6000) });
      try { r.body?.cancel(); } catch (e) { /* */ }
      this._corsOk = true;
    } catch (e) {
      if (e.name === 'TimeoutError' || navigator.onLine === false) return true; // unknown — don't give up effects
      this._corsOk = false;
    }
    return this._corsOk;
  }
  async recover(d, err) {
    if (!d.track || d.recovering) return;
    d.recovering = true;
    try { await this._recover(d, err); } finally { d.recovering = false; }
  }
  async _recover(d, err) {
    const t = d.track;
    const pos = Math.max(d.wantStart || 0, d.el.currentTime || 0);
    const wasCur = d === this.cur;
    const retry = (stage, src, raw = d.raw) => {
      if (raw !== d.raw) this.prepareDeck(d, t, raw);
      this.resetFx(d);
      d.load(t, pos, src);
      d.attempt = stage;
      this.applyDeckGain(d);
      if (wasCur) { this.setFade(d, 1); if (this.playing) d.el.play().catch(() => {}); } else this.setFade(d, 0);
    };
    const at = d.attempt || 0;
    if (t.plex && plex.connected) {
      if (at < 1) {
        if (wasCur) this.emit('buffering', true);
        const changed = await plex.reconnect();
        if (d.track !== t) return;
        if (changed) { retry(1, plex.partUrl(t)); return; }
      }
      // only drop Web Audio if the server really refuses cross-origin audio (a broken file is a different problem)
      if (at < 2 && !d.raw && err?.code !== 1 && !(await this.corsOk(plex.partUrl(t)))) {
        if (d.track !== t) return;
        console.warn('Plex audio blocked for Web Audio; using direct playback');
        this.plexNoCors = true;
        retry(2, plex.partUrl(t), true);
        this.emit('fallback');
        return;
      }
      if (at < 3) { retry(3, plex.transcodeUrl(t)); return; }
    } else if (at < 1 && !t.demo && navigator.onLine !== false) {
      retry(1, trackSrc(t)); return;
    }
    if (!wasCur) {
      // the preloaded next song can't be played: don't mix into it; it gets one more try (and a message) when its turn comes
      if (this.upcoming?.track === t && !this.transition) { this.failedNext = t.id; this.cancelNext(); }
      return;
    }
    this.errors++;
    this.emit('error', t, err);
    if (this.errors <= 4 && this.index + 1 < this.queue.length) setTimeout(() => { if (this.cur.track === t) this.playIndex(this.index + 1, { mode: 'cut' }); }, 600);
    else { this.playing = false; this.emit('state'); }
  }
  wireDeck(d) {
    for (const el of Object.values(d.els)) this.wireEl(d, el);
  }
  wireEl(d, el) {
    el.addEventListener('ended', () => {
      if (el !== d.el || d !== this.cur || this.transition) return;
      this.onEnded();
    });
    el.addEventListener('error', () => {
      if (el !== d.el || !d.track || el.getAttribute('src') === SILENT) return;
      this.recover(d, el.error);
    });
    el.addEventListener('playing', () => {
      if (el !== d.el || d !== this.cur) return;
      this.errors = 0;
      this.emit('buffering', false);
      // iOS/CarPlay take "Now Playing" from whichever element just started: re-send the song info
      this.updateMediaSession();
    });
    el.addEventListener('playing', () => {
      if (el === d.el && d === this.cur && this.playing) { try { navigator.mediaSession.playbackState = 'playing'; } catch (e) { /* */ } this.updatePosition(); }
    });
    el.addEventListener('seeked', () => {
      if (el !== d.el) return;
      if (this._seekDeck === d) this._seekTo = null;
      if (d === this.cur) { this.emit('time'); this.updatePosition(); this.emit('buffering', false); }
    });
    el.addEventListener('seeking', () => { if (el === d.el && d === this.cur) this.emit('buffering', true); });
    el.addEventListener('waiting', () => { if (el === d.el && d === this.cur) this.emit('buffering', true); });
    el.addEventListener('pause', () => {
      // paused by the OS (another app took audio focus, headphones unplugged...)
      if (el === d.el && d === this.cur && this.playing && !this.transition && !this._pausing && !d.switching && !el.ended && d.track
        && !el.seeking && performance.now() - (this._seekAt || 0) > 1500) {
        this.playing = false;
        this.emit('state');
        this.updatePosition();
      }
    });
    el.addEventListener('play', () => {
      if (el === d.el && d === this.cur && !this.playing) { this.playing = true; this.emit('state'); }
    });
    el.addEventListener('durationchange', () => {
      if (el !== d.el) return;
      if (d === this.cur && d.track && isFinite(el.duration) && Math.abs((d.track.duration || 0) - el.duration) > 1) {
        d.track.duration = el.duration;
        db.put('tracks', d.track);
      }
      if (d === this.cur) this.emit('time');
    });
  }
  // ---------- queue ----------
  // DJ Cook It Up: your whole library in random order, mixed with a different wild transition each time
  cookItUp(pool = null, { keepCurrent = false, name = 'DJ Cook It Up' } = {}) {
    let all = (pool || [...library.tracks.values()].filter((t) => library.visible(t))).filter((t) => (t.duration || 200) > 45);
    if (!all.length) return false;
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    // start somewhere it knows sounds good: a liked / often-played song from the crate
    if (!keepCurrent) {
      const fav = all.findIndex((t) => library.likes.has(t.id) || (library.stats[t.id]?.p || 0) >= 3);
      if (fav > 0 && fav < 80) all.unshift(...all.splice(fav, 1));
    }
    const cur = keepCurrent && this.track;
    if (cur) all = [cur, ...all.filter((t) => t.id !== cur.id)];
    // Cook It Up only applies to this queue: your normal DJ settings aren't touched
    if (settings.get('transition') !== 'smart') { this._cookPrevTransition = settings.get('transition'); settings.set('transition', 'smart'); }
    this.cookSalt = Math.random().toString(36).slice(2);
    this.cookHist = []; this._cookPicked = new Set(); this._userNext = new Set(); this._cookN = 0;
    (async () => { for (const t of all.slice(1, 60)) { if (!this.cookMode) break; if (!library.bpmOf(t)) await onlineBpm(t).catch(() => 0); } })();
    if (cur && this.playing) {
      // keep the song that's playing; the set continues from it
      this.queue = all.slice(0, 400).map((t) => t.id); this.index = 0; this.origQueue = null;
      this.context = { type: 'cook', name }; this.invalidateNext(); this.emit('queue'); this.saveNow();
    } else this.playTracks(all.slice(0, 400), 0, { context: { type: 'cook', name } });
    return true;
  }
  get cookMode() { return this.context?.type === 'cook'; }
  playTracks(tracks, start = 0, { context = null, shuffle = null } = {}) {
    // leaving a Cook It Up session: put the transition setting back if Cook It Up had to change it
    if (this.cookMode && context?.type !== 'cook' && this._cookPrevTransition) { settings.set('transition', this._cookPrevTransition); this._cookPrevTransition = null; }
    if (!tracks.length) return;
    this.queue = tracks.map((t) => t.id);
    this.context = context;
    this.origQueue = null;
    this.autoplayFrom = -1;
    const wantShuffle = shuffle ?? false;
    this.shuffle = false;
    let idx = start;
    if (wantShuffle) {
      this.shuffle = true;
      this.origQueue = this.queue.slice();
      const first = start >= 0 && shuffle !== true ? this.queue[start] : null;
      const rest = this.queue.filter((id, i) => !(first && i === start));
      const ordered = this.orderShuffle(rest.map((id) => library.track(id)), first ? library.track(first) : null).map((t) => t.id);
      this.queue = first ? [first, ...ordered] : ordered;
      idx = 0;
    }
    this.playIndex(idx, { mode: this.playing && settings.get('skipFade') ? 'quick' : 'cut' });
    this.emit('queue');
  }
  orderShuffle(tracks, first) {
    if (settings.get('shuffleMode') === 'flow') return library.flowOrder(shuffleArr(tracks), first);
    return shuffleArr(tracks);
  }
  toggleShuffle() {
    const cur = this.queue[this.index];
    if (!this.shuffle) {
      this.origQueue = this.queue.slice();
      const rest = this.queue.filter((id, i) => i !== this.index).map((id) => library.track(id)).filter(Boolean);
      this.queue = [cur, ...this.orderShuffle(rest, library.track(cur)).map((t) => t.id)].filter(Boolean);
      this.index = cur ? 0 : -1;
      this.shuffle = true;
    } else {
      const orig = this.origQueue || this.queue;
      const extra = this.queue.filter((id) => !orig.includes(id));
      this.queue = [...orig, ...extra];
      this.index = Math.max(0, this.queue.indexOf(cur));
      this.shuffle = false;
      this.origQueue = null;
    }
    this.invalidateNext();
    this.emit('queue'); this.emit('state'); this.saveState();
  }
  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.invalidateNext();
    this.emit('state'); this.saveState();
  }
  playNext(tracks) {
    const ids = tracks.map((t) => t.id);
    if (this.index < 0) return this.playTracks(tracks, 0);
    this.queue.splice(this.index + 1, 0, ...ids);
    if (this.origQueue) this.origQueue.push(...ids);
    (this._userNext ||= new Set()); ids.forEach((id) => this._userNext.add(id)); // Cook It Up won't reorder your picks
    this.invalidateNext();
    this.emit('queue'); this.saveState();
  }
  addToQueue(tracks) {
    const ids = tracks.map((t) => t.id);
    if (this.index < 0) return this.playTracks(tracks, 0);
    this.queue.push(...ids);
    if (this.origQueue) this.origQueue.push(...ids);
    this.invalidateNext();
    this.emit('queue'); this.saveState();
  }
  removeAt(i) {
    if (i === this.index || i < 0 || i >= this.queue.length) return;
    const [id] = this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    if (this.origQueue) { const k = this.origQueue.indexOf(id); if (k >= 0) this.origQueue.splice(k, 1); }
    this.invalidateNext();
    this.emit('queue'); this.saveState();
  }
  move(from, to) {
    if (from === to) return;
    const [id] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, id);
    if (from === this.index) this.index = to;
    else {
      if (from < this.index && to >= this.index) this.index--;
      else if (from > this.index && to <= this.index) this.index++;
    }
    this.invalidateNext();
    this.emit('queue'); this.saveState();
  }
  setUpNext(tracks) {
    const ids = tracks.map((t) => t.id);
    this.queue = [...this.queue.slice(0, this.index + 1), ...ids];
    this.origQueue = null;
    this.shuffle = false;
    this.autoplayFrom = -1;
    this.invalidateNext();
    this.emit('queue'); this.emit('state'); this.saveState();
  }
  clearUpNext() {
    this.queue = this.queue.slice(0, this.index + 1);
    this.origQueue = null;
    this.invalidateNext();
    this.emit('queue'); this.saveState();
  }
  upNext() { return this.queue.slice(this.index + 1).map((id) => library.track(id)).filter(Boolean); }

  nextIndex(auto) {
    if (auto && this.repeat === 'one') return this.index;
    if (this.index + 1 < this.queue.length) return this.index + 1;
    if (this.repeat === 'all' && this.queue.length) return 0;
    if (auto && settings.get('autoplay') && library.size > 1) {
      const seed = this.track;
      const recent = new Set(this.queue.slice(-200));
      const more = library.radioFrom(seed, recent, 25);
      if (more.length) {
        if (this.autoplayFrom < 0) this.autoplayFrom = this.queue.length;
        this.queue.push(...more.map((t) => t.id));
        this.emit('queue');
        return this.index + 1;
      }
    }
    return -1;
  }

  // ---------- transport ----------
  // iOS: an <audio> element can only start by itself later if it was started inside a tap once
  unlockDecks() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* */ }
    const waits = [];
    for (const d of this.decks) {
      for (const el of Object.values(d.els)) {
        if (el._unlocked) continue;
        el._unlocked = true;
        if (el === d.el && d.track) continue; // the playing element unlocks itself
        if (el.getAttribute('src') && el.getAttribute('src') !== SILENT) continue;
        try {
          el.src = SILENT;
          el.muted = true; // a muted element can't take over the lock screen / CarPlay
          const p = el.play();
          if (p) waits.push(p.then(() => { if (el.getAttribute('src') === SILENT) { el.pause(); el.removeAttribute('src'); el.load(); } el.muted = false; })
            .catch((e) => { el.muted = false; if (e.name === 'NotAllowedError') el._unlocked = false; }));
        } catch (e) { el.muted = false; el._unlocked = false; }
      }
    }
    // iOS hands "Now Playing" (lock screen / Dynamic Island) to whichever element started last — if a
    // silent unlock finished after the song started, take it back so it doesn't show a frozen "paused" song
    if (waits.length) Promise.allSettled(waits).then(() => this.reclaimNowPlaying());
  }
  reclaimNowPlaying() {
    if (!this.track) return;
    const d = this.cur;
    if (this.playing && !d.el.paused) {
      this.updateMediaSession();
      this.updatePosition();
      setTimeout(() => { if (this.playing) { this.updateMediaSession(); this.updatePosition(); } }, 500);
    }
  }
  async play() {
    this.unlockDecks();
    this.ensureGraph();
    await this.resume();
    if (!this.cur.track) {
      if (this.index >= 0) return this.playIndex(this.index, { mode: 'cut' });
      return;
    }
    this.playing = true;
    const d = this.cur;
    // coming back after a long break: pick up a few seconds earlier so you don't lose your place
    if (settings.get('smartResume') && this._pausedAt && Date.now() - this._pausedAt > 10 * 60000 && !this.transition && d.el.currentTime > 8) {
      try { d.el.currentTime = d.el.currentTime - 3; } catch (e) { /* */ }
    }
    this._pausedAt = 0;
    if (settings.get('pauseFade') && this.ctx) { this.setFade(d, 0); this.fade(d, 1, 0.25, { shape: 'equalpower' }); }
    else this.setFade(d, 1);
    try { await d.el.play(); } catch (e) { if (e.name === 'NotAllowedError') { this.playing = false; this.emit('state'); } /* load failures are handled by recover() */ }
    if (this.transition) { try { await this.transition.from.el.play(); } catch (e) { /* */ } }
    this.emit('state');
    this.updatePosition();
  }
  async pause() {
    this.playing = false;
    this._pausedAt = Date.now();
    // a silently-finishing old song (iPhone) stops with you
    for (const d of this.decks) for (const e of Object.values(d.els)) if (e._silentTail) { e._silentTail = false; try { e.pause(); } catch (er) { /* */ } }
    this.emit('state');
    const ds = [this.cur, this.transition?.from].filter(Boolean);
    clearTimeout(this.planTimer); this.planTimer = null;
    this.stopPreroll();
    this._pausing = true;
    if (settings.get('pauseFade') && this.ctx && !this.cur.el.paused) {
      this.fade(this.cur, 0, 0.18, { shape: 'linear' });
      await new Promise((r) => setTimeout(r, 190));
    }
    if (!this.playing) ds.forEach((d) => d.el.pause());
    this._pausing = false;
    this.updatePosition();
    this.saveState();
  }
  toggle() { return this.playing ? this.pause() : this.play(); }
  next() {
    if (this.track && this.currentTime < 30 && !this.transition) library.noteSkip(this.track.id);
    const i = this.index + 1 < this.queue.length ? this.index + 1 : this.nextIndex(false);
    if (i < 0) {
      // end of the queue: stop at the start of the last track
      this.pause(); this.seek(0); return;
    }
    // Cook It Up: skipping lands where the DJ was going to bring the next song in (its drop, its chorus,
    // or just past the silence at its start), like a DJ cutting to it
    let startAt = 0;
    if (this.cookMode) {
      const id = this.queue[i], p = this.plan;
      if (p && p.bId === id && (p.bStart || 0) > 0.5) startAt = p.bStart;
      else startAt = Math.max(0, (library.analysis.get(id)?.leadIn || 0) - 0.05);
    }
    this.playIndex(i, { mode: this.playing && settings.get('skipFade') ? 'quick' : 'cut', startAt });
  }
  prev() {
    if (this.currentTime > settings.get('prevRestarts') || this.index <= 0) { this.seek(0); return; }
    this.playIndex(this.index - 1, { mode: this.playing && settings.get('skipFade') ? 'quick' : 'cut' });
  }
  seek(t) {
    this.finishTransition();
    const d = this.cur;
    if (!d.track) return;
    const to = clamp(t, 0, Math.max(0, this.duration - 0.25));
    this._seekTo = to; this._seekAt = performance.now(); this._seekDeck = d; this._seekRetried = false;
    // jumped past where the DJ mix was going to start: don't mix away right away — let you hear the
    // part you picked, then a short crossfade into the next song at the very end
    this.stopPreroll();
    let p = this.plan;
    // a Cook It Up build-up in progress: stop it cleanly, you're going somewhere else in the song
    if (this.cooking && p) { p._aborted = true; this.cookAbort(d); }
    // Cook It Up and you jumped past (or into) its mix point: pick a new one further on instead of
    // giving up on the transition
    if (p && p.style === 'cook' && this.upcoming && (to > p.mixStart - 0.3 || p._aborted)) {
      const A = d.track, B = this.upcoming.track;
      const np = this.cookPlan({ A, B, aA: library.analysis.get(A.id), aB: library.analysis.get(B.id), bpmA: library.analysis.get(A.id)?.bpm || 0, dur: this.duration, end: this.duration, base: { aId: A.id, bId: B.id, rate: 1, bStart: 0, outDelay: 0, shape: p.shape, style: 'cook' }, durB: B.duration, after: to + 3 });
      if (np && !np.cookBlend) { clearTimeout(this.planTimer); this.planTimer = null; this.plan = p = np; this.emit('plan', np); }
    }
    this.lateSeek = !!(p && !this.transition && p.style !== 'gapless' && to > (p.mixStart ?? Infinity) - 0.3);
    this._lateGo = false;
    if (p && !this.lateSeek) p.aRamped = false;
    if (Math.abs(d.el.playbackRate - 1) > 0.001 && !this.transition) { clearInterval(d.rateTimer); d.el.playbackRate = 1; }
    const jump = () => {
      try {
        d.el.currentTime = to;
      } catch (e) { /* not seekable yet: retry once it is */
        d.el.addEventListener('loadedmetadata', () => { try { d.el.currentTime = to; } catch (er) { /* */ } }, { once: true });
      }
    };
    if (d.fx && this.ctx && this.playing && !d.el.paused && !this.transition) {
      // fade out in 30 ms, jump, fade back in once the new spot is actually playing
      const tok = d.token, my = (this._seekN = (this._seekN || 0) + 1);
      this.fade(d, 0, 0.03, { shape: 'linear' });
      clearTimeout(this._seekFadeT);
      const back = () => { if (d.token === tok && my === this._seekN && d === this.cur) this.fade(d, 1, 0.12, { shape: 'equalpower' }); };
      setTimeout(() => {
        if (d.token !== tok || my !== this._seekN) return;
        jump();
        if (!d.el.seeking) setTimeout(back, 40);
        else d.el.addEventListener('seeked', () => setTimeout(back, 40), { once: true });
        this._seekFadeT = setTimeout(back, 1500); // never stay silent
      }, 34);
    } else jump();
    clearTimeout(this.planTimer); this.planTimer = null;
    if (this.playing && d.el.paused) d.el.play().catch(() => {});
    this.emit('time');
    this.updatePosition();
    this.saveState();
  }
  // a seek that hangs (stream stalled on a slow connection): reopen the song right at that spot
  checkSeek(d) {
    if (this._seekTo == null || this._seekDeck !== d) return;
    const age = performance.now() - this._seekAt;
    const el = d.el;
    // landed (or the browser reports a position near the target): done
    if (!el.seeking || Math.abs(el.currentTime - this._seekTo) < 1 || age > 15000) {
      if (age > 250) this._seekTo = null;
      return;
    }
    // only a song that should be playing, is stuck seeking, and has nothing to play gets reopened at that spot
    if (!this._seekRetried && this.playing && age > 6000 && el.readyState < 2) {
      this._seekRetried = true;
      const to = this._seekTo, t = d.track;
      const att = d.attempt || 0;
      d.load(t, to, att > 0 ? (el.currentSrc || '').split('#')[0] || null : null);
      d.attempt = att;
      this._seekTo = to; this._seekAt = performance.now(); this._seekDeck = d;
      d.el.play().catch(() => {});
    }
  }
  jumpTo(i) { this.playIndex(i, { mode: this.playing && settings.get('skipFade') ? 'quick' : 'cut' }); }

  notePlayed(d) {
    if (!d?.track) return;
    const t = d.el.currentTime, dur = this.durationOf(d);
    if (t >= Math.min(30, dur * 0.5)) library.recordPlay(d.track.id);
  }

  async playIndex(i, { mode = 'cut', startAt = 0, autoplay = true } = {}) {
    if (i < 0 || i >= this.queue.length) return;
    if (autoplay) this.unlockDecks();
    const t = library.track(this.queue[i]);
    if (!t) { this.queue.splice(i, 1); return this.playIndex(Math.min(i, this.queue.length - 1), { mode, autoplay }); }
    this.ensureGraph();
    if (autoplay) await this.resume();
    this.finishTransition();
    this.cancelNext();
    const old = this.cur;
    this.notePlayed(old);
    this.index = i;
    this._seekTo = null; this._pm = null; // a new song: forget the old one's seek / clock
    // iPhone: Now Playing (lock screen / Dynamic Island / CarPlay) follows the audio element, so a skip
    // keeps the same element — quick fade out, switch songs, fade in — and iOS never sees a "pause".
    let fadeIn = false;
    if (mode === 'quick' && IOS && old.track && !old.el.paused && old.fx) {
      // a 25 ms dip is enough to avoid a click — you don't hear a gap
      const tok = ++this.skipToken;
      this.fade(old, 0, 0.025, { shape: 'linear' });
      await new Promise((r) => setTimeout(r, 28));
      if (tok !== this.skipToken) return;
      mode = 'cut'; fadeIn = true;
    }
    if (mode === 'quick' && old.track && !old.el.paused) {
      const dur = settings.get('skipFadeSec');
      this.ai = 1 - this.ai;
      const d = this.cur;
      this.loadDeck(d, t, startAt);
      this.applyDeckGain(d);
      this.setFade(d, 0);
      this.playing = true;
      d.el.play().catch(() => { /* load failures are handled by recover() */ });
      this.fade(d, 1, dur * 0.8);
      this.fade(old, 0, dur);
      const tok = old.token;
      setTimeout(() => { if (old.token === tok && old !== this.cur) { if (IOS) { this.setFade(old, 0); old.softUnload(); } else old.unload(); this.reassertNowPlaying(); } }, dur * 1000 + 80);
    } else {
      // (iPhone: the other player is just stopped, not emptied — see softUnload)
      if (IOS) { const o = this.other; o.token++; o.track = null; clearInterval(o.fadeTimer); clearInterval(o.rateTimer); for (const e of Object.values(o.els)) { e._silentTail = false; try { e.pause(); } catch (er) { /* */ } } } else this.other.unload();
      this.loadDeck(old, t, startAt);
      this.applyDeckGain(old);
      this.setFade(old, fadeIn ? 0 : 1);
      if (fadeIn) {
        const tokL = old.token;
        old.el.addEventListener('playing', () => { if (old.token === tokL) this.fade(old, 1, 0.06, { shape: 'equalpower' }); }, { once: true });
      }
      if (autoplay) {
        this.playing = true;
        old.el.play().catch((e) => {
          if (e.name === 'NotAllowedError') { this.playing = false; this.emit('state'); }
        });
      } else this.playing = false;
    }
    if (startAt > 0.5) { this._seekTo = startAt; this._seekAt = performance.now(); this._seekDeck = this.cur; }
    this.afterTrackChange();
  }

  afterTrackChange(transitionPlan = null) {
    const t = this.track;
    this.lateSeek = false; this._lateGo = false;
    this.emit('track', t, transitionPlan);
    this.emit('state');
    this.emit('queue');
    this.updateMediaSession();
    this.saveState();
    if (this.sleepEndOfTrack && transitionPlan) { /* handled in prepare */ }
    // analyse the current track (for its outro + loudness) — but only once it's playing smoothly, so the
    // download never competes with the song you just picked; a skipped song's download is cancelled
    this.scheduleAnalysis(t);
  }
  // Download the song that's up next onto the phone ahead of time, so pressing ⏭ starts it instantly
  warmNext(t) {
    clearTimeout(this._warmTimer);
    this._warmTimer = setTimeout(() => {
      if (this.track !== t || !this.playing) return;
      const i = this.nextIndex(true);
      const n = i >= 0 ? library.track(this.queue[i]) : null;
      if (n) (n !== this.upcoming?.track ? prefetchTrack(n) : Promise.resolve()).then(() => { if (isAnalyzed(n)) verifyBpm(n); });
      if (isAnalyzed(t)) verifyBpm(t, { reanalyze: false }); // the playing song is only re-measured later (when it comes up next / library analysis)
    }, 4000);
  }
  scheduleAnalysis(t) {
    clearTimeout(this._anTimer);
    if (this._anCtl && this._anFor !== t?.id && this._anFor !== this.upcoming?.track?.id) { this._anCtl.abort(); this._anCtl = null; }
    if (t && (!this.wantsAnalysis() || isAnalyzed(t))) { this.warmNext(t); return; }
    if (!t) return;
    const go = () => {
      if (this.track !== t) return;
      const el = this.cur.el;
      if (this.playing && (el.paused || el.readyState < 3)) { this._anTimer = setTimeout(go, 1500); return; }
      this._anCtl = new AbortController(); this._anFor = t.id;
      analyze(t, { signal: this._anCtl.signal }).then(() => this.warmNext(t));
    };
    this._anTimer = setTimeout(go, 2500);
  }
  wantsAnalysis() {
    const s = settings.v;
    return s.bpmDetect === 'auto' || (s.transition === 'smart') || (s.skipSilence && s.transition !== 'off') || (s.autoLevel && s.leveling !== 'off');
  }

  onEnded() {
    const d = this.cur;
    this.notePlayed(d);
    if (this.sleepEndOfTrack) { this.sleepEndOfTrack = false; this.playing = false; this.emit('state'); this.emit('sleep'); return; }
    const i = this.upcoming?.index ?? this.nextIndex(true);
    if (i < 0) { this.playing = false; this.emit('state'); this.emit('ended'); return; }
    this.playIndex(i, { mode: 'cut' });
  }

  // ---------- transitions ----------
  // a silent pre-roll that's no longer valid (pause, seek, queue change): stop it so it can redo itself
  stopPreroll() {
    clearInterval(this.prerollTimer);
    const p = this.plan;
    if (p?.prerolled && !this.transition) {
      p.prerolled = false;
      try { this.other.el.pause(); } catch (e) { /* */ }
    }
  }
  cancelNext() {
    clearTimeout(this.planTimer); this.planTimer = null;
    if (this.cooking && this.plan) { this.plan._aborted = true; this.cookAbort(this.cur); }
    this.stopPreroll();
    if (!this.transition && this.cur.track && Math.abs(this.cur.el.playbackRate - 1) > 0.001) this.rampRate(this.cur, 1, 1.5);
    this.plan = null;
    if (this.upcoming && !this.transition) this.other.unload();
    this.upcoming = null;
    this.emit('plan', null);
  }
  invalidateNext() { if (!this.transition) this.cancelNext(); }

  // DJ Cook It Up picks what comes next like a DJ digging through a crate: from the next couple of dozen
  // random songs, the one that mixes best with what's playing (tempo it can match, a key that fits, not
  // the same artist again), with a bit of chance so it never plays out the same way twice
  cookPickNext() {
    const i = this.index + 1;
    if (i >= this.queue.length || this.repeat === 'one' || this._userNext?.has(this.queue[i])) return;
    const cur = this.cur.track;
    if (!cur) return;
    const tempo = (t) => library.bpmOf(t) || onlineBpmCached(t) || 0;
    const genres = (t) => new Set(String(t.genre || '').toLowerCase().split(/[\/,;&|]+/).map((g) => g.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean));
    const energy = (t) => { const L = library.analysis.get(t.id)?.loud; if (!L?.length) return null; let s2 = 0; for (const v of L) s2 += v; return s2 / L.length; };
    const bA = tempo(cur), kA = library.analysis.get(cur.id)?.camelot, gA = genres(cur), eA = energy(cur), yA = +cur.year || 0;
    // a set breathes: energy rises and falls in a slow wave, a few points per song — never a hard drop
    // or a ballad straight into a banger
    this._cookN = (this._cookN || 0) + 1;
    const target = eA == null ? null : eA + 4 * Math.cos(this._cookN / 3);
    const recent = this.queue.slice(Math.max(0, this.index - 5), this.index + 1).map((id) => library.track(id)).filter(Boolean);
    const recentArtists = new Set(recent.map((t) => t.artist)), recentAlbums = new Set(recent.map((t) => t.albumId));
    let best = -1, bestS = -Infinity;
    const lookup = [];
    for (let j = i; j < Math.min(this.queue.length, i + 40); j++) {
      const t = library.track(this.queue[j]);
      if (!t || this._userNext?.has(t.id)) continue;
      let sc = Math.random() * 0.8;
      // tempo the DJ can match without anyone noticing
      const bB = tempo(t);
      if (bA && bB) {
        let r = bB / bA; if (r > 1.4) r /= 2; else if (r < 0.7) r *= 2;
        const d = Math.abs(r - 1);
        sc += d <= 0.015 ? 4.5 : d <= 0.03 ? 3.5 : d <= 0.05 ? 1.5 : d <= 0.08 ? 0.2 : -1.5;
      } else if (!bB && lookup.length < 10) lookup.push(t);
      // keys that sit together
      const kB = library.analysis.get(t.id)?.camelot;
      if (kA && kB) { const kc = keyCompat(kA, kB); sc += kc >= 0.85 ? 2.4 : kc >= 0.6 ? 0.6 : -2.5; }
      else if (kA) sc -= 0.4; // a song whose key we know beats a gamble
      // same vibe: genre, era
      const gB = genres(t);
      if (gA.size && gB.size) sc += [...gB].some((g) => gA.has(g)) ? 2.5 : -2;
      const yB = +t.year || 0;
      if (yA && yB) sc += Math.abs(yA - yB) <= 3 ? 0.5 : Math.abs(yA - yB) > 15 ? -0.5 : 0;
      // energy flow
      const eB = energy(t);
      if (target != null && eB != null) { sc -= Math.abs(eB - target) / 6; if (Math.abs(eB - eA) > 18) sc -= 3; }
      else if (eA != null) sc -= 0.8; // unknown energy is a gamble
      // variety: not the same artist or album again so soon
      if (t.artist === cur.artist) sc -= 3; else if (recentArtists.has(t.artist)) sc -= 1.5;
      if (recentAlbums.has(t.albumId)) sc -= 1;
      // songs it knows you like: liked, played a lot, not skipped
      const st = library.stats[t.id];
      if (library.likes.has(t.id)) sc += 1.4;
      if (st?.p) sc += Math.min(1.2, Math.log2(1 + st.p) * 0.35);
      if (st?.k) sc -= Math.min(2.5, st.k * (st.p ? 0.4 : 0.8));
      // a song we know everything about (tempo, key, energy, where it sings) mixes best
      if (library.analysis.get(t.id)?.bpm) sc += 1;
      if (sc > bestS) { bestS = sc; best = j; }
    }
    // tempos for songs nobody has measured yet are looked up online, so the next picks are better
    for (const t of lookup) onlineBpm(t).catch(() => {});
    if (best > i) { const [id] = this.queue.splice(best, 1); this.queue.splice(i, 0, id); this.emit('queue'); }
  }
  prepareNext() {
    if (this.upcoming || this.transition || this.sleepEndOfTrack) return;
    if (this.cookMode && !this._cookPicked?.has(this.index)) { (this._cookPicked ||= new Set()).add(this.index); try { this.cookPickNext(); } catch (e) { /* keep the order */ } }
    const i = this.nextIndex(true);
    if (i < 0) return;
    const t = library.track(this.queue[i]);
    if (!t || t.id === this.failedNext) return;
    this.upcoming = { index: i, track: t };
    this.computePlan();
    const d = this.other;
    this.loadDeck(d, t, this.plan?.bStart || 0);
    this.applyDeckGain(d);
    this.setFade(d, 0);
    if (IOS && this.playing) this.reassertNowPlaying();
    if (this.wantsAnalysis()) {
      // songs measured by an older version have no loudness map yet: refresh them so the drop can be found
      const a = library.analysis.get(t.id);
      const refresh = a && !a.loud && settings.get('transition') === 'smart' && settings.get('dropAlign') !== false;
      analyze(t, refresh ? { force: true } : undefined).then(() => { if (this.upcoming?.track === t && !this.transition) this.computePlan(); });
    } else prefetchTrack(t);
    const st = settings.v;
    // lyrics tell the DJ where the singing is: word play needs them, and beat-match blends use them so
    // two vocals never sing over each other
    if (st.transition === 'smart' && settings.get('vocalAware') !== false) {
      Promise.all([getLyrics(this.cur.track), getLyrics(t)]).then(() => { if (this.upcoming?.track === t && !this.transition) this.computePlan(); });
    }
  }

  computePlan() {
    if (!this.upcoming || this.transition || this.cooking) return;
    const A = this.cur.track, B = this.upcoming.track;
    if (!A || !B) return;
    let p = this.makePlan(A, B, this.durationOf(this.cur));
    // Cook It Up never slides one song under another or drops it in: when the songs can't be beat-matched
    // it does a long, slow filter blend instead
    if (this.cookMode && p && p.fx && (p.style === 'under' || p.style === 'echo') && !p.cue) {
      const ov = Math.max(p.overlap || 0, 12), ms = Math.max(1, (p.mixStart || 0) + (p.overlap || 0) - ov);
      p = { ...p, style: 'filter', type: 'smart', label: 'Cook It Up · Slow filter blend', mixStart: ms, overlap: ov, inDur: ov * 0.6, outDur: ov * 0.7, outDelay: ov * 0.3 };
    }
    const old = this.plan;
    this.plan = p;
    // re-seek the preloaded deck if the start point moved
    if (old && Math.abs((old.bStart || 0) - p.bStart) > 0.05 && this.other.track === B) {
      try { this.other.el.currentTime = p.bStart; } catch (e) { /* */ }
    }
    this.emit('plan', p);
  }

  isContinuation(A, B) {
    if (!A || !B || A.albumId !== B.albumId) return false;
    const da = A.disc || 1, dbb = B.disc || 1;
    return (dbb === da && B.track === A.track + 1) || (dbb === da + 1 && B.track === 1);
  }

  // ---- transition planner ----
  // Styles:
  //  gapless   consecutive album tracks / Gapless mode
  //  crossfade classic equal-power crossfade (Crossfade mode)
  //  blend     DJ mix: beat-matched, phrase-aligned, tempo-synced, with a bass swap and high-pass on the outgoing track
  //  under     outgoing song fades out on its own → bring the next one in underneath, bass held back
  //  echo      outgoing song ends hard → echo/delay tail rings out as the next song drops in
  //  filter    tempos don't match → low-pass the outgoing song away while the next one opens up from a high-pass
  // iPhone can't change an <audio> element's volume, so fades need the Web Audio engine
  canFade(t) {
    if (!IOS) return true;
    return settings.get('engine') === 'enhanced' && !!this.ctx && !(t?.plex && this.plexNoCors);
  }
  makePlan(A, B, durA) {
    const s = settings.v;
    const aA = library.analysis.get(A.id), aB = library.analysis.get(B.id);
    const cont = this.isContinuation(A, B);
    const dur = durA || A.duration || 0;
    const fx = s.djEffects !== false;
    const base = { aId: A.id, bId: B.id, rate: 1, bStart: 0, outDelay: 0, shape: s.fadeCurve, style: 'crossfade' };
    const gapless = (label = 'Gapless') => ({ ...base, style: 'gapless', type: 'gapless', label, mixStart: Math.max(0, dur - 0.05), overlap: 0.05, inDur: 0.012, outDur: 0.04, shape: 'linear' });

    if (s.transition === 'off') {
      if (s.skipSilence && !cont && aA && aB && (dur - aA.tailOut > 0.4 || aB.leadIn > 0.4)) {
        return { ...gapless('Silence skipped'), type: 'trim', mixStart: Math.max(0, aA.tailOut - 0.03), bStart: aB.leadIn };
      }
      return gapless();
    }
    if (cont && s.gaplessAlbums && !this.cookMode) { // (a DJ set mixes everything, even album neighbours)
      // only stay gapless when the songs really run into each other (live albums, DJ mixes, segues)
      const runsIn = !aA || !aB || (dur - (aA.tailOut || dur) < 0.6 && (aB.leadIn || 0) < 0.6 && (aA.tailOut - aA.fadeOutStart) < 2);
      if (runsIn || s.transition !== 'smart') return gapless('Gapless · same album');
    }
    if (!this.canFade(A) || !this.canFade(B)) return gapless('Gapless (fades need Enhanced audio on iPhone)');

    let end = dur, bStart = 0;
    if (s.skipSilence) {
      if (aA?.tailOut) end = Math.min(dur, aA.tailOut);
      if (aB) bStart = aB.leadIn || 0;
    }
    const D = clamp(s.crossfadeSec, 1, 20);
    if (s.transition === 'crossfade') {
      const d = Math.min(D, Math.max(0.5, end * 0.3));
      return { ...base, type: 'crossfade', style: 'crossfade', label: `Crossfade · ${Math.round(d)}s`, mixStart: Math.max(0, end - d), overlap: d, inDur: d, outDur: d, bStart };
    }

    // ---- DJ mix ----
    const durB = B.duration || 240;
    const outroLen = aA ? Math.max(0, end - (aA.fadeOutStart || end)) : 0;
    const bpmA = aA?.bpm && aA.bpmConf > 0.1 ? aA.bpm : 0;
    let bpmB = aB?.bpm && aB.bpmConf > 0.1 ? aB.bpm : 0;
    if (bpmA && bpmB) { if (bpmB / bpmA > 1.4) bpmB /= 2; else if (bpmA / bpmB > 1.4) bpmB *= 2; }
    const ratio = bpmA && bpmB ? bpmA / bpmB : 0;
    const tol = Math.max(0.02, s.tempoMatch ? s.tempoMatchMax / 100 : 0.02);

    const djStyle = s.djStyle || 'auto';
    // DJ Cook It Up: wild, different-every-time transitions at random points in the song
    let cookBlend = null;
    const cookArgs = { A, B, aA, aB, bpmA, dur, end, base, durB };
    if (this.cookMode && fx && this.ctx && A.fx !== false) {
      const c = this.cookPlan(cookArgs);
      if (c?.cookBlend) cookBlend = c; else if (c) return c;
    }
    // 0) word play: the outgoing song sings the next song's title → echo that line out and drop the next song on its own title
    if (djStyle !== 'beats') {
      // 0a) shared words: A sings them near its end, B sings them early → hand the vocal over
      const ho = findHandoff(A, B);
      if (ho && ho.cut < end - 1 && (djStyle === 'wordplay' || ho.score >= 10)) {
        const beatA = bpmA ? 60 / bpmA : 0.5;
        const pre = clamp(beatA, 0.35, 0.75);
        // the acapella is A's whole line (it ends on the shared words); B comes in at the start of its
        // line (which begins with those words): both cut points are line boundaries, the most precise timing
        let cut = ho.cut;
        if (bpmA && aA?.beatOffset !== undefined) {           // land the drop on A's beat grid if it's close
          const k = Math.round((cut - aA.beatOffset) / beatA), snap = aA.beatOffset + k * beatA;
          if (Math.abs(snap - cut) < 0.18) cut = snap;
        }
        const iso = clamp(cut - ho.aLine.t, 0.9, 6.5);
        const mixStart = cut - iso - pre;
        const bDrop = Math.max(0, ho.bLine.t - 0.06);
        const under = pre + iso;
        const canUnder = bDrop >= under + 0.15;
        if (mixStart > 3) {
          const cue = { t: ho.aLine.t, text: ho.aLine.text, phrase: ho.phrase, bText: ho.bLine.text };
          if (this.voxReady && fx && this.cur.fx) {
            return {
              ...base, type: 'wordplay', style: 'acapella', handoff: true, fx, cue,
              label: `Word play · “${ho.phrase}” → same words`,
              mixStart, pre, iso, phraseEnd: cut, overlap: pre + iso + 0.6,
              inDur: 0.1, outDur: 0.06, outDelay: pre + iso,
              bStart: canUnder ? bDrop - under : bDrop, bDrop, under: canUnder ? under : 0,
              echoTime: clamp(beatA * 0.75, 0.2, 0.75),
            };
          }
          return {
            ...base, type: 'wordplay', style: 'echo', fx, cue, label: `Word play · “${ho.phrase}”`,
            mixStart: cut - 1.2, overlap: 1.6, inDur: 0.12, outDur: 0.06, outDelay: 1.2, lead: 1.2,
            bStart: bDrop, echoTime: clamp(beatA * 0.75, 0.2, 0.75),
          };
        }
      }
      const cue = findCue(A, B);
      if (cue && cue.end < end - 0.5 && (djStyle === 'wordplay' || cue.score >= 6)) {
        const lead = clamp(cue.end - cue.t, 1.2, 6);
        const entry = titleEntry(B);
        const beatA = bpmA ? 60 / bpmA : 0.5;
        // the real thing: isolate the vocal on the cue line, build the next song's instrumental
        // underneath, then drop the next song in full on its own title line
        if (this.voxReady && fx && this.cur.fx && cue.t > 3) {
          const pre = clamp(beatA, 0.35, 0.75);
          // title at the end of its line → cut on the line boundary (precise); otherwise the in-line estimate
          const phraseEnd = Math.min(cue.ratio > 0.6 ? cue.lineEnd : (cue.phraseEnd ?? cue.end), end - 0.3);
          const iso = Math.max(0.6, phraseEnd - cue.t);
          const bDrop = entry != null ? Math.max(0, entry - 0.04) : bStart;
          const under = pre + iso;
          const canUnder = entry != null && bDrop >= under + 0.15;
          return {
            ...base, type: 'wordplay', style: 'acapella', fx, cue,
            label: `Word play · “${cue.phrase}” · acapella`,
            mixStart: cue.t - pre, pre, iso, phraseEnd, overlap: pre + iso + 0.6,
            inDur: 0.1, outDur: 0.06, outDelay: pre + iso,
            bStart: canUnder ? bDrop - under : bDrop, bDrop, under: canUnder ? under : 0,
            echoTime: clamp(beatA * 0.75, 0.2, 0.75),
          };
        }
        return {
          ...base, type: 'wordplay', style: 'echo', fx, cue,
          label: `Word play · “${cue.phrase}”`,
          mixStart: cue.t, overlap: lead + 0.4, inDur: 0.3, outDur: 0.06, outDelay: lead, lead,
          bStart: entry != null ? Math.max(0, entry - 0.1) : bStart,
          echoTime: clamp(beatA * 0.75, 0.2, 0.75),
        };
      }
    }
    // 1) beat-matched blend (harmonic-aware: long blends when keys agree, short when they clash)
    const kc = s.harmonicMix !== false ? keyCompat(aA?.camelot, aB?.camelot) : 0.8;
    // tempo sync: the incoming song matches the outgoing one; for bigger gaps both meet in the middle
    // (Cook It Up blends allow a bigger tempo change: it's a DJ set, the songs are bent to fit)
    // (Cook It Up keeps tempo changes small: stretching a song further makes it warble, and bringing it
    // back to speed is a hiccup — its song picking finds tempos that are close anyway)
    const maxEach = cookBlend ? Math.min(0.03, (s.tempoMatch ? s.tempoMatchMax : 1.5) / 100) : (s.tempoMatch ? s.tempoMatchMax : 1.5) / 100;
    // iPhone: every speed change of a playing song can click, so only the incoming song changes speed (once, before it's heard)
    if (s.beatMatch && ratio && Math.abs(ratio - 1) <= (IOS ? maxEach + 0.005 : maxEach * 1.6 + 0.005) && end > 20) {
      let aRate = 1, bRate = s.tempoMatch ? ratio : 1;
      if (!IOS && s.tempoMatch && Math.abs(ratio - 1) > maxEach) { const T = Math.sqrt(bpmA * bpmB); aRate = T / bpmA; bRate = T / bpmB; }
      const beat = 60 / bpmA, bar = beat * 4; // A's beat grid in A's own track time
      // long overlays: 16 beats minimum, 24 normally, 32 when the keys agree
      // (Cook It Up: long, slow blends — a set should feel like one continuous song)
      let beats = cookBlend?.club ? (kc < 0.6 ? 16 : 24) : cookBlend ? (kc < 0.6 ? 16 : 32) : clamp(Math.round(Math.max(D * 2, 16 * beat) / beat / 8) * 8, 16, kc >= 0.85 ? 32 : kc < 0.5 ? 16 : 24);
      while (beats > 8 && beats * beat > Math.min(dur * 0.4, durB * 0.45, 28)) beats -= 8;
      const overlapTrack = beats * beat;
      const overlap = overlapTrack / aRate; // real seconds
      // finish the blend as the outgoing song's outro begins (or at its end)
      const mixEnd = outroLen > 4 ? Math.min(end, aA.fadeOutStart + outroLen * 0.5) : end;
      const off = aA.beatOffset || 0;
      // The next song starts at its very first sound — snapped onto its own beat grid (never skipping
      // more than a fraction of a beat of near-silence), so its intro is never cut.
      const beatB = 60 / aB.bpm, offB = aB.beatOffset || 0, leadB = aB.leadIn || 0;
      // the grid point at or just before the first sound; if that's before the file starts, the song
      // starts at 0 and the mix point moves by the same fraction of a beat (beats stay locked)
      let bS = offB - Math.ceil(Math.max(0, offB - leadB) / beatB - 1e-6) * beatB, msShift = 0;
      if (bS < 0) { msShift = -bS * (60 / bpmA) / beatB; bS = 0; }
      const vOn = s.vocalAware !== false;
      const vA = vOn ? vocalSpans(cachedLyrics(A)) : null, vB = vOn ? vocalSpans(cachedLyrics(B)) : null;
      // The old song plays all the way to its end; the blend sits on its outro and finishes exactly as
      // it runs out (phrase-aligned) — never cut early.
      const drop = s.dropAlign !== false ? findDrop(aB, aB.bpm) : null;
      // loudness around a point (0..100), from the analysis loudness map (2 points per second)
      const loudAt = (an, t0, t1) => { const L = an?.loud; if (!L) return null; let sum = 0, c = 0; for (let i = Math.max(0, Math.floor(t0 * 2)); i < Math.min(L.length, Math.ceil(t1 * 2)); i++) { sum += L[i]; c++; } return c ? sum / c : null; };
      const tries = [];
      for (let bt = beats; bt >= 16; bt -= 8) {
        const ovT = bt * beat;
        const last = off + Math.floor((end - ovT - off - msShift) / bar) * bar + msShift;
        // where the next song comes in: from its first beat, or timed so its drop lands as the blend ends
        const starts = [{ bS, dropOn: false }];
        if (drop) { const st = drop - bt * beatB; if (st > bS + beatB && st <= 75) starts.push({ bS: Math.max(0, st), dropOn: true }); }
        // Cook It Up can also bring the next song in at one of its later phrases (its first chorus /
        // a big moment), so a high-energy exit meets a high-energy entrance, and a soft one a soft one
        if (cookBlend) for (let ph = 1; ph <= 6; ph++) { const st = bS + ph * 16 * beatB; if (st > durB * 0.4) break; starts.push({ bS: st, dropOn: false, phrase: ph }); }
        for (const st of starts) {
          for (let k = 0; k < (cookBlend?.club ? 24 : cookBlend ? 8 : 4); k++) {
            const ms = last - k * bar * 4; // whole phrases earlier (16 beats each)
            // (Club: like a club DJ, it'll leave a song as early as halfway if that's the best moment)
            if (ms <= 1 || ms < dur * (cookBlend?.club ? 0.45 : cookBlend ? 0.55 : 0.4)) break;
            const ov = ovT / aRate;
            const clash = vA && vB ? vocalClash(vA, vB, ms, aRate, st.bS, bRate, ov) : 0;
            // seamless = both songs at a similar energy where they overlap
            const eA = loudAt(aA, ms, ms + ovT), eB = loudAt(aB, st.bS, st.bS + ov * bRate);
            const eGap = eA != null && eB != null ? Math.abs(eA - eB) / 20 : 0;
            let cookS = 0;
            if (cookBlend) {
              // energy must flow: the incoming song at the energy the outgoing one is leaving with
              if (eA != null && eB != null) cookS += Math.abs(eA - eB) / 8;
              // leave as the outgoing song winds down or breaks (its next part is quieter), not mid-peak
              const after = loudAt(aA, ms + ovT, ms + ovT + 8);
              if (eA != null && after != null) cookS += after < eA - 6 ? -1.2 : after > eA + 6 ? 1.2 : 0;
              // never start the next song in the middle of a sung line
              if (vB && vB.some(([a, b]) => a < st.bS - 0.1 && b > st.bS + 0.2)) cookS += 3;
              // starting later in the next song costs a little (its intro is usually the smoothest way in)
              cookS += (st.phrase || 0) * 0.35;
            }
            tries.push({ bt, ms, ov, clash, bS: st.bS, dropOn: st.dropOn,
              score: clash * 6 + (cookBlend ? 0 : eGap) + cookS + (st.dropOn ? -2 : 0) + k * (cookBlend?.club ? 0.04 : cookBlend ? 0.3 : 0.7) + (beats - bt) * (cookBlend ? 0.25 : 0.06) });
          }
        }
      }
      tries.sort((x, y) => x.score - y.score);
      const pick = tries[0];
      if (pick) {
        const { ms, ov: overlapR, bt } = pick;
        const dropTxt = pick.dropOn ? ' · drop on the mix' : '';
        const T = bpmA * aRate;
        const tempoTxt = Math.abs(aRate - 1) > 0.002 ? `${Math.round(bpmA)}→${Math.round(T)}←${Math.round(aB.bpm)} BPM` : `${Math.round(bpmA)} BPM`;
        // still two voices at once? take the outgoing song's vocals out and blend just its music and beat
        const stripA = !!(vA && vB && pick.clash >= 1 && fx && this.voxReady && settings.get('vocalStrip') !== false);
        const vocalTxt = vA && vB ? (stripA ? ' · vocals out, beat in' : pick.clash < 0.5 ? ' · vocals clear' : '') : '';
        const out = {
          ...base, type: 'beatmatch', style: 'blend', fx,
          label: `Beat match · ${tempoTxt}${aA.camelot && aB.camelot ? ` · ${aA.camelot}→${aB.camelot}` : ''}${kc >= 0.85 ? ' · harmonic' : ''}${vocalTxt}${dropTxt} · ${bt} beats`,
          mixStart: ms, overlap: overlapR, inDur: overlapR * 0.5, outDur: overlapR * 0.62, outDelay: overlapR * 0.38,
          bStart: pick.bS, rate: bRate, aRate, preroll: bar * 2, beat: beat / aRate, vocalClash: pick.clash, stripA, dropAt: pick.dropOn ? drop : null,
        };
        if (cookBlend) {
          Object.assign(out, { cookKind: 'blend', throwEcho: cookBlend.throwEcho, label: `Cook It Up · ${cookBlend.club && ms < dur * 0.8 ? `Club mix at ${Math.round((ms / dur) * 100)}%` : 'Slow EQ blend'}${cookBlend.throwEcho ? ' + echo throw' : ''} · ${out.label.replace(/^Beat match · /, '')}` });
          // Stem swaps — what DJs do with acapellas/stems: one song's vocal rides on the other song's beat
          // for a while, so the change is carried by the music instead of a fade.
          // clashing keys: shorter, and only one song's melody is heard at a time (mids/highs handed over)
          if (kc < 0.6) Object.assign(out, { keySafe: true, label: out.label.replace('Slow EQ blend', 'Key-safe EQ blend') });
          // back to normal speed in one step on the next phrase after the mix, where the beat hides it
          if (Math.abs(bRate - 1) > 0.002) out.returnAfter = overlapR + (16 * beat) / bRate;
          if (fx && this.voxReady && vA && vB && kc >= 0.85 && Math.abs(bRate - 1) <= 0.025 && Math.abs((aRate || 1) - 1) <= 0.01) {
            const ovT = bt * beat, ovB = overlapR * bRate, bS0 = pick.bS;
            const sing = (sp, t0, t1) => { let x = 0; for (const [a, b] of sp) x += Math.max(0, Math.min(b, t1) - Math.max(a, t0)); return x; };
            const aSings = sing(vA, ms + ovT * 0.3, ms + ovT * 0.85), bIntroQuiet = sing(vB, bS0, bS0 + ovB) < 0.3;
            const aQuiet = sing(vA, ms + ovT * 0.2, ms + ovT) < 0.5, bSingsEarly = sing(vB, bS0 + ovB * 0.1, bS0 + ovB * 0.55) >= 1.5;
            if (aSings >= 2 && bIntroQuiet) {
              // the outgoing song's vocal over the incoming song's beat
              Object.assign(out, { stems: 'avb', stripA: false, label: `Cook It Up · Vocal bridge: ${A.title} sings over ${B.title}’s beat · ${tempoTxt} · ${bt} beats` });
            } else if (aQuiet && bSingsEarly) {
              // the incoming song's vocal arrives over the outgoing song's beat, then the beats swap
              Object.assign(out, { stems: 'bva', stripA: false, inDur: 0.05, outDelay: overlapR * 0.5, outDur: overlapR * 0.22, label: `Cook It Up · Beat swap: ${B.title}’s vocal over ${A.title}’s beat · ${tempoTxt} · ${bt} beats` });
            }
          }
        }
        return out;
      }
    }
    if (cookBlend && (settings.get('cookLevel') || 'smooth') === 'wild') { const c = this.cookPlan({ ...cookArgs, exclude: ['blend'] }); if (c && !c.cookBlend) return c; }
    // 2) outgoing song fades out by itself → slide the next one underneath
    if (aA && outroLen >= 3) {
      const overlap = clamp(outroLen * 0.85, 3, Math.max(D * 1.5, 5));
      return { ...base, type: 'smart', style: 'under', fx, label: 'DJ mix · fade under', mixStart: Math.max(0, end - overlap), overlap, inDur: overlap * 0.8, outDur: overlap, bStart };
    }
    // 3) hard ending → echo out
    if (aA && outroLen < 1.5 && bpmA && fx) {
      const beat = 60 / bpmA;
      const lead = clamp(beat * 2, 0.6, 2.2);
      return {
        ...base, type: 'smart', style: 'echo', fx, label: 'DJ mix · echo out',
        mixStart: Math.max(0, end - lead), overlap: lead + 0.4, inDur: 0.35, outDur: 0.06, outDelay: lead,
        bStart, echoTime: clamp(beat * 0.75, 0.18, 0.75), lead,
      };
    }
    // 4) anything else (tempos clash, or no analysis yet) → filter sweep
    const overlap = Math.min(Math.max(D, 4), Math.max(1.5, end * 0.3));
    return { ...base, type: 'smart', style: 'filter', fx, label: 'DJ mix · filter sweep', mixStart: Math.max(0, end - overlap), overlap, inDur: overlap * 0.6, outDur: overlap * 0.7, outDelay: overlap * 0.3, bStart };
  }

  // ---------- DJ Cook It Up ----------
  // A DJ who plays with the songs: real DJ moves, chosen to fit the two songs, never one of the last two
  // used, each with its own random lengths and entrance.
  //  • tempos close enough → the next song is tempo-matched and lands exactly on the outgoing song's "1"
  //  • the outgoing song leaves at a phrase line (every 16 beats) where nobody is mid-word, sometimes well
  //    before its end; the next song comes in on its drop or on a phrase start
  //  • loops, brakes and spin-backs are played from the decoded audio (sample-accurate, smooth), not by
  //    jerking the player's speed around
  cookPlan({ A, B, aA, aB, bpmA, dur, end, base, durB, after = 0, exclude: ex = [] }) {
    let exclude = ex;
    if (!this.cookSalt) this.cookSalt = Math.random().toString(36).slice(2);
    let seed = 2166136261;
    for (const ch of A.id + '|' + B.id + '|' + this.cookSalt + '|' + (this.cookHist || []).join() + '|' + exclude.join()) { seed ^= ch.charCodeAt(0); seed = Math.imul(seed, 16777619); }
    const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pickOf = (arr) => arr[Math.floor(rnd() * arr.length)];
    const beat = bpmA ? 60 / bpmA : 0.5, bar = beat * 4, phrase = bar * 4, off = aA?.beatOffset || 0;
    // can the next song be tempo-matched (allowing half / double time)?
    let bpmB = aB?.bpm || 0;
    if (bpmA && bpmB) { if (bpmB / bpmA > 1.4) bpmB /= 2; else if (bpmA / bpmB > 1.4) bpmB *= 2; }
    const ratio = bpmA && bpmB ? bpmA / bpmB : 0;
    const sync = ratio && Math.abs(ratio - 1) <= (IOS ? 0.08 : 0.1);
    const NAMES = { blend: 'Bass-swap blend', cut: 'Echo throw & cut', roll: 'Loop roll', brake: 'Vinyl brake', backspin: 'Spin-back', dub: 'Dub echo', riser: 'Riser into the drop', washout: 'Filter washout' };
    // how much it shows off: Smooth (default) is mostly clean blends with the odd echo or cut;
    // Hype adds rolls, brakes and spin-backs; Wild is everything, often
    const level = settings.get('cookLevel') || 'smooth';
    const W = {
      smooth: sync ? { blend: 7, cut: 2, dub: 2, roll: 1, washout: 1 } : { dub: 3, washout: 3, brake: 1, roll: 1 },
      hype: sync ? { blend: 4, cut: 2, roll: 2, backspin: 1, brake: 1, dub: 2, riser: 1, washout: 1 } : { roll: 1, backspin: 2, brake: 2, dub: 3, riser: 1, washout: 2 },
      wild: sync ? { blend: 3, cut: 2, roll: 3, backspin: 2, brake: 1, dub: 2, riser: 1, washout: 1 } : { roll: 2, backspin: 3, brake: 2, dub: 3, riser: 2, washout: 2 },
    }[level] || {};
    // Smooth & Hype are a DJ set: every transition is a real beat-matched blend (the songs are picked so
    // tempos line up, and Cook It Up allows a bigger tempo change), Hype sometimes throws in a cut or a
    // loop roll. Only Wild uses the stand-alone effects.
    // Smooth & Hype are a DJ set: the mix itself is the regular DJ engine (beat-matched, phrase-aligned,
    // bass swap, vocals kept apart, drop landed) — what makes it a set is the song picking (cookPickNext).
    // Hype adds the odd echo throw; the stand-alone effects are Wild only.
    if (level !== 'wild' && !after) return { cookBlend: true, club: level === 'club', throwEcho: level === 'hype' && rnd() < 0.25, cookKind: 'blend' };
    const recent = this.cookHist || [];
    let pool = Object.keys(W).filter((k) => !recent.includes(k) && !exclude.includes(k));
    if (after) pool = pool.filter((k) => k !== 'blend'); // after a jump there's no room planning a long blend
    if (!pool.length) pool = Object.keys(W).filter((k) => !exclude.includes(k) && k !== 'blend');
    if (!pool.length) pool = ['dub'];
    let tot = pool.reduce((s, k) => s + W[k], 0), x = rnd() * tot, kind = pool[0];
    for (const k of pool) { x -= W[k]; if (x <= 0) { kind = k; break; } }
    // the classic beat-matched blend (the regular DJ engine) with a Cook It Up echo throw at the end
    if (kind === 'blend') return { cookBlend: true, throwEcho: rnd() < (level === 'smooth' ? 0.35 : 0.6), cookKind: 'blend' };

    const beatsOf = { cut: 1, roll: level === 'wild' ? pickOf([4, 8]) : 4, brake: pickOf([1, 2]), backspin: 2, dub: pickOf([2, 4]), riser: pickOf([8, 16]), washout: pickOf([8, 16]) }[kind];
    const L = beatsOf * beat;
    // where the outgoing song goes out: a phrase line, nobody mid-word, at a strong moment
    const vA = vocalSpans(cachedLyrics(A));
    const loud = (t0, t1) => { const Lm = aA?.loud; if (!Lm) return 50; let s = 0, c = 0; for (let i = Math.max(0, Math.floor(t0 * 2)); i < Math.min(Lm.length, Math.ceil(t1 * 2)); i++) { s += Lm[i]; c++; } return c ? s / c : 50; };
    const cands = [];
    const lastLine = bpmA ? off + Math.floor((end - 0.4 - off) / bar) * bar : end;
    if (bpmA) {
      const startAt = { smooth: 0.78, hype: 0.62, wild: 0.5 }[level] || 0.78;
      const lo = Math.max(after + L + 1, end > 100 ? end * startAt : end * 0.7), hi = end - 0.4;
      for (let c = off + Math.ceil((lo - off) / phrase) * phrase; c <= hi; c += phrase) cands.push(c);
    }
    if (lastLine - L > after + 1) cands.push(lastLine);
    if (!cands.length) return null;
    const scored = cands.map((c) => {
      let s = rnd() * 2.2;                                         // variety
      if (vA) for (const [a, b] of vA) if (a < c - 0.15 && b > c + 0.05) s += 3; // a word would be chopped
      s -= loud(c - L - 2, c) / 40;                                // hit while it's going strong
      if (c === lastLine && end > 100) s += level === 'smooth' ? -0.6 : 0.8; // Smooth likes riding the song out
      return { c, s };
    }).sort((p, q) => p.s - q.s);
    const C = scored[0].c;
    if (C - L < Math.max(1, after)) return null;
    // where the next song comes in: on its drop (if it has one early enough) or a phrase start on its grid
    const drop = aB?.bpm ? findDrop(aB, aB.bpm) : null;
    let bS = aB?.leadIn || 0;
    const bb = aB?.bpm ? 60 / aB.bpm : 0;
    if (bb && aB.beatOffset != null) bS = Math.max(0, aB.beatOffset - Math.ceil(Math.max(0, aB.beatOffset - (aB.leadIn || 0)) / bb - 1e-6) * bb);
    const slam = ['cut', 'roll', 'brake', 'backspin', 'riser'].includes(kind);
    const useDrop = drop && drop < (durB || 240) * 0.55 && (slam ? rnd() < 0.75 : rnd() < 0.4);
    if (useDrop) bS = drop;
    const entry = kind === 'washout' || kind === 'dub' ? 'rise' : useDrop ? 'slam' : pickOf(['slam', 'slam', 'rise']);
    const rate = sync && kind !== 'washout' ? ratio : 1;
    const echoTime = beat * pickOf([0.75, 0.75, 0.5, 1.5]);
    const tail = kind === 'dub' ? 2.8 : kind === 'washout' ? bar : kind === 'cut' ? 2.4 : 0.6;
    const entryTxt = useDrop ? 'straight into the drop' : entry === 'rise' ? 'opens up' : 'on the 1';
    return {
      ...base, type: 'cook', style: 'cook', cook: kind, cookKind: kind, fx: true, entry, echoTime, beat, bar, sync: !!sync,
      label: `Cook It Up · ${NAMES[kind]} · next ${entryTxt}${sync && rate !== 1 ? ` · ${Math.round(bpmA)} BPM` : ''}`,
      mixStart: C - L, cutAt: C, build: L, overlap: tail, inDur: 0.02, outDur: tail, outDelay: 0, bStart: bS, rate,
      returnAfter: rate !== 1 ? bar * 8 / rate : 0, needsBuf: ['roll', 'brake', 'backspin'].includes(kind),
    };
  }
  // the decoded audio around the outgoing song's exit, for loops / brakes / spin-backs (kept small)
  async cookPrepare(p, t) {
    if (!p?.needsBuf || !this.ctx || p._slice || p._slicing) return;
    p._slicing = true;
    try {
      // one decode per song (plans are re-made as lyrics / analysis arrive; they share it)
      if (this._cookFull?.id !== t.id) this._cookFull = { id: t.id, p: fetchTrackBuffer(t).then((ab) => this.ctx.decodeAudioData(ab)) };
      const full = await this._cookFull.p;
      const sr = full.sampleRate, s0 = Math.max(0, Math.floor((p.cutAt - p.build - 4) * sr)), s1 = Math.min(full.length, Math.ceil((p.cutAt + 0.5) * sr));
      const buf = this.ctx.createBuffer(full.numberOfChannels, Math.max(1, s1 - s0), sr);
      for (let c = 0; c < full.numberOfChannels; c++) buf.copyToChannel(full.getChannelData(c).subarray(s0, s1), c);
      p._slice = { buf, start: s0 / sr };
    } catch (e) { /* falls back to the gain-only version */ }
    p._slicing = false;
  }
  // the outgoing song's build-up (before the next song is heard); resolves false if interrupted
  async cookBuild(A, B, p) {
    const ctx = this.ctx, t0 = ctx.currentTime + 0.01, tokA = A.token;
    const r0 = A.el.playbackRate || 1;
    const posNow = A.el.currentTime;
    const tc = t0 + Math.max(0.05, (p.cutAt - posNow) / r0);
    const L = tc - t0, beat = p.beat / r0;
    const at = (trackT) => t0 + (trackT - posNow) / r0;   // when a point of the song is heard
    p._tCut = tc;
    const H = this.hold.bind(this);
    const sl = p._slice;
    // a small piece of the decoded song, played through the outgoing deck's filters (the live player is muted)
    const src = (fromT, when, { loop = 0, reverse = false } = {}) => {
      if (!sl) return null;
      let buf = sl.buf;
      if (reverse) {
        buf = ctx.createBuffer(sl.buf.numberOfChannels, sl.buf.length, sl.buf.sampleRate);
        for (let c = 0; c < buf.numberOfChannels; c++) { const d = sl.buf.getChannelData(c), o = buf.getChannelData(c); for (let i = 0, n = d.length; i < n; i++) o[i] = d[n - 1 - i]; }
      }
      const n = ctx.createBufferSource(); n.buffer = buf;
      const g = ctx.createGain(); g.gain.value = 0;
      n.connect(g).connect(A.bass);
      const off = reverse ? (sl.start + sl.buf.duration) - fromT : fromT - sl.start;
      if (loop) { n.loop = true; n.loopStart = off; n.loopEnd = off + loop; }
      n.start(when, Math.max(0, off));
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.004);
      return { n, g };
    };
    const muteLive = (when) => { H(A.dry.gain, t0); A.dry.gain.setValueAtTime(1, when); A.dry.gain.linearRampToValueAtTime(0, when + 0.004); };
    const gate = (g, from, to, div0, div1) => { // smooth volume chops, faster towards the cut
      let t = from, i = 0;
      while (t < to - 0.01) {
        const k = (t - from) / Math.max(0.001, to - from);
        const step = beat / (div0 * Math.pow(div1 / div0, k));
        g.setTargetAtTime(i % 2 ? 0.0001 : 1, t, 0.004); i++;
        t += step / 2;
      }
    };
    let kind = p.cook;
    if (['roll', 'brake', 'backspin'].includes(kind) && !sl) kind = kind === 'backspin' ? 'dub' : kind === 'roll' ? 'gate' : 'brakeLive';
    switch (kind) {
      case 'roll': {
        // beat-repeat: the beat before the roll loops, halving each beat — 1, ½, ¼, ⅛ (… 1/16)
        const beats = Math.round(L / beat), startT = p.cutAt - p.build;
        const wild = (settings.get('cookLevel') || 'smooth') === 'wild';
        const pattern = beats >= 8 ? [[2, 1], [2, 0.5], [2, 0.25], [1, 0.125], [1, 0.0625]] : wild ? [[1, 1], [1, 0.5], [1, 0.25], [1, 0.125]] : [[2, 1], [1, 0.5], [1, 0.25]];
        let when = at(startT);
        muteLive(when);
        for (const [len, lp] of pattern) {
          const s = src(startT, when, { loop: lp * p.beat });
          if (s) { s.n.stop(when + len * beat + 0.01); s.g.gain.setValueAtTime(1, when + len * beat - 0.004); s.g.gain.linearRampToValueAtTime(0, when + len * beat); }
          when += len * beat;
        }
        H(A.hp.frequency, t0); A.hp.frequency.setValueAtTime(HP_OFF, at(startT)); A.hp.frequency.exponentialRampToValueAtTime(500, tc);
        break;
      }
      case 'brake': {
        // vinyl brake: the platter stops — smooth, from the decoded audio
        const tb = at(p.cutAt - p.build);
        muteLive(tb);
        const s = src(p.cutAt - p.build, tb);
        if (s) {
          s.n.playbackRate.setValueAtTime(r0, tb); s.n.playbackRate.exponentialRampToValueAtTime(0.06, tc);
          s.g.gain.setValueAtTime(1, tc - Math.min(0.12, L * 0.3)); s.g.gain.linearRampToValueAtTime(0, tc); s.n.stop(tc + 0.05);
        }
        H(A.lp.frequency, t0); A.lp.frequency.setValueAtTime(LP_OFF, tb); A.lp.frequency.exponentialRampToValueAtTime(1800, tc);
        break;
      }
      case 'backspin': {
        // spin-back: the record is pulled backwards fast, then lets go — the next song hits on the 1
        const tb = at(p.cutAt - p.build);
        muteLive(tb);
        const s = src(p.cutAt - p.build, tb, { reverse: true });
        if (s) {
          const r = s.n.playbackRate;
          r.setValueAtTime(0.6, tb); r.linearRampToValueAtTime(3.2, tb + L * 0.3); r.exponentialRampToValueAtTime(0.4, tc);
          s.g.gain.setValueAtTime(1, tb + L * 0.6); s.g.gain.linearRampToValueAtTime(0, tc); s.n.stop(tc + 0.05);
        }
        H(A.send.gain, t0); A.send.gain.setValueAtTime(0, tb); A.send.gain.linearRampToValueAtTime(0.3, tc);
        this.echoDelay.delayTime.setValueAtTime(Math.min(2.5, beat * 0.5), t0); H(this.echoFb.gain, t0); this.echoFb.gain.setValueAtTime(0.35, t0); this.echoFb.gain.linearRampToValueAtTime(0, tc + 1.5);
        break;
      }
      case 'cut':
        // the last beat is thrown into an echo, the next song lands on the 1 underneath it
        this.echoDelay.delayTime.setValueAtTime(Math.min(2.5, p.echoTime / r0), t0);
        H(this.echoFb.gain, t0); this.echoFb.gain.setValueAtTime(0.38, t0); this.echoFb.gain.setValueAtTime(0.38, tc + 0.6); this.echoFb.gain.linearRampToValueAtTime(0, tc + 2);
        H(A.send.gain, t0); A.send.gain.setValueAtTime(0, tc - beat); A.send.gain.linearRampToValueAtTime(0.5, tc - beat * 0.5);
        H(A.fade.gain, t0); A.fade.gain.setValueAtTime(1, tc - 0.01); A.fade.gain.linearRampToValueAtTime(0.0001, tc + 0.01);
        break;
      case 'dub':
        this.echoDelay.delayTime.setValueAtTime(Math.min(2.5, p.echoTime / r0), t0);
        H(this.echoFb.gain, t0); this.echoFb.gain.setValueAtTime(0.45, t0);
        this.echoFb.gain.setValueAtTime(0.45, tc + 0.8); this.echoFb.gain.linearRampToValueAtTime(0, tc + 2.6);
        H(A.send.gain, t0); A.send.gain.linearRampToValueAtTime(0.55, tc);
        H(A.fade.gain, t0); A.fade.gain.setValueAtTime(1, tc - 0.02); A.fade.gain.linearRampToValueAtTime(0.0001, tc);
        H(A.hp.frequency, t0); A.hp.frequency.exponentialRampToValueAtTime(280, tc);
        break;
      case 'washout':
        H(A.lp.frequency, t0); A.lp.frequency.exponentialRampToValueAtTime(180, tc + beat * 2);
        H(A.lp.Q, t0); A.lp.Q.linearRampToValueAtTime(3, tc);
        this.echoDelay.delayTime.setValueAtTime(Math.min(2.5, p.echoTime / r0), t0);
        H(this.echoFb.gain, t0); this.echoFb.gain.setValueAtTime(0.35, t0); this.echoFb.gain.linearRampToValueAtTime(0, tc + beat * 6);
        H(A.send.gain, t0); A.send.gain.linearRampToValueAtTime(0.35, tc);
        H(A.fade.gain, t0); A.fade.gain.setValueAtTime(1, tc); A.fade.gain.linearRampToValueAtTime(0.0001, tc + beat * 3);
        break;
      case 'riser': {
        // filtered noise sweep climbing into the drop; the beat chops in the last bar
        const n = ctx.createBufferSource(), buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        n.buffer = buf; n.loop = true;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
        bp.frequency.setValueAtTime(600, t0); bp.frequency.exponentialRampToValueAtTime(7000, tc);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.045, tc - 0.03); g.gain.linearRampToValueAtTime(0, tc);
        n.connect(hp).connect(bp).connect(g).connect(this.input); n.start(t0); n.stop(tc + 0.05);
        H(A.hp.frequency, t0); A.hp.frequency.exponentialRampToValueAtTime(700, tc);
        H(A.fade.gain, t0); gate(A.fade.gain, tc - beat * 4, tc, 2, 8); A.fade.gain.setTargetAtTime(0.0001, tc - 0.01, 0.004);
        break;
      }
      case 'gate': // loop roll without decoded audio: volume chops that speed up
        H(A.fade.gain, t0); gate(A.fade.gain, t0, tc, 2, 8); A.fade.gain.setTargetAtTime(0.0001, tc - 0.01, 0.004);
        H(A.hp.frequency, t0); A.hp.frequency.exponentialRampToValueAtTime(900, tc);
        break;
      case 'brakeLive':
      default:
        H(A.lp.frequency, t0); A.lp.frequency.exponentialRampToValueAtTime(900, tc);
        H(A.fade.gain, t0); A.fade.gain.setValueAtTime(1, t0); A.fade.gain.linearRampToValueAtTime(0.0001, tc);
        break;
    }
    // get the next song rolling (silent, already at the matched tempo) just before the cut
    const lead = 0.3;
    await new Promise((r) => setTimeout(r, Math.max(0, (tc - ctx.currentTime - lead) * 1000)));
    if (p._aborted) return false;
    if (A.token !== tokA || this.cur !== A || !this.playing) { this.cookAbort(A); return false; }
    B.el.playbackRate = p.rate || 1;
    try { B.el.currentTime = Math.max(0, p.bStart - lead * (p.rate || 1)); } catch (e) { /* */ }
    return true;
  }
  cookAbort(d) {
    clearInterval(d.rateTimer);
    try { d.el.preservesPitch = true; d.el.webkitPreservesPitch = true; } catch (e) { /* */ }
    if (d.track && d === this.cur) { d.el.playbackRate = 1; this.resetFx(d); this.setFade(d, 1); try { d.lp.Q.setValueAtTime(0.7, this.ctx.currentTime); } catch (e) { /* */ } }
  }
  // the next song's entrance on the cut
  cookEnter(A, B, p) {
    const ctx = this.ctx, tc = Math.max(ctx.currentTime + 0.005, p._tCut || ctx.currentTime);
    const beat = p.beat || 0.5;
    const g = B.fade.gain;
    g.cancelScheduledValues(0); g.setValueAtTime(0, ctx.currentTime); g.setValueAtTime(0, tc);
    g.linearRampToValueAtTime(1, tc + (p.entry === 'rise' ? beat * 2 : 0.035));
    if (p.entry === 'rise') { this.hold(B.hp.frequency, ctx.currentTime); B.hp.frequency.setValueAtTime(1400, tc); B.hp.frequency.exponentialRampToValueAtTime(HP_OFF, tc + beat * 8); }
    // the low end comes in over a couple of beats so the hit isn't a wall of bass on top of the echo
    this.hold(B.bass.gain, ctx.currentTime); B.bass.gain.setValueAtTime(p.cook === 'dub' || p.cook === 'washout' ? -12 : -8, tc); B.bass.gain.linearRampToValueAtTime(0, tc + beat * (p.cook === 'dub' || p.cook === 'washout' ? 8 : 2));
    // the outgoing deck is silent from the cut on (echo / washout tails ring on their own)
    if (p.cook !== 'washout') { this.hold(A.fade.gain, ctx.currentTime); A.fade.gain.setValueAtTime(0.0001, tc + 0.012); }
  }
  // automation helpers (Web Audio clock)
  hold(param, at) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(at); else { param.cancelScheduledValues(at); param.setValueAtTime(param.value, at); }
  }
  // Start the incoming song ~3 s early with its volume at zero, already at the right speed, and keep
  // nudging its *position* (silently) until it's beat-locked. At the mix point only volumes/filters move,
  // so there's no start-up stutter and no audible speed corrections.
  preroll(p) {
    const A = this.cur, B = this.other, nx = this.upcoming;
    if (!nx || !this.ctx || !A.fx || this.transition) { p.noPreroll = true; return; }
    const rb = p.rate || 1;
    const lead = (p.mixStart - A.el.currentTime) / (A.el.playbackRate || 1); // real seconds until the mix
    const startAt = p.bStart - lead * rb;
    if (lead < 0.8) { p.noPreroll = true; return; }
    if (B.track !== nx.track) { this.loadDeck(B, nx.track, Math.max(0, startAt)); this.applyDeckGain(B); }
    if (!B.fx) { p.noPreroll = true; return; } // can't silence a direct (non-Web-Audio) element on iPhone
    if (startAt < 0.2) {
      // the mix starts at the very top of the next song: warm it up silently (decoder + buffer), then park it
      // exactly on its start so it begins instantly at the mix point. Not on iPhone: a play→pause there hands
      // the lock screen / CarPlay to the paused song ("Paused" while music plays).
      p.noPreroll = true;
      if (IOS) return;
      const tokB = B.token;
      this.resetFx(B);
      this.setFade(B, 0);
      try { B.el.currentTime = 0; } catch (e) { /* */ }
      B.el.playbackRate = rb;
      B.el.play().then(() => setTimeout(() => {
        if (B.token !== tokB || this.transition || this.plan !== p) return;
        B.el.pause();
        try { B.el.currentTime = p.bStart; } catch (e) { /* */ }
      }, Math.min(700, Math.max(200, (lead - 0.4) * 1000)))).catch(() => {});
      return;
    }
    this.resetFx(B);
    this.setFade(B, 0);
    try { B.el.currentTime = startAt; } catch (e) { /* */ }
    B.el.playbackRate = rb;
    p.prerolled = true;
    const tokA = A.token, tokB = B.token;
    B.el.play().catch(() => { p.prerolled = false; p.noPreroll = true; });
    clearInterval(this.prerollTimer);
    this.prerollTimer = setInterval(() => {
      if (A.token !== tokA || B.token !== tokB || this.transition || this.plan !== p) { clearInterval(this.prerollTimer); return; }
      const ra = A.el.playbackRate || 1;
      const left = (p.mixStart - A.el.currentTime) / ra;
      if (left < 0.35) { clearInterval(this.prerollTimer); return; } // settled
      if (B.el.paused || B.el.readyState < 3) return;
      const exp = p.bStart - left * rb;
      if (Math.abs(B.el.currentTime - exp) > 0.025) { try { B.el.currentTime = exp + 0.01; } catch (e) { /* */ } }
    }, 120);
  }
  async runPlan() {
    this.planTimer = null;
    const p = this.plan, nx = this.upcoming;
    if (!p || !nx || this.transition || !this.playing) return;
    const A = this.cur, B = this.other;
    clearInterval(this.prerollTimer);
    const rolling = p.prerolled && B.track === nx.track && !B.el.paused;
    if (B.track !== nx.track) { this.loadDeck(B, nx.track, p.bStart); this.applyDeckGain(B); }
    else if (!rolling && Math.abs(B.el.currentTime - p.bStart) > 0.08) { try { B.el.currentTime = p.bStart; } catch (e) { /* */ } }
    const useFx = p.fx && A.fx && B.fx && this.ctx;
    if (p.style === 'acapella' && useFx && A.vox) return this.runAcapella(A, B, p, nx);
    if (p.style === 'acapella') { p.style = 'echo'; p.lead = p.iso; p.bStart = p.bDrop; } // no worklet: classic echo word play
    if (!rolling) {
      this.resetFx(B);
      this.setFade(B, p.style === 'gapless' ? 1 : 0);
      B.el.playbackRate = p.rate || 1;
    }
    // B's low end starts held back (DJ style) so two kick drums never fight
    if (useFx) {
      const now = this.ctx.currentTime;
      if (p.style === 'blend') B.bass.gain.setValueAtTime(BASS_CUT, now);
      if (p.style === 'under') B.bass.gain.setValueAtTime(-18, now);
      if (p.style === 'echo') B.bass.gain.setValueAtTime(-12, now);
      if (p.style === 'filter') { B.hp.frequency.setValueAtTime(900, now); B.bass.gain.setValueAtTime(-10, now); }
    }
    // echo / word play: the outgoing line rings out first, the next song starts exactly as it ends
    if (p.style === 'echo') {
      const tokA = A.token;
      const ta = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      if (useFx) {
        this.echoDelay.delayTime.setValueAtTime(p.echoTime, ta);
        this.echoFb.gain.setValueAtTime(0.52, ta);
        this.hold(A.send.gain, ta); A.send.gain.linearRampToValueAtTime(0.85, ta + p.lead);
        this.fade(A, 0, 0.08, { delay: p.lead, shape: 'linear' });
        this.echoFb.gain.setValueAtTime(0.52, ta + p.lead + 1.5);
        this.echoFb.gain.linearRampToValueAtTime(0, ta + p.lead + 4);
      } else this.fade(A, 0, p.lead, { shape: 'equalpower' });
      this.echoPending = true;
      await new Promise((r) => setTimeout(r, Math.max(0, p.lead * 0.94) * 1000));
      this.echoPending = false;
      if (A.token !== tokA || this.cur !== A || !this.playing) return;
    }
    if (p.style === 'cook') {
      if (p._started || this.cooking) return; // already building (the mix timer and the clock can both fire it)
      p._started = true;
      if (!useFx) { p.style = 'filter'; p.overlap = 4; p.inDur = 2.4; p.outDur = 2.8; p.outDelay = 1.2; }
      else {
        this.setFade(B, 0);
        this.cooking = true;
        let ok = false;
        try { ok = await this.cookBuild(A, B, p); } finally { this.cooking = false; }
        if (!ok || this.plan !== p) return;
      }
    }
    if (!rolling) { try { await B.el.play(); } catch (e) { if (e.name !== 'AbortError') { this.onEnded(); return; } } }
    const t0 = this.ctx ? this.ctx.currentTime + 0.01 : 0;
    const D = p.overlap || p.outDelay + p.outDur;
    const sh = p.shape;
    switch (p.style) {
      case 'gapless':
        this.fade(A, 0, p.outDur, { shape: 'linear' });
        break;
      case 'cook':
        this.cookEnter(A, B, p);
        break;
      case 'crossfade':
        this.fade(B, 1, p.inDur, { shape: sh });
        this.fade(A, 0, p.outDur, { shape: sh });
        break;
      case 'blend': {
        this.fade(B, 1, p.inDur, { shape: 'equalpower' });
        this.fade(A, 0, p.outDur, { delay: p.outDelay, shape: 'scurve' });
        if (useFx) {
          const swap = t0 + D * 0.5, swapLen = Math.min(0.5, (p.beat || 0.5));
          this.hold(B.bass.gain, t0); B.bass.gain.setValueAtTime(BASS_CUT, swap); B.bass.gain.linearRampToValueAtTime(0, swap + swapLen);
          this.hold(A.bass.gain, t0); A.bass.gain.setValueAtTime(0, swap); A.bass.gain.linearRampToValueAtTime(BASS_CUT, swap + swapLen);
          // three-band mixing: the incoming song's mids sit back too, and swap with the bass on the same beat
          if (B.mid && A.mid) {
            const mc = p.keySafe ? -15 : -7;
            this.hold(B.mid.gain, t0); B.mid.gain.setValueAtTime(mc, t0); B.mid.gain.setValueAtTime(mc, swap); B.mid.gain.linearRampToValueAtTime(0, swap + swapLen * 2);
            this.hold(A.mid.gain, t0); A.mid.gain.setValueAtTime(0, swap); A.mid.gain.linearRampToValueAtTime(p.keySafe ? -15 : -6, swap + swapLen * 2);
            if (p.keySafe) {
              // the incoming song's top end (its lead / high notes) waits for the handover too
              this.hold(B.lp.frequency, t0); B.lp.frequency.setValueAtTime(2500, t0); B.lp.frequency.setValueAtTime(2500, swap); B.lp.frequency.exponentialRampToValueAtTime(LP_OFF, swap + swapLen * 2);
              this.hold(A.lp.frequency, t0); A.lp.frequency.setValueAtTime(LP_OFF, swap); A.lp.frequency.exponentialRampToValueAtTime(2500, swap + swapLen * 2);
            }
          }
          this.hold(A.hp.frequency, t0); A.hp.frequency.setValueAtTime(HP_OFF, t0 + D * 0.55); A.hp.frequency.exponentialRampToValueAtTime(380, t0 + D);
          // incoming highs open up over the first ~40% (hats and vocals don't pile on top of the outgoing song)
          this.hold(B.lp.frequency, t0); B.lp.frequency.setValueAtTime(2600, t0); B.lp.frequency.exponentialRampToValueAtTime(LP_OFF, t0 + D * 0.42);
          // outgoing highs soften as it leaves
          this.hold(A.lp.frequency, t0); A.lp.frequency.setValueAtTime(LP_OFF, t0 + D * 0.5); A.lp.frequency.exponentialRampToValueAtTime(5200, t0 + D);
          // Cook It Up flourish: the outgoing song's last beat is thrown into an echo as it leaves
          if (p.throwEcho) {
            const tt = t0 + D * 0.86, b = p.beat || 0.5;
            this.echoDelay.delayTime.setValueAtTime(Math.min(2.5, b * 0.75), t0);
            this.hold(this.echoFb.gain, t0); this.echoFb.gain.setValueAtTime(0.38, tt); this.echoFb.gain.setValueAtTime(0.38, tt + 0.8); this.echoFb.gain.linearRampToValueAtTime(0, tt + 2.2);
            this.hold(A.send.gain, t0); A.send.gain.setValueAtTime(0, tt); A.send.gain.linearRampToValueAtTime(0.45, tt + b * 0.5);
            // silence it before the fader (the fade curve owns A.fade); the echo keeps ringing on its own bus
            A.dry.gain.setTargetAtTime(0, tt + b * 0.5, 0.006);
            if (A.instV) A.instV.gain.setTargetAtTime(0, tt + b * 0.5, 0.006);
          }
          // stem swaps (Cook It Up): the change happens in the music — one song's vocal over the other's beat
          if (p.stems === 'avb' && A.vox && A.instV && A.dry) {
            // A goes to stems without a sound changing, its beat leaves as B's bass takes over, its vocal
            // keeps singing on B's beat, then bows out
            const b = p.beat || 0.5, ts = t0 + D * 0.22;
            this.voxActive(A, true);
            this.hold(A.dry.gain, t0); A.dry.gain.setValueAtTime(1, ts); A.dry.gain.linearRampToValueAtTime(0, ts + b * 2);
            this.hold(A.instV.gain, t0); A.instV.gain.setValueAtTime(0, ts); A.instV.gain.linearRampToValueAtTime(1, ts + b * 2);
            A.instV.gain.setValueAtTime(1, t0 + D * 0.32); A.instV.gain.linearRampToValueAtTime(0, t0 + D * 0.52);
            this.hold(A.voxGain.gain, t0); A.voxGain.gain.setValueAtTime(0, ts); A.voxGain.gain.linearRampToValueAtTime(1, ts + b * 2);
            A.voxGain.gain.setValueAtTime(1, t0 + D * 0.84); A.voxGain.gain.linearRampToValueAtTime(0, t0 + D * 0.99);
            // B's mids stay tucked while the borrowed vocal sits on top
            if (B.mid) { B.mid.gain.cancelScheduledValues(t0); B.mid.gain.setValueAtTime(-6, t0); B.mid.gain.setValueAtTime(-6, t0 + D * 0.8); B.mid.gain.linearRampToValueAtTime(0, t0 + D); }
          }
          if (p.stems === 'bva' && B.vox && B.instV && B.dry) {
            // B starts as its vocal only (over A's beat), its beat swaps in with the bass, then it's whole
            const b = p.beat || 0.5, sw = t0 + D * 0.5;
            this.voxActive(B, true);
            this.hold(B.dry.gain, t0); B.dry.gain.setValueAtTime(0, t0); B.dry.gain.setValueAtTime(0, t0 + D * 0.82); B.dry.gain.linearRampToValueAtTime(1, t0 + D * 0.82 + b * 2);
            this.hold(B.instV.gain, t0); B.instV.gain.setValueAtTime(0, t0); B.instV.gain.setValueAtTime(0, sw); B.instV.gain.linearRampToValueAtTime(1, sw + b);
            B.instV.gain.setValueAtTime(1, t0 + D * 0.82); B.instV.gain.linearRampToValueAtTime(0, t0 + D * 0.82 + b * 2);
            this.hold(B.voxGain.gain, t0); B.voxGain.gain.setValueAtTime(0, t0); B.voxGain.gain.linearRampToValueAtTime(0.95, t0 + b * 4);
            B.voxGain.gain.setValueAtTime(0.95, t0 + D * 0.82); B.voxGain.gain.linearRampToValueAtTime(0, t0 + D * 0.82 + b * 2);
          }
          // vocals would clash: the outgoing song drops its vocals (keeps its music and beat) as the next one comes in
          if (p.stripA && A.vox && A.instV && A.dry) {
            this.voxActive(A, true);
            const ts = t0 + D * 0.18, len = Math.max(0.25, Math.min(1.2, (p.beat || 0.5) * 2));
            this.hold(A.dry.gain, t0); A.dry.gain.setValueAtTime(1, ts); A.dry.gain.linearRampToValueAtTime(0, ts + len);
            this.hold(A.instV.gain, t0); A.instV.gain.setValueAtTime(0, ts); A.instV.gain.linearRampToValueAtTime(1.05, ts + len);
          }
        }
        break;
      }
      case 'under':
        this.fade(B, 1, p.inDur, { shape: 'equalpower' });
        this.fade(A, 0, p.outDur, { shape: 'scurve' });
        if (useFx) {
          this.hold(B.bass.gain, t0); B.bass.gain.linearRampToValueAtTime(0, t0 + D * 0.65);
          this.hold(A.hp.frequency, t0); A.hp.frequency.exponentialRampToValueAtTime(220, t0 + D);
        }
        break;
      case 'echo':
        // A's echo was started above; B drops in now and its bass slides back
        this.fade(B, 1, p.inDur, { shape: 'equalpower' });
        if (useFx) { this.hold(B.bass.gain, t0); B.bass.gain.linearRampToValueAtTime(0, t0 + 2.5); }
        break;
      case 'filter':
      default:
        this.fade(B, 1, p.inDur, { shape: 'equalpower' });
        this.fade(A, 0, p.outDur, { delay: p.outDelay, shape: 'equalpower' });
        if (useFx) {
          this.hold(A.lp.frequency, t0); A.lp.frequency.exponentialRampToValueAtTime(320, t0 + D);
          this.hold(B.hp.frequency, t0); B.hp.frequency.exponentialRampToValueAtTime(HP_OFF, t0 + D * 0.75);
          this.hold(B.bass.gain, t0); B.bass.gain.linearRampToValueAtTime(0, t0 + D * 0.8);
        }
        break;
    }
    if (p.style === 'blend') this.startBeatLock(A, B, p);
    if (p.style !== 'gapless') library.addMix(p.style);
    if (p.cookKind) this.cookHist = [...(this.cookHist || []), p.cookKind].slice(-2);
    this.notePlayed(A);
    const total = (p.style === 'echo' ? 4.2 : Math.max(p.outDelay + p.outDur, D)) * 1000;
    this.transition = { from: A, to: B, plan: p, at: performance.now(), total: 0 };
    queueMicrotask(() => this.emit('transition', true));
    this.ai = 1 - this.ai;
    this.index = nx.index;
    this.upcoming = null;
    this.plan = null;
    this.emit('plan', null);
    const tok = A.token;
    if (this.transition) this.transition.total = total;
    this.transitionTimer = setTimeout(() => { if (A.token === tok) this.finishTransition(); }, total + 120);
    if (Math.abs((p.rate || 1) - 1) > 0.001) {
      const tokB = B.token;
      // back to the song's real speed as soon as the old song is basically gone (not seconds later)
      // the moment the old song is gone, the new one goes back to its real speed (quickly, no hanging)
      setTimeout(() => { if (B.token === tokB) this.rampRate(B, 1, p.cookKind || IOS ? 0 : (p.returnAfter ? 4 : 2)); }, (p.returnAfter || D) * 1000);
    }
    this.afterTrackChange(p);
  }
  // Keeps the incoming song's beats locked to the outgoing song during a blend by
  // nudging its speed (±3%) — corrects start-up latency and any drift.
  startBeatLock(A, B, p) {
    clearInterval(this.lockTimer);
    const rb = p.rate || 1;
    const started = performance.now();
    // keep the beats locked only while both songs are clearly audible; then the new song is let go
    // (and returns to its own speed) — the lock must never pull it back to the mixing speed
    const until = started + (p.overlap || 8) * 0.97 * 1000;
    const tokA = A.token, tokB = B.token;
    let lastChange = 0;
    this.lockTimer = setInterval(() => {
      if (performance.now() > until || A.token !== tokA || B.token !== tokB || A.el.paused || B.el.paused) {
        clearInterval(this.lockTimer);
        return;
      }
      const ra = A.el.playbackRate || 1;
      const expB = p.bStart + (A.el.currentTime - p.mixStart) * (rb / ra);
      const err = B.el.currentTime - expB; // seconds of B's track; + means B is ahead
      // big error: jump — but only while the incoming song is still (nearly) silent
      if (Math.abs(err) > 0.12 && performance.now() - started < 1500) { try { B.el.currentTime = expB + 0.02; } catch (e) { /* */ } return; }
      const now = performance.now();
      if (IOS || p.prerolled) return; // lined up silently during the pre-roll; no audible speed nudges
      if (now - lastChange < 700) return; // rare, deliberate corrections only
      // within 10 ms: back to the exact sync speed; otherwise a single 1–2% nudge that closes the gap in ~1.5 s
      const target = Math.abs(err) < 0.01 ? rb : rb * (1 + clamp(-err / 1.5, -0.02, 0.02));
      const q = Math.round(target * 400) / 400;
      if (Math.abs(B.el.playbackRate - q) >= 0.002) { B.el.playbackRate = q; lastChange = now; }
    }, 150);
  }
  // Word play, acapella style. Everything at the critical moment is scheduled on the audio clock
  // (sample-accurate); the next song is already running (muted, lined up) before the drop.
  async runAcapella(A, B, p, nx) {
    const ctx = this.ctx;
    const ra = A.el.playbackRate || 1;
    this.voxActive(A, true);
    this.resetFx(B);
    this.setFade(B, 0);
    B.el.playbackRate = 1;
    const t0 = ctx.currentTime + 0.03;
    const tIso = t0 + p.pre / ra, tEnd = t0 + (p.pre + p.iso) / ra;
    const N = 64, up = new Float32Array(N), down = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = i / (N - 1); up[i] = Math.sin((x * Math.PI) / 2) * 1.1; down[i] = Math.cos((x * Math.PI) / 2); }
    // 1) the beat drops out, the (latency-matched) isolated vocal stays
    this.hold(A.fade.gain, t0); A.fade.gain.setValueCurveAtTime(down, t0 + 0.01, p.pre / ra);
    this.hold(A.voxGain.gain, t0); A.voxGain.gain.setValueCurveAtTime(up, t0 + 0.01, p.pre / ra);
    // 2) end of the line: vocal out (title cue: last word echoes; shared words: short duck under B)
    this.hold(A.voxSend.gain, t0);
    if (p.handoff) {
      A.voxGain.gain.setValueAtTime(1.1, tEnd - 0.01);
      A.voxGain.gain.linearRampToValueAtTime(0, tEnd + 0.12);
    } else {
      this.echoDelay.delayTime.setValueAtTime(p.echoTime, t0);
      this.echoFb.gain.setValueAtTime(0.45, t0);
      A.voxSend.gain.setValueAtTime(0, Math.max(tIso, tEnd - 0.4));
      A.voxSend.gain.linearRampToValueAtTime(0.85, tEnd);
      A.voxGain.gain.setValueAtTime(1.1, tEnd - 0.01);
      A.voxGain.gain.linearRampToValueAtTime(0, tEnd + 0.07);
      this.echoFb.gain.setValueAtTime(0.45, tEnd + 1.2);
      this.echoFb.gain.linearRampToValueAtTime(0, tEnd + 3.5);
    }
    // 3) next song: instrumental (vocals removed) builds underneath, full mix drops exactly at tEnd
    this.hold(B.fade.gain, t0);
    B.fade.gain.setValueAtTime(0, tEnd - 0.004);
    B.fade.gain.linearRampToValueAtTime(1, tEnd + 0.05);
    this.hold(B.instGain.gain, t0);
    if (p.under) {
      B.instGain.gain.setValueAtTime(0, t0);
      B.instGain.gain.linearRampToValueAtTime(0.85, t0 + Math.max(0.3, (tEnd - t0) * 0.85));
      B.instGain.gain.setValueAtTime(0.85, tEnd - 0.004);
    }
    B.instGain.gain.linearRampToValueAtTime(0, tEnd + 0.05);
    this.hold(B.bass.gain, t0);
    B.bass.gain.setValueAtTime(-10, tEnd);
    B.bass.gain.linearRampToValueAtTime(0, tEnd + 2);
    // start B muted so that it reaches bDrop exactly at tEnd; corrections happen while it's silent
    const tokB = B.token;
    const startB = async () => {
      if (B.token !== tokB) return;
      const exp = p.bDrop - (tEnd - ctx.currentTime);
      try { if (Math.abs(B.el.currentTime - exp) > 0.03) B.el.currentTime = Math.max(0, exp); } catch (e) { /* */ }
      try { await B.el.play(); } catch (e) { if (e.name !== 'AbortError') this.onEnded(); }
    };
    const lead = tEnd - ctx.currentTime;
    if (p.bDrop >= lead) await startB();
    else setTimeout(startB, Math.max(0, (lead - p.bDrop) * 1000 - 40));
    clearInterval(this.lockTimer);
    this.lockTimer = setInterval(() => {
      const now = ctx.currentTime;
      if (B.token !== tokB || now > tEnd + 0.25) { clearInterval(this.lockTimer); if (B.token === tokB && B.el.playbackRate !== 1) B.el.playbackRate = 1; return; }
      if (B.el.paused) return;
      const err = B.el.currentTime - (p.bDrop - (tEnd - now));
      if (now < tEnd - 0.35) {
        if (Math.abs(err) > 0.04) { try { B.el.currentTime = p.bDrop - (tEnd - now) + 0.03; } catch (e) { /* */ } }
        else if (!IOS && Math.abs(err) > 0.012) { const q = Math.round((1 - clamp(err / 0.6, -0.04, 0.04)) * 400) / 400; if (Math.abs(B.el.playbackRate - q) >= 0.002) B.el.playbackRate = q; }
        else if (B.el.playbackRate !== 1) B.el.playbackRate = 1;
      } else if (B.el.playbackRate !== 1 && Math.abs(err) < 0.02) B.el.playbackRate = 1;
    }, 150);
    this.notePlayed(A);
    library.addMix('acapella');
    this.transition = { from: A, to: B, plan: p, at: performance.now(), total: 0 };
    queueMicrotask(() => this.emit('transition', true));
    this.ai = 1 - this.ai;
    this.index = nx.index;
    this.upcoming = null;
    this.plan = null;
    this.emit('plan', null);
    const tok = A.token;
    const total = ((tEnd - ctx.currentTime) + (p.handoff ? 1.2 : 3.8)) * 1000;
    this.transitionTimer = setTimeout(() => { if (A.token === tok) this.finishTransition(); }, Math.max(500, total));
    this.afterTrackChange(p);
  }
  finishTransition() {
    if (!this.transition) return;
    clearTimeout(this.transitionTimer);
    const { from, to } = this.transition;
    const st = this.transition.plan?.stems;
    this.transition = null;
    this.emit('transition', false);
    if (st && this.cur?.dry && this.ctx) {
      const d = this.cur, now = this.ctx.currentTime;
      for (const [g, v] of [[d.dry.gain, 1], [d.instV?.gain, 0], [d.voxGain?.gain, 0]]) if (g) { g.cancelScheduledValues(now); g.setValueAtTime(v, now); }
      this.voxActive(d, false);
    }
    if (from !== this.cur) {
      clearInterval(from.rateTimer);
      try { from.el.preservesPitch = true; from.el.webkitPreservesPitch = true; from.lp?.Q.setValueAtTime(0.7, this.ctx?.currentTime || 0); } catch (e) { /* */ }
      this.resetFx(from); if (IOS) { this.setFade(from, 0); from.softUnload(); } else from.unload(); this.reassertNowPlaying();
    }
    if (to?.fx && this.ctx) {
      this.voxActive(to, false);
      const now = this.ctx.currentTime;
      for (const prm of [to.instGain.gain, to.voxGain?.gain, to.voxSend?.gain].filter(Boolean)) { this.hold(prm, now); prm.setTargetAtTime(0, now, 0.05); }
    }
    // make sure the new song ends up with clean filters even if the mix was interrupted
    if (to === this.cur && to.fx && this.ctx) {
      const now = this.ctx.currentTime;
      for (const [prm, v] of [[to.bass.gain, 0], [to.hp.frequency, HP_OFF], [to.lp.frequency, LP_OFF], ...(to.mid ? [[to.mid.gain, 0]] : [])]) {
        if (Math.abs(prm.value - v) > 0.5) { this.hold(prm, now); prm.setTargetAtTime(v, now, 0.15); }
      }
      this.hold(to.fade.gain, now); to.fade.gain.setTargetAtTime(1, now, 0.1);
    }
    if (this.echoFb) this.echoFb.gain.setTargetAtTime(0, this.ctx.currentTime + 0.5, 0.6);
  }
  // ---------- clock ----------
  tick() {
    const d = this.cur;
    if (!d.track) return;
    this.checkSeek(d);
    const ctNow = d.el.currentTime || 0;
    if (!this._clk || this._clk.d !== d || this._clk.ct !== ctNow || !this.playing) this._clk = { d, ct: ctNow, at: performance.now() };
    this.syncPlayState(d);
    this.emit('time');
    if (this.playing && !d.el.paused) {
      // keep the lock screen / CarPlay clock in step (tempo-synced mixes change the playback speed)
      const nowMs = performance.now();
      if (nowMs - (this._posAt || 0) > 1000 || Math.abs((d.el.playbackRate || 1) - (this._posRate || 1)) > 0.004) {
        this._posAt = nowMs; this._posRate = d.el.playbackRate || 1;
        this.updatePosition();
      }
      // listening time (for stats)
      const dt = Math.min(1, (nowMs - (this._lastTick || nowMs)) / 1000);
      this._lastTick = nowMs;
      if (dt > 0) library.addListening(dt, d.track.id);
    } else this._lastTick = 0;
    if (this.sleepAt && Date.now() >= this.sleepAt) {
      this.sleepAt = 0;
      this.fade(d, 0, 8, { shape: 'linear' });
      setTimeout(() => { this.pause(); this.emit('sleep'); }, 8000);
      return;
    }
    if (!this.playing || d.el.paused || this.transition || this.echoPending) return;
    const dur = this.duration;
    if (!dur) return;
    const t = d.el.currentTime;
    const remaining = dur - t;
    // the next song + its mix are worked out early (10 s into a song), so the mix point is known — and
    // marked on the scrubber — long before it comes, and scrubbing to just before it always works
    // (Club and Wild can leave a song early, so they plan early — on iPhone a little later, to keep the start smooth)
    const lvl = this.cookMode && settings.get('cookLevel');
    if (!this.upcoming && (remaining < 90 || ((lvl === 'wild' || lvl === 'club') && t > (IOS ? Math.min(60, this.duration * 0.3) : 10)))) this.prepareNext();
    // Cook It Up loops / brakes need the decoded song: only fetched shortly before they're used
    const cp = this.plan;
    if (cp?.needsBuf && !cp._slice && !cp._slicing && t > cp.mixStart - 25) this.cookPrepare(cp, this.cur.track);
    if (this.lateSeek) {
      if (remaining < 1.6 && !this._lateGo) {
        this._lateGo = true;
        const i = this.upcoming?.index ?? this.nextIndex(true);
        if (i >= 0) this.playIndex(i, { mode: 'quick' });
      }
      return;
    }
    const pl = this.plan;
    if (pl && !pl.prerolled && !pl.noPreroll && ['blend', 'under', 'filter', 'crossfade'].includes(pl.style) && t >= pl.mixStart - 3 * (d.el.playbackRate || 1)) this.preroll(pl);
    if (pl && pl.aRate && Math.abs(pl.aRate - 1) > 0.001 && !pl.aRamped && t >= pl.mixStart - (pl.preroll || 4)) {
      pl.aRamped = true;
      this.rampRate(d, pl.aRate, Math.max(0.5, (pl.mixStart - t) / (d.el.playbackRate || 1)));
    }
    if (this.plan && !this.planTimer) {
      const dt = (this.plan.mixStart - t) / (d.el.playbackRate || 1);
      if (dt <= 1.2) this.planTimer = setTimeout(() => this.runPlan(), Math.max(0, dt * 1000 - 12));
    }
    if (Math.floor(t) % 5 === 0) this.saveState();
  }

  // Self-healing: the screen must always match what you hear. If the audio is clearly running but we think
  // it's paused (or the other way round for 2s), fix the state, the controls and the lock screen.
  syncPlayState(d) {
    const ct = d.el.currentTime;
    const moving = (!d.el.paused && ct > (this._lastCt ?? -1) + 0.05) || (!d.el.paused && this.audible());
    this._lastCt = ct;
    if (this._pausing || d.switching || this.transition || d.el.seeking) { this._stuck = 0; return; }
    if (!this.playing && moving) {
      this.playing = true;
      this.emit('state');
      this.updateMediaSession();
      this.updatePosition();
      this._stuck = 0;
    } else if (this.playing && d.el.paused && !d.el.ended && !d.recovering && !this.audible()) {
      if ((this._stuck = (this._stuck || 0) + 1) >= 10) { // 10 ticks × 200 ms
        this._stuck = 0;
        this.playing = false;
        this.emit('state');
        this.updatePosition();
      }
    } else this._stuck = 0;
  }

  onAnalysis(id) {
    if (this.track?.id === id) { this.applyDeckGain(this.cur, true); if (this.upcoming) this.computePlan(); }
    if (this.upcoming?.track.id === id) { this.applyDeckGain(this.other); this.computePlan(); }
    this.emit('analysis', id);
  }
  onSetting(k) {
    if (['eqOn', 'limiter'].includes(k)) { this.rewire(); this.decks.forEach((d) => this.applyDeckGain(d, true)); }
    if (['eqPreset', 'eqBands', 'eqOn'].includes(k)) this.applyEq();
    if (k === 'mono') this.applyMono();
    if (k === 'lockButtons' || k === 'seekStep') this.applyLockButtons();
    if (['leveling', 'levelPreamp', 'autoLevel', 'limiter', '*'].includes(k)) this.decks.forEach((d) => d.track && this.applyDeckGain(d, true));
    if (k === 'djStyle' && this.upcoming && settings.get('djStyle') !== 'beats') {
      const t = this.upcoming.track;
      Promise.all([getLyrics(this.cur.track), getLyrics(t)]).then(() => { if (this.upcoming?.track === t) this.computePlan(); });
    }
    if (['transition', 'crossfadeSec', 'fadeCurve', 'gaplessAlbums', 'skipSilence', 'beatMatch', 'tempoMatch', 'tempoMatchMax', 'djStyle', 'cookLevel', 'harmonicMix', 'djEffects', '*'].includes(k)) {
      if (this.upcoming) this.computePlan();
      clearTimeout(this.planTimer); this.planTimer = null;
      if (this.track && this.wantsAnalysis()) analyze(this.track);
    }
  }

  setSleep(v) {
    this.sleepAt = 0; this.sleepEndOfTrack = false;
    if (v === 'track') { this.sleepEndOfTrack = true; this.invalidateNext(); }
    else if (v) this.sleepAt = Date.now() + v * 60000;
    this.emit('sleep-set');
  }

  // ---------- media session ----------
  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = this.track;
    if (!t) return;
    const abs = (u) => new URL(u, location.href).href;
    const meta = (artwork) => new MediaMetadata({ title: t.title || 'Unknown song', artist: t.artist || '', album: t.album || '', artwork });
    const cached = this._lockArt?.id === t.artId ? this._lockArt.art : null;
    const direct = t.artId
      ? [512, 1024].map((sz) => ({ src: abs(artUrl(t.artId, sz)), sizes: `${sz}x${sz}`, type: 'image/jpeg' }))
      : [{ src: abs('./icons/icon-512.png'), sizes: '512x512', type: 'image/png' }];
    navigator.mediaSession.metadata = meta(cached || direct);
    if (t.artId && !cached) {
      lockScreenArtwork(t.artId).then((art) => {
        if (!art || this.track !== t) return;
        this._lockArt = { id: t.artId, art };
        navigator.mediaSession.metadata = meta(art);
      });
    }
    document.title = `${t.title} · ${t.artist}`;
    if (!this._msWired) {
      this._msWired = true;
      const ms = navigator.mediaSession;
      const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
      set('play', () => this.play());
      set('pause', () => this.pause());
      set('stop', () => this.pause());
      set('seekto', (e) => this.seek(e.seekTime));
      this.applyLockButtons();
    }
    this.updatePosition();
  }
  // Lock screen / CarPlay / headphones: skip songs (default) or jump back/forward inside the song
  applyLockButtons() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
    const step = settings.get('seekStep') || 15;
    if (settings.get('lockButtons') === 'seek') {
      set('previoustrack', null); set('nexttrack', null);
      set('seekbackward', (e) => this.seek(this.currentTime - (e.seekOffset || step)));
      set('seekforward', (e) => this.seek(this.currentTime + (e.seekOffset || step)));
    } else {
      set('seekbackward', null); set('seekforward', null);
      set('previoustrack', () => this.prev());
      set('nexttrack', () => this.next());
    }
  }
  // After one element stops, tell the OS again that we're playing, with the exact position & speed
  reassertNowPlaying() {
    for (const ms of [60, 400, 1200]) setTimeout(() => { if (this.track) { this.updateMediaSession(); } }, ms);
  }
  updatePosition() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    const dur = this.duration;
    if (dur && navigator.mediaSession.setPositionState) {
      try {
        navigator.mediaSession.setPositionState({ duration: dur, position: clamp(this.currentTime, 0, dur), playbackRate: this.cur.el.playbackRate || 1 });
      } catch (e) { /* */ }
    }
  }

  // ---------- persistence ----------
  saveNow() {
    return db.kv.set('state', {
      queue: this.queue, index: this.index, pos: this.currentTime, shuffle: this.shuffle, repeat: this.repeat,
      origQueue: this.origQueue, context: this.context,
    });
  }
  debouncedSave() {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => this.saveNow(), 400);
    };
  }
  async restore() {
    const v = await db.kv.get('volume');
    if (typeof v === 'number') this.volume = v;
    if (!settings.get('resumeSession')) return;
    const s = await db.kv.get('state');
    if (!s || !s.queue?.length) return;
    this.queue = s.queue.filter((id) => library.track(id));
    if (!this.queue.length) return;
    this.index = clamp(this.queue.indexOf(s.queue[s.index]), 0, this.queue.length - 1);
    this.shuffle = !!s.shuffle;
    this.repeat = s.repeat || 'off';
    this.origQueue = s.origQueue;
    this.context = s.context;
    const t = library.track(this.queue[this.index]);
    this.loadDeck(this.cur, t, s.pos || 0);
    this.applyDeckGain(this.cur);
    this.emit('track', t);
    this.emit('queue');
    this.emit('state');
    this.updateMediaSession();
  }
}

export const engine = new Engine();
