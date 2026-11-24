import { memo, useContext, useEffect, useState } from 'react';
import { Check, Download, Maximize2 } from 'lucide-react';
import type { FilePreview } from '@shared/types';
import { api } from '../api';
import { RefBaseContext, useOpenFile, withBase } from '../fileLinks';
import { displayMediaLabel, type BlockMediaLink } from '../markdownMedia';
import { openViewer, viewerAttrs } from '../mediaViewerApi';
import { AddToMessageButton } from './AddToMessage';
import { downloadFileRef } from './InlineFilePreviews';

/**
 * Inline media previews for local image, video, and audio Markdown links (`[shot.png](file:///...)`).
 *
 * - Uses a bounded stale-while-revalidate preview cache so streaming token chunks never flicker
 *   and chat switches paint immediately, while remounting revalidates from disk in case the agent
 *   overwrote the same file path in a newer turn.
 * - Missing, unreadable, or non-media files fall back cleanly to the plain clickable `.file-link`
 *   when rendered standalone, or render nothing when the link is already visible inline in prose.
 */

const MAX_CACHE = 32;
const previewCache = new Map<string, FilePreview>();

function getCached(key: string): FilePreview | null {
  const hit = previewCache.get(key);
  if (!hit) return null;
  // Refresh LRU order.
  previewCache.delete(key);
  previewCache.set(key, hit);
  return hit;
}

