// Stats page: your listening, broken down like stats.fm / Spotify Wrapped — live, any time.
import { html, icon, esc } from '../util.js';
import { library } from '../library.js';
import { plex, deviceName as dn } from '../plex.js';
const deviceName = () => (dn() === 'Web' ? 'device' : dn());
import { computeStats, allListens, RANGES } from '../stats.js';
import { art, regList, trackRow, pageHeader } from './components.js';

let range = localStorage.getItem('statsRange') || '4w';
let source = localStorage.getItem('statsSource') || 'device';
export function setStatsRange(r) { range = r; try { localStorage.setItem('statsRange', r); } catch (e) { /* */ } }
export function setStatsSource(v) { source = v; try { localStorage.setItem('statsSource', v); } catch (e) { /* */ } }
const sourceChips = (has) => (has ? html`<div class="seg stats-src">
  <button class="${source === 'device' ? 'on' : ''}" data-a="stats-source" data-v="device">This ${deviceName()}</button>
  <button class="${source === 'all' ? 'on' : ''}" data-a="stats-source" data-v="all">All devices (Plex)</button></div>` : '');

const hm = (min) => (min >= 60 ? `${Math.floor(min / 60).toLocaleString()}h ${min % 60}m` : `${min}m`);
const delta = (a, b) => {
  if (!b) return '';
  const p = Math.round(((a - b) / b) * 100);
  return html`<em class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</em>`;
};
const pct = (x) => `${Math.round(x * 100)}%`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function statsView() {
  if (!library.plexHistory) await allListens('all');
  const has = !!library.plexHistory?.length;
  const src = has ? source : 'device';
  const s = await computeStats(range, src);
  const chips = html`${sourceChips(has)}<div class="chips stats-range">${RANGES.map(([k, l]) => html`<button class="chip${k === range ? ' on' : ''}" data-a="stats-range" data-v="${k}">${l}</button>`)}</div>`;
  const plexRow = plex.connected ? html`<button class="stats-plex" data-a="stats-import">${icon('refresh')}<span>${s.hasPlexHistory ? 'Refresh history from Plex' : 'Import your listening history from Plex'}</span></button>` : '';
  if (s.empty) {
    return {
      title: 'Stats',
      html: html`${pageHeader('Your Stats', { back: true })}${chips}
        <div class="empty"><div class="empty-ic">${icon('bpm')}</div><h3>No listens ${range === 'all' ? 'yet' : 'in this period'}</h3>
        <p>Play some music and your stats build up here — top songs, artists, minutes, streaks and more.</p></div>${plexRow}<div class="bottom-pad"></div>`,
    };
  }
  const topKey = regList(s.tracks.slice(0, 50).map((x) => x.track), { type: 'mix', name: 'Your Top Songs' });
  const maxT = Math.max(1, ...s.timeline.map((b) => b.sec));
  const maxH = Math.max(1, ...s.hours);
  const maxW = Math.max(1, ...s.weekdays);
  const peakHour = s.hours.indexOf(Math.max(...s.hours));
  const peakDay = s.weekdays.indexOf(Math.max(...s.weekdays));
  const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  const top = s.artists[0];
  const maxG = Math.max(1, ...s.genres.map((g) => g.plays));
  const maxD = Math.max(1, ...s.decades.map((g) => g.plays));
  return {
    title: 'Stats',
    html: html`${pageHeader('Your Stats', { back: true })}${chips}
    <section class="stats-hero" data-tint="${top?.artist?.artId || ''}">
      <div class="sh-main"><small>Minutes listened</small><b>${s.minutes.toLocaleString()}</b>${delta(s.minutes, s.prevMinutes)}</div>
      <div class="sh-grid">
        <div><b>${s.plays.toLocaleString()}</b><span>streams ${delta(s.plays, s.prevPlays)}</span></div>
        <div><b>${s.uniqueTracks.toLocaleString()}</b><span>different songs</span></div>
        <div><b>${s.uniqueArtists.toLocaleString()}</b><span>artists</span></div>
        <div><b>${hm(s.perDayAvg)}</b><span>per day</span></div>
      </div>
    </section>

    <a class="stats-history-link" href="#/history">${icon('timer')}<span><b>Listening history</b><small>Every song you played${src === 'device' ? ` on this ${deviceName()}` : ''}, by day</small></span>${icon('right', 'chev')}</a>

    <section class="stats-card"><h2>Listening over time</h2>
      <div class="st-chart ${s.bucket}">${s.timeline.map((b, i) => html`<div class="st-col" title="${hm(Math.round(b.sec / 60))}"><i style="height:${Math.max(2, (b.sec / maxT) * 100)}%"></i>${(s.bucket === 'day' ? i % 7 === 6 : s.bucket === 'week' ? i % 4 === 0 : i % Math.max(1, Math.ceil(s.timeline.length / 8)) === 0) ? html`<span>${b.label}</span>` : ''}</div>`)}</div>
    </section>

    ${top ? html`<a class="stats-top-artist" href="#/artist/${top.artist.id}">
      ${art(top.artist.artId, 'top-art round')}
      <div><small>Your #1 artist</small><b>${top.artist.name}</b><span>${top.plays} streams · ${hm(Math.round(top.sec / 60))}</span></div></a>` : ''}

    <section class="stats-card"><div class="st-head"><h2>Top artists</h2></div>
      <ol class="st-list">${s.artists.slice(0, 10).map((a, i) => html`<li><a href="#/artist/${a.artist.id}"><span class="st-n">${i + 1}</span>${art(a.artist.artId, 'xs round')}<div class="st-meta"><b>${a.artist.name}</b><small>${a.plays} streams · ${hm(Math.round(a.sec / 60))}</small></div></a></li>`)}</ol>
    </section>

    <section class="stats-card"><div class="st-head"><h2>Top songs</h2><button class="pill-sm" data-a="play-list" data-list="${topKey}" data-i="0">${icon('play')}Play</button></div>
      <div class="rows st-songs">${s.tracks.slice(0, 10).map((x, i) => html`<div class="st-song"><span class="st-n">${i + 1}</span>${trackRow(x.track, i, topKey, { extra: html`<span class="st-plays">${x.plays}×</span>` })}</div>`)}</div>
    </section>

    <section class="stats-card"><h2>Top albums</h2>
      <div class="st-albums">${s.albums.slice(0, 10).map((a, i) => html`<a href="#/album/${a.album.id}" class="st-album">${art(a.album.artId, 'card-art')}<b>${i + 1}. ${a.album.title}</b><small>${a.plays} streams</small></a>`)}</div>
    </section>

    ${s.obsession?.track ? html`<section class="stats-card obsession"><h2>Obsessed</h2>
      <div class="st-obs">${art(s.obsession.track.artId, 'sm')}<div><b>${s.obsession.track.title}</b><small>${s.obsession.plays} times on ${new Date(s.obsession.day + 'T12:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</small></div></div></section>` : ''}

    <section class="stats-card"><h2>When you listen</h2>
      <p class="st-sub">Mostly around <b>${hourLabel(peakHour)}</b>, and most on <b>${DAYS[peakDay]}s</b>.</p>
      <div class="st-hours">${s.hours.map((v, h) => html`<div class="st-col"><i style="height:${Math.max(3, (v / maxH) * 100)}%"></i>${h % 6 === 0 ? html`<span>${hourLabel(h)}</span>` : ''}</div>`)}</div>
      <div class="st-week">${s.weekdays.map((v, d) => html`<div><i style="opacity:${0.15 + 0.85 * (v / maxW)}"></i><span>${DAYS[d][0]}</span></div>`)}</div>
    </section>

    <section class="stats-card"><h2>Streaks</h2>
      <div class="st-streak"><div><b>${s.streak}</b><span>day${s.streak === 1 ? '' : 's'} in a row now</span></div><div><b>${s.longest}</b><span>longest streak</span></div></div>
    </section>

    ${s.genres.length ? html`<section class="stats-card"><h2>Top genres</h2>
      <div class="st-bars">${s.genres.map((g) => html`<div class="st-bar"><span>${esc(g.key)}</span><i style="width:${(g.plays / maxG) * 100}%"></i><b>${g.plays}</b></div>`)}</div></section>` : ''}

    ${s.decades.length > 1 ? html`<section class="stats-card"><h2>Decades</h2>
      <div class="st-bars">${s.decades.map((g) => html`<div class="st-bar"><span>${g.key}</span><i style="width:${(g.plays / maxD) * 100}%"></i><b>${g.plays}</b></div>`)}</div></section>` : ''}

    <section class="stats-card"><h2>Your sound</h2>
      <div class="st-sound">
        ${s.sound.bpm ? html`<div><b>${s.sound.bpm}</b><span>average BPM</span></div>` : ''}
        ${s.sound.key ? html`<div><b>${s.sound.key}</b><span>favorite key</span></div>` : ''}
        <div><b>${pct(s.sound.lossless)}</b><span>lossless</span></div>
        <div><b>${pct(s.sound.explicit)}</b><span>explicit</span></div>
        ${Object.keys(s.mixes).length ? html`<div><b>${Object.values(s.mixes).reduce((a, b) => a + b, 0)}</b><span>DJ mixes</span></div>` : ''}
      </div>
    </section>
    ${plexRow}
    <p class="set-foot">${src === 'device' ? `Only music played on this ${deviceName()}.` : 'This phone plus your Plex history from other apps and devices.'} A listen counts after 20 seconds.</p>
    <div class="bottom-pad"></div>`,
  };
}

// ---------- Listening history: every listen, newest first, grouped by day ----------
let histLimit = 150;
export function moreHistory() { histLimit += 300; }
export async function historyView() {
  if (!library.plexHistory) await allListens('all');
  const has = !!library.plexHistory?.length;
  const src = has ? source : 'device';
  const list = (await allListens(src)).reverse();
  const shown = list.slice(0, histLimit);
  const key = regList(shown.map((e) => library.track(e[0])), { type: 'history', name: 'Listening History' });
  const dayLabel = (ts) => {
    const d = new Date(ts * 1000), today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  };
  const dayTotals = new Map();
  for (const e of list) { const k = new Date(e[1] * 1000).toDateString(); dayTotals.set(k, (dayTotals.get(k) || 0) + e[2]); }
  const out = [];
  let lastDay = null;
  shown.forEach((e, i) => {
    const t = library.track(e[0]);
    const dk = new Date(e[1] * 1000).toDateString();
    if (dk !== lastDay) {
      lastDay = dk;
      const mins = Math.round((dayTotals.get(dk) || 0) / 60);
      out.push(html`<div class="hist-day"><b>${dayLabel(e[1])}</b><span>${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`}</span></div>`);
    }
    const when = new Date(e[1] * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const meta = html`<span class="hist-when">${e[4] === 'now' ? html`<i class="live"></i>Now` : when}${e[3] === 'p' ? html`<em>Plex</em>` : ''}</span>`;
    out.push(trackRow(t, i, key, { showAlbum: true, extra: meta }));
  });
  const minutes = Math.round(list.reduce((s2, e) => s2 + e[2], 0) / 60);
  return {
    title: 'Listening History',
    html: html`${pageHeader('Listening History', { back: true })}${sourceChips(has)}
    <div class="lib-count">${list.length.toLocaleString()} listens · ${minutes >= 60 ? `${Math.floor(minutes / 60).toLocaleString()} hours` : `${minutes} min`}${src === 'device' ? ` on this ${deviceName()}` : ''}</div>
    ${list.length ? html`<div class="rows hist-rows">${out}</div>` : html`<div class="empty"><div class="empty-ic">${icon('timer')}</div><h3>Nothing yet</h3><p>Every song you listen to for 20 seconds or more shows up here, with the time you played it.</p></div>`}
    ${list.length > shown.length ? html`<button class="btn pill ghost hist-more" data-a="history-more">Show more</button>` : ''}
    <div class="bottom-pad"></div>`,
  };
}
