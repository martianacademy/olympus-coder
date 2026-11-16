import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Loader2,
  PencilLine,
  RefreshCw,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import type { FilePreview as Preview } from '@shared/types';
import { api } from '../api';
import { OpenFileContext, RefBaseContext } from '../fileLinks';
import { isRemoteBrowser } from '../responsive';
import { CodeEditor, WrapToggle } from './Editor';
import { Markdown } from './Chat';
import { buildDocSrcDoc, downloadFileRef } from './InlineFilePreviews';
import { parseTurnRef, TurnChangesView } from './TurnChanges';
import { copyText } from '../clipboard';

export interface PreviewTarget {
  ref: string;
  projectId?: string;
  /** Changes on every click, so clicking the same file again reloads it. */
  nonce: number;
}

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const fmtSize = (n?: number) =>
  n === undefined ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

const KIND_ICON: Record<Preview['kind'], React.ReactNode> = {
  text: <FileCode size={15} />,
  markdown: <FileText size={15} />,
  image: <FileImage size={15} />,
  video: <FileVideo size={15} />,
  audio: <FileAudio size={15} />,
  pdf: <FileText size={15} />,
  document: <FileText size={15} />,
  dir: <Folder size={15} />,
  binary: <File size={15} />,
  'too-large': <File size={15} />,
  missing: <File size={15} />,
};

/**
 * Rich in-app file viewer for links in chat, tool steps, and attachments:
 * Markdown, syntax-highlighted code, images (including .heic), playable video/audio, PDFs,
 * and Word/Office/iWork documents (.docx, .doc, .rtf, .odt, .xlsx, .pptx, .pages), plus Download.
 */
type PaneProps = { target: PreviewTarget; dark: boolean; onClose: () => void; editProjectId?: string; onEdit?: (rel: string, line?: number) => void };

export function FilePreviewPane(props: PaneProps) {
  const turn = parseTurnRef(props.target.ref);
  if (turn) return <TurnChangesView key={props.target.nonce} threadId={turn.threadId} itemId={turn.itemId} onClose={props.onClose} />;
  return <FilePane {...props} />;
}

