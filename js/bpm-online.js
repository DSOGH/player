// Looks a song's tempo up online (Deezer's public catalogue) the first time it's needed and keeps the
// answer on the device forever, so the DJ starts from the real BPM instead of a half-/double-time guess.
// Deezer's API has no CORS headers, so it's read through JSONP (a <script> tag), which needs no key.
import { skv as kv } from './db.js';
import { settings } from './settings.js';

const TTL_MISS = 30 * 864e5;     // retry songs Deezer didn't know after a month
const mem = new Map();
const inflight = new Map();
let seq = 0, last = 0;

const clean = (s) => String(s || '')
  .replace(/\s*[([](feat\.?|ft\.?|with|prod\.?)[^)\]]*[)\]]/gi, '')
  .replace(/\s*[([][^)\]]*(remaster|explicit|clean|version|edit|mono|stereo|deluxe|bonus)[^)\]]*[)\]]/gi, '')
  .replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/i, '')
  .replace(/["]/g, '').trim();
const simp = (s) => clean(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const keyOf = (t) => 'obpm:' + simp(t.artist || t.albumArtist) + '|' + simp(t.title);

function jsonp(url, ms = 7000) {
  return new Promise((res, rej) => {
    const cb = '__dz' + (++seq) + '_' + Date.now().toString(36);
    const s = document.createElement('script');
    const done = (v, e) => { clearTimeout(tm); delete window[cb]; s.remove(); e ? rej(e) : res(v); };
    const tm = setTimeout(() => done(null, new Error('timeout')), ms);
    window[cb] = (d) => done(d);
    s.onerror = () => done(null, new Error('network'));
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    s.referrerPolicy = 'no-referrer';
    document.head.appendChild(s);
  });
}
async function dz(path) {
  // stay well under Deezer's 50 requests / 5 s
  const wait = Math.max(0, last + 160 - Date.now()); last = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const d = await jsonp('https://api.deezer.com/' + path);
  if (d?.error) throw new Error(d.error.message || 'deezer');
  return d;
}

async function fetchOnline(t) {
  const artist = clean(t.artist || t.albumArtist), title = clean(t.title);
  if (!artist || !title) return 0;
  let list = (await dz('search?limit=10&q=' + encodeURIComponent(`artist:"${artist}" track:"${title}"`)))?.data || [];
  if (!list.length) list = (await dz('search?limit=10&q=' + encodeURIComponent(`${artist} ${title}`)))?.data || [];
  const A = simp(artist), T = simp(title), D = t.duration || 0;
  const scored = list.map((r) => {
    const ra = simp(r.artist?.name), rt = simp(r.title_short || r.title);
    let s = 0;
    if (rt === T) s += 4; else if (rt.includes(T) || T.includes(rt)) s += 2; else s -= 3;
    if (ra === A) s += 3; else if (ra && (ra.includes(A) || A.includes(ra))) s += 1.5; else s -= 2;
    if (D && r.duration) { const dd = Math.abs(r.duration - D); s += dd < 3 ? 2 : dd < 8 ? 1 : dd > 30 ? -2 : 0; }
    return { r, s };
  }).filter((x) => x.s >= 3).sort((a, b) => b.s - a.s);
  // the search result has no BPM — read it from the track itself; some versions have 0, so try a few
  const bpms = [];
  for (const { r } of scored.slice(0, 3)) {
    const full = await dz('track/' + r.id).catch(() => null);
    const b = +full?.bpm || 0;
    if (b >= 40 && b <= 250) { bpms.push(b); if (bpms.length >= 2) break; }
  }
  if (!bpms.length) return 0;
  // two versions agreeing is the strongest answer; otherwise the best match wins
  return Math.round(bpms[0] * 10) / 10;
}

// Returns the online BPM (0 = unknown). Never throws; answers instantly from the device once known.
export async function onlineBpm(t) {
  if (!t || t.demo || !settings.get('onlineBpm')) return 0;
  const k = keyOf(t);
  if (mem.has(k)) return mem.get(k);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      const c = await kv.get(k);
      if (c && (c.bpm || Date.now() - c.at < TTL_MISS)) { mem.set(k, c.bpm || 0); return c.bpm || 0; }
      if (!navigator.onLine) return 0;
      const bpm = await fetchOnline(t);
      mem.set(k, bpm);
      kv.set(k, { bpm, at: Date.now() });
      return bpm;
    } catch (e) { return 0; }
    finally { inflight.delete(k); }
  })();
  inflight.set(k, p);
  return p;
}
export function onlineBpmCached(t) { return t ? mem.get(keyOf(t)) : undefined; }

// How a detected tempo relates to a reference one: 1 = same, 2 = detected half-time, 0.5 = double-time, …
export function tempoRelation(detected, ref) {
  if (!detected || !ref) return 0;
  for (const f of [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 3 / 4, 3, 1 / 3]) if (Math.abs((detected * f) / ref - 1) < 0.035) return f;
  return -1; // unrelated
}
