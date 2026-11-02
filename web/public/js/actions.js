// Operations that talk to the server and update local state. Everything that
// leaves this device is encrypted here first.

import {
  api, ApiError, apiOrigin, fetchMedia, upload,
} from './api.js';
import { S, update, toast, channel } from './state.js';
import { compareIds, debounce } from './lib.js';
import { navigate } from './router.js';
import * as C from './crypto.js';
import {
  currentKey, decryptMessage, encryptMessage, encryptMeta, encryptMetaWith, encryptReaction, forgetIdentity,
  MissingKeyError, rememberServerKey, rotate, serverKeyCached, storeServerKeySelf, decryptMetaWith,
} from './keys.js';

const PAGE = 50;

function roomFor(channelId) {
  let r = S.messages.get(channelId);
  if (!r) {
    r = { list: [], pending: [], older: true, newer: false, loading: false, loaded: false };
    S.messages.set(channelId, r);
  }
  return r;
}

export function report(err) {
  if (err instanceof ApiError || err instanceof MissingKeyError) toast(err.message, 'error');
  else {
    console.error(err);
    toast('Something went wrong.', 'error');
  }
}

async function decryptPage(page) {
  for (const m of page) await decryptMessage(m);
  return page;
}

export async function loadLatest(channelId) {
  const r = roomFor(channelId);
  if (r.loaded || r.loading) return;
  r.loading = true;
  update();
  try {
    const page = await decryptPage(await api.get(`/channels/${channelId}/messages?limit=${PAGE}`));
    r.list = page;
    r.older = page.length === PAGE;
    r.newer = false;
    r.loaded = true;
  } catch (err) {
    report(err);
  } finally {
    r.loading = false;
    update();
  }
}

export async function loadOlder(channelId) {
  const r = roomFor(channelId);
  if (r.loading || !r.older || r.list.length === 0) return false;
  r.loading = true;
  try {
    const page = await decryptPage(await api.get(`/channels/${channelId}/messages?limit=${PAGE}&before=${r.list[0].id}`));
    r.list = [...page, ...r.list];
    r.older = page.length === PAGE;
    return page.length > 0;
  } catch (err) {
    report(err);
    return false;
  } finally {
    r.loading = false;
    update();
  }
}

/** Replaces a channel's history with the page around one message. */
export async function jumpToMessage(channelId, messageId) {
  const r = roomFor(channelId);
  try {
    const page = await decryptPage(await api.get(`/channels/${channelId}/messages?limit=${PAGE}&around=${messageId}`));
    r.list = page;
    r.loaded = true;
    r.older = true;
    r.newer = page.length > 0 && compareIds(page[page.length - 1].id, channel(channelId)?.last_message_id ?? '0') < 0;
    S.highlight = messageId;
    update();
    setTimeout(() => {
      if (S.highlight === messageId) {
        S.highlight = null;
        update();
      }
    }, 2500);
  } catch (err) {
    report(err);
  }
}

export async function returnToPresent(channelId) {
  const r = roomFor(channelId);
  r.loaded = false;
  r.list = [];
  await loadLatest(channelId);
}

/**
 * Searches the archive on this device. The server cannot search: it cannot
 * read anything. Older pages are fetched and decrypted as needed.
 */
export async function searchArchive(channelId, query, { maxPages = 10 } = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  await loadLatest(channelId);
  const r = roomFor(channelId);
  for (let i = 0; i < maxPages && r.older; i += 1) {
    if (!(await loadOlder(channelId))) break;
  }
  return r.list
    .filter((m) => m.body?.t?.toLowerCase().includes(needle) || m.body?.a?.some((a) => a.name?.toLowerCase().includes(needle)))
    .reverse();
}

let nonceCounter = 0;

/** Keys are replaced or created on demand when the server says so. */
async function withFreshKey(channelId, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && ['rotate_keys', 'stale_epoch', 'no_keys'].includes(err.code)) {
      if (err.code !== 'stale_epoch') await rotate(channelId);
      return fn();
    }
    throw err;
  }
}

export async function sendMessage(channelId, text, { replyTo = null, attachments = [], mentions = {} } = {}) {
  const r = roomFor(channelId);
  nonceCounter += 1;
  const nonce = `${Date.now()}-${nonceCounter}`;
  const pending = { nonce, content: text, attachments, failed: false };
  r.pending.push(pending);
  // Receiving a message clears its author's typing indicator, so the next
  // burst of typing must be announced afresh rather than throttled.
  lastTyping.delete(channelId);
  update();
  const body = { t: text };
  if (attachments.length) body.a = attachments.map(({ id, name, type, size, key, iv, w, h }) => ({ id, name, type, size, key, iv, w, h }));
  try {
    const message = await withFreshKey(channelId, async () => api.post(`/channels/${channelId}/messages`, {
      content: await encryptMessage(channelId, body),
      reply_to: replyTo ?? undefined,
      attachments: attachments.map((a) => a.id),
      mentions: mentions.users ?? [],
      mention_roles: mentions.roles ?? [],
      mention_everyone: mentions.everyone ?? false,
      nonce,
    }));
    r.pending = r.pending.filter((x) => x !== pending);
    await decryptMessage(message);
    if (!r.newer && !r.list.some((x) => x.id === message.id)) r.list.push(message);
  } catch (err) {
    pending.failed = true;
    pending.retry = () => {
      r.pending = r.pending.filter((x) => x !== pending);
      sendMessage(channelId, text, { replyTo, attachments, mentions });
    };
    report(err);
  }
  update();
}

