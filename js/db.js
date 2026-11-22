// Minimal IndexedDB wrapper. Stores:
//  tracks   {id,...}       library index
//  art      {id, blob, colors}
//  analysis {id, bpm, ...} per-track audio analysis
//  playlists{id, name, trackIds}
//  kv       out-of-line keys: settings, source, state, stats, likes...
const NAME = 'nasplayer';
const VERSION = 1;
const STORES = ['tracks', 'art', 'analysis', 'playlists'];
let _db;

export function open() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
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