function FilePane(props: PaneProps) {
  const [stack, setStack] = useState<PreviewTarget[]>([props.target]);
  const [data, setData] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);
  const [docPageMode, setDocPageMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const cur = stack[stack.length - 1];
  const remote = isRemoteBrowser();

  useEffect(() => setStack([props.target]), [props.target]);

  const load = () => {
    setLoading(true);
    setError('');
    api
      .preview(cur.ref, cur.projectId)
      .then((d) => {
        setData(d);
        setSource(false);
        setDocPageMode(false);
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  const pdfUrl = usePdfUrl(data);

  const openInside = useMemo(
    () => (ref: string) => setStack((s) => [...s, { ref, projectId: cur.projectId, nonce: Date.now() }]),
    [cur.projectId],
  );
  const base = data ? (data.kind === 'dir' ? data.path : dirOf(data.path)) : undefined;
  const canEdit = Boolean(
    props.onEdit &&
      data?.projectId &&
      data.projectId === props.editProjectId &&
      data.rel !== undefined &&
      (data.kind === 'text' || data.kind === 'markdown'),
  );
  const canDownload = Boolean(data && data.kind !== 'missing' && data.kind !== 'dir');

  const handleDownload = async () => {
    if (!data) return;
    try {
      if (await downloadFileRef(data.path, cur.projectId)) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1400);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="file-preview" data-testid="file-preview">
      <div className="fp-head">
        {stack.length > 1 && (
          <button className="btn ghost icon" title="Back" onClick={() => setStack((s) => s.slice(0, -1))}>
            <ArrowLeft size={15} />
          </button>
        )}
        <span className="fp-icon muted">{data ? KIND_ICON[data.kind] : <File size={15} />}</span>
        <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <span className="fp-name ellipsis" title={data?.path ?? cur.ref}>
            {data?.name ?? cur.ref}
            {data?.line ? <span className="fp-line">:{data.line}</span> : null}
          </span>
          {data && (
            <span className="small muted ellipsis" title={data.path}>
              {short(data.path)}
              {data.size !== undefined && data.kind !== 'dir' ? ` · ${fmtSize(data.size)}` : ''}
            </span>
          )}
        </div>
        {data?.kind === 'markdown' && (
          <div className="seg">
            <button className={!source ? 'active' : ''} onClick={() => setSource(false)} title="Rendered">
              <Eye size={13} /> Preview
            </button>
            <button className={source ? 'active' : ''} onClick={() => setSource(true)} title="Markdown source">
              <Code2 size={13} /> Source
            </button>
          </div>
        )}
        {data?.kind === 'document' && data.html && data.thumbUrl && (
          <div className="seg">
            <button className={!docPageMode ? 'active' : ''} onClick={() => setDocPageMode(false)} title="Readable document text">
              <FileText size={13} /> Text
            </button>
            <button className={docPageMode ? 'active' : ''} onClick={() => setDocPageMode(true)} title="Visual QuickLook page">
              <Eye size={13} /> Page
            </button>
          </div>
        )}
        {canEdit && (
          <button className="btn ghost icon" title="Edit in the Files tab" onClick={() => props.onEdit!(data!.rel!, data!.line)}>
            <PencilLine size={15} />
          </button>
        )}
        {(data?.kind === 'text' || (data?.kind === 'markdown' && source)) && <WrapToggle />}
        {canDownload && (
          <button
            className="btn ghost icon"
            title="Download / Save file"
            data-testid="preview-download"
            onClick={() => void handleDownload()}
          >
            {saved ? <Check size={15} /> : <Download size={15} />}
          </button>
        )}
        <button className="btn ghost icon" title="Reload" onClick={load}>
          {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        </button>
        {!remote && data && data.kind !== 'missing' && (
          <>
            <button className="btn ghost icon" title="Open in its default app" onClick={() => void api.previewOpenDefault(data.path)}>
              <SquareArrowOutUpRight size={15} />
            </button>
            <button className="btn ghost icon" title="Show in Finder" onClick={() => void api.previewReveal(data.path)}>
              <FolderOpen size={15} />
            </button>
          </>
        )}
        {data && (
          <button
            className="btn ghost icon"
            title="Copy path"
            onClick={() => {
              void copyText(data.path).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        )}
        <button className="btn ghost icon" title="Close preview" data-testid="preview-close" onClick={props.onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="fp-body">
        {error && <div className="err-box" style={{ margin: 12 }}>{error}</div>}
        {!data && !error && (
          <div className="fp-empty">
            <Loader2 size={18} className="spin" />
          </div>
        )}
        {data && (
          <OpenFileContext.Provider value={openInside}>
            <RefBaseContext.Provider value={base}>
              <PreviewBody
                data={data}
                source={source}
                docPageMode={docPageMode}
                dark={props.dark}
                pdfUrl={pdfUrl}
                onOpen={openInside}
                onDownload={() => void handleDownload()}
              />
            </RefBaseContext.Provider>
          </OpenFileContext.Provider>
        )}
      </div>
    </div>
  );
}

/** PDFs render in Chromium's viewer from a blob: URL (CSP allows blob: in frame-src). */
export function usePdfUrl(data: Preview | null): string | null {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  useEffect(() => {
    if (data?.kind !== 'pdf' || !data.dataUrl) return setPdfUrl(null);
    const bin = atob(data.dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data]);
  return pdfUrl;
}

/** The body of a preview by kind; also used by the in-chat viewer (`MediaViewer.tsx`). */
export function PreviewBody({
  data,
  source,
  docPageMode,
  dark,
  pdfUrl,
  onOpen,
  onDownload,
}: {
  data: Preview;
  source: boolean;
  docPageMode: boolean;
  dark: boolean;
  pdfUrl: string | null;
  onOpen: (ref: string) => void;
  onDownload: () => void;
}) {
  switch (data.kind) {
    case 'markdown':
      if (!source)
        return (
          <div className="md-preview msg-agent">
            <Markdown text={data.text ?? ''} />
          </div>
        );
      return <CodeEditor key={`${data.path}#src`} path={data.path} value={data.text ?? ''} dark={dark} readOnly line={data.line} onChange={() => {}} onSave={() => {}} />;
    case 'text':
      return <CodeEditor key={data.path} path={data.path} value={data.text ?? ''} dark={dark} readOnly line={data.line} onChange={() => {}} onSave={() => {}} />;
    case 'image':
      return (
        <div className="img-preview">
          <img src={data.dataUrl} alt={data.name} />
        </div>
      );
    case 'video':
      return (
        <div className="video-preview-stage">
          <video src={data.dataUrl} poster={data.thumbUrl} controls className="video-preview-el" />
        </div>
      );
    case 'audio':
      return (
        <div className="audio-preview-stage">
          <FileAudio size={38} className="muted" />
          <div className="fp-name">{data.name}</div>
          <audio src={data.dataUrl} controls className="audio-preview-el" />
        </div>
      );
    case 'pdf':
      return pdfUrl ? <iframe className="pdf-preview" src={pdfUrl} title={data.name} /> : null;
    case 'document':
      if (data.html && (!docPageMode || !data.thumbUrl)) {
        return <iframe sandbox="" className="doc-html-preview" srcDoc={buildDocSrcDoc(data.html, dark)} title={data.name} />;
      }
      if (data.thumbUrl) {
        return (
          <div className="img-preview">
            <img src={data.thumbUrl} alt={data.name} />
          </div>
        );
      }
      return <Notice text="Document preview unavailable." path={data.path} onDownload={onDownload} />;
    case 'dir':
      return (
        <div className="dir-preview">
          {(data.entries ?? []).map((e) => (
            <div key={e.name} className="dir-row" onClick={() => onOpen(`${data.path}/${e.name}`)}>
              {e.dir ? <Folder size={14} className="muted" /> : <File size={14} className="muted" />}
              <span className="ellipsis">{e.name}</span>
            </div>
          ))}
          {!data.entries?.length && <div className="muted small">Empty folder.</div>}
        </div>
      );
    case 'binary':
      return <Notice text="This is a binary file, so it can't be shown as text." path={data.path} onDownload={onDownload} />;
    case 'too-large':
      return (
        <div className="fp-empty">
          {data.thumbUrl ? <img src={data.thumbUrl} alt={data.name} style={{ maxWidth: 320, maxHeight: 220, borderRadius: 8 }} /> : <File size={22} className="muted" />}
          <span className="muted">This file is too large to stream inline here, so download or open it directly.</span>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small primary" onClick={onDownload}>
              <Download size={13} /> Download
            </button>
            {!isRemoteBrowser() && (
              <button className="btn small" onClick={() => void api.previewOpenDefault(data.path)}>
                <SquareArrowOutUpRight size={13} /> Open in default app
              </button>
            )}
          </div>
        </div>
      );
    case 'missing':
      return <Notice text={`Not found: ${data.path}`} />;
  }
}

function Notice({ text, path, onDownload }: { text: string; path?: string; onDownload?: () => void }) {
  return (
    <div className="fp-empty">
      <File size={22} className="muted" />
      <span className="muted">{text}</span>
      <div className="row" style={{ gap: 8 }}>
        {onDownload && (
          <button className="btn small primary" onClick={onDownload}>
            <Download size={13} /> Download
          </button>
        )}
        {path && !isRemoteBrowser() && (
          <button className="btn small" onClick={() => void api.previewOpenDefault(path)}>
            <SquareArrowOutUpRight size={13} /> Open in its default app
          </button>
        )}
      </div>
    </div>
  );
}
