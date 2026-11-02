// The message column: a masthead, dated rules between days, and messages
// grouped by author. Everything shown here was decrypted on this device.
//
// Keyboard: once a message has focus, the arrow keys move between messages,
// Home and End jump to the ends, Tab reaches that message's actions, and
// Escape goes back to the message box.

import {
  html, classes, compareIds, nameColor, formatBytes, formatDate, formatStamp, formatTime, idTime,
  useEffect, useLayoutEffect, useRef, useState,
} from '../lib.js';
import {
  S, P, has, displayName, isBlocked, isUnread, openModal, roleColor, toast, update, dmTitle, channel,
} from '../state.js';
import { api } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import {
  attachmentUrl, editMessage, jumpToMessage, loadLatest, loadOlder, markRead, reactionGroups, report, returnToPresent,
  toggleReaction,
} from '../actions.js';
import { Icon } from '../icons.js';
import { Avatar, IconButton, openPopover, SrOnly } from './common.js';
import { joinVoice } from '../voice.js';

const GROUP_WINDOW_MS = 7 * 60 * 1000;
const TTL_LABELS = { 300: '5 minutes', 3600: '1 hour', 21600: '6 hours', 86400: '1 day', 604800: '7 days', 2592000: '30 days' };
export const ttlLabel = (s) => TTL_LABELS[s] ?? `${s} seconds`;

const startOfDay = (ms) => new Date(ms).toDateString();

function shouldGroup(previous, m) {
  if (!previous || previous.kind !== 'default' || m.kind !== 'default' || m.reply) return false;
  return previous.author_id === m.author_id && idTime(m.id) - idTime(previous.id) < GROUP_WINDOW_MS;
}

function openUser(userId, serverId, e) {
  openPopover('profile', e.currentTarget, { userId, serverId });
}

