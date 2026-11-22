// Mini player + full-screen Now Playing (art, scrubber, controls, queue, synced lyrics)
import { html, raw, icon, fmtTime, $, clamp, nasUrl } from '../util.js';
import { engine } from '../engine.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { analyze } from '../analysis.js';
import { artColors } from '../art.js';
import { art, badges, haptic, actionSheet, toast, formatLine } from './components.js';

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
    <button class="icon-btn mini-play" data-np="toggle" aria-label="Play">${icon('play')}</button>
    <button class="icon-btn mini-next" data-np="next" aria-label="Next">${icon('next')}</button>`;
  const np = $('#np');
  np.innerHTML = html`
    <div class="np-bg"><div class="np-bg-img"></div><div class="np-bg-tint"></div></div>
    <div class="np-inner">
      <div class="np-top" data-drag>
        <button class="icon-btn np-collapse" data-np="close" aria-label="Close">${icon('down')}</button>
        <div class="np-context"><small>Playing from</small><b></b></div>
        <button class="icon-btn" data-np="menu" aria-label="More">${icon('more')}</button>
      </div>
      <div class="np-stage" data-drag>
        <div class="np-art-wrap"><div class="np-art"></div></div>
        <div class="np-panel np-queue"></div>
        <div class="np-panel np-lyrics"></div>
      </div>
      <div class="np-info">
        <div class="np-mini-art"></div>
        <div class="np-titles"><div class="np-title"><span></span></div><div class="np-artist"></div></div>
        <button class="icon-btn np-like" data-np="like" aria-label="Like">${icon('heart')}</button>
      </div>
      <div class="np-scrub">
        <div class="scrub" data-scrub><div class="scrub-track"><div class="scrub-buf"></div><div class="scrub-fill"></div></div><div class="scrub-knob"></div></div>
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
  wireSwipe();
  wireMiniSwipe();
  wireQueueDrag();
  const vol = np.querySelector('.vol');
  vol.value = engine.volume;
  vol.addEventListener('input', () => engine.setVolume(+vol.value));
  engine.on('volume', (v) => { vol.value = v; });

  engine.on('track', onTrack);
  engine.on('state', renderState);
  engine.on('time', renderTime);
  engine.on('queue', () => { if (mode === 'queue') renderQueue(); });
  engine.on('plan', renderHint);
  engine.on('analysis', (id) => { if (id === engine.track?.id) renderChips(); });
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
  history.pushState({ np: 1 }, '', (location.hash || '#/home').replace(/\?np$/, '') + '?np');
  haptic(6);
}
export function closeNP(fromPop = false) {
  if (!open) return;
  open = false;
  $('#np').classList.remove('open');
  document.body.classList.remove('np-open');
  $('#np').style.transform = '';
  if (!fromPop && location.hash.endsWith('?np')) history.back();
}

function setMode(m) {
  mode = mode === m ? 'art' : m;
  $('#np .np-stage').dataset.mode = mode;
  $('#np').dataset.mode = mode;
  $('#np .np-q').classList.toggle('on', mode === 'queue');
  $('#np .np-lyr').classList.toggle('on', mode === 'lyrics');
  if (mode === 'queue') renderQueue();
  if (mode === 'lyrics') renderLyrics();
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
    case 'like': if (t) { const on = library.toggleLike(t.id); haptic(on ? 15 : 6); } break;
    case 'queue': setMode('queue'); break;
    case 'lyrics': setMode('lyrics'); break;
    case 'mode': {
      const order = ['smart', 'crossfade', 'off'];
      const nx = order[(order.indexOf(settings.get('transition')) + 1) % order.length];
      settings.set('transition', nx);
      toast({ smart: 'Smart transitions', crossfade: `Crossfade · ${settings.get('crossfadeSec')}s`, off: 'Gapless (no crossfade)' }[nx]);
      break;
    }
    case 'menu': npMenu(); break;
    case 'clear-queue': engine.clearUpNext(); break;
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
      { icon: 'download', label: library.offline.has(t.url) ? 'Remove Download' : 'Download', value: 'download' },
      { sep: true },
      { icon: 'timer', label: sleepLabel, value: 'sleep' },
      { icon: 'bpm', label: an?.bpm ? `BPM · ${Math.round(library.bpmOf(t))} — re-detect` : 'Detect BPM', value: 'bpm' },
      { icon: 'tap', label: 'Tap Tempo…', value: 'tap' },
      { icon: 'eq', label: 'Equalizer', value: 'eq' },
      { icon: 'mix', label: 'Transitions…', value: 'transitions' },
      { icon: 'info', label: 'Track Info', value: 'info' },
    ],
  });
  if (!v) return;
  if (v === 'album') { closeNP(); location.hash = `#/album/${t.albumId}`; }
  else if (v === 'artist') { closeNP(); location.hash = `#/artist/${t.artistId}`; }
  else if (v === 'playlist') hooks.addToPlaylist([t]);
  else if (v === 'download') hooks.toggleDownload([t]);
  else if (v === 'sleep') sleepMenu();
  else if (v === 'bpm') {
    toast('Analyzing…');
    const r = await analyze(t, { force: true });
    toast(r ? `${Math.round(r.bpm)} BPM · ${r.bpmConf > 0.3 ? 'confident' : 'rough estimate'}` : 'Couldn’t analyze this file');
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
    ['BPM', library.bpmOf(t) ? `${library.bpmOf(t)}${t.bpm && settings.get('preferBpmTag') ? ' (tag)' : an?.bpm ? ' (detected)' : ''}` : '—'],
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
  bg.style.backgroundImage = t.artId ? `url('./__art/${t.artId}')` : 'none';
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
  renderTime();
  renderHint();
  lyrics = null;
  np.querySelector('.np-lyr').classList.toggle('has', !!(t.lyrics || t.lrc));
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
  b.innerHTML = html`${icon({ smart: 'smart', crossfade: 'crossfade', off: 'gapless' }[m])}<span>${{ smart: 'Smart', crossfade: 'Crossfade', off: 'Gapless' }[m]}</span>`;
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
  el.innerHTML = html`${badges(t, { compact: true })}${settings.get('showBpm') && bpm ? html`<span class="badge bpm">${icon('bpm')}${Math.round(bpm)} BPM</span>` : ''}`;
}

