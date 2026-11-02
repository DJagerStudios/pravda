// Message formatting. Text becomes virtual nodes, never an HTML string, so
// nothing a user writes can become markup: the UI library escapes every text
// node and link targets are limited to http and https.

import { html } from './lib.js';
import {
  S, channel, displayName, roleColor,
} from './state.js';
import { nameColor } from './lib.js';
import { openChannel } from './router.js';

const SAFE_URL = /^https?:\/\/[^\s<]+$/i;

// Inline rules, tried in order at each position.
const INLINE = [
  { name: 'code', re: /^`([^`\n]+)`/ },
  { name: 'spoiler', re: /^\|\|([\s\S]+?)\|\|/ },
  { name: 'bold', re: /^\*\*([\s\S]+?)\*\*/ },
  { name: 'underline', re: /^__([\s\S]+?)__/ },
  { name: 'strike', re: /^~~([\s\S]+?)~~/ },
  { name: 'italic', re: /^\*([^*\s](?:[^*]*[^*\s])?)\*/ },
  { name: 'italic', re: /^_([^_\s](?:[^_]*[^_\s])?)_(?![a-z0-9])/i },
  { name: 'user', re: /^<@(\d+)>/ },
  { name: 'role', re: /^<@&(\d+)>/ },
  { name: 'channel', re: /^<#(\d+)>/ },
  { name: 'everyone', re: /^@everyone\b/ },
  { name: 'link', re: /^https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/i },
];

const SPECIAL = /[\\`|*_~<@h]/g;

function Spoiler({ children }) {
  return html`<span class="spoiler" tabindex="0" onClick=${(e) => e.currentTarget.classList.add('revealed')}>${children}</span>`;
}

function renderMatch(rule, match, ctx) {
  const inner = () => parseInline(match[1], ctx);
  switch (rule.name) {
    case 'code': return html`<code>${match[1]}</code>`;
    case 'spoiler': return html`<${Spoiler}>${inner()}<//>`;
    case 'bold': return html`<strong>${inner()}</strong>`;
    case 'italic': return html`<em>${inner()}</em>`;
    case 'underline': return html`<u>${inner()}</u>`;
    case 'strike': return html`<s>${inner()}</s>`;
    case 'user': {
      const color = nameColor(roleColor(ctx.serverId, match[1]));
      return html`<button class="mention" style=${color ? { color } : null}
        onClick=${(e) => ctx.onUser?.(match[1], e)}>@${displayName(match[1], ctx.serverId)}</button>`;
    }
    case 'role': {
      const role = S.servers.get(ctx.serverId)?.roleIndex.get(match[1]);
      return html`<span class="mention">@${role?.name ?? 'deleted role'}</span>`;
    }
    case 'channel': {
      const c = channel(match[1]);
      if (!c) return html`<span class="mention">#restricted</span>`;
      return html`<button class="mention" onClick=${() => openChannel(c)}>#${c.name}</button>`;
    }
    case 'everyone': return html`<span class="mention">${match[0]}</span>`;
    case 'link': {
      const url = match[0];
      if (!SAFE_URL.test(url)) return url;
      return html`<a href=${url} target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
    }
    default: return match[0];
  }
}

function parseInline(text, ctx) {
  const out = [];
  let plainFrom = 0;
  let i = 0;
  while (i < text.length) {
    SPECIAL.lastIndex = i;
    const next = SPECIAL.exec(text);
    if (!next) break;
    i = next.index;
    if (text[i] === '\\' && i + 1 < text.length && /[\\`|*_~<@]/.test(text[i + 1])) {
      // A backslash shows the next character literally.
      if (i > plainFrom) out.push(text.slice(plainFrom, i));
      plainFrom = i + 1;
      i += 2;
      continue;
    }
    const rest = text.slice(i);
    let matched = false;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m) {
        if (i > plainFrom) out.push(text.slice(plainFrom, i));
        out.push(renderMatch(rule, m, ctx));
        i += m[0].length;
        plainFrom = i;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  if (plainFrom < text.length) out.push(text.slice(plainFrom));
  return out;
}

/** Renders message text into virtual nodes. */
export function renderMarkdown(text, ctx = {}) {
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body = [];
      const language = line.slice(3).trim();
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(html`<pre class="code-block" data-language=${language || null}><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    if (line.startsWith('> ')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        body.push(lines[i].slice(2));
        i += 1;
      }
      blocks.push(html`<blockquote>${renderMarkdown(body.join('\n'), ctx)}</blockquote>`);
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      blocks.push(html`<div class="md-heading md-h${heading[1].length}">${parseInline(heading[2], ctx)}</div>`);
      i += 1;
      continue;
    }
    const paragraph = [];
    while (i < lines.length && !lines[i].startsWith('```') && !lines[i].startsWith('> ') && !/^#{1,3} /.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(html`<div class="md-line">${parseInline(paragraph.join('\n'), ctx)}</div>`);
  }
  return blocks;
}
