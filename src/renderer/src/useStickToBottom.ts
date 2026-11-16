import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Distance from the bottom (px) where scrolling back down resumes live following. */
const BOTTOM_SLACK = 36;
/** Window (ms) after an upward key or touch gesture during which an upward scroll pauses following. */
const USER_UP_WINDOW_MS = 400;

/**
 * Keeps a scrolling chat or transcript pinned to its newest content while an agent streams, while letting the
 * user scroll up to read earlier messages without ever being pulled back down.
 *
 * - Following turns off only on real upward user intent (upward wheel/trackpad, upward touch swipe, keyboard
 *   navigation up, or dragging the scrollbar thumb up). Browser-initiated scroll events (layout shifts, tool
 *   cards collapsing, clamping) never disable following.
 * - While paused (`away === true`), gentle upward trackpad scrolling inside `BOTTOM_SLACK` never re-arms
 *   following; following resumes only when the user scrolls downward back into `BOTTOM_SLACK` (or reaches the
 *   very bottom ≤ 2 px), calls `jumpToBottom()`, or sends a new message (`follow()`).
 * - While following, both synchronous React commits (`contentDep`) and asynchronous size changes
 *   (`ResizeObserver` on the scroller and content wrapper: streaming tool output, Markdown/KaTeX layout, images,
 *   composer growth, window resize) pin `scrollTop` to `scrollHeight` before paint.
 */
export function useStickToBottom(
  scrollerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  resetKey: string,
  contentDep?: unknown,
): { away: boolean; jumpToBottom: () => void; follow: () => void; pause: () => void } {
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const lastUpInput = useRef(-Infinity);
  const dragging = useRef(false);
  const lastTouchY = useRef<number | null>(null);
  const lastScrollTop = useRef(0);

  const setStick = useCallback((on: boolean) => {
    stick.current = on;
    if (on) lastUpInput.current = -Infinity;
    setAway((prev) => (prev === !on ? prev : !on));
  }, []);

  const pin = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  }, [scrollerRef]);

  // Switching chats (or initial mount): start pinned at the newest message.
  useLayoutEffect(() => {
    stick.current = true;
    lastUpInput.current = -Infinity;
    dragging.current = false;
    setAway(false);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop.current = el.scrollTop;
    }
  }, [resetKey, scrollerRef]);

  // Synchronous pin right after React mutates messages/items, before paint.
  useLayoutEffect(() => {
    pin();
  }, [contentDep, pin]);

  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el) return;
    lastScrollTop.current = el.scrollTop;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        lastUpInput.current = performance.now();
        if (el.scrollTop > 0 || el.scrollHeight > el.clientHeight + 2) setStick(false);
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y != null && lastTouchY.current != null) {
        // Finger moving down scrolls content up toward older messages.
        if (y > lastTouchY.current + 2 && el.scrollTop > 0) {
          lastUpInput.current = performance.now();
          setStick(false);
        }
        lastTouchY.current = y;
      }
    };
    const onTouchEnd = () => {
      lastTouchY.current = null;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey)) {
        lastUpInput.current = performance.now();
        if (el.scrollTop > 0) setStick(false);
      } else if (e.key === 'End') {
        setStick(true);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      // Only treat presses on the right-edge scrollbar track/thumb as scrollbar dragging, not empty side margins.
      if (e.target === el && e.clientX >= el.getBoundingClientRect().right - 20) {
        dragging.current = true;
      }
    };
    const onPointerUp = () => {
      dragging.current = false;
    };
    const onScroll = () => {
      const top = el.scrollTop;
      const prev = lastScrollTop.current;
      const movedUp = top < prev - 0.5;
      const movedDown = top > prev + 0.5;
      lastScrollTop.current = top;

      const fromBottom = el.scrollHeight - top - el.clientHeight;
      if (!stick.current) {
        if (fromBottom <= 2 || (movedDown && fromBottom <= BOTTOM_SLACK)) {
          setStick(true);
        }
        return;
      }
      if (fromBottom <= BOTTOM_SLACK) return;
      const byUserUp = dragging.current || performance.now() - lastUpInput.current < USER_UP_WINDOW_MS;
      if (movedUp && byUserUp) {
        setStick(false);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('scroll', onScroll, { passive: true });

    const ro = new ResizeObserver(pin);
    ro.observe(el);
    if (content) ro.observe(content);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [resetKey, scrollerRef, contentRef, pin, setStick]);

  const follow = useCallback(() => {
    setStick(true);
    pin();
  }, [pin, setStick]);

  const pause = useCallback(() => {
    setStick(false);
  }, [setStick]);

  return { away, jumpToBottom: follow, follow, pause };
}
