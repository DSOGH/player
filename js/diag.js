// Playback report: a short record of what the player did (stalls, recoveries, mixes, measuring), kept
// on the device so a freeze or a lag can be traced afterwards. Settings → Copy playback report.
const KEY = 'playerDiag';
let buf = [];
try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { buf = []; }
let saveT = null;
export function dlog(type, data = {}) {
  const d = new Date();
  buf.push([d.toISOString().slice(5, 19).replace('T', ' '), type, data]);
  if (buf.length > 300) buf = buf.slice(-300);
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch (e) { /* */ } }, 1500);
}
export function diagText() {
  const n = navigator, c = n.connection;
  const head = [`Player report · ${new Date().toISOString()}`, n.userAgent, c ? `net ${c.effectiveType || ''} ${c.type || ''} ${c.downlink || ''}Mbps` : '', `mem ${n.deviceMemory || '?'}GB`].filter(Boolean).join('\n');
  return head + '\n\n' + buf.map(([t, k, d]) => `${t} ${k} ${Object.entries(d).map(([a, b]) => `${a}=${typeof b === 'number' ? Math.round(b * 100) / 100 : b}`).join(' ')}`).join('\n');
}
export function diagClear() { buf = []; try { localStorage.removeItem(KEY); } catch (e) { /* */ } }
