import { useEffect, useRef } from 'react';

/**
 * Polls run only while the page is on screen. A hidden desktop window (minimised, another Space, fully covered)
 * and a phone page in the background report `document.visibilityState === 'hidden'`; their timers stop, and the
 * moment the page is visible again they run once straight away, so what the user sees is fresh at once.
 */
export const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Calls `fn(visible)` whenever the page is shown or hidden. Returns the unsubscribe function. */
export function onPageVisibility(fn: (visible: boolean) => void): () => void {
  const on = () => fn(pageVisible());
  document.addEventListener('visibilitychange', on);
  return () => document.removeEventListener('visibilitychange', on);
}

/**
 * Runs `fn` every `ms` while the page is visible (and once immediately, unless `immediate` is false); paused while
 * hidden, with one catch-up run when the page comes back. Returns the stop function.
 */
export function everyWhileVisible(fn: () => void, ms: number, immediate = true): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(fn, ms);
  };
  if (pageVisible()) {
    if (immediate) fn();
    startTimer();
  }
  const off = onPageVisibility((visible) => {
    clearInterval(timer);
    timer = undefined;
    if (!visible) return;
    fn();
    startTimer();
  });
  return () => {
    off();
    clearInterval(timer);
  };
}

/** `everyWhileVisible` for a component: only while `enabled`; the latest `fn` is used without restarting the timer. */
export function useVisibleInterval(fn: () => void, ms: number, enabled = true, immediate = false) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return everyWhileVisible(() => ref.current(), ms, immediate);
  }, [ms, enabled, immediate]);
}
