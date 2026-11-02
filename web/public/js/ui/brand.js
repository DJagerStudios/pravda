// Pravda's poster artwork: newsprint cream, banner red and printer's black.
// Rays burst from a low red sun, a black star hangs above, and the title cuts
// across on the diagonal. It is all plain SVG, so it stays sharp at any size
// and needs no image files. The colours come from the brand tokens in
// pravda.css and are the same in light and dark mode.

import { html } from '../lib.js';

const STAR = 'M0-62l14.600 31.400 34.400 3.900-25.600 23.200 7 33.900L0 13.200-30.400 30.400l7-33.900-25.600-23.200 34.400-3.900z';

/** Rays fanning up and to the right of the sun. */
function rays(cx, cy) {
  const out = [];
  for (let i = 0; i < 9; i += 1) {
    const a = -8 + i * 11;
    const b = a + 5.5;
    const point = (deg, r = 1500) => {
      const t = (deg * Math.PI) / 180;
      return `${(cx + r * Math.cos(t)).toFixed(1)},${(cy - r * Math.sin(t)).toFixed(1)}`;
    };
    out.push(html`<polygon class="poster-ray" points=${`${cx},${cy} ${point(a)} ${point(b)}`} />`);
  }
  return out;
}

/** The sign-in poster. */
export function Poster() {
  return html`<svg class="poster-art" viewBox="0 0 800 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect class="poster-ground" width="800" height="1000" />
    ${rays(200, 760)}
    <circle class="poster-sun" cx="200" cy="760" r="150" />
    <polygon class="poster-wedge" points="0,1000 0,860 800,520 800,640 300,1000" />
    <g transform="translate(560 225) rotate(-14) scale(2.7)">
      <path class="poster-star" d=${STAR} />
    </g>
    <g transform="rotate(-20 400 500)">
      <text class="poster-title" x="60" y="560">ПРАВДА</text>
    </g>
  </svg>`;
}

/**
 * The slogan, printed on its own label so the artwork behind it can never cut
 * into the words, whatever the window's shape.
 */
export function Slogan() {
  return html`<p class="poster-slogan">Comrades of all servers, unite!</p>`;
}

/** Rays all the way round the origin, for the opening animation. */
function burst(count, r) {
  const out = [];
  const step = 360 / count;
  const point = (deg) => {
    const t = (deg * Math.PI) / 180;
    return `${(r * Math.cos(t)).toFixed(1)},${(r * Math.sin(t)).toFixed(1)}`;
  };
  for (let i = 0; i < count; i += 1) {
    out.push(html`<polygon class="poster-ray" points=${`0,0 ${point(i * step)} ${point(i * step + step / 2)}`} />`);
  }
  return out;
}

/**
 * The opening animation, in the poster's colours: a slowly turning sunburst
 * behind a red sun with the black star stamped on it. The rays live in their
 * own square centred on the badge, so the composition holds at any window
 * shape.
 */
export function SplashArt() {
  return html`
    <svg class="splash-rays" viewBox="-1000 -1000 2000 2000" aria-hidden="true">${burst(18, 1500)}</svg>
    <svg class="splash-badge" viewBox="-100 -100 200 200" aria-hidden="true">
      <circle class="poster-sun splash-sun" r="96" />
      <g class="splash-star"><path d=${STAR} transform="scale(1.3)" /></g>
    </svg>`;
}
