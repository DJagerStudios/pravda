// The strip of servers along the left edge.

import { html, classes, initials, avatarColor, useEffect, useState } from '../lib.js';
import { fetchMedia } from '../api.js';
import { decryptFile } from '../crypto.js';
import {
  S, openModal, serverMentions, serverUnread, mentionCount, isUnread, dmTitle,
} from '../state.js';
import { navigate } from '../router.js';
import { Icon, Logo } from '../icons.js';
import { Avatar, openContextMenu } from './common.js';
import { serverMenu } from './menus.js';

const emblems = new Map();

/** A server's icon, decrypted on this device; initials until then. */
export function ServerEmblem({ srv, size = 48 }) {
  const ref = srv.iconRef;
  const [url, setUrl] = useState(ref ? emblems.get(ref.id) ?? null : null);
  useEffect(() => {
    if (!ref || emblems.has(ref.id)) {
      setUrl(ref ? emblems.get(ref.id) ?? null : null);
      return;
    }
    let live = true;
    fetchMedia(`/media/${ref.id}/encrypted`)
      .then((data) => decryptFile(data, ref.key, ref.iv))
      .then((plain) => {
        const u = URL.createObjectURL(new Blob([plain], { type: ref.type || 'image/png' }));
        emblems.set(ref.id, u);
        if (live) setUrl(u);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [ref?.id]);
  const box = { width: `${size}px`, height: `${size}px` };
  return url
    ? html`<img class="emblem" src=${url} alt="" style=${box} />`
    : html`<span class="rail-letters emblem" style=${{ ...box, background: avatarColor(srv.id), fontSize: `${Math.round(size * 0.36)}px` }}>${initials(srv.name)}</span>`;
}

function Tile({ active, unread, mentions, label, onClick, onContextMenu, children, voice }) {
  const spoken = [label, unread && 'unread', mentions > 0 && `${mentions} ${mentions === 1 ? 'mention' : 'mentions'}`].filter(Boolean).join(', ');
  return html`<div class=${classes('rail-item', active && 'active', unread && 'unread')}>
    <span class="rail-marker" aria-hidden="true"></span>
    <button class="rail-tile" title=${label} aria-label=${spoken} aria-current=${active ? 'page' : null} onClick=${onClick} onContextMenu=${onContextMenu}>${children}</button>
    ${mentions > 0 && html`<span class="badge rail-badge" aria-hidden="true">${mentions > 99 ? '99+' : mentions}</span>`}
    ${voice && html`<span class="rail-voice" title="Your call is here"><${Icon} name="speaker" size=${12} /></span>`}
  </div>`;
}

export function Rail() {
  const homeMentions = S.dms.reduce((n, c) => n + mentionCount(c.id), 0);
  const unreadDMs = S.dms.filter((c) => mentionCount(c.id) > 0 && isUnread(c));
  const callServer = S.call ? S.channels.get(S.call.channelId)?.server_id : null;
  return html`<nav class="rail" aria-label="Servers">
    <${Tile} active=${S.route.kind === 'home' || (S.route.kind === 'channel' && !S.route.serverId)}
      mentions=${homeMentions} label="Friends and direct messages" onClick=${() => navigate('/')}>
      <${Logo} size=${48} />
    <//>
    ${unreadDMs.slice(0, 4).map((c) => html`<${Tile} key=${c.id} label=${dmTitle(c)} mentions=${mentionCount(c.id)}
      onClick=${() => navigate(`/channels/@me/${c.id}`)}>
      <${Avatar} userId=${(c.recipients ?? []).find((id) => id !== S.me.id)} size=${48} />
    <//>`)}
    <div class="rail-rule"></div>
    ${[...S.servers.values()].map((srv) => html`<${Tile} key=${srv.id}
      active=${S.route.serverId === srv.id} unread=${serverUnread(srv)} mentions=${serverMentions(srv)}
      voice=${callServer === srv.id} label=${srv.name}
      onClick=${() => navigate(`/channels/${srv.id}`)} onContextMenu=${(e) => openContextMenu(e, serverMenu(srv))}>
      <${ServerEmblem} srv=${srv} size=${48} />
    <//>`)}
    <button class="rail-add" title="Add a server" aria-label="Add a server"
      onClick=${() => openModal('addServer')}><${Icon} name="plus" size=${24} /></button>
  </nav>`;
}
