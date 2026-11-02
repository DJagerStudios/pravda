// The cinema: a shared player above the call. YouTube plays through its
// privacy-enhanced embed, steered over postMessage without loading any of
// Google's scripts into Pravda's own page; linked videos play in a plain
// video element. Every viewer's player follows the shared state.

import { html, classes, useEffect, useMemo, useRef, useState } from '../lib.js';
import { S, P, has, channel, displayName, saveSettings } from '../state.js';
import { Button, IconButton, Modal } from './common.js';
import { closeModal } from '../state.js';
import {
  expectedPosition, hostOf, parseSource, startWatch, stopWatch, updateWatch,
} from '../watch.js';
import { startCinema } from '../voice.js';
import { Icon } from '../icons.js';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';
const DRIFT_SECONDS = 1.5;
const consentedHosts = new Set();

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function allowed(state) {
  if (state.kind === 'youtube') return S.settings.allowYouTube || consentedHosts.has('youtube');
  return S.settings.allowExternalMedia || consentedHosts.has(hostOf(state));
}

function Consent({ state, onAllow }) {
  const host = hostOf(state);
  const youtube = state.kind === 'youtube';
  return html`<div class="cinema-consent">
    <${Icon} name="shield" size=${36} />
    <p><strong>This video loads from ${host}.</strong></p>
    <p>${youtube ? 'Google' : 'That site'} will see your IP address. Pravda's own traffic stays encrypted either way.</p>
    <div class="row-buttons">
      <${Button} kind="primary" onClick=${() => { consentedHosts.add(youtube ? 'youtube' : host); onAllow(); }}>Load it<//>
      <${Button} onClick=${() => { saveSettings(youtube ? { allowYouTube: true } : { allowExternalMedia: true }); onAllow(); }}>
        Always allow ${youtube ? 'YouTube' : 'linked videos'}
      <//>
    </div>
  </div>`;
}

/** Drives a YouTube embed with the IFrame API's postMessage protocol. */
function YouTubePlayer({ state, onTick }) {
  const frame = useRef(null);
  // `heard` turns true once the player reports back; until then its position
  // is unknown and must not be "corrected".
  const info = useRef({ time: 0, playerState: -1, duration: 0, heard: false });
  // Start where everyone else is, even if the player never reports back.
  const start = useMemo(() => Math.max(0, Math.floor(expectedPosition(state))), [state.src]);
  const command = (func, args = []) => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT_ORIGIN);

  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== YT_ORIGIN || e.source !== frame.current?.contentWindow) return;
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      const i = data.info;
      if (i && typeof i === 'object') {
        info.current.heard = true;
        if (typeof i.currentTime === 'number') info.current.time = i.currentTime;
        if (typeof i.playerState === 'number') info.current.playerState = i.playerState;
        if (typeof i.duration === 'number') info.current.duration = i.duration;
        onTick({ ...info.current });
      }
    };
    addEventListener('message', onMessage);
    const listen = setInterval(() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN), 1000);
    return () => {
      removeEventListener('message', onMessage);
      clearInterval(listen);
    };
  }, []);

  // Follow the shared state: play, pause and correct drift.
  useEffect(() => {
    const steer = () => {
      const target = expectedPosition(state);
      const { time, playerState, heard } = info.current;
      if (!heard) {
        command(state.playing ? 'playVideo' : 'pauseVideo');
        return;
      }
      if (Math.abs(time - target) > DRIFT_SECONDS) command('seekTo', [target, true]);
      if (state.playing && playerState !== 1 && playerState !== 3) command('playVideo');
      if (!state.playing && playerState === 1) command('pauseVideo');
    };
    steer();
    const timer = setInterval(steer, 1000);
    return () => clearInterval(timer);
  }, [state.src, state.playing, state.pos, state.at]);

  const params = new URLSearchParams({
    enablejsapi: '1', playsinline: '1', rel: '0', controls: '0', disablekb: '1', iv_load_policy: '3',
    origin: location.origin, start: String(start),
  });
  return html`<iframe ref=${frame} class="cinema-frame" title="Shared video"
    src=${`${YT_ORIGIN}/embed/${encodeURIComponent(state.src)}?${params}`}
    allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
    referrerpolicy="strict-origin-when-cross-origin"
    sandbox="allow-scripts allow-same-origin allow-presentation"></iframe>`;
}

