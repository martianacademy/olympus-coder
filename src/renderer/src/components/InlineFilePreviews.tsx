import { useEffect, useState } from 'react';
import {
  Check,
  Download,
  Eye,
  File as FileIcon,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Maximize2,
} from 'lucide-react';
import type { FilePreview } from '@shared/types';
import { api } from '../api';
import { isRemoteBrowser } from '../responsive';
import { openViewer, viewerAttrs, viewerKindOf, type ViewerKind } from '../mediaViewerApi';
import { AddToMessageButton } from './AddToMessage';

const RICH_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.heic', '.heif', '.tif', '.tiff',
  '.mp4', '.mov', '.m4v', '.webm', '.ogv', '.mkv',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus',
  '.pdf',
  '.doc', '.docx', '.rtf', '.odt', '.wordml',
  '.xls', '.xlsx', '.ppt', '.pptx', '.pages', '.numbers', '.key',
]);

const fmtBytes = (n?: number) =>
  n === undefined
    ? ''
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1024 / 1024).toFixed(1)} MB`;

function cleanRefPath(raw: string): string {
  return raw.trim().replace(/^file:\/\//i, '').replace(/#L?\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
}

function extOf(raw: string): string {
  const p = cleanRefPath(raw);
  const dot = p.lastIndexOf('.');
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

/** True when `path` points to an image, video, audio, PDF, or Office/iWork document that should render visually. */
export function isRichPreviewPath(path: string): boolean {
  return RICH_EXT.has(extOf(path));
}

/** Collects file paths from `item.locations` plus `Path`/`file_path`/`path` in JSON tool input when `locations` is empty. */
export function extractStepFilePaths(locations: string[], rawInput: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const loc of locations) push(loc);
  if (rawInput && rawInput.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(rawInput) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (/^(path|file_path|filepath|targetfile|uri)$/i.test(k) && typeof v === 'string') push(v);
      }
    } catch {
      /* ignore non-JSON input */
    }
  }
  return out;
}

/**
 * Downloads a file on both Desktop Electron (native Save dialog defaulted to ~/Downloads)
 * and Remote Phone/Web Browser (`preview.raw` -> Blob `<a download>`).
 */
export async function downloadFileRef(ref: string, projectId?: string): Promise<boolean> {
  if (!isRemoteBrowser()) {
    const res = await api.previewSaveAs(ref, projectId);
    return res.saved;
  }
  const raw = await api.previewRaw(ref, projectId);
  const bin = atob(raw.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: raw.mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = raw.name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

/** Wraps sanitized `textutil` HTML in a clean, script-free document stylesheet matching Olympus light/dark themes. */
export function buildDocSrcDoc(html: string, dark: boolean): string {
  const bg = dark ? '#16161a' : '#ffffff';
  const fg = dark ? '#ececf1' : '#1d1d22';
  const muted = dark ? '#9a9aa6' : '#666672';
  const border = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 18px 22px; background: ${bg}; color: ${fg};
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; word-wrap: break-word; }
    table { border-collapse: collapse; max-width: 100%; margin: 10px 0; }
    th, td { border: 1px solid ${border}; padding: 6px 10px; text-align: left; }
    h1, h2, h3, h4 { line-height: 1.3; margin-top: 1.1em; }
    p { margin: 0.55em 0; }
    a { color: #ee6a3e; }
    blockquote { border-left: 3px solid ${border}; margin: 8px 0; padding-left: 12px; color: ${muted}; }
    img { max-width: 100%; height: auto; }
  </style></head><body>${html}</body></html>`;
}

function kindIcon(ext: string, kind?: FilePreview['kind']) {
  if (kind === 'image') return <FileImage size={14} />;
  if (kind === 'video') return <FileVideo size={14} />;
  if (kind === 'audio') return <FileAudio size={14} />;
  if (ext === '.xls' || ext === '.xlsx' || ext === '.numbers') return <FileSpreadsheet size={14} />;
  if (kind === 'pdf' || kind === 'document') return <FileText size={14} />;
  return <FileIcon size={14} />;
}

/**
 * Inline rich media / document preview card rendered inside an expanded `ToolRow` step. Video and audio play here;
 * a click on an image or document opens the in-chat viewer (`onOpen`, the side panel, stays one click away there).
 */
