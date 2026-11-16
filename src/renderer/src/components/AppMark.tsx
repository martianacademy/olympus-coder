/**
 * Olympus Coder's mark — Olympus Mons erupting code: an orange volcano, a cream ball in its caldera (the eruption,
 * with an even gap all round) and a curly brace on its side above it (the cloud), on near-black.
 * Same art as build/icon.png (scripts/make-icons.py).
 */
const VOLCANO = 'M 7 83 C 18.4 78.55 32.65 48.29 35.5 38.5 L 41.8 38.5 L 41.8 39.7 A 8.2 8.2 0 0 0 58.2 39.7 L 58.2 38.5 L 64.5 38.5 C 67.35 48.29 81.6 78.55 93 83 Z';
const CLOUD = 'M 25 27 C 25 21.5 25 21.5 33 21.5 L 42 21.5 C 48.5 21.5 50 16 50 16 C 50 16 51.5 21.5 58 21.5 L 67 21.5 C 75 21.5 75 21.5 75 27';

/** `bare`: just the drawing on a transparent background (cloud and ball take the text colour, for light themes). */
export function AppMark({ size = 54, radius, bare }: { size?: number; radius?: number; bare?: boolean }) {
  const ink = bare ? 'currentColor' : '#FFF7F0';
  return (
    <svg
      className={bare ? 'app-mark bare' : 'app-mark'}
      width={size}
      height={size}
      viewBox={bare ? '4 12 92 74' : '0 0 100 100'}
      role="img"
      aria-label="Olympus Coder"
      style={bare ? undefined : { borderRadius: radius ?? Math.round(size * 0.24) }}
    >
      {!bare && <rect width="100" height="100" fill="#181110" />}
      <path d={VOLCANO} fill="#EE6A3E" />
      <path d={CLOUD} fill="none" stroke={ink} strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="50" cy="39.7" r="5.8" fill={ink} />
    </svg>
  );
}
