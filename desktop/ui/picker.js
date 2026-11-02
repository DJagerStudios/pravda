// The screen picker: lists the screens and windows the shell found and
// reports the one the user picks. Enter shares, Escape cancels, a double
// click shares at once.

'use strict';

const list = document.querySelector('.sources');
const empty = document.querySelector('.empty');
const shareButton = document.getElementById('share');
const tabs = [...document.querySelectorAll('.tabs button')];
let sources = [];
let kind = 'screen';
let chosen = null;

function select(id) {
  chosen = id;
  for (const el of list.querySelectorAll('.source')) el.setAttribute('aria-selected', String(el.dataset.id === id));
  shareButton.disabled = !chosen;
}

function card(source) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source';
  button.setAttribute('role', 'option');
  button.setAttribute('aria-selected', 'false');
  button.dataset.id = source.id;
  const shot = document.createElement('span');
  shot.className = 'source-shot';
  if (source.thumbnail) {
    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = '';
    shot.append(img);
  }
  const name = document.createElement('span');
  name.className = 'source-name';
  if (source.icon) {
    const icon = document.createElement('img');
    icon.src = source.icon;
    icon.alt = '';
    name.append(icon);
  }
  const label = document.createElement('span');
  label.textContent = source.name || (source.kind === 'screen' ? 'Screen' : 'Window');
  name.append(label);
  button.append(shot, name);
  button.addEventListener('click', () => select(source.id));
  button.addEventListener('dblclick', () => window.picker.choose(source.id));
  li.append(button);
  return li;
}

function render() {
  const shown = sources.filter((s) => s.kind === kind);
  list.replaceChildren(...shown.map(card));
  empty.hidden = shown.length > 0;
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
  select(shown.some((s) => s.id === chosen) ? chosen : shown[0]?.id ?? null);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    kind = tab.dataset.kind;
    render();
  });
}
shareButton.addEventListener('click', () => chosen && window.picker.choose(chosen));
document.getElementById('cancel').addEventListener('click', () => window.picker.cancel());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.picker.cancel();
  if (e.key === 'Enter' && chosen) window.picker.choose(chosen);
});

window.picker.sources().then((all) => {
  sources = all;
  if (!sources.some((s) => s.kind === 'screen')) kind = 'window';
  render();
});
