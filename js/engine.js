// Playback engine: two decks (audio elements) routed through Web Audio for sample-accurate fades,
// ReplayGain/auto leveling, EQ and a limiter. Handles gapless, crossfade and "smart" transitions
// (silence trimming, fade-aware overlaps, album awareness, beat-matched + tempo-matched mixing).
import { settings, EQ_FREQS, EQ_PRESETS } from './settings.js';
import { library } from './library.js';
import { analyze, prefetchTrack, trackSrc } from './analysis.js';
import { Emitter, shuffleArr, clamp } from './util.js';
import * as db from './db.js';
import { artUrl } from './art.js';
import { findCue, titleEntry, keyCompat } from './dj.js';
import { getLyrics } from './lyrics.js';

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 0.1s of silence, used to unlock audio elements inside a tap (iOS only lets elements started by a tap play later on their own)
const SILENT = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

const dbToLin = (db) => Math.pow(10, db / 20);

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
    this.make(false);
  }
  // raw = plain element without CORS (works with any Plex server, but no Web Audio effects)
  make(raw) {
    const el = new Audio();
    if (!raw) el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.preservesPitch = true;
    el.setAttribute('playsinline', '');
    this.el = el;
    this.raw = raw;
    this.node = null;
    this.unlocked = false;
  }
  load(track, startAt = 0) {
    this.token++;
    this.switching = true;
    setTimeout(() => { this.switching = false; }, 60);
    this.track = track;
    clearInterval(this.rateTimer);
    this.el.playbackRate = 1;
    this.el.defaultPlaybackRate = 1;
    this.el.src = trackSrc(track) + (startAt > 0.05 ? `#t=${startAt.toFixed(3)}` : '');
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
    this.saveState = this.debouncedSave();
  }

  get cur() { return this.decks[this.ai]; }
  get other() { return this.decks[1 - this.ai]; }
  get track() { return this.cur.track; }
  get enhanced() { return !!this.ctx; }
  get currentTime() { return this.cur.el.currentTime || 0; }
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
      for (const d of this.decks) if (!d.raw) this.attachNodes(d);
      this.rewire();
      this.applyEq();
      this.applyMono();
      this.volNode.gain.value = this.volume * this.volume;
      for (const d of this.decks) { d.el.volume = d.node ? 1 : d.el.volume; if (d.track) this.applyDeckGain(d); }
      ctx.addEventListener?.('statechange', () => this.emit('state'));
    } catch (e) {
      console.warn('Web Audio unavailable, using simple engine', e);
      this.ctx = null;
    }
  }
  attachNodes(d) {
    const ctx = this.ctx;
    if (!ctx || d.node || d.raw) return;
    d.node = ctx.createMediaElementSource(d.el);
    d.rg = ctx.createGain();
    d.bass = ctx.createBiquadFilter(); d.bass.type = 'lowshelf'; d.bass.frequency.value = 180; d.bass.gain.value = 0;
    d.hp = ctx.createBiquadFilter(); d.hp.type = 'highpass'; d.hp.frequency.value = HP_OFF; d.hp.Q.value = 0.7;
    d.lp = ctx.createBiquadFilter(); d.lp.type = 'lowpass'; d.lp.frequency.value = LP_OFF; d.lp.Q.value = 0.7;
    d.fade = ctx.createGain();
    d.send = ctx.createGain(); d.send.gain.value = 0;
    d.node.connect(d.rg).connect(d.bass).connect(d.hp).connect(d.lp).connect(d.fade).connect(this.input);
    d.fade.connect(d.send).connect(this.echoIn);
  }
  detachNodes(d) {
    for (const n of ['node', 'rg', 'bass', 'hp', 'lp', 'fade', 'send']) { try { d[n]?.disconnect(); } catch (e) { /* */ } d[n] = null; }
  }
  // Swap a deck's <audio> element when it needs to change between Web Audio (CORS) and raw mode.
  prepareDeck(d, track) {
    const raw = settings.get('engine') !== 'enhanced' || !!(track?.plex && this.plexNoCors);
    if (d.raw === raw) return;
    try { d.el.pause(); d.el.removeAttribute('src'); d.el.load(); } catch (e) { /* */ }
    this.detachNodes(d);
    d.make(raw);
    this.wireDeck(d);
    if (!raw && this.ctx) this.attachNodes(d);
    d.el.volume = d.node ? 1 : clamp(d.rgLin * d.fadeVal * this.volume, 0, 1);
  }
  loadDeck(d, track, startAt = 0) {
    this.prepareDeck(d, track);
    this.resetFx(d);
    d.load(track, startAt);
  }
  resetFx(d) {
    if (!d.node || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const [p, v] of [[d.bass.gain, 0], [d.hp.frequency, HP_OFF], [d.lp.frequency, LP_OFF], [d.send.gain, 0]]) {
      p.cancelScheduledValues(0);
      p.setValueAtTime(v, now);
    }
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
    if (d.node) {
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
    this.decks.forEach((d) => { if (!d.node) this.applySimpleVolume(d); });
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
    if (d.node) {
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
    if (d.node) {
      const g = d.fade.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(0);
      g.setValueAtTime(v, now);
      g.value = v;
    } else { d.fadeVal = v; this.applySimpleVolume(d); }
  }
  rampRate(d, to, sec) {
    clearInterval(d.rateTimer);
    const from = d.el.playbackRate;
    if (Math.abs(from - to) < 0.001) return;
    const t0 = performance.now();
    d.rateTimer = setInterval(() => {
      const x = Math.min(1, (performance.now() - t0) / (sec * 1000));
      d.el.playbackRate = from + (to - from) * (x * x * (3 - 2 * x));
      if (x >= 1) clearInterval(d.rateTimer);
    }, 100);
  }

  // ---------- deck events ----------
  wireDeck(d) {
    const el = d.el;
    el.addEventListener('ended', () => {
      if (el !== d.el || d !== this.cur || this.transition) return;
      this.onEnded();
    });
    el.addEventListener('error', () => {
      if (el !== d.el || !d.track) return;
      const t = d.track;
      // Plex server didn't allow cross-origin audio for Web Audio → switch to plain playback and retry
      if (t.plex && !d.raw && !this.plexNoCors && el.error && el.error.code !== 1) {
        console.warn('Plex audio blocked by CORS; falling back to direct playback');
        this.plexNoCors = true;
        const wasCur = d === this.cur;
        const pos = d.wantStart || 0;
        this.loadDeck(d, t, pos);
        this.applyDeckGain(d);
        if (wasCur) { this.setFade(d, 1); if (this.playing) d.el.play().catch(() => {}); }
        else this.setFade(d, 0);
        this.emit('fallback');
        return;
      }
      if (d !== this.cur) return;
      this.errors++;
      this.emit('error', t, el.error);
      if (this.errors <= 4 && this.index + 1 < this.queue.length) setTimeout(() => this.playIndex(this.index + 1, { mode: 'cut' }), 1200);
      else { this.playing = false; this.emit('state'); }
    });
    el.addEventListener('playing', () => {
      if (el !== d.el || d !== this.cur) return;
      this.errors = 0;
      this.emit('buffering', false);
      // iOS/CarPlay take "Now Playing" from whichever element just started: re-send the song info
      this.updateMediaSession();
    });
    el.addEventListener('waiting', () => { if (el === d.el && d === this.cur) this.emit('buffering', true); });
    el.addEventListener('pause', () => {
      // paused by the OS (another app took audio focus, headphones unplugged...)
      if (el === d.el && d === this.cur && this.playing && !this.transition && !this._pausing && !d.switching && !el.ended && d.track) {
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
  playTracks(tracks, start = 0, { context = null, shuffle = null } = {}) {
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
    for (const d of this.decks) {
      if (d.unlocked) continue;
      d.unlocked = true;
      if (d.track) continue; // the playing deck unlocks itself
      const el = d.el;
      try {
        el.src = SILENT;
        const p = el.play();
        p?.then(() => { if (!d.track && el.src === SILENT) { el.pause(); el.removeAttribute('src'); el.load(); } }).catch((e) => { if (e.name === 'NotAllowedError') d.unlocked = false; });
      } catch (e) { d.unlocked = false; }
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
    if (settings.get('pauseFade') && this.ctx) { this.setFade(d, 0); this.fade(d, 1, 0.25, { shape: 'equalpower' }); }
    else this.setFade(d, 1);
    try { await d.el.play(); } catch (e) { if (e.name !== 'AbortError') { this.playing = false; this.emit('error', d.track, e); } }
    if (this.transition) { try { await this.transition.from.el.play(); } catch (e) { /* */ } }
    this.emit('state');
    this.updatePosition();
  }
  async pause() {
    this.playing = false;
    this.emit('state');
    const ds = [this.cur, this.transition?.from].filter(Boolean);
    clearTimeout(this.planTimer); this.planTimer = null;
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
    const i = this.index + 1 < this.queue.length ? this.index + 1 : this.nextIndex(false);
    if (i < 0) {
      // end of the queue: stop at the start of the last track
      this.pause(); this.seek(0); return;
    }
    this.playIndex(i, { mode: this.playing && settings.get('skipFade') ? 'quick' : 'cut' });
  }
  prev() {
    if (this.currentTime > settings.get('prevRestarts') || this.index <= 0) { this.seek(0); return; }
    this.playIndex(this.index - 1, { mode: this.playing && settings.get('skipFade') ? 'quick' : 'cut' });
  }
  seek(t) {
    this.finishTransition();
    const d = this.cur;
    if (!d.track) return;
    try { d.el.currentTime = clamp(t, 0, Math.max(0, this.duration - 0.25)); } catch (e) { /* */ }
    clearTimeout(this.planTimer); this.planTimer = null;
    this.emit('time');
    this.updatePosition();
    this.saveState();
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
    if (mode === 'quick' && old.track && !old.el.paused) {
      const dur = settings.get('skipFadeSec');
      this.ai = 1 - this.ai;
      const d = this.cur;
      this.loadDeck(d, t, startAt);
      this.applyDeckGain(d);
      this.setFade(d, 0);
      this.playing = true;
      d.el.play().catch((e) => { if (e.name !== 'AbortError') this.emit('error', t, e); });
      this.fade(d, 1, dur * 0.8);
      this.fade(old, 0, dur);
      const tok = old.token;
      setTimeout(() => { if (old.token === tok && old !== this.cur) old.unload(); }, dur * 1000 + 80);
    } else {
      this.other.unload();
      this.loadDeck(old, t, startAt);
      this.applyDeckGain(old);
      this.setFade(old, 1);
      if (autoplay) {
        this.playing = true;
        old.el.play().catch((e) => {
          if (e.name === 'NotAllowedError') { this.playing = false; this.emit('state'); }
          else if (e.name !== 'AbortError') this.emit('error', t, e);
        });
      } else this.playing = false;
    }
    this.afterTrackChange();
  }

  afterTrackChange(transitionPlan = null) {
    const t = this.track;
    this.emit('track', t, transitionPlan);
    this.emit('state');
    this.emit('queue');
    this.updateMediaSession();
    this.saveState();
    if (this.sleepEndOfTrack && transitionPlan) { /* handled in prepare */ }
    // analyse the current track (for its outro + loudness) and warm up the next one
    if (t && this.wantsAnalysis()) analyze(t);
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
  cancelNext() {
    clearTimeout(this.planTimer); this.planTimer = null;
    this.plan = null;
    if (this.upcoming && !this.transition) this.other.unload();
    this.upcoming = null;
    this.emit('plan', null);
  }
  invalidateNext() { if (!this.transition) this.cancelNext(); }

  prepareNext() {
    if (this.upcoming || this.transition || this.sleepEndOfTrack) return;
    const i = this.nextIndex(true);
    if (i < 0) return;
    const t = library.track(this.queue[i]);
    if (!t) return;
    this.upcoming = { index: i, track: t };
    this.computePlan();
    const d = this.other;
    this.loadDeck(d, t, this.plan?.bStart || 0);
    this.applyDeckGain(d);
    this.setFade(d, 0);
    if (this.wantsAnalysis()) analyze(t).then(() => this.computePlan());
    else prefetchTrack(t);
    const st = settings.v;
    if (st.transition === 'smart' && (st.djStyle || 'auto') !== 'beats') {
      Promise.all([getLyrics(this.cur.track), getLyrics(t)]).then(() => { if (this.upcoming?.track === t) this.computePlan(); });
    }
  }

  computePlan() {
    if (!this.upcoming || this.transition) return;
    const A = this.cur.track, B = this.upcoming.track;
    if (!A || !B) return;
    const p = this.makePlan(A, B, this.durationOf(this.cur));
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
    if (cont && s.gaplessAlbums) return gapless('Gapless · same album');
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
    // 0) word play: the outgoing song sings the next song's title → echo that line out and drop the next song on its own title
    if (djStyle !== 'beats') {
      const cue = findCue(A, B);
      if (cue && cue.end < end - 0.5) {
        const lead = clamp(cue.end - cue.t, 1.2, 6);
        const entry = titleEntry(B);
        const beatA = bpmA ? 60 / bpmA : 0.5;
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
    if (s.beatMatch && ratio && Math.abs(ratio - 1) <= tol && end > 30) {
      const beat = 60 / bpmA, bar = beat * 4;
      let beats = clamp(Math.round(Math.max(D * 1.6, 8 * beat) / beat / 8) * 8, 8, kc >= 0.85 ? 32 : kc < 0.5 ? 8 : 16);
      while (beats > 8 && beats * beat > Math.min(dur * 0.35, durB * 0.4, 24)) beats -= 8;
      const overlap = beats * beat;
      // finish the blend as the outgoing song's outro begins (or at its end)
      const mixEnd = outroLen > 4 ? Math.min(end, aA.fadeOutStart + outroLen * 0.5) : end;
      const off = aA.beatOffset || 0;
      let ms = off + Math.floor((mixEnd - overlap - off) / bar) * bar;
      if (ms > 1) {
        const rate = s.tempoMatch ? ratio : 1;
        return {
          ...base, type: 'beatmatch', style: 'blend', fx,
          label: `Beat match · ${Math.round(bpmA)} BPM${aA.camelot && aB.camelot ? ` · ${aA.camelot}→${aB.camelot}` : ''}${kc >= 0.85 ? ' · harmonic' : kc < 0.5 ? ' · quick (key clash)' : ''}`,
          mixStart: ms, overlap, inDur: overlap * 0.5, outDur: overlap * 0.62, outDelay: overlap * 0.38,
          bStart: aB.beatOffset || bStart, rate, beat,
        };
      }
    }
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
  // automation helpers (Web Audio clock)
  hold(param, at) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(at); else { param.cancelScheduledValues(at); param.setValueAtTime(param.value, at); }
  }
  async runPlan() {
    this.planTimer = null;
    const p = this.plan, nx = this.upcoming;
    if (!p || !nx || this.transition || !this.playing) return;
    const A = this.cur, B = this.other;
    if (B.track !== nx.track) { this.loadDeck(B, nx.track, p.bStart); this.applyDeckGain(B); }
    else if (Math.abs(B.el.currentTime - p.bStart) > 0.08) { try { B.el.currentTime = p.bStart; } catch (e) { /* */ } }
    const useFx = p.fx && A.node && B.node && this.ctx;
    this.resetFx(B);
    this.setFade(B, p.style === 'gapless' ? 1 : 0);
    B.el.playbackRate = p.rate || 1;
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
    try { await B.el.play(); } catch (e) { if (e.name !== 'AbortError') { this.onEnded(); return; } }
    const t0 = this.ctx ? this.ctx.currentTime + 0.01 : 0;
    const D = p.overlap || p.outDelay + p.outDur;
    const sh = p.shape;
    switch (p.style) {
      case 'gapless':
        this.fade(A, 0, p.outDur, { shape: 'linear' });
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
          this.hold(A.hp.frequency, t0); A.hp.frequency.setValueAtTime(HP_OFF, t0 + D * 0.55); A.hp.frequency.exponentialRampToValueAtTime(380, t0 + D);
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
    this.notePlayed(A);
    const total = (p.style === 'echo' ? 4.2 : Math.max(p.outDelay + p.outDur, D)) * 1000;
    this.transition = { from: A, to: B, plan: p };
    this.ai = 1 - this.ai;
    this.index = nx.index;
    this.upcoming = null;
    this.plan = null;
    this.emit('plan', null);
    const tok = A.token;
    this.transitionTimer = setTimeout(() => { if (A.token === tok) this.finishTransition(); }, total + 120);
    if (Math.abs((p.rate || 1) - 1) > 0.001) {
      const tokB = B.token;
      setTimeout(() => { if (B.token === tokB) this.rampRate(B, 1, 10); }, D * 1000);
    }
    this.afterTrackChange(p);
  }
  finishTransition() {
    if (!this.transition) return;
    clearTimeout(this.transitionTimer);
    const { from, to } = this.transition;
    this.transition = null;
    if (from !== this.cur) { this.resetFx(from); from.unload(); }
    // make sure the new song ends up with clean filters even if the mix was interrupted
    if (to === this.cur && to.node && this.ctx) {
      const now = this.ctx.currentTime;
      for (const [prm, v] of [[to.bass.gain, 0], [to.hp.frequency, HP_OFF], [to.lp.frequency, LP_OFF]]) {
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
    this.emit('time');
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
    if (!this.upcoming && remaining < 90) this.prepareNext();
    if (this.plan && !this.planTimer) {
      const dt = (this.plan.mixStart - t) / (d.el.playbackRate || 1);
      if (dt <= 1.2) this.planTimer = setTimeout(() => this.runPlan(), Math.max(0, dt * 1000 - 12));
    }
    if (Math.floor(t) % 5 === 0) this.saveState();
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
    if (['leveling', 'levelPreamp', 'autoLevel', 'limiter', '*'].includes(k)) this.decks.forEach((d) => d.track && this.applyDeckGain(d, true));
    if (['transition', 'crossfadeSec', 'fadeCurve', 'gaplessAlbums', 'skipSilence', 'beatMatch', 'tempoMatch', 'tempoMatchMax', '*'].includes(k)) {
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
    const artwork = t.artId
      ? [256, 512, 640].map((sz) => ({ src: abs(artUrl(t.artId, sz)), sizes: `${sz}x${sz}`, type: 'image/jpeg' }))
      : [{ src: abs('./icons/icon-512.png'), sizes: '512x512', type: 'image/png' }];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || 'Unknown song', artist: t.artist || '', album: t.album || '', artwork,
    });
    document.title = `${t.title} · ${t.artist}`;
    if (!this._msWired) {
      this._msWired = true;
      const ms = navigator.mediaSession;
      const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* unsupported */ } };
      set('play', () => this.play());
      set('pause', () => this.pause());
      set('stop', () => this.pause());
      set('previoustrack', () => this.prev());
      set('nexttrack', () => this.next());
      set('seekto', (e) => this.seek(e.seekTime));
      set('seekbackward', (e) => this.seek(this.currentTime - (e.seekOffset || 10)));
      set('seekforward', (e) => this.seek(this.currentTime + (e.seekOffset || 10)));
    }
    this.updatePosition();
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
  debouncedSave() {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => {
        db.kv.set('state', {
          queue: this.queue, index: this.index, pos: this.currentTime, shuffle: this.shuffle, repeat: this.repeat,
          origQueue: this.origQueue, context: this.context,
        });
      }, 400);
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
