// Key management: holds the unlocked identity, fetches and unseals channel and
// server keys, shares them with members who should have them, and rotates
// them when someone loses access. Every encrypt and decrypt in the app goes
// through here.

import * as C from './crypto.js';
import { api, ApiError, instanceId } from './api.js';
import { S, update, toast } from './state.js';
import { idbDelete, idbGet, idbPut } from './idb.js';
import { storageGet, storageSet } from './lib.js';

let identity = null; // { userId, signPriv, dhPriv }
const channelKeys = new Map(); // channel id -> Map(epoch -> { raw, key })
const channelInfo = new Map(); // channel id -> last /keys response
const serverKeys = new Map(); // server id -> { raw, key }
const inflight = new Map();

export class MissingKeyError extends Error {}

const identityKey = (userId) => `${instanceId()}:${userId}`;

export function hasIdentity() {
  return identity !== null;
}

export function myId() {
  return identity?.userId;
}

export async function adoptIdentity(userId, keys, { persist = true } = {}) {
  identity = { userId, signPriv: keys.signPriv, dhPriv: keys.dhPriv };
  if (persist) await idbPut(identityKey(userId), identity);
}

export async function restoreIdentity(userId) {
  const stored = await idbGet(identityKey(userId));
  if (stored?.signPriv && stored?.dhPriv) {
    identity = { userId, signPriv: stored.signPriv, dhPriv: stored.dhPriv };
    return true;
  }
  return false;
}

export async function forgetIdentity() {
  if (identity) await idbDelete(identityKey(identity.userId));
  identity = null;
  channelKeys.clear();
  channelInfo.clear();
  serverKeys.clear();
}

/** Re-opens the bundle with a password to change it, for password changes. */
export async function rewrapBundle(bundle, oldWrapKey, newWrapKey) {
  const extractable = await C.openBundle(bundle, oldWrapKey, { extractable: true });
  return C.sealBundle(extractable, newWrapKey);
}

// ---- other users' public keys and trust-on-first-use pins ----

const pinsKey = () => `pravda.pins.${instanceId()}`;

async function publicKeysOf(userId) {
  let u = S.users.get(userId);
  if (!u?.dh_key || !u?.sign_key) {
    u = await api.get(`/users/${userId}`);
    S.users.set(userId, { ...S.users.get(userId), ...u });
  }
  return u;
}

/**
 * Records a user's fingerprint the first time it is seen and reports a
 * change afterwards. A change means they reset their keys, or someone is
 * impersonating them; the interface tells the user either way.
 */
export async function checkPin(userId) {
  const u = await publicKeysOf(userId);
  const fp = await C.fingerprint(u.sign_key, u.dh_key);
  const pins = storageGet(pinsKey(), {});
  if (!pins[userId]) {
    pins[userId] = fp;
    storageSet(pinsKey(), pins);
    return { fp, changed: false };
  }
  if (pins[userId] !== fp) {
    S.keyChanges ??= new Set();
    if (!S.keyChanges.has(userId)) {
      S.keyChanges.add(userId);
      update();
    }
    return { fp, changed: true };
  }
  return { fp, changed: false };
}

export function acceptKeyChange(userId, fp) {
  const pins = storageGet(pinsKey(), {});
  pins[userId] = fp;
  storageSet(pinsKey(), pins);
  S.keyChanges?.delete(userId);
  update();
}

export function myFingerprint() {
  const me = S.users.get(identity.userId) ?? S.me;
  return C.fingerprint(me.sign_key, me.dh_key);
}

// ---- sealing keys for others ----

async function sealFor(recipientId, raw, scope, epoch) {
  const u = await publicKeysOf(recipientId);
  await checkPin(recipientId);
  return C.sealKeyFor({ dhPriv: identity.dhPriv, recipientDh: u.dh_key, raw, scope, epoch, from: identity.userId, to: recipientId });
}

async function openFrom(senderId, wrapped, scope, epoch) {
  const u = await publicKeysOf(senderId);
  return C.openSealedKey({ dhPriv: identity.dhPriv, senderDh: u.dh_key, wrapped, scope, epoch, from: senderId, to: identity.userId });
}

// ---- channel keys ----

function remember(channelId, epoch, raw, key) {
  let m = channelKeys.get(channelId);
  if (!m) {
    m = new Map();
    channelKeys.set(channelId, m);
  }
  m.set(epoch, { raw, key });
}

