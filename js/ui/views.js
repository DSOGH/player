// Library views (rendered into #view by the router in app.js)
import { html, raw, icon, fmtDuration, greeting, sortKey, $ } from '../util.js';
import { library } from '../library.js';
import { settings } from '../settings.js';
import { engine } from '../engine.js';
import { scanner } from '../scanner.js';
import { artUrl } from '../art.js';
import { plex } from '../plex.js';
import { plexLogo } from './plex-view.js';
import {
  art, trackRow, albumCard, artistCard, mixCard, shelf, regList, empty, pageHeader, badges, formatLine,
} from './components.js';

// ---------- lazy lists ----------
const lazy = new Map();
let lazySeq = 0;
export function lazyRows(tracks, listKey, opts = {}, first = 120) {
  const id = 'z' + ++lazySeq;
  const head = tracks.slice(0, first).map((t, i) => trackRow(t, i, listKey, opts));
  if (tracks.length > first) lazy.set(id, { tracks, listKey, opts, pos: first });
  return html`<div class="rows" data-lazy="${id}">${head}</div>${tracks.length > first ? html`<div class="lazy-sentinel" data-sentinel="${id}"></div>` : ''}`;
}
export function hydrateLazy(root) {
  for (const s of root.querySelectorAll('[data-sentinel]')) {
    const id = s.dataset.sentinel;
    const io = new IntersectionObserver((ents) => {
      if (!ents.some((e) => e.isIntersecting)) return;
      const L = lazy.get(id);
      const box = root.querySelector(`[data-lazy="${id}"]`);
      if (!L || !box) { io.disconnect(); return; }
      const chunk = L.tracks.slice(L.pos, L.pos + 200);
      box.insertAdjacentHTML('beforeend', chunk.map((t, i) => trackRow(t, L.pos + i, L.listKey, L.opts)).join(''));
      L.pos += chunk.length;
      if (L.pos >= L.tracks.length) { io.disconnect(); s.remove(); lazy.delete(id); }
    }, { rootMargin: '800px' });
    io.observe(s);
  }
}

function playButtons(listKey, { extra = '' } = {}) {
  return html`<div class="play-btns">
    <button class="btn pill primary" data-a="play-all" data-list="${listKey}">${icon('play')}Play</button>
    <button class="btn pill" data-a="shuffle-all" data-list="${listKey}">${icon('shuffle')}Shuffle</button>
    <button class="icon-btn round-btn" data-a="dj-list" data-list="${listKey}" aria-label="Play as DJ set">${icon('mix')}</button>
    ${raw(extra)}
  </div>`;
}

function scanBanner() {
  if (plex.running && plex.progress) {
    const q = plex.progress;
    return html`<div class="scan-banner" data-scan-banner data-kind="plex">
      <div class="spinner"></div>
      <div><b>${q.phase}</b><span>${q.total ? `${q.done} of ${q.total} songs from ${plex.cfg?.server?.name || 'Plex'}` : `Syncing with ${plex.cfg?.server?.name || 'Plex'}…`}</span></div>
    </div>`;
  }
  const p = scanner.progress;
  if (!scanner.running || !p) return '';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return html`<div class="scan-banner" data-scan-banner>
    <div class="spinner"></div>
    <div><b>${p.phase}</b><span>${p.total ? `${p.done} of ${p.total} songs · ${pct}%` : `${p.found} songs in ${p.dirs} folders`}</span></div>
  </div>`;
}

