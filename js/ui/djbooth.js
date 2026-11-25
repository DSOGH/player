// DJ Booth: shows exactly what the DJ is going to do next — and why.
import { html, icon, fmtTime, esc } from '../util.js';
import { engine } from '../engine.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { keyCompat, info, findCue } from '../dj.js';
import { cachedLyrics } from '../lyrics.js';
import { isAnalyzed } from '../analysis.js';
import { art } from './components.js';

const pct = (r) => `${r >= 1 ? '+' : '−'}${Math.abs((r - 1) * 100).toFixed(1)}%`;
const STYLE_ICON = { cook: 'sparkle', acapella: 'lyrics', blend: 'bpm', echo: 'smart', under: 'crossfade', filter: 'eq', crossfade: 'crossfade', gapless: 'gapless' };
const STYLE_NAME = { auto: 'Auto', beats: 'Beat match', wordplay: 'Word play', cook: 'Cook It Up' };

function lineAt(t, time) {
  const L = cachedLyrics(t);
  if (!L?.synced) return null;
  let best = null;
  for (const l of L.lines) { if (l.t <= time + 0.3 && l.text) best = l; else if (l.t > time + 0.3) break; }
  return best;
}

// Plain-English steps for a transition plan
export function explain(p, A, B) {
  if (!p || !A || !B) return [];
  const a = info(A), b = info(B);
  const out = [];
  const kc = keyCompat(a.camelot, b.camelot);
  const keyTxt = a.camelot && b.camelot
    ? `Keys ${a.camelot} → ${b.camelot}: ${kc >= 0.85 ? 'harmonic match — they sound great together' : kc < 0.5 ? 'they clash, so the overlap stays tight' : 'compatible'}`
    : null;
  switch (p.style) {
    case 'cook': {
      const what = {
        tapestop: 'This song grinds to a halt like a tape machine losing power',
        gateroll: 'This song chops into a stutter roll that speeds up into the cut',
        dubecho: `This song is thrown into a dub echo (${p.echoTime ? (p.echoTime / (p.beat || 0.5)).toFixed(2).replace(/\.?0+$/, '') : '¾'} beat repeats) that rings out over the next one`,
        washout: 'A resonant filter sweeps this song away into an echo wash',
        riser: 'A white-noise riser climbs, the beat chops faster, then a sub boom on the drop',
        launch: 'This song speeds up and pitches up like it’s taking off — then a boom',
        chop: 'A quick volume chop on the last beat, then a boom',
        spin: 'The record gets pushed faster, then braked to a stop',
      }[p.cook];
      out.push(what || 'Something wild');
      const beats = Math.round((p.build || 0) / (p.beat || 0.5));
      out.push(`${beats} beat${beats === 1 ? '' : 's'} long, landing exactly on a bar line${p.cutAt < (A.duration || 0) - 20 ? ` — leaving at ${Math.floor(p.cutAt / 60)}:${String(Math.floor(p.cutAt % 60)).padStart(2, '0')}, not the end` : ''}`);
      out.push(p.entry === 'rise' ? 'Next song opens up from a high-pass sweep' : p.entry === 'stutter' ? 'Next song stutters in for a beat' : 'Next song slams straight in');
      out.push('Cook It Up never uses the same move as the last two');
      break;
    }
    case 'blend': {
      const beats = Math.round(p.overlap / (p.beat || 0.5));
      out.push(`Beat-matched overlay — ${beats} beats (${p.overlap.toFixed(1)}s), starting on a bar line`);
      if (p.aRate && Math.abs(p.aRate - 1) > 0.002) out.push(`Tempos meet in the middle: ${Math.round(a.bpm)} → ${Math.round(a.bpm * p.aRate)} ← ${Math.round(b.bpm)} BPM (this song ${pct(p.aRate)}, next ${pct(p.rate)}), pitch stays the same`);
      else if (Math.abs((p.rate || 1) - 1) > 0.002) out.push(`Next song plays at ${pct(p.rate)} to lock to ${Math.round(a.bpm)} BPM, then glides back to normal`);
      else out.push(`Both songs already at ${Math.round(a.bpm)} BPM`);
      if (keyTxt) out.push(keyTxt);
      out.push('Next song comes in with its bass cut — basses swap at the halfway point');
      out.push('High-pass sweep pulls this song’s low end out as it leaves');
      out.push(`Next song drops on its first downbeat (${fmtTime(p.bStart)}); beat lock keeps the kicks within a few ms`);
      break;
    }
    case 'acapella': {
      if (p.handoff) {
        out.push(`Both songs sing “${p.cue.phrase}”`);
        out.push(`At ${fmtTime(p.cue.t)} the beat drops out — this song’s vocal is isolated live: “${p.cue.text}”`);
        if (p.under) out.push(`Underneath, the next song’s instrumental (vocals removed) builds for ${p.under.toFixed(1)}s`);
        out.push(`On “${p.cue.phrase}” the next song takes over singing the same words: “${p.cue.bText}” (${fmtTime(p.bDrop)}) — full mix drops`);
        break;
      }
      out.push(`Word play on “${p.cue.text}” (${fmtTime(p.cue.t)})`);
      out.push('The beat drops out — the vocal is isolated live so only the singer is left');
      out.push(`Cut lands right after “${p.cue.phrase}” (≈${fmtTime(p.phraseEnd)}), the last word echoes out`);
      if (p.under) out.push(`Underneath, the next song’s instrumental (vocals removed) builds for ${p.under.toFixed(1)}s`);
      const ln = lineAt(B, p.bDrop + 0.2);
      out.push(ln ? `Then the full mix drops right on “${ln.text}” (${fmtTime(p.bDrop)})` : `Then the next song drops in full at ${fmtTime(p.bDrop)}`);
      break;
    }
    case 'echo':
      if (p.type === 'wordplay' && p.cue) {
        out.push(`Word play: this song sings “${p.cue.text}” at ${fmtTime(p.cue.t)}`);
        out.push(`That line echoes out (${Math.round(p.echoTime * 1000)} ms delay, in time with the beat)`);
        const ln = lineAt(B, p.bStart + 0.2);
        out.push(ln ? `Next song drops right on “${ln.text}” (${fmtTime(p.bStart)})` : `Next song drops at ${fmtTime(p.bStart)}`);
      } else {
        out.push('This song ends hard — its last beats ring out through a tempo-synced echo');
        out.push(`Next song drops in as the echo trails off${p.bStart > 0.3 ? ` (skipping ${p.bStart.toFixed(1)}s of silence)` : ''}`);
      }
      break;
    case 'under': {
      const an = library.analysis.get(A.id);
      out.push(`This song fades out on its own${an?.fadeOutStart ? ` from ${fmtTime(an.fadeOutStart)}` : ''}`);
      out.push(`Next song slides in underneath over ${p.overlap.toFixed(1)}s, bass held back until it takes over`);
      if (keyTxt) out.push(keyTxt);
      break;
    }
    case 'filter':
      if (a.bpm && b.bpm) out.push(`Tempos too far apart to beat-match (${Math.round(a.bpm)} vs ${Math.round(b.bpm)} BPM)`);
      else out.push('Still learning these songs’ tempos');
      out.push(`Low-pass sweep fades this song out while the next one opens up from a high-pass (${p.overlap.toFixed(1)}s)`);
      break;
    case 'crossfade':
      out.push(`Classic equal-power crossfade, ${p.overlap.toFixed(1)}s`);
      break;
    default:
      out.push(p.label || 'Gapless');
  }
  return out;
}

