import { memo, useEffect, useState, type ReactNode } from 'react';
import { Check, Download, EyeOff, FileAudio, FileText, Globe, ImageOff, Link2, Loader2, MapPin } from 'lucide-react';
import {
  baseNameOf,
  fileUriPath,
  fmtBytes,
  isForUser,
  isWebUri,
  locationRef,
  type ContentAnnotations,
  type OmittedReason,
  type RichContent,
  type RichResource,
  type RichResourceLink,
  type ToolLocation,
} from '@shared/acpContent';
import type { FilePreview } from '@shared/types';
import { api } from '../api';
import { useOpenFile } from '../fileLinks';
import { isRemoteBrowser } from '../responsive';
import { Markdown } from './ChatMarkdown';
import { downloadFileRef } from './InlineFilePreviews';
import { isViewerTarget, openViewer, viewerAttrs } from '../mediaViewerApi';
import { AddToMessageButton } from './AddToMessage';
import { StepBox } from './StepBox';
import '../richContent.css';

/**
 * ACP content blocks that are more than Markdown text: images and audio the agent sent (saved in the chat's media
 * folder, loaded through `preview.open` so they also show on the phone), embedded resources, resource links, and
 * content meant only for the agent. Plus tool call locations with their line. Shapes: `src/shared/acpContent.ts`.
 */

const OMITTED: Record<OmittedReason, string> = {
  'too-large': 'Too large to keep in the chat',
  quota: "Not saved: this chat's media folder is full",
  invalid: 'The agent sent data that could not be read',
  'write-failed': 'Could not be saved to disk',
};

function openWeb(url: string) {
  if (isRemoteBrowser()) window.open(url, '_blank', 'noopener,noreferrer');
  else void api.openExternal(url);
}

/** Loads a saved media file once (data URL), on the desktop and the phone alike. */
function useMedia(path?: string): { data: FilePreview | null; failed: boolean } {
  const [data, setData] = useState<FilePreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setData(null);
    setFailed(false);
    api
      .preview(path)
      .then((r) => alive && setData(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path]);
  return { data, failed };
}