// ---------- home ----------
export function home() {
  if (!library.size) {
    const busy = plex.running || scanner.running;
    return {
      title: 'Welcome',
      html: html`<div class="welcome">
        <div class="welcome-bg"><i></i><i></i><i></i></div>
        <div class="welcome-inner">
          <img class="welcome-icon" src="./icons/icon-192.png" alt="">
          <h1>Player</h1>
          <p>All your music. Beautiful transitions.<br>Lossless, from your own server.</p>
          ${busy ? scanBanner() : plex.connected ? html`
            <div class="welcome-status">${plexLogo()}<div><b>Signed in as ${plex.user?.name || 'you'}</b><span>${plex.progress?.phase === 'Error' ? plex.progress.error : `Server: ${plex.cfg.server.name}`}</span></div></div>
            <button class="btn pill primary big plex-btn" data-a="plex-sync">${icon('refresh')}${plex.progress?.phase === 'Error' ? 'Try again' : 'Load my music'}</button>
            <a class="btn pill big glass" href="#/settings/plex">Plex settings</a>` : plex.signedIn ? html`
            <a class="btn pill primary big plex-btn" href="#/settings/plex">${plexLogo()}Choose your Plex server</a>` : html`
            <button class="btn pill primary big plex-btn" data-a="plex-signin">${plexLogo()}Sign in with Plex</button>
            <a class="btn pill big glass" href="#/settings/source">${icon('server')}Connect a NAS folder</a>
            <button class="btn pill big link-btn" data-a="demo">Try the demo library</button>`}
        </div>
      </div>`,
    };
  }
  const recent = library.recentAlbums(12);
  const added = library.recentlyAdded(16);
  const quick = (recent.length >= 4 ? recent : added).slice(0, 6);
  const mixes = library.mixes();
  const most = library.mostPlayed(20);
  const mostKey = regList(most, { type: 'mix', name: 'Most Played' });
  const rediscover = library.sortedAlbums('title').sort(() => Math.random() - 0.5).slice(0, 12);
  const likedN = library.likes.size;
  return {
    title: 'Home',
    html: html`${pageHeader(greeting(), { actions: html`<a class="icon-btn" href="#/settings" aria-label="Settings">${icon('settings')}</a>` })}
    ${scanBanner()}
    <div class="quick-grid">
      ${likedN ? html`<a class="quick" href="#/liked"><div class="art quick-art liked-art">${icon('heart-fill')}</div><span>Liked Songs</span></a>` : ''}
      ${quick.slice(0, likedN ? 5 : 6).map((a) => html`<a class="quick" href="#/album/${a.id}">${art(a.artId, 'quick-art')}<span>${a.title}</span></a>`)}
    </div>
    ${weekCard()}
    ${shelf('Made for You', mixes.map(mixCard), { cls: 'mixes' })}
    ${recent.length ? shelf('Jump Back In', recent.map((a) => albumCard(a))) : ''}
    ${shelf('Recently Added', added.map((a) => albumCard(a)), { href: '#/library/albums' })}
    ${most.length >= 5 ? html`<section class="shelf"><div class="shelf-head"><h2>On Repeat</h2></div>
      <div class="rows grid-rows">${most.slice(0, 8).map((t, i) => trackRow(t, i, mostKey))}</div></section>` : ''}
    ${shelf('Rediscover', rediscover.map((a) => albumCard(a)))}
    ${shelf('Artists', library.sortedArtists().filter((a) => a.albums.size).sort(() => Math.random() - 0.5).slice(0, 14).map(artistCard), { href: '#/library/artists' })}
    <div class="bottom-pad"></div>`,
  };
}

function weekCard() {
  const w = library.weekStats();
  if (w.minutes < 1 && !w.mixes) return '';
  const max = Math.max(1, ...w.byDay);
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date().getDay();
  return html`<section class="week-card">
    <div class="wk-top"><div><small>Your week</small><b>${Math.floor(w.minutes / 60)}h ${w.minutes % 60}m</b></div>
      <div class="wk-bars">${w.byDay.map((m, i) => html`<div class="wk-bar"><i style="height:${Math.max(4, (m / max) * 100)}%"></i><span>${days[(today - 6 + i + 7) % 7]}</span></div>`)}</div></div>
    <div class="wk-stats">
      <div><b>${w.mixes}</b><span>DJ mixes</span></div>
      <div><b>${w.plays}</b><span>songs</span></div>
      ${w.topArtist ? html`<a href="#/artist/${w.topArtist.id}"><b>${w.topArtist.name}</b><span>top artist</span></a>` : ''}
    </div>
  </section>`;
}

