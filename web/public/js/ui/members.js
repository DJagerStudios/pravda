// The member list and the profile card, including moderation controls.

import {
  html, classes, colorCss, nameColor, useEffect, useState,
} from '../lib.js';
import { mediaUrl } from '../api.js';
import { fingerprint, safetyNumber } from '../crypto.js';
import { acceptKeyChange, myFingerprint } from '../keys.js';
import {
  S, P, has, displayName, memberOf, memberTopRole, openModal, presence, relationship, roleColor, update, user,
} from '../state.js';
import { api } from '../api.js';
import { openDM, report } from '../actions.js';
import { Avatar, Button, closePopover, openPopover, StatusDot, STATUS_LABELS, Toggle } from './common.js';
import { setLocalMute, setUserVolume } from '../voice.js';
import { Icon } from '../icons.js';

function MemberRow({ m, srv }) {
  const u = user(m.user_id);
  const status = presence(m.user_id);
  const color = nameColor(roleColor(srv.id, m.user_id));
  return html`<li>
    <button class=${classes('member', status === 'offline' && 'offline')}
      onClick=${(e) => openPopover('profile', e.currentTarget, { userId: m.user_id, serverId: srv.id })}>
      <${Avatar} userId=${m.user_id} size=${32} status />
      <span class="member-text">
        <span class="member-name" style=${color ? { color } : null}>
          ${displayName(m.user_id, srv.id)}
          ${srv.owner_id === m.user_id && html`<span title="Server owner"><${Icon} name="crown" size=${12} class="owner-star" /></span>`}
        </span>
        ${u.custom_status && html`<span class="member-status">${u.custom_status}</span>`}
      </span>
    </button>
  </li>`;
}

export function MemberList({ srv }) {
  const byName = (a, b) => displayName(a.user_id, srv.id).localeCompare(displayName(b.user_id, srv.id));
  const groups = new Map();
  const online = [];
  const offline = [];
  for (const m of srv.members) {
    if (presence(m.user_id) === 'offline') {
      offline.push(m);
      continue;
    }
    const role = memberTopRole(srv.id, m.user_id);
    if (role) {
      if (!groups.has(role.id)) groups.set(role.id, { role, members: [] });
      groups.get(role.id).members.push(m);
    } else {
      online.push(m);
    }
  }
  const sections = [...groups.values()]
    .sort((a, b) => b.role.position - a.role.position)
    .map((g) => ({ key: g.role.id, title: g.role.name, members: g.members }));
  if (online.length) sections.push({ key: 'online', title: 'Online', members: online });
  if (offline.length) sections.push({ key: 'offline', title: 'Offline', members: offline });
  return html`<aside class="members" aria-label="Members">
    ${sections.map((s) => html`<section key=${s.key}>
      <h3>${s.title} — ${s.members.length}</h3>
      <ul>${[...s.members].sort(byName).map((m) => html`<${MemberRow} key=${m.user_id} m=${m} srv=${srv} />`)}</ul>
    </section>`)}
  </aside>`;
}

function FriendButton({ userId }) {
  const kind = relationship(userId);
  const add = () => api.post('/relationships', { username: user(userId).username }).catch(report);
  const accept = () => api.put(`/relationships/${userId}`, { kind: 'friend' }).catch(report);
  if (kind === 'friend' || kind === 'blocked') return null;
  if (kind === 'incoming') return html`<${Button} onClick=${accept}>Accept request<//>`;
  if (kind === 'outgoing') return html`<${Button} disabled>Request sent<//>`;
  return html`<${Button} onClick=${add}>Add friend<//>`;
}

function ModerationSection({ srv, userId }) {
  const can = (bit) => has(srv.perms, bit);
  const member = memberOf(srv.id, userId);
  if (!member || userId === S.me.id) return null;
  const voice = [...S.voice.values()].find((room) => room.has(userId))?.get(userId);
  const inHere = voice?.server_id === srv.id;
  const path = `/servers/${srv.id}/members/${userId}`;
  const toggle = (patch) => api.patch(path, patch).catch(report);
  const name = displayName(userId, srv.id);
  const kick = () => openModal('confirm', {
    title: `Kick ${name}?`,
    body: 'They can come back with a new invite.',
    confirm: 'Kick',
    danger: true,
    onConfirm: () => api.del(path),
  });
  const ban = () => openModal('prompt', {
    title: `Ban ${name}?`,
    label: 'Reason (kept in the audit log)',
    confirm: 'Ban',
    danger: true,
    onConfirm: (reason) => api.put(`/servers/${srv.id}/bans/${userId}`, { reason }),
  });
  const sections = [
    can(P.MANAGE_ROLES) && html`<${Button} onClick=${() => { closePopover(); openModal('memberRoles', { serverId: srv.id, userId }); }}>Roles<//>`,
    inHere && can(P.MOVE_OTHERS) && html`<${Button} onClick=${() => api.post(`/servers/${srv.id}/voice/${userId}/disconnect`).catch(report)}>Disconnect<//>`,
    can(P.KICK) && html`<${Button} kind="danger" onClick=${() => { closePopover(); kick(); }}>Kick<//>`,
    can(P.BAN) && html`<${Button} kind="danger" onClick=${() => { closePopover(); ban(); }}>Ban<//>`,
  ].filter(Boolean);
  const toggles = [
    can(P.MUTE_OTHERS) && html`<${Toggle} label="Mute in voice" checked=${member.server_mute} onChange=${(v) => toggle({ server_mute: v })} />`,
    can(P.DEAFEN_OTHERS) && html`<${Toggle} label="Deafen in voice" checked=${member.server_deaf} onChange=${(v) => toggle({ server_deaf: v })} />`,
  ].filter(Boolean);
  if (sections.length === 0 && toggles.length === 0) return null;
  return html`<section class="card-section">
    <h4>Moderation</h4>
    ${toggles}
    <div class="card-actions">${sections}</div>
  </section>`;
}

