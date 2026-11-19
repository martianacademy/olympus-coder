import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot } from 'lucide-react';
import type { ThreadItem } from '@shared/types';
import { useAnyStepOpen, useExpandSteps, useStepChoice } from '../prefs';
import { fmtStepDuration, parseToolStep, type ToolItem } from '../toolStep';
import {
  describeToolAction,
  formatThoughtPreview,
  stepVerb,
  summarizeWorkGroup,
  thoughtVerb,
  type WorkStepItem,
} from '../workStepSummary';
import { Markdown } from './ChatMarkdown';
import { OrchestrationGroup, orchKind, withOlympus } from './Orchestration';
import { StepBox } from './StepBox';
import { StepIcon, toolStepKind, type StepKind } from './stepIcons';
import { ToolRow } from './ToolRow';
import { BrandWorkingMark } from './Working';
import { QUIET_AFTER_MS, quietLabel, stepSignature, useQuietMs } from '../liveQuiet';

type ThoughtItem = Extract<ThreadItem, { kind: 'thought' }>;
type PlanItem = Extract<ThreadItem, { kind: 'plan' }>;

type InnerEntry =
  | { kind: 'thought'; item: ThoughtItem; durationMs?: number }
  | { kind: 'plan'; item: PlanItem }
  | { kind: 'tool'; item: ToolItem }
  | { kind: 'orch'; type: 'spawn' | 'message' | 'check' | 'cancel'; items: ToolItem[] };

type StepNodeState = 'running' | 'failed' | 'stopped' | 'pending' | 'thought' | 'done';

/** Derives the visual status of a single vertical-stepper node inside an expanded `WorkGroup`. */
function getEntryStepState(entry: InnerEntry, isStreamingThought: boolean): StepNodeState {
  if (entry.kind === 'thought') return isStreamingThought ? 'running' : 'thought';
  if (entry.kind === 'plan') {
    if (entry.item.entries.some((e) => e.status === 'in_progress')) return 'running';
    if (entry.item.entries.length > 0 && entry.item.entries.every((e) => e.status === 'completed')) return 'done';
    return 'pending';
  }
  if (entry.kind === 'orch') {
    if (entry.items.some((t) => t.status === 'in_progress' || t.status === 'pending')) return 'running';
    if (entry.items.some((t) => t.status === 'failed' || t.olympus?.isError)) return 'failed';
    if (entry.items.some((t) => t.status === 'interrupted')) return 'stopped';
    return 'done';
  }
  const parsed = parseToolStep(entry.item);
  const badExit = parsed.exitCode !== undefined && parsed.exitCode !== 0;
  if (entry.item.status === 'failed' || badExit) return 'failed';
  if (entry.item.status === 'in_progress') return 'running';
  if (entry.item.status === 'pending') return 'pending';
  if (entry.item.status === 'interrupted') return 'stopped';
  return 'done';
}

/** The small type glyph at the start of one inner entry's row. */
function getEntryStepKind(entry: InnerEntry): StepKind {
  if (entry.kind === 'thought') return 'think';
  if (entry.kind === 'plan') return 'plan';
  if (entry.kind === 'orch') return 'subagent';
  return toolStepKind(entry.item);
}

/** Groups consecutive sub-session orchestration calls inside an expanded `WorkGroup` while keeping exact order. */
function buildInnerEntries(items: WorkStepItem[]): InnerEntry[] {
  const out: InnerEntry[] = [];
  items.forEach((it, i) => {
    if (it.kind === 'thought') {
      // Reasoning has no end time of its own: it lasts until the next step starts.
      const next = items[i + 1];
      out.push({ kind: 'thought', item: it, durationMs: next ? Math.max(0, next.ts - it.ts) : undefined });
      return;
    }
    if (it.kind === 'plan') {
      out.push({ kind: 'plan', item: it });
      return;
    }
    const orch = orchKind(it);
    if (orch) {
      const card = withOlympus(it);
      const last = out[out.length - 1];
      if (last?.kind === 'orch' && last.type === orch && orch !== 'message') last.items.push(card);
      else out.push({ kind: 'orch', type: orch, items: [card] });
    } else {
      out.push({ kind: 'tool', item: it });
    }
  });
  return out;
}

/** Collapsible reasoning row inside an expanded `WorkGroup`: `Thought for 3s` + a quiet one-line preview. */
const WorkThoughtRow = memo(function WorkThoughtRow({
  item,
  streaming,
  durationMs,
  defaultOpen,
  onBeforeToggle,
}: {
  item: ThoughtItem;
  streaming: boolean;
  durationMs?: number;
  defaultOpen: boolean;
  onBeforeToggle: () => void;
}) {
  const [choice, setChoice] = useStepChoice(`thought:${item.id}`);
  const open = choice ?? defaultOpen;
  const preview = formatThoughtPreview(item.text, streaming);

  const toggle = () => {
    onBeforeToggle();
    setChoice(!open);
  };

  return (
    <div className={`tool-row work-thought-row ${open ? 'is-open' : ''}`} data-testid="work-thought-row">
      <div className="tool-row-head" onClick={toggle}>
        <span className={`wg-verb ${streaming ? 'shimmer' : ''}`}>{thoughtVerb(streaming, durationMs)}</span>
        {!open && preview ? <span className="grow ellipsis wg-target wg-thought-snippet">{preview}</span> : <span className="grow" />}
        <ChevronRight size={13} className="wg-row-chev" />
      </div>
      {open && (
        <div className="work-thought-body">
          <StepBox kind="think" title="Reasoning" copyText={item.text} mono={false}>
            <div className="thought msg-agent">
              <Markdown text={item.text} />
            </div>
          </StepBox>
        </div>
      )}
    </div>
  );
});

