// The call stage: everyone in a call, as portraits or live video.

import { html, classes, useEffect, useRef } from '../lib.js';
import {
  S, P, has, displayName, dmTitle, user, update,
} from '../state.js';
import { Icon } from '../icons.js';
import { Avatar, Button, IconButton } from './common.js';
import { openModal } from '../state.js';
import { Cinema } from './cinema.js';
import {
  joinVoice, leaveVoice, retryAudio, setCallFocus, toggleCamera, toggleDeafen, toggleMute, toggleScreen, watchScreen,
} from '../voice.js';

function Video({ stream, muted, mirror }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return html`<video ref=${ref} autoplay playsinline muted=${muted} class=${classes(mirror && 'mirror')}></video>`;
}

function fullscreen(e) {
  e.stopPropagation();
  const tile = e.currentTarget.closest('.tile');
  if (document.fullscreenElement) document.exitFullscreen();
  else tile?.requestFullscreen?.();
}

function Tile({ tileKey, userId, serverId, source, stream, local, state }) {
  const speaking = S.speaking.has(userId) && source !== 'screen';
  const focused = S.call?.focus === tileKey;
  const name = displayName(userId, serverId);
  const label = source === 'screen' ? (local && S.call?.cinema ? `Playing ${S.call.cinema.name}` : `${name}'s screen`) : name;
  return html`<figure class=${classes('tile', speaking && 'speaking', focused && 'focused', source === 'screen' && 'screen-tile')}
    onClick=${() => setCallFocus(tileKey)}>
    ${stream
      ? html`<${Video} stream=${stream} muted mirror=${local && source === 'camera'} />`
      : html`<div class="tile-portrait"><${Avatar} userId=${userId} size=${88} /></div>`}
    <figcaption class="tile-caption">
      <span>${label}</span>
      ${source !== 'screen' && (state?.self_mute || state?.server_mute) && html`<${Icon} name="micOff" size=${14} />`}
      ${source !== 'screen' && (state?.self_deaf || state?.server_deaf) && html`<${Icon} name="phonesOff" size=${14} />`}
    </figcaption>
    ${stream && html`<${IconButton} class="tile-action" icon="maximize" size=${16} label="Fullscreen" onClick=${fullscreen} />`}
    ${!local && source === 'screen' && html`<${IconButton} class="tile-action tile-action-left" icon="x" size=${16} label="Stop watching"
      onClick=${(e) => { e.stopPropagation(); watchScreen(userId, false); }} />`}
  </figure>`;
}

function WatchPrompt({ userId, serverId }) {
  return html`<figure class="tile screen-tile watch-prompt">
    <div class="tile-portrait">
      <${Avatar} userId=${userId} size=${64} />
      <p><strong>${displayName(userId, serverId)}</strong> is broadcasting</p>
      <${Button} kind="primary" onClick=${() => watchScreen(userId, true)}>Watch<//>
    </div>
  </figure>`;
}

function tilesFor(c) {
  const call = S.call;
  const room = S.voice.get(c.id);
  const tiles = [];
  if (!room) return tiles;
  for (const [userId, state] of room) {
    const self = userId === S.me.id;
    if (state.screen) {
      if (self) {
        if (call?.localScreen) tiles.push({ key: `${userId}:screen`, userId, source: 'screen', stream: call.localScreen, local: true });
      } else if (call?.watching.has(userId)) {
        const entry = call.streams.get(`${userId}:screen`);
        tiles.push({ key: `${userId}:screen`, userId, source: 'screen', stream: entry?.stream ?? null });
      } else if (call?.channelId === c.id) {
        tiles.push({ key: `${userId}:watch`, userId, source: 'watch' });
      }
    }
    const camera = self ? call?.localCamera : call?.streams.get(`${userId}:camera`)?.stream;
    tiles.push({ key: `${userId}:camera`, userId, source: 'camera', stream: state.video ? camera ?? null : null, local: self, state });
  }
  return tiles;
}

