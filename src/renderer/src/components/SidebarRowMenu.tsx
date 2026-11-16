import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export interface RowMenuAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  testId?: string;
}

const GAP = 4;
const EDGE = 8;
/** Where a menu opens before it is measured: at the top left, the full screen width is free for its natural width. */
const MEASURE: CSSProperties = { top: 0, left: 0 };

/**
 * One "More" button standing in for a sidebar row's action buttons when the sidebar is the narrow slide-over
 * drawer, so project and session names keep the row's width. The menu is portalled to `body` with fixed
 * positioning: the drawer's scroll area would clip it, and it has to sit above the drawer.
 */
export function SidebarRowMenu(props: { title: string; actions: RowMenuAction[]; testId: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (menu.current?.contains(t) || btn.current?.contains(t))) return;
      setOpen(false);
    };
    // Capture phase, and stopped there: Escape closes just this menu, not the drawer under it (a window keydown listener).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    const dismiss = () => setOpen(false);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', dismiss);
    // The drawer's list scrolling would leave the menu floating away from its row.
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  // Right-aligned under the button, kept `EDGE` inside both sides of the screen; flipped above the button when the
  // row is near the bottom. Measured at `MEASURE`, where the menu has its natural width.
  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = menu.current.offsetWidth;
    const h = menu.current.offsetHeight;
    const left = Math.max(EDGE, Math.min(r.right - w, window.innerWidth - EDGE - w));
    const below = r.bottom + GAP + h <= window.innerHeight - EDGE;
    setPos(below ? { top: r.bottom + GAP, left } : { top: Math.max(EDGE, r.top - GAP - h), left });
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        className={`btn ghost icon row-more ${open ? 'on' : ''}`}
        title={props.title}
        aria-label={props.title}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={props.testId}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) setPos(MEASURE);
          setOpen(!open);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="menu sidebar-row-menu" role="menu" style={pos} data-testid="sidebar-row-menu" onClick={(e) => e.stopPropagation()}>
            {props.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className={`menu-item ${a.danger ? 'danger' : ''}`}
                data-testid={a.testId}
                onClick={() => {
                  setOpen(false);
                  a.onSelect();
                }}
              >
                {a.icon}
                <span className="ellipsis">{a.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