function DownloadButton({ path }: { path: string }) {
  const [saved, setSaved] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost icon rich-act"
      title="Download"
      data-testid="rich-download"
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

function Omitted({ icon, label, reason, size }: { icon: ReactNode; label: string; reason?: OmittedReason; size?: number }) {
  return (
    <div className="rich-omitted small" data-testid="rich-omitted" data-reason={reason}>
      {icon}
      <span className="ellipsis">
        {label}
        {reason ? ` · ${OMITTED[reason]}` : ''}
        {size ? ` (${fmtBytes(size)})` : ''}
      </span>
    </div>
  );
}

function RichImageView({ path, uri, mimeType, size, reason }: { path?: string; uri?: string; mimeType: string; size?: number; reason?: OmittedReason }) {
  const openFile = useOpenFile();
  const { data, failed } = useMedia(path);
  if (!path) {
    // A web image is not loaded by itself (privacy); it opens in the browser on click.
    if (uri && isWebUri(uri)) {
      return (
        <button type="button" className="rich-link" data-testid="rich-web-image" title={`Open ${uri} in your browser`} onClick={() => openWeb(uri)}>
          <Globe size={13} className="rich-link-icon" />
          <span className="rich-link-name ellipsis">Web image</span>
          <span className="rich-link-meta mono ellipsis">{hostOf(uri)}</span>
        </button>
      );
    }
    return <Omitted icon={<ImageOff size={13} />} label="Image" reason={reason ?? 'invalid'} size={size} />;
  }
  return (
    <figure className="rich-image" data-testid="rich-image" {...viewerAttrs(path, 'image', data?.name)}>
      {data?.kind === 'image' && data.dataUrl ? (
        <img
          src={data.dataUrl}
          alt="Image from the agent"
          title="Open the full image"
          onClick={(e) => openViewer({ ref: path, from: e.currentTarget, mime: mimeType, openInPanel: openFile })}
        />
      ) : failed || data ? (
        <Omitted icon={<ImageOff size={13} />} label="Image" reason="write-failed" />
      ) : (
        <div className="rich-loading muted small">
          <Loader2 size={13} className="spin" /> Loading image…
        </div>
      )}
      <figcaption className="rich-caption small muted">
        <span className="mono">{mimeType.replace(/^image\//, '').toUpperCase()}</span>
        {size ? <span>{fmtBytes(size)}</span> : null}
        <span className="grow" />
        <AddToMessageButton path={path} mime={mimeType} />
        <DownloadButton path={path} />
      </figcaption>
    </figure>
  );
}

function RichAudioView({ path, mimeType, size, reason }: { path?: string; mimeType: string; size?: number; reason?: OmittedReason }) {
  const { data, failed } = useMedia(path);
  if (!path) return <Omitted icon={<FileAudio size={13} />} label="Audio" reason={reason ?? 'invalid'} size={size} />;
  return (
    <div className="rich-audio" data-testid="rich-audio">
      <FileAudio size={14} className="rich-link-icon" />
      {data?.dataUrl ? (
        <audio src={data.dataUrl} controls preload="metadata" />
      ) : failed || data ? (
        <span className="small muted">This audio format cannot be played here.</span>
      ) : (
        <Loader2 size={13} className="spin muted" />
      )}
      <span className="rich-link-meta mono">{[mimeType.replace(/^audio\//, ''), fmtBytes(size)].filter(Boolean).join(' · ')}</span>
      <AddToMessageButton path={path} mime={mimeType} />
      <DownloadButton path={path} />
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function linkTip(c: { uri: string; description?: string; mimeType?: string; annotations?: ContentAnnotations }): string {
  const lm = c.annotations?.lastModified ? new Date(c.annotations.lastModified) : undefined;
  return [c.description, c.uri, c.mimeType, lm && !Number.isNaN(lm.getTime()) ? `Last changed ${lm.toLocaleString()}` : '']
    .filter(Boolean)
    .join('\n');
}

/** A resource link as a calm chip: name, size, short description; opens files in the in-chat viewer, web links in the browser. */
function ResourceLinkChip({ c }: { c: RichResourceLink }) {
  const openFile = useOpenFile();
  const file = fileUriPath(c.uri);
  const web = isWebUri(c.uri);
  const act = file
    ? (e: React.MouseEvent<HTMLElement>) => openViewer({ ref: file, from: e.currentTarget, mime: c.mimeType, name: c.title || c.name, openInPanel: openFile })
    : web
      ? () => openWeb(c.uri)
      : undefined;
  const label = c.title || c.name || baseNameOf(c.uri);
  const chip = (
    <button
      type="button"
      className={`rich-link ${act ? '' : 'is-static'}`}
      data-testid="rich-resource-link"
      title={linkTip(c)}
      disabled={!act}
      onClick={act}
    >
      {web ? <Globe size={13} className="rich-link-icon" /> : file ? <FileText size={13} className="rich-link-icon" /> : <Link2 size={13} className="rich-link-icon" />}
      <span className="rich-link-name ellipsis">{label}</span>
      {c.size !== undefined && <span className="rich-link-meta mono">{fmtBytes(c.size)}</span>}
      {c.description && <span className="rich-link-desc ellipsis">{c.description}</span>}
    </button>
  );
  if (!file) return chip;
  return (
    <div className="rich-link-row">
      {chip}
      <AddToMessageButton path={file} name={label} mime={c.mimeType} />
    </div>
  );
}

/** An embedded resource: text in a capped step box (Markdown for Markdown), binary contents as media or a file chip. */
function EmbeddedResource({ c }: { c: RichResource }) {
  const openFile = useOpenFile();
  const name = baseNameOf(c.uri || c.path || 'resource');
  const mime = c.mimeType ?? '';
  if (c.encoding === 'blob') {
    if (mime.startsWith('image/')) return <RichImageView path={c.path} mimeType={mime} size={c.size} reason={c.omitted} />;
    if (mime.startsWith('audio/')) return <RichAudioView path={c.path} mimeType={mime} size={c.size} reason={c.omitted} />;
    if (!c.path) return <Omitted icon={<FileText size={13} />} label={name} reason={c.omitted ?? 'invalid'} size={c.size} />;
    return (
      <div className="rich-link-row" data-testid="rich-resource-blob">
        <button
          type="button"
          className="rich-link"
          title={linkTip(c)}
          onClick={(e) => openViewer({ ref: c.path!, from: e.currentTarget, mime, name, openInPanel: openFile })}
        >
          <FileText size={13} className="rich-link-icon" />
          <span className="rich-link-name ellipsis">{name}</span>
          <span className="rich-link-meta mono">{[mime, fmtBytes(c.size)].filter(Boolean).join(' · ')}</span>
        </button>
        <AddToMessageButton path={c.path} name={name} mime={mime || undefined} />
        <DownloadButton path={c.path} />
      </div>
    );
  }
  const text = c.text ?? '';
  const isMd = /markdown/.test(mime) || /\.(md|markdown|mdx)$/i.test(name);
  const more = c.textOmitted ? `+${c.textOmitted.toLocaleString()} chars` : undefined;
  return (
    <div className="rich-resource" data-testid="rich-resource-text" title={c.uri}>
      <StepBox
        kind="read"
        title={name}
        sub={mime || undefined}
        meta={more}
        filePath={c.path ?? fileUriPath(c.uri)}
        copyText={text}
        mono={!isMd}
      >
        {isMd ? <Markdown text={text} /> : <pre className="step-box-pre">{text}</pre>}
      </StepBox>
    </div>
  );
}

/** One stored content block that is not plain Markdown text. */
export const RichBlock = memo(function RichBlock({ c }: { c: RichContent }) {
  switch (c.type) {
    case 'text':
      return <Markdown text={c.text} />;
    case 'image':
      return <RichImageView path={c.path} uri={c.uri} mimeType={c.mimeType} size={c.size} reason={c.omitted} />;
    case 'audio':
      return <RichAudioView path={c.path} mimeType={c.mimeType} size={c.size} reason={c.omitted} />;
    case 'resource':
      return <EmbeddedResource c={c} />;
    case 'resource_link':
      return <ResourceLinkChip c={c} />;
  }
});

/** Content the agent marked as meant only for the assistant: folded away and dimmed, one click to look. */
function AgentOnly({ children }: { children: ReactNode }) {
  return (
    <details className="rich-agent-only" data-testid="rich-agent-only">
      <summary title="The agent marked this content as meant for the model, not for you">
        <EyeOff size={12} /> For the agent
      </summary>
      <div className="rich-agent-only-body">{children}</div>
    </details>
  );
}

function Block({ c }: { c: RichContent }) {
  const body = <RichBlock c={c} />;
  return isForUser(c.annotations) ? body : <AgentOnly>{body}</AgentOnly>;
}

/** A message in order (`parts`): text through Markdown, everything else as rich blocks. */
export const MessageParts = memo(function MessageParts({ parts }: { parts: RichContent[] }) {
  return (
    <div className="rich-parts" data-testid="rich-parts">
      {parts.map((c, i) => (
        <Block key={i} c={c} />
      ))}
    </div>
  );
});

/** The rich entries of a tool call's content (entries whose `rich` is set); nothing when there are none. */
export function ToolRichContent({ entries }: { entries: ReadonlyArray<{ rich?: RichContent }> }) {
  const rich = entries.flatMap((e) => (e.rich ? [e.rich] : []));
  if (!rich.length) return null;
  return (
    <div className="rich-parts is-tool" data-testid="tool-rich-content">
      {rich.map((c, i) => (
        <Block key={i} c={c} />
      ))}
    </div>
  );
}

/** Tool call locations as small chips (`name.ts:12`); a click opens the file in the side panel at that line. */
export function LocationLinks({ locations, max = 12 }: { locations: ToolLocation[]; max?: number }) {
  const openFile = useOpenFile();
  const [all, setAll] = useState(false);
  if (!locations.length) return null;
  const shown = all ? locations : locations.slice(0, max);
  return (
    <div className="rich-locations" data-testid="tool-locations">
      {shown.map((l, i) => (
        <button
          key={`${l.path}:${l.line ?? ''}:${i}`}
          type="button"
          className="rich-loc mono"
          data-testid="tool-location"
          title={l.line ? `Open ${l.path} at line ${l.line}` : `Open ${l.path}`}
          onClick={(e) => {
            const ref = locationRef(l);
            if (!l.line && isViewerTarget(l.path)) openViewer({ ref: l.path, from: e.currentTarget, openInPanel: openFile });
            else openFile(ref);
          }}
        >
          <MapPin size={11} />
          <span className="ellipsis">{baseNameOf(l.path)}</span>
          {l.line ? <span className="rich-loc-line">:{l.line}</span> : null}
        </button>
      ))}
      {!all && locations.length > max && (
        <button type="button" className="rich-loc more" title="Show every location" onClick={() => setAll(true)}>
          +{locations.length - max}
        </button>
      )}
    </div>
  );
}
