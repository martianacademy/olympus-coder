/**
 * Lightweight Annotator facade so Attachments and MediaViewer don't pull the 1,155-line
 * canvas/video markup editor into the initial renderer bundle.
 */

export interface AnnotateSource {
  path: string;
  name: string;
  mime: string;
}

/** Where the result goes: a composer draft that already holds the original, or the composer on screen. */
export type AnnotateTarget = { draftKey: string } | { composer: true };

export const canAnnotate = (mime: string): boolean => mime.startsWith('image/') || mime.startsWith('video/');

/** Lazily loads the markup editor on first click. */
export function openAnnotator(src: AnnotateSource, target: AnnotateTarget): void {
  void import('./components/Annotator').then((m) => m.openAnnotator(src, target));
}
