// Administration of a server and its channels. Names, topics and the icon
// are encrypted with the server's key before they are saved.

import {
  html, classes, colorCss, formatStamp, idTime, useEffect, useRef, useState,
} from '../lib.js';
import {
  S, P, channel, displayName, has, openModal, server, toast, user,
} from '../state.js';
import { api } from '../api.js';
import {
  createRole, renameRole, report, setServerIcon, updateChannelMeta, updateServerMeta,
} from '../actions.js';
import { Button, Empty, Field, Modal, Toggle } from './common.js';
import { ServerEmblem } from './rail.js';
import { TTLSelect } from './modals.js';
import { Icon } from '../icons.js';

const PERMISSIONS = [
  ['Channels', [
    [P.VIEW, 'View channels'], [P.SEND, 'Send messages'], [P.HISTORY, 'Read history'], [P.ATTACH, 'Attach files'],
    [P.REACT, 'Add reactions'], [P.MENTION_EVERYONE, 'Mention @everyone'],
  ]],
  ['Voice', [
    [P.CONNECT, 'Connect to voice'], [P.SPEAK, 'Speak'], [P.VIDEO, 'Use camera'], [P.STREAM, 'Share screen and host watch parties'],
    [P.MUTE_OTHERS, 'Mute members'], [P.DEAFEN_OTHERS, 'Deafen members'], [P.MOVE_OTHERS, 'Disconnect members'],
  ]],
  ['Administration', [
    [P.CREATE_INVITES, 'Create invites'], [P.CHANGE_NICK, 'Change own nickname'], [P.MANAGE_NICKS, 'Change others\' nicknames'],
    [P.MANAGE_MESSAGES, 'Manage messages'], [P.MANAGE_CHANNELS, 'Manage channels'], [P.MANAGE_ROLES, 'Manage roles'],
    [P.KICK, 'Kick members'], [P.BAN, 'Ban members'], [P.VIEW_AUDIT, 'View audit log'],
    [P.MANAGE_SERVER, 'Manage server'], [P.ADMINISTRATOR, 'Administrator'],
  ]],
];

