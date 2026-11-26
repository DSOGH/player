// Mini player + full-screen Now Playing (art, scrubber, controls, queue, synced lyrics)
import { html, raw, icon, fmtTime, $, clamp, nasUrl } from '../util.js';
import { engine } from '../engine.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { analyze } from '../analysis.js';
import { artColors, artUrl } from '../art.js';
import { art, badges, haptic, actionSheet, toast, formatLine, preloadArt, likeBurst } from './components.js';
import { getLyrics } from '../lyrics.js';
import { renderBooth, tickBooth } from './djbooth.js';

let mode = 'art'; // art | queue | lyrics
let open = false;
let dragging = false;
let lyrics = null; // { id, lines:[{t, text}], synced }
const lrcCache = new Map();
let hooks = {};

export function initNowPlaying(h) {
  hooks = h;
  const mini = $('#mini');
  mini.innerHTML = html`
    <div class="mini-progress"><i></i></div>
    <div class="mini-art"></div>
    <div class="mini-meta"><div class="mini-title">Not Playing</div><div class="mini-artist"></div></div>
    ${settings.get('miniPrev') ? html`<button class="icon-btn mini-prev" data-np="prev" aria-label="Previous">${icon('prev')}</button>` : ''}
    <button class="icon-btn mini-play" data-np="toggle" aria-label="Play">${icon('play')}</button>
    <button class="icon-btn mini-next" data-np="next" aria-label="Next">${icon('next')}</button>`;
  const np = $('#np');
  np.innerHTML = html`
    <div class="np-bg"><div class="np-bg-anim"><div class="np-bg-img"></div></div><div class="np-bg-tint"></div><canvas class="np-viz"></canvas></div>
    <div class="np-idle">
      <div class="np-idle-art">${icon('note')}</div>
      <b>Nothing playing</b><small>Pick something on the other side — or let the DJ take over.</small>
      <div class="np-idle-btns">
        <button class="btn pill primary" data-np="idle-cook">${icon('sparkle')}DJ Cook It Up</button>
        <button class="btn pill" data-np="idle-shuffle">${icon('shuffle')}Shuffle all</button>
      </div>
    </div>
    <div class="np-inner">
      <div class="np-top" data-drag>
        <button class="icon-btn np-collapse" data-np="close" aria-label="Close">${icon('down')}</button>
        <div class="np-context"><small>Playing from</small><b></b></div>
        <button class="icon-btn" data-np="menu" aria-label="More">${icon('more')}</button>
      </div>
      <div class="np-stage" data-drag>
        <div class="np-art-wrap"><div class="np-glow"></div><div class="np-art"></div></div>
        <div class="np-panel np-queue"></div>
        <div class="np-panel np-lyrics"></div>
        <div class="np-panel np-booth"></div>
      </div>
      <div class="np-info">
        <div class="np-mini-art"></div>
        <div class="np-titles"><div class="np-title"><span></span></div><div class="np-artist"></div></div>
        <button class="icon-btn np-like" data-np="like" aria-label="Like">${icon('heart')}</button>
      </div>
      <div class="np-scrub">
        <div class="scrub" data-scrub><div class="scrub-track"><div class="scrub-buf"></div><div class="scrub-fill"></div></div>
          <div class="wave-wrap"><canvas class="wave"></canvas><canvas class="wave played"></canvas><i class="wave-mix"></i><i class="wave-cue"></i></div>
          <div class="scrub-knob"></div></div>
        <div class="np-times"><span class="t-cur">0:00</span><span class="np-chips"></span><span class="t-rem">-0:00</span></div>
      </div>
      <div class="np-controls">
        <button class="icon-btn np-shuffle" data-np="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
        <button class="icon-btn np-prev big" data-np="prev" aria-label="Previous">${icon('prev')}</button>
        <button class="icon-btn np-play huge" data-np="toggle" aria-label="Play">${icon('play')}</button>
        <button class="icon-btn np-next big" data-np="next" aria-label="Next">${icon('next')}</button>
        <button class="icon-btn np-repeat" data-np="repeat" aria-label="Repeat">${icon('repeat')}</button>
      </div>
      <div class="np-volume">${icon('speaker-low')}<input type="range" min="0" max="1" step="0.01" class="vol" aria-label="Volume">${icon('speaker')}</div>
      <div class="np-bottom">
        <button class="icon-btn np-lyr" data-np="lyrics" aria-label="Lyrics">${icon('lyrics')}</button>
        <button class="icon-btn np-booth-btn" data-np="booth" aria-label="DJ Booth">${icon('bpm')}</button>
        <button class="np-mode" data-np="mode" aria-label="Transition mode"></button>
        <button class="icon-btn np-q" data-np="queue" aria-label="Queue">${icon('queue')}</button>
      </div>
      <div class="np-next-hint"></div>
    </div>`;

  mini.addEventListener('click', (e) => {
    const b = e.target.closest('[data-np]');
    if (b) { e.stopPropagation(); act(b.dataset.np); return; }
    openNP();
  });
  np.addEventListener('click', (e) => {
    const b = e.target.closest('[data-np]');
    if (b) act(b.dataset.np, b);
  });
  wireScrubber();
  wireDoubleTap();
  wireSwipe();
  wireMiniSwipe();
  startPulse();
  wireQueueDrag();
  const vol = np.querySelector('.vol');
  vol.value = engine.volume;
  vol.addEventListener('input', () => engine.setVolume(+vol.value));
  engine.on('volume', (v) => { vol.value = v; });

  engine.on('track', onTrack);
  engine.on('track', autoLyrics);
  engine.on('state', updateWake);
  document.addEventListener('visibilitychange', updateWake);
  settings.on('change', (k) => {
    if (k === 'keepAwake') updateWake();
    if (k === 'miniPrev') {
      const m = $('#mini'), b = m.querySelector('.mini-prev');
      if (settings.get('miniPrev') && !b) m.querySelector('.mini-play').insertAdjacentHTML('beforebegin', html`<button class="icon-btn mini-prev" data-np="prev" aria-label="Previous">${icon('prev')}</button>`.toString());
      else if (!settings.get('miniPrev') && b) b.remove();
    }
  });
  engine.on('state', renderState);
  engine.on('time', renderTime);
  engine.on('queue', () => { if (mode === 'queue') renderQueue(); });
  engine.on('plan', () => { preloadArt(engine.upcoming?.track?.artId, [200, 360, 640]); });
  engine.on('plan', () => { renderHint(); renderWaveMarks(); if (mode === 'booth') renderBooth($('#np .np-booth')); if (mode === 'lyrics' && lyrics) markCue(); });
  engine.on('queue', () => { if (mode === 'booth') renderBooth($('#np .np-booth')); });
  // a mix starting / finishing: the booth card and the "Next" line follow it live
  engine.on('transition', () => { renderHint(); if (mode === 'booth') renderBooth($('#np .np-booth')); });
  engine.on('analysis', (id) => {
    if (id === engine.track?.id) { renderChips(); drawWave(); }
    if (mode === 'booth') renderBooth($('#np .np-booth'));
  });
  settings.on('change:waveform', drawWave);
  engine.on('buffering', (b) => np.classList.toggle('buffering', b));
  library.on('likes', renderLike);
  settings.on('change', (k) => {
    if (['transition', '*'].includes(k)) renderMode();
    if (['showBadges', 'showBpm', '*'].includes(k)) renderChips();
    if (['showVolume', 'npBackground', 'artShrinkOnPause', '*'].includes(k)) applyPrefs();
    if (k === 'showNextTransition') renderHint();
  });
  applyPrefs();
  renderMode();
  renderState();
  window.addEventListener('popstate', () => { if (open && !location.hash.includes('np')) closeNP(true); });
}

