import { clipboard, ClipboardItem } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * System clipboard writes for the desktop renderer (`clipboard.write` IPC): text, HTML and, for a copied chat
 * message, its `application/x-olympus-message` JSON (also embedded in the HTML, which is what paste events read).
 * On macOS the message's attachments also go on as file URLs, so pasting into Finder or Mail gets the files.
 * Electron 45's `clipboard.write` merges several items into one pasteboard item (only the last file URL
 * survives, measured 2026-11-16), so that case is a single NSPasteboard write through JXA.
 */

export const MESSAGE_FORMAT = 'application/x-olympus-message';
/**
 * Pasteboard types must be UTIs. This is the one Electron 45 itself writes/reads for `MESSAGE_FORMAT` (measured
 * 2026-11-16; CoreServices derives a different `dyn.` id), so `clipboard.read()` sees the JXA-written message too.
 */
const MAC_MESSAGE_UTI = 'dyn.ah62d4rv4gu80c6durvy0g2pyrf106p52fz1028prsb41gpprqz31g2phqy';

export interface ClipboardPayload {
  text: string;
  html?: string;
  /** JSON of a copied message; written as `MESSAGE_FORMAT` where the OS allows custom types. */
  message?: string;
  /** Files to offer as file URLs on macOS (only existing absolute paths are used). */
  files?: string[];
}

const MAC_WRITE = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run() {
  const raw = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
  const p = JSON.parse(raw);
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const items = $.NSMutableArray.array;
  const first = $.NSPasteboardItem.alloc.init;
  first.setStringForType(p.text, 'public.utf8-plain-text');
  if (p.html) first.setStringForType(p.html, 'public.html');
  if (p.message) first.setStringForType(p.message, p.format);
  items.addObject(first);
  for (const url of p.urls) {
    const it = $.NSPasteboardItem.alloc.init;
    it.setStringForType(url, 'public.file-url');
    items.addObject(it);
  }
  const ok = pb.writeObjects(items);
  // Let the pasteboard server take every item before osascript exits (without this ~30% of runs lost items).
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.3));
  return ok ? 'ok' : 'fail';
}`;

function macWrite(p: ClipboardPayload, urls: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_WRITE], { timeout: 5000 }, (err, stdout) =>
      resolve(!err && String(stdout).trim() === 'ok'),
    );
    child.stdin?.end(JSON.stringify({ text: p.text, html: p.html ?? '', message: p.message ?? '', format: MAC_MESSAGE_UTI, urls }));
  });
}

export async function writeClipboard(p: ClipboardPayload): Promise<boolean> {
  const text = String(p?.text ?? '');
  const urls = (p.files ?? []).filter((f) => typeof f === 'string' && f.startsWith('/') && existsSync(f)).map((f) => pathToFileURL(f).href);
  if (process.platform === 'darwin' && urls.length) {
    if (await macWrite({ ...p, text }, urls)) return true;
  }
  const item: Record<string, string> = { 'text/plain': text };
  if (p.html) item['text/html'] = p.html;
  if (p.message) item[MESSAGE_FORMAT] = p.message;
  await clipboard.write([new ClipboardItem(item)]);
  return (await clipboard.readText()) === text;
}

/**
 * The copied message JSON on the system clipboard, or ''. Needed on macOS: when file URLs are on the pasteboard,
 * Chromium's paste event only exposes `Files` (no text or HTML), so the renderer asks here instead.
 */
export async function readClipboardMessage(): Promise<string> {
  const key = process.platform === 'darwin' ? `electron application/osclipboard;format="${MAC_MESSAGE_UTI}"` : MESSAGE_FORMAT;
  try {
    const [item] = await clipboard.read();
    if (!item?.types.includes(key)) return '';
    return await ((await item.getType(key)) as Blob).text();
  } catch {
    return '';
  }
}
