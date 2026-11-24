import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import { detectMention, formatMentionInsert, rankMentions, type MentionItem } from '@shared/mentionMenu';
import type { AttachmentView, FileEntry } from '@shared/types';
import { api } from '../api';
import '../slashMenu.css';

export interface MentionMenuState {
  /** The popup (rendered inside the positioned `.composer` / `.home-composer`), or null when closed. */
  menu: ReactNode;
  /** Whether the mention popup is currently open. */
  open: boolean;
  /** Call in the textarea's onKeyDown; true means the key was handled by the mention popup. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onFocus: () => void;
  onBlur: () => void;
  onSelect: () => void;
}

/**
 * `@` file & attachment mention autocomplete for composer textareas (`ChatComposer` & `ChatHome`).
 * Always ranks currently attached/uploaded composer files at the top, followed by searchable files
 * from the active project folder (`files.search`).
 */
export function useMentionMenu(opts: {
  text: string;
  setText: (next: string) => void;
  attachments: AttachmentView[];
  projectId?: string;
  ta: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}): MentionMenuState {
  const { text, setText, attachments, projectId, ta, disabled } = opts;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const pointerAt = useRef<string | null>(null);
  const reqId = useRef(0);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(text.length);
  const [sel, setSel] = useState({ q: '', i: 0 });
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [projectFiles, setProjectFiles] = useState<FileEntry[]>([]);

  const match = !disabled ? detectMention(text, caret) : null;
  const query = match?.query ?? '';
  const triggerActive = Boolean(focused && match && dismissedAt !== match.start);

  // Sync focus & caret reliably after every text change (including initial auto-focus on mount).
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    if (document.activeElement === el) {
      setFocused(true);
      setCaret(el.selectionStart ?? text.length);
    }
  }, [text, ta]);

  // Reset Esc dismissal once the user leaves that `@` token.
  useEffect(() => {
    if (!match && dismissedAt !== null) setDismissedAt(null);
  }, [match, dismissedAt]);

  // Clear cached project search results when switching projects.
  useEffect(() => {
    setProjectFiles([]);
  }, [projectId]);

  // Fetch matching project files while `@` is active on a real project folder.
  useEffect(() => {
    if (!triggerActive || !projectId || projectId === 'general') return;
    const id = ++reqId.current;
    const timer = setTimeout(() => {
      void api.files
        .search(projectId, query, 40)
        .then((res) => {
          if (id === reqId.current) setProjectFiles(res);
        })
        .catch(() => {
          if (id === reqId.current) setProjectFiles([]);
        });
    }, query ? 50 : 0);
    return () => clearTimeout(timer);
  }, [triggerActive, projectId, query]);

  const items = useMemo(
    () => (triggerActive ? rankMentions(attachments, projectId && projectId !== 'general' ? projectFiles : [], query, 40) : []),
    [triggerActive, attachments, projectId, projectFiles, query],
  );
  const open = triggerActive && items.length > 0;
  const active = sel.q === query ? Math.min(sel.i, items.length - 1) : 0;

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

  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
    }
  }, [active, open, query]);

  function pick(item: MentionItem) {
    if (!match) return;
    const inserted = formatMentionInsert(item.target);
    const before = text.slice(0, match.start);
    const after = text.slice(match.end).replace(/^ /, '');
    const nextCaret = before.length + inserted.length;
    pendingCaret.current = nextCaret;
    setCaret(nextCaret);
    setText(before + inserted + after);
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
      if (match) setDismissedAt(match.start);
      e.stopPropagation();
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  const firstFileIdx = items.findIndex((x) => x.kind === 'file');
  const hasAttachments = items.some((x) => x.kind === 'attachment');

  const menu = open ? (
    <div
      ref={listRef}
      id={listId}
      className="slash-menu mention-menu"
      role="listbox"
      aria-label="Reference files and attachments"
      onMouseDown={(e) => e.preventDefault()}
      data-testid="mention-menu"
    >
      {items.map((item, i) => (
        <div key={item.id}>
          {i === 0 && hasAttachments && <div className="mention-section">Attached in message</div>}
          {i === firstFileIdx && firstFileIdx >= 0 && <div className="mention-section">Project files</div>}
          <div
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            data-index={i}
            data-kind={item.kind}
            className={`slash-item mention-item ${i === active ? 'active' : ''}`}
            onMouseMove={(e) => onRowMove(e, i)}
            onClick={() => pick(item)}
            data-testid="mention-item"
          >
            <span className="mention-icon">
              {item.kind === 'attachment' && item.preview ? (
                <img src={item.preview} alt="" className="mention-thumb" />
              ) : item.kind === 'attachment' && item.mime?.startsWith('image/') ? (
                <ImageIcon size={14} />
              ) : item.kind === 'attachment' ? (
                <Paperclip size={14} />
              ) : (
                <FileText size={14} />
              )}
            </span>
            <span className="slash-name mention-name">
              <span className="ellipsis">{item.label}</span>
              {item.kind === 'attachment' && <span className="slash-badge">Attached</span>}
            </span>
            {item.detail && <span className="slash-desc">{item.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  ) : null;

  return {
    menu,
    open,
    onKeyDown,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onSelect: () => setCaret(ta.current?.selectionStart ?? 0),
  };
}
