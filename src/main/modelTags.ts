import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeskEvents } from '@shared/types';
import { trimRegistry, limitsOf, type ModelTags } from '@shared/modelTags';

/**
 * Model capability tags for the model picker (src/renderer/src/components/ConfigSelectMenu.tsx).
 * The models.dev registry is fetched in the background (never blocks startup), trimmed to provider → model → tags
 * (src/shared/modelTags.ts) and cached as <userData>/model-tags.json for 7 days. A failed fetch keeps the old cache.
 */

const REGISTRY_URL = 'https://models.dev/api.json';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_FETCH_MS = 5_000;

let cache: ModelTags = { fetchedAt: 0, tags: {}, limits: {} };

const cacheFile = () => join(app.getPath('userData'), 'model-tags.json');

function readCache(): ModelTags {
  try {
    if (!existsSync(cacheFile())) return { fetchedAt: 0, tags: {}, limits: {} };
    const j = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Partial<ModelTags>;
    if (typeof j.fetchedAt === 'number' && j.tags && typeof j.tags === 'object')
      return { fetchedAt: j.fetchedAt, tags: j.tags, limits: j.limits && typeof j.limits === 'object' ? j.limits : {} };
  } catch (e) {
    console.warn('[modelTags] unreadable cache, refetching:', (e as Error).message);
  }
  return { fetchedAt: 0, tags: {}, limits: {} };
}

export const modelTags = (): ModelTags => cache;

async function refresh(emit: <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void): Promise<void> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const tags = trimRegistry(raw);
    if (!Object.keys(tags).length) throw new Error('registry had no models');
    cache = { fetchedAt: Date.now(), tags, limits: limitsOf(raw) };
    writeFileSync(cacheFile(), JSON.stringify(cache));
    emit('models:tags', cache);
  } catch (e) {
    console.warn('[modelTags] registry refresh failed, keeping the cached tags:', (e as Error).message);
  }
}

/** Loads the cache and, when it is missing or older than 7 days, refreshes it a few seconds after start. */
export function startModelTags(emit: <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void): void {
  cache = readCache();
  if (Date.now() - cache.fetchedAt < TTL_MS) return;
  setTimeout(() => void refresh(emit), FIRST_FETCH_MS).unref?.();
}
