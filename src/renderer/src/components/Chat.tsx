import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Folder,
  GitBranch,
  History,
  Radio,
  ShieldAlert,
} from 'lucide-react';
import type { AgentDef, AgentStatus, Project, SessionView, Thread, ThreadItem } from '@shared/types';
import { api } from '../api';
import { LinkedText, RefBaseContext, useOpenFile } from '../fileLinks';
import { AgentLogo } from '../logos';
import { useExpandSteps, useStepChoice } from '../prefs';
import { isQuotaMessage } from '../quota';
import type { WorkStepItem } from '../workStepSummary';
import { attachFileListToDraft, AttachmentChips } from './Attachments';
import { ChatComposer } from './ChatComposer';
import { isCompacting } from './CompactButton';
import { Markdown, normalizeMath } from './ChatMarkdown';
import { MessageParts } from './RichContent';
import { openViewer } from './MediaViewer';
import { MsgActions } from './MsgActions';
import { PromptChip, ReplyChip, SessionStatsButton } from './TokenStats';
import { TurnBar } from './TurnChanges';
import { WorkGroup } from './WorkGroup';
import { BackgroundBar, WorkingIndicator } from './Working';
import { ElicitationCard } from './ElicitationCard';
import { CompactionRow, NoticeRow, PlanDocBlock } from './SessionUpdateRows';
import { useStickToBottom } from '../useStickToBottom';
import { SentTicks } from './DeliveryTicks';

export { Markdown, normalizeMath };

const INITIAL_GROUP_WINDOW = 80;
const WINDOW_STEP = 120;

