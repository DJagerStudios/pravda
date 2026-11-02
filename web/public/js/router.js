// URL routing. The address bar is the source of truth for what is on screen.

import {
  S, update, firstTextChannel, server,
} from './state.js';

function parse(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'invite' && parts[1]) return { kind: 'invite', code: parts[1] };
  if (parts[0] === 'channels' && parts[1] === '@me' && parts[2]) return { kind: 'channel', channelId: parts[2] };
  if (parts[0] === 'channels' && parts[1] && parts[1] !== '@me') {
    return { kind: 'channel', serverId: parts[1], channelId: parts[2] ?? null };
  }
  return { kind: 'home' };
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else if (location.pathname !== path) history.pushState(null, '', path);
  S.route = parse(path);
  S.replyTo = null;
  S.editing = null;
  S.panel = null;
  S.railOpen = false;
  refreshRoute();
  update();
}

/** Re-checks the route against what the user can actually see. */
export function refreshRoute() {
  const r = S.route;
  if (r.kind !== 'channel' || S.phase !== 'ready') return;
  if (r.serverId) {
    const srv = server(r.serverId);
    if (!srv) {
      navigate('/', { replace: true });
      return;
    }
    const here = r.channelId ? S.channels.get(r.channelId) : null;
    if (!here || here.server_id !== r.serverId || here.kind === 'category') {
      const fallback = S.lastChannel.get(r.serverId) && S.channels.has(S.lastChannel.get(r.serverId))
        ? S.lastChannel.get(r.serverId)
        : firstTextChannel(srv)?.id;
      r.channelId = fallback ?? null;
      history.replaceState(null, '', `/channels/${r.serverId}${fallback ? `/${fallback}` : ''}`);
    }
    if (r.channelId) S.lastChannel.set(r.serverId, r.channelId);
  } else if (!S.channels.has(r.channelId)) {
    navigate('/', { replace: true });
  }
}

export function startRouter() {
  S.route = parse(location.pathname);
  addEventListener('popstate', () => {
    S.route = parse(location.pathname);
    S.replyTo = null;
    S.editing = null;
    refreshRoute();
    update();
  });
}

export function openChannel(c) {
  navigate(c.server_id === '0' ? `/channels/@me/${c.id}` : `/channels/${c.server_id}/${c.id}`);
}
