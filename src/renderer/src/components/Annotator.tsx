import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Circle,
  Highlighter,
  Lasso,
  MapPin,
  Pen,
  Square,
  Type,
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
  isMeaningful,
  markedName,
  nextPinNumber,
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
 * Mark-up inside the media viewer (`MediaViewer.tsx`): its Edit toggle (or a draft card's pen, which opens the viewer
 * with Edit on) lays a drawing layer over the picture — pen, highlighter, rectangle, circle, arrow, freehand shape,
 * text and numbered pins. Images: `MarkLayer`, saved as a PNG at the original's resolution. Videos: `VideoMarks`, marks
 * tied to moments of the video, saved as the video plus one marked frame per moment. Each PNG carries a legend
 * (`AttachmentView.note`) that the agent receives as text right before it (`attachments.ts` → `toBlocks`). There is no
 * Done: the viewer saves on close / step / add. Geometry and legend live in `annotate/marks.ts`.
 */

export interface AnnotateSource {
  path: string;
  name: string;
  mime: string;
}
/** Where the result goes: a composer draft that already holds the original, or the composer on screen. */
export type AnnotateTarget = { draftKey: string } | { composer: true };

export const canAnnotate = (mime: string) => mime.startsWith('image/') || mime.startsWith('video/');

/**
 * An image's marks drawn as a layer of the media viewer (its Edit toggle). The viewer keeps it mounted after the
 * toggle goes off, so the marks stay on the picture; it saves them with `saveMarked` when it closes or steps on.
 */
export function MarkLayer({ base, name, active, onExit, onState, handle }: { base: HTMLImageElement; name: string } & Pick<EditorLayer, 'active' | 'onExit' | 'onState' | 'handle'>) {
  const w = base.naturalWidth || 1;
  const h = base.naturalHeight || 1;
  return (
    <ErrorBoundary label="Mark up" onClose={onExit}>
      <MarkEditor base={base} w={w} h={h} title={name} layer={{ active, onExit, onState, handle }} />
    </ErrorBoundary>
  );
}

/** Saves an image's mark layer: a draft's file is replaced by the marked copy; from the chat the copy joins the message. */
export async function saveMarked(src: AnnotateSource, target: AnnotateTarget, out: { blob: Blob; note: string }): Promise<void> {
  await deliver([{ name: markedName(src.name), note: out.note, blob: out.blob }], src, target, false);
}

/** How long a moment's marks stay on screen while the video plays (seconds). */
const MOMENT_HOLD = 2.5;
/** A marked moment of a video: its time, the frame there (for the image the agent gets) and the marks. */
interface Moment {
  id: number;
  t: number;
  frame: HTMLCanvasElement;
  marks: Mark[];
}
/** What the viewer needs from a video's marks: how many moments are marked, and saving them. */
export interface VideoMarksSaver {
  count: () => number;
  save: (src: AnnotateSource, target: AnnotateTarget) => Promise<void>;
}

/**
 * Drawing on a video (the media viewer's Edit toggle). The video stays a video: Edit pauses it and opens a clear
 * layer over it at that moment; the marks belong to that time and show again for `MOMENT_HOLD` s whenever the video
 * plays past it. Several moments per video. Saved (`saver`) as the video itself plus one marked frame image per
 * moment, each with a legend that names the time — agents get images, not video.
 */
