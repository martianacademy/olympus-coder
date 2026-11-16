import { useCallback, useSyncExternalStore } from 'react';

/**
 * Small view preferences kept in this browser profile: whether thinking and tool steps in chats open by
 * themselves ("expanded") or stay folded until clicked, plus per-step manual open/fold overrides so a step
 * opened or folded by the user keeps that state across streaming updates, completion, and group transitions.
 */
const KEY = 'olympus.expandSteps';
const MAX_STEP_CHOICES = 5_000;
const listeners = new Set<() => void>();
const stepChoices = new Map<string, boolean>();
const stepChoiceListeners = new Set<() => void>();

let expand = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

function notifyStepChoices() {
  stepChoiceListeners.forEach((l) => l());
}

/**
 * Sets the global default for whether thinking and tool steps start open or folded.
 * Explicitly toggling the global mode resets per-step overrides so all steps follow the chosen mode.
 */
export function setExpandSteps(on: boolean) {
  expand = on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private mode: just this session */
  }
  if (stepChoices.size > 0) {
    stepChoices.clear();
    notifyStepChoices();
  }
  listeners.forEach((l) => l());
}

export const useExpandSteps = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => expand,
  );

/** Records a user's explicit open/fold toggle for an individual thinking block, tool row, or tool group. */
export function setStepChoice(key: string, open: boolean) {
  if (stepChoices.get(key) === open) return;
  if (!stepChoices.has(key) && stepChoices.size >= MAX_STEP_CHOICES) {
    const oldest = stepChoices.keys().next().value;
    if (oldest !== undefined) stepChoices.delete(oldest);
  }
  stepChoices.set(key, open);
  notifyStepChoices();
}

export function getStepChoice(key: string): boolean | undefined {
  return stepChoices.get(key);
}

export function clearStepChoices() {
  if (stepChoices.size === 0) return;
  stepChoices.clear();
  notifyStepChoices();
}

/**
 * Subscribes to the user's explicit open/fold choice (`true`, `false`, or `undefined` if untouched)
 * for a single step key. Because the snapshot is a primitive boolean/undefined, unrelated steps never re-render.
 */
export function useStepChoice(key: string): [boolean | undefined, (open: boolean) => void] {
  const choice = useSyncExternalStore(
    (l) => {
      stepChoiceListeners.add(l);
      return () => stepChoiceListeners.delete(l);
    },
    () => stepChoices.get(key),
  );
  const set = useCallback((open: boolean) => setStepChoice(key, open), [key]);
  return [choice, set];
}

/** Returns true if any of the given step keys has been explicitly opened (`true`) by the user. */
export function useAnyStepOpen(keys: readonly string[]): boolean {
  return useSyncExternalStore(
    (l) => {
      stepChoiceListeners.add(l);
      return () => stepChoiceListeners.delete(l);
    },
    () => {
      for (let i = 0; i < keys.length; i++) {
        if (stepChoices.get(keys[i]) === true) return true;
      }
      return false;
    },
  );
}

/** Long lines in the file editor and previews wrap (on by default) or scroll sideways. */
const WRAP_KEY = 'olympus.wrapLines';
const wrapListeners = new Set<() => void>();
let wrap = (() => {
  try {
    return localStorage.getItem(WRAP_KEY) !== '0';
  } catch {
    return true;
  }
})();

export function setWrapLines(on: boolean) {
  wrap = on;
  try {
    localStorage.setItem(WRAP_KEY, on ? '1' : '0');
  } catch {
    /* private mode: just this session */
  }
  wrapListeners.forEach((l) => l());
}

export const useWrapLines = () =>
  useSyncExternalStore(
    (l) => {
      wrapListeners.add(l);
      return () => wrapListeners.delete(l);
    },
    () => wrap,
  );
