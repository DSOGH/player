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

// a computer (Chrome, Brave, Edge, Safari, Firefox — touchscreen laptops included): not a phone/tablet
// browser, and it has a mouse or trackpad. Can be forced in Settings → Appearance.
function isDesktop() {
  const forced = settings.get('layoutMode');
  if (forced === 'desktop') return true;
  if (forced === 'mobile') return false;
  const ua = navigator.userAgent;
  if (navigator.userAgentData && navigator.userAgentData.mobile === false && !/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return false;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return false; // iPad asking for the desktop site
  return mq('(any-pointer: fine)') || mq('(hover: hover)') || !mq('(pointer: coarse)');
}
export function detect() {
  const body = document.body;
  const root = document.documentElement;
  const pref = settings.get('dualScreen');
  // ultrawide monitors: optionally keep the whole app in a centered frame
  const frame = isDesktop() && settings.get('deskFrame') === 'centered' ? Math.min(innerWidth, 2560) : innerWidth;
  document.documentElement.style.setProperty('--frame-w', frame + 'px');
  document.body.classList.toggle('frame-centered', frame < innerWidth);
  const W = frame, H = innerHeight;
  let mode = 'single', device = '', leftW = 0, hinge = 0, topH = 0;
  const segs0 = segments();
  if (pref !== 'off' || (isDesktop() && !segs0)) {
    const segs = pref !== 'off' ? segs0 : null;
    const DESK = isDesktop();
    if (DESK && W >= 900 && !segs) {
      // computer: sidebar + library in the middle + a player column on the right
      mode = 'wide'; device = 'Desktop';
      const pw = { narrow: [340, 0.24, 400], normal: [380, 0.3, 480], wide: [460, 0.36, 620] }[settings.get('deskPlayerW')] || [380, 0.3, 480];
      const uw = W / H >= 2.1 ? 1.2 : 1; // ultrawide: player column a little wider
      leftW = Math.round(W - Math.min(pw[2] * uw, Math.max(pw[0] * uw, W * pw[1])));
    } else if (segs) {
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
        mode = 'h'; device = 'iPhone Duo'; leftW = '50%'; hinge = 0;
      } else if (IPHONE && H >= 760 && W >= 560 && H > W) {
        // iPhone Duo inner display rotated: fold runs across the middle
        mode = 'v'; device = 'iPhone Duo'; topH = '50%'; hinge = 0;
      } else if (mq('(horizontal-viewport-segments: 2)') || mq('(spanning: single-fold-vertical)')) { mode = 'h'; device = 'Dual screen'; }
      else if (mq('(vertical-viewport-segments: 2)') || mq('(spanning: single-fold-horizontal)')) { mode = 'v'; device = 'Dual screen'; }
      else if (TOUCH && W >= 740 && H >= 500 && W > H * 1.15) {
        // other foldables / tablets in landscape: split down the middle (where a fold would be)
        mode = 'h'; device = 'Foldable'; leftW = '50%'; hinge = 0;
      } else if (W >= 900 && W > H * 1.1) {
        mode = 'wide'; device = 'Wide screen';
        leftW = Math.round(Math.min(W * 0.55, Math.max(420, W - 520)));
      }
    }
    if (mode === 'h' || mode === 'v') {
      const manualHinge = settings.get('dualHinge');
      if (manualHinge >= 0) hinge = manualHinge;
      const shift = settings.get('dualShift') || 0;
      // a fold down the exact middle stays a percentage, so it can never go stale while the phone rotates
      const add = (v, px) => (typeof v === 'string' ? (px ? `calc(${v} + ${px}px)` : v) : v + px);
      if (mode === 'h' && leftW) leftW = add(leftW, shift);
      if (mode === 'v' && topH) topH = add(topH, shift);
      if (pref === 'span') { // one layout across the hinge: split at the visual middle, no gap
        if (mode === 'h' && leftW) leftW = add(leftW, hinge / 2);
        if (mode === 'v' && topH) topH = add(topH, hinge / 2);
        hinge = 0;
      }
    }
  }
  body.classList.toggle('dual', mode !== 'single');
  body.classList.toggle('dual-h', mode === 'h' || mode === 'wide');
  body.classList.toggle('dual-v', mode === 'v');
  body.classList.toggle('dual-wide', mode === 'wide');
  body.classList.toggle('desk', device === 'Desktop');
  body.classList.toggle('desk-side', device === 'Desktop' && settings.get('deskSidebar') !== false);
  body.dataset.deskWidth = settings.get('deskWidth') || 'comfortable';
  body.classList.toggle('ultrawide', innerWidth >= 2000 || innerWidth / H >= 2.1);
  body.classList.toggle('dual-duo', /Duo/.test(device));
  body.classList.toggle('dual-swap', mode !== 'single' && !!settings.get('dualSwap'));
  const css = (v) => (typeof v === 'string' ? v : v + 'px');
  if (leftW) root.style.setProperty('--seg-w', css(leftW)); else root.style.removeProperty('--seg-w');
  if (topH) root.style.setProperty('--seg-h', css(topH)); else root.style.removeProperty('--seg-h');
  root.style.setProperty('--hinge', hinge + 'px');
  current = { mode, device, leftW, hinge, topH };
  const key = `${mode}:${leftW}:${hinge}:${topH}`;
  if (key !== last) { last = key; cb(mode); }
  return mode;
}

export function initDual(onChange) {
  cb = onChange;
  const run = () => requestAnimationFrame(detect);
  // iPhone reports the new size in stages while rotating: check again until it settles
  let settle = [];
  const runSettled = () => { run(); settle.forEach(clearTimeout); settle = [120, 350, 700, 1200].map((ms) => setTimeout(run, ms)); };
  addEventListener('resize', runSettled);
  addEventListener('orientationchange', runSettled);
  screen.orientation?.addEventListener?.('change', runSettled);
  try { new ResizeObserver(run).observe(document.documentElement); } catch (e) { /* */ }
  window.visualViewport?.addEventListener('resize', run);
  window.viewport?.addEventListener?.('segmentschange', run);
  for (const q of ['(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)', '(spanning: single-fold-vertical)', '(spanning: single-fold-horizontal)']) {
    try { matchMedia(q).addEventListener('change', run); } catch (e) { /* */ }
  }
  for (const k of ['dualScreen', 'dualShift', 'dualHinge', 'dualSwap']) settings.on(`change:${k}`, run);
  detect();
}