export function VideoMarks({
  video,
  name,
  active,
  onExit,
  onState,
  handle,
  saver,
  onCount,
}: {
  video: () => HTMLVideoElement | null;
  name: string;
  saver: React.MutableRefObject<VideoMarksSaver | null>;
  onCount: (n: number) => void;
} & Pick<EditorLayer, 'active' | 'onExit' | 'onState' | 'handle'>) {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const momentsNow = useRef(moments);
  momentsNow.current = moments;
  const nextId = useRef(1);

  // Edit on: pause, and open the moment at this time (one within 0.05 s, else a new one with its frame).
  useEffect(() => {
    if (!active) return setCurrent(null);
    const v = video();
    if (!v || !v.videoWidth) return;
    v.pause();
    const t = v.currentTime;
    const hit = momentsNow.current.find((m) => Math.abs(m.t - t) < 0.05);
    if (hit) return setCurrent(hit.id);
    const m: Moment = { id: nextId.current++, t, frame: grabFrame(v), marks: [] };
    setMoments((l) => [...l, m]);
    setCurrent(m.id);
  }, [active, video]);

  // Playing / seeking: show the latest marked moment whose hold covers the current time.
  useEffect(() => {
    const v = video();
    if (!v) return;
    let raf = 0;
    const pick = () => {
      const t = v.currentTime;
      let best: Moment | null = null;
      for (const m of momentsNow.current) if (m.marks.length && t >= m.t - 0.02 && t < m.t + MOMENT_HOLD && (!best || m.t > best.t)) best = m;
      setShown(best?.id ?? null);
    };
    const loop = () => {
      pick();
      if (!v.paused) raf = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    pick();
    v.addEventListener('play', onPlay);
    v.addEventListener('seeked', pick);
    v.addEventListener('pause', pick);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('seeked', pick);
      v.removeEventListener('pause', pick);
    };
  }, [video, moments]);

  const marked = moments.filter((m) => m.marks.length).length;
  useEffect(() => onCount(marked), [marked, onCount]);

  const setMarks = useCallback((id: number, marks: Mark[]) => {
    setMoments((l) => (l.some((m) => m.id === id && m.marks !== marks) ? l.map((m) => (m.id === id ? { ...m, marks } : m)) : l));
  }, []);

  saver.current = {
    count: () => momentsNow.current.filter((m) => m.marks.length).length,
    save: async (src, target) => {
      const list = momentsNow.current.filter((m) => m.marks.length).sort((a, b) => a.t - b.t);
      if (!list.length) return;
      const outputs: Output[] = [];
      for (const m of list) {
        const at = fmtTime(m.t);
        outputs.push({
          name: markedName(src.name, `frame ${at}`),
          note: buildLegend(m.marks, {
            source: `${src.name} at ${at}`,
            width: m.frame.width,
            height: m.frame.height,
            extra: `A frame of the attached video ${src.name} at ${at}, marked by the user; the marked frame is the image that follows`,
          }),
          blob: await bakePng(m.frame, m.frame.width, m.frame.height, m.marks),
        });
      }
      // The video goes along too: the frames say where and when, the video is the thing itself.
      await deliver(outputs, src, target, true);
    },
  };

  const m = moments.find((x) => x.id === (active ? current : shown));
  if (!m) return null;
  return <MomentEditor key={m.id} m={m} name={name} active={active} onExit={onExit} onState={onState} handle={handle} setMarks={setMarks} />;
}

