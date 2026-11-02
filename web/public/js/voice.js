// The call engine: microphone, camera and screen capture, end-to-end media
// encryption, and the WebRTC connections to the media server.
//
// Each call holds two peer connections. `pub` sends: it is negotiated once at
// the start with one slot per source, and media starts and stops by swapping
// tracks. `sub` receives: the server re-offers whenever forwarded tracks
// change. Every frame in both directions passes through e2ee-worker.js, so
// the server relays ciphertext it cannot decode.

import { S, update, toast, has, P, channel, saveSettings } from './state.js';
import { send } from './gateway.js';
import { playSound } from './sounds.js';
import { allMediaKeys, mediaKey, MissingKeyError, refreshChannelKeys } from './keys.js';

const CAMERA_BITRATE = 1_500_000;
const SCREEN_PRESETS = {
  '720p30': { width: 1280, height: 720, frameRate: 30, bitrate: 2_500_000 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, bitrate: 4_000_000 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, bitrate: 7_000_000 },
  '1440p60': { width: 2560, height: 1440, frameRate: 60, bitrate: 10_000_000 },
};

let pub = null;
let sub = null;
let senders = {};
let micStream = null;
let cameraStream = null;
let screenStream = null;
let cinemaElement = null;
let worker = null;
let legacyTransforms = false;
let audioHost = null;
const audioElements = new Map();
let pttHeld = false;

/** Whether this browser can encrypt call media end to end. */
export function mediaEncryptionSupported() {
  return 'RTCRtpScriptTransform' in globalThis || 'createEncodedStreams' in (globalThis.RTCRtpSender?.prototype ?? {});
}

function audioContainer() {
  if (!audioHost) {
    audioHost = document.createElement('div');
    audioHost.hidden = true;
    document.body.append(audioHost);
  }
  return audioHost;
}

function micConstraints() {
  const s = S.settings;
  const audio = {
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
  };
  if (s.inputDevice !== 'default') audio.deviceId = { exact: s.inputDevice };
  return { audio };
}

function micShouldTransmit() {
  const call = S.call;
  if (!call || call.muted || call.deafened || call.serverMuted) return false;
  return S.settings.inputMode !== 'ptt' || pttHeld;
}

function applyMicState() {
  const on = micShouldTransmit();
  for (const t of micStream?.getAudioTracks() ?? []) t.enabled = on;
}

export function joinVoice(channelId) {
  if (S.call?.channelId === channelId) return;
  if (!mediaEncryptionSupported()) {
    toast('This browser cannot encrypt calls end to end, so Pravda will not connect it. Use the desktop app or a current Chromium, Firefox or Safari.', 'error');
    return;
  }
  if (S.call) leaveVoice({ silent: true });
  const c = channel(channelId);
  if (c && !has(c.perms, P.CONNECT)) {
    toast('You do not have permission to join this channel.', 'error');
    return;
  }
  S.call = {
    channelId,
    state: 'connecting',
    muted: S.savedMute ?? false,
    deafened: S.savedDeaf ?? false,
    serverMuted: false,
    video: false,
    screen: false,
    cinema: null,
    streams: new Map(),
    watching: new Set(),
    focus: null,
    micError: null,
    keyIndex: null,
  };
  S.ring = null;
  send('voice_join', { channel_id: channelId, self_mute: S.call.muted, self_deaf: S.call.deafened });
  update();
}

export function leaveVoice({ silent = false, notify = true } = {}) {
  if (!S.call) return;
  if (notify) send('voice_leave');
  teardown();
  if (!silent) playSound('leave');
  update();
}

function teardown() {
  pub?.close();
  sub?.close();
  pub = null;
  sub = null;
  senders = {};
  for (const stream of [micStream, cameraStream, screenStream]) {
    for (const t of stream?.getTracks() ?? []) t.stop();
  }
  micStream = null;
  cameraStream = null;
  screenStream = null;
  stopCinemaElement();
  worker?.terminate();
  worker = null;
  for (const el of audioElements.values()) {
    el.srcObject = null;
    el.remove();
  }
  audioElements.clear();
  S.savedMute = S.call?.muted;
  S.savedDeaf = S.call?.deafened;
  S.call = null;
}

