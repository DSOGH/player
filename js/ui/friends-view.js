// Friends list, invites and chats.
import { html, icon, fmtTime } from '../util.js';
import { library } from '../library.js';
import { engine } from '../engine.js';
import { settings } from '../settings.js';
import { plex } from '../plex.js';
import { friends } from '../friends.js';
import { art, pageHeader } from './components.js';

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const avatar = (f, cls = '') => html`<span class="fr-av ${cls}" style="background:${f.color || '#5e5ce6'}">${(f.name || '?')[0].toUpperCase()}</span>`;
export const drafts = new Map();
function notifyText() {
  if (!('Notification' in window)) return 'Add Player to your Home Screen to get notifications';
  if (Notification.permission === 'granted' && settings.get('friendNotify')) return 'On — while Player is open or playing in the background';
  if (Notification.permission === 'denied') return 'Blocked — allow in iPhone Settings → Notifications → Player';
  return 'Tap to get a notification when a friend messages you';
}

export async function friendsView() {
  if (!friends.ready) {
    const name = plex.user?.name || '';
    return {
      title: 'Friends',
      html: html`${pageHeader('Friends')}
      <section class="fr-hero">
        <div class="fr-hero-ic">${icon('friends-fill')}</div>
        <h2>Listen together</h2>
        <p>Chat with friends who use Player, send songs — even from a specific moment — and see what they’re listening to.</p>
        <input class="text-input fr-name" id="fr-name" placeholder="Your name" value="${name}" maxlength="40" autocomplete="nickname">
        <button class="btn pill primary big" data-a="fr-setup">Get started</button>
        <small>Messages are end-to-end encrypted and only stored on your phones. They pass through a tiny relay that forgets them after a few hours — nothing is saved on your Plex or NAS.</small>
      </section><div class="bottom-pad"></div>`,
    };
  }
  const rows = [];
  const withLast = await Promise.all(friends.list.map(async (f) => { const h = await friends.history(f.id); return { f, last: h[h.length - 1] }; }));
  withLast.sort((a, b) => (b.last?.at || b.f.added) - (a.last?.at || a.f.added));
  for (const { f, last } of withLast) {
    const np = f.np && Date.now() - (f.npAt || 0) < 30 * 60000 ? f.np : null;
    const preview = last ? (last.type === 'song' ? `♪ ${last.song.title} — ${last.song.artist}` : last.text) : 'Say hi 👋';
    rows.push(html`<a class="fr-row${f.unread ? ' unread' : ''}" href="#/chat/${f.id}">
      ${avatar(f)}
      <div class="fr-meta"><b>${f.name}</b>
        <small>${np ? html`<span class="fr-np"><i class="eqbars"><i></i><i></i><i></i></i>${np.title} · ${np.artist}</span>` : (preview || '')}</small></div>
      <div class="fr-side">${last ? html`<small>${ago(last.at)}</small>` : ''}${f.unread ? html`<span class="fr-badge">${f.unread}</span>` : ''}</div></a>`);
  }
  return {
    title: 'Friends',
    html: html`${pageHeader('Friends', { actions: html`<button class="icon-btn" data-a="fr-add" aria-label="Add friend">${icon('plus')}</button>` })}
    <section class="fr-invite">
      <div><b>Invite a friend</b><small>Send them your link. When they open it in Player, you’re connected.</small></div>
      <div class="fr-invite-btns">
        <button class="btn pill primary" data-a="fr-share">${icon('share')}Share link</button>
        <button class="btn pill ghost" data-a="fr-enter">Enter a code</button>
      </div>
    </section>
    ${rows.length ? html`<div class="fr-list">${rows}</div>` : html`<div class="empty"><div class="empty-ic">${icon('friends')}</div><h3>No friends yet</h3><p>Share your link — once a friend opens it, they show up here.</p></div>`}
    <section class="set-group"><div class="set-card">
      <button class="set-row link" data-a="fr-notify"><div class="set-text"><span>Message notifications</span><small>${notifyText()}</small></div>${icon('right', 'chev')}</button>
      <label class="set-row"><div class="set-text"><span>Share what I’m listening to</span><small>Friends see your current song next to your name</small></div><input type="checkbox" class="switch" data-set="friendsShareNp" ${settings.get('friendsShareNp') ? 'checked' : ''}></label>
      <button class="set-row link" data-a="fr-rename"><div class="set-text"><span>Your name</span><small>${friends.me.name}</small></div>${icon('right', 'chev')}</button>
    </div></section>
    <div class="bottom-pad"></div>`,
  };
}

