// Player account in the cloud. Your account (name, colour, PIN), settings, playlists, likes, clean /
// explicit choices, BPMs, listening stats and friends (with their chat keys and recent chats) are saved where all your devices can reach them, so signing in to the same
// Plex on another phone or computer brings your Player account with it.
//  • Plex (automatic): stored on your own Plex server, in a playlist called "Player sync" that only your
//    Plex user sees — nothing leaves your server, and it follows your Plex account.
//  • GitHub (optional): a private Gist, using a token you paste once per device.
import * as db from './db.js';
import { settings } from './settings.js';
import { library } from './library.js';
import { plex, deviceName } from './plex.js';
import { accounts, deviceId } from './accounts.js';
import { Emitter } from './util.js';
import { friends } from './friends.js';

export const SYNC_TITLE = 'Player sync';
const MAGIC = 'PLAYERSYNC1:';
const GIST_FILE = 'player-sync.json';
// settings that describe this screen or this device rather than you
const LOCAL_ONLY = new Set(['engine', 'volume', 'layoutMode', 'deskWidth', 'deskPlayerW', 'deskSidebar', 'deskFrame', 'dualSwap', 'friendRelay', 'analysisNetwork', 'prefetch']);

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
    friends.on('change', later); friends.on('message', () => this.schedule(60000));
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
      v: 1, cid: this.cid(), at: Date.now(), device: deviceName(), did: deviceId(),
      profile: { name: a?.name || '', color: a?.color ?? 1, pin: a?.pin || '' },
      settings: s,
      playlists: [...library.playlists.values()].filter((p) => !p.source),
      plDeleted: (await db.kv.get('plDeleted')) || {},
      likes: [...library.likes],
      editionSet: library.editionSet || {},
      bpm,
      friends: await friends.exportData().catch(() => null),
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
    // Plex keeps it in the playlist's description; if the server refuses a long one, every profile keeps
    // its essentials and gives up old stats / chats first
    const recent = (by, months) => Object.fromEntries(Object.entries(by || {}).map(([k, v]) => [k, { ...v, plays: Object.fromEntries(Object.entries(v.plays || {}).sort().slice(-months)) }]));
    const lite = (f) => f && { ...f, chats: Object.fromEntries(Object.entries(f.chats || {}).map(([k, v]) => [k, v.slice(-30)])) };
    const each = (fn) => ({ ...data, profiles: Object.fromEntries(Object.entries(data.profiles).map(([k, d]) => [k, fn(d)])) });
    const tries = [data,
      each((d) => ({ ...d, friends: lite(d.friends), statsBy: recent(d.statsBy, 6), trimmed: true })),
      each((d) => ({ ...d, friends: lite(d.friends), statsBy: recent(d.statsBy, 2), trimmed: true })),
      each((d) => ({ ...d, friends: lite(d.friends), statsBy: undefined, trimmed: true })),
      each((d) => ({ ...d, friends: lite(d.friends), statsBy: undefined, bpm: {}, plDeleted: {}, trimmed: true })),
      each((d) => ({ v: 1, cid: d.cid, at: d.at, device: d.device, profile: d.profile, settings: d.settings, playlists: [], likes: [], editionSet: d.editionSet, friends: d.friends && { me: d.friends.me, list: d.friends.list, pending: [], chats: {} } }))];
    let last;
    const n = Object.keys(data.profiles).length;
    for (const d of tries) {
      const body = MAGIC + await gz(JSON.stringify(d));
      try {
        await plex.api(`/playlists/${pl.ratingKey}`, { summary: `Saved by Player — ${n} account${n > 1 ? 's' : ''} kept on all your devices. Please don’t delete.\n\n${body}` }, 'PUT');
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

  // This account's id in the cloud. Every account on every device has one, so saving one account never
  // touches the others: they all live side by side in the same place, each under its own id.
  cid() {
    const a = accounts.active;
    // two accounts on this device must never share an id (they'd overwrite each other)
    if (a?.cid && !accounts.all.some((x) => x.id !== a.id && x.cid === a.cid)) return a.cid;
    const id = 'p' + Math.random().toString(36).slice(2, 10);
    accounts.update(accounts.activeId, { cid: id });
    return id;
  }
  // older saves held a single account: wrap them so they become one entry among many
  static box(d) {
    if (!d) return null;
    if (d.profiles) return d;
    const cid = d.cid || 'legacy';
    return { v: 2, at: d.at || 0, profiles: { [cid]: { ...d, cid } } };
  }
  // every account saved in the cloud (Plex and GitHub combined, newest copy of each account wins)
  async fetchRemote() {
    const got = [];
    if (plex.connected) { try { const d = Cloud.box(await this.plexRead()); if (d) got.push({ d, where: 'Plex' }); } catch (e) { /* */ } }
    if (this.ghToken) { try { const d = Cloud.box(await this.ghRead()); if (d) got.push({ d, where: 'GitHub' }); } catch (e) { /* */ } }
    if (!got.length) return null;
    const profiles = {};
    for (const { d } of got) for (const [k, v] of Object.entries(d.profiles || {})) if (!profiles[k] || (v.at || 0) > (profiles[k].at || 0)) profiles[k] = v;
    const r = { c: { v: 2, at: Math.max(...got.map((g) => g.d.at || 0)), profiles }, where: got.map((g) => g.where).join(' + ') };
    this.saveRoster(r);
    return r;
  }
  // a small list of the accounts saved in the cloud, readable before anything starts — the login screen
  // shows the ones that aren't on this device yet, so anyone can pick theirs
  saveRoster(r) {
    try {
      const list = Object.values(r?.c?.profiles || {}).map((d) => ({ cid: d.cid, name: d.profile?.name || '', color: d.profile?.color ?? 1, pin: d.profile?.pin || '', at: d.at || 0, device: d.device || '' }));
      localStorage.setItem('playerCloudRoster', JSON.stringify({ at: Date.now(), from: accounts.activeId, where: r.where, list }));
    } catch (e) { /* */ }
  }
  // take an account out of the cloud (it's not touched on any device that has it)
  async removeProfile(cid) {
    const remote = await this.fetchRemote();
    if (!remote?.c?.profiles?.[cid]) return false;
    delete remote.c.profiles[cid];
    remote.c.at = Date.now();
    if (plex.connected && library.plexAnyKey()) await this.plexWrite(remote.c);
    if (this.ghToken) await this.ghWrite(remote.c);
    this.saveRoster(remote);
    return true;
  }
  // the cloud's accounts as a list, newest first (for the restore screen)
  listProfiles(r) { return Object.values(r?.c?.profiles || {}).sort((a, b) => (b.at || 0) - (a.at || 0)); }

  schedule(ms = 20000) {
    if (!this.enabled) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => this.push(), ms);
  }
  async push() {
    clearTimeout(this._t); this._t = null;
    if (!this.enabled || this.busy || !this.available) return false;
    // a device that has never saved waits until you've chosen "restore" or "start fresh" (or there was
    // nothing to restore) — so a new phone never overwrites your account with blank settings
    if (!this.state.at && !this.firstOk) return false;
    this.busy = true;
    try {
      // read what's there first and only replace this account's entry — every other account is kept
      let remote = null;
      try { remote = await this.fetchRemote(); } catch (e) { /* */ }
      // saved before accounts had ids → this device's account is the old single entry
      const leg = remote?.c?.profiles?.legacy;
      if (!accounts.active?.cid && this.state.at && leg && !accounts.all.some((a) => a.cid === 'legacy')
        && (leg.profile?.name || '') === (accounts.active?.name || '')) accounts.update(accounts.activeId, { cid: 'legacy' });
      const cid = this.cid();
      const mineBefore = remote?.c?.profiles?.[cid];
      this.remoteStats = { ...(mineBefore?.statsBy || {}), ...(this.remoteStats || {}) };
      const data = await this.snapshot();
      const box = { v: 2, at: data.at, profiles: { ...(remote?.c?.profiles || {}), [cid]: data } };
      const where = [];
      if (plex.connected && library.plexAnyKey()) { await this.plexWrite(box); where.push('Plex'); }
      if (this.ghToken) { await this.ghWrite(box); where.push('GitHub'); }
      this.saveRoster({ c: box, where: where.join(' + ') });
      this.state = { ...this.state, at: data.at, where: where.join(' + '), error: '' };
      await db.kv.set('cloud', this.state);
      this.emit('saved', this.state);
      friends.selfSend({ type: 'cloud' }).catch(() => {}); // your other devices pick it up right away
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
    if (full && d.cid && accounts.active?.cid !== d.cid) { accounts.update(accounts.activeId, { cid: d.cid }); this.remoteStats = null; }
    if (d.statsBy) this.remoteStats = { ...d.statsBy, ...(this.remoteStats || {}) };
    if (full) this.firstOk = true;
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
    // friends always follow the account between its devices (merged, never replaced)
    // (your friend ID always comes along with the account, even if you untick friends)
    if (d.friends && (!full || want('friends'))) await friends.importData(d.friends).catch((e) => console.warn('friends import', e));
    else if (d.friends?.me && full) await friends.importData({ me: d.friends.me, list: [], pending: [] }).catch(() => {});
    library.build();
    library.emit('playlists'); library.emit('likes'); library.emit('change');
    this.state = { ...this.state, pulled: Date.now(), from: d.device };
    await db.kv.set('cloud', this.state);
  }
  // on launch: pick up what your other devices changed, then save the merged result
  async syncNow() {
    if (!this.enabled || !this.available) return null;
    const r = await this.fetchRemote();
    const mine = r?.c?.profiles?.[this.cid()];
    // saved by another device (two iPhones are both just "iPhone", so devices are told apart by their id)
    const other = mine && (mine.did ? mine.did !== deviceId() : mine.device !== deviceName());
    if (mine && other && (mine.at || 0) > (this.state.pulledAt || 0)) { await this.apply(mine); this.state.pulledAt = mine.at; await db.kv.set('cloud', this.state); }
    await this.push();
    return mine ? r : null;
  }
  async setGithub(token) {
    this.ghToken = (token || '').trim(); this.gistId = '';
    await db.kv.set('cloud:gh', this.ghToken); await db.kv.del('cloud:gist');
    if (this.ghToken) await this.ghReq('/user');
  }
}

export const cloud = new Cloud();
