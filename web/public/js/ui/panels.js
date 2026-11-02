// Side panels for pinned messages and search.

import { html, formatStamp, idTime, useEffect, useRef, useState } from '../lib.js';
import { S, displayName, update } from '../state.js';
import { api } from '../api.js';
import { jumpToMessage, report, searchArchive } from '../actions.js';
import { decryptMessage } from '../keys.js';
import { renderMarkdown } from '../markdown.js';
import { Empty, IconButton } from './common.js';

function Result({ m, c }) {
  const serverId = c.server_id === '0' ? null : c.server_id;
  return html`<button class="result" onClick=${() => jumpToMessage(c.id, m.id)}>
    <span class="result-head"><strong>${displayName(m.author_id, serverId)}</strong><time>${formatStamp(idTime(m.id))}</time></span>
    <span class="result-text">${m.body?.t ? renderMarkdown(m.body.t, { serverId }) : m.sealed ? 'Encrypted message' : 'Attachment'}</span>
  </button>`;
}

function Pins({ c }) {
  const [pins, setPins] = useState(null);
  useEffect(() => {
    api.get(`/channels/${c.id}/pins`)
      .then(async (list) => {
        for (const m of list) await decryptMessage(m);
        setPins(list);
      })
      .catch(report);
  }, [c.id]);
  if (!pins) return html`<p class="panel-note">Fetching the board…</p>`;
  if (pins.length === 0) return html`<${Empty} title="No pinned messages">Pinned messages will appear here.<//>`;
  return pins.map((m) => html`<${Result} key=${m.id} m=${m} c=${c} />`);
}

function Search({ c }) {
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults(await searchArchive(c.id, query));
    } catch (err) {
      report(err);
    }
    setBusy(false);
  };
  return html`<form class="panel-search" onSubmit=${submit}>
    <input ref=${input} type="search" placeholder="Search this channel" aria-label="Search this channel" value=${query}
      onInput=${(e) => setQuery(e.currentTarget.value)} />
    <p class="panel-note">Searching happens on your device: the server cannot read your messages, so it cannot search them.</p>
  </form>
  ${busy && html`<p class="panel-note" role="status">Searching…</p>`}
  ${results && results.length === 0 && html`<p class="panel-note" role="status">No messages match.</p>`}
  ${results?.map((m) => html`<${Result} key=${m.id} m=${m} c=${S.channels.get(m.channel_id) ?? c} />`)}`;
}

export function SidePanel({ c }) {
  const title = S.panel === 'pins' ? 'Pinned messages' : 'Search';
  return html`<aside class="side-panel" aria-label=${title}>
    <header class="panel-head">
      <h3>${title}</h3>
      <${IconButton} icon="x" size=${16} label="Close" onClick=${() => { S.panel = null; update(); }} />
    </header>
    <div class="panel-body">
      ${S.panel === 'pins' ? html`<${Pins} key=${c.id} c=${c} />` : html`<${Search} key=${c.id} c=${c} />`}
    </div>
  </aside>`;
}
