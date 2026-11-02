// Moving around with the keyboard: next and previous channel, next unread,
// and marking things read.

import {
  S, channelTree, currentChannel, currentServer, isMuted, isUnread, mentionCount, update,
} from './state.js';
import { navigate, openChannel } from './router.js';
import { markRead } from './actions.js';

/** A server's text channels in the order the sidebar shows them. */
function serverChannels(srv) {
  const { loose, groups } = channelTree(srv);
  return [...loose, ...groups.flatMap((g) => g.channels)].filter((c) => c.kind === 'text');
}

function go(c) {
  if (c.server_id === '0') navigate(`/channels/@me/${c.id}`);
  else openChannel(c);
}

/** Every conversation, in the order the rail and sidebars show them. */
function everyChannel() {
  return [...S.dms, ...[...S.servers.values()].flatMap(serverChannels)];
}

const wantsAttention = (c) => mentionCount(c.id) > 0 || (isUnread(c) && !isMuted(c));

/**
 * Moves to the previous (-1) or next (+1) channel. With `unread`, it skips
 * to the nearest channel with something new, across servers.
 */
export function stepChannel(direction, unread = false) {
  const here = currentChannel();
  let list;
  if (unread) list = everyChannel();
  else if (currentServer()) list = serverChannels(currentServer());
  else list = S.dms;
  if (list.length === 0) return;
  const start = here ? list.findIndex((c) => c.id === here.id) : -1;
  for (let step = 1; step <= list.length; step += 1) {
    const index = (start + direction * step + list.length * 2) % list.length;
    const c = list[index];
    if (c.id === here?.id) continue;
    if (unread && !wantsAttention(c)) continue;
    go(c);
    return;
  }
}

/** Marks every channel in a server as read. */
export function markServerRead(srv) {
  if (!srv) return;
  for (const c of srv.channels) {
    if (c.kind === 'text' && (isUnread(c) || mentionCount(c.id) > 0)) markRead(c);
  }
  update();
}

/** Escape in a conversation: mark it read; with Shift, the whole server. */
export function markHereRead(wholeServer) {
  if (wholeServer && currentServer()) {
    markServerRead(currentServer());
    return true;
  }
  const c = currentChannel();
  if (c && c.kind === 'text' && (isUnread(c) || mentionCount(c.id) > 0)) {
    markRead(c);
    return true;
  }
  return false;
}
