import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_AUDIO_BYTES,
  MAX_BLOB_BYTES,
  MAX_CHAT_MEDIA_BYTES,
  MAX_IMAGE_BYTES,
  MAX_INLINE_RESOURCE_TEXT,
  baseNameOf,
  isForUser,
  richPlainText,
  splitMcpName,
  type ContentAnnotations,
  type ContentRole,
  type OmittedReason,
  type RichContent,
  type ToolIdentity,
  type ToolLocation,
} from '@shared/acpContent';
import type { ToolContentView } from '@shared/types';

/**
 * ACP content from an agent (message chunks, tool call content, locations, tool identity) mapped to what a chat
 * stores. Everything here is untrusted input from the agent process, so every field is checked and capped.
 * Media payloads (base64 images, audio, binary resources, very long embedded text) are written to the chat's
 * media folder `<sharedRoot>/attachments/chats/<threadId>/` and only their path stays in the chat's JSON, which
 * is re-serialized on every save. Pure apart from those file writes; no Electron imports (unit tested in Node).
 */

/** Where one chat's media goes. */
export interface MediaStore {
  dir: string;
}

export function chatMediaDir(sharedRoot: string, threadId: string): string {
  return join(sharedRoot, 'attachments', 'chats', threadId.replace(/[^\w-]/g, '_').slice(0, 80) || 'chat');
}

/** Removes a deleted chat's media folder. */
export function removeChatMedia(sharedRoot: string, threadId: string): void {
  const dir = chatMediaDir(sharedRoot, threadId);
  usedBytes.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/* ---------- small validators ---------- */

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A display string from untrusted data: control and bidi-override characters removed, trimmed, capped. */
export function safeStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
  return s || undefined;
}

const MIME_RE = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/i;

/** A MIME type without parameters, lower-cased, or `fallback` when it is not one. */
export function safeMime(v: unknown, fallback = 'application/octet-stream'): string {
  if (typeof v !== 'string') return fallback;
  const base = v.split(';')[0].trim().toLowerCase();
  return base.length <= 100 && MIME_RE.test(base) ? base : fallback;
}

function safeSize(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

function annotationsOf(a: unknown): ContentAnnotations | undefined {
  if (!isObj(a)) return undefined;
  const out: ContentAnnotations = {};
  if (Array.isArray(a.audience)) {
    const roles = [...new Set(a.audience.filter((r: unknown): r is ContentRole => r === 'user' || r === 'assistant'))];
    if (roles.length) out.audience = roles;
  }
  if (typeof a.priority === 'number' && Number.isFinite(a.priority)) out.priority = Math.min(1, Math.max(0, a.priority));
  const lm = safeStr(a.lastModified, 64);
  if (lm && !Number.isNaN(Date.parse(lm))) out.lastModified = lm;
  return Object.keys(out).length ? out : undefined;
}

const withAnnotations = <T extends RichContent>(c: T, raw: unknown): T => {
  const a = annotationsOf(raw);
  return a ? { ...c, annotations: a } : c;
};

/* ---------- media files ---------- */

const EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'image/bmp': '.bmp', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/avif': '.avif', 'image/heic': '.heic',
  'image/heif': '.heif', 'image/tiff': '.tiff',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/flac': '.flac',
  'audio/x-flac': '.flac', 'audio/webm': '.webm',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'application/pdf': '.pdf', 'application/json': '.json', 'application/xml': '.xml', 'application/zip': '.zip',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/x-markdown': '.md', 'text/html': '.html', 'text/css': '.css', 'text/csv': '.csv',
  'text/xml': '.xml', 'text/javascript': '.js', 'application/javascript': '.js', 'text/x-typescript': '.ts', 'text/x-python': '.py',
  'text/yaml': '.yml', 'application/yaml': '.yml', 'text/x-shellscript': '.sh',
};

/** The file extension for a MIME type: one the file preview recognizes, `.txt` for other text, else `.bin`. */
export function extForMime(mime: string): string {
  if (EXT[mime]) return EXT[mime];
  if (mime.startsWith('text/') || mime.endsWith('+json') || mime.endsWith('+xml')) return '.txt';
  return '.bin';
}

/** Bytes already in each chat's media folder (counted once per folder, then kept up to date). */
const usedBytes = new Map<string, number>();

function folderBytes(dir: string): number {
  let n = usedBytes.get(dir);
  if (n !== undefined) return n;
  n = 0;
  try {
    for (const f of readdirSync(dir)) {
      try {
        n += statSync(join(dir, f)).size;
      } catch {
        /* vanished */
      }
    }
  } catch {
    /* no folder yet */
  }
  usedBytes.set(dir, n);
  return n;
}

