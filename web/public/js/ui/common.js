// Small pieces shared across the interface.

import {
  html, useEffect, useRef, avatarColor, classes, initials,
} from '../lib.js';
import { S, closeModal, presence, user, update } from '../state.js';
import { mediaUrl } from '../api.js';
import { Icon } from '../icons.js';

export const STATUS_LABELS = {
  online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible',
};

export function Avatar({ userId, size = 40, status = false, name }) {
  const u = userId ? user(userId) : null;
  const label = name ?? u?.display_name ?? '?';
  return html`<span class="avatar" style=${{ width: `${size}px`, height: `${size}px`, '--avatar-size': `${size}px` }}>
    ${u?.avatar
      ? html`<img src=${mediaUrl(u.avatar)} alt="" loading="lazy" />`
      : html`<span class="avatar-letters" style=${{ background: avatarColor(userId ?? '0'), fontSize: `${Math.round(size * 0.4)}px` }}>${initials(label)}</span>`}
    ${status && html`<${StatusDot} status=${presence(userId)} />`}
  </span>`;
}

export function StatusDot({ status }) {
  return html`<span class=${`status-dot status-${status}`} role="img" aria-label=${STATUS_LABELS[status]} title=${STATUS_LABELS[status]}></span>`;
}

export function IconButton({
  icon, label, onClick, active, danger, size = 20, disabled, class: className,
}) {
  return html`<button class=${classes('icon-button', active && 'active', danger && 'danger', className)}
    title=${label} aria-label=${label} aria-pressed=${active === undefined ? null : active} disabled=${disabled} onClick=${onClick}>
    <${Icon} name=${icon} size=${size} />
  </button>`;
}

export function Button({
  children, kind = 'plain', onClick, disabled, type = 'button', class: className, title,
}) {
  return html`<button type=${type} class=${classes('button', `button-${kind}`, className)} disabled=${disabled} title=${title} onClick=${onClick}>${children}</button>`;
}

export function Field({ label, hint, error, children }) {
  return html`<label class="field">
    <span class="field-label">${label}</span>
    ${children}
    ${error ? html`<span class="field-error">${error}</span>` : hint && html`<span class="field-hint">${hint}</span>`}
  </label>`;
}

export function Toggle({ label, hint, checked, onChange, disabled }) {
  return html`<label class=${classes('toggle', disabled && 'disabled')}>
    <span class="toggle-text">
      <span class="toggle-label">${label}</span>
      ${hint && html`<span class="field-hint">${hint}</span>`}
    </span>
    <input type="checkbox" checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="toggle-track" aria-hidden="true"></span>
  </label>`;
}

/** Keeps keyboard focus inside a dialog and closes it on Escape. */
function useDialog(ref, onClose) {
  useEffect(() => {
    const previous = document.activeElement;
    const box = ref.current;
    const focusable = () => box.querySelectorAll('button, input, select, textarea, a[href]');
    (box.querySelector('[data-autofocus]') ?? focusable()[0])?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const items = [...focusable()].filter((el) => !el.disabled);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);
}

export function Modal({
  title, kicker, children, onClose = closeModal, size = 'medium', footer,
}) {
  const ref = useRef(null);
  useDialog(ref, onClose);
  return html`<div class="modal-backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class=${`modal modal-${size}`} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <header class="modal-head">
        <div>
          ${kicker && html`<div class="modal-kicker">${kicker}</div>`}
          <h2>${title}</h2>
        </div>
        <${IconButton} icon="x" label="Close" onClick=${onClose} />
      </header>
      <div class="modal-body">${children}</div>
      ${footer && html`<footer class="modal-foot">${footer}</footer>`}
    </div>
  </div>`;
}

export function openPopover(kind, anchor, props = {}) {
  const rect = anchor.getBoundingClientRect();
  S.popover = { kind, props, rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom } };
  update();
}

export function closePopover() {
  if (S.popover) {
    S.popover = null;
    update();
  }
}

/** A floating card placed beside the thing that opened it, kept on screen. */
export function Popover({ children, rect, width = 300 }) {
  const ref = useRef(null);
  useEffect(() => {
    // Keyboard focus goes back to whatever opened the card when it closes.
    const opener = document.activeElement;
    const el = ref.current;
    const box = el.getBoundingClientRect();
    let left = rect.right + 8;
    if (left + box.width > innerWidth - 8) left = rect.left - box.width - 8;
    left = Math.max(8, Math.min(left, innerWidth - box.width - 8));
    const top = Math.max(8, Math.min(rect.top, innerHeight - box.height - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
    const away = (e) => { if (!el.contains(e.target)) closePopover(); };
    const key = (e) => { if (e.key === 'Escape') closePopover(); };
    // A later tick, so the click that opened this does not also close it.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', away);
      document.addEventListener('keydown', key);
    });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
      if (opener?.isConnected && !document.querySelector('.modal')) opener.focus?.();
    };
  }, []);
  return html`<div class="popover" ref=${ref} style=${{ width: `${width}px`, visibility: 'hidden' }}>${children}</div>`;
}

/**
 * A menu of actions. Items are { label, icon, onClick, danger, disabled },
 * { heading } for a small group title, `checked` for one of a set of
 * choices, or '-' for a rule. Arrow keys move between items.
 */
export function Menu({ items }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('.menu-item:not(:disabled)')?.focus();
  }, []);
  const onKey = (e) => {
    const all = [...ref.current.querySelectorAll('.menu-item:not(:disabled)')];
    const at = all.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = all[(at + 1) % all.length];
    else if (e.key === 'ArrowUp') next = all[(at - 1 + all.length) % all.length];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return html`<div class="menu" role="menu" ref=${ref} onKeyDown=${onKey}>
    ${items.filter(Boolean).map((item) => {
      if (item === '-') return html`<div class="menu-rule" role="separator"></div>`;
      if (item.heading) return html`<div class="menu-heading" role="presentation">${item.heading}</div>`;
      const choice = item.checked !== undefined;
      return html`<button role=${choice ? 'menuitemradio' : 'menuitem'} aria-checked=${choice ? item.checked : null}
          class=${classes('menu-item', item.danger && 'danger', choice && 'menu-choice')} disabled=${item.disabled}
          onClick=${() => { closePopover(); item.onClick(); }}>
          ${choice
            ? html`<span class="menu-check" aria-hidden="true">${item.checked && html`<${Icon} name="check" size=${14} />`}</span>`
            : item.icon && html`<${Icon} name=${item.icon} size=${16} />`}
          <span>${item.label}</span>
        </button>`;
    })}
  </div>`;
}

/** Opens a menu where the pointer is, for right-clicks. */
export function openContextMenu(e, items) {
  e.preventDefault();
  S.popover = {
    kind: 'menu',
    props: { items },
    rect: { top: e.clientY, left: e.clientX, right: e.clientX, bottom: e.clientY },
  };
  update();
}

/** Text only screen readers hear. */
export const SrOnly = ({ children }) => html`<span class="sr-only">${children}</span>`;

export function Empty({ title, children }) {
  return html`<div class="empty-state"><div class="empty-star"><${Icon} name="star" size=${44} /></div>
    <h3>${title}</h3><p>${children}</p></div>`;
}
