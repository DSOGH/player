// Reads tags, embedded artwork and stream info straight from audio files
// using HTTP Range requests (only the bytes needed are downloaded).
// Supports: MP3 (ID3v2.2/2.3/2.4 + ID3v1), FLAC, M4A/MP4 (AAC + ALAC), OGG Vorbis, Opus, WAV.

const MAX_TAG = 16 * 1024 * 1024; // never read more than this for metadata

export class RangeReader {
  constructor(url, size = 0) { this.url = url; this.size = size; this.chunks = []; this.requests = 0; }
  async read(off, len) {
    if (this.size) {
      if (off >= this.size) return new Uint8Array(0);
      len = Math.min(len, this.size - off);
    }
    if (len <= 0) return new Uint8Array(0);
    for (const c of this.chunks) {
      if (off >= c.off && off + len <= c.off + c.data.length) return c.data.subarray(off - c.off, off - c.off + len);
    }
    const want = Math.max(len, 128 * 1024);
    let end = off + want - 1;
    if (this.size) end = Math.min(end, this.size - 1);
    this.requests++;
    const r = await fetch(this.url, { headers: { Range: `bytes=${off}-${end}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200) {
      // server ignored Range: we now have the whole file
      this.chunks = [{ off: 0, data: buf }];
      this.size = buf.length;
      return buf.subarray(off, off + len);
    }
    const cr = r.headers.get('content-range');
    if (cr) { const t = parseInt(cr.split('/')[1], 10); if (t) this.size = t; }
    this.chunks.push({ off, data: buf });
    if (this.chunks.length > 8) this.chunks.shift();
    return buf.subarray(0, len);
  }
}

// ---------- byte helpers ----------
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const td = {
  utf8: new TextDecoder('utf-8'),
  latin1: new TextDecoder('latin1'),
  u16le: new TextDecoder('utf-16le'),
  u16be: new TextDecoder('utf-16be'),
};
const utf8 = (b) => td.utf8.decode(b);

function decodeText(enc, b) {
  let s;
  if (enc === 0) s = td.latin1.decode(b);
  else if (enc === 3) s = td.utf8.decode(b);
  else if (enc === 2) s = td.u16be.decode(b);
  else {
    if (b[0] === 0xFE && b[1] === 0xFF) s = td.u16be.decode(b.subarray(2));
    else if (b[0] === 0xFF && b[1] === 0xFE) s = td.u16le.decode(b.subarray(2));
    else s = td.u16le.decode(b);
  }
  return s;
}
// split at the first null terminator appropriate for the encoding
function splitNull(b, enc) {
  const wide = enc === 1 || enc === 2;
  if (wide) {
    for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [b.subarray(0, i), b.subarray(i + 2)];
  } else {
    for (let i = 0; i < b.length; i++) if (b[i] === 0) return [b.subarray(0, i), b.subarray(i + 1)];
  }
  return [b, new Uint8Array(0)];
}
function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xFF && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}
const clean = (s) => (s || '').replace(/\0+$/g, '').replace(/\0/g, ', ').trim();

function numPair(s) {
  const m = String(s || '').match(/(\d+)(?:\s*\/\s*(\d+))?/);
  return m ? [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] : [0, 0];
}
function gainDb(s) {
  const v = parseFloat(String(s || '').replace(',', '.'));
  return isFinite(v) ? v : undefined;
}
function setKV(meta, key, val) {
  key = key.toUpperCase().replace(/\s+/g, '');
  val = clean(val);
  if (!val) return;
  switch (key) {
    case 'TITLE': meta.title ||= val; break;
    case 'ARTIST': meta.artist = meta.artist ? meta.artist : val; meta._artists = (meta._artists || []).concat(val); break;
    case 'ALBUMARTIST': case 'ALBUM_ARTIST': meta.albumArtist ||= val; break;
    case 'ALBUM': meta.album ||= val; break;
    case 'TRACKNUMBER': case 'TRACK': { const [a, b] = numPair(val); meta.track ||= a; if (b) meta.trackTotal = b; break; }
    case 'TRACKTOTAL': case 'TOTALTRACKS': meta.trackTotal ||= parseInt(val, 10) || 0; break;
    case 'DISCNUMBER': case 'DISC': { const [a, b] = numPair(val); meta.disc ||= a; if (b) meta.discTotal = b; break; }
    case 'DISCTOTAL': case 'TOTALDISCS': meta.discTotal ||= parseInt(val, 10) || 0; break;
    case 'DATE': case 'YEAR': case 'ORIGINALDATE': case 'ORIGINALYEAR': { const y = val.match(/\d{4}/); if (y) meta.year ||= parseInt(y[0], 10); break; }
    case 'GENRE': meta.genre ||= val; break;
    case 'BPM': case 'TEMPO': { const b = parseFloat(val); if (b > 0) meta.bpm ||= Math.round(b * 10) / 10; break; }
    case 'COMPILATION': meta.compilation = val === '1' || /^true$/i.test(val); break;
    case 'REPLAYGAIN_TRACK_GAIN': meta.rgTrack = gainDb(val); break;
    case 'REPLAYGAIN_ALBUM_GAIN': meta.rgAlbum = gainDb(val); break;
    case 'REPLAYGAIN_TRACK_PEAK': meta.rgTrackPeak = parseFloat(val) || undefined; break;
    case 'REPLAYGAIN_ALBUM_PEAK': meta.rgAlbumPeak = parseFloat(val) || undefined; break;
    case 'R128_TRACK_GAIN': { const v = parseInt(val, 10); if (isFinite(v)) meta.rgTrack ??= v / 256 + 5; break; }
    case 'R128_ALBUM_GAIN': { const v = parseInt(val, 10); if (isFinite(v)) meta.rgAlbum ??= v / 256 + 5; break; }
    case 'LYRICS': case 'UNSYNCEDLYRICS': meta.lyrics ||= val; break;
    default: break;
  }
}

// ---------- ID3 ----------
const ID3_MAP = {
  TIT2: 'TITLE', TT2: 'TITLE', TPE1: 'ARTIST', TP1: 'ARTIST', TPE2: 'ALBUMARTIST', TP2: 'ALBUMARTIST',
  TALB: 'ALBUM', TAL: 'ALBUM', TRCK: 'TRACKNUMBER', TRK: 'TRACKNUMBER', TPOS: 'DISCNUMBER', TPA: 'DISCNUMBER',
  TDRC: 'DATE', TYER: 'DATE', TYE: 'DATE', TDOR: 'ORIGINALDATE', TORY: 'ORIGINALDATE', TCON: 'GENRE', TCO: 'GENRE',
  TBPM: 'BPM', TBP: 'BPM', TCMP: 'COMPILATION', TCP: 'COMPILATION',
};
const ID3_GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];
function fixGenre(g) {
  if (!g) return g;
  const m = g.match(/^\((\d+)\)(.*)$/);
  if (m) return m[2].trim() || ID3_GENRES[+m[1]] || g;
  if (/^\d+$/.test(g)) return ID3_GENRES[+g] || g;
  return g;
}

function id3Frame(id, fd, meta) {
  if (!fd.length) return;
  const k = ID3_MAP[id];
  if (k) {
    const enc = fd[0];
    let txt = decodeText(enc, fd.subarray(1));
    // multiple values separated by nulls
    const parts = txt.split('\0').map((s) => s.trim()).filter(Boolean);
    txt = k === 'ARTIST' ? parts.join(', ') : (parts[0] || '');
    if (k === 'GENRE') txt = fixGenre(txt);
    setKV(meta, k, txt);
    return;
  }
  if (id === 'TXXX' || id === 'TXX') {
    const enc = fd[0];
    const [d, v] = splitNull(fd.subarray(1), enc);
    const desc = decodeText(enc, d);
    const val = decodeText(enc, v).split('\0')[0];
    const D = desc.toUpperCase();
    if (D === 'ALBUM ARTIST' || D === 'ALBUMARTIST') setKV(meta, 'ALBUMARTIST', val);
    else setKV(meta, D, val);
    return;
  }
  if (id === 'USLT' || id === 'ULT') {
    const enc = fd[0];
    const [, rest] = splitNull(fd.subarray(4), enc);
    meta.lyrics ||= decodeText(enc, rest).trim();
    return;
  }
  if (id === 'TLEN') {
    const ms = parseInt(decodeText(fd[0], fd.subarray(1)), 10);
    if (ms > 0) meta._tlen = ms / 1000;
    return;
  }
  if (id === 'APIC' || id === 'PIC') {
    const enc = fd[0];
    let p = 1, mime;
    if (id === 'PIC') { const fmt = ascii(fd, 1, 3).toLowerCase(); mime = fmt === 'png' ? 'image/png' : 'image/jpeg'; p = 4; }
    else { let e = p; while (e < fd.length && fd[e] !== 0) e++; mime = ascii(fd, p, e - p) || 'image/jpeg'; p = e + 1; }
    const type = fd[p]; p++;
    const [, data] = splitNull(fd.subarray(p), enc);
    if (!mime.includes('/')) mime = 'image/' + (mime.toLowerCase() === 'png' ? 'png' : 'jpeg');
    addPicture(meta, type, mime, data);
  }
}
function addPicture(meta, type, mime, data) {
  if (!data || data.length < 64) return;
  const score = type === 3 ? 3 : type === 0 ? 2 : 1;
  if (!meta.picture || score > meta.picture.score) meta.picture = { mime, data: data.slice(), score };
}

async function parseID3v2(rr, meta, base = 0) {
  const h = await rr.read(base, 10);
  if (h.length < 10 || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return 0;
  const ver = h[3], flags = h[5];
  const size = syncsafe(h, 6);
  const total = size + 10 + (flags & 0x10 ? 10 : 0);
  if (ver < 2 || ver > 4) return total;
  let data = await rr.read(base + 10, Math.min(size, MAX_TAG));
  if (flags & 0x80 && ver < 4) data = unsync(data);
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? syncsafe(data, 0) : u32(data, 0) + 4;
  const validId = (o, n) => {
    for (let i = 0; i < n; i++) { const c = data[o + i]; if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false; }
    return true;
  };
  while (p < data.length) {
    let id, fsize, fflags = 0, hl;
    if (ver === 2) {
      if (p + 6 > data.length || !validId(p, 3)) break;
      id = ascii(data, p, 3); fsize = u24(data, p + 3); hl = 6;
    } else {
      if (p + 10 > data.length || !validId(p, 4)) break;
      id = ascii(data, p, 4); hl = 10;
      fsize = ver === 4 ? syncsafe(data, p + 4) : u32(data, p + 4);
      if (ver === 4) {
        // iTunes sometimes writes non-syncsafe sizes in v2.4
        const alt = u32(data, p + 4);
        if (alt !== fsize && !validId(p + hl + fsize, 4) && validId(p + hl + alt, 4)) fsize = alt;
      }
      fflags = u16(data, p + 8);
    }
    if (fsize <= 0) break;
    let fd = data.subarray(p + hl, p + hl + fsize);
    if (ver === 4) {
      if (fflags & 0x0002) fd = unsync(fd);
      if (fflags & 0x0001) fd = fd.subarray(4);
      if (fflags & 0x000C) fd = new Uint8Array(0); // compressed/encrypted: skip
    } else if (ver === 3 && fflags & 0x00C0) fd = new Uint8Array(0);
    try { id3Frame(id, fd, meta); } catch (e) { /* ignore broken frame */ }
    p += hl + fsize;
  }
  return total;
}

async function parseID3v1(rr, meta) {
  if (!rr.size || rr.size < 128) return;
  const b = await rr.read(rr.size - 128, 128);
  if (ascii(b, 0, 3) !== 'TAG') return;
  const s = (o, n) => td.latin1.decode(b.subarray(o, o + n)).replace(/\0.*$/, '').trim();
  setKV(meta, 'TITLE', s(3, 30));
  setKV(meta, 'ARTIST', s(33, 30));
  setKV(meta, 'ALBUM', s(63, 30));
  setKV(meta, 'DATE', s(93, 4));
  if (b[125] === 0 && b[126]) meta.track ||= b[126];
  if (b[127] < ID3_GENRES.length) meta.genre ||= ID3_GENRES[b[127]];
}

// ---------- MPEG audio frames ----------
const BR = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SR = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
function mp3Head(b, i) {
  if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null;
  const vb = (b[i + 1] >> 3) & 3, lb = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
  if (vb === 1 || lb === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const v = vb === 3 ? 1 : vb === 2 ? 2 : 2.5;
  const layer = 4 - lb;
  const tbl = v === 1 ? BR[`1-${layer}`] : BR[layer === 1 ? '2-1' : '2-2'];
  const br = tbl[bri], sr = SR[v][sri], pad = (b[i + 2] >> 1) & 1, mono = b[i + 3] >> 6 === 3;
  const spf = layer === 1 ? 384 : layer === 2 ? 1152 : v === 1 ? 1152 : 576;
  const len = layer === 1 ? Math.floor((12 * br * 1000) / sr + pad) * 4 : Math.floor((spf / 8) * br * 1000 / sr) + pad;
  return { v, layer, br, sr, spf, len, mono };
}
async function parseMp3Stream(rr, meta, start) {
  const b = await rr.read(start, 64 * 1024);
  for (let i = 0; i + 4 < b.length; i++) {
    const h = mp3Head(b, i);
    if (!h || h.len < 24) continue;
    const n = mp3Head(b, i + h.len);
    if (!n && i + h.len + 4 < b.length) continue;
    meta.codec = h.layer === 3 ? 'MP3' : `MPEG L${h.layer}`;
    meta.sampleRate = h.sr;
    meta.channels = h.mono ? 1 : 2;
    const xo = h.v === 1 ? (h.mono ? 21 : 36) : (h.mono ? 13 : 21);
    const tag = ascii(b, i + xo, 4);
    let frames = 0;
    if (tag === 'Xing' || tag === 'Info') {
      const fl = u32(b, i + xo + 4);
      if (fl & 1) frames = u32(b, i + xo + 8);
    } else if (ascii(b, i + 36, 4) === 'VBRI') {
      frames = u32(b, i + 36 + 14);
    }
    const audioStart = start + i;
    if (frames) {
      meta.duration = (frames * h.spf) / h.sr;
      if (rr.size) meta.bitrate = Math.round(((rr.size - audioStart) * 8) / meta.duration / 1000);
    } else if (rr.size) {
      meta.duration = ((rr.size - audioStart) * 8) / (h.br * 1000);
      meta.bitrate = h.br;
    }
    return;
  }
}

// ---------- FLAC ----------
function flacPicture(b, meta) {
  let p = 0;
  const type = u32(b, p); p += 4;
  const ml = u32(b, p); p += 4;
  const mime = ascii(b, p, ml); p += ml;
  const dl = u32(b, p); p += 4 + dl;
  p += 16;
  const len = u32(b, p); p += 4;
  addPicture(meta, type, mime || 'image/jpeg', b.subarray(p, p + len));
}
function vorbisComment(b, meta) {
  let p = 0;
  const vl = u32le(b, p); p += 4 + vl;
  const n = u32le(b, p); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const l = u32le(b, p); p += 4;
    const s = b.subarray(p, p + l); p += l;
    let eq = s.indexOf(61);
    if (eq < 0) continue;
    const key = ascii(s, 0, eq).toUpperCase();
    if (key === 'METADATA_BLOCK_PICTURE') {
      try {
        const bin = atob(td.latin1.decode(s.subarray(eq + 1)));
        const u = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
        flacPicture(u, meta);
      } catch (e) { /* bad base64 */ }
      continue;
    }
    setKV(meta, key, utf8(s.subarray(eq + 1)));
  }
}
async function parseFlac(rr, meta, base) {
  let p = base + 4;
  meta.codec = 'FLAC';
  for (let guard = 0; guard < 64; guard++) {
    const h = await rr.read(p, 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = u24(h, 1);
    if (type === 0) {
      const b = await rr.read(p + 4, 34);
      meta.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      meta.channels = ((b[12] >> 1) & 7) + 1;
      meta.bitDepth = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
      const total = (b[13] & 0x0f) * 4294967296 + u32(b, 14);
      if (meta.sampleRate) meta.duration = total / meta.sampleRate;
    } else if (type === 4) {
      vorbisComment(await rr.read(p + 4, Math.min(len, MAX_TAG)), meta);
    } else if (type === 6 && len < MAX_TAG) {
      flacPicture(await rr.read(p + 4, len), meta);
    }
    p += 4 + len;
    if (last) break;
  }
  if (meta.duration && rr.size) meta.bitrate = Math.round((rr.size * 8) / meta.duration / 1000);
}

// ---------- OGG (Vorbis / Opus / FLAC-in-Ogg) ----------
async function parseOgg(rr, meta) {
  let p = 0;
  const packets = [];
  let cur = [];
  let serial = null;
  for (let page = 0; page < 400 && packets.length < 3; page++) {
    const h = await rr.read(p, 27);
    if (ascii(h, 0, 4) !== 'OggS') break;
    const ns = h[26];
    const seg = await rr.read(p + 27, ns);
    const ser = u32le(h, 14);
    if (serial === null) serial = ser;
    let bodyLen = 0;
    for (let i = 0; i < ns; i++) bodyLen += seg[i];
    const body = await rr.read(p + 27 + ns, bodyLen);
    if (ser === serial) {
      let o = 0;
      for (let i = 0; i < ns; i++) {
        cur.push(body.subarray(o, o + seg[i]));
        o += seg[i];
        if (seg[i] < 255) {
          const len = cur.reduce((a, c) => a + c.length, 0);
          const pk = new Uint8Array(len);
          let q = 0;
          for (const c of cur) { pk.set(c, q); q += c.length; }
          packets.push(pk);
          cur = [];
          if (packets.length >= 3) break;
        }
      }
      const curLen = cur.reduce((a, c) => a + c.length, 0);
      if (curLen > MAX_TAG) break;
    }
    p += 27 + ns + bodyLen;
  }
  if (!packets.length) return;
  const id = packets[0];
  let rate = 0, preskip = 0;
  if (ascii(id, 1, 6) === 'vorbis') {
    meta.codec = 'Vorbis';
    meta.channels = id[11];
    meta.sampleRate = rate = u32le(id, 12);
    if (packets[1]) vorbisComment(packets[1].subarray(7), meta);
  } else if (ascii(id, 0, 8) === 'OpusHead') {
    meta.codec = 'Opus';
    meta.channels = id[9];
    preskip = u16le(id, 10);
    meta.sampleRate = 48000; rate = 48000;
    if (packets[1] && ascii(packets[1], 0, 8) === 'OpusTags') vorbisComment(packets[1].subarray(8), meta);
  } else if (ascii(id, 1, 4) === 'FLAC') {
    meta.codec = 'FLAC';
    // STREAMINFO is at offset 13+4
    const si = id.subarray(17);
    meta.sampleRate = rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    meta.bitDepth = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
    if (packets[1]) vorbisComment(packets[1].subarray(4), meta);
  }
  // duration from the last page's granule position
  if (rate && rr.size) {
    const n = Math.min(rr.size, 65536);
    const tail = await rr.read(rr.size - n, n);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
        const g = u32le(tail, i + 6) + u32le(tail, i + 10) * 4294967296;
        if (g > 0) { meta.duration = (g - preskip) / rate; break; }
      }
    }
    if (meta.duration) meta.bitrate = Math.round((rr.size * 8) / meta.duration / 1000);
  }
}

// ---------- MP4 / M4A ----------
function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let len = u32(b, p);
    const type = ascii(b, p + 4, 4);
    let hl = 8;
    if (len === 1) { len = u64(b, p + 8); hl = 16; } else if (len === 0) len = end - p;
    if (len < hl || p + len > end + 8) { if (len < hl) return; }
    yield { type, start: p, data: p + hl, end: Math.min(p + len, end) };
    p += len;
  }
}
function findBox(b, start, end, path) {
  let s = start, e = end;
  for (const name of path) {
    let found = null;
    for (const bx of boxes(b, s, e)) if (bx.type === name) { found = bx; break; }
    if (!found) return null;
    s = found.data; e = found.end;
    if (name === 'meta') s += 4; // full box
    if (name === 'stsd') s += 8;
  }
  return { start: s, end: e };
}
const MP4_MAP = {
  '©nam': 'TITLE', '©ART': 'ARTIST', aART: 'ALBUMARTIST', '©alb': 'ALBUM', '©day': 'DATE',
  '©gen': 'GENRE', '©lyr': 'LYRICS',
};
function parseIlst(b, s, e, meta) {
  for (const item of boxes(b, s, e)) {
    let dataBox = null, name = null;
    for (const c of boxes(b, item.data, item.end)) {
      if (c.type === 'data') dataBox = c;
      else if (c.type === 'name') name = utf8(b.subarray(c.data + 4, c.end));
    }
    if (!dataBox) continue;
    const kind = u32(b, dataBox.data) & 0xffffff;
    const v = b.subarray(dataBox.data + 8, dataBox.end);
    const t = item.type;
    if (MP4_MAP[t]) setKV(meta, MP4_MAP[t], utf8(v));
    else if (t === 'trkn' && v.length >= 6) { meta.track ||= u16(v, 2); meta.trackTotal ||= u16(v, 4); }
    else if (t === 'disk' && v.length >= 6) { meta.disc ||= u16(v, 2); meta.discTotal ||= u16(v, 4); }
    else if (t === 'tmpo' && v.length >= 2) { const x = u16(v, 0); if (x) meta.bpm ||= x; }
    else if (t === 'cpil') meta.compilation = v[0] === 1;
    else if (t === 'gnre' && v.length >= 2) meta.genre ||= ID3_GENRES[u16(v, 0) - 1];
    else if (t === 'covr') addPicture(meta, 3, kind === 14 ? 'image/png' : 'image/jpeg', v);
    else if (t === '----' && name) setKV(meta, name, utf8(v));
  }
}
async function parseMp4(rr, meta) {
  let p = 0;
  for (let guard = 0; guard < 64; guard++) {
    const h = await rr.read(p, 16);
    if (h.length < 8) break;
    let len = u32(h, 0);
    const type = ascii(h, 4, 4);
    if (len === 1) len = u64(h, 8); else if (len === 0) len = (rr.size || p + 8) - p;
    if (len < 8) break;
    if (type === 'moov') {
      const b = await rr.read(p, Math.min(len, MAX_TAG * 2));
      const mv = findBox(b, 8, b.length, ['mvhd']);
      if (mv) {
        const ver = b[mv.start];
        const ts = ver === 1 ? u32(b, mv.start + 20) : u32(b, mv.start + 12);
        const du = ver === 1 ? u64(b, mv.start + 24) : u32(b, mv.start + 16);
        if (ts) meta.duration = du / ts;
      }
      const sd = findBox(b, 8, b.length, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
      if (sd) {
        const fmt = ascii(b, sd.start + 4, 4);
        const e = sd.start + 8;
        meta.codec = fmt === 'alac' ? 'ALAC' : fmt === 'mp4a' ? 'AAC' : fmt === 'fLaC' ? 'FLAC' : fmt === 'Opus' ? 'Opus' : fmt.toUpperCase();
        meta.channels = u16(b, e + 16);
        const bits = u16(b, e + 18);
        meta.sampleRate = u32(b, e + 24) >>> 16;
        if (fmt === 'alac') {
          // real values are in the ALAC magic cookie
          const ck = findBox(b, e + 28, sd.end, ['alac']);
          if (ck) { meta.bitDepth = b[ck.start + 9]; meta.sampleRate = u32(b, ck.start + 24) || meta.sampleRate; }
          else meta.bitDepth = bits;
        }
      }
      const il = findBox(b, 8, b.length, ['udta', 'meta', 'ilst']);
      if (il) parseIlst(b, il.start, il.end, meta);
      if (meta.duration && rr.size) meta.bitrate = Math.round((rr.size * 8) / meta.duration / 1000);
      return;
    }
    p += len;
    if (rr.size && p >= rr.size) break;
  }
}

// ---------- WAV ----------
async function parseWav(rr, meta) {
  let p = 12;
  meta.codec = 'WAV';
  for (let guard = 0; guard < 32; guard++) {
    const h = await rr.read(p, 8);
    if (h.length < 8) break;
    const id = ascii(h, 0, 4), len = u32le(h, 4);
    if (id === 'fmt ') {
      const b = await rr.read(p + 8, 16);
      meta.channels = u16le(b, 2);
      meta.sampleRate = u32le(b, 4);
      meta._byteRate = u32le(b, 8);
      meta.bitDepth = u16le(b, 14);
    } else if (id === 'data') {
      if (meta._byteRate) meta.duration = len / meta._byteRate;
    } else if (id === 'LIST') {
      const b = await rr.read(p + 8, Math.min(len, 65536));
      if (ascii(b, 0, 4) === 'INFO') {
        const M = { INAM: 'TITLE', IART: 'ARTIST', IPRD: 'ALBUM', ICRD: 'DATE', IGNR: 'GENRE', ITRK: 'TRACKNUMBER' };
        for (let q = 4; q + 8 <= b.length;) {
          const k = ascii(b, q, 4), l = u32le(b, q + 4);
          if (M[k]) setKV(meta, M[k], utf8(b.subarray(q + 8, q + 8 + l)).replace(/\0+$/, ''));
          q += 8 + l + (l & 1);
        }
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      await parseID3v2(rr, meta, p + 8);
    }
    p += 8 + len + (len & 1);
    if (rr.size && p >= rr.size) break;
  }
  if (meta.sampleRate && meta.bitDepth && meta.channels) meta.bitrate = Math.round((meta.sampleRate * meta.bitDepth * meta.channels) / 1000);
}

// ---------- entry point ----------
export async function readTags(url, size, ext = '') {
  const rr = new RangeReader(url, size);
  const meta = {};
  const head = await rr.read(0, 12);
  const magic4 = ascii(head, 0, 4);
  try {
    if (magic4 === 'fLaC') await parseFlac(rr, meta, 0);
    else if (magic4 === 'OggS') await parseOgg(rr, meta);
    else if (ascii(head, 4, 4) === 'ftyp') await parseMp4(rr, meta);
    else if (magic4 === 'RIFF' && ascii(head, 8, 4) === 'WAVE') await parseWav(rr, meta);
    else {
      const tagLen = await parseID3v2(rr, meta, 0);
      const after = await rr.read(tagLen, 4);
      if (ascii(after, 0, 4) === 'fLaC') await parseFlac(rr, meta, tagLen);
      else {
        await parseMp3Stream(rr, meta, tagLen);
        if (!meta.title) await parseID3v1(rr, meta);
        if (!meta.duration && meta._tlen) meta.duration = meta._tlen;
      }
    }
  } catch (e) {
    meta._error = String(e.message || e);
  }
  if (meta.genre) meta.genre = fixGenre(meta.genre);
  delete meta._tlen; delete meta._byteRate; delete meta._artists;
  meta.size = rr.size || size;
  return meta;
}
