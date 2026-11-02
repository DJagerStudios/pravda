// Watching together. A call's shared viewing is a small state (what, playing
// or paused, where, as of when) that any participant with the right to stream
// may change. It travels encrypted; each viewer's player follows it, using
// the server's clock so everyone lands on the same frame.

import { S, serverNow } from './state.js';
import { send } from './gateway.js';
import { encryptWatch, reportKeyError } from './keys.js';

const YOUTUBE_ID = /^[\w-]{11}$/;

/** Turns what someone pasted into a playable source, or null. */
export function parseSource(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    id = url.searchParams.get('v') ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1] ?? null;
  }
  if (id !== null) return YOUTUBE_ID.test(id) ? { kind: 'youtube', src: id, start: Number(url.searchParams.get('t')?.replace(/s$/, '')) || 0 } : null;
  if (/\.(mp4|webm|ogv|m4v|mov)$/i.test(url.pathname)) return { kind: 'url', src: url.href };
  return null;
}

export function hostOf(state) {
  if (state.kind === 'youtube') return 'www.youtube-nocookie.com';
  try {
    return new URL(state.src).hostname;
  } catch {
    return 'an unknown site';
  }
}

/** Where playback should be right now, in seconds. */
export function expectedPosition(state) {
  if (!state) return 0;
  return state.playing ? state.pos + (serverNow() - state.at) / 1000 : state.pos;
}

async function publish(channelId, state) {
  try {
    send('watch_set', { channel_id: channelId, blob: await encryptWatch(channelId, state) });
  } catch (err) {
    reportKeyError(err);
  }
}

export function startWatch(channelId, source) {
  return publish(channelId, {
    kind: source.kind, src: source.src, title: source.title ?? '', playing: true, pos: source.start ?? 0, at: serverNow(),
  });
}

export function updateWatch(channelId, patch) {
  const current = S.watch.get(channelId);
  if (!current) return null;
  const pos = patch.pos ?? expectedPosition(current);
  const { by: _by, ...rest } = current;
  return publish(channelId, { ...rest, ...patch, pos: Math.max(0, pos), at: serverNow() });
}

export function stopWatch(channelId) {
  send('watch_clear', { channel_id: channelId });
}