function Overview({ srv }) {
  const [form, setForm] = useState({ name: srv.name, description: srv.description ?? '', system_channel_id: srv.system_channel_id });
  const file = useRef(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  const save = async (e) => {
    e.preventDefault();
    try {
      await updateServerMeta(srv, { name: form.name.trim(), description: form.description.trim() });
      if (form.system_channel_id !== srv.system_channel_id) await api.patch(`/servers/${srv.id}`, { system_channel_id: form.system_channel_id });
      toast('Server updated.');
    } catch (err) {
      report(err);
    }
  };
  const pick = async (e) => {
    const chosen = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!chosen) return;
    try {
      await setServerIcon(srv, chosen);
    } catch (err) {
      report(err);
    }
  };
  const texts = srv.channels.filter((c) => c.kind === 'text');
  return html`<form onSubmit=${save}>
    <div class="avatar-edit">
      <${ServerEmblem} srv=${srv} size=${88} />
      <div class="avatar-edit-actions">
        <${Button} onClick=${() => file.current.click()}>Change icon<//>
        <span class="field-hint">Encrypted: only members can see it.</span>
      </div>
      <input ref=${file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange=${pick} />
    </div>
    <${Field} label="Name"><input required maxlength="100" value=${form.name} onInput=${set('name')} /><//>
    <${Field} label="Description"><textarea rows="3" maxlength="400" value=${form.description} onInput=${set('description')}></textarea><//>
    <${Field} label="Announce new members in">
      <select value=${form.system_channel_id} onChange=${set('system_channel_id')}>
        <option value="0">Nowhere</option>
        ${texts.map((c) => html`<option key=${c.id} value=${c.id}>#${c.name}</option>`)}
      </select>
    <//>
    <${Button} kind="primary" type="submit">Save<//>
  </form>`;
}

function Privacy({ srv }) {
  const toggle = (v) => api.patch(`/servers/${srv.id}`, { history_visible: v }).catch(report);
  return html`<div>
    <h3>Encryption</h3>
    <p class="settings-line">Every message, file, reaction, name and call in this server is end-to-end encrypted. The server holds only ciphertext and cannot read any of it.</p>
    <${Toggle} label="New members can read earlier messages"
      hint="When on, members automatically share older keys with people who join. When off, new members only see what is written after they join."
      checked=${srv.history_visible} onChange=${toggle} />
  </div>`;
}

function Entry({ srv }) {
  const [gate, setGate] = useState(null);
  const [mode, setMode] = useState(srv.gate_mode);
  const [password, setPassword] = useState('');
  const [period, setPeriod] = useState(300);
  const load = () => api.get(`/servers/${srv.id}/gate`).then((g) => { setGate(g); setMode(g.mode); setPeriod(g.period || 300); }).catch(report);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (gate?.mode !== 'rotating') return undefined;
    const timer = setInterval(() => {
      setGate((g) => {
        if (!g) return g;
        if (g.remaining <= 1) {
          load();
          return g;
        }
        return { ...g, remaining: g.remaining - 1 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [gate?.mode]);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/servers/${srv.id}/gate`, { mode, password, period: Number(period) });
      setPassword('');
      toast('Access settings saved.');
      load();
    } catch (err) {
      report(err);
    }
  };
  const choices = [
    ['none', 'Invite only', 'A valid invite link is enough'],
    ['password', 'Password', 'New members also need a password you set'],
    ['rotating', 'Rotating code', 'New members need a code that changes on a timer'],
  ];
  return html`<form onSubmit=${save}>
    <h3>Who can join</h3>
    <div class="choice-row">
      ${choices.map(([k, label, hint]) => html`<button key=${k} type="button" class=${classes('choice', mode === k && 'active')} aria-pressed=${mode === k} onClick=${() => setMode(k)}>
        <strong>${label}</strong><span>${hint}</span>
      </button>`)}
    </div>
    ${mode === 'password' && html`<${Field} label="Server password" hint="At least 4 characters. If you change it, people with older invites need the new one.">
      <input type="text" autocomplete="off" required minlength="4" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} />
    <//>`}
    ${mode === 'rotating' && html`<${Field} label="New code every" hint="Saving makes a new secret, so codes shown before stop working.">
      <select value=${period} onChange=${(e) => setPeriod(e.currentTarget.value)}>
        ${[[60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [86400, '1 day']].map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
      </select>
    <//>`}
    <${Button} kind="primary" type="submit">Save<//>
    ${gate?.mode === 'rotating' && gate.code && html`<div class="rotating-code" aria-live="polite">
      <span class="field-label">Code right now</span>
      <strong class="mono">${gate.code}</strong>
      <span class="field-hint">Changes in ${gate.remaining} s</span>
    </div>`}
  </form>`;
}

function RoleEditor({ srv, role }) {
  const initial = () => ({ name: role.name, color: role.color, permissions: role.permissions, hoist: role.hoist, mentionable: role.mentionable });
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [role.id]);
  const isBase = role.id === srv.id;
  const toggleBit = (bit, on) => setForm({ ...form, permissions: on ? form.permissions | bit : form.permissions & ~bit });
  const save = async () => {
    try {
      if (!isBase && form.name.trim() !== role.name) await renameRole(srv, role.id, form.name.trim());
      await api.patch(`/servers/${srv.id}/roles/${role.id}`, {
        color: form.color, permissions: form.permissions, hoist: form.hoist, mentionable: form.mentionable,
      });
      toast('Role saved.');
    } catch (err) {
      report(err);
    }
  };
  const remove = () => openModal('confirm', {
    title: `Delete ${role.name}?`,
    body: 'Everyone holding this role will lose it.',
    confirm: 'Delete',
    danger: true,
    onConfirm: async () => {
      await api.del(`/servers/${srv.id}/roles/${role.id}`);
      openModal('serverSettings', { serverId: srv.id, page: 'roles' });
    },
  });
  return html`<div class="role-editor">
    <div class="field-pair">
      <${Field} label="Name"><input maxlength="64" disabled=${isBase} value=${form.name} onInput=${(e) => setForm({ ...form, name: e.currentTarget.value })} /><//>
      <${Field} label="Colour"><input type="color" value=${colorCss(form.color) || '#000000'} onInput=${(e) => setForm({ ...form, color: parseInt(e.currentTarget.value.slice(1), 16) })} /><//>
    </div>
    ${!isBase && html`
      <${Toggle} label="List separately" hint="Show holders in their own group beside the channel." checked=${form.hoist} onChange=${(v) => setForm({ ...form, hoist: v })} />
      <${Toggle} label="Anyone can mention this role" checked=${form.mentionable} onChange=${(v) => setForm({ ...form, mentionable: v })} />`}
    ${PERMISSIONS.map(([title, list]) => html`<section key=${title}>
      <h4>${title}</h4>
      ${list.map(([bit, label]) => html`<${Toggle} key=${bit} label=${label} checked=${has(form.permissions, bit)} onChange=${(v) => toggleBit(bit, v)} />`)}
    </section>`)}
    <div class="row-buttons">
      <${Button} kind="primary" onClick=${save}>Save role<//>
      ${!isBase && html`<${Button} kind="danger" onClick=${remove}>Delete role<//>`}
    </div>
  </div>`;
}

function Roles({ srv }) {
  const sorted = [...srv.roles].sort((a, b) => b.position - a.position);
  const [selected, setSelected] = useState(sorted[0]?.id);
  const role = srv.roleIndex.get(selected) ?? sorted[0];
  const add = async () => {
    try {
      const created = await createRole(srv, 'New role', 0);
      setSelected(created.id);
    } catch (err) {
      report(err);
    }
  };
  const move = async (r, direction) => {
    const custom = srv.roles.filter((x) => x.id !== srv.id).sort((a, b) => a.position - b.position);
    const index = custom.findIndex((x) => x.id === r.id);
    const target = index + direction;
    if (target < 0 || target >= custom.length) return;
    [custom[index], custom[target]] = [custom[target], custom[index]];
    try {
      await api.put(`/servers/${srv.id}/roles/order`, { roles: custom.map((x) => x.id) });
    } catch (err) {
      report(err);
    }
  };
  return html`<div class="roles-page">
    <div class="role-list">
      <${Button} onClick=${add}>New role<//>
      <ul>
        ${sorted.map((r) => html`<li key=${r.id} class=${classes('role-row', role?.id === r.id && 'active')}>
          <button class="role-pick" onClick=${() => setSelected(r.id)}>
            <i style=${{ background: colorCss(r.color) || 'currentColor' }}></i><span>${r.name}</span>
          </button>
          ${r.id !== srv.id && html`<span class="role-move">
            <button title="Move up" aria-label="Move up" onClick=${() => move(r, 1)}>▲</button>
            <button title="Move down" aria-label="Move down" onClick=${() => move(r, -1)}>▼</button>
          </span>`}
        </li>`)}
      </ul>
    </div>
    ${role && html`<${RoleEditor} key=${role.id} srv=${srv} role=${role} />`}
  </div>`;
}

function Invites({ srv }) {
  const [invites, setInvites] = useState(null);
  const load = () => api.get(`/servers/${srv.id}/invites`).then(setInvites).catch(report);
  useEffect(() => { load(); }, []);
  const revoke = async (code) => {
    try {
      await api.del(`/invites/${code}`);
      load();
    } catch (err) {
      report(err);
    }
  };
  if (!invites) return null;
  if (invites.length === 0) return html`<${Empty} title="No invites">No invite links have been made yet.<//>`;
  return html`<ul class="admin-list">
    ${invites.map((v) => html`<li key=${v.code}>
      <span class="admin-text"><strong class="mono">${v.code}</strong>
        <small>By ${user(v.creator_id).display_name} · ${v.uses}${v.max_uses ? `/${v.max_uses}` : ''} uses${v.expires_at ? ` · expires ${formatStamp(v.expires_at)}` : ''}</small></span>
      <${Button} onClick=${() => revoke(v.code)}>Revoke<//>
    </li>`)}
  </ul>`;
}

