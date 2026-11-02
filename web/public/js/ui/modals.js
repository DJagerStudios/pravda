// Dialogs for creating and joining things, plus generic confirmations.

import { html, classes, useEffect, useState } from '../lib.js';
import {
  S, P, closeModal, displayName, has, server, channel, toast, user,
} from '../state.js';
import { api } from '../api.js';
import { navigate, openChannel } from '../router.js';
import {
  acceptInvite, createChannel, createInviteLink, foundServer, previewInvite, report,
} from '../actions.js';
import { rotate } from '../keys.js';
import { ttlLabel } from './messages.js';
import { Avatar, Button, Field, Modal } from './common.js';
import { Icon } from '../icons.js';

export function ConfirmModal({ title, body, confirm = 'Confirm', danger, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      closeModal();
    } catch (err) {
      report(err);
      setBusy(false);
    }
  };
  return html`<${Modal} title=${title} size="small" footer=${html`
    <${Button} onClick=${closeModal}>Cancel<//>
    <${Button} kind=${danger ? 'danger' : 'primary'} disabled=${busy} onClick=${go}>${confirm}<//>`}>
    <p>${body}</p>
  <//>`;
}

export function PromptModal({ title, label, confirm = 'Confirm', danger, onConfirm }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await onConfirm(value);
      closeModal();
    } catch (err) {
      report(err);
      setBusy(false);
    }
  };
  return html`<${Modal} title=${title} size="small" footer=${html`
    <${Button} onClick=${closeModal}>Cancel<//>
    <${Button} kind=${danger ? 'danger' : 'primary'} disabled=${busy} onClick=${go}>${confirm}<//>`}>
    <form onSubmit=${go}><${Field} label=${label}>
      <input data-autofocus maxlength="400" value=${value} onInput=${(e) => setValue(e.currentTarget.value)} />
    <//></form>
  <//>`;
}

/** Splits an invite link into its code and the key in its fragment. */
function parseInvite(text) {
  const trimmed = text.trim();
  let code = trimmed;
  let key = null;
  try {
    const url = new URL(trimmed);
    code = url.pathname.split('/').filter(Boolean).pop();
    key = url.hash.length > 1 ? url.hash.slice(1) : null;
  } catch {
    const [c, k] = trimmed.split('#');
    code = c.split('/').filter(Boolean).pop();
    key = k || null;
  }
  return { code, key };
}