export interface SavedMedia {
  path?: string;
  size?: number;
  omitted?: OmittedReason;
}

/** Saves bytes under a content hash (the same image twice is one file); respects the chat's media budget. */
export function saveMedia(store: MediaStore, bytes: Buffer, mime: string, maxBytes: number): SavedMedia {
  const size = bytes.length;
  if (!size) return { omitted: 'invalid' };
  if (size > maxBytes) return { size, omitted: 'too-large' };
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}${extForMime(mime)}`;
  const path = join(store.dir, name);
  if (existsSync(path)) return { path, size };
  const used = folderBytes(store.dir);
  if (used + size > MAX_CHAT_MEDIA_BYTES) return { size, omitted: 'quota' };
  try {
    mkdirSync(store.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
    usedBytes.set(store.dir, used + size);
    return { path, size };
  } catch {
    return { size, omitted: 'write-failed' };
  }
}

const B64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

/**
 * Decodes an agent's base64 payload (a `data:` URL prefix is tolerated) and saves it. Rejects a payload that is
 * over the limit before decoding it, so a huge chunk never doubles in memory.
 */
export function saveBase64(store: MediaStore | undefined, data: string, mime: string, maxBytes: number): SavedMedia {
  let b64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  if (/\s/.test(b64)) b64 = b64.replace(/\s+/g, '');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const estimate = Math.floor((b64.length * 3) / 4) - pad;
  if (!b64 || !B64_RE.test(b64)) return { omitted: 'invalid' };
  if (estimate > maxBytes) return { size: estimate, omitted: 'too-large' };
  if (!store) return { size: estimate, omitted: 'write-failed' };
  return saveMedia(store, Buffer.from(b64, 'base64'), mime, maxBytes);
}

const URI_MAX = 4096;

/** A URI worth keeping: not a `data:` URL (that is a payload, not an address), capped. */
function safeUri(v: unknown): string | undefined {
  const s = safeStr(v, URI_MAX);
  return s && !/^data:/i.test(s) ? s : undefined;
}

/* ---------- content blocks ---------- */

/** One ACP `ContentBlock` as stored content; undefined for something that is not a content block. */
export function toRichContent(block: unknown, store?: MediaStore): RichContent | undefined {
  if (!isObj(block)) return undefined;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? withAnnotations({ type: 'text', text: block.text }, block.annotations) : undefined;
    case 'image': {
      const mimeType = safeMime(block.mimeType, 'image/png');
      const uri = safeUri(block.uri);
      const payload =
        typeof block.data === 'string' && block.data ? block.data : typeof block.uri === 'string' && /^data:image\//i.test(block.uri) ? block.uri : '';
      const saved = payload ? saveBase64(store, payload, mimeType, MAX_IMAGE_BYTES) : {};
      if (!payload && !uri) return undefined;
      return withAnnotations({ type: 'image', mimeType, ...(uri ? { uri } : {}), ...saved }, block.annotations);
    }
    case 'audio': {
      const mimeType = safeMime(block.mimeType, 'audio/wav');
      if (typeof block.data !== 'string' || !block.data) return undefined;
      return withAnnotations({ type: 'audio', mimeType, ...saveBase64(store, block.data, mimeType, MAX_AUDIO_BYTES) }, block.annotations);
    }
    case 'resource': {
      const r = block.resource;
      if (!isObj(r)) return undefined;
      const uri = safeStr(r.uri, URI_MAX) ?? '';
      const mime = typeof r.mimeType === 'string' ? safeMime(r.mimeType) : undefined;
      if (typeof r.text === 'string') {
        const out: RichContent = { type: 'resource', encoding: 'text', uri, ...(mime ? { mimeType: mime } : {}), text: r.text };
        if (r.text.length > MAX_INLINE_RESOURCE_TEXT) {
          out.text = r.text.slice(0, MAX_INLINE_RESOURCE_TEXT);
          out.textOmitted = r.text.length - MAX_INLINE_RESOURCE_TEXT;
          const saved = store ? saveMedia(store, Buffer.from(r.text, 'utf8'), mime ?? 'text/plain', MAX_BLOB_BYTES) : { omitted: 'write-failed' as const };
          Object.assign(out, saved);
        }
        return withAnnotations(out, block.annotations);
      }
      if (typeof r.blob === 'string') {
        const saved = saveBase64(store, r.blob, mime ?? 'application/octet-stream', MAX_BLOB_BYTES);
        return withAnnotations({ type: 'resource', encoding: 'blob', uri, ...(mime ? { mimeType: mime } : {}), ...saved }, block.annotations);
      }
      return undefined;
    }
    case 'resource_link': {
      const uri = safeStr(block.uri, URI_MAX);
      if (!uri) return undefined;
      const title = safeStr(block.title, 300);
      const description = safeStr(block.description, 2000);
      const mimeType = typeof block.mimeType === 'string' ? safeMime(block.mimeType) : undefined;
      const size = safeSize(block.size);
      return withAnnotations(
        {
          type: 'resource_link',
          uri,
          name: safeStr(block.name, 300) ?? baseNameOf(uri),
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(size !== undefined ? { size } : {}),
        },
        block.annotations,
      );
    }
    default:
      return undefined;
  }
}

/** A message chunk's `content` (one block, or a list from agents that batch) as stored content. */
export function toRichContents(content: unknown, store?: MediaStore): RichContent[] {
  const list = Array.isArray(content) ? content : [content];
  const out: RichContent[] = [];
  for (const b of list) {
    const c = toRichContent(b, store);
    if (c && !(c.type === 'text' && !c.text)) out.push(c);
  }
  return out;
}

/* ---------- tool call content ---------- */

/**
 * Agents can send the whole file before and after an edit. The chat shows at most ~120 lines of it and the full
 * change of a turn lives in its git checkpoint, so each side is kept up to this many characters: a guard against
 * a single huge file (a lockfile, generated code) bloating the chat's JSON that is re-serialized on every save.
 */
export const MAX_DIFF_TEXT = 64_000;
export const capDiffText = (s: string) => (s.length > MAX_DIFF_TEXT ? `${s.slice(0, MAX_DIFF_TEXT)}\n… (truncated: ${s.length - MAX_DIFF_TEXT} more characters)` : s);

/** A tool content entry: the `ToolContentView` older code reads, plus the block itself when it is not plain text. */
export type ToolContentEntry = ToolContentView & { rich?: RichContent };

/** True for a stored block that needs more than plain text to show (media, resources, links, text not for the user). */
export const isRichEntry = (c: RichContent) => c.type !== 'text' || !isForUser(c.annotations);

/** ACP tool call `content` as stored entries (diffs capped, content blocks mapped, media saved to the chat's folder). */
export function mapToolContent(list: unknown, store?: MediaStore): ToolContentEntry[] {
  if (!Array.isArray(list)) return [];
  const out: ToolContentEntry[] = [];
  for (const c of list) {
    if (!isObj(c) || c.type === 'session') continue;
    if (c.type === 'diff') {
      out.push({ type: 'diff', path: c.path, oldText: typeof c.oldText === 'string' ? capDiffText(c.oldText) : null, newText: capDiffText(c.newText ?? '') });
    } else if (c.type === 'content') {
      const rich = toRichContent(c.content, store);
      if (!rich) out.push({ type: 'text', text: '' });
      else if (isRichEntry(rich)) out.push({ type: 'text', text: richPlainText(rich), rich });
      else out.push({ type: 'text', text: (rich as { text: string }).text });
    } else if (c.type === 'terminal') {
      out.push({ type: 'terminal', terminalId: String(c.terminalId ?? '') });
    } else {
      out.push({ type: 'other', text: JSON.stringify(c).slice(0, 2000) });
    }
  }
  return out;
}

/* ---------- locations ---------- */

const MAX_LOCATIONS = 200;

/** ACP tool call `locations` with their 1-based line (0 or a bad value means no line), duplicates removed. */
export function mapLocations(list: unknown): ToolLocation[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ToolLocation[] = [];
  for (const l of list) {
    if (!isObj(l)) continue;
    const path = safeStr(l.path, URI_MAX);
    if (!path) continue;
    const line = typeof l.line === 'number' && Number.isInteger(l.line) && l.line >= 1 ? l.line : undefined;
    const key = `${path}\0${line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line ? { path, line } : { path });
    if (out.length >= MAX_LOCATIONS) break;
  }
  return out;
}

