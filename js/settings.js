import { kv } from './db.js';
import { Emitter } from './util.js';

export const DEFAULTS = {
  // Playback
  transition: 'smart',        // 'off' | 'crossfade' | 'smart'
  crossfadeSec: 6,
  fadeCurve: 'equalpower',    // 'equalpower' | 'linear' | 'scurve'
  gaplessAlbums: true,        // never crossfade consecutive album tracks
  skipSilence: true,          // trim leading/trailing silence
  beatMatch: true,            // align mixes to the beat when BPMs are known
  tempoMatch: true,           // nudge incoming tempo during the mix
  tempoMatchMax: 6,           // percent
  bpmDetect: 'auto',          // 'off' | 'manual' | 'auto'
  preferBpmTag: true,
  analysisNetwork: 'any',     // 'any' | 'wifi'
  skipFade: true,             // quick crossfade when you press next/prev
  skipFadeSec: 1.2,
  pauseFade: true,
  resumeSession: true,
  autoplay: true,             // keep playing similar music when the queue ends
  shuffleMode: 'random',      // 'random' | 'flow' (BPM flow)
  prevRestarts: 3,            // seconds; prev restarts the track after this many seconds
  // Sound
  engine: 'enhanced',         // 'enhanced' (Web Audio) | 'simple'
  leveling: 'smart',          // 'off' | 'track' | 'album' | 'smart'
  levelPreamp: 0,             // dB
  autoLevel: true,            // analysed loudness for untagged files
  limiter: true,
  mono: false,
  eqOn: false,
  eqPreset: 'flat',
  eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  showVolume: false,
  // Library
  artNames: 'cover,folder,front,album,albumart,artwork',
  ignoreFolders: '@eaDir,#recycle,.Trash,.AppleDouble,#snapshot',
  groupCompilations: true,
  albumSort: 'added',         // 'title' | 'artist' | 'year' | 'added'
  scanOnLaunch: true,
  // Appearance
  theme: 'dark',              // 'dark' | 'light' | 'auto' | 'oled'
  accent: 'dynamic',          // 'dynamic' or a hex color
  npBackground: 'animated',   // 'animated' | 'static' | 'plain'
  gridCols: 2,
  showBadges: true,
  showBpm: true,
  showNextTransition: true,
  haptics: true,
  dualScreen: 'auto',         // 'auto' | 'off'
  artShrinkOnPause: true,
  // Data
  prefetch: 'any',            // 'any' | 'wifi' | 'off'
  // Plex
  plexReport: true,           // scrobble plays + show "now playing" in Plex
  plexSyncOnLaunch: true,
  // Extras
  reactiveArt: true,          // artwork glows with the bass
  artSwipe: true,             // swipe the artwork to skip
};

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  loudness: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
  latenight: [3, 3, 2, 1, 0, 0, 1, 1, 0, -2],
  acoustic: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
  electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
  rock: [4, 3, 2, 1, -1, -1, 1, 2, 3, 4],
  hiphop: [5, 4, 2, 3, -1, -1, 1, 0, 1, 2],
  podcast: [-4, -2, 0, 2, 4, 4, 3, 1, -1, -3],
  custom: null,
};
export const EQ_NAMES = {
  flat: 'Flat', bass: 'Bass Booster', treble: 'Treble Booster', vocal: 'Vocal', loudness: 'Loudness',
  latenight: 'Late Night', acoustic: 'Acoustic', electronic: 'Electronic', rock: 'Rock', hiphop: 'Hip-Hop',
  podcast: 'Spoken Word', custom: 'Custom',
};

class Settings extends Emitter {
  constructor() { super(); this.v = { ...DEFAULTS }; }
  async load() {
    const saved = (await kv.get('settings')) || {};
    this.v = { ...DEFAULTS, ...saved };
  }
  get(k) { return this.v[k]; }
  set(k, val) {
    if (this.v[k] === val) return;
    this.v[k] = val;
    kv.set('settings', this.v);
    this.emit('change', k, val);
    this.emit(`change:${k}`, val);
  }
  reset() {
    this.v = { ...DEFAULTS };
    kv.set('settings', this.v);
    this.emit('change', '*');
  }
}
export const settings = new Settings();
