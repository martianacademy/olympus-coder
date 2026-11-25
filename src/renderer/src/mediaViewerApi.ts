/**
 * Lightweight MediaViewer facade so chat components can tag gallery items and trigger
 * `openViewer()` without pulling MediaViewer, FilePreview, CodeMirror, or Annotator
 * into the initial renderer bundle.
 */

export type ViewerKind = 'image' | 'video' | 'audio' | 'file';

export interface ViewerItem {
  ref: string;
  kind: ViewerKind;
  name?: string;
}

export interface OpenViewerOptions {
  ref: string;
  from?: Element | null;
  name?: string;
  mime?: string;
  projectId?: string;
  openInPanel: (ref: string) => void;
  draftKey?: string;
  /** Additional gallery items (e.g. images behind a collapsed `+N` badge) to splice into the chat gallery in order. */
  extraItems?: ViewerItem[];
  /** Open with the Edit toggle on (a draft card's pen). */
  edit?: boolean;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv|mkv)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
const DOC_VIEWER_EXT = /\.(pdf|docx?|rtf|odt|xlsx|pptx|pages|numbers|key)$/i;

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

/** True when a file reference has no `:line` / `#Lline` anchor and points to media or a rich document suited to `MediaViewer`. */
export function isViewerTarget(ref: string): boolean {
  const trimmed = ref.trim().replace(/^file:\/\//i, '');
  if (!trimmed || /(?::\d+(?::\d+)?|#L?\d+(?:-L?\d+)?)$/i.test(trimmed)) return false;
  const clean = trimmed.replace(/[?#].*$/, '');
  return IMAGE_EXT.test(clean) || VIDEO_EXT.test(clean) || AUDIO_EXT.test(clean) || DOC_VIEWER_EXT.test(clean);
}

/** Attributes that make an element part of the chat's gallery. */
export function viewerAttrs(ref: string, kind: ViewerKind, name?: string) {
  return { 'data-viewer-ref': ref, 'data-viewer-kind': kind, 'data-viewer-name': name };
}

/** Lazily loads MediaViewer on first open and renders the requested item. */
export function openViewer(opts: OpenViewerOptions): void {
  void import('./components/MediaViewer').then((m) => m.openViewer(opts));
}
