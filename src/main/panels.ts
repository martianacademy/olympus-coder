import { BrowserWindow, nativeTheme, type WebContents } from 'electron';
import { PANEL_TITLES, PanelRegistry, isPanelTool, panelQuery, type PanelContext, type PanelTool } from '@shared/panels';
import { hardenWindow, isLocalUrl, showWhenReady } from './windowGuards';

/**
 * Detached Workbench tools (files, git, terminal, tasks, info, web): each can open in a window of its own, one
 * window per tool. The window loads the same renderer with `?panel=<tool>` and the same preload, so it uses the
 * same desk IPC and receives every desk:event (see `allWindows` in index.ts). Never restored on the next start.
 */

interface PanelHost {
  preload: string;
  rendererHtml: string;
  devUrl?: string;
  testHidden: boolean;
  /** The app's main window (gets 'panel:*' events and is focused by "show in main window"). */
  mainWindow: () => BrowserWindow | null;
  /** Sends a desk:event to every app window (lock rule applied by the caller in index.ts). */
  send: (channel: 'panel:closed' | 'panel:context' | 'panel:show' | 'panel:compose', payload: unknown) => void;
}

let host: PanelHost | null = null;
const registry = new PanelRegistry<BrowserWindow>((w) => !w.isDestroyed());
/** Tools closed with Re-attach (the main window then switches to that tab) rather than the window's close button. */
const reattaching = new Set<PanelTool>();
let context: PanelContext | null = null;

export function initPanels(h: PanelHost) {
  host = h;
}

export const panelWindows = () => registry.all();

/** True for the main window's or a detached tool window's own page (never a <webview>, never the phone). */
export function isAppSender(wc: WebContents) {
  const main = host?.mainWindow();
  if (main && !main.isDestroyed() && wc === main.webContents) return true;
  return registry.all().some((w) => w.webContents === wc);
}

function openPanel(tool: PanelTool, url?: string) {
  if (!host) throw new Error('Panels are not ready.');
  const h = host;
  if (tool === 'web' && url && !isLocalUrl(url)) throw new Error('The Web tool only shows local pages.');
  const { win, created } = registry.open(tool, () => {
    const w = new BrowserWindow({
      ...(h.testHidden ? { focusable: false, skipTaskbar: true } : {}),
      width: tool === 'web' ? 1100 : 760,
      height: 720,
      minWidth: 360,
      minHeight: 260,
      show: false,
      title: PANEL_TITLES[tool],
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 12, y: 12 },
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#fcfcfd',
      webPreferences: {
        preload: h.preload,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        // The Web tool is a <webview>; every one is checked in 'will-attach-webview' (hardenWindow).
        webviewTag: true,
      },
    });
    hardenWindow(w);
    showWhenReady(w, h.testHidden);
    // The window keeps the tool's name (the page's <title> would rename it "Olympus Coder").
    w.on('page-title-updated', (e) => e.preventDefault());
    const query = panelQuery(tool, url);
    if (h.devUrl) w.loadURL(`${h.devUrl}${h.devUrl.includes('?') ? '&' : '?'}${new URLSearchParams(query)}`);
    else w.loadFile(h.rendererHtml, { query });
    w.on('closed', () => {
      registry.closed(tool, w);
      const reattach = reattaching.delete(tool);
      h.send('panel:closed', { tool, reattach });
    });
    return w;
  });
  if (!created && !h.testHidden) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  return registry.list();
}

function reattachPanel(tool: PanelTool) {
  const w = registry.get(tool);
  if (w) {
    reattaching.add(tool);
    w.close();
  } else host?.send('panel:closed', { tool, reattach: true });
  const main = host?.mainWindow();
  if (main && !main.isDestroyed() && !host?.testHidden) main.focus();
}

const toolArg = (v: unknown): PanelTool => {
  if (!isPanelTool(v)) throw new Error(`Unknown tool ${String(v)}`);
  return v;
};

/** The desk:panels IPC methods (index.ts checks the sender is an app window and the app is unlocked). */
export function panelCall(sender: WebContents, method: string, args: unknown[]): unknown {
  const main = host?.mainWindow();
  const fromMain = Boolean(main && !main.isDestroyed() && sender === main.webContents);
  switch (method) {
    case 'list':
      return registry.list();
    case 'detach':
      return openPanel(toolArg(args[0]), typeof args[1] === 'string' ? args[1] : undefined);
    case 'reattach':
      reattachPanel(toolArg(args[0]));
      return registry.list();
    case 'context':
      return context;
    case 'setContext': {
      // Only the main window says which project / chat the tools follow.
      if (!fromMain) throw new Error('Not allowed');
      const c = args[0] as PanelContext | null;
      const next = c && typeof c.projectId === 'string' ? { projectId: c.projectId, ...(typeof c.threadId === 'string' ? { threadId: c.threadId } : {}) } : null;
      if (JSON.stringify(next) === JSON.stringify(context)) return context;
      context = next;
      if (registry.list().length) host?.send('panel:context', context);
      return context;
    }
    case 'showInMain': {
      // A detached tool asks the main window to show something (a file from Git, a terminal from Tasks).
      const a = (args[0] ?? {}) as { tab?: unknown; path?: unknown; line?: unknown; ptyId?: unknown; threadId?: unknown };
      if (typeof a.tab !== 'string') throw new Error('No tab');
      host?.send('panel:show', {
        tab: a.tab,
        ...(typeof a.path === 'string' ? { path: a.path } : {}),
        ...(typeof a.line === 'number' ? { line: a.line } : {}),
        ...(typeof a.ptyId === 'string' ? { ptyId: a.ptyId } : {}),
        ...(typeof a.threadId === 'string' ? { threadId: a.threadId } : {}),
      });
      if (main && !main.isDestroyed() && !host?.testHidden) main.focus();
      return true;
    }
    case 'composeInMain': {
      const a = (args[0] ?? {}) as { text?: unknown; files?: unknown };
      if (typeof a.text !== 'string') throw new Error('No text');
      if (main && !main.isDestroyed()) {
        main.webContents.send('desk:event', 'panel:compose', {
          text: a.text,
          files: Array.isArray(a.files) ? a.files : [],
        });
        if (!host?.testHidden) {
          if (main.isMinimized()) main.restore();
          main.focus();
        }
      }
      return true;
    }
    default:
      throw new Error(`Unknown method ${method}`);
  }
}
