// The keyboard shortcuts sheet (Ctrl+/).

import { html } from '../lib.js';
import { Modal } from './common.js';

const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
export const MOD = mac ? '⌘' : 'Ctrl';
const ALT = mac ? '⌥' : 'Alt';

const GROUPS = [
  ['Getting around', [
    [[MOD, 'K'], 'Quick switcher: jump to any channel, conversation or server'],
    [[ALT, '↑'], 'Previous channel'],
    [[ALT, '↓'], 'Next channel'],
    [[ALT, 'Shift', '↑'], 'Previous channel with something new'],
    [[ALT, 'Shift', '↓'], 'Next channel with something new'],
    [[MOD, 'F'], 'Search this channel'],
  ]],
  ['Messages', [
    [['Esc'], 'Mark this channel as read'],
    [['Shift', 'Esc'], 'Mark this server as read'],
    [['↑'], 'Edit your last message (in an empty message box)'],
    [['Enter'], 'Send'],
    [['Shift', 'Enter'], 'New line'],
    [['↑', '↓'], 'Move between messages, once one has focus'],
    [['Esc'], 'From a message, back to the message box'],
  ]],
  ['Calls', [
    [[MOD, 'Shift', 'M'], 'Mute or unmute'],
    [[MOD, 'Shift', 'D'], 'Deafen or undeafen'],
  ]],
  ['Pravda', [
    [[MOD, ','], 'Settings'],
    [[MOD, '/'], 'This list'],
  ]],
];

export function ShortcutsModal() {
  return html`<${Modal} title="Keyboard shortcuts" size="medium">
    <p class="settings-line">In the desktop app, mute and deafen work even while another application is in front.</p>
    ${GROUPS.map(([title, rows]) => html`<section class="shortcut-group" key=${title}>
      <h3>${title}</h3>
      <dl class="shortcut-list">
        ${rows.map(([keys, what]) => html`<div class="shortcut-row" key=${what}>
          <dt>${keys.map((k, i) => html`${i > 0 && html`<span class="kbd-plus" aria-hidden="true">+</span>`}<kbd>${k}</kbd>`)}</dt>
          <dd>${what}</dd>
        </div>`)}
      </dl>
    </section>`)}
  <//>`;
}