function applyPrefs() {
  const np = $('#np');
  np.classList.toggle('show-vol', settings.get('showVolume'));
  np.dataset.bg = settings.get('npBackground');
  np.classList.toggle('shrink', settings.get('artShrinkOnPause'));
}

export function isOpen() { return open; }
export function openNP() {
  if (!engine.track) return;
  if (document.body.classList.contains('dual')) return;
  open = true;
  $('#np').classList.add('open');
  document.body.classList.add('np-open');
  setTimeout(updateWake, 0);
  history.pushState({ np: 1 }, '', (location.hash || '#/home').replace(/\?np$/, '') + '?np');
  haptic(6);
}
export function closeNP(fromPop = false) {
  if (!open) return;
  open = false;
  $('#np').classList.remove('open');
  document.body.classList.remove('np-open');
  setTimeout(updateWake, 0);
  $('#np').style.transform = '';
  if (!fromPop && location.hash.endsWith('?np')) history.back();
}

function setMode(m) {
  mode = mode === m ? 'art' : m;
  $('#np .np-stage').dataset.mode = mode;
  $('#np').dataset.mode = mode;
  $('#np .np-q').classList.toggle('on', mode === 'queue');
  $('#np .np-lyr').classList.toggle('on', mode === 'lyrics');
  $('#np .np-booth-btn').classList.toggle('on', mode === 'booth');
  if (mode === 'queue') renderQueue();
  if (mode === 'lyrics') renderLyrics();
  if (mode === 'booth') renderBooth($('#np .np-booth'));
}

async function act(a, el) {
  haptic();
  const t = engine.track;
  switch (a) {
    case 'toggle': engine.toggle(); break;
    case 'next': engine.next(); break;
    case 'prev': engine.prev(); break;
    case 'shuffle': engine.toggleShuffle(); toast(engine.shuffle ? (settings.get('shuffleMode') === 'flow' ? 'Shuffle on · BPM flow' : 'Shuffle on') : 'Shuffle off'); break;
    case 'repeat': engine.cycleRepeat(); toast({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[engine.repeat]); break;
    case 'close': closeNP(); break;
    case 'like': if (t) { const on = library.toggleLike(t.id); haptic(on ? 15 : 6); if (on && settings.get('likeBurst')) likeBurst(el); } break;
    case 'queue': setMode('queue'); break;
    case 'lyrics': setMode('lyrics'); break;
    case 'lyrics-retry': { const { forgetLyrics } = await import('../lyrics.js'); forgetLyrics(engine.track); renderLyrics(true); break; }
    case 'booth': setMode('booth'); break;
    case 'idle-cook': if (engine.cookItUp()) { haptic(20); toast('🔥 DJ Cook It Up'); } else toast('Add some music first'); break;
    case 'idle-shuffle': { const all = [...library.tracks.values()].filter((x) => library.visible(x)); if (all.length) engine.playTracks(all, -1, { shuffle: true, context: { type: 'library', name: 'All songs' } }); break; }
    case 'hear-mix': {
      // jump to just before the next mix (and plan it first if it isn't planned yet)
      if (engine.transition) break; // already mixing: you're hearing it
      if (!engine.plan) engine.prepareNext();
      const p = engine.plan;
      if (!p) { toast(engine.queue.length > engine.index + 1 ? 'Still working out the next mix — try again in a second' : 'Nothing is up next'); break; }
      const at = p.style === 'gapless' ? Math.max(0, engine.duration - 8) : Math.max(0, p.mixStart - 6);
      engine.hearMix(at); haptic(10);
      toast(p.style === 'gapless' ? 'Same album: these two play back-to-back (no mix)' : '6 seconds before the mix');
      break;
    }
    case 'dj-style': {
      const order = ['beats', 'auto', 'wordplay'];
      const nx = order[(order.indexOf(settings.get('djStyle')) + 1) % order.length];
      settings.set('djStyle', nx);
      toast({ auto: 'DJ style: Auto (word play when lyrics line up, else beat match)', beats: 'DJ style: Beat match', wordplay: 'DJ style: Word play' }[nx]);
      if (engine.upcoming) engine.computePlan();
      renderBooth($('#np .np-booth'));
      break;
    }
    case 'dj-prep': {
      const up = engine.upNext().slice(0, 6);
      toast(`Analyzing the next ${up.length} songs…`);
      const { getLyrics: gl } = await import('../lyrics.js');
      for (const x of up) { await analyze(x); await gl(x); if (mode === 'booth') renderBooth($('#np .np-booth')); }
      if (engine.upcoming) engine.computePlan();
      toast('Upcoming mixes planned');
      break;
    }
    case 'mode': {
      const order = ['smart', 'crossfade', 'off'];
      const nx = order[(order.indexOf(settings.get('transition')) + 1) % order.length];
      settings.set('transition', nx);
      toast({ smart: 'DJ Mix — beat-matched blends, filter sweeps & echo outs', crossfade: `Crossfade · ${settings.get('crossfadeSec')}s`, off: 'Gapless (no crossfade)' }[nx]);
      break;
    }
    case 'menu': npMenu(); break;
    case 'clear-queue': engine.clearUpNext(); break;
    case 'dj-order': hooks.djOrderQueue?.(); break;
    default:
      if (a.startsWith('jump:')) engine.jumpTo(+a.slice(5));
      else if (a.startsWith('rm:')) engine.removeAt(+a.slice(3));
      else if (a.startsWith('seek:')) engine.seek(+a.slice(5));
  }
}

async function npMenu() {
  const t = engine.track;
  if (!t) return;
  const an = library.analysis.get(t.id);
  const sleepLabel = engine.sleepAt ? `Sleep timer · ${Math.ceil((engine.sleepAt - Date.now()) / 60000)} min left` : engine.sleepEndOfTrack ? 'Sleep timer · end of song' : 'Sleep Timer';
  const v = await actionSheet({
    header: html`<div class="sheet-track">${art(t.artId, 'sm')}<div><b>${t.title}</b><span>${t.artist}</span></div></div>`,
    items: [
      { icon: 'album', label: 'Go to Album', value: 'album' },
      { icon: 'artist', label: 'Go to Artist', value: 'artist' },
      { icon: 'add-playlist', label: 'Add to Playlist…', value: 'playlist' },
      { icon: 'download', label: library.isOffline(t) ? 'Remove Download' : 'Download', value: 'download' },
      { sep: true },
      { icon: 'timer', label: sleepLabel, value: 'sleep' },
      { icon: 'bpm', label: an?.bpm ? `BPM · ${Math.round(library.bpmOf(t))} — re-detect` : 'Detect BPM', value: 'bpm' },
      { icon: 'tap', label: 'Tap Tempo…', value: 'tap' },
      { icon: 'eq', label: 'Equalizer', value: 'eq' },
      { icon: 'mix', label: 'Transitions…', value: 'transitions' },
      { icon: 'info', label: 'Track Info', value: 'info' },
      ...(settings.get('carButton') ? [{ icon: 'car', label: 'Car Mode', value: 'car' }] : []),
    ],
  });
  if (!v) return;
  if (v === 'album') { closeNP(); location.hash = `#/album/${t.albumId}`; }
  else if (v === 'artist') { closeNP(); location.hash = `#/artist/${t.artistId}`; }
  else if (v === 'playlist') hooks.addToPlaylist([t]);
  else if (v === 'download') hooks.toggleDownload([t]);
  else if (v === 'sleep') sleepMenu();
  else if (v === 'car') openCarMode();
  else if (v === 'bpm') {
    toast('Analyzing…');
    const r = await analyze(t, { force: true });
    toast(r ? `${Math.round(r.bpm)} BPM · ${r.bpmSrc === 'online' ? 'confirmed online' : r.bpmConf > 0.3 ? 'confident' : 'rough estimate'}` : 'Couldn’t analyze this file');
    renderChips();
  } else if (v === 'tap') tapTempo(t);
  else if (v === 'eq') { closeNP(); location.hash = '#/settings/sound'; }
  else if (v === 'transitions') { closeNP(); location.hash = '#/settings/playback'; }
  else if (v === 'info') trackInfo(t);
}

async function sleepMenu() {
  const v = await actionSheet({
    title: 'Stop playing after…',
    items: [
      { label: 'Off', value: 'off', active: !engine.sleepAt && !engine.sleepEndOfTrack },
      { label: '10 minutes', value: 10 }, { label: '15 minutes', value: 15 }, { label: '30 minutes', value: 30 },
      { label: '45 minutes', value: 45 }, { label: '1 hour', value: 60 }, { label: 'End of this song', value: 'track', active: engine.sleepEndOfTrack },
    ],
  });
  if (v == null) return;
  engine.setSleep(v === 'off' ? null : v);
  toast(v === 'off' ? 'Sleep timer off' : v === 'track' ? 'Stopping after this song' : `Sleep timer · ${v} min`);
}

function tapTempo(t) {
  const taps = [];
  const root = $('#sheet');
  root.innerHTML = html`<div class="sheet-backdrop" data-close></div><div class="sheet-panel dialog tap-panel">
    <div class="sheet-title big">Tap along to the beat</div>
    <button class="tap-pad"><span class="tap-bpm">—</span><small>BPM</small></button>
    <div class="dialog-btns"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save disabled>Save BPM</button></div>
  </div>`;
  requestAnimationFrame(() => root.classList.add('open'));
  let bpm = 0;
  root.querySelector('.tap-pad').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    haptic(10);
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 12) taps.shift();
    if (taps.length >= 3) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      bpm = Math.round((60000 / iv) * 10) / 10;
      root.querySelector('.tap-bpm').textContent = Math.round(bpm);
      root.querySelector('[data-save]').disabled = false;
    }
    e.currentTarget.animate([{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 160 });
  });
  root.onclick = (e) => {
    if (e.target.closest('[data-close]')) { root.classList.remove('open'); setTimeout(() => { root.innerHTML = ''; }, 250); }
    if (e.target.closest('[data-save]') && bpm) {
      const an = library.analysis.get(t.id) || { id: t.id, v: 0 };
      const ratio = an.bpm ? bpm / an.bpm : 1;
      library.setAnalysis({ ...an, bpm, bpmConf: 1, tapped: true, beatOffset: an.beatOffset || 0, ...(ratio ? {} : {}) });
      t.bpm = bpm;
      root.classList.remove('open'); setTimeout(() => { root.innerHTML = ''; }, 250);
      toast(`Saved ${Math.round(bpm)} BPM`);
      renderChips();
    }
  };
}

