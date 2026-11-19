import { app, dialog, nativeImage, shell, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FilePreview } from '@shared/types';
import { mimeOf } from './attachments';
import { parseWorktreeProjectId } from '@shared/worktree';
import { generalProject, getProject, listProjects } from './store';

/**
 * File preview and download backend for links, tool step files, and composer/chat attachments.
 * Supports text/code, Markdown, images (including .heic/.tiff conversion), videos, audio, PDFs,
 * and rich Office/iWork documents (.docx, .doc, .rtf, .odt, .xlsx, .pptx, .pages, .numbers, .key).
 */

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 35 * 1024 * 1024;
const MAX_PDF = 40 * 1024 * 1024;
const MAX_AUDIO = 40 * 1024 * 1024;
const MAX_VIDEO = 64 * 1024 * 1024;
const MAX_DOC = 40 * 1024 * 1024;
const MAX_DOWNLOAD_RAW = 100 * 1024 * 1024;

const IMAGE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};
const CONVERT_IMAGE = new Set(['.heic', '.heif', '.tif', '.tiff']);
const VIDEO: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
};
const AUDIO: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
};
const TEXTUTIL_DOCS = new Set(['.docx', '.doc', '.rtf', '.odt', '.wordml']);
const VISUAL_DOCS = new Set(['.xlsx', '.xls', '.pptx', '.ppt', '.pages', '.numbers', '.key']);
const MARKDOWN = new Set(['.md', '.markdown', '.mdx', '.mdown']);

/** Turns what an agent wrote into an absolute path and an optional line: file URLs, ~, relative, `:12`, `#L12`. */
export function resolveRef(ref: string, projectId?: string): { path: string; line?: number } {
  let s = ref.trim().replace(/^<|>$/g, '');
  let line: number | undefined;
  if (/^file:/i.test(s)) {
    const hash = /#L?(\d+)/i.exec(s);
    if (hash) line = Number(hash[1]);
    s = fileURLToPath(s.replace(/#.*$/, ''));
  } else {
    const hash = /#L(\d+)(?:-L?\d+)?$/i.exec(s);
    if (hash) {
      line = Number(hash[1]);
      s = s.slice(0, hash.index);
    }
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep as written */
    }
  }
  const absolute = (p: string) => {
    if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
    if (isAbsolute(p)) return p;
    const base = (projectId && getProject(projectId)?.path) || (projectId === 'general' ? generalProject().path : undefined);
    return resolve(base ?? homedir(), p);
  };
  const lc = /:(\d+)(?::\d+)?$/.exec(s);
  if (lc && !line && !existsSync(absolute(s))) return { path: absolute(s.slice(0, lc.index)), line: Number(lc[1]) };
  return { path: absolute(s), line };
}

/** The project a path belongs to (the given one first), for "Edit in Files". */
function owningProject(abs: string, preferId?: string): { projectId: string; rel: string } | undefined {
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    /* missing file: compare the path as given */
  }
  // A worktree chat's virtual project (folder = its worktree) is never in listProjects: check it first.
  const virtual = preferId && parseWorktreeProjectId(preferId) ? getProject(preferId) : undefined;
  const projects = [...(virtual ? [virtual] : []), ...listProjects()].sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : b.path.length - a.path.length));
  for (const p of projects) {
    let root = p.path;
    try {
      root = realpathSync(p.path);
    } catch {
      continue;
    }
    if (real === root || real.startsWith(root + sep)) return { projectId: p.id, rel: relative(root, real).split(sep).join('/') };
  }
  return undefined;
}