function Controls({ c }) {
  const call = S.call;
  const canStream = has(c.perms, P.STREAM);
  return html`<div class="stage-controls">
    <${IconButton} size=${22} icon=${call.muted ? 'micOff' : 'mic'} label=${call.muted ? 'Unmute' : 'Mute'} active=${call.muted} onClick=${toggleMute} />
    <${IconButton} size=${22} icon=${call.deafened ? 'phonesOff' : 'phones'} label=${call.deafened ? 'Undeafen' : 'Deafen'} active=${call.deafened} onClick=${toggleDeafen} />
    <${IconButton} size=${22} icon=${call.video ? 'video' : 'videoOff'} label=${call.video ? 'Turn camera off' : 'Turn camera on'} active=${call.video} onClick=${toggleCamera} />
    <${IconButton} size=${22} icon="screen" label=${call.screen ? (call.cinema ? 'Stop the video' : 'Stop sharing') : 'Share your screen'} active=${call.screen} onClick=${toggleScreen} disabled=${!canStream} />
    <${IconButton} size=${22} icon="film" label="Watch together" active=${S.watch.has(c.id) || !!call.cinema} onClick=${() => openModal('watch', { channelId: c.id })} disabled=${!canStream} />
    <${IconButton} size=${22} icon="hangup" label="Disconnect" danger onClick=${() => leaveVoice()} />
    <span class="stage-lock" title="Calls are end-to-end encrypted"><${Icon} name="lock" size=${14} /> Encrypted</span>
  </div>`;
}

/** The full-size stage for a voice channel, or the band above a private chat. */
export function Stage({ c, compact = false }) {
  const serverId = c.server_id === '0' ? null : c.server_id;
  const here = S.call?.channelId === c.id;
  const room = S.voice.get(c.id);
  const count = room?.size ?? 0;
  const title = c.server_id === '0' ? dmTitle(c) : c.name;

  if (!here && compact) return null;
  if (!here) {
    return html`<section class="stage stage-idle">
      <header class="stage-head">
        <${IconButton} class="drawer-toggle" icon="menu" label="Channels" onClick=${() => { S.railOpen = !S.railOpen; update(); }} />
        <h1>${title}</h1>
      </header>
      <div class="stage-enter">
        <div class="stage-enter-mark"><${Icon} name="megaphone" size=${64} /></div>
        <p>${count > 0 ? `${count} ${count === 1 ? 'person is' : 'people are'} here.` : 'Nobody is here yet.'}</p>
        ${room && html`<div class="stage-enter-people">
          ${[...room.keys()].map((id) => html`<span key=${id} title=${user(id).display_name}><${Avatar} userId=${id} size=${44} /></span>`)}
        </div>`}
        <${Button} kind="primary" disabled=${!has(c.perms, P.CONNECT)} onClick=${() => joinVoice(c.id)}>Join voice<//>
      </div>
    </section>`;
  }

  const tiles = tilesFor(c);
  const focused = tiles.find((t) => t.key === S.call.focus);
  const grid = focused ? tiles.filter((t) => t !== focused) : tiles;
  const renderTile = (t) => (t.source === 'watch'
    ? html`<${WatchPrompt} key=${t.key} userId=${t.userId} serverId=${serverId} />`
    : html`<${Tile} key=${t.key} tileKey=${t.key} userId=${t.userId} serverId=${serverId} source=${t.source}
        stream=${t.stream} local=${t.local} state=${t.state} />`);

  return html`<section class=${classes('stage', compact && 'stage-compact')} onClick=${retryAudio}>
    ${!compact && html`<header class="stage-head">
      <${IconButton} class="drawer-toggle" icon="menu" label="Channels" onClick=${() => { S.railOpen = !S.railOpen; update(); }} />
      <h1>${title}</h1><span class="stage-count">${count} connected</span>
    </header>`}
    <${Cinema} c=${c} />
    <div class=${classes('stage-floor', (focused || S.watch.has(c.id)) && 'has-focus', `people-${Math.min(grid.length, 9)}`)}>
      ${focused && html`<div class="stage-focus">${renderTile(focused)}</div>`}
      <div class="stage-grid">${grid.map(renderTile)}</div>
    </div>
    ${S.call.micError && html`<p class="stage-warning">${S.call.micError} You can listen, but nobody can hear you.</p>`}
    <${Controls} c=${c} />
  </section>`;
}
