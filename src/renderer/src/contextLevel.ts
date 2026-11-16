import type { ContextUsage } from '@shared/types';

/**
 * One scale for every context indicator (composer ring, Info ring, header pill, Compact button):
 * up to 50% full = green, up to 78% = yellow, above = red. CSS classes `ctx-green|ctx-yellow|ctx-red` (styles.css).
 */
export const CONTEXT_YELLOW_ABOVE = 0.5;
export const CONTEXT_RED_ABOVE = 0.78;

export type ContextLevel = 'green' | 'yellow' | 'red';

export function contextLevel(fraction: number): ContextLevel {
  return fraction > CONTEXT_RED_ABOVE ? 'red' : fraction > CONTEXT_YELLOW_ABOVE ? 'yellow' : 'green';
}

/** How full the context window is (0–1), or null when the agent has not reported its size. */
export function contextFraction(usage?: ContextUsage | null): number | null {
  return usage?.size ? Math.min(1, usage.used / usage.size) : null;
}

/** The level for a usage report; green when unknown. */
export const usageLevel = (usage?: ContextUsage | null): ContextLevel => contextLevel(contextFraction(usage) ?? 0);
