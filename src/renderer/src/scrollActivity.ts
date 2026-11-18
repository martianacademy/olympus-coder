import { useEffect, type RefObject } from 'react';

const MIN_THUMB_PX = 28;

export interface OverlayScrollbarRefs {
  wrapRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  trackRef: RefObject<HTMLElement | null>;
  thumbRef: RefObject<HTMLElement | null>;
}

/**
 * Drives a thin, zero-shift DOM overlay vertical scrollbar for the sidebar scroll container.
 *
 * Why a DOM thumb instead of `::-webkit-scrollbar-thumb`:
 * - On macOS vibrancy windows in Electron/Chromium, Blink's custom scrollbar layer does not reliably invalidate on
 *   container `:hover`, and macOS overlay scroller fade-out hides native scrollbar thumbs ~0.75s after entering even
 *   while the pointer stays inside the sidebar.
 * - `scrollbar-gutter: stable` permanently reserves width even at rest, whereas an absolute-positioned DOM thumb
 *   overlays the existing right padding with zero layout shift when appearing or hiding.
 *
 * Updates DOM classes (`has-overflow`, `is-pointer-in`, `is-scrolling`, `is-dragging`) and thumb geometry directly
 * on the referenced elements so 60fps scrolling and dragging never trigger React re-renders.
 *
 * @param refs Wrapper, scroll box, track, and thumb element refs.
 * @param idleMs Milliseconds `is-scrolling` stays active after the last scroll event.
 */
export function useOverlayScrollbar(refs: OverlayScrollbarRefs, idleMs = 900): void {
  const { wrapRef, scrollRef, trackRef, thumbRef } = refs;

  useEffect(() => {
    const wrapEl = wrapRef.current;
    const scrollEl = scrollRef.current;
    const trackEl = trackRef.current;
    const thumbEl = thumbRef.current;
    if (!wrapEl || !scrollEl || !trackEl || !thumbEl) return;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let rafId = 0;
    let activeStopDrag: (() => void) | undefined;

    const sync = () => {
      rafId = 0;
      const sh = scrollEl.scrollHeight;
      const ch = scrollEl.clientHeight;
      const overflow = sh - ch;
      if (overflow <= 1 || ch <= 0) {
        wrapEl.classList.remove('has-overflow');
        return;
      }
      wrapEl.classList.add('has-overflow');
      const trackH = Math.max(0, trackEl.clientHeight || ch - 8);
      const thumbH = Math.min(trackH, Math.max(MIN_THUMB_PX, Math.round((ch / sh) * trackH)));
      const maxY = Math.max(0, trackH - thumbH);
      const clampedTop = Math.min(overflow, Math.max(0, scrollEl.scrollTop));
      const y = maxY > 0 ? Math.round((clampedTop / overflow) * maxY) : 0;
      thumbEl.style.height = `${thumbH}px`;
      thumbEl.style.transform = `translateY(${y}px)`;
    };

    const scheduleSync = () => {
      if (!rafId) rafId = requestAnimationFrame(sync);
    };

    const onScroll = () => {
      sync();
      if (!idleTimer) wrapEl.classList.add('is-scrolling');
      else clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        wrapEl.classList.remove('is-scrolling');
      }, idleMs);
    };

    const onEnter = () => {
      wrapEl.classList.add('is-pointer-in');
      sync();
    };
    const onLeave = () => {
      wrapEl.classList.remove('is-pointer-in');
    };

    const onThumbDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startScrollTop = scrollEl.scrollTop;
      wrapEl.classList.add('is-dragging');
      try {
        thumbEl.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic CDP mouse events may not hold an active pointerId; window listeners still drive the drag.
      }

      const onMove = (ev: PointerEvent) => {
        const sh = scrollEl.scrollHeight;
        const ch = scrollEl.clientHeight;
        const overflow = Math.max(0, sh - ch);
        if (overflow <= 0) return;
        const trackH = Math.max(1, trackEl.clientHeight || ch - 8);
        const thumbH = Math.min(trackH, Math.max(MIN_THUMB_PX, Math.round((ch / sh) * trackH)));
        const maxY = Math.max(1, trackH - thumbH);
        scrollEl.scrollTop = startScrollTop + ((ev.clientY - startY) / maxY) * overflow;
      };

      const stopDrag = () => {
        if (activeStopDrag === stopDrag) activeStopDrag = undefined;
        wrapEl.classList.remove('is-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stopDrag);
        window.removeEventListener('pointercancel', stopDrag);
      };

      activeStopDrag?.();
      activeStopDrag = stopDrag;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
    };

    const onTrackDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== trackEl) return;
      e.preventDefault();
      e.stopPropagation();
      const sh = scrollEl.scrollHeight;
      const ch = scrollEl.clientHeight;
      const overflow = Math.max(0, sh - ch);
      if (overflow <= 0) return;
      const rect = trackEl.getBoundingClientRect();
      const thumbH = thumbEl.offsetHeight || MIN_THUMB_PX;
      const maxY = Math.max(1, rect.height - thumbH);
      const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top - thumbH / 2) / maxY));
      scrollEl.scrollTop = ratio * overflow;
    };

    sync();

    const ro = new ResizeObserver(scheduleSync);
    ro.observe(scrollEl);

    const mo = new MutationObserver(scheduleSync);
    mo.observe(scrollEl, { childList: true, subtree: true });

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    wrapEl.addEventListener('pointerenter', onEnter);
    wrapEl.addEventListener('pointerleave', onLeave);
    thumbEl.addEventListener('pointerdown', onThumbDown);
    trackEl.addEventListener('pointerdown', onTrackDown);

    return () => {
      ro.disconnect();
      mo.disconnect();
      scrollEl.removeEventListener('scroll', onScroll);
      wrapEl.removeEventListener('pointerenter', onEnter);
      wrapEl.removeEventListener('pointerleave', onLeave);
      thumbEl.removeEventListener('pointerdown', onThumbDown);
      trackEl.removeEventListener('pointerdown', onTrackDown);
      activeStopDrag?.();
      if (rafId) cancelAnimationFrame(rafId);
      if (idleTimer) clearTimeout(idleTimer);
      wrapEl.classList.remove('has-overflow', 'is-scrolling', 'is-pointer-in', 'is-dragging');
    };
  }, [wrapRef, scrollRef, trackRef, thumbRef, idleMs]);
}
