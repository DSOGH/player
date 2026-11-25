// Player account in the cloud. Your account (name, colour, PIN), settings, playlists, likes, clean /
// explicit choices and BPMs are saved where all your devices can reach them, so signing in to the same
// Plex on another phone or computer brings your Player account with it.
//  • Plex (automatic): stored on your own Plex server, in a playlist called "Player sync" that only your
//    Plex user sees — nothing leaves your server, and it follows your Plex account.
//  • GitHub (optional): a private Gist, using a token you paste once per device.
import * as db from './db.js';
import { settings } from './settings.js';
import { library } from './library.js';
import { plex, deviceName } from './plex.js';
import { accounts } from './accounts.js';
import { Emitter } from './util.js';

export const SYNC_TITLE = 'Player sync';
const MAGIC = 'PLAYERSYNC1:';
const GIST_FILE = 'player-sync.json';
// a stable id for this device, so each device's listening stats are kept separately in the cloud
function deviceId() {
  let id = localStorage.getItem('playerDeviceId');
  if (!id) { id = Math.random().toString(36).slice(2, 10); try { localStorage.setItem('playerDeviceId', id); } catch (e) { /* */ } }
  return id;
}
// settings that describe this screen or this device rather than you
const LOCAL_ONLY = new Set(['layoutMode', 'deskWidth', 'deskPlayerW', 'deskSidebar', 'deskFrame', 'dualSwap', 'friendRelay', 'analysisNetwork', 'prefetch']);

