// Accounts on this device. Each one is a complete, separate Player — its own Plex (or NAS) sign-in,
// library, likes, playlists, stats, friends and settings — kept in its own on-device database.
// Switching never signs anything out: every account stays signed in and is one tap away.
// The list itself is tiny and lives in localStorage so it can be read before anything else starts.
const KEY = 'playerAccounts';
export const COLORS = [
  ['#ff4e6a', '#ff9a5a'], ['#7b5cff', '#3fa8ff'], ['#00c48c', '#00a3c4'], ['#ffb400', '#ff6a00'],
  ['#ff5ac8', '#8f5cff'], ['#3d7bff', '#00e0c6'], ['#e94057', '#8a2387'], ['#20bf55', '#01baef'],
];

function blank() { return { v: 1, list: [{ id: 'main', name: '', color: 1, created: Date.now() }], active: 'main', ask: true }; }
function read() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s?.list?.length) return s; } catch (e) { /* */ }
  return blank();
}
function write(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* */ }
  writeMeta(dbNameOf(s.active));
}
export const dbNameOf = (id) => (!id || id === 'main' ? 'nasplayer' : 'nasplayer_' + id);
export function activeDbName() { return dbNameOf(read().active); }

// the service worker can't read localStorage, so the active database's name is mirrored into IndexedDB
export function writeMeta(name = activeDbName()) {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('nasplayer-meta', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => {
        const d = r.result;
        try {
          const tx = d.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(name, 'activeDb');
          tx.oncomplete = () => { d.close(); res(); };
          tx.onerror = () => { d.close(); res(); };
        } catch (e) { d.close(); res(); }
      };
      r.onerror = () => res();
    } catch (e) { res(); }
  });
}

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const accounts = {
  get all() { return read().list; },
  get activeId() { return read().active; },
  get active() { const s = read(); return s.list.find((a) => a.id === s.active) || s.list[0]; },
  get ask() { return read().ask !== false; },
  set ask(v) { const s = read(); s.ask = !!v; write(s); },
  get(id) { return read().list.find((a) => a.id === id); },
  label(a) { return a?.name || a?.plexName || 'Me'; },
  colors(a) { return COLORS[(a?.color ?? 1) % COLORS.length]; },

  add({ name, color }) {
    const s = read();
    const id = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
    s.list.push({ id, name: String(name || '').trim().slice(0, 24), color: color ?? (s.list.length % COLORS.length), created: Date.now() });
    write(s);
    return id;
  },
  update(id, patch) {
    const s = read();
    const a = s.list.find((x) => x.id === id);
    if (!a) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) if (a[k] !== v) { a[k] = v; changed = true; }
    if (changed) write(s);
  },
  // forget an account and everything it stored on this device (downloads stay; other accounts may use them)
  async remove(id) {
    const s = read();
    if (s.list.length <= 1 || id === s.active) return false;
    s.list = s.list.filter((a) => a.id !== id);
    write(s);
    sessionStorage.removeItem('unlocked:' + id);
    await new Promise((res) => {
      try {
        const r = indexedDB.deleteDatabase(dbNameOf(id));
        r.onsuccess = r.onerror = () => res();
        r.onblocked = () => setTimeout(res, 800);
      } catch (e) { res(); }
    });
    return true;
  },

  hasPin(id) { return !!this.get(id)?.pin; },
  // the PIN hash doesn't depend on this device's account id, so a PIN keeps working when the account is
  // restored on another device (older PINs, tied to the local id, still work too)
  async setPin(id, pin) { this.update(id, { pin: pin ? await sha('player-pin:' + pin) : '' }); if (pin) this.markUnlocked(id); },
  async checkPin(id, pin) { const a = this.get(id); return !!a?.pin && (a.pin === await sha('player-pin:' + pin) || a.pin === await sha(id + ':' + pin)); },
  roster() { try { return JSON.parse(localStorage.getItem('playerCloudRoster')) || null; } catch (e) { return null; } },
  // accounts saved in the cloud that aren't on this device yet
  cloudOnly() { const r = this.roster(); const have = new Set(this.all.map((a) => a.cid).filter(Boolean)); return (r?.list || []).filter((x) => x.cid && !have.has(x.cid)); },
  isUnlocked(id) { return !this.hasPin(id) || sessionStorage.getItem('unlocked:' + id) === '1'; },
  markUnlocked(id) { try { sessionStorage.setItem('unlocked:' + id, '1'); } catch (e) { /* */ } },
  lock(id = this.activeId) { try { sessionStorage.removeItem('unlocked:' + id); } catch (e) { /* */ } },

  // pick the account before anything opens a database (at launch) → no reload needed
  choose(id) {
    const s = read();
    if (!s.list.some((a) => a.id === id)) return;
    s.active = id;
    s.list.find((a) => a.id === id).used = Date.now();
    write(s);
  },
  // from inside a running app: save, point everything at the other account, and restart cleanly
  async switchTo(id, { hash = '#/home', then = '' } = {}) {
    this.choose(id);
    this.markUnlocked(id);
    await writeMeta(dbNameOf(id));
    navigator.serviceWorker?.controller?.postMessage({ type: 'account-changed' });
    try { sessionStorage.setItem('picked', id); if (then) sessionStorage.setItem('afterSwitch', then); } catch (e) { /* */ }
    location.replace(location.pathname + location.search + hash);
    setTimeout(() => location.reload(), 30);
  },
  // the launch screen shows when there's more than one account (and you want to be asked), or the
  // account is PIN-locked and hasn't been unlocked since the app was opened
  needsPicker() {
    const s = read();
    if (sessionStorage.getItem('picked')) return !this.isUnlocked(s.active);
    if (s.list.length + this.cloudOnly().length > 1 && s.ask !== false) return true;
    return !this.isUnlocked(s.active);
  },
};
