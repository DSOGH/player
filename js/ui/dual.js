// Dual-screen (Surface Duo / Duo 2 / foldables) and wide-screen two-pane layout.
// Order of detection:
//  1. Viewport Segments API (window.viewport.segments, visualViewport.segments, getWindowSegments)
//  2. Surface Duo by exact screen size (Chrome hides the phone model from websites):
//       Duo   : 1114 CSS px spanned = 540 + 34 hinge + 540   (double-landscape: 720 wide)
//       Duo 2 : ~1101.6 CSS px      = 537.6 + 26.4 + 537.6   (double-landscape: ~757 wide)
//  3. CSS spanning media queries
//  4. tablets/desktop: plain two-pane
// Settings: dualScreen 'auto' (split at the hinge) | 'span' (one layout across the hinge) | 'off',
//           dualShift (nudge the split, px), dualHinge (hinge width override, px; -1 = auto)
import { settings } from '../settings.js';

let cb = () => {};
let last = '';
export let current = { mode: 'single', device: '', leftW: 0, hinge: 0, topH: 0 };

function segments() {
  try {
    if (window.viewport?.segments?.length > 1) return window.viewport.segments;
    if (window.visualViewport?.segments?.length > 1) return window.visualViewport.segments;
    if (typeof window.getWindowSegments === 'function') {
      const s = window.getWindowSegments();
      if (s?.length > 1) return s;
    }
  } catch (e) { /* */ }
  return null;
}
const mq = (q) => { try { return matchMedia(q).matches; } catch (e) { return false; } };
const near = (v, target, tol) => Math.abs(v - target) <= tol;
const IPHONE = /iPhone/.test(navigator.userAgent);
const TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

// Surface Duo models by spanned size. Returns { device, seg, hinge } for the long axis.
function duoModel(long) {
  if (near(long, 1114, 4)) return { device: 'Surface Duo', seg: 540, hinge: 34 };
  if (near(long, 1101, 5)) return { device: 'Surface Duo 2', seg: 537.6, hinge: long - 1075.2 };
  return null;
}

export function detect() {
  const body = document.body;
  const root = document.documentElement;
  const pref = settings.get('dualScreen');
  const W = innerWidth, H = innerHeight;
  let mode = 'single', device = '', leftW = 0, hinge = 0, topH = 0;
  if (pref !== 'off') {
    const segs = segments();
    if (segs) {
      const [a, b] = segs;
      device = 'Dual screen';
      if (Math.abs(a.top - b.top) < 2) { mode = 'h'; leftW = a.width; hinge = Math.max(0, b.left - (a.left + a.width)); }
      else { mode = 'v'; topH = a.height; hinge = Math.max(0, b.top - (a.top + a.height)); }
    } else {
      const sw = Math.max(screen.width, W), sh = Math.max(screen.height, H);
      const duoH = W > H ? duoModel(Math.round(Math.max(W, sw))) : null;
      const duoV = H > W ? duoModel(Math.round(Math.max(sh, H))) : null;
      if (duoH && W >= 1000) {
        mode = 'h'; device = duoH.device; leftW = duoH.seg; hinge = duoH.hinge;
      } else if (duoV && H >= 1000 && W < 800) {
        // double-landscape: the status bar sits on the top screen, so the top segment is shorter by that much
        mode = 'v'; device = duoV.device; hinge = duoV.hinge;
        topH = duoV.seg - (Math.max(sh, H) - H >= 16 ? 24 : 0); // status bar (24dp) is on the top screen
      } else if (IPHONE && W >= 600 && H >= 520 && W > H) {
        // iPhone Duo inner display (passport-style, ~890×626 CSS px): one seamless screen, fold down the middle
        mode = 'h'; device = 'iPhone Duo'; leftW = W / 2; hinge = 0;
      } else if (IPHONE && H >= 760 && W >= 560 && H > W) {
        // iPhone Duo inner display rotated: fold runs across the middle
        mode = 'v'; device = 'iPhone Duo'; topH = H / 2; hinge = 0;
      } else if (mq('(horizontal-viewport-segments: 2)') || mq('(spanning: single-fold-vertical)')) { mode = 'h'; device = 'Dual screen'; }
      else if (mq('(vertical-viewport-segments: 2)') || mq('(spanning: single-fold-horizontal)')) { mode = 'v'; device = 'Dual screen'; }
      else if (TOUCH && W >= 740 && H >= 500 && W > H * 1.15) {
        // other foldables / tablets in landscape: split down the middle (where a fold would be)
        mode = 'h'; device = 'Foldable'; leftW = W / 2; hinge = 0;
      } else if (W >= 900 && W > H * 1.1) {
        mode = 'wide'; device = 'Wide screen';
        leftW = Math.round(Math.min(W * 0.55, Math.max(420, W - 520)));
      }
    }
    if (mode === 'h' || mode === 'v') {
      const manualHinge = settings.get('dualHinge');
      if (manualHinge >= 0) hinge = manualHinge;
      const shift = settings.get('dualShift') || 0;
      if (mode === 'h' && leftW) leftW += shift;
      if (mode === 'v' && topH) topH += shift;
      if (pref === 'span') { // one layout across the hinge: split at the visual middle, no gap
        if (mode === 'h' && leftW) leftW += hinge / 2;
        if (mode === 'v' && topH) topH += hinge / 2;
        hinge = 0;
      }
    }
  }
  body.classList.toggle('dual', mode !== 'single');
  body.classList.toggle('dual-h', mode === 'h' || mode === 'wide');
  body.classList.toggle('dual-v', mode === 'v');
  body.classList.toggle('dual-wide', mode === 'wide');
  body.classList.toggle('dual-duo', /Duo/.test(device));
  body.classList.toggle('dual-swap', mode !== 'single' && !!settings.get('dualSwap'));
  if (leftW) root.style.setProperty('--seg-w', leftW + 'px'); else root.style.removeProperty('--seg-w');
  if (topH) root.style.setProperty('--seg-h', topH + 'px'); else root.style.removeProperty('--seg-h');
  root.style.setProperty('--hinge', hinge + 'px');
  current = { mode, device, leftW, hinge, topH };
  const key = `${mode}:${leftW}:${hinge}:${topH}`;
  if (key !== last) { last = key; cb(mode); }
  return mode;
}

export function initDual(onChange) {
  cb = onChange;
  const run = () => requestAnimationFrame(detect);
  addEventListener('resize', run);
  addEventListener('orientationchange', () => setTimeout(run, 250));
  window.visualViewport?.addEventListener('resize', run);
  window.viewport?.addEventListener?.('segmentschange', run);
  for (const q of ['(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)', '(spanning: single-fold-vertical)', '(spanning: single-fold-horizontal)']) {
    try { matchMedia(q).addEventListener('change', run); } catch (e) { /* */ }
  }
  for (const k of ['dualScreen', 'dualShift', 'dualHinge', 'dualSwap']) settings.on(`change:${k}`, run);
  detect();
}