function Bans({ srv }) {
  const [data, setData] = useState(null);
  const load = () => api.get(`/servers/${srv.id}/bans`).then(setData).catch(report);
  useEffect(() => { load(); }, []);
  const lift = async (id) => {
    try {
      await api.del(`/servers/${srv.id}/bans/${id}`);
      load();
    } catch (err) {
      report(err);
    }
  };
  if (!data) return null;
  if (data.bans.length === 0) return html`<${Empty} title="No bans">Nobody has been banned.<//>`;
  const names = new Map(data.users.map((u) => [u.id, u]));
  return html`<ul class="admin-list">
    ${data.bans.map((b) => html`<li key=${b.user_id}>
      <span class="admin-text"><strong>${names.get(b.user_id)?.display_name ?? b.user_id}</strong><small>${b.reason || 'No reason recorded'}</small></span>
      <${Button} onClick=${() => lift(b.user_id)}>Unban<//>
    </li>`)}
  </ul>`;
}

const AUDIT_LABELS = {
  'server.update': 'updated the server',
  'server.gate': 'changed who can join',
  'member.kick': 'kicked',
  'member.ban': 'banned',
  'member.unban': 'unbanned',
  'member.roles': 'changed the roles of',
  'member.voice': 'moderated',
  'voice.disconnect': 'disconnected',
  'role.create': 'created a role',
  'role.update': 'changed a role',
  'role.delete': 'deleted a role',
  'role.reorder': 'reordered the roles',
  'channel.create': 'created a channel',
  'channel.update': 'changed a channel',
  'channel.delete': 'deleted a channel',
  'channel.overwrite': 'changed channel permissions',
  'invite.create': 'created an invite',
  'invite.delete': 'revoked an invite',
  'message.delete': 'deleted a message by',
};

