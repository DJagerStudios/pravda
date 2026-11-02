// The quick switcher (Ctrl+K): type a few letters of a channel, server,
// conversation or friend and press Enter to go there. Prefixes narrow the
// search: # channels, @ people, * servers.

import { html, classes, useMemo, useState } from '../lib.js';
import {
  S, channelTree, closeModal, dmTitle, isMuted, isUnread, mentionCount, relationship, user,
} from '../state.js';
import { navigate, openChannel } from '../router.js';
import { openDM } from '../actions.js';
import { joinVoice } from '../voice.js';
import { Icon } from '../icons.js';
import { Avatar, Modal } from './common.js';
import { ServerEmblem } from './rail.js';

function gather() {
  const items = [];
  for (const srv of S.servers.values()) {
    items.push({ kind: 'server', id: srv.id, label: srv.name, sub: 'Server', srv, go: () => navigate(`/channels/${srv.id}`) });
    const { loose, groups } = channelTree(srv);
    for (const c of [...loose, ...groups.flatMap((g) => g.channels)]) {
      items.push({
        kind: 'channel',
        id: c.id,
        label: c.name,
        sub: srv.name,
        voice: c.kind === 'voice',
        unread: c.kind === 'text' && isUnread(c) && !isMuted(c),
        mentions: mentionCount(c.id),
        go: () => {
          openChannel(c);
          if (c.kind === 'voice') joinVoice(c.id);
        },
      });
    }
  }
  const withDM = new Set();
  for (const c of S.dms) {
    const partner = (c.recipients ?? []).find((id) => id !== S.me.id);
    if (c.kind === 'dm' && partner) withDM.add(partner);
    items.push({
      kind: 'dm',
      id: c.id,
      label: dmTitle(c),
      sub: c.kind === 'dm' ? 'Direct message' : 'Group conversation',
      userId: c.kind === 'dm' ? partner : null,
      unread: isUnread(c),
      mentions: mentionCount(c.id),
      go: () => navigate(`/channels/@me/${c.id}`),
    });
  }
  for (const [id] of S.relationships) {
    if (relationship(id) !== 'friend' || withDM.has(id)) continue;
    const u = user(id);
    items.push({ kind: 'person', id, label: u.display_name, sub: `@${u.username}`, userId: id, go: () => openDM(id) });
  }
  return items;
}

/** How well `query` matches `text`: whole prefix, word start, then letters in order. */
function score(text, query) {
  const t = text.toLowerCase();
  if (!query) return 1;
  if (t.startsWith(query)) return 100 - t.length / 100;
  if (t.split(/[\s\-_.·]+/).some((w) => w.startsWith(query))) return 60;
  const at = t.indexOf(query);
  if (at >= 0) return 40 - at / 100;
  let i = 0;
  let gaps = 0;
  for (const ch of t) {
    if (ch === query[i]) i += 1;
    else if (i > 0) gaps += 1;
    if (i === query.length) return 20 - gaps / 10;
  }
  return 0;
}

const KINDS = { '#': ['channel'], '@': ['dm', 'person'], '*': ['server'] };

function rank(items, raw) {
  let query = raw.trim().toLowerCase();
  let kinds = null;
  if (KINDS[query[0]]) {
    kinds = KINDS[query[0]];
    query = query.slice(1).trim();
  }
  const pool = kinds ? items.filter((i) => kinds.includes(i.kind)) : items;
  return pool
    .map((item) => {
      let s = score(item.label, query);
      if (s > 0) s += item.mentions ? 6 : item.unread ? 3 : 0;
      return { item, s };
    })
    .filter((x) => x.s > 0 && (query || x.item.unread || x.item.mentions || x.item.kind === 'dm'))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.item);
}

function ItemIcon({ item }) {
  if (item.kind === 'server') return html`<${ServerEmblem} srv=${item.srv} size=${28} />`;
  if (item.userId) return html`<${Avatar} userId=${item.userId} size=${28} />`;
  if (item.kind === 'channel') {
    return html`<span class="switcher-glyph">${item.voice ? html`<${Icon} name="speaker" size=${16} />` : '#'}</span>`;
  }
  return html`<span class="switcher-glyph"><${Icon} name="users" size=${16} /></span>`;
}

export function QuickSwitcher() {
  const items = useMemo(gather, []);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = rank(items, query);
  const chosen = Math.min(active, Math.max(0, results.length - 1));
  const open = (item) => {
    closeModal();
    item.go();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setActive((chosen + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (e.key === 'Enter' && results[chosen]) {
      e.preventDefault();
      open(results[chosen]);
    }
  };
  return html`<${Modal} title="Quick switcher" size="small">
    <input class="wide switcher-input" data-autofocus role="combobox" aria-expanded="true" aria-controls="switcher-list"
      aria-activedescendant=${results[chosen] ? `switcher-${results[chosen].kind}-${results[chosen].id}` : null}
      aria-label="Where to?" placeholder="Where to?" value=${query} autocomplete="off" spellcheck="false"
      onInput=${(e) => { setQuery(e.currentTarget.value); setActive(0); }} onKeyDown=${onKey} />
    <ul class="switcher-list" id="switcher-list" role="listbox" aria-label="Places">
      ${results.map((item, i) => html`<li key=${`${item.kind}-${item.id}`} id=${`switcher-${item.kind}-${item.id}`} role="option"
        aria-selected=${i === chosen} class=${classes('switcher-item', i === chosen && 'active', item.unread && 'unread')}
        onMouseMove=${() => i !== chosen && setActive(i)} onClick=${() => open(item)}>
        <${ItemIcon} item=${item} />
        <span class="switcher-label">${item.label}</span>
        <span class="switcher-sub">${item.sub}</span>
        ${item.mentions > 0 && html`<span class="badge"><span aria-hidden="true">${item.mentions}</span><span class="sr-only">${item.mentions} mentions</span></span>`}
      </li>`)}
      ${results.length === 0 && html`<li class="switcher-empty" role="option" aria-selected="false">${query ? 'Nothing matches.' : 'Nothing new. Type to search.'}</li>`}
    </ul>
    <p class="switcher-hint">Start with <kbd>#</kbd> for channels, <kbd>@</kbd> for people or <kbd>*</kbd> for servers. <kbd>↑</kbd> <kbd>↓</kbd> to choose, <kbd>Enter</kbd> to go.</p>
  <//>`;
}
