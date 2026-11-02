// The realtime connection. A dropped socket is resumed where it left off, so
// a brief network blip loses nothing and interrupts no call. Events are
// handled strictly in order, even though decrypting some of them is
// asynchronous.

import {
  S, update, putServer, putVoice, reindexMembers, toast,
} from './state.js';
import { compareIds } from './lib.js';
import { apiOrigin, bearer } from './api.js';
import {
  decryptGroupName, decryptMessage, decryptServer, decryptWatch, forgetChannelKeys, refreshChannelKeys, rotate,
  serveKeyRequest,
} from './keys.js';
import { handleVoiceEvent, refreshCallKeys, resumeCallAfterReconnect } from './voice.js';
import { playSound } from './sounds.js';
import { announceMessage, notifyMessage, notifyRing } from './notify.js';
import { navigate, refreshRoute } from './router.js';

const MAX_BACKOFF_MS = 15000;

let ws = null;
let heartbeat = 0;
let awaitingPong = false;
let pingSentAt = 0;
let seq = 0;
let session = null;
let attempts = 0;
let reconnectTimer = 0;
let stopped = false;
let onFatal = null;
let queue = Promise.resolve();

export function send(op, d) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
}

export function connect(fatalHandler) {
  onFatal = fatalHandler;
  stopped = false;
  open();
}

export function disconnect() {
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  if (ws) {
    send('bye');
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  session = null;
  seq = 0;
}

function open() {
  const url = new URL('/gateway', apiOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  ws = socket;
  socket.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    queue = queue.then(() => onFrame(frame)).catch((err) => console.error('gateway event failed', err));
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    onClose(e);
  };
}

function syncClock(serverTime, rtt = 0) {
  if (typeof serverTime === 'number') S.clockOffset = serverTime + rtt / 2 - Date.now();
}

async function onFrame(frame) {
  switch (frame.op) {
    case 'hello': {
      syncClock(frame.d.server_time);
      startHeartbeat(frame.d.heartbeat_ms);
      const token = bearer() ?? undefined;
      if (session) send('resume', { session_id: session, seq, token });
      else send('identify', { token });
      break;
    }
    case 'ready':
      await onReady(frame.d);
      break;
    case 'resumed':
      attempts = 0;
      S.connection = 'online';
      update();
      break;
    case 'invalid_session':
      session = null;
      seq = 0;
      break;
    case 'pong':
      awaitingPong = false;
      syncClock(frame.d?.server_time, Date.now() - pingSentAt);
      break;
    case 'event':
      seq = frame.s;
      await onEvent(frame.t, frame.d);
      break;
    default:
      break;
  }
}

function startHeartbeat(interval) {
  clearInterval(heartbeat);
  awaitingPong = false;
  heartbeat = setInterval(() => {
    if (awaitingPong) {
      // The server stopped answering: the socket is dead even if the browser
      // has not noticed yet.
      ws?.close();
      return;
    }
    awaitingPong = true;
    pingSentAt = Date.now();
    send('ping');
  }, interval);
}

function onClose(e) {
  clearInterval(heartbeat);
  ws = null;
  if (stopped) return;
  if (e.code === 4001) {
    session = null;
    onFatal?.();
    return;
  }
  if (e.code === 4002) {
    session = null;
    seq = 0;
  }
  S.connection = 'reconnecting';
  update();
  attempts += 1;
  // Jitter stops every client reconnecting in the same instant after an outage.
  const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempts, 5)) * (0.7 + Math.random() * 0.6);
  reconnectTimer = setTimeout(open, delay);
}

async function ingestServer(st) {
  await decryptServer(st);
  putServer(st);
}

async function onReady(d) {
  const fresh = S.sessionId !== null;
  session = d.session_id;
  seq = 0;
  attempts = 0;
  syncClock(d.server_time);
  S.sessionId = d.session_id;
  S.instance = d.instance;
  S.me = d.user;
  S.users = new Map(d.users.map((u) => [u.id, u]));
  S.users.set(d.user.id, d.user);
  S.presences = new Map(Object.entries(d.presences));
  S.relationships = new Map(d.relationships.map((r) => [r.user_id, r.kind]));
  S.reads = new Map(d.read_states.map((r) => [r.channel_id, r]));
  S.servers = new Map();
  S.channels = new Map();
  S.voice = new Map();
  S.speaking = new Set();
  // Anything cached may be stale after a full reconnect.
  S.messages = new Map();
  for (const st of d.servers) await ingestServer(st);
  for (const c of d.dms) await decryptGroupName(c);
  S.dms = d.dms;
  for (const c of d.dms) S.channels.set(c.id, c);
  for (const v of d.dm_voice) putVoice(v);
  S.connection = 'online';
  S.phase = 'ready';
  refreshRoute();
  update();
  if (fresh) resumeCallAfterReconnect();
  // Serve members who were waiting for keys while this user was away.
  for (const req of d.pending_keys) serveKeyRequest(req);
}

