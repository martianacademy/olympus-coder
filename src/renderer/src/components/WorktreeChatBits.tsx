import { useEffect, useState } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import type { ThreadWorktree } from '@shared/types';
import { api } from '../api';
import { cleanError, hasWorkToMerge, worktreeTip, WORKTREE_STATUS_EVENT } from '../worktreeUi';
import type { WorktreeStatusView } from '@shared/types';
import '../worktree.css';

/** Chat header: "⑂ <branch>" for a chat that runs in its own git worktree. Click opens the Info panel's Worktree section. */
export function WorktreeChip(props: { worktree: ThreadWorktree; onOpen?: () => void }) {
  const tip = worktreeTip(props.worktree);
  return (
    <button
      type="button"
      className="wt-chip"
      title={tip}
      aria-label={`Worktree branch ${props.worktree.branch}`}
      data-testid="worktree-chip"
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen?.();
      }}
    >
      <GitBranch size={11} />
      <span>{props.worktree.branch}</span>
    </button>
  );
}

const TOGGLE_TIP = 'Run this chat in its own git worktree and branch, so it never touches your working tree until you merge';

/**
 * True while a worktree chat is still fresh: never merged, no commits ahead, nothing uncommitted (asked from
 * `worktree.status` on mount and when the tab comes back). `undefined` until known. Always true without a worktree.
 */
function useFreshWorktree(threadId: string, worktree: ThreadWorktree | undefined): boolean | undefined {
  const [fresh, setFresh] = useState<boolean | undefined>(worktree ? undefined : true);
  const merged = Boolean(worktree?.mergedAt);
  const path = worktree?.path;
  useEffect(() => {
    if (!path) return setFresh(true);
    if (merged) return setFresh(false);
    let live = true;
    const check = () =>
      void api.worktree
        .status(threadId)
        .then((s) => live && setFresh(Boolean(s?.exists) && !hasWorkToMerge(s!)))
        .catch(() => live && setFresh(false));
    setFresh(undefined);
    check();
    const onVis = () => document.visibilityState === 'visible' && check();
    // Each status the Info panel's Worktree section loads (after turns, refresh, merges) also updates this.
    const onStatus = (e: Event) => {
      const d = (e as CustomEvent<{ threadId: string; status: WorktreeStatusView | null }>).detail;
      if (d?.threadId === threadId && live) setFresh(Boolean(d.status?.exists) && !hasWorkToMerge(d.status!));
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener(WORKTREE_STATUS_EVENT, onStatus);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener(WORKTREE_STATUS_EVENT, onStatus);
    };
  }, [threadId, path, merged]);
  return fresh;
}

/**
 * Empty code chat: "Worktree  Off | Isolated". Off by default. Switching replaces the still-empty chat with a new
 * one created with (or without) a worktree; a failure (e.g. not a git repository) shows inline and changes nothing.
 * Hidden on a worktree chat that has any history (merged, commits ahead or uncommitted files): switching it off
 * would replace that chat, so it shows only while the worktree is truly fresh.
 */
export function WorktreeToggle(props: { threadId: string; worktree?: ThreadWorktree; onChange: (on: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fresh = useFreshWorktree(props.threadId, props.worktree);
  const on = Boolean(props.worktree);
  if (!fresh) return null;
  const pick = async (next: boolean) => {
    if (busy || next === on) return;
    setBusy(true);
    setError('');
    try {
      await props.onChange(next);
    } catch (e) {
      setError(cleanError(e));
      setBusy(false);
    }
  };
  return (
    <div className="wt-toggle" data-testid="worktree-toggle">
      <span className="wt-toggle-label" title={TOGGLE_TIP}>
        Worktree
      </span>
      <div className="seg" title={TOGGLE_TIP}>
        <button type="button" className={!on ? 'active' : ''} disabled={busy} onClick={() => void pick(false)} data-testid="worktree-toggle-off">
          Off
        </button>
        <button type="button" className={on ? 'active' : ''} disabled={busy} onClick={() => void pick(true)} data-testid="worktree-toggle-on">
          {busy && !on ? <Loader2 size={11} className="spin" /> : null} Isolated
        </button>
      </div>
      {error && <div className="small error-text wt-toggle-error" data-testid="worktree-toggle-error">{error}</div>}
    </div>
  );
}
