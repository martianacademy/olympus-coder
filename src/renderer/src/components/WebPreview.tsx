import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Globe, RotateCw, SquareArrowOutUpRight, X } from 'lucide-react';
import { api } from '../api';
import { triggerFixError } from '../fixError';

/** Asks the workbench to show a local dev server in its Web tab. */
export const openWebPreview = (url: string) => window.dispatchEvent(new CustomEvent('olympus:web-preview', { detail: { url } }));

/** http(s) on this machine (the only pages the Web tab shows; the main process checks this too). */
export const isLocalUrl = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)$/i.test(u.hostname);
  } catch {
    return false;
  }
};

/** A local dev server URL printed in terminal output ("Local: http://localhost:5173/"), or null. */
export function devServerUrl(text: string): string | null {
  const m = [...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"\x1b)]*)?/g)].pop();
  return m ? m[0].replace('0.0.0.0', 'localhost').replace(/[.,;]+$/, '') : null;
}

interface LogLine {
  level: 'error' | 'warning';
  text: string;
  source?: string;
}

type WebviewEl = HTMLElement & {
  reload: () => void;
  getURL: () => string;
  loadURL: (u: string) => Promise<void>;
  capturePage?: () => Promise<{ toPNG?: () => Uint8Array; toDataURL?: () => string }>;
};

async function captureWebviewBase64(el: WebviewEl | null): Promise<string | undefined> {
  if (!el?.capturePage) return undefined;
  try {
    const img = await el.capturePage();
    if (typeof img?.toDataURL === 'function') {
      const url = img.toDataURL();
      const idx = url.indexOf('base64,');
      if (idx >= 0) return url.slice(idx + 7);
    }
  } catch {
    /* webview not ready or remote browser */
  }
  return undefined;
}

/**
 * The Web tab: a local dev server shown inside the app, with its console errors and warnings kept in a drawer
 * at the bottom (closed until there is something), and "Ask agent to fix" (including screenshot + git diff).
 */
export function WebPreview({ url, projectId, onClose }: { url: string; projectId?: string; onClose: () => void }) {
  const view = useRef<WebviewEl | null>(null);
  const [current, setCurrent] = useState(url);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onConsole = (e: any) => {
      // Electron reports the level as a number (0–3) in older versions, a word in newer ones.
      const lv = typeof e.level === 'number' ? (['debug', 'info', 'warning', 'error'][e.level] ?? 'info') : String(e.level);
      if (lv !== 'error' && lv !== 'warning') return;
      if (/^Electron Security Warning/.test(String(e.message))) return; // Electron's own dev-mode notice, not the page's
      const src = e.sourceId ? `${String(e.sourceId).replace(/^https?:\/\/[^/]+/, '')}${e.line ? `:${e.line}` : ''}` : undefined;
      setLogs((l) => [...l.slice(-99), { level: lv as LogLine['level'], text: String(e.message), source: src }]);
    };
    const onFail = (e: any) => {
      if (e.isMainFrame === false || e.errorCode === -3) return; // -3: navigation replaced, not a failure
      setFailed(`${e.errorDescription || 'Failed to load'} (${e.validatedURL || url})`);
      setLoading(false);
    };
    const onStart = () => {
      setFailed(null);
      setLoading(true);
    };
    const onStop = () => setLoading(false);
    const onNav = (e: any) => e.url && setCurrent(e.url);
    el.addEventListener('console-message', onConsole);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-navigate', onNav);
    el.addEventListener('did-navigate-in-page', onNav);
    return () => {
      el.removeEventListener('console-message', onConsole);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-navigate', onNav);
      el.removeEventListener('did-navigate-in-page', onNav);
    };
  }, [url]);

  const errors = logs.filter((l) => l.level === 'error').length;
  const warnings = logs.length - errors;
  const askFix = async () => {
    const screenshotBase64 = await captureWebviewBase64(view.current);
    await triggerFixError({
      source: 'web-console',
      title: current,
      output: logs
        .slice(-30)
        .map((l) => `[${l.level}] ${l.text}${l.source ? `  (${l.source})` : ''}`)
        .join('\n'),
      projectId,
      screenshotBase64,
    });
  };
  const askFixLoad = () => {
    if (!failed) return;
    void triggerFixError({
      source: 'web-load',
      title: current,
      output: failed,
      projectId,
    });
  };

  return (
    <div className="web-preview">
      <div className="fp-head web-head">
        <span className="fp-icon muted">{loading ? <RotateCw size={14} className="spin" /> : <Globe size={15} />}</span>
        <span className="web-url mono ellipsis grow" title={current}>
          {current.replace(/^https?:\/\//, '')}
        </span>
        <button className="btn ghost icon" title="Reload" onClick={() => view.current?.reload()}>
          <RotateCw size={14} />
        </button>
        <button className="btn ghost icon" title="Open in your browser" onClick={() => void api.openExternal(current)}>
          <SquareArrowOutUpRight size={14} />
        </button>
        <button className="btn ghost icon" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="web-body">
        <webview ref={view as any} src={url} partition="olympus-web" className="web-view" />
        {failed && (
          <div className="web-failed">
            <AlertTriangle size={18} className="warn-text" />
            <div>Couldn't load the page.</div>
            <div className="small muted">{failed}</div>
            <div className="small muted">Is the dev server running?</div>
            <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
              <button className="btn small" onClick={() => view.current?.reload()}>
                <RotateCw size={12} /> Try again
              </button>
              <button className="btn small primary" data-testid="web-fix-load" onClick={askFixLoad}>
                Ask agent to fix
              </button>
            </div>
          </div>
        )}
      </div>
      {logs.length > 0 && (
        <div className={`web-console ${open ? 'open' : ''}`}>
          <div className="web-console-head">
            <button className="link-btn" onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              <span>Console</span>
              {errors > 0 && <span className="wc-count error">{errors} error{errors > 1 ? 's' : ''}</span>}
              {warnings > 0 && <span className="wc-count warning">{warnings} warning{warnings > 1 ? 's' : ''}</span>}
            </button>
            <span className="grow" />
            <button className="btn small primary" data-testid="web-fix-error" onClick={() => void askFix()} title="Puts these messages, recent git diff, and a screenshot into the chat's message box">
              Ask agent to fix
            </button>
            <button className="btn ghost small" onClick={() => setLogs([])}>
              Clear
            </button>
          </div>
          {open && (
            <div className="web-console-list">
              {logs.map((l, i) => (
                <div key={i} className={`wc-line ${l.level}`}>
                  <span className="wc-text">{l.text}</span>
                  {l.source && <span className="wc-src small muted">{l.source}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