export function AddServerModal() {
  const [name, setName] = useState(`${S.me.display_name}'s server`);
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const st = await foundServer(name.trim());
      closeModal();
      navigate(`/channels/${st.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const join = async (e) => {
    e.preventDefault();
    const { code, key } = parseInvite(link);
    if (!code) return;
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        const p = await previewInvite(code, key);
        if (p.gate !== 'none') {
          setPreview({ ...p, code, key });
          setBusy(false);
          return;
        }
      }
      const joined = await acceptInvite(code, key, password);
      closeModal();
      navigate(`/channels/${joined.server_id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return html`<${Modal} title="Add a server">
    <div class="split-forms">
      <form onSubmit=${create}>
        <h3>Create a server</h3>
        <p>A new server with a text channel and a voice channel, run by you. Its name is encrypted before it leaves this device.</p>
        <${Field} label="Name">
          <input data-autofocus required maxlength="100" value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
        <//>
        <${Button} kind="primary" type="submit" disabled=${busy || !name.trim()}>${busy ? 'Creating…' : 'Create server'}<//>
      </form>
      <form onSubmit=${join}>
        <h3>Join a server</h3>
        <p>Paste an invite link someone sent you. Its key travels in the link and never reaches the server.</p>
        <${Field} label="Invite link">
          <input maxlength="400" value=${link} onInput=${(e) => { setLink(e.currentTarget.value); setPreview(null); }} />
        <//>
        ${preview && html`<${Field} label=${preview.gate === 'rotating' ? 'Current join code' : 'Server password'}
          hint=${`${preview.name ?? 'This server'} asks for ${preview.gate === 'rotating' ? 'the code a member sees right now' : 'a password'}.`}>
          <input data-autofocus required value=${password} autocomplete="off" onInput=${(e) => setPassword(e.currentTarget.value)} />
        <//>`}
        <${Button} type="submit" disabled=${busy || !link.trim() || (preview && !password)}>Join<//>
      </form>
    </div>
    ${error && html`<p class="form-error" role="alert">${error}</p>`}
  <//>`;
}

const TTL_CHOICES = [0, 300, 3600, 21600, 86400, 604800, 2592000];

export function TTLSelect({ value, onChange }) {
  return html`<select value=${value} onChange=${(e) => onChange(Number(e.currentTarget.value))}>
    ${TTL_CHOICES.map((s) => html`<option key=${s} value=${s}>${s === 0 ? 'Never' : `After ${ttlLabel(s)}`}</option>`)}
  </select>`;
}

export function CreateChannelModal({ serverId, parentId, kind: initialKind }) {
  const srv = server(serverId);
  const isCategory = initialKind === 'category';
  const [kind, setKind] = useState(initialKind ?? 'text');
  const [name, setName] = useState('');
  const [parent, setParent] = useState(parentId ?? '0');
  const [ttl, setTtl] = useState(0);
  const [busy, setBusy] = useState(false);
  const categories = srv.channels.filter((c) => c.kind === 'category');
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const c = await createChannel(serverId, { name, kind, parentId: isCategory ? '0' : parent, ttl: kind === 'text' ? ttl : 0 });
      closeModal();
      if (kind === 'text') navigate(`/channels/${serverId}/${c.id}`);
    } catch (err) {
      report(err);
      setBusy(false);
    }
  };
  return html`<${Modal} title=${isCategory ? 'New category' : 'New channel'} size="small" footer=${html`
    <${Button} onClick=${closeModal}>Cancel<//>
    <${Button} kind="primary" disabled=${busy || !name.trim()} onClick=${submit}>Create<//>`}>
    <form onSubmit=${submit}>
      ${!isCategory && html`<div class="choice-row">
        ${[['text', 'Text', 'Messages, files and links'], ['voice', 'Voice', 'Calls, video, screen sharing and watch parties']].map(([k, label, hint]) => html`
          <button key=${k} type="button" class=${classes('choice', kind === k && 'active')} aria-pressed=${kind === k} onClick=${() => setKind(k)}>
            <strong>${label}</strong><span>${hint}</span>
          </button>`)}
      </div>`}
      <${Field} label="Name">
        <input data-autofocus required maxlength="100" value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
      <//>
      ${!isCategory && categories.length > 0 && html`<${Field} label="Category">
        <select value=${parent} onChange=${(e) => setParent(e.currentTarget.value)}>
          <option value="0">None</option>
          ${categories.map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
        </select>
      <//>`}
      ${kind === 'text' && html`<${Field} label="Disappearing messages" hint="Messages are deleted for everyone after this long.">
        <${TTLSelect} value=${ttl} onChange=${setTtl} />
      <//>`}
    </form>
  <//>`;
}

const AGES = [[3600, '1 hour'], [86400, '1 day'], [604800, '7 days'], [0, 'Never']];
const USES = [[0, 'No limit'], [1, '1 use'], [10, '10 uses'], [100, '100 uses']];

export function InviteModal({ serverId }) {
  const srv = server(serverId);
  const [maxAge, setMaxAge] = useState(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [invite, setInvite] = useState(null);
  const [gate, setGate] = useState(null);
  const target = S.route.channelId && channel(S.route.channelId)?.server_id === serverId && channel(S.route.channelId)?.kind === 'text'
    ? S.route.channelId
    : srv.channels.find((c) => c.kind === 'text' && has(c.perms, P.CREATE_INVITES))?.id;

  useEffect(() => {
    if (!target) return;
    createInviteLink(serverId, target, { maxAge, maxUses }).then(setInvite).catch(report);
  }, [maxAge, maxUses]);
  useEffect(() => {
    if (srv.gate_mode !== 'none') api.get(`/servers/${serverId}/gate`).then(setGate).catch(() => {});
  }, [srv.gate_mode]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      toast('Invite link copied.');
    } catch {
      toast('Copy it from the box instead.', 'error');
    }
  };
  return html`<${Modal} title=${`Invite people to ${srv.name}`} size="small">
    <${Field} label="Invite link" hint="The part after # is the server's key. Browsers never send it to any server.">
      <div class="copy-row">
        <input readonly value=${invite?.url ?? ''} onFocus=${(e) => e.currentTarget.select()} />
        <${Button} kind="primary" disabled=${!invite} onClick=${copy}>Copy<//>
      </div>
    <//>
    <div class="field-pair">
      <${Field} label="Expires after">
        <select value=${maxAge} onChange=${(e) => setMaxAge(Number(e.currentTarget.value))}>
          ${AGES.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
        </select>
      <//>
      <${Field} label="Uses">
        <select value=${maxUses} onChange=${(e) => setMaxUses(Number(e.currentTarget.value))}>
          ${USES.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
        </select>
      <//>
    </div>
    ${srv.gate_mode === 'password' && html`<p class="notice"><${Icon} name="key" size=${16} /> New members will also need this server's password.</p>`}
    ${srv.gate_mode === 'rotating' && gate?.code && html`<p class="notice"><${Icon} name="key" size=${16} />
      <span>Current join code: <strong class="mono">${gate.code}</strong>. It changes every ${Math.round(gate.period / 60) <= 1 ? 'minute' : `${Math.round(gate.period / 60)} minutes`}.</span></p>`}
  <//>`;
}