function mergeUsers(users, presences) {
  for (const u of users ?? []) S.users.set(u.id, u);
  for (const [id, status] of Object.entries(presences ?? {})) S.presences.set(id, status);
}

function room(channelId) {
  return S.messages.get(channelId);
}

function touchMessage(channelId, id, fn) {
  const list = room(channelId)?.list;
  if (!list) return;
  const index = list.findIndex((m) => m.id === id);
  if (index >= 0) fn(list, index);
}

/** Re-decrypts everything that was waiting for keys that just arrived. */
async function retryChannel(channelId) {
  const r = room(channelId);
  if (r) {
    for (const m of r.list) {
      if (m.sealed || m.reactions?.some((x) => !x.emoji)) await decryptMessage(m);
    }
  }
  const c = S.channels.get(channelId);
  if (c?.kind === 'group') await decryptGroupName(c);
  if (S.call?.channelId === channelId) await refreshCallKeys();
  const watch = S.watchRaw?.get(channelId);
  if (watch) await applyWatch(watch);
}

async function applyWatch(w) {
  S.watchRaw ??= new Map();
  if (!w.blob) {
    S.watchRaw.delete(w.channel_id);
    S.watch.delete(w.channel_id);
    return;
  }
  S.watchRaw.set(w.channel_id, w);
  try {
    const state = await decryptWatch(w.channel_id, w.blob, w.by);
    if (state) S.watch.set(w.channel_id, { ...state, by: w.by });
  } catch (err) {
    console.warn('watch state could not be read', err);
  }
}

export { applyWatch };