/** Renders a QuickLook visual preview on macOS (`size` px max edge) as a JPEG data URL. */
async function quickLookImage(path: string, size = 1200): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'olympus-qlp-'));
  try {
    await new Promise<void>((done) => {
      execFile('/usr/bin/qlmanage', ['-t', '-s', String(size), '-o', dir, path], { timeout: 5000 }, () => done());
    });
    const png = readdirSync(dir).find((f) => f.endsWith('.png'));
    if (!png) return undefined;
    const img = nativeImage.createFromPath(join(dir, png));
    if (img.isEmpty()) return undefined;
    return `data:image/jpeg;base64,${img.toJPEG(86).toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Converts Word/RTF/ODT documents to clean, script-free HTML body markup via macOS `textutil`. */
async function convertDocToHtml(path: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const raw = await new Promise<string>((done, reject) => {
      execFile(
        '/usr/bin/textutil',
        ['-convert', 'html', '-stdout', path],
        { maxBuffer: 12 * 1024 * 1024, timeout: 6000 },
        (err, stdout) => (err ? reject(err) : done(String(stdout ?? ''))),
      );
    });
    if (!raw.trim()) return undefined;
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
    const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(raw);
    const cleanBody = (bodyMatch ? bodyMatch[1] : raw)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<(?:iframe|object|embed|meta|link|base)\b[^>]*>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript:/gi, '');
    const cleanStyle = (styleMatch ? styleMatch[1] : '').replace(/@import[^;]+;/gi, '');
    return cleanStyle ? `<style>${cleanStyle}</style>\n${cleanBody}` : cleanBody;
  } catch {
    return undefined;
  }
}

export async function openPreview(ref: string, projectId?: string): Promise<FilePreview> {
  const { path, line } = resolveRef(ref, projectId);
  const base: FilePreview = { ref, path, name: basename(path) || path, line, kind: 'missing', ...owningProject(path, projectId) };
  if (!existsSync(path)) return base;
  const st = statSync(path);
  const out: FilePreview = { ...base, size: st.size, mtime: st.mtimeMs };
  if (st.isDirectory()) {
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((d) => d.name !== '.DS_Store')
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1))
      .slice(0, 500);
    return { ...out, kind: 'dir', entries };
  }
  const ext = extname(path).toLowerCase();
  if (IMAGE[ext]) {
    if (st.size > MAX_IMAGE) return { ...out, kind: 'too-large', mime: IMAGE[ext] };
    return { ...out, kind: 'image', mime: IMAGE[ext], dataUrl: `data:${IMAGE[ext]};base64,${readFileSync(path).toString('base64')}` };
  }
  if (CONVERT_IMAGE.has(ext)) {
    if (st.size > MAX_IMAGE) return { ...out, kind: 'too-large', mime: mimeOf(path) };
    try {
      const ni = nativeImage.createFromPath(path);
      if (!ni.isEmpty()) {
        return { ...out, kind: 'image', mime: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${ni.toJPEG(88).toString('base64')}` };
      }
    } catch {
      /* fall through to QuickLook */
    }
    const ql = await quickLookImage(path, 1600);
    if (ql) return { ...out, kind: 'image', mime: 'image/jpeg', dataUrl: ql };
  }
  if (VIDEO[ext]) {
    const thumbUrl = await quickLookImage(path, 720);
    if (st.size > MAX_VIDEO) return { ...out, kind: 'too-large', mime: VIDEO[ext], thumbUrl };
    return {
      ...out,
      kind: 'video',
      mime: VIDEO[ext],
      thumbUrl,
      dataUrl: `data:${VIDEO[ext]};base64,${readFileSync(path).toString('base64')}`,
    };
  }
  if (AUDIO[ext]) {
    if (st.size > MAX_AUDIO) return { ...out, kind: 'too-large', mime: AUDIO[ext] };
    return {
      ...out,
      kind: 'audio',
      mime: AUDIO[ext],
      dataUrl: `data:${AUDIO[ext]};base64,${readFileSync(path).toString('base64')}`,
    };
  }
  if (ext === '.pdf') {
    const thumbUrl = await quickLookImage(path, 960);
    if (st.size > MAX_PDF) return { ...out, kind: 'too-large', mime: 'application/pdf', thumbUrl };
    return {
      ...out,
      kind: 'pdf',
      mime: 'application/pdf',
      thumbUrl,
      dataUrl: `data:application/pdf;base64,${readFileSync(path).toString('base64')}`,
    };
  }
  if (TEXTUTIL_DOCS.has(ext) || VISUAL_DOCS.has(ext)) {
    if (st.size > MAX_DOC) return { ...out, kind: 'too-large', mime: mimeOf(path) };
    const [html, thumbUrl] = await Promise.all([
      TEXTUTIL_DOCS.has(ext) ? convertDocToHtml(path) : Promise.resolve(undefined),
      quickLookImage(path, 1400),
    ]);
    if (html || thumbUrl) {
      return { ...out, kind: 'document', mime: mimeOf(path), html, thumbUrl };
    }
  }
  if (st.size > MAX_TEXT) return { ...out, kind: 'too-large', mime: mimeOf(path) };
  const buf = readFileSync(path);
  if (buf.subarray(0, 8192).includes(0)) return { ...out, kind: 'binary', mime: mimeOf(path) };
  return { ...out, kind: MARKDOWN.has(ext) ? 'markdown' : 'text', mime: mimeOf(path), text: buf.toString('utf8') };
}

/** Saves any previewable/attached file to disk via a native Save dialog defaulted to ~/Downloads. */
export async function savePreviewAs(
  win: BrowserWindow | null,
  ref: string,
  projectId?: string,
): Promise<{ saved: boolean; path?: string }> {
  const { path } = resolveRef(ref, projectId);
  if (!existsSync(path) || statSync(path).isDirectory()) throw new Error(`File not found: ${path}`);
  const defaultPath = join(app.getPath('downloads'), basename(path));
  const res = win
    ? await dialog.showSaveDialog(win, { title: 'Save file', defaultPath })
    : await dialog.showSaveDialog({ title: 'Save file', defaultPath });
  if (res.canceled || !res.filePath) return { saved: false };
  copyFileSync(path, res.filePath);
  return { saved: true, path: res.filePath };
}

/** Reads raw bytes + MIME so remote/mobile browsers can download any file via a Blob link. */
export function readPreviewRaw(
  ref: string,
  projectId?: string,
): { name: string; mime: string; size: number; base64: string } {
  const { path } = resolveRef(ref, projectId);
  if (!existsSync(path) || statSync(path).isDirectory()) throw new Error(`File not found: ${path}`);
  const st = statSync(path);
  if (st.size > MAX_DOWNLOAD_RAW) {
    throw new Error(`File is larger than ${Math.round(MAX_DOWNLOAD_RAW / 1024 / 1024)} MB and cannot be downloaded inline.`);
  }
  return {
    name: basename(path),
    mime: mimeOf(path),
    size: st.size,
    base64: readFileSync(path).toString('base64'),
  };
}

export function openInDefaultApp(path: string) {
  if (existsSync(path)) void shell.openPath(path);
}

export function revealInFinder(path: string) {
  if (existsSync(path)) shell.showItemInFolder(path);
}
