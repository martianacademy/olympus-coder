import { useEffect, useRef } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api, onEvent, remoteWatch } from '../api';
import { ERROR_LINE, stripAnsi } from '../compose';
import { fileRefs, useOpenFile } from '../fileLinks';
import { getThemeSettings } from '../theme';
import { isLocalUrl, openWebPreview } from './WebPreview';
import { copyText } from '../clipboard';

/** Live terminals by pty id, so the panel's toolbar (Clear, Copy) can act on the one in front. */
const live = new Map<string, XTerm>();

export function terminalAction(ptyId: string, action: 'clear' | 'copy' | 'interrupt'): boolean {
  const t = live.get(ptyId);
  if (action === 'interrupt') {
    void api.ptyWrite(ptyId, '\x03');
    return true;
  }
  if (!t) return false;
  if (action === 'clear') t.clear();
  if (action === 'copy') {
    const text = t.hasSelection()
      ? t.getSelection()
      : Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) ?? '')
          .join('\n')
          .trimEnd();
    void copyText(text);
  }
  t.focus();
  return true;
}

/** The last `lines` lines of a terminal, as plain text. */
export function terminalText(ptyId: string, lines = 60): string {
  const t = live.get(ptyId);
  if (!t) return '';
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = Math.max(0, b.length - 400); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').trimEnd().split('\n').slice(-lines).join('\n');
}

/** How many lines a terminal's buffer holds now (a mark to read only what comes after). */
export const terminalLineCount = (ptyId: string) => live.get(ptyId)?.buffer.active.length ?? 0;

/** The text printed since line `from` (see terminalLineCount), at most `max` lines. */
export function terminalTextFrom(ptyId: string, from: number, max = 600): string {
  const t = live.get(ptyId);
  if (!t) return '';
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = Math.max(from, b.length - max); i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    // A wrapped line continues the one before it.
    if (line.isWrapped && out.length) out[out.length - 1] += line.translateToString(true);
    else out.push(line.translateToString(true));
  }
  return out.join('\n');
}

/**
 * Find in a terminal's output (all of its scrollback). `mode: 'errors'` finds lines that look like failures
 * instead of a text. Selects the match and scrolls it into view; returns its position among all matches.
 */
export function terminalFind(ptyId: string, query: string, opts: { mode?: 'text' | 'errors'; backwards?: boolean; caseSensitive?: boolean; restart?: boolean }): { index: number; total: number } {
  const t = live.get(ptyId);
  if (!t) return { index: 0, total: 0 };
  const b = t.buffer.active;
  const matches: { row: number; col: number; len: number }[] = [];
  const q = opts.caseSensitive ? query : query.toLowerCase();
  for (let row = 0; row < b.length; row++) {
    const raw = b.getLine(row)?.translateToString(true) ?? '';
    if (opts.mode === 'errors') {
      if (raw.trim() && ERROR_LINE.test(raw)) {
        const col = raw.length - raw.trimStart().length;
        matches.push({ row, col, len: raw.trim().length });
      }
      continue;
    }
    if (!q) continue;
    const line = opts.caseSensitive ? raw : raw.toLowerCase();
    for (let at = line.indexOf(q); at >= 0; at = line.indexOf(q, at + Math.max(1, q.length))) matches.push({ row, col: at, len: q.length });
  }
  if (!matches.length) {
    t.clearSelection();
    return { index: 0, total: 0 };
  }
  // Next / previous from the current selection (or from the bottom, where the latest output is).
  const sel = opts.restart ? undefined : t.getSelectionPosition();
  const cur = sel ? sel.start.y * 100000 + sel.start.x : opts.backwards ? Infinity : -1;
  const key = (m: { row: number; col: number }) => m.row * 100000 + m.col;
  let i = opts.backwards ? matches.map(key).findLastIndex((k) => k < cur) : matches.findIndex((m) => key(m) > cur);
  if (i < 0) i = opts.backwards ? matches.length - 1 : 0;
  if (opts.restart) i = matches.length - 1; // a new search starts at the latest match
  const m = matches[i];
  t.select(m.col, m.row, m.len);
  t.scrollToLine(Math.max(0, m.row - Math.floor(t.rows / 2)));
  return { index: i + 1, total: matches.length };
}

