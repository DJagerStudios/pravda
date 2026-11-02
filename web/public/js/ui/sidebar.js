// The second column: a server's channels, or the list of conversations, with
// the call controls and your own card at the bottom.

import { html, classes, useState } from '../lib.js';
import {
  S, P, has, openModal, channelTree, isMuted, isUnread, mentionCount, dmTitle, dmPartner, displayName, channel,
} from '../state.js';
import { api } from '../api.js';
import { navigate, openChannel } from '../router.js';
import { Icon } from '../icons.js';
import {
  Avatar, IconButton, openContextMenu, openPopover, SrOnly, StatusDot, STATUS_LABELS,
} from './common.js';
import { channelMenu, serverMenu } from './menus.js';

/** A mention count that screen readers hear as words. */
export function MentionBadge({ count }) {
  if (!count) return null;
  return html`<span class="badge"><span aria-hidden="true">${count > 99 ? '99+' : count}</span><${SrOnly}>${count} ${count === 1 ? 'mention' : 'mentions'}<//></span>`;
}
import {
  joinVoice, leaveVoice, toggleCamera, toggleDeafen, toggleMute, toggleScreen,
} from '../voice.js';
import { report } from '../actions.js';
import { MOD } from './shortcuts.js';

function VoiceRoster({ channelId, serverId }) {
  const room = S.voice.get(channelId);
  if (!room) return null;
  return html`<ul class="voice-roster">
    ${[...room.values()].map((v) => html`<li key=${v.user_id} class=${classes('voice-person', S.speaking.has(v.user_id) && 'speaking')}>
      <${Avatar} userId=${v.user_id} size=${22} />
      <span class="voice-name">${displayName(v.user_id, serverId)}</span>
      ${v.screen && html`<span class="live-tag">Live</span>`}
      ${v.video && html`<${Icon} name="video" size=${14} />`}
      ${(v.self_mute || v.server_mute) && html`<${Icon} name="micOff" size=${14} class=${classes('icon', v.server_mute && 'silenced')} />`}
      ${(v.self_deaf || v.server_deaf) && html`<${Icon} name="phonesOff" size=${14} class=${classes('icon', v.server_deaf && 'silenced')} />`}
    </li>`)}
  </ul>`;
}

