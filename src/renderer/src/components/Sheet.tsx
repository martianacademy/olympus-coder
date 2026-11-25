import { forwardRef, useRef, type HTMLAttributes } from 'react';
import '../sheet.css';

/**
 * The one centered sheet every media overlay opens in (the viewer in `MediaViewer.tsx`, with mark-up inside it):
 * 90% of the window over a translucent blurred backdrop, so the app stays visible around it. The root carries the
 * dialog's own props (role, keys, test ids); `onOutside` closes on a click on the backdrop around the sheet. It waits
 * for the `click`, not `pointerup`, so a touch's follow-up click never lands on the chat underneath.
 */
export const Sheet = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { sheetClassName?: string; onOutside?: () => void }>(function Sheet(
  { className, sheetClassName, onOutside, onPointerDown, onClick, children, ...rest },
  ref,
) {
  const downOutside = useRef(false);
  return (
    <div
      ref={ref}
      {...rest}
      className={`sheet-root${className ? ` ${className}` : ''}`}
      onPointerDown={(e) => {
        downOutside.current = e.target === e.currentTarget;
        onPointerDown?.(e);
      }}
      onClick={(e) => {
        const outside = downOutside.current && e.target === e.currentTarget;
        downOutside.current = false;
        if (outside && onOutside) onOutside();
        onClick?.(e);
      }}
    >
      <div className={`sheet${sheetClassName ? ` ${sheetClassName}` : ''}`}>{children}</div>
    </div>
  );
});