function trackInfo(t) {
  const an = library.analysis.get(t.id);
  const rows = [
    ['Title', t.title], ['Artist', t.artist], ['Album', t.album], ['Album artist', t.albumArtist],
    ['Track', t.track ? `${t.track}${t.trackTotal ? ' of ' + t.trackTotal : ''}` : ''], ['Disc', t.disc > 1 || t.discTotal > 1 ? `${t.disc}${t.discTotal ? ' of ' + t.discTotal : ''}` : ''],
    ['Year', t.year || ''], ['Genre', t.genre], ['Format', formatLine(t)], ['Channels', t.channels ? (t.channels === 1 ? 'Mono' : t.channels === 2 ? 'Stereo' : t.channels + ' ch') : ''],
    ['Duration', fmtTime(t.duration)], ['Size', t.size ? (t.size / 1048576).toFixed(1) + ' MB' : ''],
    ['ReplayGain', t.rgTrack !== undefined ? `track ${t.rgTrack.toFixed(2)} dB${t.rgAlbum !== undefined ? ` · album ${t.rgAlbum.toFixed(2)} dB` : ''}` : 'none'],
    ['Leveling now', `${engine.gainDbFor(t).toFixed(1)} dB`],
    ['BPM', library.bpmOf(t) ? `${library.bpmOf(t)}${an?.tapped ? ' (tapped)' : an?.bpmSrc === 'online' ? ' (confirmed online)' : t.bpm && settings.get('preferBpmTag') ? ' (tag)' : an?.bpm ? ' (detected)' : ''}${an?.bpmFixed ? ` · was ${Math.round(an.bpmFixed)}` : ''}` : '—'],
    ['Key', an?.key ? `${an.key} (${an.camelot})` : '—'],
    ['Energy', an?.energy !== undefined ? `${Math.round(an.energy * 100)}%` : '—'],
    ['Analysis', an ? `intro silence ${an.leadIn}s · fade-out at ${fmtTime(an.fadeOutStart)} · loudness ${an.loudnessDb} dB` : 'not analyzed'],
    ['File', t.demo ? 'Generated demo track' : decodeURIComponent(t.url)],
  ].filter((r) => r[1]);
  const root = $('#sheet');
  root.innerHTML = html`<div class="sheet-backdrop" data-close></div><div class="sheet-panel info-panel">
    <div class="grabber"></div><div class="sheet-title big">Track Info</div>
    <dl class="info-list">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    <button class="sheet-cancel" data-close>Done</button></div>`;
  requestAnimationFrame(() => root.classList.add('open'));
  root.onclick = (e) => { if (e.target.closest('[data-close]')) { root.classList.remove('open'); setTimeout(() => { root.innerHTML = ''; }, 250); } };
}