async function gz(str) {
  const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const b = new Uint8Array(await new Response(cs).arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function gunz(b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).text();
}

class Cloud extends Emitter {
  constructor() { super(); this.state = { at: 0, where: '', error: '' }; this._t = null; this.busy = false; }

  async load() {
    this.state = (await db.kv.get('cloud')) || { at: 0 };
    this.ghToken = (await db.kv.get('cloud:gh')) || '';
    this.gistId = (await db.kv.get('cloud:gist')) || '';
    // anything you change is saved to the cloud a little later (and when the app closes)
    const later = () => this.schedule();
    library.on('likes', later); library.on('playlists', later);
    library.on('played', () => this.schedule(90000)); // stats are backed up automatically too
    library.on('analysis', (id) => { if (library.analysis.get(id)?.tapped) later(); });
    settings.on('change', (k) => { if (!LOCAL_ONLY.has(k)) later(); });
    addEventListener('pagehide', () => { if (this._t) this.push(); });
  }
  get enabled() { return settings.get('cloudSync') !== false; }
  get available() { return (plex.connected && !!library.plexAnyKey?.()) || !!this.ghToken; }

  // ---------- what gets saved ----------
  async snapshot() {
    const a = accounts.active;
    const s = { ...settings.v }; for (const k of LOCAL_ONLY) delete s[k];
    const bpm = {};
    for (const an of library.analysis.values()) if (an.tapped && an.bpm) bpm[an.id] = [an.bpm, an.beatOffset || 0];
    const out = {
      v: 1, at: Date.now(), device: deviceName(),
      profile: { name: a?.name || '', color: a?.color ?? 1, pin: a?.pin || '' },
      settings: s,
      playlists: [...library.playlists.values()].filter((p) => !p.source),
      plDeleted: (await db.kv.get('plDeleted')) || {},
      likes: [...library.likes],
      editionSet: library.editionSet || {},
      bpm,
    };
    // listening stats: always backed up, one entry per device (so restoring never mixes them up)
    await library.loadPlayLog();
    out.statsBy = { ...(this.remoteStats || {}), [deviceId()]: { name: deviceName(), at: Date.now(), plays: library.playLog } };
    return out;
  }

  // ---------- where it's saved ----------
  async plexFind() {
    const mc = await plex.api('/playlists', { playlistType: 'audio' });
    return (mc.Metadata || []).find((p) => p.title === SYNC_TITLE) || null;
  }
  async plexRead() {
    const pl = await this.plexFind();
    if (!pl) return null;
    let sum = pl.summary;
    if (sum == null) { const mc = await plex.api(`/playlists/${pl.ratingKey}`); sum = mc.Metadata?.[0]?.summary || ''; }
    const i = (sum || '').indexOf(MAGIC);
    if (i < 0) return null;
    return JSON.parse(await gunz(sum.slice(i + MAGIC.length).trim()));
  }
  async plexWrite(data) {
    let pl = await this.plexFind();
    if (!pl) {
      const key = library.plexAnyKey();
      if (!key) throw new Error('No Plex songs yet');
      const uri = `server://${plex.cfg.server.id}/com.plexapp.plugins.library/library/metadata/${key}`;
      const mc = await plex.api('/playlists', { type: 'audio', title: SYNC_TITLE, smart: 0, uri }, 'POST');
      pl = mc.Metadata?.[0];
      if (!pl) throw new Error('Plex didn’t create the sync playlist');
    }
    // Plex keeps it in the playlist's description; if the server refuses a long one, keep the essentials
    const recent = (by, months) => Object.fromEntries(Object.entries(by || {}).map(([k, v]) => [k, { ...v, plays: Object.fromEntries(Object.entries(v.plays || {}).sort().slice(-months)) }]));
    const tries = [data, { ...data, statsBy: recent(data.statsBy, 6), trimmed: true }, { ...data, statsBy: recent(data.statsBy, 2), trimmed: true }, { ...data, statsBy: undefined, trimmed: true }, { ...data, statsBy: undefined, bpm: {}, plDeleted: {}, trimmed: true }, { v: 1, at: data.at, device: data.device, profile: data.profile, settings: data.settings, playlists: [], likes: [], editionSet: data.editionSet }];
    let last;
    for (const d of tries) {
      const body = MAGIC + await gz(JSON.stringify(d));
      try {
        await plex.api(`/playlists/${pl.ratingKey}`, { summary: `Saved by Player on ${data.device} — keeps your Player account on all your devices. Please don’t delete.\n\n${body}` }, 'PUT');
        this.trimmed = d !== data;
        return d === data ? 'full' : 'trimmed';
      } catch (e) { last = e; }
    }
    throw last;
  }
  async ghReq(path, opts = {}) {
    const r = await fetch('https://api.github.com' + path, { ...opts, headers: { Authorization: `Bearer ${this.ghToken}`, Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401) throw new Error('GitHub rejected the token');
    if (!r.ok) throw new Error('GitHub responded with ' + r.status);
    return r.json();
  }
  async ghFindGist() {
    if (this.gistId) return this.gistId;
    for (let page = 1; page <= 5; page++) {
      const list = await this.ghReq(`/gists?per_page=100&page=${page}`);
      const g = list.find((x) => x.files?.[GIST_FILE]);
      if (g) { this.gistId = g.id; db.kv.set('cloud:gist', g.id); return g.id; }
      if (list.length < 100) break;
    }
    return '';
  }
  async ghRead() {
    const id = await this.ghFindGist();
    if (!id) return null;
    const g = await this.ghReq('/gists/' + id);
    const f = g.files?.[GIST_FILE];
    let txt = f?.content || '';
    if (f?.truncated && f.raw_url) txt = await (await fetch(f.raw_url)).text();
    return txt ? JSON.parse(txt) : null;
  }
  async ghWrite(data) {
    const id = await this.ghFindGist();
    const body = JSON.stringify({ description: 'Player account sync', files: { [GIST_FILE]: { content: JSON.stringify(data) } }, ...(id ? {} : { public: false }) });
    const g = await this.ghReq(id ? '/gists/' + id : '/gists', { method: id ? 'PATCH' : 'POST', body });
    if (!id) { this.gistId = g.id; db.kv.set('cloud:gist', g.id); }
  }

  // newest copy from any place it's kept
  async fetchRemote() {
    const got = [];
    if (plex.connected) { try { const d = await this.plexRead(); if (d) got.push({ d, where: 'Plex' }); } catch (e) { /* */ } }
    if (this.ghToken) { try { const d = await this.ghRead(); if (d) got.push({ d, where: 'GitHub' }); } catch (e) { /* */ } }
    got.sort((a, b) => (b.d.at || 0) - (a.d.at || 0));
    return got[0] || null;
  }

  schedule(ms = 20000) {
    if (!this.enabled) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => this.push(), ms);
  }
  async push() {
    clearTimeout(this._t); this._t = null;
    if (!this.enabled || this.busy || !this.available) return false;
    this.busy = true;
    try {
      if (!this.remoteStats) { try { const r = await this.fetchRemote(); this.remoteStats = r?.d?.statsBy || {}; } catch (e) { this.remoteStats = {}; } }
      const data = await this.snapshot();
      const where = [];
      if (plex.connected && library.plexAnyKey()) { await this.plexWrite(data); where.push('Plex'); }
      if (this.ghToken) { await this.ghWrite(data); where.push('GitHub'); }
      this.state = { at: data.at, where: where.join(' + '), error: '' };
      await db.kv.set('cloud', this.state);
      this.emit('saved', this.state);
      return true;
    } catch (e) {
      this.state = { ...this.state, error: e.message || 'Couldn’t save' };
      this.emit('error', e);
      return false;
    } finally { this.busy = false; }
  }

  // ---------- bring it back ----------
  // merge the cloud copy into this device: nothing local is thrown away; newer wins per playlist
  async apply(d, { full = false, parts = null } = {}) {
    if (!d) return;
    const want = (k) => !parts || parts.includes(k);
    if (d.statsBy) this.remoteStats = { ...d.statsBy, ...(this.remoteStats || {}) };
    if ((full && want('profile')) || !accounts.active?.name) accounts.update(accounts.activeId, { name: d.profile?.name || accounts.active?.name || '', color: d.profile?.color ?? accounts.active?.color, pin: d.profile?.pin || '' });
    if (full && want('settings') && d.settings) { for (const [k, v] of Object.entries(d.settings)) if (!LOCAL_ONLY.has(k) && k !== 'sv') settings.v[k] = v; await settings.save?.(); settings.emit('change', '*'); }
    if (want('music')) {
    const dead = { ...((await db.kv.get('plDeleted')) || {}), ...(d.plDeleted || {}) };
    for (const p of d.playlists || []) {
      if (dead[p.id] && dead[p.id] >= (p.updated || 0)) continue;
      const mine = library.playlists.get(p.id);
      if (!mine || (p.updated || 0) > (mine.updated || 0)) { library.playlists.set(p.id, p); await db.put('playlists', p); }
    }
    for (const [id, at] of Object.entries(dead)) { const p = library.playlists.get(id); if (p && !p.source && (p.updated || 0) <= at) { library.playlists.delete(id); await db.del('playlists', id); } }
    await db.kv.set('plDeleted', dead);
    let likes = false;
    for (const id of d.likes || []) if (!library.likes.has(id)) { library.likes.add(id); likes = true; }
    if (likes) await db.kv.set('likes', [...library.likes]);
    }
    if (want('dj') && d.editionSet) { library.editionSet = { ...d.editionSet, ...(library.editionSet || {}) }; await db.kv.set('editionSet', library.editionSet); }
    if (want('dj')) for (const [id, [bpm, off]] of Object.entries(d.bpm || {})) {
      const an = library.analysis.get(id);
      if (!an?.tapped) library.setAnalysis({ ...(an || { id, v: 4 }), bpm, beatOffset: an?.beatOffset ?? off, bpmConf: 1, tapped: true });
    }
    // stats: brought back on a restore (every device's history for this account), and kept combined
    // afterwards if "Combine stats from all devices" is on
    const statSrc = (full && want('stats')) || settings.get('cloudStats') ? Object.entries(d.statsBy || {}).filter(([k]) => k !== deviceId() || full).map(([, v]) => v.plays || {}) : [];
    if (d.plays && (full || settings.get('cloudStats'))) statSrc.push(d.plays);
    if (statSrc.length) await library.loadPlayLog();
    for (const plays of statSrc) {
      for (const [m, arr] of Object.entries(plays)) {
        const have = new Set((library.playLog[m] || []).map((e) => e[0] + ':' + e[1]));
        const add = arr.filter((e) => !have.has(e[0] + ':' + e[1]));
        if (add.length) { library.playLog[m] = [...(library.playLog[m] || []), ...add].sort((a, b) => a[1] - b[1]); await db.kv.set('plays:' + m, library.playLog[m]); }
      }
    }
    library.build();
    library.emit('playlists'); library.emit('likes'); library.emit('change');
    this.state = { ...this.state, pulled: Date.now(), from: d.device };
    await db.kv.set('cloud', this.state);
  }
  // on launch: pick up what your other devices changed, then save the merged result
  async syncNow() {
    if (!this.enabled || !this.available) return null;
    const r = await this.fetchRemote();
    if (r && (r.d.at || 0) > (this.state.at || 0) && r.d.device !== deviceName()) await this.apply(r.d);
    await this.push();
    return r;
  }
  async setGithub(token) {
    this.ghToken = (token || '').trim(); this.gistId = '';
    await db.kv.set('cloud:gh', this.ghToken); await db.kv.del('cloud:gist');
    if (this.ghToken) await this.ghReq('/user');
  }
}

export const cloud = new Cloud();