/** Loads every key generation into the worker and marks the newest for sending. */
export async function refreshCallKeys() {
  const call = S.call;
  if (!call || !worker) return;
  await refreshChannelKeys(call.channelId);
  const current = await mediaKey(call.channelId);
  for (const k of await allMediaKeys(call.channelId)) {
    worker.postMessage({ type: 'key', index: k.index, raw: k.raw, current: k.index === current.index });
  }
  worker.postMessage({ type: 'key', index: current.index, raw: current.raw, current: true });
  call.keyIndex = current.index;
}

function attachTransform(endpoint, kind, mode) {
  if (!legacyTransforms) {
    endpoint.transform = new RTCRtpScriptTransform(worker, { mode, kind });
    return;
  }
  const { readable, writable } = endpoint.createEncodedStreams();
  worker.postMessage({ type: 'stream', readable, writable, mode, kind }, [readable, writable]);
}

async function startConnections(ready) {
  const call = S.call;
  if (!call) return;
  call.state = 'negotiating';
  call.serverMuted = !ready.can_speak;
  if (ready.watch) {
    const { applyWatch } = await import('./gateway.js');
    await applyWatch(ready.watch);
  }

  legacyTransforms = !('RTCRtpScriptTransform' in globalThis);
  worker = new Worker(new URL('./e2ee-worker.js', import.meta.url));
  // The key must be in place before the first frame, or nothing can be sent.
  await refreshCallKeys();
  if (S.call !== call) return;

  const config = legacyTransforms ? { encodedInsertableStreams: true } : {};
  pub = new RTCPeerConnection(config);
  sub = new RTCPeerConnection(config);
  pub.onconnectionstatechange = () => onConnectionState();
  sub.onconnectionstatechange = () => onConnectionState();
  pub.onicecandidate = (e) => sendCandidate('pub', e.candidate);
  sub.onicecandidate = (e) => sendCandidate('sub', e.candidate);
  sub.ontrack = onRemoteTrack;

  senders = {
    mic: pub.addTransceiver('audio', { direction: 'sendonly' }),
    camera: pub.addTransceiver('video', { direction: 'sendonly' }),
    screen: pub.addTransceiver('video', { direction: 'sendonly' }),
    screen_audio: pub.addTransceiver('audio', { direction: 'sendonly' }),
  };
  // Frame encryption leaves VP8's own header readable, so video uses VP8.
  preferCodec(senders.camera, 'video/VP8');
  preferCodec(senders.screen, 'video/VP8');
  for (const [source, t] of Object.entries(senders)) attachTransform(t.sender, source === 'mic' || source === 'screen_audio' ? 'audio' : 'video', 'encrypt');

  // The microphone is requested before the offer so a permission prompt
  // cannot leave the call half set up.
  await startMic();
  if (S.call !== call) return;

  await pub.setLocalDescription(await pub.createOffer());
  const mids = {};
  for (const [source, transceiver] of Object.entries(senders)) mids[transceiver.mid] = source;
  send('voice_signal', { pc: 'pub', type: 'offer', sdp: pub.localDescription.sdp, mids });
  playSound('join');
  update();
}

function preferCodec(transceiver, mime) {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const wanted = codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
  if (wanted.length) transceiver.setCodecPreferences(wanted);
}

