import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, GitMerge, Loader2, RotateCw, Trash2 } from 'lucide-react';
import type { Thread, WorktreeMergeResult, WorktreeStatusView } from '@shared/types';
import { api } from '../api';
import { cleanError, hasWorkToMerge, resolveConflictsPrompt, worktreeCounts, WORKTREE_STATUS_EVENT } from '../worktreeUi';
import '../worktree.css';

type Busy = 'merge' | 'squash' | 'remove' | null;

/**
 * Info panel → "Worktree": the chat's isolated branch against its base (ahead / behind / uncommitted), the files it
 * changed, and Squash / Merge into the base branch or Remove the worktree. Merges auto-commit dirty files first;
 * on conflicts the merge is aborted and the files are listed with "Ask the agent to resolve".
 */
export function WorktreeSection(props: {
  thread: Thread;
  /** True while the agent's turn runs: the status refreshes when it ends. */
  running: boolean;
  refreshKey: number;
  onOpenFile: (path: string) => void;
  /** The thread changed on disk (worktree removed): reload it. */
  onThreadChanged?: () => void;
}) {
  const wt = props.thread.worktree;
  const [status, setStatus] = useState<WorktreeStatusView | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [result, setResult] = useState<WorktreeMergeResult | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [asked, setAsked] = useState(false);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const load = useCallback(() => {
    setLoadError('');
    api.worktree
      .status(props.thread.id)
      .then((s) => {
        window.dispatchEvent(new CustomEvent(WORKTREE_STATUS_EVENT, { detail: { threadId: props.thread.id, status: s } }));
        if (live.current) setStatus(s);
      })
      .catch((e) => {
        if (!live.current) return;
        setStatus(null);
        setLoadError(cleanError(e));
      });
  }, [props.thread.id]);

  // On open, after every turn (running → idle) and whenever the workbench refreshes.
  useEffect(() => {
    if (!props.running) load();
  }, [load, props.running, props.refreshKey]);

  if (!wt) return null;
  const base = status?.baseBranch ?? wt.baseBranch;
  const branch = status?.branch ?? wt.branch;

  async function merge(mode: 'merge' | 'squash') {
    setBusy(mode);
    setError('');
    setNotice('');
    setResult(null);
    setAsked(false);
    try {
      const r = await api.worktree.merge(props.thread.id, mode);
      if (!live.current) return;
      setResult(r);
      if (r.ok) setNotice(`${mode === 'squash' ? 'Squashed' : 'Merged'} into ${base}${r.commitSha ? ` as ${r.commitSha.slice(0, 7)}` : ''}. The worktree stays, so the chat can keep working.`);
      else if (!r.conflicts?.length) setError(r.error ?? `The ${mode} did not finish.`);
    } catch (e) {
      if (live.current) setError(cleanError(e));
    } finally {
      if (live.current) {
        setBusy(null);
        load();
      }
    }
  }

  async function remove() {
    setBusy('remove');
    setError('');
    setNotice('');
    try {
      const r = await api.worktree.remove(props.thread.id);
      if (!live.current) return;
      if (!r.ok) {
        setError(r.error ?? 'The worktree could not be removed.');
        return;
      }
      setConfirmRemove(false);
      props.onThreadChanged?.();
    } catch (e) {
      if (live.current) setError(cleanError(e));
    } finally {
      if (live.current) setBusy(null);
    }
  }

  async function askToResolve(r: WorktreeMergeResult) {
    setError('');
    try {
      await api.send(props.thread.id, resolveConflictsPrompt({ branch, baseBranch: base, conflicts: r.conflicts ?? [], mode: r.mode }));
      if (live.current) setAsked(true);
    } catch (e) {
      if (live.current) setError(cleanError(e));
    }
  }

  const missing = status ? !status.exists : false;
  const files = status?.changedFiles ?? [];
  const canMerge = Boolean(status?.exists && hasWorkToMerge(status));
  const conflicts = result && !result.ok && result.conflicts?.length ? result.conflicts : null;

  return (
    <div className="info-section wt-section" data-testid="worktree-section">
      <div className="info-title row" style={{ gap: 6, alignItems: 'center' }}>
        <span className="grow">Worktree</span>
        <button className="btn ghost icon" title="Refresh worktree status" aria-label="Refresh worktree status" data-testid="worktree-refresh" onClick={load} disabled={busy !== null}>
          <RotateCw size={12} />
        </button>
      </div>

      <div className="wt-branch-line" title={`${status?.path ?? wt.path}\nBranched from ${base} at ${wt.baseCommit.slice(0, 7)}`}>
        <span className="mono ellipsis wt-branch" data-testid="worktree-branch">{branch}</span>
        <span className="muted wt-arrow">→</span>
        <span className="mono ellipsis wt-base">{base}</span>
      </div>
      <div className="small muted wt-counts" data-testid="worktree-counts">
        {status === undefined ? 'Checking…' : status === null ? loadError || 'Status unavailable.' : missing ? 'The worktree folder is missing.' : worktreeCounts(status)}
      </div>

      {files.length > 0 && (
        <>
          <button className="wt-disclosure" onClick={() => setFilesOpen((o) => !o)} aria-expanded={filesOpen} data-testid="worktree-files-toggle">
            {filesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Changed files <span className="info-count">{files.length}</span>
          </button>
          {filesOpen && (
            <div className="info-files" data-testid="worktree-files">
              {files.map((p) => (
                <button key={p} className="info-file" onClick={() => props.onOpenFile(p)} title={p}>
                  <FileCode size={14} className="info-file-icon" />
                  <span className="info-file-name ellipsis">{p.split('/').pop()}</span>
                  <span className="info-file-dir ellipsis">{p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {conflicts && (
        <div className="wt-conflicts" data-testid="worktree-conflicts">
          <div className="small">
            The {result!.mode} stopped on conflicts and was undone. {base} is unchanged.
          </div>
          <ul className="wt-conflict-list mono small">
            {conflicts.map((f) => (
              <li key={f} className="ellipsis" title={f}>
                {f}
              </li>
            ))}
          </ul>
          {asked ? (
            <div className="small muted">Asked the agent to rebase and resolve them in this chat.</div>
          ) : (
            <button className="btn small" onClick={() => void askToResolve(result!)} data-testid="worktree-ask-resolve" title={`Send a message asking the agent to rebase ${branch} onto ${base}, resolve these files, run checks and commit`}>
              Ask the agent to resolve
            </button>
          )}
        </div>
      )}

      {notice && <div className="small wt-notice" data-testid="worktree-notice">{notice}</div>}
      {error && <div className="small error-text">{error}</div>}

      {confirmRemove ? (
        <div className="wt-confirm" data-testid="worktree-remove-confirm">
          <div className="small">
            Remove the worktree folder? Uncommitted files are committed first, and unmerged work stays on the branch <span className="mono">{branch}</span>. The chat
            then works in the project folder.
          </div>
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn small ghost" onClick={() => setConfirmRemove(false)} disabled={busy !== null}>
              Keep
            </button>
            <button className="btn small danger" onClick={() => void remove()} disabled={busy !== null} data-testid="worktree-remove-yes">
              {busy === 'remove' && <Loader2 size={12} className="spin" />} Remove worktree
            </button>
          </div>
        </div>
      ) : (
        <div className="wt-actions">
          <button
            className="btn small"
            onClick={() => void merge('squash')}
            disabled={busy !== null || !canMerge}
            title={canMerge ? `Commit any uncommitted files, then add all of this branch's changes to ${base} as one commit` : `Nothing to bring into ${base} yet`}
            data-testid="worktree-squash"
          >
            {busy === 'squash' ? <Loader2 size={12} className="spin" /> : <GitMerge size={12} />} <span className="ellipsis">Squash into {base}</span>
          </button>
          <button
            className="btn small ghost"
            onClick={() => void merge('merge')}
            disabled={busy !== null || !canMerge}
            title={canMerge ? `Commit any uncommitted files, then merge this branch into ${base}, keeping its commits` : `Nothing to bring into ${base} yet`}
            data-testid="worktree-merge"
          >
            {busy === 'merge' ? <Loader2 size={12} className="spin" /> : <GitMerge size={12} />} <span className="ellipsis">Merge into {base}</span>
          </button>
          <button
            className="btn small ghost wt-remove"
            onClick={() => setConfirmRemove(true)}
            disabled={busy !== null}
            title="Remove the worktree folder (unmerged work is kept on its branch)"
            data-testid="worktree-remove"
          >
            <Trash2 size={12} /> Remove worktree
          </button>
        </div>
      )}
    </div>
  );
}