export function NewDMModal() {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const known = new Set();
  for (const srv of S.servers.values()) for (const m of srv.members) known.add(m.user_id);
  for (const [id, kind] of S.relationships) if (kind === 'friend') known.add(id);
  known.delete(S.me.id);
  const q = query.toLowerCase();
  const list = [...known]
    .map(user)
    .filter((u) => u.display_name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q))
    .slice(0, 30);
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const start = async () => {
    try {
      const c = await api.post('/dms', { recipients: picked });
      S.channels.set(c.id, c);
      if (c.key_epoch === 0) await rotate(c.id);
      closeModal();
      openChannel(c);
    } catch (err) {
      report(err);
    }
  };
  return html`<${Modal} title="New conversation" size="small" footer=${html`
    <${Button} onClick=${closeModal}>Cancel<//>
    <${Button} kind="primary" disabled=${picked.length === 0} onClick=${start}>${picked.length > 1 ? 'Start group' : 'Start'}<//>`}>
    <input data-autofocus class="wide" placeholder="Find a friend" aria-label="Find a friend" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
    <ul class="pick-list">
      ${list.map((u) => html`<li key=${u.id}>
        <button class=${classes('pick', picked.includes(u.id) && 'active')} onClick=${() => toggle(u.id)}>
          <${Avatar} userId=${u.id} size=${30} />
          <span class="pick-text"><span>${u.display_name}</span><small>@${u.username}</small></span>
          ${picked.includes(u.id) && html`<${Icon} name="check" size=${16} />`}
        </button>
      </li>`)}
    </ul>
  <//>`;
}

export function TTLModal({ channelId }) {
  const c = channel(channelId);
  const [ttl, setTtl] = useState(c?.ttl_seconds ?? 0);
  const save = async () => {
    try {
      await api.patch(`/channels/${channelId}`, { ttl_seconds: ttl });
      closeModal();
    } catch (err) {
      report(err);
    }
  };
  return html`<${Modal} title="Disappearing messages" size="small" footer=${html`
    <${Button} onClick=${closeModal}>Cancel<//><${Button} kind="primary" onClick=${save}>Save<//>`}>
    <p>New messages are deleted for everyone, from every device and from the server, after this long. Everyone in the conversation sees the change.</p>
    <${Field} label="Delete messages after"><${TTLSelect} value=${ttl} onChange=${setTtl} /><//>
  <//>`;
}

export function MemberRolesModal({ serverId, userId }) {
  const srv = server(serverId);
  const member = srv.memberIndex.get(userId);
  const roles = srv.roles.filter((r) => r.id !== srv.id).sort((a, b) => b.position - a.position);
  const toggle = async (roleId, on) => {
    const next = on ? [...member.roles, roleId] : member.roles.filter((r) => r !== roleId);
    try {
      await api.patch(`/servers/${serverId}/members/${userId}`, { roles: next });
    } catch (err) {
      report(err);
    }
  };
  return html`<${Modal} title=${`Roles of ${displayName(userId, serverId)}`} size="small">
    <ul class="pick-list">
      ${roles.map((r) => {
        const on = member.roles.includes(r.id);
        return html`<li key=${r.id}><button class=${classes('pick', on && 'active')} onClick=${() => toggle(r.id, !on)}>
          <span class="pick-text"><span>${r.name}</span></span>${on && html`<${Icon} name="check" size=${16} />`}
        </button></li>`;
      })}
    </ul>
  <//>`;
}

export function Lightbox({ url, name }) {
  return html`<div class="lightbox" role="dialog" aria-label=${name} onClick=${closeModal}>
    <img src=${url} alt=${name} />
    <a href=${url} download=${name} onClick=${(e) => e.stopPropagation()}>Save</a>
  </div>`;
}
