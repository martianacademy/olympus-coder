import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ClipboardPaste, Copy, FileCode2, RotateCcw } from 'lucide-react';
import type { ThemeSettings } from '@shared/types';
import { codeFontCss, DEFAULT_THEME, UI_FONTS } from '@shared/themes';
import { parseTweakcnCss, themeToTweakcnCss } from '@shared/tweakcnTheme';
import { copyText } from '../../clipboard';

const CodeEditor = lazy(() => import('../Editor').then((m) => ({ default: m.CodeEditor })));

/**
 * Settings → Appearance → Theme CSS:
 * Full standard Tailwind / shadcn / tweakcn `globals.css` editor (`:root` + `.dark`).
 * Users can paste any theme directly from tweakcn.com, load their active preset as editable CSS,
 * or tweak individual tokens (`--background`, `--primary`, `--sidebar`, `--radius`, `--font-sans`, …)
 * with live preview on the app behind the resizable Settings window.
 */
export function ThemeCssEditor({
  theme,
  dark,
  onChange,
  onBack,
}: {
  theme: ThemeSettings;
  dark: boolean;
  onChange: (patch: Partial<ThemeSettings>) => void;
  onBack?: () => void;
}) {
  const t: ThemeSettings = { ...DEFAULT_THEME, ...theme };
  const uiFontCss = UI_FONTS.find((f) => f.id === t.uiFont)?.css ?? UI_FONTS[0].css;
  const codeFontCssStr = `${codeFontCss(t.codeFont)}, ui-monospace, Menlo, monospace`;

  const generated = useMemo(() => themeToTweakcnCss(t, uiFontCss, codeFontCssStr), [t, uiFontCss, codeFontCssStr]);
  const [draft, setDraft] = useState<string>(() => (t.customCss?.trim() ? t.customCss : generated));
  const draftRef = useRef(draft);
  const [copied, setCopied] = useState(false);
  const [pasteErr, setPasteErr] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setDraftValue = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };

  // Sync draft when customCss is cleared externally (e.g. Reset all or picking a preset).
  const prevCustom = useRef(t.customCss);
  useEffect(() => {
    if (prevCustom.current !== t.customCss) {
      prevCustom.current = t.customCss;
      if (!t.customCss?.trim()) setDraftValue(generated);
      else setDraftValue(t.customCss);
    }
  }, [t.customCss, generated]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const parsed = useMemo(() => parseTweakcnCss(draft), [draft]);
  const activeMode = dark ? parsed.dark : parsed.light;
  const hasCustomActive = Boolean(t.customCss?.trim());

  const applyDraft = (next: string, immediate = false) => {
    setDraftValue(next);
    setPasteErr('');
    if (timer.current) clearTimeout(timer.current);
    const commit = () => {
      const trimmed = next.trim();
      if (!trimmed) {
        onChange({ customCss: undefined });
        return;
      }
      const p = parseTweakcnCss(trimmed);
      if (p.hasAny) onChange({ customCss: trimmed });
    };
    if (immediate) commit();
    else timer.current = setTimeout(commit, 180);
  };

  const onEditorChange = (v: string) => {
    // Ignore programmatic value echoes from CodeEditor's value-sync effect (e.g. after Reset to preset).
    if (v === draftRef.current) return;
    applyDraft(v);
  };

  const pasteClipboard = async () => {
    setPasteErr('');
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setPasteErr('Clipboard is empty.');
        return;
      }
      const p = parseTweakcnCss(text);
      if (!p.hasAny) {
        setPasteErr('No CSS custom properties (--background, --primary, etc.) found in clipboard.');
        return;
      }
      applyDraft(text.trim(), true);
    } catch {
      setPasteErr('Could not read clipboard — paste directly inside the editor (⌘V).');
    }
  };

  const loadPresetCss = () => {
    const fresh = themeToTweakcnCss({ ...t, customCss: undefined }, uiFontCss, codeFontCssStr);
    applyDraft(fresh, true);
  };

  const resetCss = () => {
    if (timer.current) clearTimeout(timer.current);
    const fresh = themeToTweakcnCss({ ...t, customCss: undefined }, uiFontCss, codeFontCssStr);
    setDraftValue(fresh);
    onChange({ customCss: undefined });
    setPasteErr('');
  };

  const swatches = [activeMode.palette.panel, activeMode.palette.bg, activeMode.palette.surface, activeMode.palette.accent].filter(
    (c): c is string => Boolean(c),
  );

  return (
    <div data-testid="theme-css-editor">
      {onBack && (
        <div className="row" style={{ marginBottom: 8, gap: 8 }}>
          <button type="button" className="btn small ghost" data-testid="tweakcn-back" onClick={onBack} style={{ paddingLeft: 6 }}>
            <ArrowLeft size={13} /> Back to Theme &amp; Colors
          </button>
          {hasCustomActive && (
            <button type="button" className="btn small" data-testid="tweakcn-reset-top" onClick={resetCss} style={{ marginLeft: 'auto' }}>
              <RotateCcw size={12} /> Revert to preset
            </button>
          )}
        </div>
      )}
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        Paste any standard Tailwind / shadcn / <b>tweakcn.com</b> CSS theme (<code>:root</code> + <code>.dark</code>, supporting{' '}
        <code>oklch()</code>, <code>hsl()</code>, and hex), or edit variables live. Drag or resize this window to see changes on the app behind it.
      </p>

      <div className="tweakcn-bar">
        <button type="button" className="btn small primary" data-testid="tweakcn-paste" onClick={() => void pasteClipboard()}>
          <ClipboardPaste size={12} /> Paste tweakcn CSS
        </button>
        <button type="button" className="btn small ghost" data-testid="tweakcn-load-preset" onClick={loadPresetCss}>
          <FileCode2 size={12} /> Load current preset
        </button>
        <button
          type="button"
          className="btn small ghost"
          data-testid="tweakcn-copy"
          onClick={() => {
            void copyText(draft).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy CSS'}
        </button>
        {hasCustomActive && (
          <button type="button" className="btn small ghost" data-testid="tweakcn-reset" onClick={resetCss} style={{ marginLeft: 'auto' }}>
            <RotateCcw size={12} /> Reset to preset
          </button>
        )}
      </div>

      <div className="tweakcn-editor-wrap" data-testid="tweakcn-code-host">
        <Suspense fallback={<div className="small muted" style={{ padding: 12 }}>Loading CSS editor…</div>}>
          <CodeEditor path="globals.css" value={draft} dark={dark} onChange={onEditorChange} onSave={() => applyDraft(draftRef.current, true)} />
        </Suspense>
      </div>

      <div className="tweakcn-status">
        {hasCustomActive && parsed.hasAny ? (
          <>
            <span className="tweakcn-badge" data-testid="tweakcn-active-badge">
              Active
            </span>
            {swatches.length > 0 && (
              <span className="tweakcn-swatches" aria-hidden="true">
                {swatches.map((c, i) => (
                  <i key={i} style={{ background: c }} />
                ))}
              </span>
            )}
            <span className="small muted" data-testid="tweakcn-counts">
              {parsed.lightCount} light · {parsed.darkCount} dark variables
              {activeMode.radius !== undefined ? ` · radius ${activeMode.radius}px` : ''}
            </span>
          </>
        ) : parsed.hasAny ? (
          <span className="small muted">Showing current preset as Tailwind CSS — edit any line or paste a tweakcn theme to activate.</span>
        ) : (
          <span className="small error-text" data-testid="tweakcn-error">
            No valid CSS custom properties found. Include <code>:root {'{ --background: ...; --primary: ...; }'}</code>.
          </span>
        )}
      </div>
      {pasteErr && (
        <div className="small error-text" style={{ marginTop: 6 }}>
          {pasteErr}
        </div>
      )}
    </div>
  );
}