function deck(t, label, rate = 1) {
  if (!t) return '';
  const i = info(t);
  const an = library.analysis.get(t.id);
  return html`<div class="dj-deck">
    ${art(t.artId, 'sm')}
    <div class="dj-deck-meta"><small>${label}</small><b>${t.title}</b><span>${t.artist}</span>
      <div class="dj-chips">
        ${i.bpm ? html`<span class="dj-chip">${icon('bpm')}${Math.round(i.bpm * rate)} BPM${Math.abs(rate - 1) > 0.002 ? ` (${pct(rate)})` : ''}</span>` : html`<span class="dj-chip dim">BPM…</span>`}
        ${i.camelot ? html`<span class="dj-chip">${i.camelot}</span>` : ''}
        ${an ? html`<span class="dj-energy" title="Energy"><i style="width:${Math.round(i.energy * 100)}%"></i></span>` : ''}
      </div>
    </div>
  </div>`;
}

export function renderBooth(box) {
  const t = engine.track;
  if (!t) { box.innerHTML = ''; return; }
  const p = engine.plan, nx = engine.upcoming?.track;
  const tr = engine.transition;
  const style = settings.get('djStyle');
  const mode = settings.get('transition');
  let trans;
  if (tr) {
    trans = html`<div class="dj-trans live">${icon(STYLE_ICON[tr.plan.style] || 'smart')}<div><b>Mixing now → ${tr.to.track?.title || ''}</b><span>${tr.plan.label}</span><div class="dj-mixbar"><i data-dj-mixbar></i></div></div></div>`;
  } else if (p && nx) {
    const steps = explain(p, t, nx);
    trans = html`<div class="dj-trans">
      <div class="dj-trans-head">${icon(STYLE_ICON[p.style] || 'smart')}<div><b>${p.label}</b><span data-dj-when></span></div></div>
      <div class="dj-timeline" data-dj-tl><i class="dj-tl-now"></i><i class="dj-tl-mix"></i>${p.cue ? html`<i class="dj-tl-cue"></i>` : ''}</div>
      <ol class="dj-steps">${steps.map((s) => html`<li>${s}</li>`)}</ol>
    </div>`;
  } else if (engine.queue.length > engine.index + 1 || settings.get('autoplay')) {
    trans = html`<div class="dj-trans dim"><div class="spinner"></div><div><b>Planning the next mix…</b><span>It’s worked out ~90s before the song ends (tempo, key, lyrics).</span></div></div>`;
  } else trans = html`<div class="dj-trans dim">${icon('info')}<div><b>Nothing up next</b><span>Add songs or turn on Autoplay.</span></div></div>`;

  // preview the following transitions
  const q = engine.queue, prev = [];
  for (let i = engine.index + 1; i + 1 < q.length && prev.length < 4; i++) {
    const A = library.track(q[i]), B = library.track(q[i + 1]);
    if (!A || !B) continue;
    let label;
    if (!isAnalyzed(A) || !isAnalyzed(B)) label = 'decided when it gets closer';
    else { try { label = engine.makePlan(A, B, A.duration).label; } catch (e) { label = '—'; } }
    const cue = style !== 'beats' ? findCue(A, B) : null;
    prev.push(html`<li><span class="dj-pv-t">${A.title} → ${B.title}</span><span class="dj-pv-l">${cue ? `Word play · “${cue.phrase}”` : label}</span></li>`);
  }
  const wk = library.weekStats();
  box.innerHTML = html`
    <div class="q-head"><b>DJ Booth</b>
      <span class="q-tools">
        <button class="pill-sm${mode === 'smart' ? ' on' : ''}" data-np="mode">${mode === 'smart' ? 'DJ Mix' : mode === 'crossfade' ? 'Crossfade' : 'Gapless'}</button>
        ${mode === 'smart' ? html`<button class="pill-sm" data-np="dj-style">${STYLE_NAME[style]}</button>` : ''}
      </span></div>
    ${deck(t, 'Now playing', engine.cur.el.playbackRate || 1)}
    ${trans}
    ${nx ? deck(nx, 'Up next', p?.rate || 1) : ''}
    ${prev.length ? html`<div class="dj-sub">Coming up</div><ol class="dj-preview">${prev}</ol>` : ''}
    <div class="dj-actions">
      <button class="pill-sm dj" data-np="dj-order">${icon('mix')}DJ Order</button>
      <button class="pill-sm" data-np="dj-prep">${icon('bpm')}Analyze upcoming</button>
    </div>
    <div class="dj-foot">${wk.mixes} mixes this week · ${Math.floor(wk.minutes / 60)}h ${wk.minutes % 60}m listened</div>`.toString();
  tickBooth(box);
}

