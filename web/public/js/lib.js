// One import point for the UI library, plus small shared helpers.
export {
  html, render, useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect,
} from '/vendor/preact-htm.mjs';

/** Compares two decimal ID strings numerically. */
export function compareIds(a, b) {
  if (a === b) return 0;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : 1;
}

// IDs carry their creation time in the high bits.
const EPOCH = 1767225600000n;
export const idTime = (id) => Number((BigInt(id) >> 12n) + EPOCH);

export const classes = (...parts) => parts.filter(Boolean).join(' ');

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatStamp(ms) {
  const d = new Date(ms);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === now.toDateString()) return `Today ${formatTime(ms)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${formatTime(ms)}`;
  return `${d.toLocaleDateString()} ${formatTime(ms)}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** A role or accent colour as CSS. Zero means "no colour". */
export const colorCss = (n) => (n ? `#${n.toString(16).padStart(6, '0')}` : '');

// ---- legible name colours ----
// Role colours are chosen by people, so a name could vanish into the page:
// a black role on the dark theme, a cream one on the light. nameColor mixes
// such a colour towards the page's own text colour until it reads at 4.5:1.

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (n) => 0.2126 * channel(((n >> 16) & 255) / 255) + 0.7152 * channel(((n >> 8) & 255) / 255) + 0.0722 * channel((n & 255) / 255);
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mix = (a, b, t) => {
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (a >> shift) & 255;
    const cb = (b >> shift) & 255;
    out |= Math.round(ca + (cb - ca) * t) << shift;
  }
  return out;
};
const PAGE = { day: [0xefe6d2, 0x15120f], night: [0x1c1815, 0xefe6d2] };
const legible = new Map();

/** A role colour adjusted so it stays readable on the current theme. */
export function nameColor(n) {
  if (!n) return '';
  const theme = document.documentElement.dataset.theme === 'night' ? 'night' : 'day';
  const key = `${theme}:${n}`;
  let out = legible.get(key);
  if (out === undefined) {
    const [bg, ink] = PAGE[theme];
    out = n;
    for (let t = 0.1; contrast(out, bg) < 4.5 && t <= 1; t += 0.1) out = mix(n, ink, t);
    legible.set(key, out);
  }
  return colorCss(out);
}

/** A stable colour for avatars without a picture, from the brand palette. */
// Mid tones only, so a portrait stands out on cream, on black and on a
// selected row alike.
const AVATAR_COLORS = ['#c8102e', '#a90d26', '#8e0b20', '#645b4d', '#7a7061'];
export function avatarColor(id) {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

export const initials = (name) => {
  const clean = (name || '?').trim();
  const parts = clean.split(/\s+/);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return letters.toUpperCase();
};

export function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private windows; settings then last the session.
  }
}
