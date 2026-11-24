/**
 * Pure detection and HAST extraction of local media links inside Markdown blocks (`<p>`, `<li>`).
 * Agents routinely share generated/captured images, videos, and audio using standard Markdown links
 * (`[shot.png](file:///abs/path/shot.png)` or `[shot.png](/abs/path/shot.png)`) rather than `![...](...)`.
 * Keeping this module dependency-free lets unit tests verify every edge case directly.
 */

export type InlineMediaKind = 'image' | 'video' | 'audio';

export interface BlockMediaLink {
  href: string;
  label: string;
  kind: InlineMediaKind;
}

export interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface ExtractedBlockMedia {
  links: BlockMediaLink[];
  /** True only when a `<p>` consists solely of local media link(s) plus optional `<br>` / whitespace. */
  standalone: boolean;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv|mkv)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;

const LINE_ANCHOR_RE = /(?::\d+(?::\d+)?|#L?\d+(?:-L?\d+)?)$/i;
const EXTERNAL_OR_NON_FILE_SCHEME_RE = /^(?:https?:|mailto:|tel:|data:|blob:|javascript:|vbscript:|about:|chrome:|#)/i;
const GENERIC_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

export const MAX_BLOCK_MEDIA_LINKS = 6;

/** Strips `file://` (including `file://localhost`) and query/hash fragments for extension checks. */
function cleanMediaPath(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (EXTERNAL_OR_NON_FILE_SCHEME_RE.test(trimmed)) return null;

  let path = trimmed;
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\/(?:localhost)?/i, '');
  } else if (GENERIC_SCHEME_RE.test(path) && !WINDOWS_DRIVE_RE.test(path)) {
    // Reject unknown URI schemes like `ftp:`, `vscode:`, `olympus:`, `node:assert`, etc.
    return null;
  }

  if (LINE_ANCHOR_RE.test(path)) return null;
  return path.replace(/[?#].*$/, '');
}

/** Returns `'image' | 'video' | 'audio'` when `href` targets a local media file without a line anchor, else `null`. */
export function mediaKindFromHref(href?: string): InlineMediaKind | null {
  if (!href) return null;
  const clean = cleanMediaPath(href);
  if (!clean) return null;
  if (IMAGE_EXT.test(clean)) return 'image';
  if (VIDEO_EXT.test(clean)) return 'video';
  if (AUDIO_EXT.test(clean)) return 'audio';
  return null;
}

/** True when `href` is a local image, video, or audio file link suited to inline preview. */
export function isLocalMediaHref(href?: string): boolean {
  return mediaKindFromHref(href) !== null;
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (!node.children) return '';
  return node.children.map(textOf).join('');
}

function containsImg(node: HastNode): boolean {
  if (node.type === 'element' && node.tagName === 'img') return true;
  if (!node.children) return false;
  return node.children.some(containsImg);
}

function hrefOf(node: HastNode): string | undefined {
  const raw = node.properties?.href;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Picks a clean human label for a media preview caption: prefers meaningful link text,
 * falling back to the resolved filename when the link text is empty or a raw path/URL.
 */
export function displayMediaLabel(label: string, href: string, resolvedName?: string): string {
  const t = label.trim();
  const fallback =
    resolvedName ||
    href
      .replace(/[?#].*$/, '')
      .split(/[\\/]/)
      .pop() ||
    href;
  if (!t) return fallback;
  if (t === href.trim() || /^(?:file:\/\/|\/|~\/|[a-z]:[\\/])/i.test(t)) return fallback;
  return t;
}

/**
 * Collects local media `<a>` links from a `<p>` or `<li>` HAST node.
 * - Stops before nested block elements (so loose `<li><p>...</p></li>` lists never duplicate previews).
 * - Skips any `<a>` that already wraps an `<img>` (so `[![alt](a.png)](a.png)` never duplicates).
 * - Deduplicates by trimmed `href` and caps at `MAX_BLOCK_MEDIA_LINKS`.
 * - Sets `standalone = true` only when a `<p>` contains nothing but local media links (plus optional `<br>` / whitespace).
 */
export function extractBlockMediaLinks(node: HastNode | undefined): ExtractedBlockMedia {
  if (!node || node.type !== 'element' || !node.children?.length) {
    return { links: [], standalone: false };
  }

  const links: BlockMediaLink[] = [];
  const seen = new Set<string>();
  let hasNonMediaContent = false;

  const walk = (children: HastNode[]) => {
    for (const child of children) {
      if (child.type === 'text') {
        if ((child.value ?? '').trim().length > 0) hasNonMediaContent = true;
        continue;
      }
      if (child.type !== 'element') continue;
      const tag = (child.tagName ?? '').toLowerCase();
      if (tag === 'br') continue;
      if (BLOCK_TAGS.has(tag)) {
        // Nested blocks (`<p>`, `<ul>`, etc.) handle their own media links; don't double-collect or mark standalone.
        hasNonMediaContent = true;
        continue;
      }
      if (tag === 'a') {
        const href = hrefOf(child);
        const kind = mediaKindFromHref(href);
        if (href && kind && !containsImg(child)) {
          const key = href.trim();
          if (!seen.has(key) && links.length < MAX_BLOCK_MEDIA_LINKS) {
            seen.add(key);
            links.push({ href: key, label: textOf(child).trim(), kind });
          }
          continue;
        }
        hasNonMediaContent = true;
        continue;
      }
      if (tag === 'img' || tag === 'code') {
        hasNonMediaContent = true;
        continue;
      }
      // Inline wrappers like <strong>, <em>, <del>, <span>
      if (child.children?.length) {
        walk(child.children);
      }
    }
  };

  walk(node.children);

  const isParagraph = (node.tagName ?? '').toLowerCase() === 'p';
  const standalone = isParagraph && links.length > 0 && !hasNonMediaContent;
  return { links, standalone };
}
