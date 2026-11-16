import { useCallback, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * A height the user picked for the composer's text box by dragging its top edge (per device), so a long prompt
 * never has to cover the chat. No saved height = the box grows with its text up to the CSS cap.
 */
const KEY = 'olympus.composerHeight';
const MIN = 40;
const maxFor = () => Math.max(MIN, Math.round(window.innerHeight * 0.7));

const read = (): number | null => {
  const n = Number(localStorage.getItem(KEY));
  return Number.isFinite(n) && n >= MIN ? n : null;
};

export function useComposerResize(box: React.RefObject<HTMLTextAreaElement | null>) {
  const [height, setHeight] = useState<number | null>(read);

  const save = (h: number | null) => {
    setHeight(h);
    if (h === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(h));
  };

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = box.current?.getBoundingClientRect().height ?? MIN;
      let last = startH;
      const move = (ev: PointerEvent) => {
        // Dragging up makes the box taller.
        last = Math.min(maxFor(), Math.max(MIN, Math.round(startH + (startY - ev.clientY))));
        setHeight(last);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        save(last);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
    [box],
  );

  const reset = useCallback(() => save(null), []);

  const style: CSSProperties | undefined =
    height === null ? undefined : { height: Math.min(height, maxFor()), maxHeight: Math.min(height, maxFor()), fieldSizing: 'fixed', overflowY: 'auto' } as CSSProperties;

  return { style, onPointerDown, reset, sized: height !== null };
}
