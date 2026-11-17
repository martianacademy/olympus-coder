/**
 * Model capability tags (Free / Vision / Reasoning / Tools) for model pickers, from the models.dev registry
 * (https://models.dev/api.json). Only a trimmed map is ever kept: provider → model id → tags.
 * Pure functions (no Electron) so tests/modelTags.unit.mjs can run them in plain Node.
 */

export type ModelTag = 'free' | 'vision' | 'reasoning' | 'tools';

export const MODEL_TAGS: ModelTag[] = ['free', 'vision', 'reasoning', 'tools'];

/** The trimmed registry the main process caches (model-tags.json in userData) and hands to the window. */
export interface ModelTags {
  /** When the registry was fetched (ms); 0 = never. */
  fetchedAt: number;
  tags: Record<string, Record<string, string[]>>;
  /** Context-window sizes (tokens), provider → model id — for the "context (est.)" read in the Info panel. */
  limits: Record<string, Record<string, number>>;
}

/** The registry's model entry fields we read. */
interface RawModel {
  attachment?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  cost?: { input?: unknown; output?: unknown } | null;
}

/** One registry model → its tags (only the ones that apply). */
export function tagsOfModel(m: RawModel): ModelTag[] {
  const out: ModelTag[] = [];
  if (m.cost && m.cost.input === 0 && m.cost.output === 0) out.push('free');
  if (m.attachment === true) out.push('vision');
  if (m.reasoning === true) out.push('reasoning');
  if (m.tool_call === true) out.push('tools');
  return out;
}

/** The raw models.dev JSON → { provider: { modelId: tags } }. Models with no tags are left out to keep it small. */
export function trimRegistry(raw: unknown): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [provider, p] of Object.entries(raw as Record<string, unknown>)) {
    const models = (p as { models?: unknown } | null)?.models;
    if (!models || typeof models !== 'object') continue;
    const map: Record<string, string[]> = {};
    for (const [id, m] of Object.entries(models as Record<string, unknown>)) {
      if (!m || typeof m !== 'object') continue;
      const t = tagsOfModel(m as RawModel);
      if (t.length) map[id] = t;
    }
    if (Object.keys(map).length) out[provider] = map;
  }
  return out;
}

/** The raw models.dev JSON → { provider: { modelId: context-window tokens } }, for models that publish a limit. */
export function limitsOf(raw: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [provider, p] of Object.entries(raw as Record<string, unknown>)) {
    const models = (p as { models?: unknown } | null)?.models;
    if (!models || typeof models !== 'object') continue;
    const map: Record<string, number> = {};
    for (const [id, m] of Object.entries(models as Record<string, unknown>)) {
      const ctx = (m as { limit?: { context?: unknown } | null } | null)?.limit?.context;
      if (typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0) map[id] = ctx;
    }
    if (Object.keys(map).length) out[provider] = map;
  }
  return out;
}

/** Context-window tokens of one choice value from the limits map; undefined when unknown. */
export function contextLimit(limits: Record<string, Record<string, number>> | undefined, value: string): number | undefined {
  const parts = splitModelValue(value);
  const n = parts && limits ? limits[parts[0]]?.[parts[1]] : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** "provider/model-id" → [provider, model-id], split at the FIRST slash (nested ids like "z-ai/glm-5" stay whole). */
export function splitModelValue(value: string): [string, string] | null {
  const i = value.indexOf('/');
  if (i <= 0 || i === value.length - 1) return null;
  return [value.slice(0, i), value.slice(i + 1)];
}

/** Tags of one choice value from the trimmed map; [] when the provider or model is unknown. */
export function tagsForValue(tags: Record<string, Record<string, string[]>> | undefined, value: string): string[] {
  const parts = splitModelValue(value);
  if (!parts || !tags) return [];
  return tags[parts[0]]?.[parts[1]] ?? [];
}

/** Offline guess when the registry has no entry: "free" when the id or name says so. */
export function deriveFallbackTags(value: string, name?: string): string[] {
  return /free/i.test(value) || /free/i.test(name ?? '') ? ['free'] : [];
}

/** Registry tags, plus the "free" guess when the registry has nothing for this model. */
export function choiceTags(tags: Record<string, Record<string, string[]>> | undefined, value: string, name?: string): string[] {
  const t = tagsForValue(tags, value);
  return t.length ? t : deriveFallbackTags(value, name);
}

/** The provider prefix of a choice value ("opencode/glm" → "opencode"), or undefined. */
export const providerOf = (value: string): string | undefined => splitModelValue(value)?.[0];
