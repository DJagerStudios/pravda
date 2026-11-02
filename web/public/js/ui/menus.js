// Right-click menus for channels and servers: mark as read, notification
// level and mute, plus the actions the person is allowed.

import {
  S, P, has, isUnread, mentionCount, openModal, ownLevel, setNotifyLevel,
} from '../state.js';
import { markRead } from '../actions.js';
import { markServerRead } from '../navigation.js';

const LEVELS = [
  ['all', 'All messages'],
  ['mentions', 'Only mentions'],
  ['none', 'Nothing (muted)'],
];

function levelItems(id, defaultLabel) {
  const own = ownLevel(id);
  return [
    { heading: 'Notifications' },
    { label: defaultLabel, checked: !own, onClick: () => setNotifyLevel(id, null) },
    ...LEVELS.map(([level, label]) => ({ label, checked: own === level, onClick: () => setNotifyLevel(id, level) })),
  ];
}

export function channelMenu(c) {
  const srv = c.server_id !== '0' ? S.servers.get(c.server_id) : null;
  const unread = isUnread(c) || mentionCount(c.id) > 0;
  return [
    c.kind === 'text' && { label: 'Mark as read', icon: 'check', disabled: !unread, onClick: () => markRead(c) },
    c.kind === 'text' && '-',
    ...(c.kind === 'text' ? levelItems(c.id, srv ? 'Same as the server' : 'Same as everywhere') : []),
    srv && has(c.perms, P.MANAGE_CHANNELS) && '-',
    srv && has(c.perms, P.MANAGE_CHANNELS) && { label: 'Channel settings', icon: 'gear', onClick: () => openModal('channelSettings', { channelId: c.id }) },
  ];
}

export function serverMenu(srv) {
  const unread = srv.channels.some((c) => c.kind === 'text' && (isUnread(c) || mentionCount(c.id) > 0));
  return [
    { label: 'Mark as read', icon: 'check', disabled: !unread, onClick: () => markServerRead(srv) },
    '-',
    ...levelItems(srv.id, 'Same as everywhere'),
  ];
}