function songCard(m, mine) {
  const s = m.song;
  const local = friends.match(s);
  return html`<div class="ch-song${local ? '' : ' missing'}">
    ${local ? art(local.artId, 'sm') : html`<div class="art sm art-empty">${icon('note')}</div>`}
    <div class="ch-song-meta"><b>${s.title}</b><small>${s.artist}${s.at ? html` · from <em>${fmtTime(s.at)}</em>` : ''}</small>
      ${local ? '' : html`<small class="ch-miss">Not in ${mine ? 'their' : 'your'} library</small>`}</div>
    ${local ? html`<button class="ch-play" data-a="ch-play" data-tid="${local.id}" data-at="${s.at || 0}" aria-label="Play">${icon('play')}</button>`
      : html`<button class="ch-play ghost" data-a="ch-search" data-q="${s.title} ${s.artist}" aria-label="Search">${icon('search')}</button>`}
  </div>`;
}

export async function chatView(id) {
  const f = friends.friend(id);
  if (!f) return { title: 'Chat', html: html`${pageHeader('Chat', { back: true })}<div class="empty"><h3>Friend not found</h3></div>` };
  friends.viewing = id;
  friends.markRead(id);
  const h = await friends.history(id);
  const out = [];
  let lastDay = '';
  h.forEach((m, i) => {
    const day = new Date(m.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const d = new Date(m.at);
      out.push(html`<div class="ch-day">${day === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>`);
    }
    const mine = m.from === friends.me.id;
    const next = h[i + 1];
    const tail = !next || next.from !== m.from || next.at - m.at > 5 * 60000;
    out.push(html`<div class="ch-msg ${mine ? 'me' : 'them'}${tail ? ' tail' : ''}${m.state === 'failed' ? ' failed' : ''}" data-mid="${m.mid}">
      ${m.type === 'song' ? html`${songCard(m, mine)}${m.note ? html`<div class="ch-bubble">${m.note}</div>` : ''}` : html`<div class="ch-bubble">${m.text}</div>`}
      ${tail ? html`<small class="ch-time">${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${mine ? (m.state === 'sending' ? ' · Sending…' : m.state === 'failed' ? html` · <button class="ch-retry" data-a="ch-retry" data-fid="${id}" data-mid="${m.mid}">Not sent — retry</button>` : '') : ''}</small>` : ''}
    </div>`);
  });
  const np = f.np && Date.now() - (f.npAt || 0) < 30 * 60000 ? f.np : null;
  return {
    title: f.name,
    html: html`${pageHeader(f.name, { back: true, actions: html`<button class="icon-btn" data-a="fr-menu" data-fid="${id}" aria-label="More">${icon('more')}</button>` })}
    ${np ? html`<div class="ch-np"><i class="eqbars"><i></i><i></i><i></i></i>Listening to <b>${np.title}</b> · ${np.artist}</div>` : ''}
    <div class="ch-list" data-chat="${id}">${out.length ? out : html`<div class="ch-empty">${avatar(f, 'big')}<p>This is the start of your chat with <b>${f.name}</b>.<br>Send a song from any moment with ♪.</p></div>`}</div>
    <form class="ch-compose" data-chat-form="${id}" onsubmit="return false">
      <button type="button" class="ch-attach" data-a="ch-attach" data-fid="${id}" aria-label="Send a song">${icon('note')}</button>
      <input class="ch-input" id="ch-input" placeholder="Message" autocomplete="off" enterkeyhint="send" value="${drafts.get(id) || ''}">
      <button type="submit" class="ch-send" data-a="ch-send" data-fid="${id}" aria-label="Send">${icon('send')}</button>
    </form>`,
    after(v) {
      const list = v.querySelector('.ch-list');
      const inp = v.querySelector('#ch-input');
      requestAnimationFrame(() => { const m = document.querySelector('#main'); m.scrollTop = m.scrollHeight; });
      inp.addEventListener('input', () => drafts.set(id, inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); v.querySelector('.ch-send').click(); } });
      void list;
    },
  };
}

export function acceptView(code) {
  const c = friends.parseCode(code);
  const standalone = document.documentElement.classList.contains('standalone');
  return {
    title: 'Add Friend',
    html: html`${pageHeader('Add Friend', { back: true })}
    <section class="fr-hero">
      ${c ? html`<span class="fr-av big" style="background:#0a84ff">${c.name[0].toUpperCase()}</span><h2>${c.name}</h2><p>wants to be friends on Player.</p>` : html`<h2>Invalid link</h2>`}
      ${c ? html`<button class="btn pill primary big" data-a="fr-accept" data-code="${code}">Add ${c.name}</button>` : ''}
      ${c && !standalone ? html`<small>Using Player from your home screen? Links open in Safari, which keeps a separate copy. Copy this code, open Player from your home screen, go to Friends → Enter a code:</small>
        <button class="btn pill ghost" data-a="fr-copy" data-code="${code}">${icon('copy')}Copy code</button>` : ''}
    </section><div class="bottom-pad"></div>`,
  };
}