export function Chat(props: {
  thread: Thread;
  project: Project;
  session: SessionView | null;
  agentDef?: AgentDef;
  agentDefs: Record<string, AgentDef>;
  agentStatus?: AgentStatus;
  parentTitle?: string;
  /** Header slots: the agent picker sits on the left, Code mode's panel toggles on the right. */
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  onLogin: () => void;
  onFork: (uptoItemId?: string) => void;
  onOpenThread: (id: string) => void;
  onUsage?: () => void;
  /** Every agent's status, to offer a switch when this one is out of quota. */
  allStatuses?: Record<string, AgentStatus>;
  onSwitchAgent?: (agentId: string) => void;
  /** The "Approve all" pill changed this chat's setting. */
  onAutoApprove?: (on: boolean) => void;
}) {
  const { thread, session, agentDef } = props;
  const [sending, setSending] = useState(false);
  const [paneDrop, setPaneDrop] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const running = session?.status === 'running';
  const { away, jumpToBottom, follow, pause } = useStickToBottom(scroller, inner, thread.id, thread.items);
  const prevBottomRef = useRef<number | null>(null);

  const groups = useMemo(() => groupItems(thread.items), [thread.items]);
  const compacting = useMemo(() => isCompacting(thread.items, running), [thread.items, running]);
  // First group rendered. Fixed when the chat opens and lowered by "Show earlier messages"; new groups are added
  // at the end without dropping old ones from the top, so what the user is reading never shifts under them.
  const [firstShown, setFirstShown] = useState(() => Math.max(0, groups.length - INITIAL_GROUP_WINDOW));
  useEffect(() => {
    setFirstShown(Math.max(0, groupItems(thread.items).length - INITIAL_GROUP_WINDOW));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);
  const startIdx = Math.min(firstShown, Math.max(0, groups.length - 1));

  const handleStickToBottom = follow;

  const loadOlder = useCallback(() => {
    const el = scroller.current;
    pause();
    prevBottomRef.current = el ? el.scrollHeight - el.scrollTop : 0;
    setFirstShown((f) => Math.max(0, f - WINDOW_STEP));
  }, [pause]);

  useLayoutEffect(() => {
    if (prevBottomRef.current === null) return;
    const cur = scroller.current;
    if (cur) cur.scrollTop = Math.max(0, cur.scrollHeight - prevBottomRef.current);
    prevBottomRef.current = null;
  }, [firstShown]);

  const renderedGroups = useMemo(() => {
    let turnUser: UserItem | undefined;
    for (let i = 0; i < startIdx; i++) {
      const g = groups[i];
      if (startsTurn(g)) turnUser = g.item;
    }
    const out: React.ReactNode[] = [];
    for (let i = startIdx; i < groups.length; i++) {
      const g = groups[i];
      if (startsTurn(g)) turnUser = g.item;
      const next = groups[i + 1];
      const turnEnds = next ? startsTurn(next) : !running;
      const isLast = i === groups.length - 1;
      if (g.kind === 'work') {
        const isLiveWork = Boolean(running && isLast);
        out.push(
          <WorkGroup
            key={g.items[0].id}
            items={g.items}
            live={isLiveWork}
            onOpenThread={props.onOpenThread}
          />,
        );
      } else {
        out.push(
          <Item
            key={g.item.id}
            item={g.item}
            threadId={thread.id}
            agentDefs={props.agentDefs}
            onFork={props.onFork}
          />,
        );
      }
      if (turnEnds && turnUser?.checkpoint?.files) {
        out.push(<TurnBar key={`turn-${turnUser.id}`} threadId={thread.id} item={turnUser} />);
      }
    }
    return out;
  }, [groups, startIdx, running, thread.id, props.agentDefs, props.onFork, props.onOpenThread]);

  const lastGroup = groups[groups.length - 1];
  const hasLiveWorkGroup = Boolean(running && lastGroup?.kind === 'work');

  return (
    <RefBaseContext.Provider value={props.project.path}>
      <div className="main-head">
        {props.headerLeft}
        <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <span className="title ellipsis">{thread.title}</span>
          {thread.parentId ? (
            <span className="small muted ellipsis link-like" onClick={() => props.onOpenThread(thread.parentId!)} title="Open parent chat">
              <CornerLeftUp size={11} /> Sub-session of: {props.parentTitle ?? 'parent chat'}
            </span>
          ) : (
            <span className="head-sub ellipsis" title={props.project.path}>
              <Folder size={12} /> {props.project.id === 'general' ? 'General chat' : props.project.name}
            </span>
          )}
        </div>
        <SessionStatsButton thread={thread} usage={session?.usage} agentDefs={props.agentDefs} />
        <button className="btn ghost icon head-fork-btn" title="Fork: start a new sub-session from this whole chat" onClick={() => props.onFork()}>
          <GitBranch size={16} />
        </button>
        {props.headerRight}
      </div>

      <div
        className={`chat-scroll ${paneDrop ? 'pane-dragging' : ''}`}
        ref={scroller}
        tabIndex={-1}
        data-testid="chat-scroll"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setPaneDrop(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaneDrop(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setPaneDrop(false);
          void attachFileListToDraft(thread.id, [...e.dataTransfer.files]).catch(() => {});
        }}
      >
        {paneDrop && (
          <div className="chat-drop-overlay" data-testid="chat-drop-overlay">
            Drop images, videos, PDFs, docs, or code to attach
          </div>
        )}
        <div className="chat-inner" ref={inner}>
          {!thread.items.length && (
            <div className="muted" style={{ textAlign: 'center', marginTop: '18vh' }}>
              {agentDef && <AgentLogo def={agentDef} size={44} />}
              <p>
                Chat with <b>{agentDef?.name}</b>. You can switch agents anytime from the dropdown at the top left —
                <br />
                the new agent reads the earlier conversation and the shared memory.
              </p>
            </div>
          )}
          {startIdx > 0 && (
            <div className="chat-older-wrap">
              <button className="btn ghost small chat-load-older" onClick={loadOlder} data-testid="load-older">
                <History size={13} /> Show earlier messages ({startIdx} older step{startIdx === 1 ? '' : 's'})
              </button>
            </div>
          )}
          {renderedGroups}
          {running || sending ? (
            hasLiveWorkGroup ? null : (
              <WorkingIndicator items={thread.items} agentName={agentDef?.name ?? 'the agent'} />
            )
          ) : (
            <BackgroundBar threadId={thread.id} />
          )}
        </div>
        {away && (
          <div className="jump-latest-wrap">
            <button
              type="button"
              className={`btn small jump-latest ${running ? 'is-live' : ''}`}
              onClick={jumpToBottom}
              data-testid="jump-latest"
              title={running ? 'Scroll to the live response and keep following' : 'Scroll to the newest message'}
            >
              <ArrowDown size={14} />
              <span>{running ? 'Follow live response' : 'Jump to latest'}</span>
            </button>
          </div>
        )}
      </div>

      <ChatComposer
        threadId={thread.id}
        agentId={thread.agentId}
        autoApprove={thread.autoApprove}
        session={session}
        compacting={compacting}
        agentDef={agentDef}
        agentDefs={props.agentDefs}
        agentStatus={props.agentStatus}
        allStatuses={props.allStatuses}
        onLogin={props.onLogin}
        onUsage={props.onUsage}
        onSwitchAgent={props.onSwitchAgent}
        onAutoApprove={props.onAutoApprove}
        onSendingChange={setSending}
        onStickToBottom={handleStickToBottom}
      />
    </RefBaseContext.Provider>
  );
}

type UserItem = Extract<ThreadItem, { kind: 'user' }>;
type VisibleItem = Exclude<ThreadItem, WorkStepItem>;
type Group =
  | { kind: 'work'; items: WorkStepItem[] }
  | { kind: 'item'; item: VisibleItem };

/** A message that starts a turn: one sent from Olympus (a user message from the agent's own session sits inside a turn). */
const startsTurn = (g: Group): g is { kind: 'item'; item: UserItem } => g.kind === 'item' && g.item.kind === 'user' && !g.item.viaAgent;

/**
 * Collects all consecutive non-message work steps (`thought`, `tool`, and `plan`) between
 * visible messages (`user`, `agent`, `permission`, `error`, `switch`) into one collapsible
 * `WorkGroup` so reasoning and tool calls never flood the chat window.
 */
function groupItems(items: ThreadItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    // A plan the agent withdrew (`plan_removed`) is no longer shown.
    if ((it.kind === 'plan' || it.kind === 'plan-doc') && it.removed) continue;
    if (it.kind === 'thought' || it.kind === 'tool' || it.kind === 'plan') {
      const last = out[out.length - 1];
      if (last?.kind === 'work') last.items.push(it);
      else out.push({ kind: 'work', items: [it] });
    } else {
      out.push({ kind: 'item', item: it });
    }
  }
  return out;
}