// ---------- rendering ----------
async function onTrack(t) {
  const mini = $('#mini'), np = $('#np');
  document.body.classList.toggle('has-track', !!t);
  if (!t) return;
  mini.querySelector('.mini-art').innerHTML = art(t.artId, 'xs');
  mini.querySelector('.mini-title').textContent = t.title;
  mini.querySelector('.mini-artist').textContent = t.artist;
  const artEl = np.querySelector('.np-art');
  const prev = artEl.dataset.art;
  if (prev !== String(t.artId)) {
    artEl.innerHTML = art(t.artId, 'np-art-img', t.album);
    artEl.dataset.art = t.artId;
    artEl.animate?.([{ opacity: 0.4, transform: 'scale(.97)' }, { opacity: 1, transform: '' }], { duration: 320, easing: 'ease-out' });
  }
  np.querySelector('.np-mini-art').innerHTML = art(t.artId, 'xs');
  np.querySelector('.np-title span').textContent = t.title;
  np.querySelector('.np-artist').innerHTML = html`<a href="#/artist/${t.artistId}" data-np="close">${t.artist}</a> — <a href="#/album/${t.albumId}" data-np="close">${t.album}</a>`;
  const ctx = engine.context;
  np.querySelector('.np-context b').textContent = ctx?.name || t.album;
  np.querySelector('.np-context small').textContent = ctx?.type === 'album' ? 'Playing from album' : ctx?.type === 'playlist' ? 'Playing from playlist' : ctx?.type === 'artist' ? 'Playing from artist' : 'Playing from';
  const bg = np.querySelector('.np-bg-img');
  bg.style.backgroundImage = t.artId ? `url('${artUrl(t.artId, 300)}')` : 'none';
  const colors = await artColors(t.artId);
  const c = colors || ['#2a2a35', '#5a5a7a', '#101014'];
  np.style.setProperty('--np-c1', c[0]);
  np.style.setProperty('--np-c2', c[1]);
  np.style.setProperty('--np-c3', c[2]);
  hooks.onAccent?.(colors);
  requestAnimationFrame(() => {
    const tl = np.querySelector('.np-title');
    tl.classList.toggle('marquee', tl.scrollWidth > tl.clientWidth + 4);
  });
  renderLike();
  renderChips();
  drawWave();
  renderTime();
  renderHint();
  if (mode === 'booth') renderBooth($('#np .np-booth'));
  lyrics = null;
  np.querySelector('.np-lyr').classList.toggle('has', !!(t.lyrics || t.lrc || t.plexLyrics));
  getLyrics(t).then((l) => { if (engine.track === t) np.querySelector('.np-lyr').classList.toggle('has', !!l); });
  if (mode === 'lyrics') renderLyrics();
  if (mode === 'queue') renderQueue();
  document.querySelectorAll('.row.track.playing').forEach((r) => r.classList.remove('playing'));
  document.querySelectorAll(`.row.track[data-tid="${t.id}"]`).forEach((r) => r.classList.add('playing'));
}