function VolumeSlider({ userId }) {
  const [value, setValue] = useState(S.settings.volumes[userId] ?? 100);
  const muted = !!S.settings.localMutes[userId];
  return html`<section class="card-section">
    <h4 id=${`volume-${userId}`}>Volume — ${value}%</h4>
    <input type="range" min="0" max="100" value=${value} aria-labelledby=${`volume-${userId}`} disabled=${muted}
      onInput=${(e) => { const v = Number(e.currentTarget.value); setValue(v); setUserVolume(userId, v); }} />
    <${Toggle} label="Mute for me" hint="Only you stop hearing them." checked=${muted} onChange=${(v) => { setLocalMute(userId, v); update(); }} />
  </section>`;
}

function SafetyNumber({ userId }) {
  const [number, setNumber] = useState(null);
  const [mine, setMine] = useState(null);
  const changed = S.keyChanges.has(userId);
  useEffect(() => {
    (async () => {
      const u = user(userId);
      const theirs = await fingerprint(u.sign_key, u.dh_key);
      const own = await myFingerprint();
      setMine(theirs);
      setNumber(safetyNumber(own, theirs));
    })().catch(() => {});
  }, [userId, user(userId).dh_key]);
  if (!number) return null;
  return html`<section class="card-section">
    <h4>Safety number</h4>
    ${changed && html`<p class="key-warning">${user(userId).display_name}'s security keys changed. If they did not reset them, someone may be intercepting. Compare this number with them before trusting it.</p>`}
    <code class="safety-number">${number}</code>
    <p class="field-hint">Compare in person or on a call: if you both see the same number, nobody is intercepting your messages.</p>
    ${changed && html`<${Button} onClick=${() => acceptKeyChange(userId, mine)}>We compared it: trust the new keys<//>`}
  </section>`;
}

export function ProfileCard({ userId, serverId, preview }) {
  const u = preview ?? user(userId);
  const srv = serverId ? S.servers.get(serverId) : null;
  const member = srv ? memberOf(serverId, userId) : null;
  const status = presence(userId);
  const self = userId === S.me.id;
  const inMyCall = S.call && S.voice.get(S.call.channelId)?.has(userId) && !self;
  const blocked = relationship(userId) === 'blocked';
  const accent = colorCss(u.accent_color);
  const bannerStyle = u.banner
    ? { backgroundImage: `url("${mediaUrl(u.banner)}")` }
    : u.banner_color ? { background: colorCss(u.banner_color) } : null;
  const block = () => {
    closePopover();
    openModal('confirm', {
      title: `Block ${u.display_name}?`,
      body: 'They will not be able to write to you, and their messages will be hidden.',
      confirm: 'Block',
      danger: true,
      onConfirm: () => api.put(`/relationships/${userId}`, { kind: 'blocked' }),
    });
  };
  return html`<div class="profile-card" style=${accent ? { '--card-accent': accent } : null}>
    <div class="profile-banner" style=${bannerStyle}></div>
    <div class="profile-head">
      <${Avatar} userId=${userId} size=${76} status=${!preview} />
      <h3>${srv ? displayName(userId, serverId) : u.display_name}</h3>
      <div class="profile-username">@${u.username}${u.pronouns ? html` · <span>${u.pronouns}</span>` : ''}</div>
      <div class="profile-status"><${StatusDot} status=${status} /> <span>${u.custom_status || STATUS_LABELS[status]}</span></div>
    </div>
    ${u.bio && html`<section class="card-section"><h4>About</h4><p class="profile-bio">${u.bio}</p></section>`}
    ${member?.roles.length > 0 && html`<section class="card-section">
      <h4>Roles</h4>
      <div class="role-chips">
        ${member.roles.map((id) => srv.roleIndex.get(id)).filter(Boolean).sort((a, b) => b.position - a.position).map((r) => html`
          <span key=${r.id} class="role-chip"><i style=${{ background: colorCss(r.color) || 'currentColor' }}></i>${r.name}</span>`)}
      </div>
    </section>`}
    ${inMyCall && html`<${VolumeSlider} userId=${userId} />`}
    ${!self && !preview && html`<div class="card-actions">
      ${!blocked && html`<${Button} kind="primary" onClick=${() => { closePopover(); openDM(userId); }}>Write<//>`}
      <${FriendButton} userId=${userId} />
      ${blocked
        ? html`<${Button} onClick=${() => api.del(`/relationships/${userId}`).catch(report)}>Unblock<//>`
        : html`<${Button} onClick=${block}>Block<//>`}
    </div>`}
    ${!self && !preview && html`<${SafetyNumber} userId=${userId} />`}
    ${srv && !preview && html`<${ModerationSection} srv=${srv} userId=${userId} />`}
  </div>`;
}