async function startMic() {
  const call = S.call;
  try {
    micStream = await navigator.mediaDevices.getUserMedia(micConstraints());
  } catch (err) {
    // Listening without a microphone is still a valid way to be in a call.
    if (call) {
      call.micError = err.name === 'NotAllowedError' ? 'Microphone access was refused.' : 'No microphone was found.';
      toast(`${call.micError} You can still listen.`, 'error');
    }
    return;
  }
  if (S.call !== call) {
    for (const t of micStream.getTracks()) t.stop();
    return;
  }
  applyMicState();
  await senders.mic.sender.replaceTrack(micStream.getAudioTracks()[0]);
}

function sendCandidate(pc, candidate) {
  if (candidate) send('voice_signal', { pc, type: 'candidate', candidate: candidate.toJSON() });
}

function onConnectionState() {
  const call = S.call;
  if (!call || !pub) return;
  const states = [pub.connectionState, sub.connectionState];
  if (pub.connectionState === 'connected') call.state = 'connected';
  if (states.includes('failed')) {
    const channelId = call.channelId;
    toast('Connection lost. Reconnecting the call…', 'error');
    leaveVoice({ silent: true });
    setTimeout(() => joinVoice(channelId), 500);
    return;
  }
  update();
}

function onRemoteTrack(event) {
  attachTransform(event.receiver, event.track.kind, 'decrypt');
  const [stream] = event.streams;
  const call = S.call;
  if (!stream || !call) return;
  const [userId, source] = stream.id.split(':');
  const key = stream.id;
  call.streams.set(key, { userId, source, stream, kind: event.track.kind });
  if (event.track.kind === 'audio') attachAudio(key, stream, userId);
  stream.onremovetrack = () => {
    if (stream.getTracks().length > 0) return;
    S.call?.streams.delete(key);
    const el = audioElements.get(key);
    if (el) {
      el.srcObject = null;
      el.remove();
      audioElements.delete(key);
    }
    update();
  };
  update();
}

function attachAudio(key, stream, userId) {
  let el = audioElements.get(key);
  if (!el) {
    el = document.createElement('audio');
    el.autoplay = true;
    audioContainer().append(el);
    audioElements.set(key, el);
  }
  el.srcObject = stream;
  el.dataset.user = userId;
  el.muted = (S.call?.deafened ?? false) || !!S.settings.localMutes[userId];
  el.volume = (S.settings.volumes[userId] ?? 100) / 100;
  if (S.settings.outputDevice !== 'default') el.setSinkId?.(S.settings.outputDevice).catch(() => {});
  el.play?.().catch(() => {
    // Browsers may refuse playback before the first click; clicks into the
    // call retry it.
  });
}

export function retryAudio() {
  for (const el of audioElements.values()) el.play?.().catch(() => {});
}

/** Mutes one person for me alone; nobody else is affected. */
export function setLocalMute(userId, muted) {
  const mutes = { ...S.settings.localMutes };
  if (muted) mutes[userId] = true;
  else delete mutes[userId];
  saveSettings({ localMutes: mutes });
  for (const el of audioElements.values()) {
    if (el.dataset.user === userId) el.muted = (S.call?.deafened ?? false) || muted;
  }
}

export function setUserVolume(userId, percent) {
  saveSettings({ volumes: { ...S.settings.volumes, [userId]: percent } });
  for (const [key, el] of audioElements) {
    if (key.startsWith(`${userId}:`)) el.volume = percent / 100;
  }
}

export function setOutputDevice(deviceId) {
  for (const el of audioElements.values()) el.setSinkId?.(deviceId === 'default' ? '' : deviceId).catch(() => {});
}

function pushState(patch) {
  send('voice_state', patch);
  update();
}

export function toggleMute() {
  const call = S.call;
  if (!call) {
    S.savedMute = !S.savedMute;
    update();
    return;
  }
  // Unmuting while deafened also lifts the deafening: nobody means to talk
  // into a room they cannot hear.
  if (call.deafened && call.muted) {
    call.deafened = false;
    for (const el of audioElements.values()) el.muted = false;
  }
  call.muted = !call.muted;
  applyMicState();
  playSound(call.muted ? 'mute' : 'unmute');
  pushState({ self_mute: call.muted, self_deaf: call.deafened });
}