// ---------- library ----------
const TABS = [['playlists', 'Playlists'], ['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs'], ['genres', 'Genres'], ['history', 'History'], ['downloaded', 'Downloaded']];
export function libraryView(tab = 'albums') {
  const chips = html`<div class="chips">${TABS.map(([k, l]) => html`<a class="chip${k === tab ? ' on' : ''}" href="#/library/${k}">${l}</a>`)}</div>`;
  let body = '';
  let actions = '';
  if (!library.size && tab !== 'playlists') {
    body = plex.connected
      ? empty('library', plex.running ? 'Loading your music…' : 'No music yet', plex.running ? `Syncing with ${plex.cfg.server.name}.` : `Signed in to Plex (${plex.cfg.server.name}). Tap below to load your library.`,
        `<button class="btn pill primary plex-btn" data-a="plex-sync">Load my music</button>`)
      : empty('library', 'No music yet', 'Each device keeps its own library — sign in on this phone too.',
        `<div class="empty-btns"><button class="btn pill primary plex-btn" data-a="plex-signin">${plexLogo()}Sign in with Plex</button><a class="btn pill" href="#/settings/source">Connect a NAS folder</a></div>`);
  }
  else if (tab === 'albums') {
    const sort = settings.get('albumSort');
    actions = html`<button class="icon-btn" data-a="album-sort" aria-label="Sort">${icon('sort')}</button>`;
    const albums = library.sortedAlbums(sort);
    body = html`<div class="lib-count">${albums.length} albums · sorted by ${{ title: 'title', artist: 'artist', year: 'year', added: 'recently added' }[sort]}</div>
      <div class="grid cols-${settings.get('gridCols')}">${albums.map((a) => albumCard(a))}</div>`;
  } else if (tab === 'artists') {
    const list = library.sortedArtists();
    let letter = '';
    body = html`<div class="lib-count">${list.length} artists</div><div class="rows">${list.map((ar) => {
      const L = (sortKey(ar.name)[0] || '#').toUpperCase();
      const head = L !== letter ? ((letter = L), html`<div class="letter">${/[A-Z]/.test(L) ? L : '#'}</div>`) : '';
      return html`${head}<a class="row" href="#/artist/${ar.id}">${art(ar.artId, 'sm round')}<div class="meta"><div class="t1">${ar.name}</div><div class="t2">${ar.albums.size ? `${ar.albums.size} album${ar.albums.size > 1 ? 's' : ''}` : 'Appears on'}</div></div>${icon('right', 'chev')}</a>`;
    })}</div>`;
  } else if (tab === 'songs') {
    const list = library.sortedTracks();
    const key = regList(list, { type: 'songs', name: 'Songs' });
    body = html`<div class="lib-count">${list.length} songs</div>${playButtons(key)}${lazyRows(list, key, { showAlbum: true })}`;
  } else if (tab === 'genres') {
    const gs = [...library.genres.values()].sort((a, b) => b.tracks.length - a.tracks.length);
    body = gs.length ? html`<div class="genre-grid">${gs.map((g, i) => genreTile(g, i))}</div>` : empty('genre', 'No genres', 'Your files don’t have genre tags yet.');
  } else if (tab === 'playlists') {
    const pls = [...library.playlists.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    body = html`<div class="rows">
      <button class="row" data-a="new-playlist"><div class="art sm add-art">${icon('plus')}</div><div class="meta"><div class="t1 accent">New Playlist…</div></div></button>
      <a class="row" href="#/liked"><div class="art sm liked-art">${icon('heart-fill')}</div><div class="meta"><div class="t1">Liked Songs</div><div class="t2">${library.likes.size} songs</div></div>${icon('right', 'chev')}</a>
      ${pls.map((p) => html`<a class="row" href="#/playlist/${p.id}">${playlistArt(p, 'sm')}<div class="meta"><div class="t1">${p.name}</div><div class="t2">${p.source === 'nas' ? 'From NAS · ' : p.source === 'plex' ? 'From Plex · ' : ''}${p.trackIds.length} songs</div></div>${icon('right', 'chev')}</a>`)}
    </div>`;
  } else if (tab === 'history') {
    const list = library.recentlyPlayed(200);
    const key = regList(list, { type: 'history', name: 'Recently Played' });
    body = list.length ? html`<div class="lib-count">Recently played</div>${lazyRows(list, key, { showAlbum: true })}`
      : empty('timer', 'Nothing played yet', 'Songs you listen to show up here.');
  } else if (tab === 'downloaded') {
    const list = [...library.tracks.values()].filter((t) => library.isOffline(t));
    const key = regList(list, { type: 'downloaded', name: 'Downloaded' });
    body = list.length ? html`${playButtons(key)}${lazyRows(list, key, { showAlbum: true })}`
      : empty('download', 'Nothing downloaded', 'Download albums or playlists to play them without your NAS — great for the car or a flight.');
  }
  return { title: 'Library', html: html`${pageHeader('Library', { actions })}${chips}${scanBanner()}${body}<div class="bottom-pad"></div>` };
}

const GENRE_COLORS = ['#e13300', '#7358ff', '#1e3264', '#e8115b', '#148a08', '#bc5900', '#509bf5', '#8d67ab', '#e91429', '#27856a', '#af2896', '#477d95'];
function genreTile(g, i) {
  const a = library.album([...g.albums][0]);
  return html`<a class="genre-tile" href="#/genre/${encodeURIComponent(g.id)}" style="background:${GENRE_COLORS[i % GENRE_COLORS.length]}">
    <span>${g.name}</span>${a?.artId ? html`<img src="${artUrl(a.artId, 200)}" alt="" loading="lazy">` : ''}
  </a>`;
}

export function playlistArt(p, cls = '') {
  const ids = [];
  for (const id of p.trackIds) {
    const t = library.track(id);
    if (t?.artId && !ids.includes(t.artId)) ids.push(t.artId);
    if (ids.length >= 4) break;
  }
  if (ids.length < 4) return art(ids[0], cls);
  return html`<div class="art mosaic ${cls}">${ids.map((id) => html`<img src="${artUrl(id, 300)}" alt="" loading="lazy">`)}</div>`;
}

// ---------- album ----------
export function albumView(id) {
  const a = library.album(id);
  if (!a) return notFound();
  const key = regList(a.tracks, { type: 'album', id: a.id, name: a.title });
  const multi = a.discs > 1;
  let disc = 0;
  const rows = a.tracks.map((t, i) => {
    let head = '';
    if (multi && (t.disc || 1) !== disc) { disc = t.disc || 1; head = html`<div class="disc-head">Disc ${disc}</div>`; }
    const extra = t.artist !== a.artist && a.artist !== '' ? '' : '';
    return html`${head}${trackRow(t, i, key, { num: true, extra })}`;
  });
  const allOff = a.tracks.every((t) => library.isOffline(t));
  const more = library.artist(a.artistId);
  const others = more ? library.artistAlbums(more).filter((x) => x.id !== a.id) : [];
  const first = a.tracks[0];
  return {
    title: a.title,
    html: html`${pageHeader('', { back: true, actions: html`<button class="icon-btn" data-a="album-menu" data-id="${a.id}">${icon('more')}</button>` })}
    <div class="hero album-hero" data-tint="${a.artId || ''}">
      ${art(a.artId, 'hero-art', a.title)}
      <h1 class="hero-title">${a.title}${a.edition === 'explicit' ? html`<span class="ebadge big">E</span>` : ''}</h1>
      <a class="hero-sub accent" href="#/artist/${a.artistId}">${a.artist}</a>
      ${a.editions?.length > 1 ? html`<div class="seg edition-switch">${a.editions.map((e, i) => html`<a class="${e.id === a.id ? 'on' : ''}" href="#/album/${e.id}">${e.edition === 'explicit' ? 'Explicit' : e.edition === 'clean' ? 'Clean' : `Version ${i + 1}`}</a>`)}</div>` : ''}
      <div class="hero-meta">${[a.genre, a.year || ''].filter(Boolean).join(' · ')} ${badges(first, { compact: true })}</div>
      ${playButtons(key, { extra: html`<button class="icon-btn round-btn${allOff ? ' on' : ''}" data-a="download-album" data-id="${a.id}" aria-label="Download">${icon(allOff ? 'downloaded' : 'download')}</button>` })}
    </div>
    <div class="rows album-rows">${rows}</div>
    <div class="album-foot">${a.year ? `${a.year}\n` : ''}${a.tracks.length} song${a.tracks.length > 1 ? 's' : ''}, ${fmtDuration(a.duration)}${first ? `\n${formatLine(first)}` : ''}</div>
    ${others.length ? shelf(`More by ${a.artist}`, others.map((x) => albumCard(x, { sub: 'year' }))) : ''}
    <div class="bottom-pad"></div>`,
  };
}

// ---------- artist ----------
export function artistView(id) {
  const ar = library.artist(id);
  if (!ar) return notFound();
  const albums = library.artistAlbums(ar);
  const appears = [...ar.appears].map((x) => library.album(x)).filter(Boolean);
  const top = library.artistTopTracks(ar, 5);
  const all = [...new Map([...albums.flatMap((a) => a.tracks), ...ar.tracks].map((t) => [t.id, t])).values()];
  const key = regList(all, { type: 'artist', id: ar.id, name: ar.name });
  const topKey = regList(top, { type: 'artist', id: ar.id, name: ar.name });
  return {
    title: ar.name,
    html: html`${pageHeader('', { back: true })}
    <div class="artist-hero">
      ${ar.artId ? html`<div class="artist-bg" style="background-image:url('${artUrl(ar.artId, 300)}')"></div>` : ''}
      ${art(ar.artId, 'artist-avatar round', ar.name)}
      <h1 class="hero-title">${ar.name}</h1>
      <div class="hero-meta">${albums.length} album${albums.length === 1 ? '' : 's'} · ${all.length} songs</div>
      ${playButtons(key)}
    </div>
    ${top.length ? html`<section class="shelf"><div class="shelf-head"><h2>Top Songs</h2></div><div class="rows">${top.map((t, i) => trackRow(t, i, topKey, { showAlbum: false }))}</div></section>` : ''}
    ${albums.length ? html`<section class="shelf"><div class="shelf-head"><h2>Albums</h2></div><div class="grid cols-${settings.get('gridCols')}">${albums.map((a) => albumCard(a, { sub: 'year' }))}</div></section>` : ''}
    ${shelf('Appears On', appears.map((a) => albumCard(a)))}
    <div class="bottom-pad"></div>`,
  };
}

// ---------- playlists / liked / genre / mix ----------
function trackListPage({ title, sub, artHtml, tracks, context, actions = '', rowOpts = { showAlbum: true }, emptyMsg }) {
  const key = regList(tracks, context);
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return html`${pageHeader('', { back: true, actions })}
    <div class="hero album-hero">
      ${artHtml}
      <h1 class="hero-title">${title}</h1>
      ${sub ? html`<div class="hero-sub">${sub}</div>` : ''}
      <div class="hero-meta">${tracks.length} songs · ${fmtDuration(dur)}</div>
      ${tracks.length ? playButtons(key) : ''}
    </div>
    ${tracks.length ? lazyRows(tracks, key, rowOpts) : emptyMsg || ''}
    <div class="bottom-pad"></div>`;
}
export function playlistView(id) {
  const p = library.playlists.get(id);
  if (!p) return notFound();
  const tracks = library.playlistTracks(p);
  return {
    title: p.name,
    html: trackListPage({
      title: p.name, sub: p.source === 'nas' ? 'Playlist from your NAS' : p.source === 'plex' ? `Plex ${p.smart ? 'smart ' : ''}playlist` : 'Playlist', artHtml: playlistArt(p, 'hero-art'),
      tracks, context: { type: 'playlist', id: p.id, name: p.name },
      actions: html`<button class="icon-btn" data-a="playlist-menu" data-id="${p.id}">${icon('more')}</button>`,
      emptyMsg: empty('playlist', 'Empty playlist', 'Use “Add to Playlist” from any song’s ••• menu.'),
    }),
  };
}
export function likedView() {
  const tracks = [...library.likes].map((id) => library.track(id)).filter(Boolean).reverse();
  return {
    title: 'Liked Songs',
    html: trackListPage({
      title: 'Liked Songs', artHtml: html`<div class="art hero-art liked-art">${icon('heart-fill')}</div>`, tracks,
      context: { type: 'liked', name: 'Liked Songs' },
      emptyMsg: empty('heart', 'No liked songs', 'Tap the heart in the player to save songs here.'),
    }),
  };
}
export function genreView(id) {
  const g = library.genres.get(decodeURIComponent(id));
  if (!g) return notFound();
  const albums = [...g.albums].map((x) => library.album(x)).filter(Boolean);
  const tracks = [...g.tracks].sort((a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)));
  const key = regList(tracks, { type: 'genre', id: g.id, name: g.name });
  return {
    title: g.name,
    html: html`${pageHeader(g.name, { back: true })}${playButtons(key)}
    <div class="grid cols-${settings.get('gridCols')}">${albums.map((a) => albumCard(a))}</div><div class="bottom-pad"></div>`,
  };
}
const mixCache = new Map();
export function mixView(id) {
  const m = library.mixes().find((x) => x.id === id);
  if (!m) return notFound();
  if (!mixCache.has(id)) mixCache.set(id, library.mixTracks(m));
  const tracks = mixCache.get(id).filter((t) => library.track(t.id));
  return {
    title: m.name,
    html: trackListPage({
      title: m.name, sub: m.sub,
      artHtml: html`<div class="art hero-art mix-art" style="background:linear-gradient(135deg,${m.colors[0]},${m.colors[1]})"><div class="mix-label">${m.name}</div><div class="mix-icon">${icon(m.kind === 'bpm' ? 'bpm' : 'mix')}</div></div>`,
      tracks, context: { type: 'mix', id: m.id, name: m.name },
      actions: html`<button class="icon-btn" data-a="remix" data-id="${m.id}" aria-label="Refresh">${icon('refresh')}</button>`,
    }),
  };
}
export function refreshMix(id) { mixCache.delete(id); }