function Audit({ srv }) {
  const [entries, setEntries] = useState(null);
  useEffect(() => { api.get(`/servers/${srv.id}/audit`).then(setEntries).catch(report); }, []);
  if (!entries) return null;
  if (entries.length === 0) return html`<${Empty} title="Nothing logged">Moderation and settings changes will be listed here.<//>`;
  const targetsPerson = (a) => a.startsWith('member.') || a === 'voice.disconnect' || a === 'message.delete';
  return html`<ul class="admin-list audit">
    ${entries.map((e) => html`<li key=${e.id}>
      <span class="admin-text">
        <span><strong>${displayName(e.actor_id, srv.id)}</strong> ${AUDIT_LABELS[e.action] ?? e.action}${targetsPerson(e.action) ? html` <strong>${displayName(e.target_id, srv.id)}</strong>` : ''}</span>
        ${e.detail && !e.action.startsWith('invite.') && html`<small>${e.detail}</small>`}
        <small>${formatStamp(idTime(e.id))}</small>
      </span>
    </li>`)}
  </ul>`;
}

function DangerZone({ srv }) {
  const [heir, setHeir] = useState('');
  const others = srv.members.filter((m) => m.user_id !== S.me.id);
  const transfer = () => openModal('confirm', {
    title: 'Transfer ownership?',
    body: `${displayName(heir, srv.id)} becomes the owner. You cannot undo this yourself.`,
    confirm: 'Transfer',
    danger: true,
    onConfirm: () => api.patch(`/servers/${srv.id}`, { owner_id: heir }),
  });
  const deleteServer = () => openModal('confirm', {
    title: `Delete ${srv.name}?`,
    body: 'Every channel, message and file in this server is deleted. This cannot be undone.',
    confirm: 'Delete server',
    danger: true,
    onConfirm: () => api.del(`/servers/${srv.id}`),
  });
  return html`<div>
    <h3>Transfer ownership</h3>
    <${Field} label="New owner">
      <select value=${heir} onChange=${(e) => setHeir(e.currentTarget.value)}>
        <option value="">Choose a member</option>
        ${others.map((m) => html`<option key=${m.user_id} value=${m.user_id}>${displayName(m.user_id, srv.id)}</option>`)}
      </select>
    <//>
    <${Button} disabled=${!heir} onClick=${transfer}>Transfer<//>
    <h3>Delete this server</h3>
    <p class="settings-line">Deletes everything here, for everyone.</p>
    <${Button} kind="danger" onClick=${deleteServer}>Delete server<//>
  </div>`;
}