function renderState() {
  const playing = engine.playing;
  const np = $('#np'), mini = $('#mini');
  for (const b of [np.querySelector('.np-play'), mini.querySelector('.mini-play')]) {
    b.innerHTML = icon(playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  np.classList.toggle('paused', !playing);
  document.body.classList.toggle('is-playing', playing);
  np.querySelector('.np-shuffle').classList.toggle('on', engine.shuffle);
  const rp = np.querySelector('.np-repeat');
  rp.classList.toggle('on', engine.repeat !== 'off');
  rp.innerHTML = icon(engine.repeat === 'one' ? 'repeat-one' : 'repeat');
}

function renderMode() {
  const m = settings.get('transition');
  const b = $('#np .np-mode');
  if (!b) return;
  b.innerHTML = html`${icon({ smart: 'smart', crossfade: 'crossfade', off: 'gapless' }[m])}<span>${{ smart: 'DJ Mix', crossfade: 'Crossfade', off: 'Gapless' }[m]}</span>`;
  b.dataset.m = m;
}

function renderLike() {
  const t = engine.track;
  const b = $('#np .np-like');
  const on = t && library.likes.has(t.id);
  b.innerHTML = icon(on ? 'heart-fill' : 'heart');
  b.classList.toggle('on', !!on);
}

function renderChips() {
  const t = engine.track;
  const el = $('#np .np-chips');
  if (!t || !el) return;
  const bpm = library.bpmOf(t);
  const key = library.analysis.get(t.id)?.camelot;
  el.innerHTML = html`${badges(t, { compact: true })}${settings.get('showBpm') && bpm ? html`<span class="badge bpm">${icon('bpm')}${Math.round(bpm)} BPM${key ? ` · ${key}` : ''}</span>` : ''}`;
}

function renderHint() {
  const el = $('#np .np-next-hint');
  if (!el) return;
  const p = engine.plan, nx = engine.upcoming, tr = engine.transition;
  if (settings.get('showNextTransition') && tr) {
    // mixing right now: say so, with a live progress readout
    el.dataset.mix = '';
    el.innerHTML = html`${icon('smart')}<span>Mixing into <b>${tr.to.track?.title || ''}</b> · ${tr.plan.label}</span><em class="mixing"></em>`;
    el.classList.add('show', 'live');
    return;
  }
  el.classList.remove('live');
  if (!settings.get('showNextTransition') || !p || !nx) { el.classList.remove('show'); return; }
  el.dataset.mix = p.mixStart;
  el.innerHTML = html`${icon(p.style === 'gapless' ? 'gapless' : p.style === 'crossfade' ? 'crossfade' : 'smart')}<span>Next: <b>${nx.track.title}</b> · ${p.label}</span><em></em><button class="hear-mix" data-np="hear-mix" aria-label="Jump to just before the mix">Hear it</button>`;
  el.classList.add('show');
}

let lastLyricIdx = -1;
let dragAt = 0;
function renderTime() {
  const np = $('#np');
  const t = engine.currentTime, d = engine.duration || 0;
  const pct = d ? clamp(t / d, 0, 1) : 0;
  $('#mini .mini-progress i').style.transform = `scaleX(${pct})`;
  // a drag that lost its finger (iOS cancelled the touch) must never freeze the slider
  if (dragging && performance.now() - dragAt > 1500) { dragging = false; np.querySelector('.scrub').classList.remove('drag'); }
  if (!dragging) {
    np.querySelector('.scrub').style.setProperty('--p', pct);
    np.querySelector('.t-cur').textContent = fmtTime(t);
    np.querySelector('.t-rem').textContent = '-' + fmtTime(Math.max(0, d - t));
  }
  const el = engine.cur.el;
  if (el.buffered?.length && d) {
    let end = 0;
    for (let i = 0; i < el.buffered.length; i++) if (el.buffered.start(i) <= t + 1) end = Math.max(end, el.buffered.end(i));
    np.querySelector('.scrub').style.setProperty('--b', clamp(end / d, 0, 1));
  }
  if (np.classList.contains('has-wave')) np.querySelector('.wave.played').style.clipPath = `inset(0 ${((1 - (dragging ? +np.querySelector('.scrub').style.getPropertyValue('--p') : pct)) * 100).toFixed(2)}% 0 0)`;
  if (mode === 'booth') tickBooth(np.querySelector('.np-booth'));
  const hint = np.querySelector('.np-next-hint.show em');
  if (hint) {
    const tr = engine.transition;
    if (tr) {
      const k = tr.total ? clamp((performance.now() - tr.at) / tr.total, 0, 1) : 0;
      hint.textContent = `${Math.round(k * 100)}%`;
    } else {
      const left = (+np.querySelector('.np-next-hint').dataset.mix || 0) - t;
      hint.textContent = left > 0 && left < 60 ? `in ${fmtTime(left)}` : '';
    }
  }
  if (mode === 'lyrics' && lyrics?.synced) {
    let idx = -1;
    for (let i = 0; i < lyrics.lines.length; i++) { if (lyrics.lines[i].t <= t + 0.25) idx = i; else break; }
    if (idx !== lastLyricIdx) {
      lastLyricIdx = idx;
      const box = np.querySelector('.np-lyrics');
      box.querySelectorAll('.ly.on').forEach((x) => x.classList.remove('on'));
      const line = box.querySelector(`.ly[data-i="${idx}"]`);
      if (line) {
        line.classList.add('on');
        // keep the sung line ~1/3 down; leave the user alone for a few seconds after they scroll
        if (Date.now() - lyricTouch > 3500) {
          const top = box.scrollTop + line.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight * 0.33;
          box.scrollTo({ top, behavior: Math.abs(top - box.scrollTop) > box.clientHeight * 1.5 ? 'auto' : 'smooth' });
        }
      }
    }
  }
}

function renderQueue() {
  const box = $('#np .np-queue');
  const t = engine.track;
  if (!t) { box.innerHTML = ''; return; }
  const q = engine.queue;
  const rows = [];
  for (let i = engine.index + 1; i < q.length && rows.length < 300; i++) {
    const x = library.track(q[i]);
    if (!x) continue;
    if (i === engine.autoplayFrom) rows.push(html`<div class="q-head auto"><b>Autoplay</b><span>Similar music</span></div>`);
    rows.push(html`<div class="q-row" data-qi="${i}">
      ${art(x.artId, 'xs')}
      <div class="meta" data-np="jump:${i}"><div class="t1">${x.title}</div><div class="t2">${x.artist}</div></div>
      <button class="icon-btn q-rm" data-np="rm:${i}" aria-label="Remove">${icon('x')}</button>
      <div class="q-handle" data-handle aria-label="Reorder">${icon('drag')}</div>
    </div>`);
  }
  box.innerHTML = html`
    <div class="q-head"><b>Up Next</b>
      <span class="q-tools">
        <button class="pill-sm${engine.shuffle ? ' on' : ''}" data-np="shuffle">${icon('shuffle')}</button>
        <button class="pill-sm${engine.repeat !== 'off' ? ' on' : ''}" data-np="repeat">${icon(engine.repeat === 'one' ? 'repeat-one' : 'repeat')}</button>
        ${rows.length > 1 ? html`<button class="pill-sm dj" data-np="dj-order">${icon('mix')}DJ Order</button>` : ''}
        ${rows.length ? html`<button class="pill-sm" data-np="clear-queue">Clear</button>` : ''}
      </span></div>
    <div class="q-sub">${engine.context?.name ? `From ${engine.context.name}` : ''}</div>
    <div class="q-list">${rows.length ? rows : html`<div class="q-empty">Nothing up next${settings.get('autoplay') ? ' — Autoplay will keep the music going.' : '.'}</div>`}</div>`;
}

// ---------- lyrics ----------
let lyricTouch = 0;
async function renderLyrics(fresh = false) {
  const box = $('#np .np-lyrics');
  const t = engine.track;
  if (!t) return;
  if (!box.dataset.wired) {
    box.dataset.wired = '1';
    for (const ev of ['touchstart', 'wheel']) box.addEventListener(ev, () => { lyricTouch = Date.now(); }, { passive: true });
  }
  box.innerHTML = '<div class="ly-loading"><div class="spinner"></div></div>';
  lyrics = await getLyrics(t, fresh ? { fresh: true } : undefined);
  lastLyricIdx = -1;
  if (engine.track !== t) return;
  if (!lyrics) {
    box.innerHTML = html`<div class="ly-none">${icon('lyrics')}<p>No lyrics found for this song.</p><small>${settings.get('onlineLyrics') ? 'Searched your files, Plex and LRCLIB by title & artist.' : 'Turn on Online lyrics in Settings → Playback to search by title & artist.'}</small><button class="pill-sm" data-np="lyrics-retry">Search again</button></div>`;
    return;
  }
  setTimeout(markCue, 0);
  // blank lines: a short "•••" for instrumental breaks in synced lyrics, plain spacing otherwise; never doubled up
  box.innerHTML = html`<div class="ly-wrap${lyrics.synced ? ' synced' : ''}">${lyrics.lines.map((l, i) => l.text
    ? html`<p class="ly" data-i="${i}" ${lyrics.synced ? raw(`data-np="seek:${l.t}"`) : ''}>${l.text}</p>`
    : (i === 0 || !lyrics.lines[i - 1].text || i === lyrics.lines.length - 1) ? ''
      : lyrics.synced && lyrics.lines[i + 1] && lyrics.lines[i + 1].t - l.t > 6 ? html`<p class="ly gap" data-i="${i}">•••</p>`
        : html`<p class="ly space" data-i="${i}"></p>`)}<p class="ly-src">Lyrics · ${lyrics.source}</p></div>`;
  renderTime();
}

// DJ cue in the lyrics: the line the DJ will cut on (word play)
function markCue() {
  const box = $('#np .np-lyrics');
  box.querySelectorAll('.ly.cue').forEach((x) => x.classList.remove('cue'));
  const cue = engine.plan?.cue;
  if (!cue || !lyrics?.synced) return;
  const i = lyrics.lines.findIndex((l) => Math.abs(l.t - cue.t) < 0.05);
  box.querySelector(`.ly[data-i="${i}"]`)?.classList.add('cue');
}

// ---------- waveform scrubber ----------
function drawWave() {
  const np = $('#np');
  const t = engine.track;
  const an = t && library.analysis.get(t.id);
  const on = !!(settings.get('waveform') && an?.wave?.length);
  np.classList.toggle('has-wave', on);
  if (!on) return;
  for (const c of np.querySelectorAll('.wave')) {
    const dpr = Math.min(3, devicePixelRatio || 1);
    const w = c.clientWidth || c.parentNode.clientWidth, h = c.clientHeight || 30;
    if (!w) { requestAnimationFrame(drawWave); return; }
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = c.classList.contains('played') ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.3)';
    const bars = Math.floor(w / 3);
    for (let i = 0; i < bars; i++) {
      const v = an.wave[Math.floor((i / bars) * an.wave.length)] / 100;
      const bh = Math.max(2, v * h);
      x.fillRect(i * 3, (h - bh) / 2, 2, bh);
    }
  }
  renderWaveMarks();
  renderTime();
}
function renderWaveMarks() {
  const np = $('#np');
  const p = engine.plan, d = engine.duration || 0;
  const mix = np.querySelector('.wave-mix'), cue = np.querySelector('.wave-cue');
  if (!mix) return;
  if (!p || !d || !engine.upcoming || p.style === 'gapless') { mix.style.display = 'none'; cue.style.display = 'none'; return; }
  mix.style.display = 'block';
  mix.style.left = `${(p.mixStart / d) * 100}%`;
  const span = p.style === 'cook' ? (p.cutAt - p.mixStart) + (p.overlap || 0) : (p.overlap || 0.3) * (p.aRate || 1);
  mix.style.width = `${Math.max(0.6, (span / d) * 100)}%`;
  cue.style.display = p.cue ? 'block' : 'none';
  if (p.cue) cue.style.left = `${(p.cue.t / d) * 100}%`;
}

// ---------- gestures ----------
function wireScrubber() {
  const sc = $('#np .scrub');
  let rect, val = 0;
  const pos = (e) => clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const preview = () => {
    const d = engine.duration || 0;
    sc.style.setProperty('--p', val);
    sc.dataset.time = fmtTime(val * d);
    $('#np .t-cur').textContent = fmtTime(val * d);
    $('#np .t-rem').textContent = '-' + fmtTime(d - val * d);
  };
  sc.addEventListener('pointerdown', (e) => {
    if (!engine.track) return;
    rect = sc.getBoundingClientRect();
    dragging = true; dragAt = performance.now();
    sc.classList.add('drag');
    sc.setPointerCapture(e.pointerId);
    val = pos(e); preview();
  });
  sc.addEventListener('pointermove', (e) => { if (dragging) { dragAt = performance.now(); val = pos(e); preview(); } });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sc.classList.remove('drag');
    engine.seek(val * (engine.duration || 0));
    haptic(5);
  };
  sc.addEventListener('pointerup', end);
  sc.addEventListener('pointercancel', end);
  sc.addEventListener('lostpointercapture', end);
  sc.addEventListener('touchend', () => setTimeout(end, 0), { passive: true });
  sc.addEventListener('touchcancel', () => setTimeout(end, 0), { passive: true });
}