export function toggleDeafen() {
  const call = S.call;
  if (!call) {
    S.savedDeaf = !S.savedDeaf;
    if (S.savedDeaf) S.savedMute = true;
    update();
    return;
  }
  call.deafened = !call.deafened;
  if (call.deafened) call.muted = true;
  for (const el of audioElements.values()) el.muted = call.deafened || !!S.settings.localMutes[el.dataset.user];
  applyMicState();
  playSound(call.deafened ? 'mute' : 'unmute');
  pushState({ self_mute: call.muted, self_deaf: call.deafened });
}

export async function toggleCamera() {
  const call = S.call;
  if (!call || !pub) return;
  if (call.video) {
    await stopCamera();
    return;
  }
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (S.settings.cameraDevice !== 'default') video.deviceId = { exact: S.settings.cameraDevice };
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video });
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Camera access was refused.' : 'No camera was found.', 'error');
    return;
  }
  if (S.call !== call) {
    for (const t of cameraStream.getTracks()) t.stop();
    cameraStream = null;
    return;
  }
  const track = cameraStream.getVideoTracks()[0];
  track.onended = () => stopCamera();
  await senders.camera.sender.replaceTrack(track);
  await limitBitrate(senders.camera.sender, CAMERA_BITRATE);
  call.video = true;
  call.localCamera = cameraStream;
  pushState({ video: true });
}

async function stopCamera() {
  const call = S.call;
  if (!call?.video) return;
  await senders.camera.sender.replaceTrack(null);
  for (const t of cameraStream?.getTracks() ?? []) t.stop();
  cameraStream = null;
  call.video = false;
  call.localCamera = null;
  pushState({ video: false });
}

async function publishScreen(stream, preset, label) {
  const call = S.call;
  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];
  // High frame rates suggest a game or film; otherwise favour sharp text.
  video.contentHint = preset.frameRate >= 60 || label ? 'motion' : 'detail';
  video.onended = () => stopScreen();
  await senders.screen.sender.replaceTrack(video);
  await limitBitrate(senders.screen.sender, preset.bitrate);
  await senders.screen_audio.sender.replaceTrack(audio ?? null);
  call.screen = true;
  call.localScreen = stream;
  pushState({ screen: true });
}

export async function toggleScreen() {
  const call = S.call;
  if (!call || !pub) return;
  if (call.screen) {
    await stopScreen();
    return;
  }
  const preset = SCREEN_PRESETS[S.settings.streamQuality] ?? SCREEN_PRESETS['1080p30'];
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.frameRate } },
      audio: { suppressLocalAudioPlayback: false },
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Screen sharing could not start.', 'error');
    return;
  }
  if (S.call !== call) {
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
    return;
  }
  await publishScreen(screenStream, preset);
}

/**
 * Broadcasts a local video file to the call: it plays here and its picture
 * and sound go out as an encrypted stream, so everyone watches in sync
 * without the file ever being uploaded.
 */
export async function startCinema(file) {
  const call = S.call;
  if (!call || !pub) return;
  if (call.screen) await stopScreen();
  const el = document.createElement('video');
  el.src = URL.createObjectURL(file);
  el.playsInline = true;
  el.controls = true;
  try {
    await el.play();
  } catch {
    toast('That file could not be played. Try MP4 (H.264) or WebM.', 'error');
    URL.revokeObjectURL(el.src);
    return;
  }
  const capture = el.captureStream?.() ?? el.mozCaptureStream?.();
  if (!capture) {
    toast('This browser cannot broadcast a video file.', 'error');
    return;
  }
  cinemaElement = el;
  screenStream = capture;
  call.cinema = { name: file.name, element: el };
  el.onended = () => stopScreen();
  // Tracks appear once playback produces frames.
  await new Promise((resolve) => {
    if (capture.getVideoTracks().length) resolve();
    else capture.onaddtrack = () => resolve();
    setTimeout(resolve, 1500);
  });
  await publishScreen(capture, SCREEN_PRESETS['1080p30'], file.name);
}

