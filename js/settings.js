import { kv } from './db.js';
import { Emitter } from './util.js';

export const DEFAULTS = {
  // Playback
  transition: 'smart',        // 'off' | 'crossfade' | 'smart' (DJ Mix)
  crossfadeSec: 8,
  djEffects: true,            // bass swaps, filter sweeps, echo outs in DJ Mix
  djStyle: 'beats',           // 'beats' | 'auto' | 'wordplay' (DJ Cook It Up is its own mode)
  djPrevStyle: 'beats',
  cookLevel: 'smooth',        // DJ Cook It Up: 'smooth' | 'hype' | 'wild'
  harmonicMix: true,          // use musical key (Camelot) to choose blend length
  onlineLyrics: true,         // look up lyrics by title + artist (LRCLIB)
  fadeCurve: 'equalpower',    // 'equalpower' | 'linear' | 'scurve'
  gaplessAlbums: true,        // never crossfade consecutive album tracks
  skipSilence: true,          // trim leading/trailing silence
  beatMatch: true,            // align mixes to the beat when BPMs are known
  tempoMatch: true,           // nudge incoming tempo during the mix
  tempoMatchMax: 5,           // percent: the most a song is sped up / slowed down to match (beyond that: a different kind of mix)
  sv: 7,                      // settings schema version
  bpmDetect: 'auto',          // 'off' | 'manual' | 'auto'
  preferBpmTag: true,
  onlineBpm: true,
  cloudSync: true,            // keep this Player account on your Plex (and GitHub) for your other devices
  cloudStats: false,          // also combine listening stats from all devices
  pulseMode: 'both',          // cover pulse: 'bpm' grid | 'beat' real kick drum | 'both'
  pulseAmount: 'normal',      // 'subtle' | 'normal' | 'strong'
  editionAudio: true,         // compare clean/explicit versions by ear            // look tempos up online (Deezer) once and keep them
  analysisNetwork: 'any',     // 'any' | 'wifi'
  skipFade: false,            // quick crossfade when you press next/prev (off = instant cut)
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
  explicitPref: 'explicit',   // 'explicit' | 'clean' | 'both' — which edition to show when an album has both
  albumSort: 'added',         // 'title' | 'artist' | 'year' | 'added'
  scanOnLaunch: true,
  // Appearance
  theme: 'dark',              // 'dark' | 'light' | 'auto' | 'oled'
  accent: 'dynamic',          // 'dynamic' or a hex color
  npBackground: 'animated',   // 'animated' | 'static' | 'plain'
  gridCols: 2,
  showBadges: true,
  showBpmRows: true,
  showBpm: true,
  showNextTransition: true,
  haptics: true,
  dualScreen: 'auto',         // 'auto' (split at hinge) | 'span' (across hinge) | 'off'
  dualShift: 0,               // px nudge of the split
  dualHinge: -1,              // px hinge width override (-1 = automatic)
  artShrinkOnPause: true,
  // Data
  prefetch: 'any',            // 'any' | 'wifi' | 'off'
  // Plex
  plexReport: true,           // scrobble plays + show "now playing" in Plex
  plexSyncOnLaunch: true,
  // Extras
  reactiveArt: true,          // artwork glows with the bass
  artSwipe: true,             // swipe the artwork to skip
  visualizer: 'bars',         // 'bars' | 'off'
  waveform: true,             // waveform scrubber with DJ markers
  dualSwap: false,            // put the player on the left/top when unfolded
  doubleTapSeek: true, // double-tap the left/right of the artwork to jump back/forward
  seekStep: 15, // seconds
  lockButtons: 'tracks', // 'tracks' | 'seek' — lock screen / CarPlay / headphone buttons
  keepAwake: false, // keep the screen on while the player is open
  autoLyrics: false, // open the player in lyrics view when a song has synced lyrics
  carButton: true, // show the Car Mode button in the player menu
  smartResume: true, // rewind a couple of seconds after a long pause
  miniPrev: true, // back button in the mini player
  carLyrics: true, // live lyrics in Car Mode
  friendNotify: false, // notifications for messages while the app runs in the background
  friendsShareNp: false, // let friends see what you're listening to
  friendRelay: 'https://ntfy.sh', // message relay (ntfy) — can be your own
  dropAlign: true, // time blends so the next song's drop lands as the old one leaves
  vocalStrip: true, // if two vocals would still overlap, blend only the outgoing song's music & beat
  vocalAware: true, // DJ blends avoid two vocals singing at once (uses synced lyrics)
  layoutMode: 'auto', // 'auto' | 'desktop' | 'mobile'
  deskWidth: 'auto', // computer: content width ('auto' = album grids use the width, text pages stay readable)
  deskFrame: 'full', // computer: 'full' | 'centered' (ultrawide: app in a centered 2560 px frame)
  deskPlayerW: 'normal', // computer: player column width
  deskSidebar: true, // computer: sidebar navigation
  rowSwipe: true, // swipe a song right to queue it, left to add it to a playlist
  likeBurst: true, // little burst animation when you like a song
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
    if (!saved.sv || saved.sv < 2) {
      // v1.4: wider tempo sync + longer default mixes
      saved.tempoMatchMax = Math.max(saved.tempoMatchMax || 0, 12);
      saved.crossfadeSec = Math.max(saved.crossfadeSec || 0, 8);
      saved.sv = 2;
    }
    if (saved.sv < 3) { saved.djStyle = 'beats'; saved.sv = 3; } // v1.7: beat match is the default DJ style
    if (saved.sv < 4) { saved.skipFade = false; saved.sv = 4; } // v1.11: skipping is an instant cut
    if (saved.sv < 5) { if (saved.deskWidth === 'comfortable') saved.deskWidth = 'auto'; saved.sv = 5; }
    if (saved.sv < 6) { if (!saved.tempoMatchMax || saved.tempoMatchMax >= 12) saved.tempoMatchMax = 5; saved.sv = 6; } // v1.17.1: subtler tempo changes
    if (saved.sv < 7) { if (saved.djStyle === 'cook') saved.djStyle = saved.djPrevStyle && saved.djPrevStyle !== 'cook' ? saved.djPrevStyle : 'beats'; saved.sv = 7; } // v1.22.1: Cook It Up is its own mode, not a DJ style
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
  save() { return kv.set('settings', this.v); }
  reset() {
    this.v = { ...DEFAULTS };
    kv.set('settings', this.v);
    this.emit('change', '*');
  }
}
export const settings = new Settings();
