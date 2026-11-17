import { app, BrowserWindow, session, type Session, type WebContents } from 'electron';
import { pathToFileURL } from 'node:url';

/**
 * Microphone access is a security boundary. Electron grants every permission when no handler is set, so:
 * - `media` is allowed ONLY when all of these hold: the request comes from the app's own window (a BrowserWindow's
 *   web contents of type 'window', not a <webview>), from its main frame, the URL is the app's own page (the bundled
 *   renderer folder via file://, or the dev server origin in development), and it asks for audio only (no camera).
 * - Every other session (the Web tab's `olympus-web` partition and any future one) gets `media` denied.
 * - Other permission types keep Electron's previous behaviour (unchanged by this module).
 */

const log = (...a: unknown[]) => console.log('[permissions]', ...a);

export function makeIsAppUrl(rendererDir: string, devUrl?: string) {
  const fileBase = pathToFileURL(rendererDir.endsWith('/') ? rendererDir : `${rendererDir}/`).href;
  const devOrigin = (() => {
    try {
      return devUrl ? new URL(devUrl).origin : null;
    } catch {
      return null;
    }
  })();
  return (url: string | undefined): boolean => {
    if (!url) return false;
    if (url.startsWith(fileBase)) return true;
    try {
      return devOrigin !== null && new URL(url).origin === devOrigin;
    } catch {
      return false;
    }
  };
}

export interface MediaAsk {
  wcType: string;
  isAppWindow: boolean;
  isMainFrame: boolean;
  url: string | undefined;
  mediaTypes: string[] | undefined;
}

/** The whole rule in one pure function (unit-tested). */
export function allowMedia(a: MediaAsk, isAppUrl: (u: string | undefined) => boolean): boolean {
  if (a.wcType !== 'window' || !a.isAppWindow || !a.isMainFrame) return false;
  if (!isAppUrl(a.url)) return false;
  const types = a.mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === 'audio');
}

const isAppWindow = (wc: WebContents | null | undefined) => Boolean(wc && wc.getType() === 'window' && BrowserWindow.fromWebContents(wc));

function denyMedia(s: Session) {
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(permission !== 'media'));
  s.setPermissionCheckHandler((_wc, permission) => permission !== 'media');
}

export function installPermissionHandlers(rendererDir: string, devUrl?: string) {
  const isAppUrl = makeIsAppUrl(rendererDir, devUrl);
  const ds = session.defaultSession;
  ds.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission !== 'media') return cb(true);
    const d = details as { mediaTypes?: string[]; isMainFrame?: boolean; requestingUrl?: string };
    const ok = allowMedia(
      { wcType: wc.getType(), isAppWindow: isAppWindow(wc), isMainFrame: d.isMainFrame !== false, url: d.requestingUrl ?? wc.getURL(), mediaTypes: d.mediaTypes },
      isAppUrl,
    );
    if (!ok) log('denied media', { type: wc.getType(), url: d.requestingUrl, mediaTypes: d.mediaTypes });
    cb(ok);
  });
  ds.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== 'media') return true;
    const d = details as { mediaType?: string; isMainFrame?: boolean; requestingUrl?: string };
    // Checks carry one media type; 'unknown' happens for device enumeration. Never 'video'.
    if (d.mediaType === 'video') return false;
    return Boolean(wc && wc.getType() === 'window' && isAppWindow(wc) && isAppUrl(d.requestingUrl ?? wc.getURL() ?? origin));
  });
  // The Web tab's partition and any other session: no microphone or camera.
  denyMedia(session.fromPartition('olympus-web'));
  app.on('session-created', (s) => {
    if (s !== session.defaultSession) denyMedia(s);
  });
}
