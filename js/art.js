// Artwork: resize, extract palette, store in IndexedDB. Served by the SW at ./__art/<id>
import * as db from './db.js';

const SIZE = 640;
const known = new Set();
let knownLoaded = false;

export async function loadKnown() {
  if (knownLoaded) return;
  (await db.keys('art')).forEach((k) => known.add(k));
  knownLoaded = true;
}
export const hasArt = (id) => known.has(id);
export const artUrl = (id) => (id ? `./__art/${id}` : '');

async function toBitmap(blob) {
  try { return await createImageBitmap(blob); } catch (e) {
    // some formats only decode through <img>
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
async function canvasBlob(c, type, q) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality: q });
  return new Promise((r) => c.toBlob(r, type, q));
}

// palette: [dominant, vibrant, dark] as hex
export function palette(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const buckets = new Map();
  let ar = 0, ag = 0, ab = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    ar += r; ag += g; ab += b; n++;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    e.r += r; e.g += g; e.b += b; e.n++;
    buckets.set(key, e);
  }
  const list = [...buckets.values()].map((e) => {
    const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0, lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { r, g, b, n: e.n, sat, lum };
  });
  list.sort((a, b) => b.n - a.n);
  const dom = list[0] || { r: ar / n, g: ag / n, b: ab / n };
  const vib = [...list].filter((c) => c.lum > 0.18 && c.lum < 0.85)
    .sort((a, b) => b.sat * Math.sqrt(b.n) - a.sat * Math.sqrt(a.n))[0] || dom;
  const dark = [...list].sort((a, b) => a.lum - b.lum)[0] || dom;
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return [hex(dom), hex(vib), hex(dark)];
}

export async function storeArt(id, blob) {
  if (known.has(id)) return id;
  try {
    const bmp = await toBitmap(blob);
    const bw = bmp.width, bh = bmp.height;
    if (!bw || !bh) return null;
    const scale = Math.min(1, SIZE / Math.max(bw, bh));
    const w = Math.round(bw * scale), h = Math.round(bh * scale);
    // square crop to center
    const s = Math.min(w, h);
    const c = canvas(s, s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, (s - w) / 2, (s - h) / 2, w, h);
    const out = await canvasBlob(c, 'image/jpeg', 0.86);
    const sm = canvas(24, 24);
    const sctx = sm.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(c, 0, 0, 24, 24);
    const colors = palette(sctx, 24, 24);
    bmp.close?.();
    await db.put('art', { id, blob: out, colors });
    known.add(id);
    return id;
  } catch (e) {
    console.warn('art failed', e);
    return null;
  }
}

const colorCache = new Map();
export async function artColors(id) {
  if (!id) return null;
  if (colorCache.has(id)) return colorCache.get(id);
  const rec = await db.get('art', id);
  const c = rec?.colors || null;
  colorCache.set(id, c);
  return c;
}
