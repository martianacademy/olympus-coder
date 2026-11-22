import type { ThreadItem } from '@shared/types';
import type { WorkStepItem } from './workStepSummary';

export type ToolItem = Extract<ThreadItem, { kind: 'tool' }>;

/**
 * One image referenced or returned by a tool step, ready for thumbnail strips in `WorkGroup` / `StepRowHead`
 * and for opening in the shared media `Sheet` (`MediaViewer`).
 */
export interface StepImage {
  /** Path passed to thumbnail loaders and `openViewer` (persisted chat media copy when present, else file path). */
  ref: string;
  /** Human-readable file name (original basename when known, rather than a hashed media copy name). */
  name: string;
  /** MIME type when reported by an ACP rich content block. */
  mime?: string;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i;
const WEB_URI_RE = /^(?:https?|data|blob|mailto):/i;
const PATH_KEY_RE = /^(?:path|file_path|filepath|targetfile|uri|image_path|output_path)$/i;
const PATH_LIST_KEY_RE = /^(?:paths|image_paths|images)$/i;

/** Strips `file://`, line anchors (`:12`, `#L12-L20`), and query/hash fragments from a raw file reference. */
function cleanPath(raw: string): string {
  let s = raw.trim().replace(/^["'<]|["'>]$/g, '');
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/(?:localhost)?/i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep raw percent-encoding if malformed */
    }
  }
  return s.replace(/#L?\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
}

/** True when `raw` points to a local image file (not a web/data URI). */
export function isImagePath(raw: string): boolean {
  const s = raw.trim();
  if (!s || WEB_URI_RE.test(s)) return false;
  const cleaned = cleanPath(s).replace(/[?#].*$/, '');
  return IMAGE_EXT_RE.test(cleaned);
}

/** Extracts the file's display basename without query/hash suffixes. */
function baseName(raw: string): string {
  const stripped = cleanPath(raw).replace(/[?#].*$/, '');
  return stripped.split(/[\\/]/).filter(Boolean).pop() || stripped;
}

/** Resolves a relative file path against `base` (project folder), leaving absolute and `~` paths untouched. */
function resolveAgainst(raw: string, base?: string): string {
  const cleaned = cleanPath(raw);
  if (!base || !cleaned) return cleaned;
  if (/^(?:\/|~|[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(cleaned)) return cleaned;
  return `${base.replace(/[\\/]+$/, '')}/${cleaned.replace(/^\.[\\/]/, '')}`;
}

/** Extracts local image paths from a tool's `Input:` JSON payload (non-command tools). */
function inputImagePaths(item: ToolItem): string[] {
  const inputEntry = item.content.find((c) => c.type !== 'diff' && !c.rich && c.text && /^Input:(?:\s|$)/.test(c.text));
  if (!inputEntry?.text) return [];
  const raw = inputEntry.text.replace(/^Input:\s*/, '').trim();
  if (!raw.startsWith('{')) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (PATH_KEY_RE.test(k) && typeof v === 'string' && isImagePath(v)) {
      out.push(v);
    } else if (PATH_LIST_KEY_RE.test(k) && Array.isArray(v)) {
      for (const el of v) {
        if (typeof el === 'string' && isImagePath(el)) out.push(el);
      }
    }
  }
  return out;
}

/**
 * Extracts images belonging to one tool call (`Read` / `read_file` on an image, MCP/agent rich image blocks,
 * embedded image resources, or `file://` image resource links).
 *
 * When a step has both a persisted ACP `rich` image copy (in `~/.olympus/attachments/chats/...`) and a matching
 * original path in `locations` (e.g. Claude Code's `Read /tmp/shot.png`), it pairs them into a single entry using
 * the durable `rich.path` as `ref` and the original filename (`shot.png`) as `name` so the thumbnail never duplicates
 * and survives `/tmp` cleanup.
 */
export function extractToolImages(item: ToolItem, base?: string): StepImage[] {
  const richImages: StepImage[] = [];
  for (const c of item.content) {
    const r = c.rich;
    if (!r) continue;
    if (r.type === 'image' && r.path) {
      richImages.push({ ref: r.path, name: baseName(r.path), mime: r.mimeType });
    } else if (r.type === 'resource' && r.encoding === 'blob' && r.mimeType?.startsWith('image/') && r.path) {
      richImages.push({ ref: r.path, name: baseName(r.uri || r.path), mime: r.mimeType });
    } else if (r.type === 'resource_link' && /^file:\/\//i.test(r.uri)) {
      const f = cleanPath(r.uri);
      if (f && (r.mimeType?.startsWith('image/') || isImagePath(f))) {
        richImages.push({ ref: f, name: r.title || r.name || baseName(f), mime: r.mimeType });
      }
    }
  }

  const locImages: StepImage[] = [];
  if (item.status !== 'failed') {
    const seenLoc = new Set<string>();
    const addLoc = (raw: string) => {
      if (!isImagePath(raw)) return;
      const ref = resolveAgainst(raw, base);
      if (!ref || seenLoc.has(ref)) return;
      seenLoc.add(ref);
      locImages.push({ ref, name: baseName(ref) });
    };

    for (const loc of item.locations) addLoc(loc);
    if (item.locationRefs) {
      for (const loc of item.locationRefs) addLoc(loc.path);
    }

    const isCmd = item.toolKind === 'execute' || Boolean(item.terminalKey);
    if (!isCmd) {
      for (const p of inputImagePaths(item)) addLoc(p);
      if (item.toolKind === 'read' && locImages.length === 0) {
        const stripped = item.title.replace(/^(?:Read|File)\s+/i, '').trim();
        if (stripped && !/\s/.test(stripped)) addLoc(stripped);
      }
    }
  }

  const combined: StepImage[] = [];
  const seen = new Set<string>();
  const pushUnique = (img: StepImage) => {
    if (!img.ref || seen.has(img.ref)) return;
    seen.add(img.ref);
    combined.push(img);
  };

  if (richImages.length === 0) {
    for (const img of locImages) pushUnique(img);
    return combined;
  }

  // Pair rich copies with original filenames from locations/input so we never show duplicates for Read <img.png>.
  richImages.forEach((img, idx) => {
    const pairedLoc = locImages[idx];
    const name = pairedLoc ? pairedLoc.name : img.name;
    pushUnique({ ...img, name });
  });

  // Only append extra location images beyond the paired rich copies (e.g. a tool touching multiple files).
  for (let i = richImages.length; i < locImages.length; i++) {
    pushUnique(locImages[i]);
  }
  return combined;
}

/** Collects all unique images across a `WorkGroup`'s steps in chronological order. */
export function extractGroupImages(items: WorkStepItem[], base?: string): StepImage[] {
  const seen = new Set<string>();
  const out: StepImage[] = [];
  for (const it of items) {
    if (it.kind !== 'tool') continue;
    for (const img of extractToolImages(it, base)) {
      if (seen.has(img.ref)) continue;
      seen.add(img.ref);
      out.push(img);
    }
  }
  return out;
}
