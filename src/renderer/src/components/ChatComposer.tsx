import { memo, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type { AgentDef, AgentStatus, SessionView } from '@shared/types';
import { api } from '../api';
import { useDraft } from '../drafts';
import { useOpenFile } from '../fileLinks';
import { setExpandSteps, useExpandSteps } from '../prefs';
import { promptQueueApi, usePromptQueue } from '../promptQueueApi';
import { quotaState } from '../quota';
import { AttachButton, AttachmentChips, useAttachments } from './Attachments';
import { CompactButton } from './CompactButton';
import { ConfigPill } from './ConfigPills';
import { QueuedMessages } from './QueuedMessages';
import { useSlashMenu } from './SlashMenu';
import { SwitchAgents } from './SwitchAgents';
import { estimateTokens } from './TokenStats';
import { ContextMeter, fmtReset, LimitsFreshness } from './Usage';

const NO_COMMANDS: SessionView['commands'] = [];

export interface ChatComposerProps {
  threadId: string;
  agentId: string;
  autoApprove?: boolean;
  session: SessionView | null;
  /** The agent is compacting this chat's context (`isCompacting` over the thread's items). */
  compacting?: boolean;
  agentDef?: AgentDef;
  agentDefs: Record<string, AgentDef>;
  agentStatus?: AgentStatus;
  allStatuses?: Record<string, AgentStatus>;
  onLogin: () => void;
  onUsage?: () => void;
  onSwitchAgent?: (agentId: string) => void;
  onAutoApprove?: (on: boolean) => void;
  onSendingChange: (sending: boolean) => void;
  onStickToBottom: () => void;
}

/**
 * Isolated chat composer: owns the `<textarea>` draft state, attachments, height auto-sizing, and config pills
 * so typing in the composer never triggers React reconciliation over the message/tool list above it.
 */
export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const { threadId, agentId, autoApprove, session, agentDef } = props;
  const { text, setText, clear: clearThreadDraft } = useDraft(threadId);
  const openFile = useOpenFile();
  const expandSteps = useExpandSteps();
  const ta = useRef<HTMLTextAreaElement>(null);
  const att = useAttachments(threadId);
  const running = session?.status === 'running';
  const needsLogin = session?.status === 'needs-login' || props.agentStatus?.state === 'needs-login';
  // The long "queued" hint doesn't fit a narrow composer (phones, a narrow window): a short one there.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ta.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 460));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const slash = useSlashMenu({ text, setText, commands: session?.commands ?? NO_COMMANDS, ta });
  const queue = usePromptQueue(threadId);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [threadId]);

  // Text sent here from elsewhere in the app (e.g. "Ask agent to fix" on a terminal error): into the box, not sent.
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<{ text: string }>).detail.text;
      setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${t}` : t));
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        el.scrollTop = el.scrollHeight;
      });
    };
    window.addEventListener('olympus:compose', on);
    return () => window.removeEventListener('olympus:compose', on);
  }, [setText]);

  // Always sendable: while the agent works (or is offline) the message waits in the chat's queue, with ticks.
  const canSend = Boolean(text.trim() || att.files.length);
  async function send() {
    if (!canSend) return;
    const t = text.trim();
    const files = att.files;
    clearThreadDraft();
    props.onStickToBottom();
    props.onSendingChange(true);
    try {
      await promptQueueApi.submit(threadId, t, files);
    } finally {
      props.onSendingChange(false);
    }
  }

  const model = session?.configOptions.find((o) => o.category === 'model')?.currentValue;
  const q = quotaState(props.agentStatus, model);

  return (
    <div className="composer-wrap">
      {q.out && !needsLogin && (() => {
        const others = Object.values(props.agentDefs).filter(
          (d) =>
            d.id !== agentId &&
            !['not-installed', 'error', 'needs-login'].includes(props.allStatuses?.[d.id]?.state ?? 'unknown') &&
            !quotaState(props.allStatuses?.[d.id]).out,
        );
        return (
          <div className="banner quota-banner">
            <AlertTriangle size={17} />
            <span className="quota-text">
              <b>{agentDef?.name} is out of quota</b>
              {q.limits[0] ? ` (${q.limits.map((l) => l.label).join(', ')})` : ''}
              {q.resetsAt ? ` — ${fmtReset(q.resetsAt)}, at ${new Date(q.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '.'}
              {q.otherGroupsLeft.length ? ` ${q.otherGroupsLeft.join(', ')} models still work — change the model below.` : ''}
              <LimitsFreshness status={props.agentStatus} agentName={agentDef?.name} />
            </span>
            <SwitchAgents agents={others} statuses={props.allStatuses ?? {}} onSwitch={(id) => props.onSwitchAgent?.(id)} />
          </div>
        );
      })()}
      {needsLogin && (
        <div className="banner">
          <ShieldAlert size={17} />
          <span className="grow">
            {agentDef?.name} needs you to log in.
            {session?.error && <span className="muted small"> ({session.error})</span>}
          </span>
          <button className="btn small primary" onClick={props.onLogin}>
            Login
          </button>
        </div>
      )}
      {session?.status === 'error' && session.error && (
        <div className="banner" style={{ borderColor: 'var(--danger)' }}>
          <span className="grow small" style={{ whiteSpace: 'pre-wrap' }}>
            {session.error}
          </span>
          <button className="btn small" onClick={props.onLogin}>
            Login
          </button>
          <button className="btn small" onClick={() => void api.ensureSession(threadId)}>
            Retry
          </button>
        </div>
      )}
      <QueuedMessages threadId={threadId} queue={queue} />
      <div className={`composer ${att.dragging ? 'dragging' : ''}`} {...att.dropProps}>
        {slash.menu}
        <AttachmentChips files={att.files} onRemove={att.remove} onOpen={(a) => openFile(a.path)} />
        <div className="growable-textarea" data-replicated-value={text}>
          <textarea
            ref={ta}
            rows={1}
            spellCheck={false}
            value={text}
            placeholder={running ? (narrow ? 'Queue a message…' : `Message ${agentDef?.name ?? 'Agent'} — it gets it when this reply ends…`) : `Message ${agentDef?.name ?? 'Agent'}…`}
            title="Enter = send · Shift+Enter = new line · ⌘V = paste screenshot"
            onChange={(e) => setText(e.target.value)}
            onPaste={att.onPaste}
            {...slash.textareaProps}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            data-testid="composer"
          />
          {slash.ghost}
        </div>
        <div className="composer-bar">
          <AttachButton onClick={() => void att.pick()} onFiles={att.addRawFiles} />
          {att.error && <span className="error-text small ellipsis">{att.error}</span>}
          <div className="spacer" />
          {session?.status === 'starting' && (
            <span className="small muted row" style={{ gap: 4 }}>
              <Loader2 size={13} className="spin" /> connecting…
            </span>
          )}
          {text.trim() && (
            <span className="type-estimate" title="Estimate for the message you typed (≈4 characters = 1 token). The exact count appears under the message after you send it.">
              ≈ {estimateTokens(text).toLocaleString()} tokens
            </span>
          )}
          <CompactButton threadId={threadId} session={session} compacting={Boolean(props.compacting)} queue={queue} variant="chip" />
          <ContextMeter usage={session?.usage} onClick={props.onUsage} />
          <div className="composer-send">
            {running && (
              <button className="btn small stop-btn" onClick={() => void api.cancel(threadId)} title="Stop the current reply" data-testid="stop">
                <Square size={12} fill="currentColor" /> Stop
              </button>
            )}
            <button
              className="btn primary icon send-btn"
              disabled={!canSend}
              onClick={() => void send()}
              title={running ? 'Queue — sent when the current reply ends' : 'Send'}
              data-testid="send"
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
        {att.dragging && <div className="drop-hint">Drop files here</div>}
      </div>
      <div className="composer-pills">
        <button
          className={`pill-toggle ${autoApprove ? 'on' : ''}`}
          title={
            autoApprove
              ? 'Every permission request in this chat is approved automatically. Click to ask again.'
              : "Approve every permission request in this chat automatically (like the agent's bypass mode). New chats with this agent start the same way."
          }
          onClick={() => void api.setAutoApprove(threadId, !autoApprove).then((on) => props.onAutoApprove?.(on))}
          data-testid="approve-all"
        >
          {autoApprove ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />} {autoApprove ? 'Approve all' : 'Ask first'}
        </button>
        <button
          className={`pill-toggle ${expandSteps ? 'on' : ''}`}
          title={expandSteps ? 'Thinking and tool steps open by themselves. Click to keep them folded.' : 'Thinking and tool steps stay folded until you click them. Click to have them open by themselves.'}
          onClick={() => setExpandSteps(!expandSteps)}
          data-testid="expand-steps"
        >
          {expandSteps ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />} {expandSteps ? 'Steps open' : 'Steps folded'}
        </button>
        {(session?.configOptions ?? []).map((o) => (
          <ConfigPill key={o.id} option={o} disabled={running} onChange={(v) => void api.setConfig(threadId, o.id, v)} />
        ))}
      </div>
    </div>
  );
});
