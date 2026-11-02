// Interface sounds, synthesised at runtime so the app ships no audio files.
// The palette is a radio operator's: short sine and square blips.

import { S } from './state.js';

let ctx = null;

function context() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip(ac, { freq, start, length, type = 'sine', gain = 0.12 }) {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = ac.currentTime + start;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(env).connect(ac.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

const SOUNDS = {
  message: [{ freq: 880, start: 0, length: 0.09, gain: 0.07 }],
  mention: [
    { freq: 880, start: 0, length: 0.1 },
    { freq: 1175, start: 0.09, length: 0.14 },
  ],
  join: [
    { freq: 523, start: 0, length: 0.11 },
    { freq: 784, start: 0.1, length: 0.16 },
  ],
  leave: [
    { freq: 784, start: 0, length: 0.11 },
    { freq: 523, start: 0.1, length: 0.16 },
  ],
  mute: [{ freq: 330, start: 0, length: 0.08, type: 'square', gain: 0.04 }],
  unmute: [{ freq: 495, start: 0, length: 0.08, type: 'square', gain: 0.04 }],
  ring: [
    { freq: 698, start: 0, length: 0.2 },
    { freq: 880, start: 0.22, length: 0.2 },
    { freq: 698, start: 0.6, length: 0.2 },
    { freq: 880, start: 0.82, length: 0.2 },
  ],
};

export function playSound(name) {
  if (!S.settings.sounds) return;
  const notes = SOUNDS[name];
  if (!notes) return;
  try {
    const ac = context();
    for (const note of notes) blip(ac, note);
  } catch {
    // Audio can be blocked until the first user gesture. Sounds are a nicety.
  }
}