// ---------- search ----------
export function searchView(q = '') {
  const res = q ? library.search(q) : null;
  let body;
  if (!q) {
    const gs = [...library.genres.values()].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 12);
    body = html`
      ${library.recentSearches.length ? html`<section class="shelf"><div class="shelf-head"><h2>Recent</h2><button class="see-all" data-a="clear-recent">Clear</button></div>
        <div class="rows">${library.recentSearches.map((s) => html`<button class="row recent-q" data-a="search-q" data-q="${s}"><span class="ic-wrap">${icon('search')}</span><div class="meta"><div class="t1">${s}</div></div></button>`)}</div></section>` : ''}
      ${gs.length ? html`<section class="shelf"><div class="shelf-head"><h2>Browse</h2></div><div class="genre-grid">${gs.map((g, i) => genreTile(g, i))}</div></section>` : ''}`;
  } else if (!res || (!res.tracks.length && !res.albums.length && !res.artists.length)) {
    body = empty('search', 'No results', `Nothing in your library matches “${q}”.`);
  } else {
    const key = regList(res.tracks, { type: 'search', name: `Search: ${q}` });
    const top = res.top;
    let topHtml = '';
    if (top) {
      const it = top.item;
      if (top.kind === 'artist') topHtml = html`<a class="top-result" href="#/artist/${it.id}">${art(it.artId, 'top-art round')}<div class="tr-t">${it.name}</div><div class="tr-k">Artist</div></a>`;
      else if (top.kind === 'album') topHtml = html`<a class="top-result" href="#/album/${it.id}">${art(it.artId, 'top-art')}<div class="tr-t">${it.title}</div><div class="tr-k">Album · ${it.artist}</div></a>`;
      else topHtml = html`<button class="top-result" data-a="play-list" data-list="${key}" data-i="0">${art(it.artId, 'top-art')}<div class="tr-t">${it.title}</div><div class="tr-k">Song · ${it.artist}</div></button>`;
    }
    body = html`
      ${topHtml ? html`<section class="shelf"><div class="shelf-head"><h2>Top Result</h2></div>${topHtml}</section>` : ''}
      ${res.tracks.length ? html`<section class="shelf"><div class="shelf-head"><h2>Songs</h2></div><div class="rows">${res.tracks.slice(0, 20).map((t, i) => trackRow(t, i, key, { showAlbum: true }))}</div></section>` : ''}
      ${shelf('Artists', res.artists.map(artistCard))}
      ${shelf('Albums', res.albums.map((a) => albumCard(a)))}
      ${res.playlists.length ? html`<section class="shelf"><div class="shelf-head"><h2>Playlists</h2></div><div class="rows">${res.playlists.map((p) => html`<a class="row" href="#/playlist/${p.id}">${playlistArt(p, 'sm')}<div class="meta"><div class="t1">${p.name}</div></div></a>`)}</div></section>` : ''}`;
  }
  return { title: 'Search', html: html`<div data-search-results>${body}</div><div class="bottom-pad"></div>`, search: true };
}

export function notFound() {
  return { title: 'Not found', html: html`${pageHeader('', { back: true })}${empty('info', 'Not found', 'This item isn’t in your library anymore.')}` };
}

export { scanBanner };
