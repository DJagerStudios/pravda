// The client's single source of truth. Components read S directly; anything
// that changes it calls update(), which schedules one redraw per frame. This
// keeps the data flow trivial: events mutate S, the UI is a function of S.

import { compareIds, storageGet, storageSet } from './lib.js';

/** Mirrors internal/perm. */
export const P = {
  VIEW: 1 << 0, SEND: 1 << 1, HISTORY: 1 << 2, ATTACH: 1 << 3, REACT: 1 << 4, MENTION_EVERYONE: 1 << 5,
  MANAGE_MESSAGES: 1 << 6, MANAGE_CHANNELS: 1 << 7, MANAGE_ROLES: 1 << 8, MANAGE_SERVER: 1 << 9,
  CREATE_INVITES: 1 << 10, KICK: 1 << 11, BAN: 1 << 12, VIEW_AUDIT: 1 << 13, CHANGE_NICK: 1 << 14,
  MANAGE_NICKS: 1 << 15, CONNECT: 1 << 16, SPEAK: 1 << 17, VIDEO: 1 << 18, STREAM: 1 << 19,
  MUTE_OTHERS: 1 << 20, DEAFEN_OTHERS: 1 << 21, MOVE_OTHERS: 1 << 22, ADMINISTRATOR: 1 << 23, PIN_ONLY: 1 << 24,
};

export const has = (perms, bit) => (perms & bit) === bit;

const DEFAULT_SETTINGS = {
  theme: 'system',
  fontScale: 100,
  compact: false,
  showMembers: true,
  inputDevice: 'default',
  outputDevice: 'default',
  cameraDevice: 'default',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputMode: 'voice',
  pttKey: 'KeyV',
  streamQuality: '1080p30',
  notifications: 'mentions',
  sounds: true,
  volumes: {},
  localMutes: {}, // user id -> true: muted for me only
  notifyLevels: {}, // server or channel id -> 'all' | 'mentions' | 'none'
  allowYouTube: false,
  allowExternalMedia: false,
  reduceMotion: false,
  // Accessibility
  contrast: 'system', // 'system' follows the operating system; or 'standard' | 'high'
  readableFont: false,
  roleColors: true,
  alwaysTimestamps: false,
  announceMessages: false,
};

export const S = {
  phase: 'loading', // loading | auth | connecting | ready
  instance: null,
  me: null,
  sessionId: null,
  connection: 'online', // online | reconnecting
  servers: new Map(),
  channels: new Map(),
  dms: [],
  users: new Map(),
  presences: new Map(),
  relationships: new Map(),
  reads: new Map(),
  messages: new Map(), // channel id -> { list, older, newer, loading }
  voice: new Map(), // channel id -> Map(user id -> state)
  speaking: new Set(),
  typing: new Map(), // channel id -> Map(user id -> expiry time)
  route: { kind: 'home' },
  lastChannel: new Map(), // server id -> channel id
  modal: null,
  popover: null,
  toast: null,
  replyTo: null,
  editing: null,
  panel: null, // right-hand panel: null | 'pins' | 'search'
  railOpen: false, // narrow screens: navigation drawer
  call: null,
  ring: null,
  watch: new Map(), // channel id -> decrypted watch-party state
  keyChanges: new Set(), // users whose security key changed
  clockOffset: 0, // server time minus local time, in ms
  stage: 'full', // 'enroll' while the authenticator still needs setting up
  announcement: null, // the latest message read out to screen readers
  update: null, // desktop app: the updater's state
  settings: { ...DEFAULT_SETTINGS, ...storageGet('pravda.settings', {}) },
};

/** The server's clock, estimated from gateway pings. */
export const serverNow = () => Date.now() + S.clockOffset;

const listeners = new Set();
let scheduled = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Redraws on the next frame. Frames stop while a window is hidden or the
 * compositor holds them back, so a timer stands in: state that arrives then
 * (a call, a message) is still applied, and the app never stalls on boot.
 */
export function update() {
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    if (!scheduled) return;
    scheduled = false;
    for (const fn of listeners) fn();
  };
  requestAnimationFrame(flush);
  setTimeout(flush, 50);
}

export function saveSettings(patch) {
  Object.assign(S.settings, patch);
  storageSet('pravda.settings', S.settings);
  update();
}

export function toast(message, kind = 'info') {
  const entry = { message, kind, key: Date.now() };
  S.toast = entry;
  update();
  setTimeout(() => {
    if (S.toast === entry) {
      S.toast = null;
      update();
    }
  }, 4500);
}

export function openModal(kind, props = {}) {
  S.modal = { kind, props };
  update();
}

export function closeModal() {
  S.modal = null;
  update();
}

export function server(id) { return S.servers.get(id); }
export function channel(id) { return S.channels.get(id); }

export function currentChannel() {
  return S.route.channelId ? S.channels.get(S.route.channelId) : null;
}

export function currentServer() {
  return S.route.serverId ? S.servers.get(S.route.serverId) : null;
}

export function user(id) {
  return S.users.get(id) ?? { id, username: 'unknown', display_name: 'Unknown user' };
}

export function memberOf(serverId, userId) {
  return S.servers.get(serverId)?.memberIndex.get(userId) ?? null;
}

/** The name to show for a user in a given server. */
export function displayName(userId, serverId) {
  if (serverId) {
    const nick = memberOf(serverId, userId)?.nick;
    if (nick) return nick;
  }
  return user(userId).display_name;
}

export function presence(userId) {
  return S.presences.get(userId) ?? 'offline';
}

