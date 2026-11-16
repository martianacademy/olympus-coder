/**
 * ACP content as Olympus stores and shows it: every ACP `ContentBlock` (text, image, audio, embedded resource,
 * resource link) with its annotations, tool call locations with their line, and a safe subset of a tool call's
 * identity (`name` + allowlisted `_meta`). Media never lives in the chat's JSON: the main process
 * (`src/main/acpContent.ts`) writes it to the chat's media folder and keeps only the file path here.
 * Shared by the main process and the renderer (desktop and phone).
 */

/** Who the agent meant a piece of content for (ACP `annotations.audience`). */
export type ContentRole = 'user' | 'assistant';

/** ACP `Annotations`, validated. */
export interface ContentAnnotations {
  audience?: ContentRole[];
  /** 0 (least important) to 1 (most important). */
  priority?: number;
  /** ISO 8601 time the underlying resource last changed. */
  lastModified?: string;
}

/** Why a media payload was not saved: too big for one block, over the chat's media budget, bad data, disk error. */
export type OmittedReason = 'too-large' | 'quota' | 'invalid' | 'write-failed';

interface ContentBase {
  annotations?: ContentAnnotations;
}

export interface RichText extends ContentBase {
  type: 'text';
  text: string;
}

export interface RichImage extends ContentBase {
  type: 'image';
  mimeType: string;
  /** The saved image (in the chat's media folder). */
  path?: string;
  /** Where the image came from, if the agent said (a web image the app does not load by itself). */
  uri?: string;
  /** Decoded size in bytes. */
  size?: number;
  omitted?: OmittedReason;
}

export interface RichAudio extends ContentBase {
  type: 'audio';
  mimeType: string;
  path?: string;
  size?: number;
  omitted?: OmittedReason;
}

/** An embedded resource (ACP `resource`): its text inline (capped), or its binary contents saved to a file. */
export interface RichResource extends ContentBase {
  type: 'resource';
  uri: string;
  mimeType?: string;
  /** `text` resources: the text (at most `MAX_INLINE_RESOURCE_TEXT` characters, the rest is in `path`). */
  text?: string;
  /** Characters of the text that are not inline (the whole text is then saved at `path`). */
  textOmitted?: number;
  /** `blob` resources (and long text): the saved contents. */
  path?: string;
  size?: number;
  /** `blob` when the agent sent binary contents. */
  encoding: 'text' | 'blob';
  omitted?: OmittedReason;
}

/** A link to a resource the agent can read (ACP `resource_link`). */
export interface RichResourceLink extends ContentBase {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export type RichContent = RichText | RichImage | RichAudio | RichResource | RichResourceLink;

/** A file a tool call reads or changes (ACP `ToolCallLocation`), with its 1-based line when the agent gave one. */
export interface ToolLocation {
  path: string;
  line?: number;
}

/**
 * What a tool call really is, from its ACP `name` and an allowlisted subset of its `_meta` (never shown raw).
 * Claude: `_meta.claudeCode.{toolName,parentToolUseId}` and, with AIR caps, `_meta.jetbrains.air.{mcp,skill,
 * subagent,commandTitle}`; Codex: `name` and `_meta.is_mcp_tool_call`.
 */
export interface ToolIdentity {
  /** ACP tool `name` (programmatic), e.g. `Read`, `mcp__github__create_issue`, `exec_command`. */
  name?: string;
  /** Claude Code's tool name (`_meta.claudeCode.toolName`). */
  toolName?: string;
  /** The Agent/Task tool call of the Claude sub-agent that made this call. */
  parentToolUseId?: string;
  isMcp?: boolean;
  mcpServer?: string;
  mcpTool?: string;
  /** The skill a Claude `Skill` call loads. */
  skill?: string;
  /** The call starts a sub-agent. */
  subagent?: boolean;
  /** Claude's short description of a shell command. */
  commandTitle?: string;
}

/** A tool's ACP `content` entry for one content block, kept next to its plain-text form for older readers. */
export interface RichToolContent {
  type: 'text';
  /** Plain-text form (what older code reads, copy, search). */
  text: string;
  /** The block itself when it is not plain text for the user (media, resources, links, annotated text). */
  rich?: RichContent;
}

/* ---------- limits (shared so the UI can explain them) ---------- */

/** Largest image / audio / binary resource saved from one content block. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;
/** Everything one chat may save to its media folder. */
export const MAX_CHAT_MEDIA_BYTES = 512 * 1024 * 1024;
/** Embedded text kept inside the chat; longer text is saved to a file and only this much stays inline. */
export const MAX_INLINE_RESOURCE_TEXT = 24_000;

/* ---------- helpers ---------- */

/** True unless the agent marked the content as meant only for the assistant (the model), not for the user. */
export function isForUser(a?: ContentAnnotations): boolean {
  return !a?.audience?.length || a.audience.includes('user');
}

export function fmtBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The local path of a `file:` URI (undefined for other schemes). */
export function fileUriPath(uri: string): string | undefined {
  if (!/^file:/i.test(uri)) return undefined;
  try {
    const p = decodeURIComponent(new URL(uri).pathname);
    return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
  } catch {
    return undefined;
  }
}

export const isWebUri = (uri: string) => /^https?:\/\//i.test(uri);

/** Last segment of a path or URI, for a short label. */
export function baseNameOf(ref: string): string {
  const clean = ref.replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).pop() || ref;
}

