// Writing a message. Mentions are typed as readable names and swapped for
// their machine form only when sending, so the text box never shows raw IDs.

import {
  html, classes, formatBytes, useEffect, useRef, useState,
} from '../lib.js';
import {
  S, P, has, displayName, dmTitle, toast, typingUsers, update, user,
} from '../state.js';
import { report, sendMessage, sendTyping, uploadEncrypted } from '../actions.js';
import { Icon } from '../icons.js';
import { Avatar, IconButton, openPopover } from './common.js';
import { Suggestions } from './pickers.js';

const MAX_RESULTS = 8;
const drafts = new Map();

function memberIds(c) {
  if (c.server_id === '0') return c.recipients ?? [];
  return S.servers.get(c.server_id)?.members.map((m) => m.user_id) ?? [];
}

function buildSuggestions(c, trigger, query) {
  const q = query.toLowerCase();
  if (trigger === '@') {
    const people = memberIds(c)
      .map((id) => ({ id, name: displayName(id, c.server_id === '0' ? null : c.server_id), username: user(id).username }))
      .filter((p) => p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS)
      .map((p) => ({
        key: p.id,
        label: p.name,
        hint: `@${p.username}`,
        icon: html`<${Avatar} userId=${p.id} size=${24} />`,
        insert: `@${p.name}`,
        token: `<@${p.id}>`,
      }));
    const srv = S.servers.get(c.server_id);
    const roles = (srv?.roles ?? [])
      .filter((r) => r.id !== srv.id && r.mentionable && r.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((r) => ({
        key: r.id, label: r.name, hint: 'role', icon: html`<${Icon} name="shield" size=${20} />`, insert: `@${r.name}`, token: `<@&${r.id}>`,
      }));
    const everyone = srv && has(c.perms, P.MENTION_EVERYONE) && 'everyone'.startsWith(q)
      ? [{ key: 'all', label: 'everyone', hint: 'notify everyone here', icon: html`<${Icon} name="megaphone" size=${20} />`, insert: '@everyone', token: '@everyone' }]
      : [];
    return [...everyone, ...people, ...roles].slice(0, MAX_RESULTS);
  }
  const srv = S.servers.get(c.server_id);
  return (srv?.channels ?? [])
    .filter((x) => x.kind === 'text' && x.name.includes(q))
    .slice(0, MAX_RESULTS)
    .map((x) => ({
      key: x.id, label: x.name, icon: html`<span class="channel-glyph">#</span>`, insert: `#${x.name}`, token: `<#${x.id}>`,
    }));
}

function TypingLine({ c }) {
  const ids = typingUsers(c.id);
  if (ids.length === 0) return html`<div class="typing-line"></div>`;
  const serverId = c.server_id === '0' ? null : c.server_id;
  const names = ids.slice(0, 3).map((id) => displayName(id, serverId));
  const text = ids.length > 3
    ? 'Several people are typing…'
    : `${names.join(', ')} ${ids.length === 1 ? 'is' : 'are'} typing…`;
  return html`<div class="typing-line" aria-live="polite"><span class="typing-dots"><i></i><i></i><i></i></span>${text}</div>`;
}

export function Composer({ c }) {
  const canSend = has(c.perms, P.SEND);
  const canAttach = has(c.perms, P.ATTACH);
  const box = useRef(null);
  const fileInput = useRef(null);
  const tokens = useRef(new Map());
  const [files, setFiles] = useState([]);
  const [suggest, setSuggest] = useState(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.value = drafts.get(c.id) ?? '';
    tokens.current = new Map();
    resize();
    setFiles([]);
    setSuggest(null);
    if (matchMedia('(pointer: fine)').matches) el.focus();
  }, [c.id]);

  function resize() {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
  }

  function refreshSuggestions() {
    const el = box.current;
    const before = el.value.slice(0, el.selectionStart);
    const match = /(?:^|\s)([@#])([^\s@#]*)$/.exec(before);
    if (!match) {
      setSuggest(null);
      return;
    }
    const trigger = match[1];
    const items = buildSuggestions(c, trigger, match[2]);
    setSuggest(items.length ? { items, index: 0, start: before.length - match[2].length - 1 } : null);
  }

  function applySuggestion(item) {
    const el = box.current;
    const after = el.value.slice(el.selectionStart);
    el.value = `${el.value.slice(0, suggest.start)}${item.insert} ${after}`;
    const caret = suggest.start + item.insert.length + 1;
    el.setSelectionRange(caret, caret);
    tokens.current.set(item.insert, item.token);
    setSuggest(null);
    drafts.set(c.id, el.value);
    el.focus();
    resize();
  }

  async function addFiles(list) {
    const max = S.instance?.max_upload_bytes ?? Infinity;
    for (const file of list) {
      if (file.size > max) {
        toast(`${file.name} is over the ${formatBytes(max)} limit.`, 'error');
        continue;
      }
      const entry = { key: `${file.name}-${Math.random()}`, name: file.name, size: file.size, progress: 0, done: null };
      setFiles((current) => [...current, entry]);
      try {
        // Encrypted here; the server receives only ciphertext.
        entry.done = await uploadEncrypted(file, (p) => {
          entry.progress = p;
          setFiles((current) => [...current]);
        });
        setFiles((current) => [...current]);
      } catch (err) {
        report(err);
        setFiles((current) => current.filter((f) => f !== entry));
      }
    }
  }

  async function send() {
    const el = box.current;
    let content = el.value.trim();
    if (files.some((f) => !f.done)) {
      toast('Wait for your files to finish uploading.');
      return;
    }
    if (!content && files.length === 0) return;
    // Longest names first, so "@Ann Lee" is not caught by "@Ann".
    const names = [...tokens.current].sort((a, b) => b[0].length - a[0].length);
    for (const [name, token] of names) content = content.split(name).join(token);
    // The server cannot read the text, so mentions are declared alongside it.
    const mentions = {
      users: [...new Set([...content.matchAll(/<@(\d+)>/g)].map((m) => m[1]))],
      roles: [...new Set([...content.matchAll(/<@&(\d+)>/g)].map((m) => m[1]))],
      everyone: /(^|\s)@everyone\b/.test(content),
    };
    const attachments = files.map((f) => f.done);
    const replyTo = S.replyTo?.id ?? null;
    el.value = '';
    drafts.delete(c.id);
    tokens.current = new Map();
    setFiles([]);
    setSuggest(null);
    S.replyTo = null;
    resize();
    update();
    await sendMessage(c.id, content, { replyTo, attachments, mentions });
  }

  function onKeyDown(e) {
    if (suggest) {
      const n = suggest.items.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggest({ ...suggest, index: (suggest.index + 1) % n });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggest({ ...suggest, index: (suggest.index + n - 1) % n });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggest.items[suggest.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSuggest(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && S.replyTo) {
      S.replyTo = null;
      update();
    } else if (e.key === 'ArrowUp' && !box.current.value) {
      const list = S.messages.get(c.id)?.list ?? [];
      const last = [...list].reverse().find((m) => m.author_id === S.me.id && m.kind === 'default' && m.body);
      if (last) {
        e.preventDefault();
        S.editing = last.id;
        update();
      }
    }
  }

  if (!canSend) {
    return html`<div class="composer-wrap"><div class="composer-locked">You do not have permission to send messages here.</div></div>`;
  }
  const serverId = c.server_id === '0' ? null : c.server_id;
  const placeholder = c.server_id === '0' ? `Message ${dmTitle(c)}` : `Message #${c.name}`;

  return html`<div class=${classes('composer-wrap', drag && 'dragging')}
    onDragOver=${(e) => { if (canAttach && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
    onDragLeave=${() => setDrag(false)}
    onDrop=${(e) => { e.preventDefault(); setDrag(false); if (canAttach) addFiles([...e.dataTransfer.files]); }}>
    ${suggest && html`<${Suggestions} items=${suggest.items} index=${suggest.index} onPick=${applySuggestion} />`}
    ${S.replyTo && html`<div class="reply-bar">
      <span>Replying to <strong>${displayName(S.replyTo.author_id, serverId)}</strong></span>
      <${IconButton} icon="x" size=${14} label="Cancel reply" onClick=${() => { S.replyTo = null; update(); }} />
    </div>`}
    ${files.length > 0 && html`<ul class="upload-list">
      ${files.map((f) => html`<li key=${f.key} class="upload-item">
        <${Icon} name="file" size=${18} />
        <span class="upload-name">${f.name}</span>
        <span class="upload-size">${f.done ? formatBytes(f.size) : `${Math.round(f.progress * 100)}%`}</span>
        <${IconButton} icon="x" size=${14} label="Remove file" onClick=${() => setFiles((current) => current.filter((x) => x !== f))} />
      </li>`)}
    </ul>`}
    <div class="composer">
      ${canAttach && html`<${IconButton} icon="clip" label="Attach files" onClick=${() => fileInput.current.click()} />`}
      <input ref=${fileInput} type="file" multiple hidden onChange=${(e) => { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; }} />
      <textarea ref=${box} id="composer-input" rows="1" maxlength="4000" placeholder=${placeholder} aria-label=${placeholder}
        onInput=${() => { drafts.set(c.id, box.current.value); resize(); refreshSuggestions(); if (box.current.value) sendTyping(c.id); }}
        onKeyDown=${onKeyDown}
        onKeyUp=${(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') refreshSuggestions(); }}
        onBlur=${() => setTimeout(() => setSuggest(null), 100)}
        onPaste=${(e) => { const pasted = [...(e.clipboardData?.files ?? [])]; if (pasted.length && canAttach) { e.preventDefault(); addFiles(pasted); } }}></textarea>
      <${IconButton} icon="smile" label="Emoji" onClick=${(e) => openPopover('emoji', e.currentTarget, {
        onPick: (emoji) => {
          const el = box.current;
          el.setRangeText(emoji, el.selectionStart, el.selectionEnd, 'end');
          drafts.set(c.id, el.value);
          el.focus();
        },
      })} />
      <${IconButton} icon="send" label="Send" onClick=${send} />
    </div>
    <${TypingLine} c=${c} />
  </div>`;
}