function wireSwipe() {
  const np = $('#np');
  let x0 = null, y0 = 0, dx = 0, dy = 0, t0 = 0, axis = null, onArt = false;
  const artEl = () => np.querySelector('.np-art');
  np.addEventListener('pointerdown', (e) => {
    const dual = document.body.classList.contains('dual');
    if (!open && !dual) return;
    const zone = e.target.closest('[data-drag]');
    if (!zone || e.target.closest('button, a, .np-panel, input, .scrub')) return;
    onArt = !!e.target.closest('.np-art-wrap') && mode === 'art';
    if (dual && !onArt) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; dy = 0; axis = null; t0 = performance.now();
  });
  np.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    if (!axis && Math.hypot(dx, dy) > 10) {
      axis = Math.abs(dx) > Math.abs(dy) && onArt && settings.get('artSwipe') ? 'x' : 'y';
      if (axis === 'y' && document.body.classList.contains('dual')) { x0 = null; return; }
      np.classList.add(axis === 'x' ? 'swiping' : 'dragging');
    }
    if (axis === 'y') np.style.transform = `translateY(${Math.max(0, dy)}px)`;
    if (axis === 'x') {
      const a = artEl();
      a.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      a.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 500));
    }
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    const v = (axis === 'x' ? Math.abs(dx) : dy) / (performance.now() - t0);
    np.classList.remove('dragging', 'swiping');
    if (axis === 'y') {
      if (dy > 140 || v > 0.6) closeNP(); else np.style.transform = '';
    } else if (axis === 'x') {
      const a = artEl();
      if (Math.abs(dx) > 90 || v > 0.5) {
        const dir = dx < 0 ? -1 : 1;
        haptic(12);
        dir < 0 ? engine.next() : engine.prev();
        const from = a.style.transform || 'none';
        a.style.transform = ''; a.style.opacity = '';
        try {
          a.animate([{ transform: from, opacity: 0.6 }, { transform: `translateX(${dir * 420}px) rotate(${dir * 8}deg)`, opacity: 0 },
            { transform: `translateX(${-dir * 160}px) scale(.92)`, opacity: 0, offset: 0.4 }, { transform: 'none', opacity: 1 }],
          { duration: 480, easing: 'ease-out' });
        } catch (e) { /* no WAAPI */ }
      } else {
        const from = a.style.transform || 'none';
        a.style.transform = ''; a.style.opacity = '';
        try { a.animate([{ transform: from }, { transform: 'none' }], { duration: 250, easing: 'cubic-bezier(.2,.9,.3,1.3)' }); } catch (e) { /* */ }
      }
    }
    axis = null;
  };
  np.addEventListener('pointerup', end);
  np.addEventListener('pointercancel', end);
}

