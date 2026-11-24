// Stats page: your listening, broken down like stats.fm / Spotify Wrapped — live, any time.
import { html, icon, esc } from '../util.js';
import { library } from '../library.js';
import { plex } from '../plex.js';
import { computeStats, RANGES } from '../stats.js';
import { art, regList, trackRow, pageHeader } from './components.js';

let range = localStorage.getItem('statsRange') || '4w';
export function setStatsRange(r) { range = r; try { localStorage.setItem('statsRange', r); } catch (e) { /* */ } }

const hm = (min) => (min >= 60 ? `${Math.floor(min / 60).toLocaleString()}h ${min % 60}m` : `${min}m`);
const delta = (a, b) => {
  if (!b) return '';
  const p = Math.round(((a - b) / b) * 100);
  return html`<em class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</em>`;
};
const pct = (x) => `${Math.round(x * 100)}%`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function statsView() {
  const s = await computeStats(range);
  const chips = html`<div class="chips stats-range">${RANGES.map(([k, l]) => html`<button class="chip${k === range ? ' on' : ''}" data-a="stats-range" data-v="${k}">${l}</button>`)}</div>`;
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
    <p class="set-foot">Counted on this phone${s.hasPlexHistory ? ' plus your Plex history' : ''}. A listen counts after 20 seconds.</p>
    <div class="bottom-pad"></div>`,
  };
}