/** A reference the file preview understands: `path#L12` when the location has a line. */
export function locationRef(loc: ToolLocation): string {
  return loc.line && loc.line > 0 ? `${loc.path}#L${loc.line}` : loc.path;
}

/** Locations in the old (bare path) or new form as `ToolLocation`s. */
export function normalizeLocations(list: ReadonlyArray<string | ToolLocation> | undefined): ToolLocation[] {
  const out: ToolLocation[] = [];
  for (const l of list ?? []) {
    if (typeof l === 'string') {
      if (l.trim()) out.push({ path: l.trim() });
    } else if (l && typeof l.path === 'string' && l.path.trim()) {
      out.push(l.line && l.line > 0 ? { path: l.path.trim(), line: l.line } : { path: l.path.trim() });
    }
  }
  return out;
}

/** `mcp__<server>__<tool>` split the way Claude Code does (server up to the next `__`, the tool is the rest). */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice(5);
  const sep = rest.indexOf('__');
  if (sep <= 0 || !rest.slice(sep + 2)) return undefined;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * A short line naming the real tool behind a step, for the step header: `MCP · github › create_issue`,
 * `Skill · pdf`, or the tool name when the title does not already say it. Undefined when it adds nothing.
 */
export function toolIdentityLabel(id: ToolIdentity | undefined, title?: string): string | undefined {
  if (!id) return undefined;
  const t = (title ?? '').toLowerCase();
  if (id.mcpServer && id.mcpTool) return `MCP · ${id.mcpServer} › ${id.mcpTool}`;
  if (id.skill) return `Skill · ${id.skill}`;
  const name = id.toolName ?? id.name;
  if (!name) return id.isMcp ? 'MCP tool' : undefined;
  if (t.includes(name.toLowerCase())) return undefined;
  return id.isMcp ? `MCP · ${name}` : name;
}

/** The plain-text form of a content block: what copy, search and the shared history for other agents read. */
export function richPlainText(c: RichContent): string {
  switch (c.type) {
    case 'text':
      return c.text;
    case 'image':
      return c.path ? `[Image: ${c.path}]` : c.uri ? `[Image: ${c.uri}]` : '[Image]';
    case 'audio':
      return c.path ? `[Audio: ${c.path}]` : '[Audio]';
    case 'resource':
      if (c.encoding === 'text' && c.text !== undefined) {
        return `${c.uri}\n\`\`\`\n${c.text}${c.textOmitted ? `\n… (${c.textOmitted} more characters in ${c.path ?? 'the file'})` : ''}\n\`\`\``;
      }
      return c.path ? `[Resource ${c.uri}: ${c.path}]` : `[Resource ${c.uri}]`;
    case 'resource_link':
      return `[${c.title || c.name || c.uri}](${c.uri})`;
  }
}

/** True for a block that needs more than Markdown text to show (media, resources, links, annotated text). */
export function needsRichView(c: RichContent): boolean {
  return c.type !== 'text' || Boolean(c.annotations);
}

/**
 * Adds streamed content to a message. `text` always holds the whole message as plain text (older readers,
 * copy, search). `parts` appears with the first block that is not plain text and from then on holds the
 * message in order, with neighbouring plain text merged.
 */
export function appendMessageContent(
  msg: { text: string; parts?: RichContent[] },
  add: RichContent[],
): { text: string; parts?: RichContent[] } {
  let text = msg.text;
  let parts = msg.parts ? [...msg.parts] : undefined;
  for (const c of add) {
    const plain = richPlainText(c);
    if (c.type === 'text' && !c.annotations) {
      text += plain;
      if (parts) {
        const last = parts[parts.length - 1];
        if (last && last.type === 'text' && !last.annotations) parts[parts.length - 1] = { type: 'text', text: last.text + c.text };
        else parts.push(c);
      }
      continue;
    }
    if (!parts) parts = text ? [{ type: 'text', text }] : [];
    // Media and resources sit on their own line in the plain-text form.
    const sep = c.type === 'text' || !text || text.endsWith('\n') ? '' : '\n';
    text += sep + plain + (c.type === 'text' ? '' : '\n');
    parts.push(c);
  }
  return parts ? { text, parts } : { text };
}
