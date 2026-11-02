// The emoji palette and the composer's autocomplete list.

import { html, classes, useMemo, useState } from '../lib.js';
import { closePopover } from './common.js';

const GROUPS = [
  ['Salutes', ['👍', '👎', '✊', '🫡', '👏', '🙌', '🤝', '💪', '🫶', '🙏', '👀', '🤔']],
  ['Faces', ['😀', '😂', '🤣', '😅', '😊', '😍', '😎', '🥲', '😭', '😡', '🤯', '😱', '🥳', '😴', '🤡', '💀']],
  ['Symbols', ['⭐', '🌟', '🔥', '❤️', '💔', '✅', '❌', '⚠️', '💯', '🎉', '🚩', '🏴', '📣', '📢', '🔔', '💡']],
  ['Works', ['🔨', '⚒️', '🛠️', '🌾', '🏭', '🚜', '🚀', '🛰️', '📻', '📰', '📜', '✏️', '🎵', '🎮', '☕', '🍺']],
];

export function EmojiPicker({ onPick }) {
  const [query, setQuery] = useState('');
  const pick = (emoji) => {
    closePopover();
    onPick(emoji);
  };
  const custom = query.trim();
  return html`<div class="emoji-picker">
    <input class="emoji-input" placeholder="Or paste any emoji" maxlength="16" value=${query}
      onInput=${(e) => setQuery(e.currentTarget.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && custom) pick(custom); }} />
    ${GROUPS.map(([title, list]) => html`<section key=${title}>
      <h4>${title}</h4>
      <div class="emoji-grid">
        ${list.map((emoji) => html`<button key=${emoji} class="emoji" onClick=${() => pick(emoji)}>${emoji}</button>`)}
      </div>
    </section>`)}
  </div>`;
}

export function Suggestions({ items, index, onPick }) {
  return useMemo(() => html`<ul class="suggestions" role="listbox">
    ${items.map((item, i) => html`<li key=${item.key}>
      <button role="option" aria-selected=${i === index} class=${classes('suggestion', i === index && 'active')}
        onMouseDown=${(e) => { e.preventDefault(); onPick(item); }}>
        ${item.icon}<span class="suggestion-label">${item.label}</span>
        ${item.hint && html`<span class="suggestion-hint">${item.hint}</span>`}
      </button>
    </li>`)}
  </ul>`, [items, index]);
}