// Artwork that breathes with the kick drum + optional spectrum visualizer.
// Only transforms/opacity change per frame (GPU-composited), capped at 30 fps, and it sleeps when hidden.
const PULSE_AMT = { subtle: 0.6, normal: 1, strong: 1.6 };
function startPulse() {
  const np = $('#np');
  const viz = np.querySelector('.np-viz');
  const vctx = viz.getContext('2d');
  let avg = 0, level = 0, buf = null, lastT = 0, lastLevel = -1;
  let fluxAvg = 0, lastHit = 0, realAt = -1e9, heardAt = -1e9; const hits = [];
  const loop = (now) => {
    requestAnimationFrame(loop);
    if (now - lastT < (settings.get('reactiveArt') && mode === 'art' && open ? 15 : 33)) return; // smooth beat pulse while the cover is showing
    lastT = now;
    const visible = (open || document.body.classList.contains('dual')) && !document.hidden;
    // smooth, exact clock & slider while the player is on screen (not just 5× a second)
    // clock/slider ~15×/s (smooth to the eye, light on the phone — keeps audio glitch-free during mixes)
    if (visible && engine.track && !dragging && (engine.playing || !engine.cur.el.paused) && performance.now() - (loop._rt || 0) > 66) { loop._rt = performance.now(); renderTime(); }
    const an = engine.analyser;
    const art = np.querySelector('.np-art .art');
    const glow = np.querySelector('.np-glow');
    const vizOn = settings.get('visualizer') !== 'off';
    if (!visible || !an || !engine.playing) {
      if (level > 0.002) { level *= 0.8; apply(art, glow); }
      if (viz.dataset.on === '1') { vctx.clearRect(0, 0, viz.width, viz.height); viz.dataset.on = '0'; }
      return;
    }
    if (!buf || buf.length !== an.frequencyBinCount) buf = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(buf);
    if (settings.get('reactiveArt') && mode === 'art') {
      const hz = engine.ctx.sampleRate / an.fftSize;
      const lo = Math.max(1, Math.floor(35 / hz)), hi = Math.ceil(140 / hz);
      let s = 0;
      for (let i = lo; i <= hi; i++) s += buf[i];
      const bass = s / (hi - lo + 1) / 255;
      avg = avg * 0.92 + bass * 0.08;
      const t = engine.track, a = t && library.analysis.get(t.id);
      const bpm = t && library.bpmOf(t);
      const pm = settings.get('pulseMode') || 'both';
      const ctx = engine.ctx;
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + 2048 / ctx.sampleRate;
      // the real kick drum: a jump in bass energy above the song's own recent level. It's heard `lat`
      // seconds after the analyser sees it, so the hit is queued and shown when it reaches your ears.
      const flux = Math.max(0, bass - (loop._pb || 0)); loop._pb = bass;
      fluxAvg = fluxAvg * 0.95 + flux * 0.05;
      if (bass > 0.002) heardAt = now;
      if (flux > fluxAvg * 2.2 + 0.025 && now - lastHit > 140) { lastHit = now; hits.push({ at: now + lat * 1000, v: Math.min(1, 0.35 + flux * 5 + bass * 0.6) }); }
      let real = 0;
      while (hits.length && hits[0].at <= now) { real = Math.max(real, hits.shift().v); realAt = now; }
      const silentAn = now - heardAt > 1500; // raw (non-Web Audio) playback: the analyser hears nothing
      if (bpm && a && pm !== 'beat' || (pm === 'beat' && silentAn && bpm && a)) {
        // locked to the song's beat grid: a sharp hit exactly on every beat (bigger on the downbeat),
        // timed to when you *hear* it (the clock runs a little ahead of the speakers)
        const th = engine.currentTime - lat * (engine.cur.el.playbackRate || 1);
        const beats = (th - (a.beatOffset || 0)) * (bpm / 60);
        const ph = beats - Math.floor(beats);
        const down = ((Math.floor(beats) % 4) + 4) % 4 === 0;
        // "both": on the grid, but only as strong as the drums really are right now (quiet in breakdowns)
        const drive = pm === 'both' && !silentAn ? Math.min(1, avg * 3.2) * (now - realAt < 900 ? 1 : 0.35) : Math.min(1, avg * 3.2);
        const amp = (pm === 'both' && !silentAn ? 0.15 + 0.85 * drive : 0.35 + 0.65 * drive) * (down ? 1 : 0.62);
        level = beats < 0 ? level * 0.8 : Math.exp(-ph * 7) * amp;
      } else if (real) level = Math.max(level, real);
      else level *= 0.82;
      apply(art, glow);
    }
    // the bars run at ~24 fps (half that while two songs are mixing) — the audio always comes first
    if (vizOn) { if (now - (loop._vz || 0) >= (engine.transition ? 80 : 40)) { loop._vz = now; drawViz(buf); } }
    else if (viz.dataset.on === '1') { vctx.clearRect(0, 0, viz.width, viz.height); viz.dataset.on = '0'; }
  };
  function apply(art, glow) {
    if (Math.abs(level - lastLevel) < 0.01) return;
    lastLevel = level;
    const k = PULSE_AMT[settings.get('pulseAmount')] ?? 1;
    if (art) art.style.transform = `scale(${(1 + level * 0.03 * k).toFixed(4)})`;
    if (glow) glow.style.opacity = Math.min(1, level * 0.9 * Math.min(1.3, k)).toFixed(3);
  }
  function drawViz(b) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = viz.clientWidth, h = viz.clientHeight;
    if (!w || !h) return;
    if (viz.width !== Math.round(w * dpr)) { viz.width = Math.round(w * dpr); viz.height = Math.round(h * dpr); }
    viz.dataset.on = '1';
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vctx.clearRect(0, 0, w, h);
    const bars = 48, gap = 3;
    const bw = (w - gap * (bars - 1)) / bars;
    const hz = engine.ctx.sampleRate / engine.analyser.fftSize;
    vctx.fillStyle = 'rgba(255,255,255,0.16)';
    vctx.beginPath(); // one shape for all bars: a single fill per frame
    for (let i = 0; i < bars; i++) {
      // log-spaced bands 40 Hz – 14 kHz
      const f0 = 40 * Math.pow(350, i / bars), f1 = 40 * Math.pow(350, (i + 1) / bars);
      let m = 0;
      for (let k = Math.floor(f0 / hz); k <= Math.ceil(f1 / hz); k++) m = Math.max(m, b[k] || 0);
      const bh = Math.max(2, (m / 255) ** 2.2 * h);
      const x = i * (bw + gap);
      vctx.rect(x, h - bh, bw, bh);
    }
    vctx.fill();
  }
  requestAnimationFrame(loop);
}

function wireMiniSwipe() {
  const mini = $('#mini');
  let x0 = null, dx = 0;
  mini.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) { x0 = e.clientX; dx = 0; } });
  mini.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    mini.querySelector('.mini-meta').style.transform = `translateX(${dx * 0.6}px)`;
    mini.querySelector('.mini-meta').style.opacity = 1 - Math.min(0.7, Math.abs(dx) / 200);
  });
  const end = (e) => {
    if (x0 === null) return;
    const m = mini.querySelector('.mini-meta');
    m.style.transform = ''; m.style.opacity = '';
    if (Math.abs(dx) > 70) {
      e.preventDefault();
      mini.dataset.swiped = '1';
      setTimeout(() => { delete mini.dataset.swiped; }, 50);
      dx < 0 ? engine.next() : engine.prev();
      haptic(10);
    }
    x0 = null;
  };
  mini.addEventListener('pointerup', end);
  mini.addEventListener('pointercancel', () => { x0 = null; });
  mini.addEventListener('click', (e) => { if (mini.dataset.swiped) e.stopImmediatePropagation(); }, true);
}

