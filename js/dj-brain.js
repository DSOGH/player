// DJ brain — the part of the DJ that learns what YOU think is a good mix.
//
// Two tiny models (logistic regression, trained on the phone as you listen — no server, no credits,
// microseconds per decision):
//   pick: "will this song work as the next one?"   (tempo, key, energy, genre, how the songs sound…)
//   mix:  "will this way of mixing work?"           (where it leaves, where it comes in, how long, the effect…)
// Every mix is remembered with what it looked like; what you do next is the answer:
//   👍 / 👎 on the mix, skipping during or right after it, letting the next song play, liking it.
// The models start neutral (the DJ's built-in rules decide) and take over more as they learn.
import { settings } from './settings.js';
import { dlog } from './diag.js';

const KEY = 'djBrain';
const LR = 0.12, L2 = 0.002;
const sig = (x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

const fresh = () => ({ v: 1, pick: { w: {}, n: 0 }, mix: { w: {}, n: 0 }, rated: 0, at: 0 });
function load() {
  const m = settings.get(KEY);
  return m && m.v === 1 ? JSON.parse(JSON.stringify(m)) : fresh();
}

class Brain {
  constructor() {
    this._m = null; this._src = undefined;
    this.pending = null; // the mix that just happened, waiting for your verdict
    this._saveT = null;
  }
  // what it has learned: read from the profile's settings whenever those change (they load a moment
  // after start, and change when you switch profile or restore from the cloud)
  get m() {
    const cur = settings.get(KEY);
    if (!this._m || (cur !== this._src && !this._saveT)) { this._m = load(); this._src = cur; }
    return this._m;
  }
  set m(v) { this._m = v; }
  // how sure the model may be: it only steers once it has seen enough mixes
  conf(head) { const n = this.m[head].n; return n / (n + 12); }
  predict(head, f) {
    const w = this.m[head].w;
    let z = w.bias || 0;
    for (const k in f) if (f[k]) z += (w[k] || 0) * f[k];
    return sig(z);
  }
  // a score to ADD to the DJ's own score (higher = better), scaled by how much it has learned
  bonus(head, f, scale = 3) {
    if (settings.get('djLearn') === false) return 0;
    const c = this.conf(head);
    return c ? (this.predict(head, f) - 0.5) * 2 * scale * c : 0;
  }
  learn(head, f, y, weight = 1) {
    const M = this.m[head], w = M.w;
    const err = (y - this.predict(head, f)) * weight;
    w.bias = (w.bias || 0) + LR * err;
    for (const k in f) {
      const x = f[k];
      if (!x) continue;
      w[k] = (w[k] || 0) * (1 - LR * L2) + LR * err * x;
    }
    M.n += weight;
    this.save();
  }
  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      this._saveT = null;
      this._m.at = Date.now();
      const copy = JSON.parse(JSON.stringify(this._m)); // (a new object, or settings wouldn't store it)
      this._src = copy;
      settings.set(KEY, copy);
    }, 1500);
  }
  reset() { this._m = { ...fresh(), at: Date.now() }; const copy = JSON.parse(JSON.stringify(this._m)); this._src = copy; settings.set(KEY, copy); }
  get learnedFrom() { return Math.round(this.m.mix.n); }

  // ---- the life of a mix ----
  // a mix just started: remember what it looked like
  mixStarted({ from, to, pickF, mixF, label }) {
    this.settle(); // (anything still waiting gets its quiet verdict first)
    this.pending = { from, to, pickF: pickF || {}, mixF: mixF || {}, label, at: Date.now(), done: false };
  }
  // what happened next
  rate(good, how) {
    const p = this.pending;
    if (!p || p.done) return false;
    p.done = true;
    const w = { thumb: 2.5, 'skip-during': 2, 'skip-soon': 1.5, 'skip-later': 0.6, like: 1, played: 1 }[how] || 1;
    this.learn('mix', p.mixF, good ? 1 : 0, w);
    // a skip a while into the song is about the song, not the mix: it mostly teaches the picker
    this.learn('pick', p.pickF, good ? 1 : 0, how === 'skip-during' ? w * 0.5 : w);
    if (how === 'thumb') this.m.rated++;
    dlog('dj-learned', { from: p.from, to: p.to, good, how, mixes: Math.round(this.m.mix.n) });
    return true;
  }
  // the next song played on without complaint: a quiet "that was fine"
  settle() { if (this.pending && !this.pending.done) this.rate(true, 'played'); }
  // features of a candidate next song (all roughly -1…1)
  pickFeatures({ tempoGap, keyFit, energyGap, energyDrop, sameGenre, nearGenre, yearGap, sameArtist, liked, plays, skips, soundSim, partyGap, danceGap, moodGap, voiceGap, level }) {
    const f = {
      tempoClose: tempoGap != null ? 1 - Math.min(1, tempoGap / 0.08) : 0,
      tempoFar: tempoGap != null && tempoGap > 0.08 ? 1 : 0,
      keyFit: keyFit ?? 0, keyClash: keyFit != null && keyFit < 0.6 ? 1 : 0,
      energyClose: energyGap != null ? 1 - Math.min(1, Math.abs(energyGap) / 20) : 0,
      energyUp: energyGap != null && energyGap > 4 ? Math.min(1, energyGap / 20) : 0,
      energyDrop: energyDrop ? Math.min(1, energyDrop / 20) : 0,
      sameGenre: sameGenre ? 1 : 0, nearGenre: nearGenre ? 1 : 0,
      eraFar: yearGap != null && yearGap > 10 ? 1 : 0,
      sameArtist: sameArtist ? 1 : 0, liked: liked ? 1 : 0,
      plays: plays ? Math.min(1, Math.log2(1 + plays) / 5) : 0, skips: skips ? Math.min(1, skips / 4) : 0,
      soundSim: soundSim != null ? (soundSim - 0.75) * 4 : 0,
      partyGap: partyGap != null ? Math.abs(partyGap) : 0, danceGap: danceGap != null ? Math.abs(danceGap) : 0,
      moodGap: moodGap != null ? Math.abs(moodGap) : 0, voiceGap: voiceGap != null ? Math.abs(voiceGap) : 0,
    };
    if (level) f['lvl_' + level] = 1;
    return f;
  }
  // features of a way of mixing
  mixFeatures({ energyGap, leaveStrong, enterSection, enterLand, enterIntro, exitFrac, beats, stretch, keyFit, kind, stems, keySafe, echo, level, club }) {
    const f = {
      mEnergyClose: energyGap != null ? 1 - Math.min(1, Math.abs(energyGap) / 20) : 0,
      mEnergyDrop: energyGap != null && energyGap < -6 ? Math.min(1, -energyGap / 20) : 0,
      leaveStrong: leaveStrong ? 1 : 0, enterSection: enterSection ? 1 : 0, enterLand: enterLand ? 1 : 0, enterIntro: enterIntro ? 1 : 0,
      exitEarly: exitFrac != null && exitFrac < 0.7 ? (0.7 - exitFrac) * 2 : 0,
      longBlend: beats ? Math.min(1, Math.max(0, (beats - 16) / 16)) : 0, shortBlend: beats && beats <= 16 ? 1 : 0,
      stretch: stretch ? Math.min(1, stretch / 0.08) : 0,
      mKeyFit: keyFit ?? 0,
      ['k_' + (kind || 'blend')]: 1,
      stems: stems ? 1 : 0, ['s_' + (stems || 'none')]: 1, keySafe: keySafe ? 1 : 0, echo: echo ? 1 : 0, club: club ? 1 : 0,
    };
    if (level) f['ml_' + level] = 1;
    return f;
  }
  // a learned lean for each kind of effect (Wild): multiplies how often it's chosen
  kindLean(kind) {
    if (settings.get('djLearn') === false) return 1;
    const w = this.m.mix.w['k_' + kind] || 0, c = this.conf('mix');
    return Math.exp(Math.max(-1.5, Math.min(1.5, w * c)));
  }
  // what it has learned so far, in words (for the booth)
  summary() {
    const w = this.m.mix.w, p = this.m.pick.w, n = Math.round(this.m.mix.n);
    if (n < 3) return null;
    const names = {
      tempoClose: 'tight tempo matches', keyFit: 'songs in key', soundSim: 'songs that sound alike', energyUp: 'the energy climbing',
      energyDrop: 'energy drops', sameGenre: 'staying in one genre', enterSection: 'coming in on a chorus / drop', enterIntro: 'starting from intros',
      exitEarly: 'leaving songs early', longBlend: 'long blends', shortBlend: 'quick blends', stems: 'voices handed over', k_cut: 'clean cuts',
      k_roll: 'loop rolls', k_brake: 'brakes', k_backspin: 'spin-backs', k_dub: 'echo outs', k_riser: 'risers', k_washout: 'filter washes', echo: 'echo throws',
    };
    const all = Object.entries({ ...p, ...w }).filter(([k]) => names[k]).sort((a, b) => b[1] - a[1]);
    const likes = all.filter(([, v]) => v > 0.25).slice(0, 2).map(([k]) => names[k]);
    const dislikes = all.filter(([, v]) => v < -0.25).slice(-2).map(([k]) => names[k]);
    return { n, likes, dislikes };
  }
}
export const brain = new Brain();
