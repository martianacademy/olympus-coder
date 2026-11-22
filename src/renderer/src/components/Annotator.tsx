import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sheet } from './Sheet';
import {
  ArrowUpRight,
  Circle,
  Film,
  Highlighter,
  Lasso,
  Loader2,
  MapPin,
  Pause,
  Pen,
  Play,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { AttachmentView } from '@shared/types';
import { api } from '../api';
import { addDraftFiles, removeDraftFile } from '../drafts';
import {
  buildLegend,
  COLORS,
  drawMarks,
  fitSize,
  fmtTime,
  fontSize,
  frameTimes,
  isMeaningful,
  markedName,
  nextPinNumber,
  sheetLayout,
  toImagePoint,
  toScreenPoint,
  unitFor,
  type Mark,
  type Pt,
  type ToolId,
  type WidthId,
} from '../annotate/marks';
import { ErrorBoundary } from './ErrorBoundary';
import { addFilesToMessage, addToMessage } from './AddToMessage';
import '../annotate.css';

/**
 * Mark up an image (or frames of a video) before sending it to an agent: pen, highlighter, rectangle, circle, arrow,
 * freehand shape, text and numbered pins. "Done" bakes the marks into a new PNG at the original's resolution, saves
 * it like any attachment and puts it in the draft with a legend (`AttachmentView.note`) that the agent receives as
 * text right before the image (`attachments.ts` → `toBlocks`). Videos: mark one frame (PNG named with its time) or
 * one area over a time range (a contact sheet of 4–6 frames with the marks and timestamps). Rendered in its own root
 * on `document.body`, like the media viewer. Geometry and legend live in `annotate/marks.ts`.
 */

export interface AnnotateSource {
  path: string;
  name: string;
  mime: string;
}
/** Where the result goes: a composer draft that already holds the original, or the composer on screen. */
export type AnnotateTarget = { draftKey: string } | { composer: true };

export const canAnnotate = (mime: string) => mime.startsWith('image/') || mime.startsWith('video/');

let root: Root | null = null;
function render(node: React.ReactNode) {
  if (!root) {
    const host = document.createElement('div');
    host.className = 'an-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root.render(node);
}

export function closeAnnotator() {
  render(null);
}

export function openAnnotator(src: AnnotateSource, target: AnnotateTarget) {
  render(
    <ErrorBoundary label="Mark up" onClose={closeAnnotator}>
      <Annotator key={Date.now()} src={src} target={target} />
    </ErrorBoundary>,
  );
}

/** A baked PNG waiting to be saved: display name (may hold ':'), the legend, and the pixels. */
interface Output {
  name: string;
  note: string;
  blob: Blob;
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(b);
  });
}

function canvasBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the PNG'))), 'image/png'));
}

/** The original's pixels with the marks drawn 1:1 on top, as a PNG of the same size. */
export async function bakePng(base: CanvasImageSource, w: number, h: number, marks: readonly Mark[]): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(base, 0, 0, w, h);
  drawMarks(ctx, marks, unitFor(w, h));
  return canvasBlob(c);
}

/** Seeks `v` to `t` and resolves once the frame is decoded (or after 4 s). */
function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(timer);
      // One more frame so the decoded picture is the one drawn.
      requestAnimationFrame(() => resolve());
    };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

function grabFrame(v: HTMLVideoElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
  return c;
}

/** 4–6 frames from the range in a grid, the marks drawn on each and its timestamp printed under it. */
async function bakeSheet(v: HTMLVideoElement, times: number[], marks: readonly Mark[]): Promise<Blob> {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const L = sheetLayout(times.length, vw, vh);
  const c = document.createElement('canvas');
  c.width = L.width;
  c.height = L.height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#16161a';
  ctx.fillRect(0, 0, L.width, L.height);
  const unit = unitFor(vw, vh);
  const was = v.currentTime;
  for (let i = 0; i < times.length; i++) {
    const cell = L.cells[i];
    await seek(v, times[i]);
    ctx.drawImage(v, cell.x, cell.y, L.cellW, L.cellH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, L.cellW, L.cellH);
    ctx.clip();
    ctx.translate(cell.x, cell.y);
    ctx.scale(cell.scale, cell.scale);
    drawMarks(ctx, marks, unit);
    ctx.restore();
    ctx.fillStyle = '#ececf1';
    ctx.font = `600 ${Math.round(L.labelH * 0.5)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${i + 1}  ·  ${fmtTime(times[i])}`, cell.x + L.cellW / 2, cell.y + L.cellH + L.labelH / 2);
  }
  await seek(v, was);
  return canvasBlob(c);
}

// ---------- the editor ----------

