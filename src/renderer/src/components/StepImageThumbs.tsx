import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { useOpenFile } from '../fileLinks';
import { useProjectId } from '../fixError';
import type { StepImage } from '../stepImages';
import { openViewer, viewerAttrs } from '../mediaViewerApi';

/**
 * Shared LRU thumbnail cache (`ref -> dataUrl | null`). `null` means the file is missing or unreadable,
 * so deleted `/tmp` screenshots quietly hide themselves without retrying on every render.
 */
const MAX_CACHE = 240;
const thumbCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let cacheVersion = 0;

/** Pending absolute paths queued for the next micro-batched `api.describeAttachments` call. */
let pendingBatch: { ref: string; projectId?: string; resolve: (url: string | null) => void }[] = [];
let batchScheduled = false;

function subscribeCache(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const getCacheVersion = () => cacheVersion;

function cacheSet(ref: string, val: string | null) {
  if (thumbCache.has(ref)) thumbCache.delete(ref);
  thumbCache.set(ref, val);
  while (thumbCache.size > MAX_CACHE) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
    else break;
  }
  cacheVersion++;
  for (const fn of listeners) fn();
}

/** True for absolute paths on POSIX or Windows that `attachments.describe` can `statSync` directly. */
const isDirectFsPath = (p: string) => /^(?:\/|[A-Za-z]:[\\/])/.test(p);

async function fallbackPreview(ref: string, projectId?: string): Promise<string | null> {
  try {
    const res = await api.preview(ref, projectId);
    if (res.kind === 'image' && res.dataUrl) return res.dataUrl;
    if (res.thumbUrl) return res.thumbUrl;
  } catch {
    /* file unavailable */
  }
  return null;
}

async function flushBatch() {
  batchScheduled = false;
  const items = pendingBatch;
  pendingBatch = [];
  if (!items.length) return;

  const direct = items.filter((it) => isDirectFsPath(it.ref));
  const resolved = new Map<string, string>();

  if (direct.length) {
    try {
      const views = await api.describeAttachments(direct.map((d) => d.ref));
      for (const v of views) {
        if (v.preview) resolved.set(v.path, v.preview);
      }
    } catch {
      /* headless server or unsupported runtime: fall back to api.preview below */
    }
  }

  await Promise.all(
    items.map(async (it) => {
      const hit = resolved.get(it.ref);
      const url = hit ?? (await fallbackPreview(it.ref, it.projectId));
      cacheSet(it.ref, url);
      it.resolve(url);
    }),
  );
}

/** Loads a lightweight thumbnail data URL for `ref`, coalescing concurrent requests into one batched IPC call. */
function loadThumb(ref: string, projectId?: string): Promise<string | null> {
  if (thumbCache.has(ref)) return Promise.resolve(thumbCache.get(ref) ?? null);
  const existing = inflight.get(ref);
  if (existing) return existing;

  const p = new Promise<string | null>((resolve) => {
    pendingBatch.push({ ref, projectId, resolve });
    if (!batchScheduled) {
      batchScheduled = true;
      setTimeout(() => void flushBatch(), 16);
    }
  }).finally(() => {
    inflight.delete(ref);
  });

  inflight.set(ref, p);
  return p;
}

/**
 * Compact strip of clickable image thumbnails rendered on the right side of a `WorkGroup` header or `StepRowHead`.
 * Clicking any thumbnail (or the `+N` overflow badge) opens the image in the shared media `Sheet` (`MediaViewer`)
 * without toggling the parent group or tool row.
 */
export const StepImageStrip = memo(function StepImageStrip({
  images,
  max = 4,
  scope,
}: {
  images: StepImage[];
  max?: number;
  scope: 'group' | 'row';
}) {
  const openFile = useOpenFile();
  const projectId = useProjectId();
  const stripRef = useRef<HTMLSpanElement>(null);
  useSyncExternalStore(subscribeCache, getCacheVersion);

  // Drop confirmed-missing files first so live images backfill the visible slots and `+N` stays accurate.
  const liveImages = images.filter((img) => thumbCache.get(img.ref) !== null);
  const visible = liveImages.slice(0, max);
  const visibleRefsKey = visible.map((i) => i.ref).join('\0');
  const allCached = visible.every((i) => thumbCache.has(i.ref));

  const [inView, setInView] = useState(allCached);

  // Lazy-load thumbnails only once scrolled near the viewport (immediate if already cached).
  useEffect(() => {
    if (inView || allCached) {
      if (!inView && allCached) setInView(true);
      return;
    }
    const el = stripRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, allCached, visibleRefsKey]);

  useEffect(() => {
    if (!inView) return;
    const missing = visible.filter((img) => !thumbCache.has(img.ref));
    if (!missing.length) return;
    for (const img of missing) void loadThumb(img.ref, projectId);
  }, [inView, visibleRefsKey, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!liveImages.length) return null;

  const extraItems = liveImages.map((im) => ({ ref: im.ref, kind: 'image' as const, name: im.name }));
  const openAt = (e: React.MouseEvent<HTMLElement>, img: StepImage) => {
    e.stopPropagation();
    openViewer({
      ref: img.ref,
      from: e.currentTarget,
      name: img.name,
      mime: img.mime,
      projectId,
      openInPanel: openFile,
      extraItems,
    });
  };
  const stopKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  };

  const overflow = Math.max(0, liveImages.length - max);
  const thumbTestId = scope === 'group' ? 'wg-group-img-thumb' : 'wg-row-img-thumb';

  return (
    <span
      ref={stripRef}
      className={`wg-img-strip is-${scope}`}
      data-testid={scope === 'group' ? 'wg-group-images' : 'wg-row-images'}
      onClick={(e) => e.stopPropagation()}
    >
      {visible.map((img) => {
        const src = thumbCache.get(img.ref);
        return (
          <button
            key={img.ref}
            type="button"
            className={`wg-img-thumb ${src ? '' : 'is-loading'}`}
            data-testid={thumbTestId}
            title={`Preview ${img.name}`}
            aria-label={`Preview ${img.name}`}
            {...viewerAttrs(img.ref, 'image', img.name)}
            onClick={(e) => openAt(e, img)}
            onKeyDown={stopKeys}
          >
            {src ? <img src={src} alt={img.name} draggable={false} /> : null}
          </button>
        );
      })}
      {overflow > 0 && (
        <button
          type="button"
          className="wg-img-more"
          data-testid="wg-img-more"
          title={`View all ${liveImages.length} images`}
          aria-label={`View ${overflow} more image${overflow === 1 ? '' : 's'}`}
          onClick={(e) => openAt(e, liveImages[max])}
          onKeyDown={stopKeys}
        >
          +{overflow}
        </button>
      )}
    </span>
  );
});
