import type { AttachmentView } from '@shared/types';
import { isRemoteBrowser } from './responsive';

/**
 * One clipboard path for the whole app (desktop Electron and the phone/web page). `navigator.clipboard` is missing
 * on plain-http pages (the Same-Wi-Fi LAN link) and can reject without focus, so never call it directly.
 *
 * A copied user message (`copyMessage`) carries its attachments: the JSON `{ v: 1, text, attachments }` goes on
 * the clipboard as `application/x-olympus-message` where the platform allows custom types, and always inside the
 * HTML as a `data-olympus-message` attribute (Safari and other apps keep HTML but drop custom types). Pasting
 * into any composer (`readCopiedMessage` in `useAttachments().onPaste`) restores the text and the same files.
 */

export const MESSAGE_FORMAT = 'application/x-olympus-message';

export interface CopiedMessage {
  v: 1;
  text: string;
  attachments: Pick<AttachmentView, 'name' | 'path' | 'mime' | 'size'>[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const onDesktop = () => !isRemoteBrowser() && typeof window.desk?.invoke === 'function';

async function viaMain(p: { text: string; html?: string; message?: string; files?: string[] }): Promise<boolean> {
  try {
    return Boolean(await window.desk.invoke('clipboard.write', p));
  } catch {
    return false;
  }
}

/**
 * Copies through a `copy` event: works without the async Clipboard API and keeps custom types. A hidden element
 * holding the content is selected first, so the browser copies it even if the event handler is ignored.
 */
function viaCopyEvent(formats: Record<string, string>): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const box = document.createElement('div');
  box.setAttribute('contenteditable', 'true');
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0', whiteSpace: 'pre-wrap', userSelect: 'text', webkitUserSelect: 'text' });
  if (formats['text/html']) box.innerHTML = formats['text/html'];
  else box.textContent = formats['text/plain'] ?? '';
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    for (const [type, value] of Object.entries(formats)) {
      try {
        e.clipboardData.setData(type, value);
      } catch {
        /* this browser refuses custom types: the HTML still carries the message */
      }
    }
  };
  const active = document.activeElement as HTMLElement | null;
  const sel = window.getSelection();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
  const fieldSel = field ? [field.selectionStart, field.selectionEnd] : null;
  document.body.appendChild(box);
  document.addEventListener('copy', onCopy, true);
  let ok = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(box);
    sel?.removeAllRanges();
    sel?.addRange(range);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    box.remove();
    sel?.removeAllRanges();
    for (const r of ranges) sel?.addRange(r);
    if (active && document.activeElement !== active) active.focus({ preventScroll: true });
    if (field && fieldSel && fieldSel[0] !== null && fieldSel[1] !== null) field.setSelectionRange(fieldSel[0], fieldSel[1]);
  }
  return ok;
}

async function viaAsyncApi(formats: Record<string, string>): Promise<boolean> {
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb) return false;
  const html = formats['text/html'];
  if (html && typeof ClipboardItem !== 'undefined' && typeof cb.write === 'function') {
    try {
      await cb.write([
        new ClipboardItem({
          'text/plain': new Blob([formats['text/plain'] ?? ''], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return true;
    } catch {
      /* fall back to plain text */
    }
  }
  try {
    await cb.writeText(formats['text/plain'] ?? '');
    return true;
  } catch {
    return false;
  }
}

async function copyFormats(formats: Record<string, string>, desktop: () => Promise<boolean>): Promise<boolean> {
  if (onDesktop() && (await desktop())) return true;
  // Synchronous first: it keeps the click's user activation (Safari) and works on plain-http pages.
  if (viaCopyEvent(formats)) return true;
  return viaAsyncApi(formats);
}

/** Copies plain text. Resolves `true` only when the clipboard write succeeded. */
export function copyText(text: string): Promise<boolean> {
  return copyFormats({ 'text/plain': text }, () => viaMain({ text }));
}

/** Copies a user message with its attachments (see the module comment). Without attachments it is `copyText`. */
export function copyMessage({ text, attachments }: { text: string; attachments?: AttachmentView[] }): Promise<boolean> {
  if (!attachments?.length) return copyText(text);
  const msg: CopiedMessage = { v: 1, text, attachments: attachments.map(({ name, path, mime, size }) => ({ name, path, mime, size })) };
  const json = JSON.stringify(msg);
  const html = `<div data-olympus-message="${esc(json)}">${esc(text).replace(/\n/g, '<br>')}</div>`;
  return copyFormats({ 'text/plain': text, 'text/html': html, [MESSAGE_FORMAT]: json }, () =>
    viaMain({ text, html, message: json, files: msg.attachments.map((a) => a.path) }),
  );
}

function parseMessage(json: string): CopiedMessage | null {
  try {
    const m = JSON.parse(json) as Partial<CopiedMessage>;
    if (!m || m.v !== 1 || typeof m.text !== 'string' || !Array.isArray(m.attachments)) return null;
    const attachments = m.attachments.filter(
      (a) => a && typeof a.path === 'string' && a.path.length > 0 && typeof a.name === 'string' && typeof a.mime === 'string' && typeof a.size === 'number',
    );
    return { v: 1, text: m.text, attachments };
  } catch {
    return null;
  }
}

/** The copied Olympus message on a paste/drop `DataTransfer`, or `null` for anything else. Synchronous. */
export function readCopiedMessage(dt: DataTransfer | null): CopiedMessage | null {
  if (!dt) return null;
  const custom = dt.getData(MESSAGE_FORMAT);
  if (custom) {
    const m = parseMessage(custom);
    if (m) return m;
  }
  const html = dt.getData('text/html');
  if (!html || !html.includes('data-olympus-message')) return null;
  const attr = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-olympus-message]')?.getAttribute('data-olympus-message');
  return attr ? parseMessage(attr) : null;
}

/** Desktop only: the copied message on the system clipboard (see `readClipboardMessage` in main), or `null`. */
export async function readSystemMessage(): Promise<CopiedMessage | null> {
  if (!onDesktop()) return null;
  try {
    const json = (await window.desk.invoke('clipboard.readMessage')) as string;
    return json ? parseMessage(json) : null;
  } catch {
    return null;
  }
}