/**
 * The stored form of locations: `locations` stays a list of paths (every older reader), and `locationRefs` keeps
 * the full list with lines only when at least one location has a line.
 */
export function splitLocations(locs: ToolLocation[]): { locations: string[]; locationRefs?: ToolLocation[] } {
  const locations = [...new Set(locs.map((l) => l.path))];
  return locs.some((l) => l.line) ? { locations, locationRefs: locs } : { locations };
}

/* ---------- tool identity ---------- */

const ID_RE = /^[\w.:@/-]{1,128}$/;

/**
 * A tool call's identity from its ACP `name` and an allowlisted part of `_meta`, merged over what an earlier
 * report said (`tool_call_update` sends only what changed). Nothing else from `_meta` is kept.
 */
export function toolIdentityOf(u: unknown, prev?: ToolIdentity): ToolIdentity | undefined {
  const out: ToolIdentity = { ...(prev ?? {}) };
  if (isObj(u)) {
    const name = safeStr(u.name, 200);
    if (name) out.name = name;
    const meta = isObj(u._meta) ? u._meta : undefined;
    const cc = isObj(meta?.claudeCode) ? meta.claudeCode : undefined;
    const toolName = safeStr(cc?.toolName, 200);
    if (toolName) out.toolName = toolName;
    const parent = safeStr(cc?.parentToolUseId, 128);
    if (parent && ID_RE.test(parent)) out.parentToolUseId = parent;
    const air = isObj(meta?.jetbrains) && isObj(meta.jetbrains.air) ? meta.jetbrains.air : undefined;
    if (isObj(air?.mcp)) {
      const server = safeStr(air.mcp.server, 120);
      const tool = safeStr(air.mcp.tool, 200);
      if (server && tool) Object.assign(out, { isMcp: true, mcpServer: server, mcpTool: tool });
    }
    const skill = safeStr(isObj(air?.skill) ? air.skill.name : undefined, 120);
    if (skill) out.skill = skill;
    if (air?.subagent === true) out.subagent = true;
    const commandTitle = safeStr(air?.commandTitle, 300);
    if (commandTitle) out.commandTitle = commandTitle;
    if (meta?.is_mcp_tool_call === true) out.isMcp = true;
  }
  const mcp = (out.toolName && splitMcpName(out.toolName)) || (out.name && splitMcpName(out.name));
  if (mcp && !out.mcpServer) Object.assign(out, { isMcp: true, mcpServer: mcp.server, mcpTool: mcp.tool });
  return Object.keys(out).length ? out : undefined;
}

