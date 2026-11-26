// Minimal IndexedDB wrapper. Stores:
//  tracks   {id,...}       library index
//  art      {id, blob, colors}
//  analysis {id, bpm, ...} per-track audio analysis
//  playlists{id, name, trackIds}
//  kv       out-of-line keys: settings, source, state, stats, likes...
import { activeDbName } from './accounts.js';
// one database per account on this device (the first account keeps the original "nasplayer")
let NAME = null;
export const openedName = () => NAME;
const VERSION = 1;
const STORES = ['tracks', 'art', 'analysis', 'playlists'];
let _db;

export function open() {
  if (_db) return _db;
  NAME = activeDbName();
  _db = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); res(d); };
    r.onerror = () => rej(r.error);
  });
  return _db;
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function store(name, mode = 'readonly') {
  const d = await open();
  return d.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return req((await store(name)).get(key)); }
export async function all(name) { return req((await store(name)).getAll()); }
export async function keys(name) { return req((await store(name)).getAllKeys()); }
export async function put(name, val, key) {
  const s = await store(name, 'readwrite');
  return req(key === undefined ? s.put(val) : s.put(val, key));
}
export async function del(name, key) { return req((await store(name, 'readwrite')).delete(key)); }
export async function clear(name) { return req((await store(name, 'readwrite')).clear()); }
export async function putMany(name, vals) {
  if (!vals.length) return;
  const d = await open();
  return new Promise((res, rej) => {
    const tx = d.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of vals) s.put(v);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function delMany(name, ids) {
  if (!ids.length) return;
  const d = await open();
  return new Promise((res, rej) => {
    const tx = d.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const id of ids) s.delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export const kv = {
  get: (k) => get('kv', k),
  set: (k, v) => put('kv', v, k),
  del: (k) => del('kv', k),
};

// Shared by every account on this device: song analysis (BPM, key, beat grid, energy) and online tempos
// describe the song, not the listener — so switching accounts never measures a song twice.
let _sh;
function openShared() {
  if (_sh) return _sh;
  _sh = new Promise((res) => {
    let r;
    try { r = indexedDB.open('nasplayer-shared', 1); } catch (e) { res(null); return; }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('analysis')) d.createObjectStore('analysis', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); res(d); };
    r.onerror = () => res(null);
  });
  return _sh;
}
async function sstore(name, mode = 'readonly') { const d = await openShared(); return d ? d.transaction(name, mode).objectStore(name) : null; }
export const shared = {
  async all(name) { const s = await sstore(name); return s ? req(s.getAll()) : []; },
  async get(name, key) { const s = await sstore(name); return s ? req(s.get(key)) : undefined; },
  async put(name, val, key) { const s = await sstore(name, 'readwrite'); if (s) return req(key === undefined ? s.put(val) : s.put(val, key)); },
  async putMany(name, vals) {
    const d = await openShared(); if (!d || !vals.length) return;
    return new Promise((res) => { const tx = d.transaction(name, 'readwrite'); const s = tx.objectStore(name); for (const v of vals) s.put(v); tx.oncomplete = () => res(); tx.onerror = () => res(); });
  },
  async clear(name) { const s = await sstore(name, 'readwrite'); if (s) return req(s.clear()); },
};
export const skv = {
  get: async (k) => { const v = await shared.get('kv', k).catch(() => undefined); return v !== undefined ? v : get('kv', k); },
  set: (k, v) => shared.put('kv', v, k).catch(() => put('kv', v, k)),
};
