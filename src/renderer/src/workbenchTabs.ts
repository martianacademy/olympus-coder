import { useSyncExternalStore } from 'react';

/** The five core Workbench tabs whose order the user can customise by dragging. */
export const DEFAULT_WB_TABS = ['files', 'git', 'terminal', 'tasks', 'info'] as const;
export type CoreWbTab = (typeof DEFAULT_WB_TABS)[number];

const STORAGE_KEY = 'olympus.wbTabOrder.v1';
const VALID = new Set<string>(DEFAULT_WB_TABS);

/** Validates a stored tab order, drops unknown/duplicate ids, and appends any missing defaults at the end. */
export function normalizeTabOrder(raw: unknown): CoreWbTab[] {
  const out: CoreWbTab[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && VALID.has(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item as CoreWbTab);
      }
    }
  }
  for (const id of DEFAULT_WB_TABS) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** Returns a new order array with `fromId` moved into `toId`'s slot (no-op if either is missing or identical). */
export function reorderTabs(order: readonly CoreWbTab[], fromId: CoreWbTab, toId: CoreWbTab): CoreWbTab[] {
  if (fromId === toId) return [...order];
  const fromIdx = order.indexOf(fromId);
  const toIdx = order.indexOf(toId);
  if (fromIdx < 0 || toIdx < 0) return [...order];
  const next = [...order];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

/**
 * Commits a drag-drop of `draggedId` at `insertIdx` among the currently visible non-dragged core tabs,
 * keeping any hidden/detached core tabs in their relative positions.
 */
export function commitTabReorder(
  fullOrder: readonly CoreWbTab[],
  draggedId: CoreWbTab,
  otherVisibleIds: readonly CoreWbTab[],
  insertIdx: number,
): CoreWbTab[] {
  const clamped = Math.max(0, Math.min(otherVisibleIds.length, insertIdx));
  const nextVisible = [...otherVisibleIds.slice(0, clamped), draggedId, ...otherVisibleIds.slice(clamped)];
  const visibleSet = new Set<CoreWbTab>(nextVisible);
  let vi = 0;
  return fullOrder.map((id) => (visibleSet.has(id) ? nextVisible[vi++] : id));
}

/**
 * Picks the next visible tab when `current` becomes hidden (e.g. detached into its own window).
 * Prefers the neighbor right after `current` in the previous full order, then before, then the first visible tab.
 */
export function pickNextVisibleTab<T extends string>(
  allInOrder: readonly T[],
  visible: readonly T[],
  current: T,
): T | null {
  if (!visible.length) return null;
  if (visible.includes(current)) return current;
  const visSet = new Set(visible);
  const idx = allInOrder.indexOf(current);
  if (idx >= 0) {
    for (let i = idx + 1; i < allInOrder.length; i++) {
      if (visSet.has(allInOrder[i])) return allInOrder[i];
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (visSet.has(allInOrder[i])) return allInOrder[i];
    }
  }
  return visible[0];
}

function readStoredOrder(): CoreWbTab[] {
  if (typeof localStorage === 'undefined') return [...DEFAULT_WB_TABS];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeTabOrder(JSON.parse(raw)) : [...DEFAULT_WB_TABS];
  } catch {
    return [...DEFAULT_WB_TABS];
  }
}

let currentOrder: CoreWbTab[] = readStoredOrder();
const listeners = new Set<() => void>();

export function getWorkbenchTabOrder(): CoreWbTab[] {
  return currentOrder;
}

export function setWorkbenchTabOrder(next: CoreWbTab[]) {
  const normalized = normalizeTabOrder(next);
  if (normalized.length === currentOrder.length && normalized.every((id, i) => id === currentOrder[i])) return;
  currentOrder = normalized;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      /* ignore storage quota errors */
    }
  }
  for (const fn of listeners) fn();
}

export function useWorkbenchTabOrder(): CoreWbTab[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => currentOrder,
  );
}