function InlineMediaCard({ path, onOpen }: { path: string; onOpen: (ref: string) => void }) {
  const [data, setData] = useState<FilePreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const ext = extOf(path);
  const badge = ext ? ext.slice(1).toUpperCase() : 'FILE';
  const kind: ViewerKind =
    data?.kind === 'image' || data?.kind === 'video' || data?.kind === 'audio' ? data.kind : data ? 'file' : viewerKindOf(path);
  const view = (e: React.MouseEvent<HTMLElement>) => openViewer({ ref: path, from: e.currentTarget, name: data?.name, openInPanel: onOpen });
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

  useEffect(() => {
    let alive = true;
    setFailed(false);
    api
      .preview(path)
      .then((res) => {
        if (alive) setData(res);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (await downloadFileRef(data?.path ?? path)) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
      }
    } catch {
      /* user canceled or missing */
    }
  };

  return (
    <div className="inline-media-card" data-testid="inline-media-card" data-kind={data?.kind ?? 'loading'} {...viewerAttrs(path, kind, data?.name)}>
      <div className="inline-media-head">
        <span className="inline-media-icon">{kindIcon(ext, data?.kind)}</span>
        <span className="inline-media-name ellipsis" onClick={view}>
          {data?.name ?? (path.split(/[\\/]/).pop() || path)}
        </span>
        <span className="inline-media-badge mono">{badge}</span>
        {data?.size !== undefined && <span className="inline-media-size muted">{fmtBytes(data.size)}</span>}
        <span className="spacer" />
        <button type="button" className="btn ghost cmd-pane-btn" onClick={view} title="Open in the viewer">
          {kind === 'video' ? <Maximize2 size={11} /> : <Eye size={11} />} {kind === 'video' ? 'Full size' : 'Preview'}
        </button>
        {data && data.kind !== 'missing' && <AddToMessageButton path={data.path} name={data.name} className="btn ghost cmd-pane-btn" size={11} />}
        {data && data.kind !== 'missing' && (
          <button
            type="button"
            className="btn ghost cmd-pane-btn"
            onClick={(e) => void handleDownload(e)}
            title="Download / Save file"
            data-testid="inline-media-download"
          >
            {saved ? <Check size={11} /> : <Download size={11} />} {saved ? 'Saved' : 'Download'}
          </button>
        )}
      </div>

      <div className="inline-media-stage">
        {!data && !failed && (
          <div className="inline-media-loading muted small">
            <Loader2 size={14} className="spin" /> Loading preview…
          </div>
        )}
        {failed || data?.kind === 'missing' ? (
          <div className="inline-media-fallback muted small">File unavailable on disk: {path}</div>
        ) : data?.kind === 'image' && data.dataUrl ? (
          <img
            src={data.dataUrl}
            alt={data.name}
            className="inline-media-img"
            onClick={view}
            title="Open in the viewer"
          />
        ) : data?.kind === 'video' && data.dataUrl ? (
          <video
            src={data.dataUrl}
            poster={data.thumbUrl}
            controls
            preload="metadata"
            className="inline-media-video"
          />
        ) : data?.kind === 'audio' && data.dataUrl ? (
          <div className="inline-media-audio">
            <audio src={data.dataUrl} controls preload="metadata" />
          </div>
        ) : data?.kind === 'pdf' ? (
          data.thumbUrl ? (
            <img
              src={data.thumbUrl}
              alt={data.name}
              className="inline-media-img is-doc-thumb"
              onClick={view}
              title="Open the PDF in the viewer"
            />
          ) : (
            <div className="inline-media-fallback small" onClick={view}>
              Click Preview to read {data.name}
            </div>
          )
        ) : data?.kind === 'document' ? (
          data.thumbUrl ? (
            <img
              src={data.thumbUrl}
              alt={data.name}
              className="inline-media-img is-doc-thumb"
              onClick={view}
              title="Open the document in the viewer"
            />
          ) : data.html ? (
            <iframe
              sandbox=""
              srcDoc={buildDocSrcDoc(data.html, dark)}
              title={data.name}
              className="inline-media-doc-frame"
            />
          ) : null
        ) : data ? (
          <div className="inline-media-fallback muted small" onClick={view}>
            {data.kind === 'too-large' ? 'Large file — click Download or Preview to open.' : 'Click Preview to inspect file.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InlineFilePreviews({ paths, onOpen }: { paths: string[]; onOpen: (ref: string) => void }) {
  const rich = paths.filter(isRichPreviewPath).slice(0, 6);
  if (!rich.length) return null;
  return (
    <div className="inline-media-list" data-testid="inline-media-list">
      {rich.map((p) => (
        <InlineMediaCard key={p} path={p} onOpen={onOpen} />
      ))}
    </div>
  );
}
