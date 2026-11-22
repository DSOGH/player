// NAS sources: WebDAV (Synology, QNAP, TrueNAS, Unraid, Nextcloud, rclone...)
// and plain HTTP directory listings (nginx autoindex, Caddy browse, Apache, python -m http.server).
// All requests go through the service worker (./__nas?u=...) which adds your login.
import { nasUrl } from './util.js';
import { kv } from './db.js';

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`;

export class SourceError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

function explain(status, url) {
  if (status === 401 || status === 403) return new SourceError('auth', 'The NAS rejected the username or password.');
  if (status === 404) return new SourceError('notfound', `Folder not found: ${decodeURI(new URL(url).pathname)}`);
  if (status === 405) return new SourceError('method', 'This address doesn’t speak WebDAV. Try “HTTP folder” instead, or check the WebDAV port.');
  if (status === 502 || status === 504) return new SourceError('network', 'Couldn’t reach the NAS. Is it on, and is the address right? (It must be HTTPS and allow this site via CORS — see the setup guide.)');
  return new SourceError('http', `NAS responded with HTTP ${status}.`);
}

function ensureSlash(u) { return u.endsWith('/') ? u : u + '/'; }

export function authHeader(user, pass) {
  if (!user) return '';
  return 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass || ''}`)));
}

// Save the source config where the service worker can read it.
export async function saveSource(cfg) {
  const base = ensureSlash(cfg.url.trim());
  const out = {
    type: cfg.type, url: base, username: cfg.username || '',
    auth: authHeader(cfg.username, cfg.password),
    remember: cfg.remember !== false,
  };
  await kv.set('source', out);
  navigator.serviceWorker?.controller?.postMessage({ type: 'config-changed' });
  return out;
}
export async function loadSource() { return kv.get('source'); }

class WebDAV {
  constructor(cfg) { this.cfg = cfg; }
  async list(url) {
    let r;
    try {
      r = await fetch(nasUrl(url), {
        method: 'PROPFIND',
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
    } catch (e) { throw new SourceError('network', 'Couldn’t reach the NAS.'); }
    if (r.status !== 207 && !r.ok) throw explain(r.status, url);
    const text = await r.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const NS = 'DAV:';
    const out = [];
    const selfPath = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
    for (const resp of doc.getElementsByTagNameNS(NS, 'response')) {
      const hrefEl = resp.getElementsByTagNameNS(NS, 'href')[0];
      if (!hrefEl) continue;
      const abs = new URL(hrefEl.textContent.trim(), url);
      const path = decodeURIComponent(abs.pathname).replace(/\/+$/, '');
      if (path === selfPath) continue;
      const txt = (n) => resp.getElementsByTagNameNS(NS, n)[0]?.textContent || '';
      const isDir = resp.getElementsByTagNameNS(NS, 'collection').length > 0;
      const name = path.split('/').pop();
      out.push({
        name,
        url: isDir ? ensureSlash(abs.href) : abs.href,
        isDir,
        size: parseInt(txt('getcontentlength'), 10) || 0,
        mtime: Date.parse(txt('getlastmodified')) || 0,
        etag: txt('getetag').replace(/"/g, ''),
      });
    }
    return out;
  }
}

class HttpIndex {
  constructor(cfg) { this.cfg = cfg; }
  async list(url) {
    let r;
    try { r = await fetch(nasUrl(url), { headers: { Accept: 'application/json, text/html;q=0.9' } }); }
    catch (e) { throw new SourceError('network', 'Couldn’t reach the NAS.'); }
    if (!r.ok) throw explain(r.status, url);
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    let items = null;
    if (ct.includes('json') || /^\s*\[/.test(body)) {
      try {
        const j = JSON.parse(body);
        const arr = Array.isArray(j) ? j : j.items || j.files || [];
        items = arr.map((e) => {
          const isDir = e.is_dir ?? e.isDir ?? (e.type === 'directory' || e.type === 'dir');
          const name = String(e.name || '').replace(/\/$/, '');
          return {
            name,
            url: new URL(e.url ? e.url : encodeURIComponent(name) + (isDir ? '/' : ''), url).href,
            isDir: !!isDir,
            size: e.size || 0,
            mtime: Date.parse(e.mod_time || e.mtime || e.modified || '') || 0,
          };
        });
      } catch (e) { items = null; }
    }
    if (!items) {
      const doc = new DOMParser().parseFromString(body, 'text/html');
      items = [];
      const seen = new Set();
      const base = new URL(url);
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (!href || href.startsWith('?') || href.startsWith('#') || href.startsWith('..') || href === './' || href === '/') continue;
        const abs = new URL(href, base);
        if (abs.origin !== base.origin || !abs.pathname.startsWith(base.pathname) || abs.pathname === base.pathname) continue;
        const rel = abs.pathname.slice(base.pathname.length);
        if (rel.replace(/\/$/, '').includes('/')) continue; // only direct children
        if (seen.has(abs.href)) continue;
        seen.add(abs.href);
        const isDir = abs.pathname.endsWith('/');
        items.push({ name: decodeURIComponent(rel.replace(/\/$/, '')), url: abs.href, isDir, size: 0, mtime: 0 });
      }
    }
    return items;
  }
}

export function makeSource(cfg) {
  if (!cfg) return null;
  if (cfg.type === 'http') return new HttpIndex(cfg);
  if (cfg.type === 'webdav') return new WebDAV(cfg);
  return null;
}

export async function testSource(cfg) {
  const src = makeSource(cfg);
  const entries = await src.list(cfg.url);
  const dirs = entries.filter((e) => e.isDir).length;
  const files = entries.length - dirs;
  return { dirs, files, entries };
}
