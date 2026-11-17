/**
 * Olympus's own mic sounds (synthesized, no audio files). Deliberately not Google's two-note rising "bloop":
 * - start: a quick three-note rising D-major sparkle (D6 → F#6 → A6), soft sine bells.
 * - stop: two notes falling a fifth (A5 → D5), a little lower and warmer.
 * Pure data; the renderer plays it with Web Audio (src/renderer/src/earcons.ts).
 */

export interface EarconNote {
  /** Hz. */
  freq: number;
  /** Start offset, ms. */
  at: number;
  /** Ring time (exponential decay), ms. */
  ms: number;
}

export type EarconId = 'start' | 'stop';

export const EARCONS: Record<EarconId, EarconNote[]> = {
  start: [
    { freq: 1174.66, at: 0, ms: 130 },
    { freq: 1479.98, at: 55, ms: 130 },
    { freq: 1760.0, at: 110, ms: 170 },
  ],
  stop: [
    { freq: 880.0, at: 0, ms: 140 },
    { freq: 587.33, at: 75, ms: 190 },
  ],
};

/** Peak loudness (0–1): quiet, a cue rather than an alert. */
export const EARCON_GAIN = 0.12;

/** Total length of an earcon, ms (the mic opens only after the start sound, so it isn't recorded). */
export function earconMs(id: EarconId): number {
  return Math.max(...EARCONS[id].map((n) => n.at + n.ms));
}