const TOOLS: { id: ToolId; label: string; key: string; icon: React.ReactNode }[] = [
  { id: 'pen', label: 'Pen', key: 'p', icon: <Pen size={16} /> },
  { id: 'highlighter', label: 'Highlighter', key: 'h', icon: <Highlighter size={16} /> },
  { id: 'rect', label: 'Rectangle', key: 'r', icon: <Square size={16} /> },
  { id: 'ellipse', label: 'Circle', key: 'o', icon: <Circle size={16} /> },
  { id: 'arrow', label: 'Arrow', key: 'a', icon: <ArrowUpRight size={16} /> },
  { id: 'shape', label: 'Freehand shape', key: 'f', icon: <Lasso size={16} /> },
  { id: 'text', label: 'Text', key: 't', icon: <Type size={16} /> },
  { id: 'pin', label: 'Numbered pin', key: 'n', icon: <MapPin size={16} /> },
];
const WIDTHS: { id: WidthId; label: string }[] = [
  { id: 0, label: 'Thin' },
  { id: 1, label: 'Medium' },
  { id: 2, label: 'Thick' },
];
const mod = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+');

/** Undo/redo history of the whole mark list. */
function useHistory() {
  const [h, setH] = useState<{ stack: Mark[][]; i: number }>({ stack: [[]], i: 0 });
  const marks = h.stack[h.i];
  /** Adds a state; `next` gets the current marks (an updater, so two pushes in one tick both land). */
  const push = useCallback(
    (next: Mark[] | ((cur: Mark[]) => Mark[])) =>
      setH((s) => ({ stack: [...s.stack.slice(0, s.i + 1), typeof next === 'function' ? next(s.stack[s.i]) : next], i: s.i + 1 })),
    [],
  );
  return {
    marks,
    push,
    canUndo: h.i > 0,
    canRedo: h.i < h.stack.length - 1,
    undo: () => setH((s) => ({ ...s, i: Math.max(0, s.i - 1) })),
    redo: () => setH((s) => ({ ...s, i: Math.min(s.stack.length - 1, s.i + 1) })),
  };
}

interface EditorProps {
  base: HTMLImageElement | HTMLCanvasElement;
  w: number;
  h: number;
  title: string;
  /** Muted line under the title (e.g. what a range sheet will contain). */
  hint?: string;
  doneLabel: string;
  /** Video frames may go out without marks. */
  allowEmpty?: boolean;
  /** Below the tools (e.g. "Also send the original"). */
  footer?: React.ReactNode;
  onCancel: () => void;
  onDone: (marks: Mark[]) => Promise<void>;
}

const ZOOM_MAX = 8;
/** One press of − / + (or the keys) zooms by this much. */
const ZOOM_STEP = 1.5;

