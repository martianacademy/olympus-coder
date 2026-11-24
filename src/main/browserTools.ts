/**
 * Five lean MCP tools (`<= 650B` each, all 4 boolean annotations) exposing the user's real Chrome
 * browser via the Olympus Chrome Extension (`src/main/browserBridge.ts`) to every ACP coding agent.
 */
import { callBrowserExtension, saveBrowserScreenshot } from './browserBridge';

export const BROWSER_TOOL_NAMES = ['browser_tabs', 'browser_open', 'browser_read', 'browser_act', 'browser_close'] as const;

export function browserToolDefs(readOnlyOnly = false) {
  const tabs = {
    name: 'browser_tabs',
    title: 'List Chrome tabs',
    description: 'List open tabs in the user’s connected real Chrome browser (id, title, url, active, group).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  const read = {
    name: 'browser_read',
    title: 'Read Chrome tab',
    description:
      'Read a Chrome tab’s text and interactive refs. Optional screenshot, console logs, or failed network requests.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab id (default: active Olympus/current tab).' },
        screenshot: { type: 'boolean', description: 'Save a viewport JPEG.' },
        console: { type: 'boolean', description: 'Include recent console logs/errors.' },
        network: { type: 'boolean', description: 'Include recent failed HTTP requests.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  if (readOnlyOnly) return [tabs, read];
  return [
    tabs,
    {
      name: 'browser_open',
      title: 'Open URL in Chrome',
      description: 'Open an http(s) URL in a new tab inside the orange Olympus Chrome tab group, or navigate an existing tabId.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http:// or https:// URL.' },
          tabId: { type: 'number', description: 'Optional existing tab id to navigate.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    read,
    {
      name: 'browser_act',
      title: 'Interact with Chrome tab',
      description:
        'Act visibly in Chrome (moving cursor & smooth scroll): click, hover, type, press, select, scroll, wait, back, forward, reload.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'hover', 'type', 'press', 'select', 'scroll', 'wait', 'back', 'forward', 'reload'] },
          tabId: { type: 'number' },
          ref: { type: 'number', description: 'Element ref from browser_read.' },
          selector: { type: 'string', description: 'CSS selector fallback.' },
          text: { type: 'string', description: 'Text, key, option, or wait text.' },
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
          x: { type: 'number', description: 'Viewport X (or wait ms).' },
          y: { type: 'number', description: 'Viewport Y.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'browser_close',
      title: 'Close Chrome tab',
      description: 'Close a non-pinned Chrome tab by tabId.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

function assertHttpUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Invalid URL: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme "${u.protocol}" — only http:// and https:// URLs are allowed.`);
  }
  return u.toString();
}

/** Handles any `browser_*` MCP call; returns undefined if `name` is not a browser tool. */
export async function handleBrowserTool(
  name: string,
  args: any,
  readOnlyOnly: boolean,
): Promise<string | undefined> {
  if (!(BROWSER_TOOL_NAMES as readonly string[]).includes(name)) return undefined;
  if (readOnlyOnly && name !== 'browser_tabs' && name !== 'browser_read') {
    throw new Error('This session is read-only and may only use browser_tabs and browser_read.');
  }

  if (name === 'browser_tabs') {
    const res = await callBrowserExtension<{ tabs: { id: number; title: string; url: string; active: boolean; group?: string }[] }>('tabs');
    if (!res?.tabs?.length) return 'No open Chrome tabs.';
    return res.tabs
      .map((t) => `- [${t.id}]${t.active ? ' (active)' : ''}${t.group ? ` [${t.group}]` : ''} ${t.title || '(untitled)'} — ${t.url}`)
      .join('\n');
  }

  if (name === 'browser_open') {
    const url = assertHttpUrl(String(args?.url ?? ''));
    const tabId = typeof args?.tabId === 'number' ? args.tabId : undefined;
    const res = await callBrowserExtension<{ id: number; title: string; url: string }>('open', { url, tabId });
    return `Opened tab [${res.id}]: ${res.title || '(loading)'} — ${res.url}`;
  }

  if (name === 'browser_read') {
    const tabId = typeof args?.tabId === 'number' ? args.tabId : undefined;
    const screenshot = Boolean(args?.screenshot);
    const wantConsole = Boolean(args?.console);
    const wantNetwork = Boolean(args?.network);
    const res = await callBrowserExtension<{
      id: number;
      title: string;
      url: string;
      text: string;
      elements: { ref: number; tag: string; label: string; href?: string; type?: string }[];
      screenshotDataUrl?: string;
      console?: string[];
      network?: string[];
    }>('read', { tabId, screenshot, console: wantConsole, network: wantNetwork });
    const lines = [`Tab [${res.id}]: ${res.title}`, `URL: ${res.url}`];
    if (res.screenshotDataUrl) {
      const saved = saveBrowserScreenshot(res.screenshotDataUrl);
      lines.push(`Screenshot: ${saved}`);
    }
    if (res.console?.length) lines.push('', 'Console:', ...res.console);
    if (res.network?.length) lines.push('', 'Failed network:', ...res.network);
    if (res.elements?.length) {
      lines.push(
        '',
        'Interactive elements:',
        ...res.elements.slice(0, 90).map((e) => `[${e.ref}] <${e.tag}${e.type ? ` type=${e.type}` : ''}> ${e.label}${e.href ? ` (${e.href})` : ''}`),
      );
    }
    if (res.text) lines.push('', 'Visible text:', res.text);
    return lines.join('\n');
  }

  if (name === 'browser_act') {
    const action = String(args?.action ?? '');
    const allowed = ['click', 'hover', 'type', 'press', 'select', 'scroll', 'wait', 'back', 'forward', 'reload'];
    if (!allowed.includes(action)) throw new Error(`Invalid action "${action}".`);
    const res = await callBrowserExtension<{ ok: boolean; detail: string; url?: string }>('act', {
      action,
      tabId: typeof args?.tabId === 'number' ? args.tabId : undefined,
      ref: typeof args?.ref === 'number' ? args.ref : undefined,
      selector: typeof args?.selector === 'string' ? args.selector : undefined,
      text: typeof args?.text === 'string' ? args.text : undefined,
      direction: typeof args?.direction === 'string' ? args.direction : undefined,
      x: typeof args?.x === 'number' ? args.x : undefined,
      y: typeof args?.y === 'number' ? args.y : undefined,
    });
    return `${res.detail}${res.url ? ` (${res.url})` : ''}`;
  }

  if (name === 'browser_close') {
    const tabId = Number(args?.tabId);
    if (!Number.isFinite(tabId)) throw new Error('"tabId" must be a number.');
    await callBrowserExtension('close', { tabId });
    return `Closed Chrome tab [${tabId}].`;
  }

  return undefined;
}