export function ServerSettings({ serverId, page: initial }) {
  const srv = server(serverId);
  const can = (bit) => has(srv?.perms ?? 0, bit);
  const pages = [
    can(P.MANAGE_SERVER) && ['overview', 'Overview', Overview],
    can(P.MANAGE_SERVER) && ['privacy', 'Privacy', Privacy],
    can(P.MANAGE_SERVER) && ['entry', 'Access', Entry],
    can(P.MANAGE_ROLES) && ['roles', 'Roles', Roles],
    can(P.MANAGE_SERVER) && ['invites', 'Invites', Invites],
    can(P.BAN) && ['bans', 'Bans', Bans],
    can(P.VIEW_AUDIT) && ['audit', 'Audit log', Audit],
    srv?.owner_id === S.me.id && ['danger', 'Danger zone', DangerZone],
  ].filter(Boolean);
  const [page, setPage] = useState(initial ?? pages[0]?.[0]);
  if (!srv) return null;
  const Page = pages.find((p) => p[0] === page)?.[2] ?? pages[0]?.[2];
  return html`<${Modal} title=${srv.name} kicker="Server settings" size="large">
    <div class="settings">
      <nav class="settings-nav" aria-label="Server settings pages">
        ${pages.map(([key, label]) => html`<button key=${key} class=${classes('settings-tab', page === key && 'active')} onClick=${() => setPage(key)}>${label}</button>`)}
      </nav>
      <div class="settings-page">${Page && html`<${Page} srv=${srv} />`}</div>
    </div>
  <//>`;
}

function TriState({ label, state, onChange }) {
  const options = [['deny', '✕', 'Deny'], ['inherit', '/', 'Inherit'], ['allow', '✓', 'Allow']];
  return html`<div class="tristate">
    <span class="tristate-label">${label}</span>
    <div role="group" aria-label=${label}>
      ${options.map(([value, glyph, title]) => html`<button key=${value} title=${title} aria-label=${title} aria-pressed=${state === value}
        class=${classes(`tri-${value}`, state === value && 'active')} onClick=${() => onChange(value)}>${glyph}</button>`)}
    </div>
  </div>`;
}

function ChannelPermissions({ c, srv }) {
  const [target, setTarget] = useState(`role:${srv.id}`);
  const [kind, targetId] = target.split(':');
  const relevant = PERMISSIONS.flatMap(([title, list]) => (title === 'Administration'
    ? list.filter(([bit]) => bit === P.CREATE_INVITES || bit === P.MANAGE_MESSAGES || bit === P.MANAGE_CHANNELS)
    : list));
  const existing = c.overwrites?.find((o) => o.member === (kind === 'member') && o.target_id === targetId);
  const allow = existing?.allow ?? 0;
  const deny = existing?.deny ?? 0;
  const roles = [...srv.roles].sort((a, b) => b.position - a.position);
  const stateOf = (bit) => (has(allow, bit) ? 'allow' : has(deny, bit) ? 'deny' : 'inherit');
  const change = async (bit, value) => {
    const nextAllow = value === 'allow' ? allow | bit : allow & ~bit;
    const nextDeny = value === 'deny' ? deny | bit : deny & ~bit;
    const path = `/channels/${c.id}/overwrites/${kind}/${targetId}`;
    try {
      if (nextAllow === 0 && nextDeny === 0) await api.del(path);
      else await api.put(path, { allow: nextAllow, deny: nextDeny });
    } catch (err) {
      report(err);
    }
  };
  return html`<div>
    <${Field} label="Rules for" hint="Inherit follows the category and the role's own permissions. Rules for a member override their roles' rules.">
      <select value=${target} onChange=${(e) => setTarget(e.currentTarget.value)}>
        <optgroup label="Roles">${roles.map((r) => html`<option key=${r.id} value=${`role:${r.id}`}>${r.name}</option>`)}</optgroup>
        <optgroup label="Members">${srv.members.map((m) => html`<option key=${m.user_id} value=${`member:${m.user_id}`}>${displayName(m.user_id, srv.id)}</option>`)}</optgroup>
      </select>
    <//>
    ${relevant.map(([bit, label]) => html`<${TriState} key=${bit} label=${label} state=${stateOf(bit)} onChange=${(v) => change(bit, v)} />`)}
  </div>`;
}