function MarkEditor({ base, w, h, title, hint, doneLabel, allowEmpty, footer, onCancel, onDone }: EditorProps) {
  const hist = useHistory();
  const { marks } = hist;
  const [tool, setTool] = useState<ToolId>('ellipse');
  const [color, setColor] = useState(COLORS[0].hex);
  const [width, setWidth] = useState<WidthId>(1);
  const [box, setBox] = useState<{ w: number; h: number; scale: number } | null>(null);
  const [text, setText] = useState<{ at: Pt; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const baseCanvas = useRef<HTMLCanvasElement>(null);
  const markCanvas = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const live = useRef<{ mark: Mark; pointerId: number } | null>(null);
  const frame = useRef(0);
  const unit = unitFor(w, h);
  // Zoom of the picture on screen (marks stay in image pixels: `pointAt` reads the canvas's on-screen rect).
  const [zoom, setZoomState] = useState({ s: 1, x: 0, y: 0 });
  const zoomNow = useRef(zoom);
  // Canvas pixel density follows the zoom (1, 2 or 4 ×), once the zoom settles, so zoomed lines stay sharp.
  const [sharp, setSharp] = useState(1);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number; mx: number; my: number } | null>(null);
  const tapAction = useRef<{ pointerId: number; x: number; y: number; p: Pt } | null>(null);

  // Fit the image into the stage (re-measured on resize / rotation).
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const pad = r.width < 600 ? 8 : 28;
      setBox(fitSize(w, h, Math.max(40, r.width - pad * 2), Math.max(40, r.height - pad * 2)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);

  const baseDpr = Math.min(3, window.devicePixelRatio || 1);
  // Big zooms of big pictures: keep each canvas under ~24 M pixels.
  const dpr = box ? Math.min(baseDpr * sharp, Math.sqrt(24e6 / Math.max(1, box.w * box.h))) : baseDpr;
  const sizeCanvas = useCallback(
    (c: HTMLCanvasElement | null) => {
      if (!c || !box) return null;
      const bw = Math.round(box.w * dpr);
      const bh = Math.round(box.h * dpr);
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh;
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);
      return ctx;
    },
    [box, dpr],
  );

  useEffect(() => {
    const ctx = sizeCanvas(baseCanvas.current);
    if (!ctx) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }, [base, sizeCanvas]);

  const redraw = useCallback(() => {
    const ctx = sizeCanvas(markCanvas.current);
    if (!ctx || !box) return;
    const s = (box.w / w) * dpr;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    drawMarks(ctx, marks, unit);
    if (live.current) drawMarks(ctx, [live.current.mark], unit);
  }, [sizeCanvas, box, w, dpr, marks, unit]);
  useEffect(redraw, [redraw]);
  // The frame callback must draw the LATEST marks: a pointerup schedules a frame and commits the mark in the same
  // tick, and a stale `redraw` from that render would wipe the new mark until the next change.
  const redrawNow = useRef(redraw);
  redrawNow.current = redraw;
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const schedule = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      redrawNow.current();
    });
  };

  /** Sets the zoom, keeping the picture over the stage (pan only as far as the zoomed picture is bigger). */
  const applyZoom = useCallback(
    (next: { s: number; x: number; y: number }) => {
      const s = Math.min(ZOOM_MAX, Math.max(1, next.s));
      let { x, y } = next;
      const st = stage.current;
      if (s === 1 || !st || !box) {
        x = 0;
        y = 0;
      } else {
        const mx = Math.max(0, (box.w * s - st.clientWidth) / 2);
        const my = Math.max(0, (box.h * s - st.clientHeight) / 2);
        x = Math.min(mx, Math.max(-mx, x));
        y = Math.min(my, Math.max(-my, y));
      }
      zoomNow.current = { s, x, y };
      setZoomState(zoomNow.current);
    },
    [box],
  );
  /** Zoom to `s` keeping the screen point (cx, cy) still. */
  const zoomAt = useCallback(
    (s: number, cx: number, cy: number) => {
      const st = stage.current;
      if (!st) return;
      const r = st.getBoundingClientRect();
      const px = cx - (r.left + r.width / 2);
      const py = cy - (r.top + r.height / 2);
      const cur = zoomNow.current;
      const next = Math.min(ZOOM_MAX, Math.max(1, s));
      const k = next / cur.s;
      applyZoom({ s: next, x: px - k * (px - cur.x), y: py - k * (py - cur.y) });
    },
    [applyZoom],
  );
  const zoomBy = (k: number) => {
    const r = stage.current?.getBoundingClientRect();
    if (r) zoomAt(zoomNow.current.s * k, r.left + r.width / 2, r.top + r.height / 2);
  };
  // A new size of the stage / picture: keep the zoom inside the new bounds.
  useEffect(() => applyZoom(zoomNow.current), [applyZoom]);
  useEffect(() => {
    const t = setTimeout(() => setSharp(zoom.s >= 3 ? 4 : zoom.s > 1.2 ? 2 : 1), 180);
    return () => clearTimeout(t);
  }, [zoom.s]);

  // Trackpad: a pinch arrives as ctrl + wheel (zoom around the pointer); two-finger scroll pans once zoomed.
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(zoomNow.current.s * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else if (zoomNow.current.s > 1) applyZoom({ ...zoomNow.current, x: zoomNow.current.x - e.deltaX, y: zoomNow.current.y - e.deltaY });
    };
    st.addEventListener('wheel', onWheel, { passive: false });
    return () => st.removeEventListener('wheel', onWheel);
  }, [zoomAt, applyZoom]);

  const pointAt = (e: { clientX: number; clientY: number }): Pt => toImagePoint(e.clientX, e.clientY, markCanvas.current!.getBoundingClientRect(), w, h);

  // The text being typed, readable synchronously (pointerdown + blur can both try to commit it).
  const textNow = useRef(text);
  textNow.current = text;
  const { push } = hist;
  const commitText = useCallback(() => {
    const t = textNow.current;
    textNow.current = null;
    setText(null);
    if (t?.value.trim()) {
      const mark: Mark = { kind: 'text', color, width, points: [t.at], text: t.value.replace(/\s+$/, '') };
      push((cur) => [...cur, mark]);
    }
  }, [push, color, width]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || busy) return;
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        // Two fingers: zoom / pan, not a mark. Drop what the first finger started.
        live.current = null;
        tapAction.current = null;
        schedule();
        for (const id of touches.current.keys()) {
          try {
            if (!e.currentTarget.hasPointerCapture(id)) e.currentTarget.setPointerCapture(id);
          } catch {
            /* that finger is already gone */
          }
        }
        const [a, b] = [...touches.current.values()];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: zoomNow.current.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        return;
      }
      if (touches.current.size > 2 || pinch.current) return;
    }
    if (live.current) return; // a second finger while drawing
    if (text) {
      // Tapping elsewhere ends the text being typed.
      e.preventDefault();
      commitText();
      return;
    }
    const p = pointAt(e);
    if (e.pointerType === 'touch' && (tool === 'text' || tool === 'pin')) {
      // On touch, a pin / text box waits for the finger to lift: it may be the first finger of a pinch.
      e.currentTarget.setPointerCapture(e.pointerId);
      tapAction.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, p };
      return;
    }
    if (tool === 'text') {
      e.preventDefault();
      setText({ at: p, value: '' });
      return;
    }
    if (tool === 'pin') {
      push((cur) => [...cur, { kind: 'pin', color, width, points: [p], n: nextPinNumber(cur) }]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    live.current = { pointerId: e.pointerId, mark: { kind: tool, color, width, points: [p, p] } };
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pz = pinch.current;
      if (pz && touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        zoomAt((pz.s * Math.hypot(a.x - b.x, a.y - b.y)) / pz.d, mx, my);
        applyZoom({ ...zoomNow.current, x: zoomNow.current.x + mx - pz.mx, y: zoomNow.current.y + my - pz.my });
        pz.mx = mx;
        pz.my = my;
        return;
      }
    }
    const l = live.current;
    if (!l || l.pointerId !== e.pointerId) return;
    const m = l.mark;
    if (m.kind === 'pen' || m.kind === 'highlighter' || m.kind === 'shape') {
      const evs = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
      const minStep = 1.2 / (((box?.scale ?? 1) || 1) * zoomNow.current.s);
      for (const ev of evs.length ? evs : [e.nativeEvent]) {
        const p = pointAt(ev);
        const last = m.points[m.points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minStep) m.points.push(p);
      }
    } else {
      m.points = [m.points[0], pointAt(e)];
    }
    schedule();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId);
      if (pinch.current) {
        if (!touches.current.size) pinch.current = null;
        return;
      }
      const ta = tapAction.current;
      if (ta && ta.pointerId === e.pointerId) {
        tapAction.current = null;
        if (e.type !== 'pointercancel' && Math.hypot(e.clientX - ta.x, e.clientY - ta.y) < 12) {
          if (tool === 'text') setText({ at: ta.p, value: '' });
          else push((cur) => [...cur, { kind: 'pin', color, width, points: [ta.p], n: nextPinNumber(cur) }]);
        }
        return;
      }
    }
    const l = live.current;
    if (!l || l.pointerId !== e.pointerId) return;
    live.current = null;
    if (e.type !== 'pointercancel') {
      const m = l.mark;
      if (m.kind === 'pen' || m.kind === 'highlighter' || m.kind === 'shape') {
        // A tap with the pen still leaves a dot; the doubled first point is dropped.
        if (m.points.length > 2) m.points.splice(1, 1);
      }
      if (isMeaningful(m, unit) || (m.kind === 'pen' && m.points.length)) push((cur) => [...cur, m]);
    }
    schedule();
  };

  // Text field focus when it opens.
  useEffect(() => {
    if (text && textRef.current && document.activeElement !== textRef.current) textRef.current.focus({ preventScroll: true });
  }, [text]);

  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const done = async () => {
    if (busy) return;
    const t = textNow.current;
    const list = t?.value.trim() ? [...marks, { kind: 'text' as const, color, width, points: [t.at], text: t.value.trim() }] : marks;
    textNow.current = null;
    setText(null);
    if (!list.length && !allowEmpty) return;
    setBusy(true);
    setError('');
    try {
      await onDone(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = (e.target as HTMLElement).closest('textarea, input');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (text) setText(null);
      else if (!marks.length) onCancel();
      return;
    }
    if (typing) return;
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) hist.redo();
      else hist.undo();
      return;
    }
    if (cmd && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      hist.redo();
      return;
    }
    if (cmd && e.key === 'Enter') {
      e.preventDefault();
      void done();
      return;
    }
    if (cmd || e.altKey) return;
    if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') {
      e.preventDefault();
      if (e.key === '0') applyZoom({ s: 1, x: 0, y: 0 });
      else zoomBy(e.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP);
      return;
    }
    const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (t) setTool(t.id);
  };

  const canDone = !busy && (allowEmpty || marks.length > 0 || Boolean(text?.value.trim()));
  const textPos = text && box ? toScreenPoint(text.at, { width: box.w, height: box.h }, w, h) : null;

  return (
    <Sheet
      ref={rootRef}
      className="an-root"
      sheetClassName="an-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Mark up ${title}`}
      tabIndex={-1}
      data-testid="annotator"
      data-tool={tool}
      data-marks={marks.length}
      onKeyDown={onKeyDown}
    >
      <div className="sheet-bar an-bar">
        <button type="button" className="an-icon" title="Cancel (Esc)" aria-label="Cancel" data-testid="an-cancel" onClick={onCancel}>
          <X size={17} />
        </button>
        <div className="an-title">
          <span className="ellipsis an-name">{title}</span>
          {hint && <span className="ellipsis an-hint">{hint}</span>}
        </div>
        <button type="button" className="an-icon an-zoom-out" title="Zoom out (−)" aria-label="Zoom out" data-testid="an-zoom-out" disabled={zoom.s <= 1} onClick={() => zoomBy(1 / ZOOM_STEP)}>
          <ZoomOut size={16} />
        </button>
        {zoom.s !== 1 && (
          <button type="button" className="an-icon an-zoom-pct mono" title="Reset zoom (0)" data-testid="an-zoom-reset" onClick={() => applyZoom({ s: 1, x: 0, y: 0 })}>
            {Math.round(zoom.s * 100)}%
          </button>
        )}
        <button type="button" className="an-icon" title="Zoom in (+) — or pinch on the trackpad" aria-label="Zoom in" data-testid="an-zoom-in" disabled={zoom.s >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>
          <ZoomIn size={16} />
        </button>
        <span className="an-bar-sep" aria-hidden="true" />
        <button type="button" className="an-icon" title={`Undo (${mod()}Z)`} aria-label="Undo" data-testid="an-undo" disabled={!hist.canUndo} onClick={hist.undo}>
          <Undo2 size={16} />
        </button>
        <button type="button" className="an-icon" title={`Redo (${mod()}⇧Z)`} aria-label="Redo" data-testid="an-redo" disabled={!hist.canRedo} onClick={hist.redo}>
          <Redo2 size={16} />
        </button>
        <button type="button" className="an-icon" title="Clear all marks" aria-label="Clear all marks" data-testid="an-clear" disabled={!marks.length} onClick={() => hist.push([])}>
          <Trash2 size={16} />
        </button>
        <button type="button" className="btn primary small an-done" disabled={!canDone} title={`${doneLabel} (${mod()}Enter)`} data-testid="an-done" onClick={() => void done()}>
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {doneLabel}
        </button>
      </div>

      <div className="an-stage" ref={stage}>
        {box && (
          <div
            className="an-canvas-box"
            data-testid="an-canvas-box"
            data-zoom={zoom.s.toFixed(2)}
            style={{ width: box.w, height: box.h, transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.s})` }}
          >
            <canvas ref={baseCanvas} className="an-canvas" style={{ width: box.w, height: box.h }} aria-hidden="true" />
            <canvas
              ref={markCanvas}
              className={`an-canvas an-marks tool-${tool}`}
              style={{ width: box.w, height: box.h }}
              data-testid="an-canvas"
              data-nat-w={w}
              data-nat-h={h}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            {text && textPos && box && (
              <textarea
                ref={textRef}
                className="an-text"
                data-testid="an-text"
                rows={1}
                spellCheck={false}
                placeholder="Type here"
                value={text.value}
                style={{
                  left: textPos[0],
                  top: textPos[1],
                  color,
                  fontSize: fontSize(width, unit) * box.scale,
                  maxWidth: Math.max(80, box.w - textPos[0]),
                }}
                onChange={(e) => setText({ ...text, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    commitText();
                  }
                }}
                onBlur={commitText}
              />
            )}
          </div>
        )}
      </div>

      <div className="an-tools" role="toolbar" aria-label="Markup tools">
        <div className="an-group" role="radiogroup" aria-label="Tool">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={tool === t.id}
              className={`an-tool ${tool === t.id ? 'on' : ''}`}
              title={`${t.label} (${t.key.toUpperCase()})`}
              aria-label={t.label}
              data-testid={`an-tool-${t.id}`}
              onClick={() => {
                if (text) commitText();
                setTool(t.id);
              }}
            >
              {t.icon}
            </button>
          ))}
        </div>
        <span className="an-sep" aria-hidden="true" />
        <div className="an-group" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c.hex}
              type="button"
              role="radio"
              aria-checked={color === c.hex}
              className={`an-swatch ${color === c.hex ? 'on' : ''}`}
              title={c.name[0].toUpperCase() + c.name.slice(1)}
              aria-label={c.name}
              data-testid={`an-color-${c.name}`}
              style={{ ['--sw' as string]: c.hex }}
              onClick={() => setColor(c.hex)}
            >
              <span />
            </button>
          ))}
        </div>
        <span className="an-sep" aria-hidden="true" />
        <div className="an-group" role="radiogroup" aria-label="Size">
          {WIDTHS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={width === x.id}
              className={`an-tool an-width ${width === x.id ? 'on' : ''}`}
              title={x.label}
              aria-label={x.label}
              data-testid={`an-width-${x.id}`}
              onClick={() => setWidth(x.id)}
            >
              <span style={{ width: 4 + x.id * 4, height: 4 + x.id * 4 }} />
            </button>
          ))}
        </div>
      </div>
      {(footer || error) && (
        <div className="an-foot">
          {footer}
          {error && <span className="error-text small ellipsis">{error}</span>}
        </div>
      )}
    </Sheet>
  );
}

function OriginalToggle({ on, onChange, label = 'Also send the original' }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="an-check" data-testid="an-keep-original">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ---------- delivery ----------

async function deliver(outputs: Output[], src: AnnotateSource, target: AnnotateTarget, keepOriginal: boolean): Promise<void> {
  const saved: AttachmentView[] = [];
  for (const o of outputs) {
    const a = await api.saveAttachment(o.name.replace(/:/g, '.'), 'image/png', await blobToBase64(o.blob));
    saved.push({ ...a, name: o.name, mime: 'image/png', note: o.note });
  }
  if ('draftKey' in target) {
    addDraftFiles(target.draftKey, saved);
    if (!keepOriginal) removeDraftFile(target.draftKey, src.path);
    return;
  }
  if (keepOriginal) await addToMessage(src.path, { name: src.name, mime: src.mime });
  if (!addFilesToMessage(saved)) throw new Error('Open a chat to add the marked image to a message.');
}

// ---------- image / video shells ----------

function useSource(src: AnnotateSource) {
  const [state, setState] = useState<{ dataUrl?: string; error?: string }>({});
  useEffect(() => {
    let alive = true;
    api
      .preview(src.path)
      .then((d) => {
        if (!alive) return;
        if (d.kind === 'too-large') setState({ error: `${src.name} is too large to mark up here.` });
        else if (d.kind === 'missing') setState({ error: `${src.name} no longer exists.` });
        else if (!d.dataUrl) setState({ error: `Can't open ${src.name} here.` });
        else setState({ dataUrl: d.dataUrl });
      })
      .catch((e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [src.path, src.name]);
  return state;
}

function Shell({ title, children, onClose }: { title: string; children?: React.ReactNode; onClose: () => void }) {
  return (
    <Sheet
      className="an-root"
      sheetClassName="an-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Mark up ${title}`}
      tabIndex={-1}
      data-testid="annotator"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="sheet-bar an-bar">
        <button type="button" className="an-icon" title="Close (Esc)" aria-label="Close" data-testid="an-cancel" onClick={onClose}>
          <X size={17} />
        </button>
        <div className="an-title">
          <span className="ellipsis an-name">{title}</span>
        </div>
      </div>
      <div className="an-stage an-center">{children ?? <Loader2 size={20} className="spin muted" />}</div>
    </Sheet>
  );
}

function Annotator({ src, target }: { src: AnnotateSource; target: AnnotateTarget }) {
  return src.mime.startsWith('video/') ? <VideoAnnotator src={src} target={target} /> : <ImageAnnotator src={src} target={target} />;
}

function ImageAnnotator({ src, target }: { src: AnnotateSource; target: AnnotateTarget }) {
  const { dataUrl, error } = useSource(src);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState('');
  // Off by default: people mark up a picture to replace it; they tick the box when the agent should see both.
  const [keep, setKeep] = useState(false);
  useEffect(() => {
    if (!dataUrl) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setLoadError(`Can't read ${src.name} as an image.`);
    i.src = dataUrl;
  }, [dataUrl, src.name]);
  if (error || loadError) return <Shell title={src.name} onClose={closeAnnotator}><div className="an-error">{error || loadError}</div></Shell>;
  if (!img) return <Shell title={src.name} onClose={closeAnnotator} />;
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  return (
    <MarkEditor
      base={img}
      w={w}
      h={h}
      title={src.name}
      doneLabel="Done"
      footer={<OriginalToggle on={keep} onChange={setKeep} />}
      onCancel={closeAnnotator}
      onDone={async (marks) => {
        const blob = await bakePng(img, w, h, marks);
        await deliver([{ name: markedName(src.name), note: buildLegend(marks, { source: src.name, width: w, height: h }), blob }], src, target, keep);
        closeAnnotator();
      }}
    />
  );
}

/** Makes a WebM from MediaRecorder report its real duration (it says Infinity until the end has been seen). */
async function settleDuration(v: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(v.duration)) return v.duration;
  await new Promise<void>((resolve) => {
    const on = () => {
      if (!Number.isFinite(v.duration)) return;
      v.removeEventListener('durationchange', on);
      v.removeEventListener('seeked', on);
      resolve();
    };
    v.addEventListener('durationchange', on);
    v.addEventListener('seeked', on);
    v.currentTime = 1e7;
    setTimeout(resolve, 3000);
  });
  await seek(v, 0);
  return Number.isFinite(v.duration) ? v.duration : 0;
}

type VideoMode = { kind: 'pick' } | { kind: 'frame'; frame: HTMLCanvasElement; t: number } | { kind: 'range'; frame: HTMLCanvasElement; start: number; end: number };

function VideoAnnotator({ src, target }: { src: AnnotateSource; target: AnnotateTarget }) {
  const { dataUrl, error } = useSource(src);
  const video = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [range, setRange] = useState<{ start?: number; end?: number }>({});
  const [mode, setMode] = useState<VideoMode>({ kind: 'pick' });
  const [outputs, setOutputs] = useState<Output[]>([]);
  // Off by default: people mark up a picture to replace it; they tick the box when the agent should see both.
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (mode.kind === 'pick') rootRef.current?.focus({ preventScroll: true });
  }, [mode.kind]);

  const onMeta = async () => {
    const v = video.current;
    if (!v) return;
    const d = await settleDuration(v);
    setDuration(d);
    setT(v.currentTime);
  };

  const scrub = (to: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(duration || 0, to));
    setT(v.currentTime);
  };

  const start = range.start;
  const end = range.end;
  const hasRange = start !== undefined && end !== undefined && Math.abs(end - start) >= 0.2;
  const lo = hasRange ? Math.min(start!, end!) : 0;
  const hi = hasRange ? Math.max(start!, end!) : 0;
  const times = hasRange ? frameTimes(lo, hi, duration) : [];

  const markFrame = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    v.pause();
    setMode({ kind: 'frame', frame: grabFrame(v), t: v.currentTime });
  };
  const markRange = async () => {
    const v = video.current;
    if (!v || !hasRange) return;
    v.pause();
    await seek(v, lo);
    setT(v.currentTime);
    setMode({ kind: 'range', frame: grabFrame(v), start: lo, end: hi });
  };

  const finish = async () => {
    if (!outputs.length || busy) return;
    setBusy(true);
    setNote('');
    try {
      await deliver(outputs, src, target, keep);
      closeAnnotator();
    } catch (e: unknown) {
      setNote(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (error) return <Shell title={src.name} onClose={closeAnnotator}><div className="an-error">{error}</div></Shell>;

  const v = video.current;
  const vw = v?.videoWidth ?? 0;
  const vh = v?.videoHeight ?? 0;
  const pct = (x: number) => (duration ? `${(x / duration) * 100}%` : '0%');

  return (
    <>
      <Sheet
        ref={rootRef}
        className="an-root an-video"
        sheetClassName="an-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Mark up ${src.name}`}
        tabIndex={-1}
        data-testid="annotator"
        data-mode="video"
        data-duration={duration}
        data-time={t}
        data-ready={outputs.length}
        hidden={mode.kind !== 'pick'}
        onKeyDown={(e) => {
          if (mode.kind !== 'pick') return;
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (!outputs.length) closeAnnotator();
          } else if (e.key === ' ' && !(e.target as HTMLElement).closest('button, input')) {
            e.preventDefault();
            if (v?.paused) void v.play();
            else v?.pause();
          }
        }}
      >
        <div className="sheet-bar an-bar">
          <button type="button" className="an-icon" title="Cancel (Esc)" aria-label="Cancel" data-testid="an-cancel" onClick={closeAnnotator}>
            <X size={17} />
          </button>
          <div className="an-title">
            <span className="ellipsis an-name">{src.name}</span>
            <span className="ellipsis an-hint">Agents can't watch video — marked frames go as images</span>
          </div>
          <button type="button" className="btn primary small an-done" disabled={!outputs.length || busy} data-testid="an-video-done" onClick={() => void finish()}>
            {busy ? <Loader2 size={14} className="spin" /> : null}
            {outputs.length ? `Add ${outputs.length} image${outputs.length > 1 ? 's' : ''}` : 'Done'}
          </button>
        </div>
        <div className="an-stage an-center">
          {!dataUrl ? (
            <Loader2 size={20} className="spin muted" />
          ) : (
            <video
              ref={video}
              className="an-player"
              src={dataUrl}
              playsInline
              preload="auto"
              muted
              data-testid="an-video"
              onLoadedMetadata={() => void onMeta()}
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
            />
          )}
        </div>
        <div className="an-scrub">
          <button
            type="button"
            className="an-icon"
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!duration}
            onClick={() => (v?.paused ? void v.play() : v?.pause())}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div className="an-track">
            {hasRange && <span className="an-range-band" style={{ left: pct(lo), width: pct(hi - lo) }} />}
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={t}
              disabled={!duration}
              aria-label="Video position"
              data-testid="an-scrubber"
              onChange={(e) => scrub(Number(e.target.value))}
            />
          </div>
          <span className="an-time mono" data-testid="an-time">
            {fmtTime(t)} <span className="muted">/ {fmtTime(duration)}</span>
          </span>
        </div>
        <div className="an-video-actions">
          <div className="an-range-set">
            <button type="button" className="btn small" disabled={!duration} data-testid="an-set-start" onClick={() => setRange((r) => ({ ...r, start: t }))}>
              Start {start !== undefined ? fmtTime(start) : '—'}
            </button>
            <button type="button" className="btn small" disabled={!duration} data-testid="an-set-end" onClick={() => setRange((r) => ({ ...r, end: t }))}>
              End {end !== undefined ? fmtTime(end) : '—'}
            </button>
            {(start !== undefined || end !== undefined) && (
              <button type="button" className="an-icon" title="Clear the range" aria-label="Clear the range" onClick={() => setRange({})}>
                <X size={14} />
              </button>
            )}
          </div>
          <div className="spacer" />
          <button type="button" className="btn small" disabled={!vw} data-testid="an-mark-frame" onClick={markFrame}>
            <Pen size={13} /> Mark this frame
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!hasRange}
            title={hasRange ? `One image with ${times.length} frames from ${fmtTime(lo)} to ${fmtTime(hi)}` : 'Set a start and an end first'}
            data-testid="an-mark-range"
            onClick={() => void markRange()}
          >
            <Film size={13} /> Mark range{hasRange ? ` · ${times.length} frames` : ''}
          </button>
        </div>
        <div className="an-foot">
          <OriginalToggle on={keep} onChange={setKeep} label="Also send the video" />
          {outputs.length > 0 && (
            <div className="an-outputs" data-testid="an-outputs">
              {outputs.map((o, i) => (
                <span key={`${o.name}-${i}`} className="an-output">
                  <span className="ellipsis">{o.name.replace(/\.png$/, '')}</span>
                  <button type="button" title="Remove" aria-label={`Remove ${o.name}`} onClick={() => setOutputs((l) => l.filter((_, j) => j !== i))}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {note && <span className="error-text small ellipsis">{note}</span>}
        </div>
      </Sheet>
      {mode.kind === 'frame' && (
        <MarkEditor
          base={mode.frame}
          w={mode.frame.width}
          h={mode.frame.height}
          title={`${src.name} · frame ${fmtTime(mode.t)}`}
          doneLabel="Save frame"
          allowEmpty
          onCancel={() => setMode({ kind: 'pick' })}
          onDone={async (marks) => {
            const at = fmtTime(mode.t);
            const blob = await bakePng(mode.frame, mode.frame.width, mode.frame.height, marks);
            const note = buildLegend(marks, { source: `${src.name} at ${at}`, width: mode.frame.width, height: mode.frame.height, extra: 'The marked video frame is the image that follows' });
            setOutputs((l) => [...l, { name: markedName(src.name, `frame ${at}`), note, blob }]);
            setMode({ kind: 'pick' });
          }}
        />
      )}
      {mode.kind === 'range' && (
        <MarkEditor
          base={mode.frame}
          w={mode.frame.width}
          h={mode.frame.height}
          title={`${src.name} · ${fmtTime(mode.start)}–${fmtTime(mode.end)}`}
          hint={`Your marks are drawn on ${frameTimes(mode.start, mode.end, duration).length} frames across this range`}
          doneLabel="Make sheet"
          onCancel={() => setMode({ kind: 'pick' })}
          onDone={async (marks) => {
            const el = video.current!;
            const ts = frameTimes(mode.start, mode.end, duration);
            const blob = await bakeSheet(el, ts, marks);
            const span = `${fmtTime(mode.start)}–${fmtTime(mode.end)}`;
            const note = buildLegend(marks, {
              source: `${src.name}, ${span}`,
              width: el.videoWidth,
              height: el.videoHeight,
              extra: `The image that follows is a contact sheet of ${ts.length} evenly spaced frames (${ts.map(fmtTime).join(', ')}), left to right and top to bottom, each with its timestamp under it; the same marks are drawn on every frame and the coordinates are video-frame pixels`,
            });
            setOutputs((l) => [...l, { name: markedName(src.name, `range ${span}`), note, blob }]);
            setMode({ kind: 'pick' });
          }}
        />
      )}
    </>
  );
}
