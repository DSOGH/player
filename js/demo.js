// Demo library: generated music so the app (transitions, BPM, EQ...) can be tried before connecting a NAS.
import * as db from './db.js';
import { storeArt } from './art.js';

const ALBUMS = [
  {
    title: 'Neon Harbor', artist: 'Midnight Static', year: 2024, genre: 'House', colors: ['#ff3d77', '#6a00ff', '#120024'],
    tracks: [
      { title: 'Afterglow', bpm: 124, dur: 72, root: 45, style: 'house', lead: 0.8, fadeIn: 2, fadeOut: 9, tail: 1.5, melody: 1, drumsIn: 4 },
      { title: 'Signal Fire', bpm: 124, dur: 66, root: 48, style: 'house', fadeOut: 0.3, melody: 1 },
      { title: 'Low Tide', bpm: 122, dur: 70, root: 43, style: 'house', fadeIn: 6, fadeOut: 10, melody: 1, drumsIn: 8 },
    ],
  },
  {
    title: 'Slow Satellites', artist: 'Aurora Vale', year: 2023, genre: 'Chillout', colors: ['#00c6ff', '#0072ff', '#001a33'],
    tracks: [
      { title: 'Paper Moons', bpm: 86, dur: 74, root: 50, style: 'chill', lead: 2.5, fadeIn: 5, fadeOut: 12, tail: 2, melody: 1, melodyIn: 4 },
      { title: 'Glasshouse', bpm: 90, dur: 68, root: 47, style: 'chill', fadeIn: 4, fadeOut: 8, melody: 1 },
      { title: 'Northbound', bpm: 92, dur: 64, root: 52, style: 'chill', fadeOut: 6, tail: 3, melody: 1 },
    ],
  },
  {
    title: 'Concrete Bloom', artist: 'The Loud Hours', year: 2025, genre: 'Rock', colors: ['#f7971e', '#d92b2b', '#2b0b00'],
    tracks: [
      { title: 'Open Wire', bpm: 132, dur: 62, root: 40, style: 'rock', fadeOut: 0.2, melody: 1, tail: 0.6 },
      { title: 'Hollow Crown', bpm: 128, dur: 66, root: 42, style: 'rock', lead: 1.2, fadeOut: 5, melody: 1 },
    ],
  },
  {
    title: 'Velocity', artist: 'Kilo Drift', year: 2022, genre: 'Drum & Bass', colors: ['#00f5a0', '#00d9f5', '#00241a'],
    tracks: [
      { title: 'Breakpoint', bpm: 172, dur: 60, root: 41, style: 'dnb', fadeIn: 3, fadeOut: 7, melody: 1, drumsIn: 3 },
      { title: 'Night Bus', bpm: 174, dur: 58, root: 44, style: 'dnb', fadeOut: 8, melody: 1 },
    ],
  },
];

async function makeCover(title, artist, colors, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = 640;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 640, 640);
  g.addColorStop(0, colors[0]); g.addColorStop(0.55, colors[1]); g.addColorStop(1, colors[2]);
  x.fillStyle = g; x.fillRect(0, 0, 640, 640);
  let s = seed;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  x.globalCompositeOperation = 'overlay';
  for (let i = 0; i < 7; i++) {
    const rad = 80 + r() * 260;
    const rg = x.createRadialGradient(r() * 640, r() * 640, 0, r() * 640, r() * 640, rad);
    rg.addColorStop(0, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 640, 640);
  }
  x.globalCompositeOperation = 'source-over';
  x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = 3;
  for (let i = 0; i < 9; i++) {
    x.beginPath();
    x.arc(320, 420, 60 + i * 34, Math.PI, 2 * Math.PI);
    x.stroke();
  }
  x.fillStyle = 'rgba(255,255,255,0.95)';
  x.font = '800 58px system-ui, -apple-system, Roboto, sans-serif';
  x.fillText(title.toUpperCase(), 44, 110, 560);
  x.font = '500 30px system-ui, -apple-system, Roboto, sans-serif';
  x.fillStyle = 'rgba(255,255,255,0.8)';
  x.fillText(artist, 46, 156, 560);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
}

export async function installDemo() {
  const tracks = [];
  let n = 0;
  for (const [ai, al] of ALBUMS.entries()) {
    const artId = 'demo-art-' + ai;
    await storeArt(artId, await makeCover(al.title, al.artist, al.colors, ai * 97 + 13));
    al.tracks.forEach((t, i) => {
      n++;
      const q = new URLSearchParams();
      for (const k of ['bpm', 'dur', 'root', 'style', 'lead', 'tail', 'fadeIn', 'fadeOut', 'melody', 'drumsIn', 'melodyIn']) if (t[k] !== undefined) q.set(k, t[k]);
      q.set('seed', n * 31);
      const sz = 44 + Math.floor(t.dur * 22050) * 2;
      tracks.push({
        id: 'demo-' + n, v: 2, demo: true,
        url: `./__demo/${n}.wav?${q}`,
        size: sz, mtime: 0, added: Date.now() - ai * 86400000,
        title: t.title, artist: al.artist, albumArtist: al.artist, album: al.title,
        track: i + 1, trackTotal: al.tracks.length, disc: 1, year: al.year, genre: al.genre,
        bpm: 0, duration: t.dur, codec: 'WAV', sampleRate: 22050, bitDepth: 16, channels: 1, bitrate: 353,
        lyrics: '', lrc: '', artId, file: t.title + '.wav',
      });
    });
  }
  await db.putMany('tracks', tracks);
  await db.kv.set('demo', true);
}

export async function removeDemo() {
  const all = await db.all('tracks');
  await db.delMany('tracks', all.filter((t) => t.demo).map((t) => t.id));
  await db.kv.set('demo', false);
}
