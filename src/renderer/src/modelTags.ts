import { useEffect, useState } from 'react';
import type { ModelTags } from '@shared/modelTags';
import { api, onEvent } from './api';

/**
 * The window's shared models.dev tag cache (src/main/modelTags.ts): fetched once per window, updated live by the
 * `models:tags` desk event when the background refresh lands. Used by the model picker (ConfigSelectMenu) and the
 * Info panel's context estimate (TokenStats).
 */

let tagsNow: ModelTags | null = null;
let tagsLoad: Promise<void> | null = null;
const tagsListeners = new Set<(t: ModelTags) => void>();

export function useModelTags(): ModelTags | null {
  const [tags, setTags] = useState(tagsNow);
  useEffect(() => {
    tagsListeners.add(setTags);
    if (!tagsLoad) {
      onEvent((ch, p) => {
        if (ch !== 'models:tags') return;
        tagsNow = p as ModelTags;
        for (const fn of tagsListeners) fn(tagsNow);
      });
      tagsLoad = api
        .modelTags()
        .then((t) => {
          // A live refresh may have landed first; keep the newer one.
          if (!tagsNow || t.fetchedAt > tagsNow.fetchedAt) tagsNow = t;
          for (const fn of tagsListeners) fn(tagsNow);
        })
        .catch(() => undefined);
    }
    return () => void tagsListeners.delete(setTags);
  }, []);
  return tags;
}