export async function editMessage(m, text, mentions = {}) {
  const body = { ...m.body, t: text };
  await withFreshKey(m.channel_id, async () => api.patch(`/channels/${m.channel_id}/messages/${m.id}`, {
    content: await encryptMessage(m.channel_id, body),
    mentions: mentions.users ?? [],
    mention_roles: mentions.roles ?? [],
    mention_everyone: mentions.everyone ?? false,
  }));
}

const lastTyping = new Map();

export function sendTyping(channelId) {
  const now = Date.now();
  if (now - (lastTyping.get(channelId) ?? 0) < 6000) return;
  lastTyping.set(channelId, now);
  api.post(`/channels/${channelId}/typing`).catch(() => {});
}

const postRead = debounce((channelId, messageId) => {
  api.post(`/channels/${channelId}/read`, { message_id: messageId }).catch(() => {});
}, 400);

export function markRead(c) {
  if (!c?.last_message_id || c.last_message_id === '0') return;
  const read = S.reads.get(c.id);
  if (read && read.mentions === 0 && compareIds(read.last_read_id, c.last_message_id) >= 0) return;
  S.reads.set(c.id, { channel_id: c.id, last_read_id: c.last_message_id, mentions: 0 });
  postRead(c.id, c.last_message_id);
  update();
}

/** Groups decrypted reactions by emoji for display. */
export function reactionGroups(m) {
  const groups = new Map();
  for (const r of m.reactions ?? []) {
    if (!r.emoji) continue;
    let g = groups.get(r.emoji);
    if (!g) {
      g = { emoji: r.emoji, users: [], mine: null };
      groups.set(r.emoji, g);
    }
    if (!g.users.includes(r.user_id)) g.users.push(r.user_id);
    if (r.user_id === S.me.id) g.mine = r.id;
  }
  return [...groups.values()];
}

export async function toggleReaction(m, emoji) {
  const mine = reactionGroups(m).find((g) => g.emoji === emoji)?.mine;
  const base = `/channels/${m.channel_id}/messages/${m.id}/reactions`;
  try {
    if (mine) await api.del(`${base}/${mine}`);
    else await withFreshKey(m.channel_id, async () => api.post(base, { content: await encryptReaction(m, emoji) }));
  } catch (err) {
    report(err);
  }
}

/** Encrypts and uploads a file, returning what the message needs to open it. */
export async function uploadEncrypted(file, onProgress) {
  const plain = await file.arrayBuffer();
  const sealed = await C.encryptFile(plain);
  let w;
  let h;
  if (file.type.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file);
      w = bitmap.width;
      h = bitmap.height;
      bitmap.close();
    } catch {
      // Not decodable here: shown as a plain file.
    }
  }
  const up = await upload(new Blob([sealed.data]), { onProgress });
  return { id: up.id, name: file.name || 'file', type: file.type || 'application/octet-stream', size: file.size, key: sealed.key, iv: sealed.iv, w, h };
}

const fileCache = new Map();

/** Fetches and decrypts an attachment, returning an object URL for it. */
export function attachmentUrl(a) {
  let job = fileCache.get(a.id);
  if (!job) {
    job = (async () => {
      const data = await fetchMedia(`/media/${a.id}/encrypted`);
      const plain = await C.decryptFile(data, a.key, a.iv);
      return URL.createObjectURL(new Blob([plain], { type: a.type }));
    })();
    fileCache.set(a.id, job);
    job.catch(() => fileCache.delete(a.id));
  }
  return job;
}

export async function openDM(userId) {
  try {
    const c = await api.post('/dms', { recipients: [userId] });
    S.channels.set(c.id, c);
    if (!S.dms.some((x) => x.id === c.id)) S.dms = [c, ...S.dms];
    if (c.key_epoch === 0) await rotate(c.id);
    navigate(`/channels/@me/${c.id}`);
  } catch (err) {
    report(err);
  }
}

const DEFAULT_PERMS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 10) | (1 << 14) | (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19);
const MODERATOR_PERMS = (1 << 6) | (1 << 11) | (1 << 15) | (1 << 20) | (1 << 21) | (1 << 22) | (1 << 5) | (1 << 13);
const ADMIN_PERMS = 1 << 23;

/**
 * Creates a server: a fresh key encrypts every name before anything is sent,
 * then each channel gets its own first key generation.
 */
