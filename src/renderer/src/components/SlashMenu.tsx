import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { SessionView } from '@shared/types';
import '../slashMenu.css';

export type SlashCommand = SessionView['commands'][number];

/**
 * The `/name` token at the very start of the message. Leading spaces are allowed because `send()` trims them;
 * agents (claude-agent-acp, codex-acp) only run a command when the prompt's first text block starts with `/`.
 */
const TOKEN = /^(\s*)\/(\S*)/;
/** `/name ` with nothing typed after it yet: the moment to show the command's input hint. */
const AWAITING_INPUT = /^\s*\/(\S+) +$/;

const bare = (name: string) => name.replace(/^\//, '');

/** Relevance of one command for the typed query; 0 hides it. Prefix beats word-start beats substring beats fuzzy. */
function score(c: SlashCommand, q: string): number {
  if (!q) return 1;
  const n = bare(c.name).toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/[-_:./]/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  if (i === q.length) return 20;
  // One letter matches far too many descriptions; from two letters on they help ("/rev" -> "…review comments").
  return q.length > 1 && c.description?.toLowerCase().includes(q) ? 10 : 0;
}

/** Commands matching `query`, best first; equal scores keep the agent's own order. Duplicate names are dropped. */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  return commands
    .filter((c) => c.name && !seen.has(bare(c.name)) && seen.add(bare(c.name)))
    .map((c, i) => ({ c, i, s: score(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

/** Copies the textarea's text metrics onto the hint overlay so the hint starts exactly where the caret is. */
function matchFont(from: HTMLElement, to: HTMLElement) {
  const cs = getComputedStyle(from);
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontFeatureSettings', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent'] as const) {
    to.style[k] = cs[k];
  }
}

export interface SlashMenuState {
  /** The popup (rendered inside the positioned `.composer`), or null when closed. */
  menu: ReactNode;
  /** Muted input hint after `/name `, overlaid on the textarea; render next to it inside `.growable-textarea`. */
  ghost: ReactNode;
  /** Call first in the textarea's onKeyDown; true means the key was used by the menu. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Spread onto the textarea: focus tracking, caret tracking and combobox ARIA. */
  textareaProps: {
    role?: 'combobox';
    'aria-autocomplete'?: 'list';
    'aria-expanded'?: boolean;
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
    onFocus: () => void;
    onBlur: () => void;
    onSelect: () => void;
  };
}

/**
 * Slash-command autocomplete for a composer textarea, fed by the agent's ACP `available_commands_update`.
 * Picking a command only inserts `/name ` into the draft; the message is still sent the normal way.
 */
export function useSlashMenu(opts: {
  text: string;
  setText: (next: string) => void;
  commands: SlashCommand[];
  ta: RefObject<HTMLTextAreaElement | null>;
}): SlashMenuState {
  const { text, setText, commands, ta } = opts;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const pointerAt = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(text.length);
  const [sel, setSel] = useState({ q: '', i: 0 });
  const [dismissed, setDismissed] = useState<string | null>(null);

  const m = TOKEN.exec(text);
  const slashAt = m ? m[1].length : -1;
  const tokenEnd = m ? m[0].length : -1;
  const query = m ? m[2] : '';
  const hasToken = Boolean(m);
  const items = useMemo(() => (hasToken && commands.length ? rankCommands(commands, query) : []), [commands, query, hasToken]);
  const open = focused && hasToken && caret > slashAt && caret <= tokenEnd && items.length > 0 && dismissed !== query;
  const active = sel.q === query ? Math.min(sel.i, items.length - 1) : 0;

  // The caret after every text change (typing, paste, text sent in from elsewhere), and after a pick.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    if (document.activeElement === el) setCaret(el.selectionStart ?? text.length);
  }, [text, ta]);

  // Esc hides the menu for the current query only; deleting the `/` forgets it.
  useEffect(() => {
    if (!hasToken && dismissed !== null) setDismissed(null);
  }, [hasToken, dismissed]);

  // Every opening starts on the first row. Chromium also sends mousemoves when content appears under a resting
  // pointer, so only a pointer that moves after the menu is open may change the active row.
  useEffect(() => {
    if (open) return;
    pointerAt.current = null;
    setSel({ q: '', i: 0 });
  }, [open]);
  function onRowMove(e: MouseEvent, i: number) {
    const at = `${e.clientX},${e.clientY}`;
    const moved = pointerAt.current !== null && pointerAt.current !== at;
    pointerAt.current = at;
    if (moved && i !== active) setSel({ q: query, i });
  }

  // Keep the active row in view without scrolling anything outside the list.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
  }, [active, open, query]);

  function pick(c: SlashCommand) {
    const insert = `/${bare(c.name)} `;
    const rest = text.slice(tokenEnd).replace(/^[ \t]+/, '');
    pendingCaret.current = insert.length;
    setCaret(insert.length);
    setText(insert + rest);
    ta.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return false;
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    const n = items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setSel({ q: query, i: (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
    } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      pick(items[active]);
    } else if (e.key === 'Escape') {
      setDismissed(query);
      e.stopPropagation();
    } else return false;
    e.preventDefault();
    return true;
  }

  const awaiting = !open ? AWAITING_INPUT.exec(text) : null;
  const hint = awaiting ? commands.find((c) => bare(c.name) === awaiting[1])?.inputHint : undefined;
  useLayoutEffect(() => {
    if (hint && ghostRef.current && ta.current) matchFont(ta.current, ghostRef.current);
  }, [hint, ta]);

  const menu = open ? (
    <div
      ref={listRef}
      id={listId}
      className="slash-menu"
      role="listbox"
      aria-label="Agent commands"
      onMouseDown={(e) => e.preventDefault()}
      data-testid="slash-menu"
    >
      {items.map((c, i) => (
        <div
          key={c.name}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={i === active}
          data-index={i}
          className={`slash-item ${i === active ? 'active' : ''}`}
          onMouseMove={(e) => onRowMove(e, i)}
          onClick={() => pick(c)}
          data-testid="slash-item"
        >
          <span className="slash-name">
            {`/${bare(c.name)}`}
            {c.inputHint && <span className="slash-hint"> {c.inputHint}</span>}
          </span>
          {c.description && <span className="slash-desc">{c.description}</span>}
        </div>
      ))}
    </div>
  ) : null;

  const ghost = hint ? (
    <div ref={ghostRef} className="slash-ghost" aria-hidden="true" data-testid="slash-ghost">
      <span className="slash-ghost-typed">{text}</span>
      <span className="slash-ghost-hint">{hint}</span>
    </div>
  ) : null;

  return {
    menu,
    ghost,
    onKeyDown,
    textareaProps: {
      ...(commands.length
        ? {
            role: 'combobox' as const,
            'aria-autocomplete': 'list' as const,
            'aria-expanded': open,
            'aria-controls': open ? listId : undefined,
            'aria-activedescendant': open ? `${listId}-${active}` : undefined,
          }
        : {}),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onSelect: () => setCaret(ta.current?.selectionStart ?? 0),
    },
  };
}
