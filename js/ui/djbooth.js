// DJ Booth: shows exactly what the DJ is going to do next — and why.
import { html, icon, fmtTime, esc } from '../util.js';
import { engine } from '../engine.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { keyCompat, info, findCue } from '../dj.js';
import { cachedLyrics } from '../lyrics.js';
import { isAnalyzed } from '../analysis.js';
import { art } from './components.js';
import { brain } from '../dj-brain.js';
import { soundSim } from '../sound-ai.js';

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
        cut: 'The last beat of this song is thrown into an echo and the next song lands on the 1 underneath it',
        roll: 'This song’s beat loops and rolls — 1, ½, ¼, ⅛ — tighter and tighter into the cut',
        brake: 'Vinyl brake: the platter stops and the pitch drops, then the next song hits',
        backspin: 'Spin-back: the record is pulled backwards, then the next song hits on the 1',
        dub: 'This song is thrown into a dub echo that rings out over the next one',
        riser: 'A noise riser climbs while the beat chops faster, then the drop',
        washout: 'A resonant filter sweeps this song away into an echo wash while the next opens up',
      }[p.cook];
      out.push(what || 'Something wild');
      const beats = Math.round((p.build || 0) / (p.beat || 0.5));
      out.push(`${beats} beat${beats === 1 ? '' : 's'} long, landing exactly on a bar line${p.cutAt < (A.duration || 0) - 20 ? ` — leaving at ${Math.floor(p.cutAt / 60)}:${String(Math.floor(p.cutAt % 60)).padStart(2, '0')}, not the end` : ''}`);
      out.push(p.entry === 'rise' ? 'Next song opens up from a high-pass sweep' : 'Next song slams straight in');
      if (p.sync && Math.abs((p.rate || 1) - 1) > 0.002) out.push(`Next song is tempo-matched (${pct(p.rate)}) so the beat carries straight through, then eases back to its own speed`);
      out.push('Cook It Up never uses the same move as the last two');
      break;
    }
    case 'blend': {
      const beats = Math.round(p.overlap / (p.beat || 0.5));
      out.push(`Beat-matched overlay — ${beats} beats (${p.overlap.toFixed(1)}s), starting on a bar line`);
      if (p.stems === 'avb') out.push('Vocal bridge: this song’s beat slips away and its vocal keeps singing over the next song’s beat, then bows out as the next song takes over');
      if (p.stems === 'bva') out.push('Beat swap: the next song’s vocal comes in over this song’s beat, then the beats swap with the bass and it’s the next song in full');
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
  // the AI DJ: how alike the two sound, their moods, and what it has learned you like
  const aA = library.analysis.get(A.id), aB = library.analysis.get(B.id);
  const sim = soundSim(aA, aB);
  if (sim != null) {
    const mood = (x) => [x.party >= 0.6 && 'party', x.dance >= 0.6 && 'danceable', x.aggr >= 0.6 && 'hard', x.relax >= 0.6 && 'chill', x.happy >= 0.6 && 'happy'].filter(Boolean).join(', ') || 'mellow';
    out.push(`Sound AI: they sound ${sim >= 0.9 ? 'very alike' : sim >= 0.8 ? 'alike' : sim >= 0.7 ? 'related' : 'different'} (${Math.max(0, Math.round(sim * 100))}%) · ${mood(aA.ai)} → ${mood(aB.ai)}`);
  }
  const sm = brain.summary();
  if (sm) out.push(`Taste AI (learned from ${sm.n} mixes)${sm.likes.length ? `: you like ${sm.likes.join(' and ')}` : ''}${sm.dislikes.length ? `${sm.likes.length ? ', ' : ': '}not ${sm.dislikes.join(' or ')}` : ''}`);
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

// the next mix as a picture: both songs' energy around the mix, the overlap shaded
function energyCurve(p, A, B) {
  const aA = library.analysis.get(A.id), aB = library.analysis.get(B.id);
  if (!aA?.loud || !p || p.mixStart == null) return '';
  const ovT = (p.overlap || 4) * (p.aRate || 1);
  const from = Math.max(0, p.mixStart - 24), to = Math.min(A.duration || p.mixStart + ovT + 10, p.mixStart + ovT + 10);
  const W = 300, H = 64, span = Math.max(1, to - from);
  const X = (t) => (((t - from) / span) * W).toFixed(1);
  const Y = (v) => (H - 4 - (Math.max(0, Math.min(100, v)) / 100) * (H - 10)).toFixed(1);
  // energy around a moment (smoothed over ~3 s, so it reads as a shape, not a scribble)
  const at = (an, t) => { const L = an?.loud; if (!L) return null; const i = Math.round(t * 2); if (i < 0 || i >= L.length) return null; let s2 = 0, c = 0; for (let j = Math.max(0, i - 3); j <= Math.min(L.length - 1, i + 3); j++) { s2 += L[j]; c++; } return s2 / c; };
  const ptsA = [], ptsB = [];
  for (let t = from; t <= to; t += 0.5) {
    const va = at(aA, t); if (va != null && t <= p.mixStart + ovT) ptsA.push(`${X(t)},${Y(va)}`);
    if (aB?.loud && t >= p.mixStart) { const tb = (p.bStart || 0) + ((t - p.mixStart) / (p.aRate || 1)) * (p.rate || 1); const vb = at(aB, tb); if (vb != null) ptsB.push(`${X(t)},${Y(vb)}`); }
  }
  return html`<svg class="djb-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <rect x="${X(p.mixStart)}" y="0" width="${(X(p.mixStart + ovT) - X(p.mixStart)).toFixed(1)}" height="${H}" rx="6" class="djb-ov"/>
    ${ptsA.length > 1 ? html`<polyline points="${ptsA.join(' ')}" class="djb-a"/>` : ''}
    ${ptsB.length > 1 ? html`<polyline points="${ptsB.join(' ')}" class="djb-b"/>` : ''}
    <line data-dj-now x1="0" x2="0" y1="0" y2="${H}" class="djb-now"/>
  </svg>`;
}
function card(t, label, rate = 1, cls = '') {
  if (!t) return '';
  const i = info(t);
  return html`<div class="djb-card ${cls}">
    <div class="djb-art">${art(t.artId, 'sm')}</div>
    <small>${label}</small><b>${t.title}</b><span>${t.artist}</span>
    <div class="djb-tags">
      ${i.bpm ? html`<em>${Math.round(i.bpm * rate)}<i>BPM</i></em>` : html`<em class="dim">…<i>BPM</i></em>`}
      ${i.camelot ? html`<em>${i.camelot}<i>KEY</i></em>` : ''}
      ${library.analysis.get(t.id) ? html`<em class="djb-en"><span style="--e:${Math.round(i.energy * 100)}%"></span><i>ENERGY</i></em>` : ''}
    </div>
  </div>`;
}
// how well two songs fit (cheap: tempo + key + energy), for the set list
function fit(A, B) {
  const a = info(A), b = info(B);
  let sc = 0, n = 0;
  if (a.bpm && b.bpm) { let r = b.bpm / a.bpm; if (r > 1.4) r /= 2; else if (r < 0.7) r *= 2; sc += Math.abs(r - 1) <= 0.03 ? 1 : Math.abs(r - 1) <= 0.06 ? 0.5 : 0; n++; }
  if (a.camelot && b.camelot) { sc += keyCompat(a.camelot, b.camelot) >= 0.85 ? 1 : keyCompat(a.camelot, b.camelot) >= 0.6 ? 0.5 : 0; n++; }
  if (library.analysis.get(A.id) && library.analysis.get(B.id)) { sc += Math.abs(a.energy - b.energy) < 0.15 ? 1 : Math.abs(a.energy - b.energy) < 0.3 ? 0.5 : 0; n++; }
  return n ? sc / n : null;
}

export function renderBooth(box) {
  const t = engine.track;
  if (!t) { box.innerHTML = ''; return; }
  const p = engine.plan, nx = engine.upcoming?.track;
  const tr = engine.transition;
  const style = settings.get('djStyle');
  const mode = settings.get('transition');
  const parts = String((tr ? tr.plan : p)?.label || '').split(' · ');
  const name = parts[0] === 'Cook It Up' ? parts[1] : parts[0];
  const rest = parts.slice(parts[0] === 'Cook It Up' ? 2 : 1).join(' · ');
  let bridge;
  if (tr) {
    bridge = html`<div class="djb-bridge live"><div class="djb-ring" data-dj-ring><span>${icon('mix')}</span></div><b>Mixing now</b><small>${name}</small></div>`;
  } else if (p && nx) {
    bridge = html`<div class="djb-bridge"><div class="djb-ring" data-dj-ring><span data-dj-when>…</span></div><b>${name || 'Mix'}</b><small>${rest}</small>${p.style !== 'gapless' ? html`<button class="hear-mix" data-np="hear-mix">Hear it</button>` : ''}</div>`;
  } else {
    bridge = html`<div class="djb-bridge dim"><div class="djb-ring"><span>${engine.queue.length > engine.index + 1 || settings.get('autoplay') ? html`<i class="spinner"></i>` : icon('info')}</span></div><b>${engine.queue.length > engine.index + 1 || settings.get('autoplay') ? 'Planning…' : 'Nothing next'}</b><small>${engine.queue.length > engine.index + 1 ? 'Worked out about 90 s before the end' : 'Add songs or turn on Autoplay'}</small></div>`;
  }
  const B = tr ? tr.to.track : nx;
  // the set: what's coming, and how well each step fits
  const q = engine.queue, set = [];
  for (let i = engine.index + (nx ? 2 : 1), prev = nx || t; i < q.length && set.length < 5; i++) {
    const x = library.track(q[i]); if (!x) continue;
    const f = fit(prev, x);
    set.push(html`<li>${art(x.artId, 'sm')}<span class="djb-st"><b>${x.title}</b><small>${x.artist}</small></span>${f == null ? html`<i class="djb-fit q" title="Not analyzed yet"></i>` : html`<i class="djb-fit ${f >= 0.75 ? 'g' : f >= 0.45 ? 'y' : 'r'}" title="Fit with the song before"></i>`}</li>`);
    prev = x;
  }
  const wk = library.weekStats();
  box.innerHTML = html`<div class="djb">
    <div class="djb-head"><b>${engine.cookMode ? (engine.context?.name || 'DJ Cook It Up') : 'DJ'}</b>
      <span class="q-tools">
        <button class="pill-sm${mode === 'smart' ? ' on' : ''}" data-np="mode">${mode === 'smart' ? 'DJ Mix' : mode === 'crossfade' ? 'Crossfade' : 'Gapless'}</button>
        ${mode === 'smart' && !engine.cookMode ? html`<button class="pill-sm" data-np="dj-style">${STYLE_NAME[style]}</button>` : ''}
      </span></div>
    <div class="djb-decks">
      ${card(tr ? tr.from.track || t : t, tr ? 'Out' : 'Now', (tr ? tr.from : engine.cur).el?.playbackRate || 1, 'a')}
      ${bridge}
      ${B ? card(B, tr ? 'In' : 'Next', p?.rate || 1, 'b') : html`<div class="djb-card b empty"><small>Next</small><b>—</b></div>`}
    </div>
    ${!tr && p && nx ? energyCurve(p, t, nx) : ''}
    ${!tr && p && nx ? html`<details class="djb-why"><summary>Why this mix</summary><ol>${explain(p, t, nx).map((x) => html`<li>${x}</li>`)}</ol></details>` : ''}
    ${set.length ? html`<div class="djb-sub">${engine.cookMode ? 'In the set' : 'Coming up'}</div><ol class="djb-set">${set}</ol>` : ''}
    <div class="dj-actions">
      <button class="pill-sm dj" data-np="dj-order">${icon('mix')}DJ Order</button>
      <button class="pill-sm" data-np="dj-prep">${icon('bpm')}Analyze upcoming</button>
    </div>
    <div class="dj-foot">${wk.mixes} mixes this week · ${Math.floor(wk.minutes / 60)}h ${wk.minutes % 60}m listened</div>
  </div>`.toString();
  tickBooth(box);
}

export function tickBooth(box) {
  const tr = engine.transition, ring = box.querySelector('[data-dj-ring]');
  const live = !!box.querySelector('.djb-bridge.live');
  // a mix started or finished (or a new plan arrived): redraw
  if (!!tr !== live) { renderBooth(box); return; }
  if (tr) { if (ring) ring.style.setProperty('--p', tr.total ? Math.min(1, (performance.now() - tr.at) / tr.total) : 0); return; }
  const p = engine.plan, el = box.querySelector('[data-dj-when]');
  if (!p || !el) return;
  const t = engine.currentTime;
  const left = (p.mixStart - t) / (engine.cur.el.playbackRate || 1);
  el.textContent = left > 0 ? fmtTime(left) : 'now';
  if (ring) ring.style.setProperty('--p', Math.max(0, Math.min(1, 1 - left / 90)));
  const now = box.querySelector('[data-dj-now]');
  if (now) {
    const ovT = (p.overlap || 4) * (p.aRate || 1);
    const from = Math.max(0, p.mixStart - 24), to = Math.min(engine.duration || p.mixStart + ovT + 10, p.mixStart + ovT + 10);
    const x = Math.max(0, Math.min(300, ((t - from) / Math.max(1, to - from)) * 300)).toFixed(1);
    now.setAttribute('x1', x); now.setAttribute('x2', x);
  }
}