export async function foundServer(name) {
  const raw = C.randomBytes(32);
  const key = await C.importContentKey(raw);
  const meta = (kind, body) => encryptMetaWith(key, kind, body);
  const st = await api.post('/servers', {
    meta: await meta('server', { name, description: '' }),
    roles: [
      { meta: await meta('role', { name: 'everyone' }), permissions: DEFAULT_PERMS },
      { meta: await meta('role', { name: 'Moderator' }), permissions: MODERATOR_PERMS, color: 0x2F6F8F, hoist: true, mentionable: true },
      { meta: await meta('role', { name: 'Admin' }), permissions: ADMIN_PERMS, color: 0xC8102E, hoist: true, mentionable: true },
    ],
    channels: [
      { kind: 'category', meta: await meta('channel', { name: 'Text channels' }), parent: -1 },
      { kind: 'text', meta: await meta('channel', { name: 'general', topic: 'General chat.' }), parent: 0, system: true },
      { kind: 'category', meta: await meta('channel', { name: 'Voice channels' }), parent: -1 },
      { kind: 'voice', meta: await meta('channel', { name: 'Lounge' }), parent: 2 },
    ],
  });
  await storeServerKeySelf(st.id, raw);
  for (const c of st.channels) {
    if (c.kind !== 'category') await rotate(c.id);
  }
  return st;
}

export function normalizeChannelName(name, kind) {
  if (kind !== 'text') return name.trim();
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export async function createChannel(serverId, { name, kind, parentId = '0', ttl = 0 }) {
  const clean = normalizeChannelName(name, kind);
  if (!clean) throw new ApiError(400, 'bad_name', 'Give the channel a name.');
  const c = await api.post(`/servers/${serverId}/channels`, {
    kind, parent_id: parentId, ttl_seconds: ttl, meta: await encryptMeta(serverId, 'channel', { name: clean, topic: '' }),
  });
  if (kind !== 'category') await rotate(c.id);
  return c;
}

export async function updateChannelMeta(c, { name, topic }) {
  const clean = normalizeChannelName(name, c.kind);
  await api.patch(`/channels/${c.id}`, { meta: await encryptMeta(c.server_id, 'channel', { name: clean, topic }) });
}

export async function updateServerMeta(st, patch) {
  const body = { name: st.name, description: st.description, icon: st.iconRef ?? undefined, ...patch };
  await api.patch(`/servers/${st.id}`, { meta: await encryptMeta(st.id, 'server', body) });
}

/** Encrypts an image as this server's icon. Only members can fetch it. */
export async function setServerIcon(st, file) {
  const sealed = await C.encryptFile(await file.arrayBuffer());
  const up = await upload(new Blob([sealed.data]), { kind: 'server', server: st.id });
  const icon = { id: up.id, key: sealed.key, iv: sealed.iv, type: file.type };
  await api.patch(`/servers/${st.id}`, { icon_attachment: up.id });
  await updateServerMeta(st, { icon });
}

export async function createRole(st, name, permissions = 0) {
  return api.post(`/servers/${st.id}/roles`, { meta: await encryptMeta(st.id, 'role', { name }), permissions });
}

export async function renameRole(st, roleId, name) {
  await api.patch(`/servers/${st.id}/roles/${roleId}`, { meta: await encryptMeta(st.id, 'role', { name }) });
}

/**
 * An invite link. The part after # carries the server's key and is never
 * sent to any server: browsers keep URL fragments to themselves.
 */
export async function createInviteLink(serverId, channelId, { maxAge = 604800, maxUses = 0 } = {}) {
  const invite = await api.post(`/channels/${channelId}/invites`, { max_age: maxAge, max_uses: maxUses });
  const entry = serverKeyCached(serverId);
  const fragment = entry ? `#${C.toB64url(entry.raw)}` : '';
  return { ...invite, url: `${apiOrigin()}/invite/${invite.code}${fragment}` };
}

/** Reads an invite preview, decrypting the server's name with the link's key. */
export async function previewInvite(code, fragmentKey) {
  const preview = await api.get(`/invites/${encodeURIComponent(code)}`);
  preview.name = null;
  if (fragmentKey) {
    try {
      const key = await C.importContentKey(C.fromB64url(fragmentKey));
      preview.name = (await decryptMetaWith(key, 'server', preview.server.meta)).name;
    } catch {
      // A wrong or truncated key: the name stays hidden.
    }
  }
  return preview;
}

export async function acceptInvite(code, fragmentKey, password) {
  const joined = await api.post(`/invites/${encodeURIComponent(code)}`, password ? { password } : {});
  if (fragmentKey) {
    try {
      const raw = C.fromB64url(fragmentKey);
      // Only keep a key that really opens this server's name.
      const preview = await api.get(`/invites/${encodeURIComponent(code)}`).catch(() => null);
      if (preview) await decryptMetaWith(await C.importContentKey(raw), 'server', preview.server.meta);
      await storeServerKeySelf(joined.server_id, raw);
      await rememberServerKey(joined.server_id, raw);
    } catch (err) {
      console.warn('the invite key did not open this server', err);
    }
  }
  return joined;
}

export async function logout() {
  try {
    await api.post('/auth/logout');
  } finally {
    await forgetIdentity();
    location.reload();
  }
}

export { currentKey };