const handlers = {
  'message.create': async (m) => {
    if (m.author) S.users.set(m.author.id, m.author);
    await decryptMessage(m);
    const c = S.channels.get(m.channel_id);
    if (c) {
      if (compareIds(m.id, c.last_message_id || '0') > 0) c.last_message_id = m.id;
      c.message_count += 1;
    }
    const r = room(m.channel_id);
    if (r && !r.newer && !r.list.some((x) => x.id === m.id)) r.list.push(m);
    if (r && m.nonce) r.pending = r.pending.filter((x) => x.nonce !== m.nonce);
    S.typing.get(m.channel_id)?.delete(m.author_id);
    if (m.author_id === S.me.id) {
      S.reads.set(m.channel_id, { channel_id: m.channel_id, last_read_id: m.id, mentions: 0 });
    } else {
      notifyMessage(m);
      announceMessage(m);
    }
    if (c && c.server_id === '0') S.dms = [c, ...S.dms.filter((x) => x.id !== c.id)];
  },
  'message.update': async (m) => {
    if (m.author) S.users.set(m.author.id, m.author);
    await decryptMessage(m);
    touchMessage(m.channel_id, m.id, (list, i) => { list[i] = m; });
  },
  'message.delete': (d) => {
    touchMessage(d.channel_id, d.id, (list, i) => { list.splice(i, 1); });
    const c = S.channels.get(d.channel_id);
    if (c) c.message_count = Math.max(0, c.message_count - 1);
    if (S.replyTo?.id === d.id) S.replyTo = null;
    if (S.editing === d.id) S.editing = null;
  },
  'reaction.add': async (d) => {
    const r = room(d.channel_id)?.list.find((m) => m.id === d.message_id);
    if (!r) return;
    r.reactions ??= [];
    if (!r.reactions.some((x) => x.id === d.reaction.id)) r.reactions.push(d.reaction);
    await decryptMessage(r);
  },
  'reaction.remove': (d) => {
    touchMessage(d.channel_id, d.message_id, (list, i) => {
      list[i].reactions = (list[i].reactions ?? []).filter((x) => x.id !== d.id);
    });
  },
  'typing.start': (d) => {
    if (d.user_id === S.me.id) return;
    let t = S.typing.get(d.channel_id);
    if (!t) {
      t = new Map();
      S.typing.set(d.channel_id, t);
    }
    t.set(d.user_id, Date.now() + 8000);
    setTimeout(update, 8100);
  },
  'mention.create': (d) => {
    const read = S.reads.get(d.channel_id) ?? { channel_id: d.channel_id, last_read_id: '0', mentions: 0 };
    read.mentions += 1;
    S.reads.set(d.channel_id, read);
  },
  'read.update': (d) => { S.reads.set(d.channel_id, d); },

  'server.sync': async (st) => {
    await ingestServer(st);
    refreshRoute();
  },
  'server.remove': (d) => {
    const srv = S.servers.get(d.server_id);
    if (srv) {
      for (const c of srv.channels) S.channels.delete(c.id);
      S.servers.delete(d.server_id);
    }
    if (S.route.serverId === d.server_id) navigate('/');
  },
  'member.add': (d) => {
    S.users.set(d.user.id, d.user);
    if (d.status && d.status !== 'offline') S.presences.set(d.user.id, d.status);
    const srv = S.servers.get(d.member.server_id);
    if (srv && !srv.memberIndex.has(d.user.id)) {
      srv.members.push(d.member);
      reindexMembers(srv);
    }
  },
  'member.update': (m) => {
    const srv = S.servers.get(m.server_id);
    if (!srv) return;
    srv.members = srv.members.map((x) => (x.user_id === m.user_id ? m : x));
    reindexMembers(srv);
  },
  'member.remove': (d) => {
    const srv = S.servers.get(d.server_id);
    if (!srv) return;
    srv.members = srv.members.filter((x) => x.user_id !== d.user_id);
    reindexMembers(srv);
  },
  'users.add': (d) => mergeUsers(d.users, d.presences),
  'user.update': (u) => { S.users.set(u.id, u); },
  'account.update': (a) => {
    S.me = a;
    S.users.set(a.id, a);
  },
  'presence.update': (d) => {
    if (d.status === 'offline') S.presences.delete(d.user_id);
    else S.presences.set(d.user_id, d.status);
  },
  'relationship.update': (d) => {
    S.users.set(d.user.id, d.user);
    S.relationships.set(d.user_id, d.kind);
    if (d.status && d.status !== 'offline') S.presences.set(d.user_id, d.status);
    if (d.kind === 'incoming') toast(`${d.user.display_name} sent you a friend request.`);
  },
  'relationship.remove': (d) => { S.relationships.delete(d.user_id); },
  'dm.create': async (d) => {
    mergeUsers(d.users, d.presences);
    await decryptGroupName(d.channel);
    S.channels.set(d.channel.id, d.channel);
    S.dms = [d.channel, ...S.dms.filter((c) => c.id !== d.channel.id)];
  },
  'dm.remove': (d) => {
    S.dms = S.dms.filter((c) => c.id !== d.channel_id);
    if (S.route.channelId === d.channel_id) navigate('/');
  },

  'keys.request': (req) => { serveKeyRequest(req); },
  'keys.available': async (d) => {
    if (d.scope === 'server') {
      const st = S.servers.get(d.id);
      if (st) {
        // Fetch this member's newly shared copy, then unseal the names.
        const fresh = await (await import('./api.js')).api.get(`/servers/${d.id}/keys`).catch(() => null);
        if (fresh?.key) {
          st.key = fresh.key;
          await ingestServer(st);
        }
      }
      return;
    }
    await refreshChannelKeys(d.id);
    await retryChannel(d.id);
  },
  'keys.rotated': async (d) => {
    await refreshChannelKeys(d.channel_id);
    if (S.call?.channelId === d.channel_id) await refreshCallKeys();
  },
  'keys.rotate': async (d) => {
    try {
      await rotate(d.channel_id);
    } catch (err) {
      console.warn('could not rotate the call key', err);
    }
    forgetChannelKeys(d.channel_id);
    await refreshChannelKeys(d.channel_id);
    if (S.call?.channelId === d.channel_id) await refreshCallKeys();
  },
  'watch.state': (w) => applyWatch(w),

  'voice.state': async (v) => {
    const channelId = v.channel_id === '0' ? v.left_channel_id : v.channel_id;
    if (S.call?.channelId === channelId && v.user_id !== S.me.id) {
      const had = S.voice.get(channelId)?.has(v.user_id);
      if (v.channel_id === '0') playSound('leave');
      else if (!had) playSound('join');
    }
    // A finished broadcast ends the watching too: the next one asks again,
    // rather than silently streaming to everyone who once looked.
    if (!v.screen && S.call?.watching.has(v.user_id)) {
      const { watchScreen } = await import('./voice.js');
      watchScreen(v.user_id, false);
    }
    putVoice(v);
    if (S.ring?.channel_id === v.channel_id && v.user_id === S.me.id) S.ring = null;
  },
  'voice.speaking': (d) => {
    if (d.speaking) S.speaking.add(d.user_id);
    else S.speaking.delete(d.user_id);
  },
  'call.ring': (d) => {
    if (S.call?.channelId === d.channel_id) return;
    S.ring = d;
    notifyRing(d);
    playSound('ring');
  },
  'call.end': (d) => {
    if (S.ring?.channel_id === d.channel_id) S.ring = null;
  },
  'op.error': (d) => {
    toast(d.message, 'error');
    handleVoiceEvent('op.error', d);
  },
};

async function onEvent(type, data) {
  if (type.startsWith('voice.') && type !== 'voice.state' && type !== 'voice.speaking') {
    await handleVoiceEvent(type, data);
  } else {
    await handlers[type]?.(data);
  }
  update();
}
