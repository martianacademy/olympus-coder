import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Check, ChevronLeft, ChevronRight, Download, FolderOpen, Loader2, MessageSquarePlus, PanelRight, PenLine, X } from 'lucide-react';
import type { FilePreview } from '@shared/types';
import { api } from '../api';
import { OpenFileContext, RefBaseContext } from '../fileLinks';
import { isRemoteBrowser } from '../responsive';
import { ErrorBoundary } from './ErrorBoundary';
import { PreviewBody, usePdfUrl } from './FilePreview';
import { downloadFileRef } from './InlineFilePreviews';
import { addToMessage, useCanAddToMessage } from './AddToMessage';
import { openAnnotator } from './Annotator';
import '../mediaViewer.css';

/**
 * In-chat viewer: images, videos and documents from the chat open in an overlay over the chat instead of the side
 * panel. Images zoom (wheel, pinch, double-click) and pan; ←/→ or a swipe step through the chat's images and videos;
 * documents reuse the panel's renderers (`PreviewBody`). Rendered in its own root on `document.body`, so any
 * component can open it with `openViewer()` without a provider.
 *
 * Clickable media in the chat carry `data-viewer-ref` / `data-viewer-kind` / `data-viewer-name`; the gallery for
 * ←/→ is collected from those inside the chat scroller.
 */

export type ViewerKind = 'image' | 'video' | 'audio' | 'file';
export interface ViewerItem {
  ref: string;
  kind: ViewerKind;
  name?: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv|mkv)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;