export function ChannelSettings({ channelId }) {
  const c = channel(channelId);
  const srv = c ? server(c.server_id) : null;
  const [page, setPage] = useState('overview');
  const [form, setForm] = useState({ name: c?.name ?? '', topic: c?.topic ?? '', user_limit: c?.user_limit ?? 0, ttl: c?.ttl_seconds ?? 0 });
  if (!c || !srv) return null;
  const save = async (e) => {
    e.preventDefault();
    try {
      if (form.name !== c.name || form.topic !== c.topic) await updateChannelMeta(c, { name: form.name, topic: form.topic });
      const patch = {};
      if (Number(form.user_limit) !== c.user_limit) patch.user_limit = Number(form.user_limit);
      if (form.ttl !== c.ttl_seconds) patch.ttl_seconds = form.ttl;
      if (Object.keys(patch).length) await api.patch(`/channels/${c.id}`, patch);
      toast('Channel saved.');
    } catch (err) {
      report(err);
    }
  };
  const remove = () => openModal('confirm', {
    title: `Close ${c.name}?`,
    body: 'Its messages and files are deleted. This cannot be undone.',
    confirm: 'Delete channel',
    danger: true,
    onConfirm: () => api.del(`/channels/${c.id}`),
  });
  const canPermit = has(c.perms, P.MANAGE_ROLES);
  return html`<${Modal} title=${c.name} kicker="Channel settings" size="large">
    <div class="settings">
      <nav class="settings-nav" aria-label="Channel settings pages">
        <button class=${classes('settings-tab', page === 'overview' && 'active')} onClick=${() => setPage('overview')}>Overview</button>
        ${canPermit && html`<button class=${classes('settings-tab', page === 'permissions' && 'active')} onClick=${() => setPage('permissions')}>Permissions</button>`}
      </nav>
      <div class="settings-page">
        ${page === 'overview'
          ? html`<form onSubmit=${save}>
              <${Field} label="Name"><input required maxlength="100" value=${form.name} onInput=${(e) => setForm({ ...form, name: e.currentTarget.value })} /><//>
              ${c.kind === 'text' && html`<${Field} label="Topic"><textarea rows="3" maxlength="1000" value=${form.topic} onInput=${(e) => setForm({ ...form, topic: e.currentTarget.value })}></textarea><//>`}
              ${c.kind === 'text' && html`<${Field} label="Disappearing messages" hint="Deleted for everyone, from every device and the server.">
                <${TTLSelect} value=${form.ttl} onChange=${(v) => setForm({ ...form, ttl: v })} />
              <//>`}
              ${c.kind === 'voice' && html`<${Field} label="User limit" hint="0 means unlimited."><input type="number" min="0" max="99" value=${form.user_limit} onInput=${(e) => setForm({ ...form, user_limit: e.currentTarget.value })} /><//>`}
              <div class="row-buttons">
                <${Button} kind="primary" type="submit">Save<//>
                <${Button} kind="danger" onClick=${remove}>Delete channel<//>
              </div>
            </form>`
          : html`<${ChannelPermissions} c=${c} srv=${srv} />`}
      </div>
    </div>
  <//>`;
}

export { Icon };
