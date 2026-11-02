// Desktop notifications, sounds, screen-reader announcements and the unread
// count shown in the title, the tray and the dock.

import {
  S, channel, displayName, dmTitle, mentionCount, notifyLevel, update, user,
} from './state.js';
import { playSound } from './sounds.js';

const desktop = () => globalThis.pravdaDesktop ?? null;

function isMentioned(m) {
  const c = channel(m.channel_id);
  if (!c) return false;
  if (c.server_id === '0') return true;
  return m.mention_everyone || (m.mentions ?? []).includes(S.me.id);
}

function isViewing(m) {
  return document.visibilityState === 'visible' && document.hasFocus() && S.route.channelId === m.channel_id;
}

const preview = (m) => (m.body?.t ? m.body.t.replace(/<@&?\d+>/g, '@…').replace(/\|\|[\s\S]*?\|\|/g, '(spoiler)').slice(0, 140)
  : m.body?.a?.length ? 'Sent an attachment' : 'Sent an encrypted message');

function openChannelFrom(c) {
  desktop()?.focusWindow?.();
  focus();
  history.pushState(null, '', c.server_id === '0' ? `/channels/@me/${c.id}` : `/channels/${c.server_id}/${c.id}`);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function notifyMessage(m) {
  if (m.kind !== 'default' || isViewing(m)) return;
  const c = channel(m.channel_id);
  const relevant = isMentioned(m);
  // The channel's own level, its server's, or the global one, in that order.
  const level = notifyLevel(c);
  if (level === 'none' && !(relevant && c?.server_id === '0')) return;
  if (level === 'mentions' && !relevant) return;
  playSound(relevant ? 'mention' : 'message');
  if (relevant) desktop()?.flash?.();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  const place = c?.server_id === '0' ? dmTitle(c) : `#${c?.name ?? ''}`;
  const n = new Notification(`${displayName(m.author_id, c?.server_id)} — ${place}`, {
    body: preview(m),
    icon: '/img/icon-192.png',
    tag: m.channel_id,
  });
  n.onclick = () => {
    if (c) openChannelFrom(c);
    n.close();
  };
}

/** Reads a new message in the open channel out to screen readers, if asked to. */
export function announceMessage(m) {
  if (!S.settings.announceMessages || m.kind !== 'default' || m.author_id === S.me?.id) return;
  if (S.route.channelId !== m.channel_id) return;
  const c = channel(m.channel_id);
  S.announcement = { key: m.id, text: `${displayName(m.author_id, c?.server_id)}: ${preview(m)}` };
  update();
}

export function notifyRing(d) {
  desktop()?.flash?.();
  if (document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification('Incoming call', { body: `${user(d.from).display_name} is calling you.`, icon: '/img/icon-192.png', tag: 'call' });
  n.onclick = () => {
    desktop()?.focusWindow?.();
    focus();
    n.close();
  };
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

let lastBadge = -1;

/** Puts the unread mention total in the window title, and on the tray and dock. */
export function syncTitle() {
  let total = 0;
  for (const srv of S.servers.values()) {
    for (const c of srv.channels) total += mentionCount(c.id);
  }
  for (const c of S.dms) total += mentionCount(c.id);
  const base = S.instance?.name ?? 'Pravda';
  const here = S.route.channelId ? channel(S.route.channelId) : null;
  const title = here ? `${here.server_id === '0' ? dmTitle(here) : `#${here.name}`} — ${base}` : base;
  document.title = total > 0 ? `(${total}) ${title}` : title;
  if (total !== lastBadge) {
    lastBadge = total;
    desktop()?.setBadge?.(total);
  }
}