/** Fetches and unseals every generation of a channel's key this user holds. */
export async function refreshChannelKeys(channelId) {
  const running = inflight.get(`c:${channelId}`);
  if (running) return running;
  const job = (async () => {
    const ks = await api.get(`/channels/${channelId}/keys`);
    channelInfo.set(channelId, ks);
    for (const k of ks.keys) {
      if (channelKeys.get(channelId)?.has(k.epoch)) continue;
      try {
        const raw = await openFrom(k.sender_id, k.wrapped, `c:${channelId}`, k.epoch);
        remember(channelId, k.epoch, raw, await C.importContentKey(raw));
      } catch (err) {
        console.warn('a sealed key could not be opened', channelId, k.epoch, err);
      }
    }
    return ks;
  })();
  inflight.set(`c:${channelId}`, job);
  try {
    return await job;
  } finally {
    inflight.delete(`c:${channelId}`);
  }
}

/** The key for one generation, fetching it if needed. Null if unavailable. */
export async function keyForEpoch(channelId, epoch) {
  let entry = channelKeys.get(channelId)?.get(epoch);
  if (entry) return entry;
  await refreshChannelKeys(channelId);
  entry = channelKeys.get(channelId)?.get(epoch);
  if (!entry) requestKeys(channelId, true);
  return entry ?? null;
}

const requested = new Map();

/** Asks key holders to share, at most every 15 seconds per channel. */
export function requestKeys(channelId, history = false) {
  const last = requested.get(channelId) ?? 0;
  if (Date.now() - last < 15000) return;
  requested.set(channelId, Date.now());
  api.post(`/channels/${channelId}/keys/request`, { history }).catch(() => {});
}

/**
 * The key to encrypt new content with. Creates the first generation, or a
 * new one when someone lost access, before returning.
 */
export async function currentKey(channelId) {
  let ks = await refreshChannelKeys(channelId);
  if (ks.epoch === 0 || ks.rotate) {
    await rotate(channelId);
    ks = await refreshChannelKeys(channelId);
  }
  const entry = channelKeys.get(channelId)?.get(ks.epoch);
  if (!entry) {
    requestKeys(channelId);
    throw new MissingKeyError('You do not have this channel’s key yet. Someone who has it will share it when they are online.');
  }
  return { epoch: ks.epoch, ...entry };
}

/** Starts a new key generation shared with exactly everyone who can see the channel. */
export async function rotate(channelId, attempt = 0) {
  const ks = await refreshChannelKeys(channelId);
  if (!ks.viewers) throw new MissingKeyError('Only someone who holds the key can replace it.');
  const raw = C.randomBytes(32);
  const epoch = ks.epoch + 1;
  const keys = [];
  for (const userId of ks.viewers) {
    keys.push({ user_id: userId, wrapped: await sealFor(userId, raw, `c:${channelId}`, epoch) });
  }
  try {
    await api.post(`/channels/${channelId}/keys`, { epoch, rotate: true, keys });
    remember(channelId, epoch, raw, await C.importContentKey(raw));
  } catch (err) {
    // Somebody else rotated first, or membership changed meanwhile: retry
    // against the new state.
    if (err instanceof ApiError && err.status === 409 && attempt < 3) {
      channelInfo.delete(channelId);
      const fresh = await refreshChannelKeys(channelId);
      if (fresh.epoch >= epoch && !fresh.rotate) return;
      return rotate(channelId, attempt + 1);
    }
    throw err;
  }
}

/** Seals the given generations for the given users. */
export async function shareChannelKeys(channelId, epochs, userIds) {
  for (const epoch of epochs) {
    const entry = await keyForEpoch(channelId, epoch);
    if (!entry) continue;
    const keys = [];
    for (const userId of userIds) keys.push({ user_id: userId, wrapped: await sealFor(userId, entry.raw, `c:${channelId}`, epoch) });
    try {
      await api.post(`/channels/${channelId}/keys`, { epoch, keys });
    } catch (err) {
      // History may be hidden from new members, or they lost access since.
      if (!(err instanceof ApiError) || err.status >= 500) throw err;
    }
  }
}

const serving = new Set();

/** Answers a request to share keys, from the gateway or on connect. */
export async function serveKeyRequest(req) {
  if (!identity) return;
  const tag = `${req.scope}:${req.id}:${req.user_ids.join(',')}`;
  if (serving.has(tag)) return;
  serving.add(tag);
  try {
    if (req.scope === 'server') {
      await shareServerKey(req.id, req.user_ids);
      return;
    }
    await refreshChannelKeys(req.id);
    const held = [...(channelKeys.get(req.id)?.keys() ?? [])];
    const epochs = req.history ? held : held.filter((e) => req.epochs?.includes(e));
    await shareChannelKeys(req.id, epochs, req.user_ids);
  } catch (err) {
    console.warn('could not serve a key request', req, err);
  } finally {
    serving.delete(tag);
  }
}

