import { dialog, nativeImage, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AttachmentView } from '@shared/types';
import { promptAudioMime, promptBlockKind, type PromptCaps } from './acpContent';
import { sharedRoot } from './store';

/**
 * Files attached to a message. Any format is accepted; how it reaches the agent depends on the type:
 * images go as image blocks, text-like files as embedded text, everything else as a file link the agent
 * opens with its own tools. Pasted images (no file on disk) are saved under <sharedRoot>/attachments.
 */

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.rtf': 'application/rtf', '.odt': 'application/vnd.oasis.opendocument.text',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pages': 'application/vnd.apple.pages', '.numbers': 'application/vnd.apple.numbers', '.key': 'application/vnd.apple.keynote',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.xml': 'application/xml',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/x-typescript', '.tsx': 'text/x-typescript', '.jsx': 'text/javascript',
  '.py': 'text/x-python', '.sol': 'text/x-solidity', '.rs': 'text/x-rust', '.go': 'text/x-go', '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++', '.h': 'text/x-c',
  '.sh': 'text/x-shellscript', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.toml': 'text/x-toml', '.sql': 'text/x-sql', '.pine': 'text/plain', '.log': 'text/plain', '.env': 'text/plain',
};

export const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

async function qlThumbnail(path: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'olympus-ql-'));
  try {
    await new Promise<void>((resolve) => {
      execFile('/usr/bin/qlmanage', ['-t', '-s', '360', '-o', dir, path], { timeout: 3500 }, () => resolve());
    });
    const out = readdirSync(dir).find((f) => f.endsWith('.png'));
    if (!out) return undefined;
    const img = nativeImage.createFromPath(join(dir, out));
    if (img.isEmpty()) return undefined;
    return `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function preview(path: string, mime: string): Promise<string | undefined> {
  if (mime.startsWith('image/')) {
    try {
      const img = nativeImage.createFromPath(path);
      if (!img.isEmpty()) return img.resize({ width: 360 }).toDataURL();
    } catch {
      /* fall through to OS thumbnailer (e.g. .heic / .svg) */
    }
  }
  const richMedia =
    mime.startsWith('video/') ||
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    /\b(msword|officedocument|ms-excel|ms-powerpoint|rtf|opendocument|apple\.(?:pages|numbers|keynote))\b/.test(mime);
  if (!richMedia) return undefined;
  if (typeof nativeImage.createThumbnailFromPath === 'function') {
    try {
      const thumb = await Promise.race([
        nativeImage.createThumbnailFromPath(path, { width: 360, height: 240 }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (thumb && !thumb.isEmpty()) {
        return `data:image/jpeg;base64,${thumb.toJPEG(82).toString('base64')}`;
      }
    } catch {
      /* fall through to qlmanage on macOS */
    }
  }
  return qlThumbnail(path);
}

export async function describe(paths: string[]): Promise<AttachmentView[]> {
  const items = await Promise.all(
    paths.map(async (path): Promise<AttachmentView | null> => {
      try {
        const size = statSync(path).size;
        const mime = mimeOf(path);
        return { name: basename(path), path, mime, size, preview: await preview(path, mime) };
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is AttachmentView => x !== null);
}

export async function pick(win: BrowserWindow | null): Promise<AttachmentView[]> {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], title: 'Attach files' });
  return r.canceled ? [] : describe(r.filePaths);
}

/** A pasted, dropped, or mobile-uploaded file that has no local Mac path yet (saved under <sharedRoot>/attachments). */
export async function saveData(name: string, mime: string, base64: string): Promise<AttachmentView> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(sharedRoot(), 'attachments', day);
  mkdirSync(dir, { recursive: true });
  const safe = (name || 'pasted').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'pasted';
  const path = join(dir, `${randomUUID().slice(0, 8)}-${safe}`);
  writeFileSync(path, Buffer.from(base64, 'base64'));
  const described = (await describe([path]))[0];
  return { ...described, name: safe };
}

/**
 * ACP prompt blocks for the attachments, using what this agent says it supports (`promptCapabilities`): images
 * and audio as media blocks, text as an embedded resource (or inline text), small PDFs as an embedded binary
 * resource, and everything else as a file link the agent opens with its own tools. See `promptBlockKind`.
 */
export function toBlocks(list: AttachmentView[], caps: PromptCaps): any[] {
  const blocks: any[] = [];
  for (const a of list) {
    const uri = pathToFileURL(a.path).href;
    const kind = promptBlockKind(a, caps);
    try {
      if (kind === 'image') {
        blocks.push({ type: 'image', mimeType: a.mime, data: readFileSync(a.path).toString('base64'), uri });
        continue;
      }
      if (kind === 'audio') {
        blocks.push({ type: 'audio', mimeType: promptAudioMime(a.mime), data: readFileSync(a.path).toString('base64') });
        continue;
      }
      if (kind === 'resource-text' || kind === 'inline-text') {
        const text = readFileSync(a.path, 'utf8');
        if (kind === 'resource-text') blocks.push({ type: 'resource', resource: { uri, mimeType: a.mime, text } });
        else blocks.push({ type: 'text', text: `File ${a.name} (${a.path}):\n\`\`\`\n${text}\n\`\`\`` });
        continue;
      }
      if (kind === 'resource-blob') {
        blocks.push({ type: 'resource', resource: { uri, mimeType: a.mime, blob: readFileSync(a.path).toString('base64') } });
        continue;
      }
    } catch {
      /* unreadable: fall through to a link */
    }
    blocks.push({ type: 'resource_link', uri, name: a.name, mimeType: a.mime, size: a.size });
  }
  return blocks;
}