function LinkedPlayer({ state, onTick }) {
  const video = useRef(null);
  useEffect(() => {
    const el = video.current;
    const steer = () => {
      const target = expectedPosition(state);
      if (Math.abs(el.currentTime - target) > DRIFT_SECONDS && Number.isFinite(el.duration || target)) el.currentTime = target;
      if (state.playing && el.paused) el.play().catch(() => {});
      if (!state.playing && !el.paused) el.pause();
      onTick({ time: el.currentTime, duration: el.duration || 0, playerState: el.paused ? 2 : 1 });
    };
    steer();
    const timer = setInterval(steer, 1000);
    return () => clearInterval(timer);
  }, [state.src, state.playing, state.pos, state.at]);
  return html`<video ref=${video} class="cinema-video" src=${state.src} playsinline preload="auto"></video>`;
}

/** The shared player and its controls, shown when a call is watching something. */
export function Cinema({ c }) {
  const state = S.watch.get(c.id);
  const [, setConsent] = useState(0);
  const [tick, setTick] = useState({ time: 0, duration: 0 });
  if (!state) return null;
  const canControl = has(c.perms, P.STREAM);
  const position = expectedPosition(state);
  const duration = tick.duration || 0;
  const seekTo = (e) => {
    if (!canControl || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    updateWatch(c.id, { pos: ((e.clientX - rect.left) / rect.width) * duration });
  };
  const fullscreen = (e) => {
    const box = e.currentTarget.closest('.cinema');
    if (document.fullscreenElement) document.exitFullscreen();
    else box?.requestFullscreen?.();
  };
  return html`<section class="cinema" aria-label="Watching together">
    <div class="cinema-screen">
      ${allowed(state)
        ? (state.kind === 'youtube'
          ? html`<${YouTubePlayer} key=${state.src} state=${state} onTick=${setTick} />`
          : html`<${LinkedPlayer} key=${state.src} state=${state} onTick=${setTick} />`)
        : html`<${Consent} state=${state} onAllow=${() => setConsent((n) => n + 1)} />`}
    </div>
    <div class="cinema-bar">
      ${canControl && html`<${IconButton} icon=${state.playing ? 'pause' : 'play'} label=${state.playing ? 'Pause for everyone' : 'Play for everyone'}
        onClick=${() => updateWatch(c.id, { playing: !state.playing })} />`}
      ${canControl && html`<${IconButton} icon="back10" label="Back 10 seconds" onClick=${() => updateWatch(c.id, { pos: position - 10 })} />`}
      ${canControl && html`<${IconButton} icon="forward30" label="Forward 30 seconds" onClick=${() => updateWatch(c.id, { pos: position + 30 })} />`}
      <span class="cinema-time">${formatClock(position)}${duration ? ` / ${formatClock(duration)}` : ''}</span>
      <div class=${classes('cinema-progress', canControl && 'seekable')} onClick=${seekTo} role="presentation">
        <div class="cinema-progress-fill" style=${{ width: duration ? `${Math.min(100, (position / duration) * 100)}%` : '0%' }}></div>
      </div>
      <span class="cinema-by">Chosen by ${displayName(state.by, c.server_id === '0' ? null : c.server_id)}</span>
      <${IconButton} icon="maximize" label="Fullscreen" onClick=${fullscreen} />
      ${canControl && html`<${IconButton} icon="x" label="Stop watching for everyone" danger onClick=${() => stopWatch(c.id)} />`}
    </div>
  </section>`;
}

export function WatchModal({ channelId }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const file = useRef(null);
  const source = parseSource(link);
  const start = () => {
    if (!source) {
      setError('Paste a YouTube link, or a direct link to an MP4 or WebM file.');
      return;
    }
    startWatch(channelId, source);
    closeModal();
  };
  const c = channel(channelId);
  return html`<${Modal} title="Watch together" kicker=${c?.name ?? 'Call'} size="medium">
    <div class="split-forms">
      <form onSubmit=${(e) => { e.preventDefault(); start(); }}>
        <h3>From a link</h3>
        <p>YouTube or a direct video link. Everyone's player stays in step; anyone allowed to stream can pause or skip.</p>
        <label class="field"><span class="field-label">Link</span>
          <input data-autofocus placeholder="https://www.youtube.com/watch?v=…" value=${link} onInput=${(e) => { setLink(e.currentTarget.value); setError(''); }} />
        </label>
        ${error && html`<p class="form-error">${error}</p>`}
        <${Button} kind="primary" type="submit" disabled=${!link.trim()}>Start<//>
      </form>
      <div>
        <h3>From this computer</h3>
        <p>Play a film or episode from your own disk. It streams to the call encrypted; nothing is uploaded.</p>
        <${Button} onClick=${() => file.current.click()}>Choose a video file<//>
        <input ref=${file} type="file" accept="video/*,audio/*" hidden onChange=${(e) => {
          const chosen = e.currentTarget.files[0];
          if (chosen) {
            startCinema(chosen);
            closeModal();
          }
        }} />
      </div>
    </div>
  <//>`;
}