function ChannelRow({ c, serverId }) {
  const active = S.route.channelId === c.id;
  const mentions = mentionCount(c.id);
  const muted = isMuted(c);
  const unread = c.kind === 'text' && isUnread(c) && !muted;
  const manage = has(c.perms, P.MANAGE_CHANNELS);
  const open = () => {
    openChannel(c);
    if (c.kind === 'voice') joinVoice(c.id);
  };
  return html`<li>
    <div class=${classes('channel-row', active && 'active', unread && 'unread', muted && 'muted')}>
      <button class="channel-link" onClick=${open} aria-current=${active ? 'page' : null}
        onContextMenu=${(e) => openContextMenu(e, channelMenu(c))}>
        <span class="channel-glyph" aria-hidden="true">${c.kind === 'voice' ? html`<${Icon} name="speaker" size=${16} />` : '#'}</span>
        <span class="channel-name">${c.name}</span>
        ${c.kind === 'voice' && html`<${SrOnly}>, voice channel<//>`}
        ${unread && html`<${SrOnly}>, unread<//>`}
        ${muted && html`<${Icon} name="bellOff" size=${14} class="icon channel-muted" /><${SrOnly}>, muted<//>`}
        ${c.user_limit > 0 && html`<span class="channel-limit">${S.voice.get(c.id)?.size ?? 0}/${c.user_limit}</span>`}
      </button>
      <${MentionBadge} count=${mentions} />
      ${manage && html`<${IconButton} class="row-action" icon="gear" size=${14} label="Channel settings"
        onClick=${() => openModal('channelSettings', { channelId: c.id })} />`}
    </div>
    ${c.kind === 'voice' && html`<${VoiceRoster} channelId=${c.id} serverId=${serverId} />`}
  </li>`;
}

function ServerSidebar({ srv }) {
  const { loose, groups } = channelTree(srv);
  const [collapsed, setCollapsed] = useState(new Set());
  const can = (bit) => has(srv.perms, bit);
  const toggle = (id) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };
  const leave = () => openModal('confirm', {
    title: `Leave ${srv.name}?`,
    body: 'You will need a new invite to come back.',
    confirm: 'Leave',
    danger: true,
    onConfirm: () => api.post(`/servers/${srv.id}/leave`),
  });
  const openMenu = (e) => openPopover('menu', e.currentTarget, {
    items: [
      ...serverMenu(srv),
      '-',
      can(P.CREATE_INVITES) && { label: 'Invite people', icon: 'link', onClick: () => openModal('invite', { serverId: srv.id }) },
      (can(P.MANAGE_SERVER) || can(P.MANAGE_ROLES) || can(P.BAN) || can(P.VIEW_AUDIT))
        && { label: 'Server settings', icon: 'gear', onClick: () => openModal('serverSettings', { serverId: srv.id }) },
      can(P.MANAGE_CHANNELS) && { label: 'New channel', icon: 'plus', onClick: () => openModal('createChannel', { serverId: srv.id }) },
      can(P.MANAGE_CHANNELS) && { label: 'New category', icon: 'plus', onClick: () => openModal('createChannel', { serverId: srv.id, kind: 'category' }) },
      '-',
      srv.owner_id !== S.me.id && { label: 'Leave server', icon: 'door', danger: true, onClick: leave },
    ],
  });
  return html`<div class="sidebar-scroll">
    <button class="sidebar-head" onClick=${openMenu} onContextMenu=${(e) => openContextMenu(e, serverMenu(srv))} aria-haspopup="menu">
      <span class="sidebar-title">${srv.name}</span><${Icon} name="chevron" size=${18} />
    </button>
    <ul class="channel-list">
      ${loose.map((c) => html`<${ChannelRow} key=${c.id} c=${c} serverId=${srv.id} />`)}
      ${groups.map(({ category, channels }) => html`<li key=${category.id} class="channel-group">
        <div class="group-head">
          <button class="group-toggle" onClick=${() => toggle(category.id)} aria-expanded=${!collapsed.has(category.id)}>
            <${Icon} name=${collapsed.has(category.id) ? 'chevronRight' : 'chevron'} size=${12} />
            <span>${category.name}</span>
          </button>
          ${can(P.MANAGE_CHANNELS) && html`<${IconButton} class="row-action" icon="plus" size=${14} label="New channel here"
            onClick=${() => openModal('createChannel', { serverId: srv.id, parentId: category.id })} />`}
        </div>
        <ul class="channel-list">
          ${channels
            .filter((c) => !collapsed.has(category.id) || S.route.channelId === c.id || isUnread(c) || S.voice.has(c.id))
            .map((c) => html`<${ChannelRow} key=${c.id} c=${c} serverId=${srv.id} />`)}
        </ul>
      </li>`)}
    </ul>
  </div>`;
}

function HomeSidebar() {
  const hide = async (e, c) => {
    e.stopPropagation();
    try {
      await api.del(`/dms/${c.id}`);
    } catch (err) {
      report(err);
    }
  };
  return html`<div class="sidebar-scroll">
    <div class="sidebar-head static"><span class="sidebar-title">Direct messages</span></div>
    <button class="find-button" onClick=${() => openModal('switcher')} title=${`Find a conversation (${MOD}+K)`} aria-keyshortcuts="Control+K">
      <${Icon} name="search" size=${16} /><span>Find a conversation</span>
    </button>
    <button class=${classes('channel-row home-link', S.route.kind === 'home' && 'active')} onClick=${() => navigate('/')} aria-current=${S.route.kind === 'home' ? 'page' : null}>
      <${Icon} name="users" size=${18} /><span class="channel-name">Friends</span>
    </button>
    <div class="group-head"><span class="group-label">Conversations</span>
      <${IconButton} class="row-action visible" icon="plus" size=${14} label="New conversation" onClick=${() => openModal('newDM')} />
    </div>
    <ul class="channel-list">
      ${S.dms.map((c) => {
        const partner = dmPartner(c);
        return html`<li key=${c.id}>
          <div class=${classes('channel-row dm-row', S.route.channelId === c.id && 'active', isUnread(c) && !isMuted(c) && 'unread', isMuted(c) && 'muted')}>
            <button class="channel-link" onClick=${() => navigate(`/channels/@me/${c.id}`)} aria-current=${S.route.channelId === c.id ? 'page' : null}
              onContextMenu=${(e) => openContextMenu(e, channelMenu(c))}>
              <${Avatar} userId=${partner} size=${30} status=${c.kind === 'dm'} />
              <span class="channel-name">${dmTitle(c)}</span>
              ${isUnread(c) && !isMuted(c) && html`<${SrOnly}>, unread<//>`}
            </button>
            <${MentionBadge} count=${mentionCount(c.id)} />
            <${IconButton} class="row-action" icon="x" size=${14} label="Close conversation" onClick=${(e) => hide(e, c)} />
          </div>
        </li>`;
      })}
    </ul>
  </div>`;
}

function CallBar() {
  const call = S.call;
  if (!call) return null;
  const c = channel(call.channelId);
  const srv = c?.server_id !== '0' ? S.servers.get(c?.server_id) : null;
  const label = { connecting: 'Calling…', negotiating: 'Connecting…', connected: 'Voice connected' }[call.state];
  return html`<section class="call-bar" aria-label="Current call">
    <div class="call-info">
      <div class=${classes('call-state', call.state === 'connected' && 'good')}>${label}</div>
      <button class="call-place" onClick=${() => c && openChannel(c)}>
        ${c ? (srv ? `${c.name} · ${srv.name}` : dmTitle(c)) : 'Call'}
      </button>
    </div>
    <div class="call-actions">
      <${IconButton} icon=${call.video ? 'video' : 'videoOff'} label=${call.video ? 'Turn camera off' : 'Turn camera on'} active=${call.video} onClick=${toggleCamera} />
      <${IconButton} icon="screen" label=${call.screen ? 'Stop sharing' : 'Share your screen'} active=${call.screen} onClick=${toggleScreen} />
      <${IconButton} icon="hangup" label="Leave call" danger onClick=${() => leaveVoice()} />
    </div>
  </section>`;
}

function setStatus(status) {
  api.patch('/users/@me', { status }).catch(report);
}

function UserBar() {
  const me = S.me;
  const muted = S.call ? S.call.muted : S.savedMute;
  const deaf = S.call ? S.call.deafened : S.savedDeaf;
  const status = me.status;
  const openStatus = (e) => openPopover('menu', e.currentTarget, {
    items: [
      ...['online', 'idle', 'dnd', 'invisible'].map((s) => ({ label: STATUS_LABELS[s], onClick: () => setStatus(s) })),
      '-',
      { label: 'Edit profile', icon: 'edit', onClick: () => openModal('userSettings', { page: 'profile' }) },
      { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: () => openModal('shortcuts') },
      globalThis.pravdaDesktop?.switchInstance && { label: 'Switch server', icon: 'door', onClick: () => globalThis.pravdaDesktop.switchInstance() },
    ].filter(Boolean),
  });
  return html`<section class="user-bar" aria-label="Your account">
    <button class="user-card" onClick=${openStatus} title="Set your status">
      <${Avatar} userId=${me.id} size=${34} />
      <span class="user-text">
        <span class="user-name">${me.display_name}</span>
        <span class="user-status"><${StatusDot} status=${status === 'invisible' ? 'offline' : status} />${me.custom_status || STATUS_LABELS[status]}</span>
      </span>
    </button>
    <${IconButton} icon=${muted ? 'micOff' : 'mic'} label=${muted ? 'Unmute' : 'Mute'} active=${muted} onClick=${toggleMute} />
    <${IconButton} icon=${deaf ? 'phonesOff' : 'phones'} label=${deaf ? 'Undeafen' : 'Deafen'} active=${deaf} onClick=${toggleDeafen} />
    <${IconButton} icon="gear" label="Settings" onClick=${() => openModal('userSettings')} />
  </section>`;
}

export function Sidebar({ srv }) {
  return html`<aside class=${classes('sidebar', S.railOpen && 'open')}>
    ${srv ? html`<${ServerSidebar} srv=${srv} />` : html`<${HomeSidebar} />`}
    <${CallBar} />
    <${UserBar} />
  </aside>`;
}

