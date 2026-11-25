// Friends & chat between people using Player.
// Nothing big is stored anywhere: messages are tiny encrypted JSON passed through a ntfy relay
// (https://ntfy.sh by default, or your own) which keeps them for a few hours; chats live on each phone.
// Each friendship has its own AES-256 key that only the two phones know (it travels in the invite code).
import * as db from './db.js';
import { Emitter } from './util.js';
import { settings } from './settings.js';
import { library } from './library.js';
import { plex } from './plex.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const relay = () => (localStorage.getItem('relayBase') || settings.get('friendRelay') || 'https://ntfy.sh').replace(/\/$/, '');
const topic = (id) => `plyr_${id}`;
const npTopic = (id) => `plyr_${id}_np`; // "listening to" status lives on its own topic (never pushes)
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function importKey(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function keyId(raw) { return b64u((await crypto.subtle.digest('SHA-256', raw)).slice(0, 6)); }

class Friends extends Emitter {
  constructor() {
    super();
    this.me = null;
    this.list = [];      // [{ id, name, key, kid, color, added, np, npAt, unread }]
    this.pending = [];   // invites I created: [{ key, kid, at }]
    this.chats = new Map();
    this.keys = new Map(); // kid → CryptoKey
    this.es = null;
  }
  get ready() { return !!this.me; }

  async load() {
    this.me = await db.kv.get('friends:me');
    this.list = (await db.kv.get('friends:list')) || [];
    this.pending = (await db.kv.get('friends:pending')) || [];
    for (const f of this.list) this.keys.set(f.kid, await importKey(unb64u(f.key)));
    for (const p of this.pending) this.keys.set(p.kid, await importKey(unb64u(p.key)));
    if (this.me) { this.connect(); this.refreshPush(); }
  }
  async setup(name) {
    if (!this.me) this.me = { id: rand(18), since: Date.now(), last: 'all' };
    this.me.name = (name || plex.user?.name || 'Me').slice(0, 40);
    await db.kv.set('friends:me', this.me);
    this.connect();
    this.emit('change');
  }
  async save() {
    await db.kv.set('friends:list', this.list);
    await db.kv.set('friends:pending', this.pending);
    this.emit('change');
  }
  friend(id) { return this.list.find((f) => f.id === id); }
  get unread() { return this.list.reduce((s, f) => s + (f.unread || 0), 0); }

  // ---------- invites ----------
  // Code = "<my inbox id>.<friendship key>.<my name>" — share it as a link or paste it
  async createInvite() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const kid = await keyId(raw);
    const key = b64u(raw);
    this.pending.push({ key, kid, at: Date.now() });
    this.pending = this.pending.slice(-12);
    this.keys.set(kid, await importKey(raw));
    await this.save();
    const code = `${this.me.id}.${key}.${encodeURIComponent(this.me.name)}`;
    return { code, link: `${location.origin}${location.pathname}#/friend/${code}` };
  }
  parseCode(code) {
    const m = String(code || '').trim().replace(/^.*#\/friend\//, '').match(/^([A-Za-z0-9_-]{16,40})\.([A-Za-z0-9_-]{40,46})\.?(.*)$/);
    if (!m) return null;
    return { id: m[1], key: m[2], name: decodeURIComponent(m[3] || 'Friend').slice(0, 40) || 'Friend' };
  }
  async acceptInvite(code) {
    const c = this.parseCode(code);
    if (!c) throw new Error('That isn’t a valid friend code');
    if (c.id === this.me.id) throw new Error('That’s your own code');
    let f = this.friend(c.id);
    const raw = unb64u(c.key);
    const kid = await keyId(raw);
    if (!f) {
      f = { id: c.id, name: c.name, key: c.key, kid, color: colorFor(c.id), added: Date.now(), unread: 0 };
      this.list.push(f);
    } else Object.assign(f, { key: c.key, kid, name: c.name });
    this.keys.set(kid, await importKey(raw));
    await this.save();
    // tell them who we are (encrypted with the key from their invite)
    await this.send(f, { type: 'hello', from: this.me.id, name: this.me.name }, { store: false });
    return f;
  }
  async remove(id) {
    this.list = this.list.filter((f) => f.id !== id);
    await db.kv.set('chat:' + id, null);
    this.chats.delete(id);
    await this.save();
  }

  // ---------- messages ----------
  async history(id) {
    if (!this.chats.has(id)) this.chats.set(id, (await db.kv.get('chat:' + id)) || []);
    return this.chats.get(id);
  }
  async store(id, msg) {
    const h = await this.history(id);
    if (h.some((m) => m.mid === msg.mid)) return false;
    h.push(msg);
    h.sort((a, b) => a.at - b.at);
    if (h.length > 800) h.splice(0, h.length - 800);
    db.kv.set('chat:' + id, h);
    return true;
  }
  async send(f, body, { store = true } = {}) {
    const msg = { mid: rand(9), at: Date.now(), from: this.me.id, ...body };
    if (store) { msg.state = 'sending'; await this.store(f.id, msg); this.emit('message', f.id, msg); }
    try {
      const key = this.keys.get(f.kid);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(msg)));
      const env = JSON.stringify({ v: 1, k: f.kid, iv: b64u(iv), c: b64u(ct) });
      const r = await fetch(`${relay()}/${msg.type === 'np' ? npTopic(f.id) : topic(f.id)}`, { method: 'POST', body: env, headers: { 'X-Cache': 'yes' } });
      if (!r.ok) throw new Error('relay ' + r.status);
      if (store) { msg.state = 'sent'; db.kv.set('chat:' + f.id, await this.history(f.id)); this.emit('message', f.id, msg); }
    } catch (e) {
      if (store) { msg.state = 'failed'; db.kv.set('chat:' + f.id, await this.history(f.id)); this.emit('message', f.id, msg); }
      else throw e;
    }
    return msg;
  }
  sendText(f, text) { return this.send(f, { type: 'text', text: String(text).slice(0, 2000) }); }
  sendSong(f, t, at = 0, note = '') {
    return this.send(f, {
      type: 'song', note: note.slice(0, 500),
      song: { title: t.title, artist: t.artist, album: t.album, year: t.year || 0, duration: Math.round(t.duration || 0), at: Math.max(0, Math.round(at)) },
    });
  }
  async retry(fid, mid) {
    const f = this.friend(fid), h = await this.history(fid);
    const i = h.findIndex((m) => m.mid === mid);
    if (!f || i < 0) return;
    const [m] = h.splice(i, 1);
    const { state, mid: _m, at, from, ...body } = m;
    await this.send(f, body);
  }
  async markRead(id) {
    const f = this.friend(id);
    if (f && f.unread) { f.unread = 0; await this.save(); }
  }
  // "listening to" status for friends (only if you turn it on)
  shareNowPlaying(t) {
    if (!this.me || !settings.get('friendsShareNp') || !t || !this.list.length) return;
    if (Date.now() - (this._npAt || 0) < 20000 && this._npId === t.id) return;
    this._npAt = Date.now(); this._npId = t.id;
    for (const f of this.list) this.send(f, { type: 'np', title: t.title, artist: t.artist }, { store: false }).catch(() => {});
  }

  // find a song someone sent in *your* library
  match(song) {
    const nt = norm(song.title), na = norm(song.artist);
    let best = null, bestScore = 0;
    for (const t of library.tracks.values()) {
      if (norm(t.title) !== nt) continue;
      let s = 1;
      const ta = norm(t.artist);
      if (ta === na) s += 3; else if (ta.includes(na) || na.includes(ta)) s += 2;
      if (song.album && norm(t.album) === norm(song.album)) s += 1;
      if (song.duration && t.duration && Math.abs(t.duration - song.duration) < 3) s += 1;
      if (s > bestScore) { bestScore = s; best = t; }
    }
    return bestScore >= 3 ? best : null;
  }

  // ---------- receiving ----------
  async handle(evt) {
    if (!evt || evt.event !== 'message' || !evt.message) return;
    if (evt.id) { this.me.last = evt.id; this._saveLast(); }
    let env;
    try { env = JSON.parse(evt.message); } catch (e) { return; }
    const key = this.keys.get(env.k);
    if (!key) return;
    let msg;
    try { msg = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv) }, key, unb64u(env.c)))); } catch (e) { return; }
    let f = this.list.find((x) => x.id === msg.from);
    if (msg.type === 'hello') {
      // someone accepted one of my invites
      const inv = this.pending.find((p) => p.kid === env.k);
      if (!f && inv) {
        f = { id: msg.from, name: String(msg.name || 'Friend').slice(0, 40), key: inv.key, kid: inv.kid, color: colorFor(msg.from), added: Date.now(), unread: 0 };
        this.list.push(f);
        await this.save();
        this.emit('friend', f);
      } else if (f) { f.name = String(msg.name || f.name).slice(0, 40); await this.save(); }
      return;
    }
    if (!f || f.kid !== env.k) return;
    if (msg.type === 'np') { f.np = { title: msg.title, artist: msg.artist }; f.npAt = msg.at; await this.save(); return; }
    delete msg.state;
    if (await this.store(f.id, msg)) {
      if (this.viewing !== f.id) { f.unread = (f.unread || 0) + 1; await this.save(); }
      this.emit('message', f.id, msg, true);
    }
  }
  _saveLast() { clearTimeout(this._lt); this._lt = setTimeout(() => db.kv.set('friends:me', this.me), 800); }

  // live connection to my inbox (plus a catch-up poll when the app comes back)
  connect() {
    if (!this.me || this.es) return;
    const since = this.me.last && this.me.last !== 'all' ? this.me.last : '12h';
    this.poll(since);
    try {
      this.es = new EventSource(`${relay()}/${topic(this.me.id)},${npTopic(this.me.id)}/sse?since=${encodeURIComponent(this.me.last || '12h')}`);
      this.es.onmessage = (e) => { try { this.handle(JSON.parse(e.data)); } catch (er) { /* */ } };
      this.es.onerror = () => { /* EventSource reconnects by itself */ };
    } catch (e) { this.es = null; }
    if (!this._wired) {
      this._wired = true;
      document.addEventListener('visibilitychange', () => { if (!document.hidden && this.me) this.poll(this.me.last || '12h'); });
      setInterval(() => { if (!document.hidden && this.me && (!this.es || this.es.readyState === 2)) { this.es = null; this.connect(); } }, 30000);
    }
  }
  async poll(since) {
    try {
      const r = await fetch(`${relay()}/${topic(this.me.id)},${npTopic(this.me.id)}/json?poll=1&since=${encodeURIComponent(since || '12h')}`);
      if (!r.ok) return;
      for (const line of (await r.text()).split('\n')) { if (line.trim()) { try { await this.handle(JSON.parse(line)); } catch (e) { /* */ } } }
    } catch (e) { /* offline */ }
  }
  // ---------- push notifications (work even when Player is closed) ----------
  // The relay (ntfy) sends a Web Push to this phone for each message; the service worker decrypts it
  // on the phone and shows the notification. The relay only ever sees the encrypted envelope.
  get pushOn() { return !!this.me?.pushAt; }
  async enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('unsupported');
    const reg = await navigator.serviceWorker.ready;
    // the relay's push key: built in for ntfy.sh (its config file may not be readable from another site)
    const KNOWN = { 'https://ntfy.sh': 'BEMjM0sNxh41x0a6Lz3YaqkJ7AUhZefxsOQgw-at69i0fM1CybVBcj7-QQXf4N_tPCgFnOXdRbQ5jrSrr9Yg9Lc' };
    let key = null;
    try {
      const txt = await (await fetch(`${relay()}/config.js`, { cache: 'no-store' })).text();
      key = (txt.match(/web_push_public_key["']?\s*:\s*["']([A-Za-z0-9_-]{40,})["']/) || [])[1] || null;
    } catch (e) { /* not readable from here */ }
    key = key || KNOWN[relay()];
    if (!key) throw new Error('relay-no-push');
    const appKey = unb64u(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = sub.options?.applicationServerKey ? b64u(sub.options.applicationServerKey) : null;
      if (cur && cur !== key) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) {
      try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey }); }
      catch (e) { throw new Error(`iPhone refused the push subscription (${e.name || e.message})`); }
    }
    const j = sub.toJSON();
    let r;
    try {
      r = await fetch(`${relay()}/v1/webpush`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: j.endpoint, auth: j.keys.auth, p256dh: j.keys.p256dh, topics: [topic(this.me.id)] }),
      });
    } catch (e) { throw new Error('couldn’t reach the relay to register'); }
    if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch (e) { /* */ } throw new Error(`relay said ${r.status}${m ? ' – ' + m : ''}`); }
    this.me.pushAt = Date.now();
    await db.kv.set('friends:me', this.me);
    this.emit('change');
  }
  async disablePush() {
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) {
        await fetch(`${relay()}/v1/webpush`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
      }
    } catch (e) { /* */ }
    if (this.me) { delete this.me.pushAt; await db.kv.set('friends:me', this.me); }
    this.emit('change');
  }
  // the relay forgets push subscriptions that aren't renewed, so renew every few days
  refreshPush() {
    if (this.pushOn && Date.now() - this.me.pushAt > 4 * 86400000 && Notification.permission === 'granted') this.enablePush().catch(() => {});
  }
  reconnect() { try { this.es?.close(); } catch (e) { /* */ } this.es = null; this.connect(); }
}

const COLORS = ['#ff375f', '#ff9f0a', '#30d158', '#0a84ff', '#bf5af2', '#64d2ff', '#ffd60a', '#5e5ce6'];
function colorFor(id) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0; return COLORS[Math.abs(h) % COLORS.length]; }

export const friends = new Friends();
