import { useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Check, Copy, FolderOpen, Maximize2, Minimize2, SquareArrowOutUpRight } from 'lucide-react';
import { api } from '../api';
import { copyText } from '../clipboard';
import { RefBaseContext, useOpenFile, withBase } from '../fileLinks';
import { isRemoteBrowser } from '../responsive';
import { StepIcon, type StepKind } from './stepIcons';
import '../stepBox.css';

/**
 * Body height (px) before a box scrolls; "Expand" lifts the cap. Keep in sync with `.step-box-body`
 * (stepBox.css) and `.cmd-terminal-scroll` (mediaAndConsole.css).
 */
export const STEP_BOX_CAP = 240;

/** Last path segment of a file reference. */
export function fileNameOf(path: string): string {
  const clean = path.trim().replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).pop() || clean;
}

/** Short parent folder for a box header: relative to `base` when inside it, else the last two folders. */
export function shortDirOf(path: string, base?: string): string {
  const clean = path.trim().replace(/^file:\/\//i, '');
  const rel = base && clean.startsWith(`${base.replace(/\/$/, '')}/`) ? clean.slice(base.replace(/\/$/, '').length + 1) : clean;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  parts.pop();
  if (!parts.length) return '';
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * Absolute local path for "Open folder", or '' when the OS file manager cannot be pointed at it from here
 * (relative or `~` refs, URLs). Strips `file://` and trailing `:line` / `#L12` suffixes.
 */
export function revealablePath(ref: string): string {
  let p = ref.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    try {
      p = decodeURIComponent(p);
    } catch {
      // Malformed percent-escapes: keep the path as written.
    }
    p = p.replace(/^\/([a-z]:[\\/])/i, '$1');
  }
  p = p.replace(/#L?\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  return /^(?:\/|[a-z]:[\\/])/i.test(p) ? p : '';
}

/** Slim labelled header action shared by every step box (and the command terminal bar). */
export function BoxButton({
  icon,
  label,
  tip,
  testId,
  className = '',
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tip: string;
  testId: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`step-box-btn ${className}`}
      title={tip}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {icon}
      <span className="step-box-btn-label">{label}</span>
    </button>
  );
}

/** "Copy" header action that briefly confirms with "Copied". */
export function CopyBoxButton({
  text,
  label = 'Copy',
  tip,
  testId,
  className,
  icon = <Copy size={11} />,
}: {
  text: string;
  label?: string;
  tip: string;
  testId: string;
  className?: string;
  icon?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <BoxButton
      icon={copied ? <Check size={11} /> : icon}
      label={copied ? 'Copied' : label}
      tip={tip}
      testId={testId}
      className={className}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    />
  );
}

/**
 * Height cap for a box body: `overflows` turns true once the content is taller than `cap`, so the
 * Expand / Collapse action only appears when there is something hidden.
 */
export function useBodyCap(cap: number): {
  innerRef: RefObject<HTMLDivElement | null>;
  overflows: boolean;
  expanded: boolean;
  toggle: () => void;
} {
  const innerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > cap + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cap]);

  return { innerRef, overflows, expanded, toggle: () => setExpanded((v) => !v) };
}

/** Expand / Collapse header action for a capped body. */
export function ExpandBoxButton({
  expanded,
  onToggle,
  testId,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  testId: string;
  className?: string;
}) {
  return (
    <BoxButton
      icon={expanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
      label={expanded ? 'Collapse' : 'Expand'}
      tip={expanded ? 'Limit the height of this box' : 'Show the whole content'}
      testId={testId}
      className={className}
      onClick={onToggle}
    />
  );
}

export interface StepBoxProps {
  /** Step kind, drives the small header glyph and `data-box-kind`. */
  kind: StepKind;
  /** Main header text: a file name, a query, a URL or a tool name. */
  title: ReactNode;
  /** Muted secondary header text (short folder path, scope, tool summary). */
  sub?: string;
  /** Right-aligned header facts: a line range for reads, `+added −removed` for edits, a result count. */
  meta?: ReactNode;
  /** File this box is about: enables "Open" (inside the app) and "Open folder" (OS file manager). */
  filePath?: string;
  /** Text the "Copy" button copies; the button is hidden when empty. */
  copyText?: string;
  /** Monospace body (code, diffs, raw output). Prose such as reasoning sets this to false. */
  mono?: boolean;
  children: ReactNode;
}

/**
 * One flat content box for an expanded step: a slim header (glyph, name, short path, facts, actions) over a
 * capped, scrollable body with an Expand / Collapse toggle. Shared by every step type so they look the same.
 */
export function StepBox({ kind, title, sub, meta, filePath, copyText, mono = true, children }: StepBoxProps) {
  const openFile = useOpenFile();
  const base = useContext(RefBaseContext);
  const { innerRef, overflows, expanded, toggle } = useBodyCap(STEP_BOX_CAP);

  const target = filePath ? withBase(filePath, base) : '';
  const revealTarget = target && !isRemoteBrowser() ? revealablePath(target) : '';

  return (
    <div className={`step-box ${expanded ? 'is-expanded' : ''}`} data-testid="step-box" data-box-kind={kind}>
      <div className="step-box-head">
        <span className="step-box-glyph" aria-hidden="true">
          <StepIcon kind={kind} size={12} />
        </span>
        <span className="step-box-title ellipsis">
          <span className="step-box-name">{title}</span>
          {sub && <span className="step-box-sub mono">{sub}</span>}
        </span>
        {meta && <span className="step-box-meta mono">{meta}</span>}
        <span className="step-box-actions">
          {target && (
            <BoxButton
              icon={<SquareArrowOutUpRight size={11} />}
              label="Open"
              tip="Open this file in the side panel"
              testId="step-box-open"
              onClick={() => openFile(target)}
            />
          )}
          {copyText ? <CopyBoxButton text={copyText} tip="Copy the content shown in this box" testId="step-box-copy" /> : null}
          {revealTarget && (
            <BoxButton
              icon={<FolderOpen size={11} />}
              label="Open folder"
              tip="Show this file in its folder"
              testId="step-box-reveal"
              onClick={() => void api.previewReveal(revealTarget)}
            />
          )}
          {(overflows || expanded) && <ExpandBoxButton expanded={expanded} onToggle={toggle} testId="step-box-expand" />}
        </span>
      </div>
      <div className={`step-box-body ${mono ? 'mono' : 'prose'}`}>
        <div ref={innerRef} className="step-box-inner">
          {children}
        </div>
      </div>
    </div>
  );
}

/** A labelled part inside one box (e.g. "Input" and "Output" of an MCP tool). */
export function StepBoxSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="step-box-section">
      <div className="step-box-section-label">{label}</div>
      {children}
    </div>
  );
}