/** Compact collapsible plan checklist row inside an expanded `WorkGroup`. */
const WorkPlanRow = memo(function WorkPlanRow({
  item,
  defaultOpen,
  onBeforeToggle,
}: {
  item: PlanItem;
  defaultOpen: boolean;
  onBeforeToggle: () => void;
}) {
  const [choice, setChoice] = useStepChoice(`plan:${item.id}`);
  const open = choice ?? defaultOpen;
  const doneCount = item.entries.filter((e) => e.status === 'completed').length;
  const activeEntry = item.entries.find((e) => e.status === 'in_progress') ?? item.entries.find((e) => e.status === 'pending');
  const running = item.entries.some((e) => e.status === 'in_progress');

  return (
    <div className={`tool-row work-plan-row ${open ? 'is-open' : ''}`} data-testid="work-plan-row">
      <div
        className="tool-row-head"
        onClick={() => {
          onBeforeToggle();
          setChoice(!open);
        }}
      >
        <span className="wg-verb">{stepVerb('plan', running)}</span>
        <span className="grow ellipsis wg-target">
          {activeEntry ? activeEntry.content : `${doneCount}/${item.entries.length} completed`}
        </span>
        <span className="wg-plan-count">
          {doneCount}/{item.entries.length}
        </span>
        <ChevronRight size={13} className="wg-row-chev" />
      </div>
      {open && (
        <div className="work-plan-body plan">
          <ul>
            {item.entries.map((e, i) => (
              <li key={i} className={e.status === 'completed' ? 'done' : ''}>
                {e.status === 'completed' ? (
                  <CircleCheck size={14} className="muted" />
                ) : e.status === 'in_progress' ? (
                  <CircleDot size={14} />
                ) : (
                  <Circle size={14} className="muted" />
                )}
                <span>{e.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

/**
 * Borderless collapsible container for consecutive reasoning (`thought`), tool (`tool`),
 * and checklist (`plan`) steps between visible user/agent messages.
 *
 * - Settled: one quiet line, `Worked for 1m 10s · 3 commands, 2 files edited`; live: the brand mark, the
 *   present-tense action and a timer.
 * - Expanded: a flat list, one muted type icon (`StepIcon`) per row; only failures are coloured (`data-step-state`).
 * - Strictly honors `Steps folded / Steps open` (`useExpandSteps`) and per-group manual choices
 *   (`useStepChoice('work:' + firstId)`).
 */
export const WorkGroup = memo(
  function WorkGroup({
    items,
    live,
    onOpenThread,
  }: {
    items: WorkStepItem[];
    live: boolean;
    onOpenThread?: (id: string) => void;
  }) {
    const expandAll = useExpandSteps();
    const firstId = items[0].id;
    const [groupChoice, setGroupChoice] = useStepChoice(`work:${firstId}`);

    const childKeys = useMemo(
      () =>
        items.map((it) =>
          it.kind === 'thought' ? `thought:${it.id}` : it.kind === 'plan' ? `plan:${it.id}` : `tool:${it.id}`,
        ),
      [items],
    );
    const anyChildOpen = useAnyStepOpen(childKeys);
    const isOpen = groupChoice ?? (expandAll || anyChildOpen);

    const pinGroupWhenChildToggled = useCallback(() => {
      if (groupChoice === undefined && isOpen) setGroupChoice(true);
    }, [groupChoice, isOpen, setGroupChoice]);

    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
      if (!live) return;
      setNow(Date.now());
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }, [live]);

    const summary = useMemo(() => summarizeWorkGroup(items), [items]);
    const innerEntries = useMemo(() => (isOpen ? buildInnerEntries(items) : []), [items, isOpen]);

    // What is happening right now, for the live header.
    const activeTool = live
      ? ([...items].reverse().find(
          (it): it is ToolItem => it.kind === 'tool' && (it.status === 'in_progress' || it.status === 'pending'),
        ) ?? undefined)
      : undefined;
    const lastItem = items[items.length - 1];
    const liveElapsed = live ? fmtStepDuration(Math.max(0, now - items[0].ts)) : '';
    const quiet = useQuietMs(stepSignature(lastItem), now, lastItem.kind === 'tool' ? lastItem.endedAt : undefined);
    // The newest tool already finished and nothing came after it: the agent is preparing a step it has not sent.
    const betweenSteps = live && !activeTool && lastItem.kind === 'tool' && quiet >= QUIET_AFTER_MS;
    const liveQuiet = live && !activeTool ? quietLabel(quiet) : '';

    let liveVerb = '';
    let liveKind: StepKind = 'tool';
    let liveTarget = '';
    let liveMono = false;
    if (betweenSteps) {
      liveVerb = 'Working out the next step';
      liveKind = 'think';
    } else if (live) {
      if (activeTool || lastItem.kind === 'tool') {
        const a = describeToolAction((activeTool ?? lastItem) as ToolItem, true);
        liveVerb = a.verb;
        liveKind = a.kind;
        liveTarget = a.target;
        liveMono = a.mono;
      } else if (lastItem.kind === 'thought') {
        liveVerb = 'Thinking';
        liveKind = 'think';
        liveTarget = formatThoughtPreview(lastItem.text, true);
      } else {
        const activePlan = lastItem.entries.find((e) => e.status === 'in_progress') ?? lastItem.entries[0];
        liveVerb = stepVerb('plan', true);
        liveKind = 'plan';
        liveTarget = activePlan ? activePlan.content : '';
      }
    }

    return (
      <div
        className={`tool-group work-group ${live ? 'is-live' : ''} ${summary.failedCount > 0 ? 'has-failed' : ''}`}
        data-testid="work-group"
        data-live={live ? '1' : '0'}
        data-open={isOpen ? '1' : '0'}
      >
        <div
          className="tool-group-head work-group-head"
          data-testid="work-group-head"
          onClick={() => setGroupChoice(!isOpen)}
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setGroupChoice(!isOpen);
            }
          }}
        >
          {live ? (
            <>
              <BrandWorkingMark compact />
              <span className="wg-verb shimmer" data-testid="wg-live-phase" data-step-kind={liveKind}>
                {liveVerb}
              </span>
              <span className={`grow ellipsis wg-target wg-live-detail ${liveMono ? 'mono' : ''}`}>{liveTarget}</span>
              {liveElapsed && (
                <span className="wg-time">
                  {liveElapsed}
                  {liveQuiet ? ` · ${liveQuiet}` : ''}
                </span>
              )}
            </>
          ) : (
            <span className="grow wg-settled-title">
              <span className="wg-headline">{summary.headline}</span>
              {summary.headlineTarget && (
                <span className={`wg-detail wg-single-target ellipsis ${summary.headlineMono ? 'mono' : ''}`}>
                  {summary.headlineTarget}
                </span>
              )}
              {summary.parts.map((p, i) => (
                <span key={p} className="wg-detail wg-part">
                  {i === 0 ? ' · ' : ', '}
                  {p}
                </span>
              ))}
            </span>
          )}
          {summary.failedCount > 0 && <span className="wg-flag failed">{summary.failedCount} failed</span>}
          {!live && summary.stoppedCount > 0 && (
            <span className="wg-flag">{summary.stoppedCount} stopped</span>
          )}
          {isOpen ? <ChevronDown size={14} className="wg-chev" /> : <ChevronRight size={14} className="wg-chev" />}
        </div>

        {isOpen && (
          <div className="tool-group-body work-group-body" data-testid="work-group-body">
            {innerEntries.map((entry, idx) => {
              const isTrailingThought =
                live && idx === innerEntries.length - 1 && entry.kind === 'thought' && !activeTool;
              const stepState = getEntryStepState(entry, isTrailingThought);
              const stepKind = getEntryStepKind(entry);
              const stepKey = entry.kind === 'orch' ? entry.items[0].id : entry.item.id;
              return (
                <div
                  key={stepKey}
                  className={`wg-step wg-step-${stepState}`}
                  data-testid="wg-step"
                  data-step-state={stepState}
                >
                  <span className="wg-step-icon" data-testid="step-icon" data-step-kind={stepKind} aria-hidden="true">
                    <StepIcon kind={stepKind} size={14} />
                  </span>
                  {entry.kind === 'thought' ? (
                    <WorkThoughtRow
                      item={entry.item}
                      streaming={isTrailingThought}
                      durationMs={entry.durationMs}
                      defaultOpen={expandAll}
                      onBeforeToggle={pinGroupWhenChildToggled}
                    />
                  ) : entry.kind === 'plan' ? (
                    <WorkPlanRow
                      item={entry.item}
                      defaultOpen={expandAll}
                      onBeforeToggle={pinGroupWhenChildToggled}
                    />
                  ) : entry.kind === 'orch' ? (
                    <div className="work-orch-wrap">
                      <OrchestrationGroup kind={entry.type} items={entry.items} onOpen={onOpenThread} />
                    </div>
                  ) : (
                    <ToolRow
                      item={entry.item}
                      live={live}
                      defaultOpen={expandAll}
                      onBeforeToggle={pinGroupWhenChildToggled}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.onOpenThread === b.onOpenThread &&
    a.items.length === b.items.length &&
    a.items.every((x, i) => x === b.items[i]),
);