function setCached(key: string, value: FilePreview): void {
  if (previewCache.has(key)) previewCache.delete(key);
  previewCache.set(key, value);
  while (previewCache.size > MAX_CACHE) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

function fmtBytes(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isPreviewableMedia(p: FilePreview | null): p is FilePreview & { kind: 'image' | 'video' | 'audio'; dataUrl: string } {
  return Boolean(p && (p.kind === 'image' || p.kind === 'video' || p.kind === 'audio') && p.dataUrl);
}

function MediaDownloadButton({ path }: { path: string }) {
  const [saved, setSaved] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost icon rich-act"
      title="Download"
      aria-label="Download file"
      data-testid="md-media-download"
      onClick={(e) => {
        e.stopPropagation();
        void downloadFileRef(path)
          .then((ok) => {
            if (!ok) return;
            setSaved(true);
            setTimeout(() => setSaved(false), 1400);
          })
          .catch(() => {});
      }}
    >
      {saved ? <Check size={12} /> : <Download size={12} />}
    </button>
  );
}

const MdMediaItem = memo(function MdMediaItem({ link, standalone }: { link: BlockMediaLink; standalone: boolean }) {
  const openInPanel = useOpenFile();
  const base = useContext(RefBaseContext);
  const resolved = withBase(link.href, base);

  const [data, setData] = useState<FilePreview | null>(() => getCached(resolved));
  const [settled, setSettled] = useState(() => Boolean(getCached(resolved)));

  useEffect(() => {
    let alive = true;
    const cached = getCached(resolved);
    if (cached) {
      setData(cached);
      setSettled(true);
    } else {
      setData(null);
      setSettled(false);
    }
    void api
      .preview(resolved)
      .then((res) => {
        if (!alive) return;
        if (isPreviewableMedia(res)) {
          setCached(resolved, res);
          setData(res);
        } else {
          // Drop stale cache entry if the file was deleted or replaced with non-media.
          previewCache.delete(resolved);
          setData(res);
        }
        setSettled(true);
      })
      .catch(() => {
        if (!alive) return;
        previewCache.delete(resolved);
        setData(null);
        setSettled(true);
      });
    return () => {
      alive = false;
    };
  }, [resolved]);

  const fallbackLabel = link.label || link.href;
  const openMedia = (from: Element | null) => {
    openViewer({
      ref: resolved,
      from,
      name: displayMediaLabel(link.label, link.href, data?.name),
      mime: data?.mime,
      openInPanel,
    });
  };

  if (!isPreviewableMedia(data)) {
    // While loading or when missing/unreadable/too-large: keep standalone links clickable and clean,
    // and render nothing for inline-in-prose links (their text link is already visible above).
    if (!standalone) return null;
    return (
      <p className="md-media-fallback-link">
        <a
          href={link.href}
          className="file-link"
          title={`Open ${link.href}`}
          data-testid={settled ? 'md-media-fallback' : 'md-media-loading'}
          onClick={(e) => {
            e.preventDefault();
            openMedia(e.currentTarget);
          }}
        >
          {fallbackLabel}
        </a>
      </p>
    );
  }

  const displayName = displayMediaLabel(link.label, link.href, data.name);
  const sizeLabel = fmtBytes(data.size);

  if (data.kind === 'audio') {
    return (
      <div className="rich-audio md-media-audio" data-testid="md-media-preview" data-media-kind="audio">
        <audio src={data.dataUrl} controls preload="metadata" />
        <button
          type="button"
          className="md-media-name ellipsis"
          title={`Open ${displayName}`}
          onClick={(e) => openMedia(e.currentTarget)}
        >
          {displayName}
        </button>
        {sizeLabel && <span className="rich-link-meta mono">{sizeLabel}</span>}
        <AddToMessageButton path={data.path} name={data.name} mime={data.mime} />
        <MediaDownloadButton path={data.path} />
      </div>
    );
  }

  if (data.kind === 'video') {
    return (
      <figure
        className="rich-image md-media-card is-video"
        data-testid="md-media-preview"
        data-media-kind="video"
        {...viewerAttrs(resolved, 'video', displayName)}
      >
        <video src={data.dataUrl} poster={data.thumbUrl} controls preload="metadata" className="md-media-video" />
        <figcaption className="rich-caption small muted">
          <button
            type="button"
            className="md-media-name ellipsis"
            title="Open full size"
            onClick={(e) => openMedia(e.currentTarget)}
          >
            {displayName}
          </button>
          {sizeLabel && <span className="mono">{sizeLabel}</span>}
          <span className="grow" />
          <button
            type="button"
            className="btn ghost icon rich-act"
            title="Open full size"
            aria-label="Open video full size"
            onClick={(e) => openMedia(e.currentTarget)}
          >
            <Maximize2 size={12} />
          </button>
          <AddToMessageButton path={data.path} name={data.name} mime={data.mime} />
          <MediaDownloadButton path={data.path} />
        </figcaption>
      </figure>
    );
  }

  return (
    <figure
      className="rich-image md-media-card"
      data-testid="md-media-preview"
      data-media-kind="image"
      {...viewerAttrs(resolved, 'image', displayName)}
    >
      <img
        src={data.dataUrl}
        alt={displayName}
        title="Click to open full size"
        onClick={(e) => openMedia(e.currentTarget)}
      />
      <figcaption className="rich-caption small muted">
        <button
          type="button"
          className="md-media-name ellipsis"
          title="Open in viewer"
          onClick={(e) => openMedia(e.currentTarget)}
        >
          {displayName}
        </button>
        {sizeLabel && <span className="mono">{sizeLabel}</span>}
        <span className="grow" />
        <AddToMessageButton path={data.path} name={data.name} mime={data.mime} />
        <MediaDownloadButton path={data.path} />
      </figcaption>
    </figure>
  );
});

/** Renders inline media previews for one Markdown paragraph or list item. */
export const MdMediaStrip = memo(function MdMediaStrip({
  links,
  standalone = false,
}: {
  links: BlockMediaLink[];
  standalone?: boolean;
}) {
  if (!links.length) return null;
  return (
    <div
      className={`md-media-strip ${standalone ? 'is-standalone' : 'is-attached'} ${links.length > 1 ? 'is-multi' : ''}`}
      data-testid="md-media-strip"
    >
      {links.map((link) => (
        <MdMediaItem key={link.href} link={link} standalone={standalone} />
      ))}
    </div>
  );
});