function renderHint() {
  const el = $('#np .np-next-hint');
  if (!el) return;
  const p = engine.plan, nx = engine.next;
  if (!settings.get('showNextTransition') || !p || !nx) { el.classList.remove('show'); return; }
  el.dataset.mix = p.mixStart;
  el.innerHTML = html`${icon(p.type === 'gapless' || p.type === 'trim' ? 'gapless' : p.type === 'crossfade' ? 'crossfade' : 'smart')}<span>Next: <b>${nx.track.title}</b> · ${p.label}</span><em></em>`;
  el.classList.add('show');
}

let lastLyricIdx = -1;
function renderTime() {
  const np = $('#np');
  const t = engine.currentTime, d = engine.duration || 0;
  const pct = d ? clamp(t / d, 0, 1) : 0;
  $('#mini .mini-progress i').style.transform = `scaleX(${pct})`;
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
  const hint = np.querySelector('.np-next-hint.show em');
  if (hint) {
    const left = (+np.querySelector('.np-next-hint').dataset.mix || 0) - t;
    hint.textContent = left > 0 && left < 60 ? `in ${fmtTime(left)}` : '';
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
        box.scrollTo({ top: line.offsetTop - box.clientHeight * 0.35, behavior: 'smooth' });
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
        ${rows.length ? html`<button class="pill-sm" data-np="clear-queue">Clear</button>` : ''}
      </span></div>
    <div class="q-sub">${engine.context?.name ? `From ${engine.context.name}` : ''}</div>
    <div class="q-list">${rows.length ? rows : html`<div class="q-empty">Nothing up next${settings.get('autoplay') ? ' — Autoplay will keep the music going.' : '.'}</div>`}</div>`;
}

// ---------- lyrics ----------
function parseLrc(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    const txt = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text: txt });
  }
  return lines.sort((a, b) => a.t - b.t);
}
async function loadLyrics(t) {
  if (lrcCache.has(t.id)) return lrcCache.get(t.id);
  let out = null;
  if (t.lrc) {
    try {
      const r = await fetch(nasUrl(t.lrc));
      if (r.ok) { const lines = parseLrc(await r.text()); if (lines.length) out = { synced: true, lines }; }
    } catch (e) { /* */ }
  }
  if (!out && t.lyrics) {
    const lines = parseLrc(t.lyrics);
    out = lines.length ? { synced: true, lines } : { synced: false, lines: t.lyrics.split(/\r?\n/).map((text) => ({ t: 0, text })) };
  }
  lrcCache.set(t.id, out);
  return out;
}
async function renderLyrics() {
  const box = $('#np .np-lyrics');
  const t = engine.track;
  if (!t) return;
  box.innerHTML = '<div class="ly-loading"><div class="spinner"></div></div>';
  lyrics = await loadLyrics(t);
  lastLyricIdx = -1;
  if (engine.track !== t) return;
  if (!lyrics) {
    box.innerHTML = html`<div class="ly-none">${icon('lyrics')}<p>No lyrics for this song.</p><small>Add a .lrc file next to the song on your NAS (same name) or embed lyrics in the tags.</small></div>`;
    return;
  }
  box.innerHTML = html`<div class="ly-wrap${lyrics.synced ? ' synced' : ''}">${lyrics.lines.map((l, i) => l.text
    ? html`<p class="ly" data-i="${i}" ${lyrics.synced ? raw(`data-np="seek:${l.t}"`) : ''}>${l.text}</p>`
    : html`<p class="ly gap" data-i="${i}">•••</p>`)}</div>`;
  renderTime();
}

// ---------- gestures ----------
function wireScrubber() {
  const sc = $('#np .scrub');
  let rect, val = 0;
  const pos = (e) => clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const preview = () => {
    const d = engine.duration || 0;
    sc.style.setProperty('--p', val);
    $('#np .t-cur').textContent = fmtTime(val * d);
    $('#np .t-rem').textContent = '-' + fmtTime(d - val * d);
  };
  sc.addEventListener('pointerdown', (e) => {
    if (!engine.track) return;
    rect = sc.getBoundingClientRect();
    dragging = true;
    sc.classList.add('drag');
    sc.setPointerCapture(e.pointerId);
    val = pos(e); preview();
  });
  sc.addEventListener('pointermove', (e) => { if (dragging) { val = pos(e); preview(); } });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sc.classList.remove('drag');
    engine.seek(val * (engine.duration || 0));
    haptic(5);
  };
  sc.addEventListener('pointerup', end);
  sc.addEventListener('pointercancel', end);
}

function wireSwipe() {
  const np = $('#np');
  let y0 = null, dy = 0, t0 = 0;
  np.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('dual') || !open) return;
    const zone = e.target.closest('[data-drag]');
    if (!zone || e.target.closest('button, a, .np-panel, input, .scrub')) return;
    y0 = e.clientY; dy = 0; t0 = performance.now();
    np.classList.add('dragging');
  });
  np.addEventListener('pointermove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    np.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 === null) return;
    np.classList.remove('dragging');
    const v = dy / (performance.now() - t0);
    y0 = null;
    if (dy > 140 || v > 0.6) closeNP(); else np.style.transform = '';
  };
  np.addEventListener('pointerup', end);
  np.addEventListener('pointercancel', end);
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