export function forgetChannelKeys(channelId) {
  channelKeys.delete(channelId);
  channelInfo.delete(channelId);
}

// ---- server metadata keys ----

export function serverKeyCached(serverId) {
  return serverKeys.get(serverId) ?? null;
}

/** Unseals a server's metadata key from this member's copy. */
export async function serverKey(st) {
  const cached = serverKeys.get(st.id);
  if (cached) return cached;
  if (!st.key) return null;
  try {
    const raw = await openFrom(st.key.sender_id, st.key.wrapped, `s:${st.id}`, 0);
    const entry = { raw, key: await C.importContentKey(raw) };
    serverKeys.set(st.id, entry);
    return entry;
  } catch (err) {
    console.warn('server key could not be opened', st.id, err);
    return null;
  }
}

export async function rememberServerKey(serverId, raw) {
  const entry = { raw, key: await C.importContentKey(raw) };
  serverKeys.set(serverId, entry);
  return entry;
}

/** Stores this member's own sealed copy of a server key they already know. */
export async function storeServerKeySelf(serverId, raw) {
  await rememberServerKey(serverId, raw);
  const wrapped = await C.sealKeyFor({
    dhPriv: identity.dhPriv, recipientDh: (await publicKeysOf(identity.userId)).dh_key,
    raw, scope: `s:${serverId}`, epoch: 0, from: identity.userId, to: identity.userId,
  });
  await api.post(`/servers/${serverId}/keys`, { keys: [{ user_id: identity.userId, wrapped }] });
}

export async function shareServerKey(serverId, userIds) {
  const entry = serverKeys.get(serverId);
  if (!entry) return;
  const keys = [];
  for (const userId of userIds) keys.push({ user_id: userId, wrapped: await sealFor(userId, entry.raw, `s:${serverId}`, 0) });
  await api.post(`/servers/${serverId}/keys`, { keys });
}

export function requestServerKey(serverId) {
  const last = requested.get(`s:${serverId}`) ?? 0;
  if (Date.now() - last < 15000) return;
  requested.set(`s:${serverId}`, Date.now());
  api.post(`/servers/${serverId}/keys/request`).catch(() => {});
}

// ---- content ----

const msgAad = (channelId, authorId) => `pravda/msg/v1|${channelId}|${authorId}`;

/** Encrypts a message body for a channel under its current key. */
export async function encryptMessage(channelId, body) {
  const { epoch, key } = await currentKey(channelId);
  return C.encryptEnvelope({ key, epoch, body, aad: `${msgAad(channelId, identity.userId)}|${epoch}`, signPriv: identity.signPriv });
}

/**
 * Decrypts a message in place: sets `body` on success, or `sealed` with a
 * reason when it cannot be read (yet).
 */
export async function decryptMessage(m) {
  if (m.kind !== 'default' || !m.content) return m;
  const epoch = C.envelopeEpoch(m.content);
  try {
    const entry = await keyForEpoch(m.channel_id, epoch);
    if (!entry) {
      m.sealed = 'missing';
      return m;
    }
    const author = await publicKeysOf(m.author_id);
    m.body = await C.decryptEnvelope({
      envelope: m.content, key: entry.key, aad: `${msgAad(m.channel_id, m.author_id)}|${epoch}`, signPub: author.sign_key,
    });
    delete m.sealed;
  } catch (err) {
    m.sealed = err instanceof C.DecryptError && err.message === 'bad signature' ? 'forged' : 'unreadable';
  }
  if (m.reply?.content) {
    await decryptMessage(Object.assign(m.reply, { kind: 'default', channel_id: m.channel_id }));
  }
  await decryptReactions(m);
  return m;
}

const reactAad = (messageId, userId) => `pravda/react/v1|${messageId}|${userId}`;

export async function encryptReaction(m, emoji) {
  const { epoch, key } = await currentKey(m.channel_id);
  return C.encryptEnvelope({ key, epoch, body: { emoji }, aad: `${reactAad(m.id, identity.userId)}|${epoch}`, signPriv: identity.signPriv });
}

