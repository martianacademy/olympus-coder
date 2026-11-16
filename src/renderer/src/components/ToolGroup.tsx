import { memo, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react';
import type { ThreadItem } from '@shared/types';
import { useAnyStepOpen, useExpandSteps, useStepChoice } from '../prefs';
import { itemTokens } from '../tokens';
import { parseToolStep } from '../toolStep';
import { KIND_ICON, TokenTag, ToolRow } from './ToolRow';

type ToolItem = Extract<ThreadItem, { kind: 'tool' }>;

const KIND_VERB: Record<string, string> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'command',
  fetch: 'fetch',
};

/**
 * Renders consecutive tool calls as a single collapsible step group (or a standalone `ToolRow`
 * when `items.length === 1`). Strictly obeys the user's `Steps folded / Steps open` preference—never
 * auto-opening running, recent, or failed steps when folded—while keeping any manual user open/fold
 * choice intact across streaming updates, completion, and `1 → 2+` item group transitions.
 */
export const ToolGroup = memo(
  function ToolGroup({ items, live }: { items: ToolItem[]; live: boolean }) {
    const parsedItems = items.map(parseToolStep);
    const running = items.some((t) => t.status === 'pending' || t.status === 'in_progress');
    const failed = items.filter((t, i) => t.status === 'failed' || (parsedItems[i].exitCode !== undefined && parsedItems[i].exitCode !== 0)).length;
    const stopped = items.filter((t) => t.status === 'interrupted').length;
    const expandAll = useExpandSteps();
    const [groupChoice, setGroupChoice] = useStepChoice(`group:${items[0].id}`);
    const childKeys = useMemo(() => items.map((t) => `tool:${t.id}`), [items]);
    const anyChildOpen = useAnyStepOpen(childKeys);
    const tokens = items.reduce((a, t) => a + itemTokens(t), 0);

    const isOpen = groupChoice ?? (expandAll || anyChildOpen);

    // If the group expanded because the user had opened the first tool while it was standalone,
    // pin the group open when toggling a child row so folding that child doesn't collapse the group.
    const pinGroupWhenChildToggled = useCallback(() => {
      if (groupChoice === undefined && isOpen) setGroupChoice(true);
    }, [groupChoice, isOpen, setGroupChoice]);

    if (items.length === 1) {
      return (
        <ToolRow
          item={items[0]}
          standalone
          live={live}
          tokens={tokens}
          defaultOpen={expandAll}
        />
      );
    }

    const counts: Record<string, number> = {};
    for (let i = 0; i < items.length; i++) {
      const k = parsedItems[i].isCommand ? 'execute' : (items[i].toolKind ?? 'other');
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const summary = Object.entries(counts)
      .map(([k, n]) => `${n} ${KIND_VERB[k] ?? 'step'}${n > 1 ? 's' : ''}`)
      .join(' · ');
    const curIdx = [...items].map((_, i) => i).reverse().find((i) => items[i].status === 'in_progress' || items[i].status === 'pending');
    const currentParsed = curIdx !== undefined ? parsedItems[curIdx] : undefined;

    return (
      <div className="tool-group">
        <div className="tool-group-head" onClick={() => setGroupChoice(!isOpen)}>
          {running ? <Loader2 size={14} className="spin" /> : <Wrench size={14} className="muted" />}
          {running && currentParsed && !isOpen ? (
            <>
              <span className="tool-badge">{currentParsed.toolLabel}</span>
              <span className="shimmer ellipsis grow">
                {currentParsed.summary || (currentParsed.isCommand ? `$ ${currentParsed.headerTitle}` : currentParsed.headerTitle) || 'Working…'}
              </span>
              <span className="muted tg-step-pos">
                {(curIdx ?? 0) + 1}/{items.length}
              </span>
            </>
          ) : running ? (
            <span className="grow ellipsis">
              <span className="shimmer">
                Running step {(curIdx ?? 0) + 1} of {items.length}
              </span>{' '}
              <span className="muted">· {summary}</span>
            </span>
          ) : (
            <span className="grow ellipsis">
              {items.length} steps <span className="muted">· {summary}</span>
            </span>
          )}
          <TokenTag n={tokens} live={live && running} />
          {failed > 0 && <span className="status-pill failed">{failed} failed</span>}
          {stopped > 0 && (
            <span className="status-pill" title="The agent's process ended (the app was closed or restarted) before these finished.">
              {stopped} stopped
            </span>
          )}
          <span className="tg-icons">
            {[...new Set(items.map((t, i) => (parsedItems[i].isCommand ? 'execute' : (t.toolKind ?? 'other'))))].slice(0, 4).map((k) => (
              <span key={k}>{KIND_ICON[k] ?? <Wrench size={13} />}</span>
            ))}
          </span>
          {isOpen ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
        </div>
        {isOpen && (
          <div className="tool-group-body">
            {items.map((t) => (
              <ToolRow
                key={t.id}
                item={t}
                live={live}
                defaultOpen={expandAll}
                onBeforeToggle={pinGroupWhenChildToggled}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
  (a, b) => a.live === b.live && a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]),
);
