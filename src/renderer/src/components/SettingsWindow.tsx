import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCcw, X } from 'lucide-react';
import '../settingsWindow.css';

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORAGE_KEY = 'olympus.settingsBounds.v1';
const MIN_W = 380;
const MIN_H = 380;
const EDGE_PAD = 12;

function defaultBounds(): Bounds {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(880, Math.max(MIN_W, vw - 48));
  const h = Math.min(680, Math.max(MIN_H, vh - 48));
  return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
}

function clampBounds(b: Bounds): Bounds {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_W, Math.min(b.w, vw - EDGE_PAD * 2));
  const h = Math.max(MIN_H, Math.min(b.h, vh - EDGE_PAD * 2));
  // Keep at least 120px of header reachable horizontally and fully reachable vertically.
  const x = Math.max(EDGE_PAD - w + 160, Math.min(b.x, vw - 160));
  const y = Math.max(EDGE_PAD, Math.min(b.y, vh - 60));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function readSavedBounds(): Bounds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Bounds>;
    if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.w === 'number' && typeof p.h === 'number') {
      return clampBounds({ x: p.x, y: p.y, w: p.w, h: p.h });
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Floating, draggable, edge-resizable Settings window on desktop (>640px) so the user can move
 * or shrink Settings to inspect live Appearance changes on the app behind it. Uses CSS container
 * queries (`settings-win`) to stay responsive at any width down to 380px.
 */
export function SettingsWindow(props: {
  title: string;
  transparentBackdrop?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [narrowViewport, setNarrowViewport] = useState(() => window.innerWidth <= 640);
  const [bounds, setBounds] = useState<Bounds>(() => readSavedBounds() ?? defaultBounds());
  const [customPos, setCustomPos] = useState(() => Boolean(readSavedBounds()));
  const [dragging, setDragging] = useState(false);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    const onResize = () => {
      const narrow = window.innerWidth <= 640;
      setNarrowViewport(narrow);
      if (!narrow) setBounds((b) => clampBounds(b));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const persist = useCallback((b: Bounds) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
    } catch {
      // ignore quota errors
    }
  }, []);

  const resetLayout = useCallback(() => {
    const def = defaultBounds();
    setBounds(def);
    setCustomPos(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const startDrag = (e: React.PointerEvent) => {
    if (narrowViewport || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = boundsRef.current;
    setDragging(true);
    setCustomPos(true);

    const onMove = (ev: PointerEvent) => {
      const next = clampBounds({ ...orig, x: orig.x + ev.clientX - startX, y: orig.y + ev.clientY - startY });
      setBounds(next);
    };
    const onUp = () => {
      setDragging(false);
      persist(boundsRef.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startResize = (edge: Edge) => (e: React.PointerEvent) => {
    if (narrowViewport || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = boundsRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setDragging(true);
    setCustomPos(true);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, w, h } = orig;

      if (edge.includes('e')) w = Math.max(MIN_W, Math.min(orig.w + dx, vw - orig.x - EDGE_PAD));
      if (edge.includes('s')) h = Math.max(MIN_H, Math.min(orig.h + dy, vh - orig.y - EDGE_PAD));
      if (edge.includes('w')) {
        const right = orig.x + orig.w;
        const nextX = Math.max(EDGE_PAD, Math.min(orig.x + dx, right - MIN_W));
        x = nextX;
        w = right - nextX;
      }
      if (edge.includes('n')) {
        const bottom = orig.y + orig.h;
        const nextY = Math.max(EDGE_PAD, Math.min(orig.y + dy, bottom - MIN_H));
        y = nextY;
        h = bottom - nextY;
      }
      setBounds({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    };
    const onUp = () => {
      setDragging(false);
      persist(boundsRef.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const style: React.CSSProperties | undefined = narrowViewport
    ? undefined
    : { position: 'fixed', left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h, maxHeight: 'none' };

  return (
    <div
      className={`overlay settings-overlay ${props.transparentBackdrop || customPos ? 'is-live-preview' : ''} ${dragging ? 'is-moving' : ''}`}
      data-testid="settings-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className={`modal settings-modal ${dragging ? 'is-moving' : ''}`} style={style} data-testid="settings-modal">
        <div
          className="modal-head settings-drag-head"
          data-testid="settings-drag-head"
          onPointerDown={startDrag}
          onDoubleClick={narrowViewport ? undefined : resetLayout}
          title={narrowViewport ? undefined : 'Drag to move · Double-click to center'}
        >
          <span>{props.title}</span>
          <div className="spacer" />
          {!narrowViewport && customPos && (
            <button type="button" className="btn ghost icon" data-testid="settings-reset-layout" title="Center & reset window size" onClick={resetLayout}>
              <RotateCcw size={13} />
            </button>
          )}
          <button type="button" className="btn ghost icon" data-testid="settings-close" title="Close" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        {props.children}

        {!narrowViewport && (
          <>
            <div className="sw-resize sw-n" onPointerDown={startResize('n')} />
            <div className="sw-resize sw-s" onPointerDown={startResize('s')} />
            <div className="sw-resize sw-e" data-testid="settings-resize-e" onPointerDown={startResize('e')} />
            <div className="sw-resize sw-w" onPointerDown={startResize('w')} />
            <div className="sw-resize sw-ne" onPointerDown={startResize('ne')} />
            <div className="sw-resize sw-nw" onPointerDown={startResize('nw')} />
            <div className="sw-resize sw-se" data-testid="settings-resize-se" onPointerDown={startResize('se')} />
            <div className="sw-resize sw-sw" onPointerDown={startResize('sw')} />
          </>
        )}
      </div>
    </div>
  );
}