/** The colour of a member's highest coloured role. */
export function memberColor(serverId, userId) {
  const srv = S.servers.get(serverId);
  const m = srv?.memberIndex.get(userId);
  if (!m) return 0;
  let best = null;
  for (const roleId of m.roles) {
    const role = srv.roleIndex.get(roleId);
    if (role?.color && (!best || role.position > best.position)) best = role;
  }
  return best?.color ?? 0;
}

export function memberTopRole(serverId, userId) {
  const srv = S.servers.get(serverId);
  const m = srv?.memberIndex.get(userId);
  if (!m) return null;
  let best = null;
  for (const roleId of m.roles) {
    const role = srv.roleIndex.get(roleId);
    if (role?.hoist && (!best || role.position > best.position)) best = role;
  }
  return best;
}

/** Stores a server sent by the gateway, replacing any previous copy. */
export function putServer(st) {
  const previous = S.servers.get(st.id);
  if (previous) {
    for (const c of previous.channels) {
      if (!st.channels.some((n) => n.id === c.id)) S.channels.delete(c.id);
    }
  }
  st.memberIndex = new Map(st.members.map((m) => [m.user_id, m]));
  st.roleIndex = new Map(st.roles.map((r) => [r.id, r]));
  for (const c of st.channels) S.channels.set(c.id, c);
  for (const v of st.voice ?? []) putVoice(v);
  S.servers.set(st.id, st);
}

export function reindexMembers(st) {
  st.memberIndex = new Map(st.members.map((m) => [m.user_id, m]));
}

export function putVoice(v) {
  const channelId = v.channel_id && v.channel_id !== '0' ? v.channel_id : null;
  for (const [id, room] of S.voice) {
    if (id !== channelId && room.delete(v.user_id) && room.size === 0) S.voice.delete(id);
  }
  if (!channelId) {
    S.speaking.delete(v.user_id);
    return;
  }
  let room = S.voice.get(channelId);
  if (!room) {
    room = new Map();
    S.voice.set(channelId, room);
  }
  room.set(v.user_id, v);
}

/** Channels grouped under their categories, in display order. */
export function channelTree(srv) {
  const byPosition = (a, b) => a.position - b.position || compareIds(a.id, b.id);
  const categories = srv.channels.filter((c) => c.kind === 'category').sort(byPosition);
  const known = new Set(categories.map((c) => c.id));
  const loose = srv.channels.filter((c) => c.kind !== 'category' && !known.has(c.parent_id)).sort(byPosition);
  const groups = categories.map((category) => ({
    category,
    channels: srv.channels.filter((c) => c.parent_id === category.id).sort(byPosition),
  }));
  return { loose, groups };
}

export function firstTextChannel(srv) {
  const { loose, groups } = channelTree(srv);
  const all = [...loose, ...groups.flatMap((g) => g.channels)];
  return all.find((c) => c.kind === 'text') ?? null;
}

export function isUnread(c) {
  if (!c.last_message_id || c.last_message_id === '0') return false;
  const read = S.reads.get(c.id);
  return !read || compareIds(c.last_message_id, read.last_read_id) > 0;
}

export function mentionCount(channelId) {
  return S.reads.get(channelId)?.mentions ?? 0;
}

export function serverMentions(srv) {
  return srv.channels.reduce((n, c) => n + mentionCount(c.id), 0);
}

export function serverUnread(srv) {
  if (S.settings.notifyLevels[srv.id] === 'none') return false;
  return srv.channels.some((c) => c.kind === 'text' && isUnread(c) && !isMuted(c));
}

// ---- notification levels ----
// Each server and channel can have its own level; a channel without one
// follows its server, and a server without one follows the global setting.

/** The level set on this channel or server itself, or undefined. */
export const ownLevel = (id) => S.settings.notifyLevels[id];

/** The notification level that applies to a channel. */
export function notifyLevel(c) {
  if (!c) return S.settings.notifications;
  return ownLevel(c.id) ?? (c.server_id && c.server_id !== '0' ? ownLevel(c.server_id) : undefined) ?? S.settings.notifications;
}

/** Muted channels show no unread marker and send no alerts, except mentions badges. */
export function isMuted(c) {
  const own = ownLevel(c.id);
  if (own) return own === 'none';
  return c.server_id !== '0' && ownLevel(c.server_id) === 'none';
}

export function setNotifyLevel(id, level) {
  const levels = { ...S.settings.notifyLevels };
  if (level) levels[id] = level;
  else delete levels[id];
  saveSettings({ notifyLevels: levels });
}

/** A member's role colour, if the reader wants role colours shown. */
export function roleColor(serverId, userId) {
  return S.settings.roleColors ? memberColor(serverId, userId) : 0;
}

/** A private channel's title as seen by me. */
export function dmTitle(c) {
  if (c.name) return c.name;
  const others = (c.recipients ?? []).filter((id) => id !== S.me?.id);
  return others.map((id) => user(id).display_name).join(', ') || 'Private notes';
}

export function dmPartner(c) {
  return (c.recipients ?? []).find((id) => id !== S.me?.id) ?? null;
}

export function typingUsers(channelId) {
  const room = S.typing.get(channelId);
  if (!room) return [];
  const now = Date.now();
  return [...room].filter(([id, expiry]) => expiry > now && id !== S.me?.id).map(([id]) => id);
}

export function relationship(userId) {
  return S.relationships.get(userId) ?? null;
}

export function isBlocked(userId) {
  return relationship(userId) === 'blocked';
}