/* ---------- outgoing prompt blocks ---------- */

/** What the agent says it accepts in a prompt (ACP `promptCapabilities`). */
export interface PromptCaps {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/** Largest attachment sent inline per kind; anything bigger goes as a link the agent opens with its own tools. */
export const PROMPT_LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 8 * 1024 * 1024,
  text: 400 * 1024,
  /**
   * Binary resources are kept small on purpose: Codex puts a binary resource into the model's context as base64
   * text, and Claude only decodes images, PDFs and text from one (other types are dropped).
   */
  blob: 256 * 1024,
} as const;

const PROMPT_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PROMPT_AUDIO = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/opus']);
/** Binary types an agent can read from an embedded resource. */
const PROMPT_BLOB = new Set(['application/pdf']);

export const isPromptImage = (mime: string) => PROMPT_IMAGE.has(mime);
export const isPromptAudio = (mime: string) => PROMPT_AUDIO.has(mime);
export const isTextLikeMime = (mime: string) =>
  mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/yaml'].includes(mime) || mime.endsWith('+json') || mime.endsWith('+xml');

export type PromptBlockKind = 'image' | 'audio' | 'resource-text' | 'inline-text' | 'resource-blob' | 'link';

/** How an attachment goes into a prompt, from its type, size and the agent's prompt capabilities. */
export function promptBlockKind(a: { mime: string; size: number }, caps: PromptCaps): PromptBlockKind {
  const mime = safeMime(a.mime);
  if (caps.image && isPromptImage(mime) && a.size <= PROMPT_LIMITS.image) return 'image';
  if (caps.audio && isPromptAudio(mime) && a.size <= PROMPT_LIMITS.audio) return 'audio';
  if (isTextLikeMime(mime) && a.size <= PROMPT_LIMITS.text) return caps.embeddedContext ? 'resource-text' : 'inline-text';
  if (caps.embeddedContext && PROMPT_BLOB.has(mime) && a.size <= PROMPT_LIMITS.blob) return 'resource-blob';
  return 'link';
}

/** The ACP audio MIME type for a file type (`audio/x-wav` and friends normalized). */
export function promptAudioMime(mime: string): string {
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'audio/wav';
  if (mime === 'audio/mp3') return 'audio/mpeg';
  return mime;
}