export function tickBooth(box) {
  const tr = engine.transition, bar = box.querySelector('[data-dj-mixbar]');
  if (tr && bar) bar.style.transform = `scaleX(${tr.total ? Math.min(1, (performance.now() - tr.at) / tr.total) : 0})`;
  // the booth still shows a finished mix (or a new plan arrived): redraw
  if ((!tr && bar) || (tr && box.querySelector('[data-dj-when]'))) { renderBooth(box); return; }
  const p = engine.plan;
  const el = box.querySelector('[data-dj-when]');
  if (!p || !el) return;
  const t = engine.currentTime, dur = engine.duration || 1;
  const left = (p.mixStart - t) / (engine.cur.el.playbackRate || 1);
  el.textContent = left > 0 ? `Starts in ${fmtTime(left)} · at ${fmtTime(p.mixStart)}` : 'Starting…';
  const tl = box.querySelector('[data-dj-tl]');
  if (tl) {
    const from = Math.max(0, Math.min(t, p.mixStart) - 20), to = Math.min(dur, p.mixStart + (p.overlap || 4) * (p.aRate || 1) + 8);
    const span = Math.max(1, to - from);
    const x = (v) => `${Math.max(0, Math.min(100, ((v - from) / span) * 100))}%`;
    tl.querySelector('.dj-tl-now').style.left = x(t);
    const mix = tl.querySelector('.dj-tl-mix');
    mix.style.left = x(p.mixStart);
    mix.style.width = `calc(${x(p.mixStart + (p.overlap || 0.3) * (p.aRate || 1))} - ${x(p.mixStart)})`;
    const cue = tl.querySelector('.dj-tl-cue');
    if (cue && p.cue) cue.style.left = x(p.cue.t);
  }
}
