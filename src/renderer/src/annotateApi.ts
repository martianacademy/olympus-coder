/**
 * Mark-up types shared without loading the editor (`components/Annotator.tsx`, lazy). Mark-up happens in the media
 * viewer only: its Edit toggle, or a draft card's pen, which opens the viewer with Edit on.
 */

export interface AnnotateSource {
  path: string;
  name: string;
  mime: string;
}

/** Where the result goes: a composer draft that already holds the original, or the composer on screen. */
export type AnnotateTarget = { draftKey: string } | { composer: true };

export const canAnnotate = (mime: string): boolean => mime.startsWith('image/') || mime.startsWith('video/');