function wireQueueDrag() {
  const box = $('#np .np-queue');
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-handle]');
    if (!h) return;
    e.preventDefault();
    const row = h.closest('.q-row');
    const rows = [...box.querySelectorAll('.q-row')];
    drag = { row, rows, from: rows.indexOf(row), y0: e.clientY, h: row.offsetHeight, to: rows.indexOf(row), qi: +row.dataset.qi };
    row.classList.add('lift');
    h.setPointerCapture(e.pointerId);
    haptic(10);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y0;
    drag.row.style.transform = `translateY(${dy}px)`;
    const to = clamp(drag.from + Math.round(dy / drag.h), 0, drag.rows.length - 1);
    if (to !== drag.to) {
      drag.to = to;
      drag.rows.forEach((r, i) => {
        if (r === drag.row) return;
        let shift = 0;
        if (drag.from < to && i > drag.from && i <= to) shift = -drag.h;
        if (drag.from > to && i < drag.from && i >= to) shift = drag.h;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
      haptic(4);
    }
  });
  const end = () => {
    if (!drag) return;
    const { from, to, rows, qi } = drag;
    rows.forEach((r) => { r.style.transform = ''; r.classList.remove('lift'); });
    drag = null;
    if (from !== to) {
      const toQi = +rows[to].dataset.qi;
      engine.move(qi, toQi);
    }
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ---------- extras ----------
// Double-tap the left/right half of the artwork to jump back/forward
function wireDoubleTap() {
  const np = $('#np');
  const wrap = () => np.querySelector('.np-art-wrap');
  let last = 0, lx = 0, ly = 0, down = null;
  const inside = (e) => { const r = wrap()?.getBoundingClientRect(); return r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  // listen on the whole player (the swipe gesture may capture the pointer) and test the position
  np.addEventListener('pointerdown', (e) => { down = inside(e) ? [e.clientX, e.clientY] : null; }, true);
  np.addEventListener('pointerup', (e) => {
    if (!settings.get('doubleTapSeek') || !engine.track || mode !== 'art' || !down) return;
    if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 14) { last = 0; return; }
    const now = performance.now();
    if (now - last < 350 && Math.hypot(e.clientX - lx, e.clientY - ly) < 70) {
      last = 0;
      const w = wrap(), r = w.getBoundingClientRect();
      const back = e.clientX < r.left + r.width / 2;
      const step = settings.get('seekStep') || 15;
      engine.seek(engine.currentTime + (back ? -step : step));
      haptic(8);
      const rip = document.createElement('div');
      rip.className = 'seek-ripple ' + (back ? 'l' : 'r');
      rip.innerHTML = `${icon(back ? 'prev' : 'next')}<b>${back ? '−' : '+'}${step}s</b>`;
      w.appendChild(rip);
      setTimeout(() => rip.remove(), 650);
    } else { last = now; lx = e.clientX; ly = e.clientY; }
  }, true);
}

// Keep the screen on while the player (or Car Mode) is showing
let wakeLock = null;
async function updateWake() {
  const want = (settings.get('keepAwake') && open && engine.playing && !document.hidden) || (carOpen && !document.hidden);
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch (e) { wakeLock = null; }
}

// Open lyrics automatically for songs with time-synced lyrics
let autoOpened = false;
async function autoLyrics(t) {
  if (!t || !settings.get('autoLyrics')) return;
  const l = await getLyrics(t);
  if (engine.track !== t) return;
  if (l?.synced && mode === 'art') { setMode('lyrics'); autoOpened = true; }
  else if (!l?.synced && mode === 'lyrics' && autoOpened) { setMode('lyrics'); autoOpened = false; }
}

// ---------- Car Mode: huge buttons, big text, live lyrics, screen stays on ----------
// Layouts (css): phone upright = stacked; phone sideways = controls | lyrics; unfolded iPhone Duo = one
// screen each side of the fold (controls on one, lyrics on the other; swaps with "Swap sides").
let carOpen = false, carLyr = null, carLyrIdx = -2, carTrack = null;
export function openCarMode() {
  if (!engine.track) return;
  let car = $('#car');
  if (!car) {
    car = document.createElement('div');
    car.id = 'car';
    document.body.appendChild(car);
    car.addEventListener('click', (e) => {
      const b = e.target.closest('[data-car]');
      if (!b) return;
      haptic(10);
      const a = b.dataset.car;
      if (a === 'close') closeCarMode();
      else if (a === 'toggle') engine.toggle();
      else if (a === 'next') engine.next();
      else if (a === 'prev') engine.prev();
      else if (a === 'like' && engine.track) { if (library.toggleLike(engine.track.id) && settings.get('likeBurst')) likeBurst(b); }
      else if (a === 'lyrics') { settings.set('carLyrics', !settings.get('carLyrics')); carTrack = null; renderCar(); }
      else if (a.startsWith('seek:')) engine.seek(+a.slice(5));
      b.animate?.([{ transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
    });
    engine.on('track', () => { carTrack = null; renderCar(); });
    engine.on('state', renderCarState);
    engine.on('time', carTime);
    library.on('likes', renderCarState);
  }
  carOpen = true;
  carTrack = null;
  renderCar();
  requestAnimationFrame(() => car.classList.add('open'));
  updateWake();
}
export function closeCarMode() {
  const car = $('#car');
  carOpen = false;
  car?.classList.remove('open');
  updateWake();
}
async function renderCar() {
  const car = $('#car');
  const t = engine.track;
  if (!car || !carOpen || !t || carTrack === t) return;
  carTrack = t;
  const wantLyr = settings.get('carLyrics');
  carLyr = null; carLyrIdx = -2;
  car.classList.toggle('no-lyrics', !wantLyr);
  car.innerHTML = html`
    <div class="car-side car-main">
      <div class="car-bar">
        <button class="car-round" data-car="close" aria-label="Close">${icon('down')}</button>
        <div class="car-bar-r">
          <button class="car-round car-lyr${wantLyr ? ' on' : ''}" data-car="lyrics" aria-label="Lyrics">${icon('lyrics')}</button>
          <button class="car-round car-like" data-car="like" aria-label="Like">${icon('heart')}</button>
        </div>
      </div>
      <div class="car-top">${art(t.artId, 'car-art', t.album)}<div class="car-meta"><div class="car-title">${t.title}</div><div class="car-artist">${t.artist}</div></div></div>
      <div class="car-prog"><i></i></div>
      <div class="car-ctl">
        <button data-car="prev" aria-label="Previous">${icon('prev')}</button>
        <button data-car="toggle" class="car-play" aria-label="Play/Pause">${icon('play')}</button>
        <button data-car="next" aria-label="Next">${icon('next')}</button>
      </div>
    </div>
    <div class="car-hinge"></div>
    <div class="car-side car-lyrics">${wantLyr ? html`<div class="car-ly-wait"><div class="spinner"></div></div>` : ''}</div>`;
  renderCarState();
  carTime();
  if (!wantLyr) return;
  const l = await getLyrics(t);
  if (carTrack !== t || !carOpen) return;
  carLyr = l;
  const box = car.querySelector('.car-lyrics');
  car.classList.toggle('lyr-none', !l);
  if (!l) { box.innerHTML = html`<div class="car-ly-none">${icon('lyrics')}<span>No lyrics for this song</span></div>`; return; }
  // same look as the player's lyrics: a scrolling sheet, sung line bright, the rest dimmed
  box.innerHTML = html`<div class="car-ly-scroll"><div class="ly-wrap${l.synced ? ' synced' : ''}">${l.lines.map((x, i) => x.text
    ? html`<p class="ly" data-i="${i}" ${l.synced ? raw(`data-car="seek:${x.t}"`) : ''}>${x.text}</p>`
    : (i === 0 || !l.lines[i - 1].text || i === l.lines.length - 1) ? ''
      : l.synced && l.lines[i + 1] && l.lines[i + 1].t - x.t > 6 ? html`<p class="ly gap" data-i="${i}">•••</p>` : html`<p class="ly space" data-i="${i}"></p>`)}</div></div>`;
  const sc = box.querySelector('.car-ly-scroll');
  for (const ev of ['touchstart', 'wheel']) sc.addEventListener(ev, () => { carTouch = Date.now(); }, { passive: true });
  carTime(true);
}
let carTouch = 0;
function renderCarState() {
  const car = $('#car');
  const t = engine.track;
  if (!car || !carOpen || !t) return;
  const play = car.querySelector('.car-play');
  if (play) play.innerHTML = icon(engine.playing ? 'pause' : 'play');
  const like = car.querySelector('.car-like');
  if (like) { const on = library.likes.has(t.id); like.classList.toggle('on', on); like.innerHTML = icon(on ? 'heart-fill' : 'heart'); }
}
function carTime(force = false) {
  if (!carOpen) return;
  const car = $('#car');
  const d = engine.duration || 0, t = engine.currentTime;
  const bar = car?.querySelector('.car-prog i');
  if (bar) bar.style.transform = `scaleX(${d ? clamp(t / d, 0, 1) : 0})`;
  if (!carLyr?.synced) return;
  const L = carLyr.lines;
  let idx = -1;
  for (let i = 0; i < L.length; i++) { if (L[i].t <= t + 0.25) idx = i; else break; }
  if (idx === carLyrIdx && force !== true) return;
  carLyrIdx = idx;
  const sc = car.querySelector('.car-ly-scroll');
  if (!sc) return;
  sc.querySelectorAll('.ly.on').forEach((x) => x.classList.remove('on'));
  const line = sc.querySelector(`.ly[data-i="${idx}"]`) || sc.querySelector('.ly');
  if (!line) return;
  if (idx >= 0) line.classList.add('on');
  if (Date.now() - carTouch > 3500) {
    const top = sc.scrollTop + line.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight * 0.32;
    sc.scrollTo({ top, behavior: force === true || Math.abs(top - sc.scrollTop) > sc.clientHeight * 1.5 ? 'auto' : 'smooth' });
  }
}
