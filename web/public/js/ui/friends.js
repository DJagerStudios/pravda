// The home view: your friends and pending requests.

import { html, classes, useState } from '../lib.js';
import {
  S, presence, update, user,
} from '../state.js';
import { api } from '../api.js';
import { openDM, report } from '../actions.js';
import { Avatar, Button, Empty, IconButton, STATUS_LABELS } from './common.js';

const TABS = [
  ['online', 'Online'],
  ['all', 'All friends'],
  ['pending', 'Requests'],
  ['blocked', 'Blocked'],
];

function AddFriend() {
  const [name, setName] = useState('');
  const [note, setNote] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/relationships', { username: name.trim() });
      setNote({ good: true, text: `Request sent to ${name.trim()}.` });
      setName('');
    } catch (err) {
      setNote({ good: false, text: err.message });
    }
  };
  return html`<form class="add-friend" onSubmit=${submit}>
    <h3>Add a friend</h3>
    <p>Send a request to anyone on this instance by their username.</p>
    <div class="add-friend-row">
      <input placeholder="username" aria-label="Username" value=${name} autocapitalize="off" spellcheck="false"
        onInput=${(e) => setName(e.currentTarget.value)} />
      <${Button} kind="primary" type="submit" disabled=${!name.trim()}>Send request<//>
    </div>
    ${note && html`<p class=${note.good ? 'form-good' : 'form-error'}>${note.text}</p>`}
  </form>`;
}

function Row({ userId, kind }) {
  const u = user(userId);
  const status = presence(userId);
  const remove = () => api.del(`/relationships/${userId}`).catch(report);
  const accept = () => api.put(`/relationships/${userId}`, { kind: 'friend' }).catch(report);
  const sub = { incoming: 'Sent you a friend request', outgoing: 'Request sent', blocked: 'Blocked' }[kind] ?? (u.custom_status || STATUS_LABELS[status]);
  return html`<li class="friend-row">
    <button class="friend-open" onClick=${() => kind !== 'blocked' && openDM(userId)}>
      <${Avatar} userId=${userId} size=${40} status />
      <span class="friend-text">
        <span class="friend-name">${u.display_name}</span>
        <span class="friend-sub">${sub}</span>
      </span>
    </button>
    ${kind === 'incoming' && html`<${IconButton} icon="check" label="Accept" onClick=${accept} />`}
    ${kind === 'friend' && html`<${IconButton} icon="send" label="Message" onClick=${() => openDM(userId)} />`}
    <${IconButton} icon="x" label=${kind === 'friend' ? 'Remove friend' : kind === 'blocked' ? 'Unblock' : 'Dismiss'} onClick=${remove} />
  </li>`;
}

export function Friends() {
  const [tab, setTab] = useState('online');
  const entries = [...S.relationships.entries()];
  const shown = entries.filter(([id, kind]) => {
    switch (tab) {
      case 'online': return kind === 'friend' && presence(id) !== 'offline';
      case 'all': return kind === 'friend';
      case 'pending': return kind === 'incoming' || kind === 'outgoing';
      default: return kind === 'blocked';
    }
  });
  const pendingCount = entries.filter(([, k]) => k === 'incoming').length;
  return html`<main class="friends">
    <header class="masthead">
      <${IconButton} class="drawer-toggle" icon="menu" label="Conversations" onClick=${() => { S.railOpen = !S.railOpen; update(); }} />
      <div class="masthead-title"><h1>Friends</h1></div>
      <nav class="tabs" aria-label="Friend lists">
        ${TABS.map(([key, label]) => html`<button key=${key} class=${classes('tab', tab === key && 'active')} onClick=${() => setTab(key)}>
          ${label}${key === 'pending' && pendingCount > 0 ? html` <span class="badge">${pendingCount}</span>` : null}
        </button>`)}
      </nav>
    </header>
    <div class="friends-body">
      <${AddFriend} />
      ${shown.length > 0
        ? html`<ul class="friend-list">${shown.map(([id, kind]) => html`<${Row} key=${id} userId=${id} kind=${kind} />`)}</ul>`
        : html`<${Empty} title="Nobody here yet">${S.servers.size === 0
          ? 'Create a server or accept an invite to start talking.'
          : 'Friends you add will appear here.'}<//>`}
    </div>
  </main>`;
}