export async function decryptReactions(m) {
  for (const r of m.reactions ?? []) {
    if (r.emoji) continue;
    try {
      const epoch = C.envelopeEpoch(r.content);
      const entry = await keyForEpoch(m.channel_id, epoch);
      if (!entry) continue;
      const author = await publicKeysOf(r.user_id);
      const body = await C.decryptEnvelope({ envelope: r.content, key: entry.key, aad: `${reactAad(m.id, r.user_id)}|${epoch}`, signPub: author.sign_key });
      if (typeof body.emoji === 'string' && body.emoji.length <= 32) r.emoji = body.emoji;
    } catch {
      // An unreadable reaction is simply not shown.
    }
  }
  return m;
}

// Server, channel and role names are sealed with the server key.
export const META_AAD = {
  server: 'pravda/meta/v1|server',
  channel: 'pravda/meta/v1|channel',
  role: 'pravda/meta/v1|role',
};

export function encryptMetaWith(key, kind, body) {
  return C.encryptEnvelope({ key, body, aad: META_AAD[kind] });
}

export function encryptMeta(serverId, kind, body) {
  const entry = serverKeys.get(serverId);
  if (!entry) return Promise.reject(new MissingKeyError('This server’s key has not reached you yet.'));
  return encryptMetaWith(entry.key, kind, body);
}

export function decryptMetaWith(key, kind, envelope) {
  return C.decryptEnvelope({ envelope, key, aad: META_AAD[kind] });
}

/** Decrypts a server's names in place, keeping the ciphertext for later. */
export async function decryptServer(st) {
  const entry = await serverKey(st);
  st.sealed = !entry;
  const tryMeta = async (kind, envelope) => {
    if (!entry || !envelope) return null;
    try {
      return await decryptMetaWith(entry.key, kind, envelope);
    } catch {
      return null;
    }
  };
  const meta = await tryMeta('server', st.meta);
  st.name = meta?.name ?? 'Encrypted server';
  st.description = meta?.description ?? '';
  st.iconRef = meta?.icon ?? null;
  for (const c of st.channels) {
    const cm = await tryMeta('channel', c.meta);
    c.name = cm?.name ?? (c.kind === 'category' ? 'Encrypted category' : 'encrypted');
    c.topic = cm?.topic ?? '';
    c.sealed = !cm;
  }
  for (const r of st.roles) {
    const rm = await tryMeta('role', r.meta);
    r.name = rm?.name ?? (r.id === st.id ? 'everyone' : 'Encrypted role');
  }
  if (!entry) requestServerKey(st.id);
  return st;
}

/** Group conversations keep their name sealed with the group's own key. */
export async function decryptGroupName(c) {
  if (c.kind !== 'group' || !c.meta) return c;
  try {
    const epoch = C.envelopeEpoch(c.meta);
    const entry = await keyForEpoch(c.id, epoch);
    if (entry) c.name = (await C.decryptEnvelope({ envelope: c.meta, key: entry.key, aad: `pravda/meta/v1|group|${c.id}` })).name;
  } catch {
    // Fall back to listing the participants.
  }
  return c;
}

export async function encryptGroupName(channelId, name) {
  const { epoch, key } = await currentKey(channelId);
  return C.encryptEnvelope({ key, epoch, body: { name }, aad: `pravda/meta/v1|group|${channelId}` });
}

const watchAad = (channelId) => `pravda/watch/v1|${channelId}`;

export async function encryptWatch(channelId, state) {
  const { epoch, key } = await currentKey(channelId);
  return C.encryptEnvelope({ key, epoch, body: state, aad: `${watchAad(channelId)}|${epoch}`, signPriv: identity.signPriv });
}

export async function decryptWatch(channelId, blob, byUserId) {
  const epoch = C.envelopeEpoch(blob);
  const entry = await keyForEpoch(channelId, epoch);
  if (!entry) return null;
  const author = await publicKeysOf(byUserId);
  return C.decryptEnvelope({ envelope: blob, key: entry.key, aad: `${watchAad(channelId)}|${epoch}`, signPub: author.sign_key });
}

/** The current media key for a call, and its one-byte generation index. */
export async function mediaKey(channelId) {
  const { epoch, raw } = await currentKey(channelId);
  return { index: epoch % 256, raw: await C.deriveMediaKey(raw, channelId, epoch), epoch };
}

/** Media keys for every generation this user holds, for receiving. */
export async function allMediaKeys(channelId) {
  const out = [];
  for (const [epoch, entry] of channelKeys.get(channelId) ?? []) {
    out.push({ index: epoch % 256, raw: await C.deriveMediaKey(entry.raw, channelId, epoch), epoch });
  }
  return out;
}

export function keyInfo(channelId) {
  return channelInfo.get(channelId) ?? null;
}

export function reportKeyError(err) {
  if (err instanceof MissingKeyError) toast(err.message, 'error');
  else throw err;
}