function MomentEditor({
  m,
  name,
  active,
  onExit,
  onState,
  handle,
  setMarks,
}: { m: Moment; name: string; setMarks: (id: number, marks: Mark[]) => void } & Pick<EditorLayer, 'active' | 'onExit' | 'onState' | 'handle'>) {
  const onMarks = useCallback((marks: Mark[]) => setMarks(m.id, marks), [m.id, setMarks]);
  return (
    <ErrorBoundary label="Mark up" onClose={onExit}>
      <MarkEditor
        base={m.frame}
        w={m.frame.width}
        h={m.frame.height}
        title={`${name} at ${fmtTime(m.t)}`}
        layer={{ active, onExit, onState, handle, clear: true, initialMarks: m.marks, onMarks }}
      />
    </ErrorBoundary>
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
function grabFrame(v: HTMLVideoElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
  return c;
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

/** Undo/redo history of the whole mark list. */
function useHistory(initial: Mark[] = []) {
  const [h, setH] = useState<{ stack: Mark[][]; i: number }>(() => ({ stack: [initial], i: 0 }));
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
  /** Names the picture in the legend. */
  title: string;
  /** Always a layer of the media viewer (its Edit toggle): no bar and no Done — the viewer's bar holds Undo / Redo /
   *  Close, and the viewer saves the marks when it closes or steps on. */
  layer: EditorLayer;
}

/** What the viewer's bar needs from a mark layer. */
export interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  marks: number;
  zoom: number;
}
/** Controls the viewer's bar drives on a mark layer; `bake` = the picture with its marks, or null when unmarked. */
export interface EditorHandle {
  undo: () => void;
  redo: () => void;
  zoomBy: (k: number) => void;
  resetZoom: () => void;
  bake: () => Promise<{ blob: Blob; note: string } | null>;
}
interface EditorLayer {
  /** The Edit toggle: on = tools and drawing; off = the marks stay on the picture, drawing stops. */
  active: boolean;
  onExit: () => void;
  onState: (s: EditorState) => void;
  handle: React.MutableRefObject<EditorHandle | null>;
  /** Added to the legend (e.g. "The marked video frame is the image that follows"). */
  legendExtra?: string;
  /** Marks to start from (a video moment opened again); `onMarks` hears every change. */
  initialMarks?: Mark[];
  onMarks?: (marks: Mark[]) => void;
  /** Over a live video: the picture is not drawn (the video shows through) and the layer never zooms. */
  clear?: boolean;
}

const ZOOM_MAX = 8;
/** One press of − / + (or the keys) zooms by this much. */
const ZOOM_STEP = 1.5;

/** The drawing layer the media viewer puts over a picture or a video (see `MarkLayer`, `VideoMarks`). */
function MarkEditor({ base, w, h, title, layer }: EditorProps) {
  const active = layer.active;
  const hist = useHistory(layer.initialMarks);
  const { marks } = hist;
  const clear = Boolean(layer.clear);
  const [tool, setTool] = useState<ToolId>('ellipse');
  const [color, setColor] = useState(COLORS[0].hex);
  const [width, setWidth] = useState<WidthId>(1);
  const [box, setBox] = useState<{ w: number; h: number; scale: number } | null>(null);
  const [text, setText] = useState<{ at: Pt; value: string } | null>(null);
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
      // Same place and size as the viewer's picture: its padding (CSS), never larger than the picture itself.
      const cs = getComputedStyle(el);
      const aw = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setBox(fitSize(w, h, Math.max(40, aw), Math.max(40, ah), 1));
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
    if (!ctx || clear) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }, [base, sizeCanvas, clear]);

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
      // Over a live video the marks must stay on the video's pixels, so that layer never zooms.
      const s = clear ? 1 : Math.min(ZOOM_MAX, Math.max(1, next.s));
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
    [box, clear],
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
    if (e.button !== 0 || !active) return;
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
    if (active) rootRef.current?.focus({ preventScroll: true });
  }, [active]);

  // Layer: the toggle going off ends a text being typed (it stays as a mark).
  useEffect(() => {
    if (!active && textNow.current) commitText();
  }, [active, commitText]);
  const onMarks = layer.onMarks;
  useEffect(() => {
    onMarks?.(marks);
  }, [onMarks, marks]);
  const onState = layer.onState;
  useEffect(() => {
    onState?.({ canUndo: hist.canUndo, canRedo: hist.canRedo, marks: marks.length, zoom: zoom.s });
  }, [onState, hist.canUndo, hist.canRedo, marks.length, zoom.s]);
  layer.handle.current = {
    undo: hist.undo,
    redo: hist.redo,
    zoomBy,
    resetZoom: () => applyZoom({ s: 1, x: 0, y: 0 }),
    bake: async () => {
      const t = textNow.current;
      const list = t?.value.trim() ? [...marks, { kind: 'text' as const, color, width, points: [t.at], text: t.value.trim() }] : marks;
      if (!list.length) return null;
      return { blob: await bakePng(base, w, h, list), note: buildLegend(list, { source: title, width: w, height: h, extra: layer.legendExtra }) };
    },
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Layer with the toggle off: the viewer handles the keys.
    if (!active) return;
    const typing = (e.target as HTMLElement).closest('textarea, input');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // The marks stay, so Esc always just leaves edit mode (or drops the text being typed).
      if (text) setText(null);
      else layer.onExit();
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

  const textPos = text && box ? toScreenPoint(text.at, { width: box.w, height: box.h }, w, h) : null;

  const stageNode = (
      <div className={`an-stage an-layer-stage${clear ? ' is-clear' : ''}`} ref={stage}>
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
  );
  const toolsNode = (
      <div className="an-tools an-tools-float" role="toolbar" aria-label="Markup tools">
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
  );

  return (
    <div
      ref={rootRef}
      className={`an-layer${active ? ' is-active' : ''}`}
      tabIndex={-1}
      data-testid="annotator"
      data-tool={tool}
      data-marks={marks.length}
      data-active={active ? 'true' : 'false'}
      onKeyDown={onKeyDown}
    >
      {stageNode}
      {active && toolsNode}
    </div>
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
