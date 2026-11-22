// Dual-screen (Surface Duo / foldables) and wide-screen two-pane layout.
// Uses the Viewport Segments API, the older getWindowSegments() (Edge on Duo),
// the CSS spanning media queries, and falls back to a width check for tablets/desktop.
import { settings } from '../settings.js';

let cb = () => {};
let last = '';

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

export function detect() {
  const body = document.body;
  const root = document.documentElement;
  let mode = 'single';
  let leftW = 0, hinge = 0, topH = 0;
  if (settings.get('dualScreen') !== 'off') {
    const segs = segments();
    if (segs) {
      const [a, b] = segs;
      if (Math.abs(a.top - b.top) < 2) {
        mode = 'h';
        leftW = a.width;
        hinge = Math.max(0, b.left - (a.left + a.width));
      } else {
        mode = 'v';
        topH = a.height;
        hinge = Math.max(0, b.top - (a.top + a.height));
      }
    } else if (mq('(horizontal-viewport-segments: 2)') || mq('(spanning: single-fold-vertical)')) mode = 'h';
    else if (mq('(vertical-viewport-segments: 2)') || mq('(spanning: single-fold-horizontal)')) mode = 'v';
    else if (/Surface Duo/i.test(navigator.userAgent) && innerWidth > 1000) {
      // Duo spanned without segment APIs: two equal screens around a fixed hinge (Duo 1: 34px, Duo 2: 26px)
      mode = 'h';
      hinge = innerWidth < 1140 ? 34 : 26;
      leftW = Math.round((innerWidth - hinge) / 2);
    } else if (/Surface Duo/i.test(navigator.userAgent) && innerHeight > 1000 && innerHeight > innerWidth) {
      mode = 'v';
      hinge = innerHeight < 1140 ? 34 : 26;
      topH = Math.round((innerHeight - hinge) / 2);
    } else if (innerWidth >= 900 && innerWidth > innerHeight * 1.1) {
      mode = 'wide';
      leftW = Math.round(Math.min(innerWidth * 0.55, Math.max(420, innerWidth - 520)));
    }
  }
  body.classList.toggle('dual', mode !== 'single');
  body.classList.toggle('dual-h', mode === 'h' || mode === 'wide');
  body.classList.toggle('dual-v', mode === 'v');
  body.classList.toggle('dual-wide', mode === 'wide');
  if (leftW) root.style.setProperty('--seg-w', leftW + 'px'); else root.style.removeProperty('--seg-w');
  if (topH) root.style.setProperty('--seg-h', topH + 'px'); else root.style.removeProperty('--seg-h');
  root.style.setProperty('--hinge', hinge + 'px');
  const key = `${mode}:${leftW}:${hinge}:${topH}`;
  if (key !== last) { last = key; cb(mode); }
  return mode;
}

export function initDual(onChange) {
  cb = onChange;
  const run = () => requestAnimationFrame(detect);
  addEventListener('resize', run);
  addEventListener('orientationchange', run);
  window.visualViewport?.addEventListener('resize', run);
  window.viewport?.addEventListener?.('segmentschange', run);
  for (const q of ['(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)', '(spanning: single-fold-vertical)', '(spanning: single-fold-horizontal)']) {
    try { matchMedia(q).addEventListener('change', run); } catch (e) { /* */ }
  }
  settings.on('change:dualScreen', run);
  detect();
}