/** Clears a search's selection. */
export const terminalFindClear = (ptyId: string) => live.get(ptyId)?.clearSelection();

/** Colours from the app theme, with an ANSI palette that reads well on it (dark or light). */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = v('--surface', dark ? '#17171b' : '#ffffff');
  const fg = v('--text', dark ? '#ececf1' : '#1d1d22');
  const accent = v('--accent', '#d97757');
  const selection = /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}${dark ? '55' : '40'}` : dark ? 'rgba(217,119,87,0.33)' : 'rgba(217,119,87,0.25)';
  return dark
    ? {
        background: bg, foreground: fg, cursor: accent, cursorAccent: bg, selectionBackground: selection,
        black: '#1e1e24', red: '#f47174', green: '#7fd48a', yellow: '#f2c66d', blue: '#7aa7ff', magenta: '#d39cf5', cyan: '#6fd3d8', white: '#d7d7de',
        brightBlack: '#6b6b78', brightRed: '#ff8a8d', brightGreen: '#9be7a4', brightYellow: '#ffd98a', brightBlue: '#9cc0ff', brightMagenta: '#e3b6ff', brightCyan: '#8fe6ea', brightWhite: '#ffffff',
      }
    : {
        background: bg, foreground: fg, cursor: accent, cursorAccent: bg, selectionBackground: selection,
        black: '#2b2b33', red: '#c8373c', green: '#2d8a3e', yellow: '#9a6a00', blue: '#2f62c9', magenta: '#8e44b5', cyan: '#18808a', white: '#d0d0d8',
        brightBlack: '#6e6e7a', brightRed: '#e0484d', brightGreen: '#38a34c', brightYellow: '#b47d00', brightBlue: '#3d74e0', brightMagenta: '#a557cf', brightCyan: '#1f97a2', brightWhite: '#ffffff',
      };
}

/** A clear-screen (ED 2/3 or full reset). Dashboards that redraw on a timer start every frame with one. */
const CLEAR = /\x1b\[[23]J|\x1bc/;

/**
 * A pseudo-terminal running in the main process. On mount it replays the scrollback the main process kept,
 * so switching tabs, modes or unlocking the app never loses output.
 *
 * No flicker: output is written once per animation frame, and when a chunk clears the screen the write waits
 * (briefly) for the redraw that follows, so the cleared screen and the new content appear in the same frame.
 * Drawn with WebGL when available.
 */
export function Terminal({
  ptyId,
  onExit,
  visible = true,
  onError,
  onCommand,
  onOutput,
  onFind,
}: {
  ptyId: string;
  onExit?: (code: number) => void;
  visible?: boolean;
  /** Output that looks like a failure just appeared (stack trace, compiler error, failed test …). */
  onError?: () => void;
  /** The user pressed Enter in this terminal (a new command). */
  onCommand?: () => void;
  /** New output was drawn. */
  onOutput?: () => void;
  /** ⌘F (macOS) / Ctrl+Shift+F pressed in the terminal. */
  onFind?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const openFile = useOpenFile();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const hooks = useRef({ onError, onCommand, onOutput, onFind, openFile });
  hooks.current = { onError, onCommand, onOutput, onFind, openFile };
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const ts = getThemeSettings();
    const initSize = (ts.terminalFontSize && ts.terminalFontSize > 0 ? ts.terminalFontSize : undefined) ?? (parseFloat(css.getPropertyValue('--term-size') || css.getPropertyValue('--code-size')) || 12.5);
    const term = new XTerm({
      fontFamily: css.getPropertyValue('--code-font').trim() || 'ui-monospace, Menlo, monospace',
      fontSize: initSize,
      lineHeight: ts.terminalLineHeight ?? 1.25,
      cursorBlink: ts.terminalCursorBlink !== false,
      cursorStyle: ts.terminalCursorStyle ?? 'bar',
      cursorWidth: 2,
      scrollback: ts.terminalScrollback ?? 10000,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      drawBoldTextInBrightColors: true,
      theme: themeFromCss(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose()); // falls back to the DOM renderer
      term.loadAddon(gl);
    } catch {
      /* no WebGL: the DOM renderer is fine */
    }
    live.set(ptyId, term);

    // Follow the app's light / dark switch and live Appearance → Terminal / Code updates.
    const themeObs = new MutationObserver(() => {
      term.options.theme = themeFromCss();
      const comp = getComputedStyle(document.documentElement);
      const cur = getThemeSettings();
      const nextFamily = comp.getPropertyValue('--code-font').trim() || 'ui-monospace, Menlo, monospace';
      const nextSize = (cur.terminalFontSize && cur.terminalFontSize > 0 ? cur.terminalFontSize : undefined) ?? (parseFloat(comp.getPropertyValue('--term-size') || comp.getPropertyValue('--code-size')) || 12.5);
      const nextLh = cur.terminalLineHeight ?? 1.25;
      let needsFit = false;
      if (term.options.fontFamily !== nextFamily) {
        term.options.fontFamily = nextFamily;
        needsFit = true;
      }
      if (term.options.fontSize !== nextSize) {
        term.options.fontSize = nextSize;
        needsFit = true;
      }
      if (term.options.lineHeight !== nextLh) {
        term.options.lineHeight = nextLh;
        needsFit = true;
      }
      if (term.options.cursorStyle !== (cur.terminalCursorStyle ?? 'bar')) {
        term.options.cursorStyle = cur.terminalCursorStyle ?? 'bar';
      }
      if (term.options.cursorBlink !== (cur.terminalCursorBlink !== false)) {
        term.options.cursorBlink = cur.terminalCursorBlink !== false;
      }
      if (term.options.scrollback !== (cur.terminalScrollback ?? 10000)) {
        term.options.scrollback = cur.terminalScrollback ?? 10000;
      }
      if (needsFit) fitRef.current();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });

    // Resize the pty only when the grid really changes: every resize makes the program redraw its screen.
    let sent = '';
    const doFit = () => {
      if (!visibleRef.current) return;
      if (!box.current?.offsetWidth || !box.current.offsetHeight) return;
      try {
        const dims = fit.proposeDimensions();
        if (!dims || !dims.cols || !dims.rows) return;
        if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
        const key = `${term.cols}x${term.rows}`;
        if (key !== sent) {
          sent = key;
          void api.ptyResize(ptyId, term.cols, term.rows);
        }
      } catch {
        /* not laid out yet */
      }
    };
    fitRef.current = doFit;
    // Fit immediately so `term.cols` matches the container width before any scrollback is written.
    doFit();
    let fitFrame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(doFit);
    });
    ro.observe(box.current!);
    // ⌘F / Ctrl+F opens Find instead of reaching the shell.
    term.attachCustomKeyEventHandler((e) => {
      // macOS: ⌘F. Elsewhere Ctrl+Shift+F, because plain Ctrl+F moves the cursor in the shell.
      const mac = navigator.platform.toLowerCase().includes('mac');
      const combo = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey;
      if (e.type === 'keydown' && combo && !e.altKey && e.key.toLowerCase() === 'f' && hooks.current.onFind) {
        e.preventDefault();
        hooks.current.onFind();
        return false;
      }
      return true;
    });
    term.onData((d) => {
      void api.ptyWrite(ptyId, d);
      if (d.includes('\r')) hooks.current.onCommand?.();
    });
    term.registerLinkProvider({
      provideLinks(line, cb) {
        const text = term.buffer.active.getLine(line - 1)?.translateToString(true) ?? '';
        const out: any[] = [];
        const urls: [number, number][] = [];
        for (const m of text.matchAll(/https?:\/\/[^\s'"]+/g)) {
          const start = (m.index ?? 0) + 1;
          urls.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
          // A local dev server opens in the app's Web tab; anything else in the browser.
          const url = m[0].replace(/[.,;)]+$/, '');
          out.push({ range: { start: { x: start, y: line }, end: { x: start + url.length - 1, y: line } }, text: url, activate: () => (isLocalUrl(url) ? openWebPreview(url) : void api.openExternal(url)) });
        }
        // File paths with a line number (stack traces, compiler errors): open the file at that line.
        for (const f of fileRefs(text)) {
          if (urls.some(([a, b]) => f.index < b && f.index + f.length > a)) continue;
          const start = f.index + 1;
          out.push({
            range: { start: { x: start, y: line }, end: { x: start + f.length - 1, y: line } },
            text: f.ref,
            decorations: { underline: true, pointerCursor: true },
            activate: () => hooks.current.openFile(f.ref),
          });
        }
        cb(out);
      },
    });

    // ---- batched writes ----
    let pending = '';
    let frame = 0;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdSince = 0;
    const flush = () => {
      frame = 0;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      holdSince = 0;
      if (pending) {
        term.write(pending);
        if (hooks.current.onError && ERROR_LINE.test(stripAnsi(pending))) hooks.current.onError();
        hooks.current.onOutput?.();
      }
      pending = '';
    };
    const schedule = () => {
      if (CLEAR.test(pending)) {
        // Wait for the redraw: flush once output pauses for 40 ms, or 150 ms after the clear at the latest.
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (!holdSince) holdSince = performance.now();
        if (holdTimer) clearTimeout(holdTimer);
        const left = 150 - (performance.now() - holdSince);
        holdTimer = setTimeout(flush, Math.max(0, Math.min(40, left)));
        return;
      }
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const push = (data: string) => {
      pending += data;
      // While the window is hidden no frames run: hand big batches to xterm (it buffers) instead of piling up here.
      if (pending.length > 512 * 1024) flush();
      else schedule();
    };

    // Events that arrive before the scrollback do are kept, then only the part after the scrollback is written.
    let replayedTo = -1;
    const early: { data: string; end: number }[] = [];
    const off = onEvent((ch, p) => {
      if (p?.ptyId !== ptyId) return;
      if (ch === 'pty:data') {
        if (replayedTo < 0) early.push(p);
        else if (p.end > replayedTo) {
          push(p.data.slice(Math.max(0, p.data.length - (p.end - replayedTo))));
          replayedTo = p.end;
        }
      }
      if (ch === 'pty:exit') onExit?.(p.exitCode);
    });
    void api.ptyBuffer(ptyId).then((b) => {
      doFit();
      if (b.data) term.write(b.data);
      replayedTo = b.end;
      for (const e of early) if (e.end > replayedTo) push(e.data.slice(Math.max(0, e.data.length - (e.end - replayedTo))));
      replayedTo = Math.max(replayedTo, ...early.map((e) => e.end));
      setTimeout(doFit, 20);
    });
    term.focus();
    return () => {
      off();
      ro.disconnect();
      themeObs.disconnect();
      if (frame) cancelAnimationFrame(frame);
      cancelAnimationFrame(fitFrame);
      if (holdTimer) clearTimeout(holdTimer);
      live.delete(ptyId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  useEffect(() => {
    if (visible) setTimeout(() => fitRef.current(), 20);
  }, [visible]);

  // On a phone the Mac streams only terminals on screen; one shown again gets its scrollback (skipped by `end`).
  useEffect(() => (visible ? remoteWatch('pty', ptyId) : undefined), [ptyId, visible]);

  const sendKey = (seq: string) => {
    void api.ptyWrite(ptyId, seq);
    live.get(ptyId)?.focus();
  };

  return (
    <div className="term-wrap">
      <div className="term-box" ref={box} />
      <div className="term-touch-keys" aria-label="Terminal touch keys" data-testid="term-touch-keys">
        {(
          [
            ['Esc', '\x1b'],
            ['Tab', '\t'],
            ['Ctrl+C', '\x03'],
            ['Ctrl+D', '\x04'],
            ['Ctrl+L', '\x0c'],
            ['↑', '\x1b[A'],
            ['↓', '\x1b[B'],
            ['←', '\x1b[D'],
            ['→', '\x1b[C'],
          ] as const
        ).map(([label, seq]) => (
          <button
            key={label}
            type="button"
            className="term-key-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendKey(seq)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