export function viewerKindOf(ref: string, mime?: string): ViewerKind {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  const p = ref.replace(/[?#].*$/, '');
  if (IMAGE_EXT.test(p)) return 'image';
  if (VIDEO_EXT.test(p)) return 'video';
  if (AUDIO_EXT.test(p)) return 'audio';
  return 'file';
}

/** Attributes that make an element part of the chat's gallery. */
export function viewerAttrs(ref: string, kind: ViewerKind, name?: string) {
  return { 'data-viewer-ref': ref, 'data-viewer-kind': kind, 'data-viewer-name': name };
}

const isMedia = (k: ViewerKind) => k === 'image' || k === 'video';
const baseName = (p: string) => p.replace(/[?#].*$/, '').split(/[\\/]/).pop() || p;
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

/** Images and videos around `from` (the chat scroller, else its message), in page order, without repeats. */
function collectGallery(from: Element | null | undefined): ViewerItem[] {
  const scope = from?.closest('[data-testid="chat-scroll"], .chat-scroll') ?? from?.closest('.msg-wrap');
  if (!scope) return [];
  const seen = new Set<string>();
  const out: ViewerItem[] = [];
  for (const el of scope.querySelectorAll<HTMLElement>('[data-viewer-ref]')) {
    const ref = el.dataset.viewerRef!;
    const kind = (el.dataset.viewerKind as ViewerKind) || viewerKindOf(ref);
    if (!isMedia(kind) || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, kind, name: el.dataset.viewerName || undefined });
  }
  return out;
}

interface ViewerState {
  items: ViewerItem[];
  index: number;
  projectId?: string;
  openInPanel: (ref: string) => void;
}

let root: Root | null = null;
/** Set when the viewer closes because focus is going elsewhere on purpose (the composer after "Add to message"). */
let keepFocus = false;

function render(state: ViewerState | null) {
  if (!root) {
    const host = document.createElement('div');
    host.className = 'mv-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root.render(
    state ? (
      <ErrorBoundary label="Viewer" onClose={closeViewer}>
        <Viewer key={Date.now()} {...state} />
      </ErrorBoundary>
    ) : null,
  );
}

export function closeViewer(opts: { restoreFocus?: boolean } = {}) {
  keepFocus = opts.restoreFocus === false;
  render(null);
}

/**
 * Opens `ref` in the in-chat viewer. Images and videos get the gallery of the chat around `from`; other files open
 * alone. `openInPanel` is the side panel opener (`useOpenFile()`), offered as a secondary action.
 */
export function openViewer(opts: {
  ref: string;
  from?: Element | null;
  name?: string;
  mime?: string;
  projectId?: string;
  openInPanel: (ref: string) => void;
}) {
  const kind = viewerKindOf(opts.ref, opts.mime);
  const self: ViewerItem = { ref: opts.ref, kind, name: opts.name };
  let items = [self];
  if (isMedia(kind)) {
    const gallery = collectGallery(opts.from);
    if (gallery.some((g) => g.ref === opts.ref)) items = gallery;
  }
  render({ items, index: Math.max(0, items.findIndex((i) => i.ref === opts.ref)), projectId: opts.projectId, openInPanel: opts.openInPanel });
}

/** A few loaded previews, so stepping back and forth does not load files again (phones load them over the relay). */
const cache = new Map<string, FilePreview>();
function loadPreview(ref: string, projectId?: string): Promise<FilePreview> {
  const hit = cache.get(ref);
  if (hit) return Promise.resolve(hit);
  return api.preview(ref, projectId).then((d) => {
    cache.set(ref, d);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
    return d;
  });
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, iframe, video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

function Viewer({ items: initialItems, index: initialIndex, projectId, openInPanel }: ViewerState) {
  const [items, setItems] = useState(initialItems);
  const [index, setIndex] = useState(initialIndex);
  const [data, setData] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [resetKey, setResetKey] = useState(0);
  const [saved, setSaved] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const item = items[index];
  const many = items.length > 1;
  const remote = isRemoteBrowser();
  const dark = document.documentElement.dataset.theme === 'dark';
  const pdfUrl = usePdfUrl(data);
  const canAdd = useCanAddToMessage();

  const step = useCallback(
    (d: number) => {
      if (items.length < 2) return;
      setIndex((i) => (i + d + items.length) % items.length);
    },
    [items.length],
  );

  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    setZoom(1);
    loadPreview(item.ref, projectId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.message ?? String(e)));
    // Warm the neighbours so stepping feels instant.
    if (items.length > 1) {
      for (const d of [1, -1]) {
        const n = items[(index + d + items.length) % items.length];
        if (n.kind === 'image') void loadPreview(n.ref, projectId).catch(() => {});
      }
    }
    return () => {
      alive = false;
    };
  }, [item.ref, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus moves into the dialog and returns on close to the control that had it (not to a container such as the
  // chat scroller, which would then show a focus ring after Esc).
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialog.current?.focus({ preventScroll: true });
    return () => {
      if (keepFocus) keepFocus = false;
      else if (prev?.isConnected && prev.tabIndex >= 0 && prev.matches(FOCUSABLE)) prev.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeViewer();
      return;
    }
    if (e.key === 'Tab') {
      const els = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
      if (!els.length) return e.preventDefault();
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (t === first || t === dialog.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && t === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    // Arrows belong to editors, fields and players when they have focus.
    if (t.closest('input, textarea, select, video, audio, [contenteditable="true"], .cm-editor')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  const download = async () => {
    try {
      if (await downloadFileRef(data?.path ?? item.ref, projectId)) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const name = data?.name ?? item.name ?? baseName(item.ref);
  const kind = data?.kind;
  const media = kind === 'image' || kind === 'video' || kind === 'audio';
  const hasFile = Boolean(data && data.kind !== 'missing' && data.kind !== 'dir');

  /** Links inside a document open in the viewer too. */
  const openInside = useCallback((ref: string) => {
    setItems([{ ref, kind: viewerKindOf(ref) }]);
    setIndex(0);
  }, []);

  return (
    <div
      ref={dialog}
      className={`mv-root ${media ? 'is-media' : 'is-doc'}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewer: ${name}`}
      tabIndex={-1}
      data-testid="media-viewer"
      data-kind={kind ?? 'loading'}
      data-index={index}
      data-count={items.length}
      onKeyDown={onKeyDown}
    >
      <div className="mv-bar">
        <div className="mv-title">
          <span className="mv-name ellipsis" data-testid="viewer-name">
            {name}
          </span>
          {many && (
            <span className="mv-count mono" data-testid="viewer-count">
              {index + 1} / {items.length}
            </span>
          )}
        </div>
        {kind === 'image' && zoom !== 1 && (
          <button type="button" className="mv-btn mv-zoom mono" title="Reset zoom" onClick={() => setResetKey((k) => k + 1)}>
            {Math.round(zoom * 100)}%
          </button>
        )}
        {hasFile && (
          <button type="button" className="mv-btn" title="Download" aria-label="Download" data-testid="viewer-download" onClick={() => void download()}>
            {saved ? <Check size={16} /> : <Download size={16} />}
          </button>
        )}
        {hasFile && canAdd && (
          <button
            type="button"
            className="mv-btn"
            title="Add to message"
            aria-label="Add to message"
            data-testid="viewer-add-to-message"
            onClick={() => {
              const ref = data?.path ?? item.ref;
              // Close first so the composer can take focus once the file is in the draft.
              closeViewer({ restoreFocus: false });
              void addToMessage(ref, { name: item.name });
            }}
          >
            <MessageSquarePlus size={16} />
          </button>
        )}
        {hasFile && canAdd && data && (kind === 'image' || kind === 'video') && (
          <button
            type="button"
            className="mv-btn"
            title={kind === 'video' ? 'Mark up frames & add to message' : 'Mark up & add to message'}
            aria-label={kind === 'video' ? 'Mark up frames and add to message' : 'Mark up and add to message'}
            data-testid="viewer-annotate"
            onClick={() => {
              closeViewer({ restoreFocus: false });
              openAnnotator({ path: data.path, name, mime: kind === 'video' ? data.mime || 'video/mp4' : data.mime || 'image/png' }, { composer: true });
            }}
          >
            <PenLine size={16} />
          </button>
        )}
        <button
          type="button"
          className="mv-btn"
          title="Open in panel"
          aria-label="Open in panel"
          data-testid="viewer-open-panel"
          onClick={() => {
            closeViewer();
            openInPanel(item.ref);
          }}
        >
          <PanelRight size={16} />
        </button>
        {!remote && hasFile && data && (
          <button type="button" className="mv-btn" title="Open folder" aria-label="Open folder" onClick={() => void api.previewReveal(data.path)}>
            <FolderOpen size={16} />
          </button>
        )}
        <button type="button" className="mv-btn" title="Close (Esc)" aria-label="Close viewer" data-testid="viewer-close" onClick={() => closeViewer()}>
          <X size={17} />
        </button>
      </div>

      <div className="mv-stage-wrap">
        {error ? (
          <Backdrop className="mv-center">
            <div className="mv-error">{error}</div>
          </Backdrop>
        ) : !data ? (
          <Backdrop className="mv-center">
            <Loader2 size={20} className="spin mv-spinner" />
          </Backdrop>
        ) : kind === 'image' && data.dataUrl ? (
          <ZoomImage key={`${data.path}#${resetKey}`} src={data.dataUrl} alt={name} onZoom={setZoom} onStep={many ? step : undefined} />
        ) : kind === 'video' && data.dataUrl ? (
          <Backdrop className="mv-center" onStep={many ? step : undefined}>
            <video key={data.path} src={data.dataUrl} poster={data.thumbUrl} controls autoPlay playsInline className="mv-video" data-testid="viewer-video" />
          </Backdrop>
        ) : kind === 'audio' && data.dataUrl ? (
          <Backdrop className="mv-center" onStep={many ? step : undefined}>
            <div className="mv-audio">
              <audio key={data.path} src={data.dataUrl} controls autoPlay />
            </div>
          </Backdrop>
        ) : (
          <Backdrop className="mv-doc-wrap">
            <div className="mv-doc file-preview" data-testid="viewer-doc">
              <div className="fp-body">
                <OpenFileContext.Provider value={openInside}>
                  <RefBaseContext.Provider value={dirOf(data.path)}>
                    <PreviewBody
                      data={data}
                      source={false}
                      docPageMode={false}
                      dark={dark}
                      pdfUrl={pdfUrl}
                      onOpen={openInside}
                      onDownload={() => void download()}
                    />
                  </RefBaseContext.Provider>
                </OpenFileContext.Provider>
              </div>
            </div>
          </Backdrop>
        )}

        {many && (
          <>
            <button type="button" className="mv-nav prev" title="Previous (←)" aria-label="Previous" data-testid="viewer-prev" onClick={() => step(-1)}>
              <ChevronLeft size={20} />
            </button>
            <button type="button" className="mv-nav next" title="Next (→)" aria-label="Next" data-testid="viewer-next" onClick={() => step(1)}>
              <ChevronRight size={20} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The area around the content: a tap or click on it closes the viewer; a horizontal swipe steps. Closing waits for
 * the `click`: closing on `pointerup` would let a touch's follow-up click land on the chat underneath.
 */
function Backdrop({ className, onStep, children }: { className: string; onStep?: (d: number) => void; children: React.ReactNode }) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const closeOnClick = useRef(false);
  return (
    <div
      className={`mv-stage ${className}`}
      data-testid="viewer-stage"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        closeOnClick.current = false;
      }}
      onClick={() => {
        if (!closeOnClick.current) return;
        closeOnClick.current = false;
        closeViewer();
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (onStep && e.pointerType !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) onStep(dx < 0 ? 1 : -1);
        else closeOnClick.current = Math.hypot(dx, dy) < 6 && e.target === e.currentTarget;
      }}
    >
      {children}
    </div>
  );
}

const MIN = 1;
const MAX = 8;

/** An image fitted to the stage: wheel / pinch / double-click zoom around the pointer, drag to pan, swipe to step. */
function ZoomImage({ src, alt, onZoom, onStep }: { src: string; alt: string; onZoom: (z: number) => void; onStep?: (d: number) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const tr = useRef(t);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ sx: number; sy: number; moved: boolean; onImage: boolean; pinch?: { d: number; s: number }; lastTap?: number; tapToggled?: number; closeOnClick?: boolean }>({
    sx: 0,
    sy: 0,
    moved: false,
    onImage: false,
  });

  const apply = useCallback(
    (next: { s: number; x: number; y: number }) => {
      const s = Math.min(MAX, Math.max(MIN, next.s));
      let { x, y } = next;
      const st = stage.current;
      const im = img.current;
      if (s === 1 || !st || !im) {
        x = 0;
        y = 0;
      } else {
        // Keep the image over the stage: pan only as far as the zoomed image is larger than the stage.
        const mx = Math.max(0, (im.offsetWidth * s - st.clientWidth) / 2);
        const my = Math.max(0, (im.offsetHeight * s - st.clientHeight) / 2);
        x = Math.min(mx, Math.max(-mx, x));
        y = Math.min(my, Math.max(-my, y));
      }
      tr.current = { s, x, y };
      setT(tr.current);
      onZoom(s);
    },
    [onZoom],
  );

  /** Zoom to `s` keeping the screen point (cx, cy) still. */
  const zoomAt = useCallback(
    (s: number, cx: number, cy: number) => {
      const st = stage.current;
      if (!st) return;
      const r = st.getBoundingClientRect();
      const px = cx - (r.left + r.width / 2);
      const py = cy - (r.top + r.height / 2);
      const cur = tr.current;
      const next = Math.min(MAX, Math.max(MIN, s));
      const k = next / cur.s;
      apply({ s: next, x: px - k * (px - cur.x), y: py - k * (py - cur.y) });
    },
    [apply],
  );

  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(tr.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX, e.clientY);
    };
    st.addEventListener('wheel', onWheel, { passive: false });
    return () => st.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const toggleAt = (cx: number, cy: number) => zoomAt(tr.current.s > 1 ? 1 : 2.5, cx, cy);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Read the target before capturing: once captured, later events target the stage.
    const onImage = e.target === img.current;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.sx = e.clientX;
      g.sy = e.clientY;
      g.moved = false;
      g.closeOnClick = false;
      g.onImage = onImage;
      g.pinch = undefined;
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: tr.current.s };
      g.moved = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, now);
    const g = gesture.current;
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((g.pinch.s * d) / g.pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (Math.hypot(now.x - g.sx, now.y - g.sy) > 5) g.moved = true;
    if (tr.current.s > 1) apply({ ...tr.current, x: tr.current.x + now.x - prev.x, y: tr.current.y + now.y - prev.y });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) return;
    const wasPinch = Boolean(g.pinch);
    g.pinch = undefined;
    if (wasPinch) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (tr.current.s === 1 && onStep && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      onStep(dx < 0 ? 1 : -1);
      return;
    }
    if (g.moved) return;
    const onImage = g.onImage;
    if (e.pointerType !== 'mouse' && onImage) {
      // Double tap (touch has no reliable dblclick).
      const now = Date.now();
      if (g.lastTap && now - g.lastTap < 300) {
        g.lastTap = undefined;
        g.tapToggled = now;
        toggleAt(e.clientX, e.clientY);
      } else g.lastTap = now;
      return;
    }
    g.closeOnClick = !onImage;
  };

  return (
    <div
      ref={stage}
      className={`mv-stage mv-center mv-zoom-stage ${t.s > 1 ? 'is-zoomed' : ''}`}
      data-testid="viewer-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
      onClick={() => {
        const g = gesture.current;
        if (!g.closeOnClick) return;
        g.closeOnClick = false;
        closeViewer();
      }}
      onDoubleClick={(e) => {
        // Captured pointers retarget dblclick to the stage, so hit-test; a touch double tap was already handled.
        const g = gesture.current;
        if (g.tapToggled && Date.now() - g.tapToggled < 600) return;
        if (document.elementFromPoint(e.clientX, e.clientY) === img.current) toggleAt(e.clientX, e.clientY);
      }}
    >
      <img
        ref={img}
        src={src}
        alt={alt}
        draggable={false}
        className="mv-img"
        data-testid="viewer-image"
        data-zoom={t.s.toFixed(2)}
        style={{ transform: `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.s})` }}
      />
    </div>
  );
}
