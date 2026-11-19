import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { CACHE_COLD_AFTER_MS } from '@shared/freshCarryover';
import type { SessionView, ThreadItem } from '@shared/types';
import { api } from '../api';
import { contextFraction, contextLevel } from '../contextLevel';
import { fmtTokens } from './Usage';

type ContextResetItem = Extract<ThreadItem, { kind: 'context-reset' }>;

/** Clean inline timeline divider inserted when the user starts a fresh context in the same chat. */
export function ContextResetRow({ item }: { item: ContextResetItem }) {
  return (
    <div className="switch-line" data-testid="context-reset-line">
      <span>
        <RotateCcw size={12} /> Fresh context started
        {item.previousUsed ? ` (${fmtTokens(item.previousUsed)} → ~${fmtTokens(item.estimatedCarryover ?? 3000)} tokens)` : ''}
        {item.editedFilesCount ? ` · ${item.editedFilesCount} ${item.editedFilesCount === 1 ? 'file' : 'files'} carried over` : ''}
      </span>
    </div>
  );
}

/**
 * Universal 1-click "Fresh context" action for ALL 18+ ACP agents.
 * Closes the bloated agent session and starts a clean session in the exact same chat thread
 * with a compact (~2k-4k token) carryover brief — $0 extra LLM cost, 100% chat history & Undo preserved.
 */
export function FreshContextButton(props: {
  threadId: string;
  session: SessionView | null | undefined;
  /** True when the chat has at least one completed/sent user or agent message. */
  hasHistory: boolean;
  /** Timestamp of the last user/agent message, used to hint when cloud prompt cache is already cold (>5 min). */
  lastTurnTs?: number;
  /** True when `CompactButton` is already displaying a red-level notice in this same container. */
  hasCompactNotice?: boolean;
  /** When true (Code mode composer), stay hidden at green and surface the 1-click chip only at yellow/red (>50%). */
  onlyWhenElevated?: boolean;
  variant: 'full' | 'chip';
}) {
  const { threadId, session, hasHistory, lastTurnTs = 0, hasCompactNotice = false, onlyWhenElevated = false, variant } = props;
  const [resetting, setResetting] = useState(false);

  if (!hasHistory) return null;

  const running = session?.status === 'running';
  const busy = resetting || running;
  const fill = contextFraction(session?.usage);
  const lvl = contextLevel(fill ?? 0);
  if (variant === 'chip' && onlyWhenElevated && lvl === 'green' && !resetting) return null;
  const cacheCold = lastTurnTs > 0 && Date.now() - lastTurnTs >= CACHE_COLD_AFTER_MS;

  const baseTip =
    'Start a fresh agent session in this same chat with a compact carryover brief (~2k–4k tokens, $0 extra cost). Chat history and Undo checkpoints stay intact.';
  const tip = running
    ? 'Wait for the current reply to finish before starting a fresh context.'
    : cacheCold
      ? `${baseTip} Prompt cache already expired (>5m idle) — resetting now has zero cache penalty.`
      : baseTip;

  const click = () => {
    if (busy) return;
    setResetting(true);
    void api.resetContext(threadId).catch(() => {}).finally(() => setResetting(false));
  };

  const icon = resetting ? <Loader2 size={variant === 'full' ? 14 : 13} className="spin" /> : <RotateCcw size={variant === 'full' ? 14 : 13} />;

  if (variant === 'full') {
    return (
      <>
        <button
          type="button"
          className={`btn small compact-btn ctx-${lvl}`}
          disabled={busy}
          title={tip}
          onClick={click}
          data-testid="fresh-context-btn"
          data-level={lvl}
        >
          {icon} {resetting ? 'Resetting…' : 'Fresh context'}
        </button>
        {lvl === 'red' && fill !== null && !busy && !hasCompactNotice && (
          <div className="compact-notice" role="status" data-testid="fresh-context-notice">
            <span>Context is {Math.round(fill * 100)}% full. Start a fresh context to drop old tool dumps while keeping this chat.</span>
            <button type="button" className="link-btn" onClick={click} data-testid="fresh-context-notice-action">
              Fresh context
            </button>
          </div>
        )}
      </>
    );
  }

  const showLabel = lvl !== 'green' || resetting;
  return (
    <button
      type="button"
      className={`compact-chip ctx-${lvl} ${showLabel ? 'labelled' : ''}`}
      disabled={busy}
      title={tip}
      aria-label="Fresh context"
      onClick={click}
      data-testid="fresh-context-chip"
      data-level={lvl}
    >
      {icon}
      {showLabel && <span>{resetting ? 'Resetting…' : 'Fresh context'}</span>}
    </button>
  );
}