/** An attachment decrypted on demand. */
function Attachment({ a }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const isImage = a.type?.startsWith('image/');
  const isVideo = a.type === 'video/mp4' || a.type === 'video/webm';
  const isAudio = a.type?.startsWith('audio/');
  const inline = isImage || isVideo || isAudio;
  useEffect(() => {
    let live = true;
    if (inline) attachmentUrl(a).then((u) => live && setUrl(u)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [a.id]);
  const save = async () => {
    try {
      const u = await attachmentUrl(a);
      const link = document.createElement('a');
      link.href = u;
      link.download = a.name;
      link.click();
    } catch (err) {
      report(err);
    }
  };
  if (failed) return html`<div class="attachment-file failed"><${Icon} name="lock" size=${20} /><span>${a.name} could not be decrypted.</span></div>`;
  if (isImage) {
    const ratio = a.w && a.h ? { aspectRatio: `${a.w} / ${a.h}`, width: `${Math.min(a.w, 416)}px` } : null;
    return html`<button class="attachment-image" style=${ratio} onClick=${() => url && openModal('lightbox', { url, name: a.name })}>
      ${url ? html`<img src=${url} alt=${a.name} />` : html`<span class="attachment-loading">Decrypting…</span>`}
    </button>`;
  }
  if (isVideo) return url ? html`<video class="attachment-video" src=${url} controls preload="metadata"></video>` : html`<div class="attachment-file">Decrypting ${a.name}…</div>`;
  if (isAudio) {
    return html`<div class="attachment-file"><span class="attachment-name">${a.name}</span>
      ${url ? html`<audio src=${url} controls preload="none"></audio>` : 'Decrypting…'}</div>`;
  }
  return html`<button class="attachment-file" onClick=${save}>
    <${Icon} name="file" size=${28} />
    <span class="attachment-meta"><span class="attachment-name">${a.name}</span><span class="attachment-size">${formatBytes(a.size)}</span></span>
    <${Icon} name="download" size=${18} />
  </button>`;
}

function Reactions({ m, canReact }) {
  const groups = reactionGroups(m);
  if (!groups.length) return null;
  return html`<div class="reactions">
    ${groups.map((g) => html`<button key=${g.emoji} disabled=${!canReact}
      class=${classes('reaction', g.mine && 'mine')}
      title=${g.users.map((u) => displayName(u, m.server_id)).join(', ')}
      onClick=${() => toggleReaction(m, g.emoji)}><span>${g.emoji}</span> <span class="reaction-count">${g.users.length}</span></button>`)}
  </div>`;
}

function toolbarFor(m, perms, startEdit) {
  const mine = m.author_id === S.me.id;
  const readable = !!m.body;
  const del = () => openModal('confirm', {
    title: 'Delete this message?',
    body: 'It is deleted for everyone. This cannot be undone.',
    confirm: 'Delete',
    danger: true,
    onConfirm: () => api.del(`/channels/${m.channel_id}/messages/${m.id}`),
  });
  const pin = () => (m.pinned ? api.del : api.put)(`/channels/${m.channel_id}/pins/${m.id}`).catch(report);
  const where = channel(m.channel_id)?.server_id;
  const copy = () => navigator.clipboard.writeText(tokensToNames(m.body.t, where === '0' ? null : where).shown)
    .then(() => toast('Copied.'), () => toast('Copying is not allowed here.', 'error'));
  return html`<div class="message-tools" role="toolbar" aria-label="Message actions">
    ${readable && has(perms, P.REACT) && html`<${IconButton} icon="smile" size=${16} label="React"
      onClick=${(e) => openPopover('emoji', e.currentTarget, { onPick: (emoji) => toggleReaction(m, emoji) })} />`}
    ${has(perms, P.SEND) && html`<${IconButton} icon="reply" size=${16} label="Reply"
      onClick=${() => { S.replyTo = m; update(); document.querySelector('.composer textarea')?.focus(); }} />`}
    ${readable && m.body.t && html`<${IconButton} icon="copy" size=${16} label="Copy text" onClick=${copy} />`}
    ${mine && readable && html`<${IconButton} icon="edit" size=${16} label="Edit" onClick=${startEdit} />`}
    ${(has(perms, P.MANAGE_MESSAGES) || has(perms, P.PIN_ONLY)) && html`<${IconButton} icon="pin" size=${16}
      label=${m.pinned ? 'Unpin' : 'Pin'} active=${m.pinned} onClick=${pin} />`}
    ${(mine || has(perms, P.MANAGE_MESSAGES)) && html`<${IconButton} icon="trash" size=${16} label="Delete" danger onClick=${del} />`}
  </div>`;
}

/** Turns stored tokens back into names for editing, and back again on save. */
function tokensToNames(text, serverId) {
  const names = new Map();
  const shown = text
    .replace(/<@(\d+)>/g, (token, id) => {
      const name = `@${displayName(id, serverId)}`;
      names.set(name, { token, user: id });
      return name;
    })
    .replace(/<#(\d+)>/g, (token, id) => {
      const name = `#${channel(id)?.name ?? id}`;
      names.set(name, { token });
      return name;
    });
  return { shown, names };
}

function EditBox({ m, serverId }) {
  const { shown, names } = tokensToNames(m.body?.t ?? '', serverId);
  const ref = useRef(null);
  const [value, setValue] = useState(shown);
  const stop = () => { S.editing = null; update(); };
  const save = async () => {
    let text = value.trim();
    const users = [];
    for (const [name, entry] of names) {
      if (text.includes(name)) {
        text = text.split(name).join(entry.token);
        if (entry.user) users.push(entry.user);
      }
    }
    if (text === m.body?.t) {
      stop();
      return;
    }
    try {
      await editMessage(m, text, { users });
      stop();
    } catch (err) {
      report(err);
    }
  };
  // Focus before the next paint, so keys typed right after pressing Up land here.
  useLayoutEffect(() => {
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return html`<div class="edit-box">
    <textarea ref=${ref} rows=${Math.min(10, value.split('\n').length)} value=${value} maxlength="4000"
      onInput=${(e) => setValue(e.currentTarget.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); stop(); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      }}></textarea>
    <div class="edit-hint">Enter to save · Escape to cancel</div>
  </div>`;
}

const SEALED_TEXT = {
  missing: 'Encrypted. The key for this message has not reached you yet; someone who has it will share it when they are online.',
  unreadable: 'This message could not be decrypted.',
  forged: 'This message failed its signature check and is hidden. It may have been tampered with.',
};

function Message({ m, grouped, perms, serverId, entry }) {
  const ctx = { serverId, onUser: (id, e) => openUser(id, serverId, e) };
  const color = nameColor(roleColor(serverId, m.author_id));
  const tabIndex = entry ? 0 : -1;
  const mentioned = m.mention_everyone || (m.mentions ?? []).includes(S.me.id);
  const editing = S.editing === m.id;
  const time = idTime(m.id);

  if (m.kind === 'join' || m.kind === 'ttl') {
    const text = m.kind === 'join'
      ? 'joined the server.'
      : Number(m.content) > 0 ? `set messages to disappear after ${ttlLabel(Number(m.content))}.` : 'turned off disappearing messages.';
    return html`<article class="message system" id=${`m-${m.id}`} tabindex=${tabIndex}>
      <span class="system-mark"><${Icon} name=${m.kind === 'join' ? 'star' : 'timer'} size=${14} /></span>
      <span class="system-text"><button class="author-inline" onClick=${(e) => openUser(m.author_id, serverId, e)}>${displayName(m.author_id, serverId)}</button> ${text}</span>
      <time>${formatStamp(time)}</time>
    </article>`;
  }
  if (isBlocked(m.author_id)) {
    return html`<article class="message blocked" tabindex=${tabIndex}>A message from someone you blocked is hidden.</article>`;
  }
  const attachments = m.body?.a ?? [];
  return html`<article id=${`m-${m.id}`} tabindex=${tabIndex} class=${classes('message', grouped && 'grouped', mentioned && 'mentioned', S.highlight === m.id && 'highlight')}>
    ${m.reply && html`<button class="reply-line" onClick=${() => jumpToMessage(m.channel_id, m.reply_to)}>
      <${Icon} name="reply" size=${13} />
      <strong>${displayName(m.reply.author_id, serverId)}</strong>
      <span class="reply-text">${(m.reply.body?.t ?? (m.reply.sealed ? 'Encrypted message' : 'Attachment')).replace(/<[@#]&?\d+>/g, '@…').slice(0, 140)}</span>
    </button>`}
    <div class="message-row">
      <div class="message-gutter">
        ${grouped
          ? html`<time class="gutter-time">${formatTime(time)}</time>`
          : html`<button class="avatar-button" onClick=${(e) => openUser(m.author_id, serverId, e)} aria-label=${`Profile of ${displayName(m.author_id, serverId)}`}>
              <${Avatar} userId=${m.author_id} size=${42} />
            </button>`}
      </div>
      <div class="message-body">
        ${grouped && html`<${SrOnly}>${displayName(m.author_id, serverId)}, ${formatStamp(time)}<//>`}
        ${!grouped && html`<header class="message-head">
          <button class="author" style=${color ? { color } : null} onClick=${(e) => openUser(m.author_id, serverId, e)}>${displayName(m.author_id, serverId)}</button>
          <time>${formatStamp(time)}</time>
          ${m.pinned && html`<span class="pinned-tag" title="Pinned"><${Icon} name="pin" size=${12} /></span>`}
          ${m.expires_at && html`<span class="expiry-tag" title=${`Disappears ${formatStamp(m.expires_at)}`}><${Icon} name="timer" size=${12} /></span>`}
        </header>`}
        ${m.sealed && html`<div class=${classes('sealed-note', m.sealed === 'forged' && 'danger')}><${Icon} name="lock" size=${14} /><span>${SEALED_TEXT[m.sealed]}</span></div>`}
        ${editing
          ? html`<${EditBox} m=${m} serverId=${serverId} />`
          : m.body?.t && html`<div class="message-text">${renderMarkdown(m.body.t, ctx)}${m.edited_at ? html`<span class="edited"> (edited)</span>` : null}</div>`}
        ${attachments.map((a) => html`<${Attachment} key=${a.id} a=${a} />`)}
        <${Reactions} m=${m} canReact=${has(perms, P.REACT)} />
      </div>
    </div>
    ${!editing && toolbarFor(m, perms, () => { S.editing = m.id; update(); })}
  </article>`;
}

function PendingMessage({ p }) {
  return html`<article class=${classes('message pending', p.failed && 'failed')}>
    <div class="message-row"><div class="message-gutter"></div>
      <div class="message-body">
        <div class="message-text">${p.content}</div>
        ${p.failed && html`<button class="link" onClick=${p.retry}>Not delivered. Send again</button>`}
      </div>
    </div>
  </article>`;
}

function Beginning({ c }) {
  const isPrivate = c.server_id === '0';
  return html`<header class="channel-start">
    <div class="start-kicker">${isPrivate ? 'Direct message' : 'Welcome to'}</div>
    <h2>${isPrivate ? dmTitle(c) : `#${c.name}`}</h2>
    <p>${isPrivate ? 'This is the beginning of your conversation.' : c.topic || 'This is the start of the channel.'}</p>
    <p class="e2ee-note"><${Icon} name="lock" size=${14} /> Messages, files and reactions here are end-to-end encrypted. The server stores only ciphertext.</p>
  </header>`;
}

/** Arrow keys between messages; Escape back to the message box. */
function onListKey(e) {
  const here = e.target.closest?.('article.message');
  if (!here || e.target !== here) return;
  const all = [...e.currentTarget.querySelectorAll('article.message[tabindex]')];
  const at = all.indexOf(here);
  let next = null;
  if (e.key === 'ArrowUp') next = all[at - 1];
  else if (e.key === 'ArrowDown') next = all[at + 1];
  else if (e.key === 'Home') next = all[0];
  else if (e.key === 'End') next = all[all.length - 1];
  else if (e.key === 'Escape') {
    const box = document.getElementById('composer-input');
    if (box) {
      e.stopPropagation();
      box.focus();
    }
    return;
  }
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/** "New messages" banner: where unread starts, with a jump and mark-as-read. */
function UnreadBanner({ since, onJump, onDismiss }) {
  return html`<div class="unread-banner" role="status">
    <span>New messages since ${formatStamp(idTime(since))}</span>
    <button class="link" onClick=${onJump}><${Icon} name="arrowDown" size=${14} /> Jump</button>
    <button class="link" onClick=${onDismiss}>Mark as read</button>
  </div>`;
}

export function MessageList({ c }) {
  const scroller = useRef(null);
  const stick = useRef(true);
  const prior = useRef(null);
  const divider = useRef(null);
  const room = S.messages.get(c.id);
  const perms = c.perms;
  const serverId = c.server_id === '0' ? null : c.server_id;
  // Where unread began when this channel was opened. It stays put while the
  // channel is open, like a bookmark, even after the messages are read.
  const [unreadSince] = useState(() => (isUnread(c) ? S.reads.get(c.id)?.last_read_id ?? '0' : null));
  const [dividerAbove, setDividerAbove] = useState(false);
  const [bannerGone, setBannerGone] = useState(false);

  useEffect(() => {
    stick.current = true;
    loadLatest(c.id);
  }, [c.id]);

  const firstId = room?.list[0]?.id;
  const lastId = room?.list[room.list.length - 1]?.id;

  // Hold the reader's place: follow the newest message when at the bottom,
  // and keep older pages from shoving the view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const old = prior.current;
    if (old && old.channel === c.id && old.firstId !== firstId && old.lastId === lastId) {
      el.scrollTop += el.scrollHeight - old.height;
    } else if (S.highlight) {
      document.getElementById(`m-${S.highlight}`)?.scrollIntoView({ block: 'center' });
      stick.current = false;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prior.current = { channel: c.id, firstId, lastId, height: el.scrollHeight };
  });

  // Images finish decrypting after layout; stay at the bottom while they do.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !globalThis.ResizeObserver) return undefined;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el.firstElementChild ?? el);
    return () => observer.disconnect();
  }, [c.id]);

  const atBottom = () => {
    const el = scroller.current;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const tryMarkRead = () => {
    if (room?.loaded && !room.newer && stick.current && document.hasFocus()) markRead(c);
  };
  useEffect(tryMarkRead);
  useEffect(() => {
    addEventListener('focus', tryMarkRead);
    return () => removeEventListener('focus', tryMarkRead);
  });

  const onScroll = () => {
    const el = scroller.current;
    stick.current = atBottom();
    if (el.scrollTop < 400) loadOlder(c.id);
    tryMarkRead();
  };

  const list = room?.list ?? [];
  const firstUnread = unreadSince !== null ? list.find((m) => compareIds(m.id, unreadSince) > 0 && m.author_id !== S.me.id) : null;

  // Show the banner while the "New messages" rule is above the visible area.
  useEffect(() => {
    const el = divider.current;
    if (!el || !globalThis.IntersectionObserver) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      setDividerAbove(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root: scroller.current });
    observer.observe(el);
    return () => observer.disconnect();
  }, [firstUnread?.id]);

  const rows = [];
  let previous = null;
  for (const m of list) {
    const time = idTime(m.id);
    const newDay = !previous || startOfDay(idTime(previous.id)) !== startOfDay(time);
    if (newDay) rows.push(html`<div class="day-rule" key=${`day-${m.id}`}><span>${formatDate(time)}</span></div>`);
    if (m === firstUnread) {
      rows.push(html`<div class="new-rule" key="new-rule" ref=${divider} role="separator" aria-label="New messages"><span aria-hidden="true">New</span></div>`);
    }
    const grouped = !newDay && m !== firstUnread && shouldGroup(previous, m);
    rows.push(html`<${Message} key=${m.id} m=${m} grouped=${grouped} perms=${perms} serverId=${serverId} entry=${m === list[list.length - 1]} />`);
    previous = m;
  }

  return html`<div class="message-area">
    ${firstUnread && dividerAbove && !bannerGone && html`<${UnreadBanner} since=${unreadSince}
      onJump=${() => divider.current?.scrollIntoView({ block: 'start' })}
      onDismiss=${() => { setBannerGone(true); markRead(c); }} />`}
    <div class="message-scroll" id="messages" tabindex="-1" ref=${scroller} onScroll=${onScroll} role="log" aria-label="Messages">
      <div class="message-stack" onKeyDown=${onListKey}>
        ${room?.loaded && !room.older && html`<${Beginning} c=${c} />`}
        ${room?.loading && list.length > 0 && html`<div class="loading-older">Loading older messages…</div>`}
        ${rows}
        ${room?.pending.map((p) => html`<${PendingMessage} key=${p.nonce} p=${p} />`)}
      </div>
    </div>
    ${room?.newer && html`<button class="return-present" onClick=${() => returnToPresent(c.id)}>Jump to the latest messages</button>`}
  </div>`;
}

export function Masthead({ c }) {
  const isPrivate = c.server_id === '0';
  return html`<header class="masthead">
    <${IconButton} class="drawer-toggle" icon="menu" label="Channels" onClick=${() => { S.railOpen = !S.railOpen; update(); }} />
    <div class="masthead-title">
      <h1><span class="masthead-glyph">${isPrivate ? '' : '#'}</span>${isPrivate ? dmTitle(c) : c.name}</h1>
      <p class="masthead-topic">
        <span class="e2ee-badge" title="End-to-end encrypted"><${Icon} name="lock" size=${12} /> Encrypted</span>
        ${c.ttl_seconds > 0 && html`<span class="ttl-badge"><${Icon} name="timer" size=${12} /> Disappears after ${ttlLabel(c.ttl_seconds)}</span>`}
        ${c.topic && html`<span class="topic-text">${c.topic}</span>`}
      </p>
    </div>
    <div class="masthead-tools">
      ${isPrivate && html`<${IconButton} icon="phone" label="Start an encrypted call" active=${S.call?.channelId === c.id} onClick=${() => joinVoice(c.id)} />`}
      ${isPrivate && html`<${IconButton} icon="timer" label="Disappearing messages" active=${c.ttl_seconds > 0} onClick=${() => openModal('ttl', { channelId: c.id })} />`}
      <${IconButton} icon="pin" label="Pinned messages" active=${S.panel === 'pins'} onClick=${() => { S.panel = S.panel === 'pins' ? null : 'pins'; update(); }} />
      <${IconButton} icon="search" label="Search" active=${S.panel === 'search'} onClick=${() => { S.panel = S.panel === 'search' ? null : 'search'; update(); }} />
      ${!isPrivate && html`<${IconButton} icon="users" label="Member list" active=${S.settings.showMembers}
        onClick=${() => { S.settings.showMembers = !S.settings.showMembers; update(); }} />`}
    </div>
  </header>`;
}