const NOOP_FORK = () => {};

/** A chat's messages, read-only: the Tasks panel uses it to show a sub-session's work live. */
export function Transcript({ thread, agentDefs, running }: { thread: Thread; agentDefs: Record<string, AgentDef>; running: boolean }) {
  const groups = useMemo(() => groupItems(thread.items), [thread.items]);
  const shown = groups.length > INITIAL_GROUP_WINDOW ? groups.slice(groups.length - INITIAL_GROUP_WINDOW) : groups;
  return (
    <div className="transcript compact">
      {shown.map((g, i, all) => {
        if (g.kind === 'work') {
          const isLiveWork = Boolean(running && i === all.length - 1);
          return <WorkGroup key={g.items[0].id} items={g.items} live={isLiveWork} />;
        }
        return <Item key={g.item.id} item={g.item} threadId={thread.id} agentDefs={agentDefs} onFork={NOOP_FORK} compact />;
      })}
    </div>
  );
}

const Item = memo(function Item({
  item,
  threadId,
  agentDefs,
  onFork,
  compact,
}: {
  item: VisibleItem;
  threadId: string;
  agentDefs: Record<string, AgentDef>;
  onFork: (uptoItemId?: string) => void;
  compact?: boolean;
}) {
  const def = agentDefs[item.kind === 'switch' ? item.to : item.agentId];
  const openFile = useOpenFile();
  switch (item.kind) {
    case 'user': {
      const from = item.fromAgent ? agentDefs[item.fromAgent] : undefined;
      return (
        <div className={`col msg-wrap ${item.viaAgent ? 'msg-via-agent' : ''}`} style={{ alignItems: 'flex-end', gap: 3 }} data-testid={item.viaAgent ? 'msg-via-agent' : undefined}>
          {item.viaAgent && (
            <span className="small muted row msg-from" style={{ gap: 4 }} title="This message reached the agent from its own session (another app on that session, or replayed by the agent), not from Olympus Coder">
              <Radio size={13} /> From the agent session
            </span>
          )}
          {item.fromApp && (
            <span className="small muted row msg-from" style={{ gap: 4 }} title="Sent automatically by Olympus Coder, not by you">
              <Bot size={13} /> Olympus Coder · automatic message
            </span>
          )}
          {item.fromAgent && (
            <span className="small muted row msg-from" style={{ gap: 4 }} title="The main session's agent (the orchestrator) wrote this message">
              {from && <AgentLogo def={from} size={14} />} Task from {from?.name ?? item.fromAgent} · orchestrator
            </span>
          )}
          {item.attachments?.length ? <AttachmentChips files={item.attachments} inlinePlay addable onOpen={(a, el) => openViewer({ ref: a.path, from: el, name: a.name, mime: a.mime, openInPanel: openFile })} /> : null}
          {item.text &&
            (compact && item.text.length > 600 ? (
              <Collapsible
                stepKey={`user:${item.id}`}
                label={`${item.text.slice(0, 140).replace(/\s+/g, ' ')}…`}
                body={
                  <div className="msg-user">
                    <LinkedText text={item.text} />
                  </div>
                }
              />
            ) : (
              <div className="msg-user">
                <LinkedText text={item.text} />
              </div>
            ))}
          <div className="row msg-foot" style={{ gap: 6 }}>
            {item.usage && <PromptChip usage={item.usage} />}
            {item.contextAttached && (
              <span className="small muted row" style={{ gap: 4 }} title="Shared memory (and the earlier conversation, if any) was sent to the agent with this message">
                <Brain size={12} /> shared context attached
              </span>
            )}
            {!compact && <MsgActions text={item.text} attachments={item.attachments} onFork={() => onFork(item.id)} align="end" secondOpinion={{ threadId, itemId: item.id, agentId: item.agentId, agentDefs }} />}
            <SentTicks delivery={item.delivery} agentName={def?.name ?? item.agentId} />
          </div>
        </div>
      );
    }
    case 'agent':
      return (
        <div className="msg-wrap">
          <div className="msg-meta">
            {def && <AgentLogo def={def} />} {def?.name}
          </div>
          {isQuotaMessage(item.text) ? (
            <div className="notice-card">
              <AlertTriangle size={16} />
              <span>{item.text.replace(/^[\s⚠️]+/, '').trim()}</span>
            </div>
          ) : (
            <div className="msg-agent">
              {item.parts ? <MessageParts parts={item.parts} /> : <Markdown text={item.text} />}
            </div>
          )}
          <div className="row msg-foot" style={{ gap: 6 }}>
            {item.usage && !isQuotaMessage(item.text) && <ReplyChip usage={item.usage} />}
            {!compact && <MsgActions text={item.text} onFork={() => onFork(item.id)} align="start" />}
          </div>
        </div>
      );
    case 'switch': {
      const from = agentDefs[item.from];
      return (
        <div className="switch-line">
          <span>
            {from && <AgentLogo def={from} size={16} />} {from?.name ?? item.from} <ArrowRight size={12} /> {def && <AgentLogo def={def} size={16} />} {def?.name ?? item.to}
          </span>
        </div>
      );
    }
    case 'error':
      return <div className="err-box">{item.text}</div>;
    case 'notice':
      return <NoticeRow item={item} />;
    case 'compaction':
      return <CompactionRow item={item} />;
    case 'plan-doc':
      return <PlanDocBlock item={item} agentName={def?.name} />;
    case 'permission':
      return (
        <div className="perm">
          <div className="row" style={{ marginBottom: 8 }}>
            <ShieldAlert size={16} />
            <b className="grow">{def?.name} is asking for permission</b>
          </div>
          <div className="perm-title">{item.title}</div>
          {item.resolved ? (
            <span className="chip">{item.resolved}</span>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {item.options.map((o) => (
                <button key={o.optionId} className={`btn small ${o.kind.startsWith('allow') ? 'primary' : ''}`} onClick={() => void api.permission(threadId, item.id, o.optionId)}>
                  {o.name}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case 'elicitation':
      return <ElicitationCard item={item} threadId={threadId} agentName={def?.name ?? 'The agent'} />;
  }
});

/**
 * A collapsible block (used for long compact prompts in `Transcript`). With `follow`, it opens by itself
 * only when the user's "Steps open" preference is enabled; any manual click overrides and persists.
 */
function Collapsible({
  stepKey,
  label,
  body,
  icon,
  follow,
}: {
  stepKey: string;
  label: React.ReactNode;
  body: React.ReactNode;
  icon?: React.ReactNode;
  follow?: boolean;
}) {
  const expandAll = useExpandSteps();
  const [choice, setChoice] = useStepChoice(stepKey);
  const open = choice ?? (follow ? expandAll : false);
  return (
    <div className="msg-wrap">
      <button className="btn ghost small muted collapse-head" onClick={() => setChoice(!open)} style={{ paddingLeft: 4 }}>
        {icon} {label} {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && body}
    </div>
  );
}
