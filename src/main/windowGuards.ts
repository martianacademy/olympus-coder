import { shell, type BrowserWindow } from 'electron';

/** http(s) on this machine: localhost, 127.x, 0.0.0.0, [::1] — the only pages the Web tab will show. */
export const isLocalUrl = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)$/i.test(u.hostname);
  } catch {
    return false;
  }
};

/**
 * The guards every app window gets (main window and detached tool windows): a <webview> may only show a local dev
 * server with no Node, no preload and a sandbox; new windows and navigations away from the app page go to the
 * user's browser instead.
 */
export function hardenWindow(w: BrowserWindow) {
  w.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete (prefs as any).preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (!isLocalUrl(params.src)) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (w.isDestroyed() || url !== w.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

/**
 * Shows a window once it has painted. `testHidden` (OLYMPUS_TEST_HIDDEN=1): render normally but never take the
 * user's keyboard focus or clicks, never sit on top of their work, and stay out of the Dock / Mission Control (an
 * opacity-0 window still steals focus and input).
 */
export function showWhenReady(w: BrowserWindow, testHidden: boolean) {
  w.once('ready-to-show', () => {
    if (w.isDestroyed()) return;
    if (!testHidden) return w.show();
    w.setFocusable(false);
    w.setIgnoreMouseEvents(true);
    w.setOpacity(0);
    w.setSkipTaskbar(true);
    if (process.platform === 'darwin') w.setHiddenInMissionControl(true);
    w.showInactive();
  });
}