function stopCinemaElement() {
  if (!cinemaElement) return;
  cinemaElement.pause();
  URL.revokeObjectURL(cinemaElement.src);
  cinemaElement = null;
}

async function stopScreen() {
  const call = S.call;
  if (!call?.screen) return;
  await senders.screen.sender.replaceTrack(null);
  await senders.screen_audio.sender.replaceTrack(null);
  for (const t of screenStream?.getTracks() ?? []) t.stop();
  screenStream = null;
  stopCinemaElement();
  call.screen = false;
  call.localScreen = null;
  call.cinema = null;
  pushState({ screen: false });
}

async function limitBitrate(sender, maxBitrate) {
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  params.encodings[0].maxBitrate = maxBitrate;
  try {
    await sender.setParameters(params);
  } catch {
    // Older browsers refuse this; the stream then simply uses more bandwidth.
  }
}

export function watchScreen(userId, on) {
  const call = S.call;
  if (!call) return;
  if (on) call.watching.add(userId);
  else call.watching.delete(userId);
  send('voice_watch', { user_id: userId, on });
  update();
}

export function setCallFocus(key) {
  if (S.call) {
    S.call.focus = S.call.focus === key ? null : key;
    update();
  }
}

/** Replaces the live microphone after a settings change. */
export async function restartMic() {
  const call = S.call;
  if (!call || !pub) return;
  for (const t of micStream?.getTracks() ?? []) t.stop();
  micStream = null;
  await startMic();
}

async function onSignal(signal) {
  if (signal.pc === 'pub' && signal.type === 'answer') {
    await pub?.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    return;
  }
  if (signal.pc === 'sub' && signal.type === 'offer' && sub) {
    await sub.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    await sub.setLocalDescription(await sub.createAnswer());
    send('voice_signal', { pc: 'sub', type: 'answer', sdp: sub.localDescription.sdp });
  }
}

const END_REASONS = {
  connection_lost: 'The call dropped.',
  moved_elsewhere: 'You joined this call from another device.',
  removed: 'You were removed from the call.',
  disconnected: 'A moderator disconnected you.',
  channel_deleted: 'This channel was deleted.',
};

export async function handleVoiceEvent(type, data) {
  switch (type) {
    case 'voice.ready':
      try {
        await startConnections(data);
      } catch (err) {
        console.error('starting call', err);
        toast(err instanceof MissingKeyError ? err.message : 'The call could not be set up.', 'error');
        leaveVoice({ silent: true });
      }
      break;
    case 'voice.signal':
      onSignal(data).catch((err) => console.error('call negotiation', err));
      break;
    case 'voice.ended':
      if (S.call) {
        toast(END_REASONS[data.reason] ?? 'The call ended.');
        teardown();
        update();
      }
      break;
    case 'op.error':
      if (data.op === 'voice_join' && S.call?.state === 'connecting') teardown();
      break;
    default:
      break;
  }
}

/** The server forgot us during a long outage: get back into the call. */
export function resumeCallAfterReconnect() {
  const channelId = S.call?.channelId;
  if (!channelId) return;
  teardown();
  joinVoice(channelId);
}

export function bindPushToTalk() {
  const matches = (e) => S.settings.inputMode === 'ptt' && e.code === S.settings.pttKey;
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '');
  addEventListener('keydown', (e) => {
    if (matches(e) && !typing(e) && !e.repeat) {
      pttHeld = true;
      applyMicState();
    }
  });
  addEventListener('keyup', (e) => {
    if (matches(e)) {
      pttHeld = false;
      applyMicState();
    }
  });
  addEventListener('blur', () => {
    // A key released while the window is unfocused never reports it.
    pttHeld = false;
    applyMicState();
  });
}
