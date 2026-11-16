import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Maximize2,
  Paperclip,
  Play,
  X,
} from 'lucide-react';
import type { AttachmentView } from '@shared/types';
import { api } from '../api';
import { readCopiedMessage, readSystemMessage, type CopiedMessage } from '../clipboard';
import { addDraftFiles, removeDraftFile, setDraftText, updateDraftFilePreview, useDraft } from '../drafts';
import { downloadFileRef } from './InlineFilePreviews';
import { viewerAttrs, viewerKindOf } from './MediaViewer';
import { AddToMessageButton, useComposerTarget } from './AddToMessage';

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Short uppercase badge for the card preview stage (e.g. "MOV", "PNG", "TSX", "PDF"). */
function extBadge(name: string, mime: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    const raw = name.slice(dot + 1).toUpperCase();
    if (/^[A-Z0-9]{1,6}$/.test(raw)) return raw;
  }
  const sub = mime.split('/')[1]?.split('+')[0]?.replace(/^x-/, '').toUpperCase() ?? 'FILE';
  return sub.slice(0, 6);
}

function iconFor(mime: string, size = 24) {
  if (mime.startsWith('image/')) return <FileImage size={size} />;
  if (mime.startsWith('video/')) return <FileVideo size={size} />;
  if (mime.startsWith('audio/')) return <FileAudio size={size} />;
  if (/zip|tar|gzip|rar|7z/.test(mime)) return <FileArchive size={size} />;
  if (/sheet|excel|csv|tab-separated/.test(mime)) return <FileSpreadsheet size={size} />;
  if (/pdf|word|document|markdown|text\/plain|presentation/.test(mime)) return <FileText size={size} />;
  if (mime.startsWith('text/') || /json|xml|javascript|typescript/.test(mime)) return <FileCode size={size} />;
  return <FileIcon size={size} />;
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const canThumbnail = (mime: string) =>
  mime.startsWith('image/') ||
  mime.startsWith('video/') ||
  mime === 'application/pdf' ||
  /\b(msword|officedocument|ms-excel|ms-powerpoint|rtf|opendocument|apple\.(?:pages|numbers|keynote))\b/.test(mime);

/** Attach dropped or pasted `File` objects directly into `targetKey`'s draft (`threadId` or `HOME_DRAFT_KEY`). */
export async function attachFileListToDraft(targetKey: string, list: File[]): Promise<void> {
  for (const f of list) {
    const path = !isRemoteBrowser() ? window.desk.pathForFile(f) : '';
    if (path) addDraftFiles(targetKey, await api.describeAttachments([path]));
    else {
      const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
      addDraftFiles(
        targetKey,
        [await api.saveAttachment(f.name || `pasted.${ext}`, f.type || 'application/octet-stream', await toBase64(f))],
      );
    }
  }
}

/**
 * Inserts pasted text at the caret like typing (one undo step); falls back to a direct draft update. Runs after
 * the paste event: Chromium ignores `insertText` while the paste command is still running.
 */
function insertAtCaret(ta: HTMLTextAreaElement, text: string, targetKey: string) {
  if (!text) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  setTimeout(() => {
    if (!ta.isConnected) {
      setDraftText(targetKey, (prev) => prev + text);
      return;
    }
    ta.focus();
    ta.setSelectionRange(start, end);
    const before = ta.value;
    try {
      document.execCommand('insertText', false, text);
    } catch {
      /* fall through */
    }
    if (ta.value === before) {
      ta.setRangeText(text, start, end, 'end');
      setDraftText(targetKey, ta.value);
    }
  }, 0);
}

/** Avoid re-requesting previews for files the OS could not thumbnail (e.g. unsupported codec or Linux). */
const attemptedPreviewPaths = new Set<string>();

/** True when running in a web/phone browser over `bridge.ts` rather than native Electron preload. */
export const isRemoteBrowser = () => typeof window !== 'undefined' && Boolean((window as unknown as { __OLYMPUS_REMOTE__?: boolean }).__OLYMPUS_REMOTE__);

/**
 * Attachment state for a composer (`draftKey` = `threadId` or `HOME_DRAFT_KEY`): file picker (native dialog on
 * desktop, `<input type="file">` on phone/web), drag & drop, and clipboard paste. Stored in `drafts.ts`.
 */
export function useAttachments(draftKey: string) {
  const { files } = useDraft(draftKey);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDragging(false);
    setError('');
  }, [draftKey]);
  // "Add to message" on chat files lands in this composer while it is on screen.
  useComposerTarget(draftKey, setError);

  // Rehydrate missing media/PDF thumbnails from disk (e.g. after localStorage quota fallback).
  useEffect(() => {
    const missing = files
      .filter((f) => canThumbnail(f.mime) && !f.preview && !attemptedPreviewPaths.has(f.path))
      .map((f) => f.path);
    if (!missing.length) return;
    let cancelled = false;
    for (const p of missing) {
      attemptedPreviewPaths.add(p);
      void api
        .describeAttachments([p])
        .then(([d]) => {
          if (!cancelled && d?.preview) updateDraftFilePreview(draftKey, d.path, d.preview);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [draftKey, files]);

  const addFiles = useCallback(async (targetKey: string, list: File[]) => {
    setError('');
    try {
      await attachFileListToDraft(targetKey, list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Attachments of a copied message: reuses the saved files (no re-upload) and skips ones that are gone. */
  const addCopied = useCallback(async (targetKey: string, list: CopiedMessage['attachments']) => {
    setError('');
    if (!list.length) return;
    try {
      const found = new Map((await api.describeAttachments(list.map((a) => a.path))).map((d) => [d.path, d]));
      const kept = list.flatMap((a) => {
        const d = found.get(a.path);
        return d ? [{ ...d, name: a.name || d.name, mime: a.mime || d.mime }] : [];
      });
      addDraftFiles(targetKey, kept);
      const missing = list.length - kept.length;
      if (missing) setError(missing === 1 ? '1 attached file no longer exists and was skipped' : `${missing} attached files no longer exist and were skipped`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    files,
    error,
    dragging,
    remove: (path: string) => removeDraftFile(draftKey, path),
    addRawFiles: (list: File[]) => void addFiles(draftKey, list),
    pick: async () => {
      const targetKey = draftKey;
      try {
        setError('');
        addDraftFiles(targetKey, await api.pickAttachments());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    /** Spread on the composer box. */
    dropProps: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(draftKey, [...e.dataTransfer.files]);
      },
    },
    /**
     * Put on the textarea: a message copied in Olympus restores its text and attachments, pasted files /
     * screenshots become attachments, pasted text stays text.
     */
    onPaste: (e: React.ClipboardEvent) => {
      const copied = readCopiedMessage(e.clipboardData);
      if (copied && e.currentTarget instanceof HTMLTextAreaElement) {
        e.preventDefault();
        insertAtCaret(e.currentTarget, copied.text, draftKey);
        void addCopied(draftKey, copied.attachments);
        return;
      }
      const list = [...e.clipboardData.files];
      if (!list.length) return;
      e.preventDefault();
      const ta = e.currentTarget;
      const paths = isRemoteBrowser() ? [] : list.map((f) => window.desk.pathForFile(f));
      if (!paths.length || paths.some((p) => !p) || !(ta instanceof HTMLTextAreaElement)) {
        void addFiles(draftKey, list);
        return;
      }
      // macOS hides a copied message's text behind its file URLs: if these are its files, restore the message.
      const targetKey = draftKey;
      void readSystemMessage().then((m) => {
        if (m && paths.every((p) => m.attachments.some((a) => a.path === p))) {
          insertAtCaret(ta, m.text, targetKey);
          void addCopied(targetKey, m.attachments);
        } else void addFiles(targetKey, list);
      });
    },
  };
}

export function AttachButton({ onClick, onFiles }: { onClick: () => void; onFiles?: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const remote = isRemoteBrowser();
  return (
    <>
      {remote && onFiles && (
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const picked = e.target.files ? [...e.target.files] : [];
            e.target.value = '';
            if (picked.length) onFiles(picked);
          }}
        />
      )}
      <button
        className="btn ghost icon attach-btn"
        title="Attach files — images, videos, PDFs, docs, code (drag & drop or ⌘V also work)"
        aria-label="Attach files"
        onClick={() => (remote && onFiles ? inputRef.current?.click() : onClick())}
        type="button"
      >
        <Paperclip size={17} aria-hidden="true" />
      </button>
    </>
  );
}

/** A sent video or audio attachment playing inside its card (`api.preview` data URL, so it also works on the phone). */
function CardPlayer({ a, onExpand }: { a: AttachmentView; onExpand?: (el: HTMLElement) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const audio = a.mime.startsWith('audio/');
  useEffect(() => {
    let alive = true;
    api
      .preview(a.path)
      .then((d) => {
        if (!alive) return;
        if (d.dataUrl) setSrc(d.dataUrl);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [a.path]);
  return (
    <div className={`attach-player ${audio ? 'is-audio' : ''}`} data-testid="attach-player" onClick={(e) => e.stopPropagation()}>
      {failed ? (
        <span className="small muted">Can't play this file here</span>
      ) : !src ? (
        <Loader2 size={16} className="spin muted" />
      ) : audio ? (
        <audio src={src} controls autoPlay />
      ) : (
        <video src={src} poster={a.preview} controls autoPlay playsInline />
      )}
      {!audio && onExpand && (
        <button
          type="button"
          className="attach-expand"
          title="Open full size"
          aria-label={`Open ${a.name} full size`}
          data-testid="attach-expand"
          onClick={(e) => onExpand(e.currentTarget)}
        >
          <Maximize2 size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * Modern vertical attachment cards: a prominent visual preview stage on top (crisp image/video/PDF frame or
 * styled extension tile) and a compact filename + size caption strip underneath.
 */
export function AttachmentChips({
  files,
  onRemove,
  onOpen,
  inlinePlay,
  addable,
}: {
  files: AttachmentView[];
  onRemove?: (path: string) => void;
  /** `el` is the clicked card (the in-chat viewer collects the chat's gallery around it). */
  onOpen?: (a: AttachmentView, el: HTMLElement) => void;
  /** Sent messages: videos and audio play inside their card instead of calling `onOpen`. */
  inlinePlay?: boolean;
  /** Sent messages: an "Add to message" action puts the same file into the composer's draft. */
  addable?: boolean;
}) {
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [playing, setPlaying] = useState<ReadonlySet<string>>(new Set());
  if (!files.length) return null;
  return (
    <div className="attach-list">
      {files.map((a) => {
        const isVid = a.mime.startsWith('video/');
        const badge = extBadge(a.name, a.mime);
        const justSaved = savedPath === a.path;
        const playable = Boolean(inlinePlay && (isVid || a.mime.startsWith('audio/')));
        const isPlaying = playable && playing.has(a.path);
        return (
          <div
            key={a.path}
            className={`attach-chip ${a.preview ? 'has-preview' : 'no-preview'} ${isVid ? 'is-video' : ''} ${onOpen ? 'is-clickable' : ''}`}
            title={isPlaying ? undefined : `${a.name} (${fmtSize(a.size)})\n${playable ? 'Click to play' : 'Click to preview'} · ${a.path}`}
            onClick={(e) => {
              if (playable) setPlaying((s) => new Set(s).add(a.path));
              else onOpen?.(a, e.currentTarget);
            }}
            data-testid="attach-chip"
            {...(inlinePlay ? viewerAttrs(a.path, viewerKindOf(a.path, a.mime), a.name) : {})}
          >
            <div className="attach-stage">
              {isPlaying ? (
                <CardPlayer a={a} onExpand={onOpen ? (el) => onOpen(a, el) : undefined} />
              ) : a.preview ? (
                <img src={a.preview} alt={a.name} className="attach-thumb" />
              ) : (
                <div className="attach-placeholder">
                  <span className="attach-icon" aria-hidden="true">
                    {iconFor(a.mime, 24)}
                  </span>
                  <span className="attach-badge">{badge}</span>
                </div>
              )}
              {isVid && !isPlaying && (
                <span className="attach-play" aria-hidden="true">
                  <Play size={13} fill="currentColor" />
                </span>
              )}
              {a.preview && !isPlaying && <span className="attach-corner-badge">{badge}</span>}
              <button
                type="button"
                className={`attach-dl ${onRemove ? 'with-x' : ''}`}
                title="Download / Save file"
                aria-label={`Download ${a.name}`}
                data-testid="attach-download"
                onClick={(e) => {
                  e.stopPropagation();
                  void downloadFileRef(a.path)
                    .then((ok) => {
                      if (!ok) return;
                      setSavedPath(a.path);
                      setTimeout(() => setSavedPath((cur) => (cur === a.path ? null : cur)), 1400);
                    })
                    .catch(() => {});
                }}
              >
                {justSaved ? <Check size={12} aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
              </button>
              {addable && <AddToMessageButton path={a.path} name={a.name} mime={a.mime} className="attach-dl attach-add" />}
              {onRemove && (
                <button
                  type="button"
                  className="attach-x"
                  title="Remove attachment"
                  aria-label={`Remove ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(a.path);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="attach-meta">
              <span className="ellipsis attach-name">{a.name}</span>
              <span className="attach-sub">{fmtSize(a.size)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
