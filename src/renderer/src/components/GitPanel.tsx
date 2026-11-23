import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, CloudDownload, FileCode, GitBranch as BranchIcon, GitCommitHorizontal, GitMerge, Loader2, Minus, MoreHorizontal, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import type { GitBranch, GitCommit, GitFileChange, GitStash, GitStatus } from '@shared/types';
import { api } from '../api';
import { PanelSkeleton } from './Skeleton';
import { keys } from '../platform';

export function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="muted small" style={{ padding: 10 }}>No diff.</div>;
  return (
    <pre className="diff-view">
      {text.split('\n').map((l, i) => {
        const cls =
          l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
            ? 'd-meta'
            : l.startsWith('@@')
              ? 'd-hunk'
              : l.startsWith('+')
                ? 'd-add'
                : l.startsWith('-')
                  ? 'd-del'
                  : '';
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        );
      })}
    </pre>
  );
}

const LETTER: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'Untracked', T: 'Type changed' };

type Tab = 'changes' | 'history' | 'branches' | 'stash';

/** Every everyday git action for the open project, so the terminal is optional. */
export function GitPanel({ projectId, refreshKey, onStatus, onOpenFile }: { projectId: string; refreshKey: number; onStatus: (s: GitStatus) => void; onOpenFile: (path: string) => void }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [tab, setTab] = useState<Tab>('changes');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [selected, setSelected] = useState<{ path: string; staged: boolean; untracked: boolean } | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [commitOpen, setCommitOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 680);
  const [rowMenu, setRowMenu] = useState<{ f: GitFileChange; isStaged: boolean; letter: string; x: number; y: number } | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [newBranch, setNewBranch] = useState('');
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [stashMsg, setStashMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const s = await api.git.status(projectId);
      setSt(s);
      onStatus(s);
      if (!s.isRepo) return;
      if (tab === 'history') setCommits(await api.git.log(projectId));
      if (tab === 'branches') setBranches(await api.git.branches(projectId));
      if (tab === 'stash') setStashes(await api.git.stashes(projectId));
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? String(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // Keep the open diff current.
  useEffect(() => {
    if (!selected) return setDiff('');
    void api.git
      .diff(projectId, selected.path, selected.staged, selected.untracked)
      .then(setDiff)
      .catch((e) => setDiff(String(e?.message ?? e)));
  }, [selected, st, projectId]);

  useEffect(() => {
    if (!rowMenu) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement)?.closest?.('.explorer-menu')) setRowMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [rowMenu]);

  /** Run one git action with a spinner, then show its output and refresh. */
  async function run(label: string, fn: () => Promise<unknown>, okText?: string) {
    setBusy(label);
    setMsg(null);
    try {
      const out = await fn();
      setMsg({ ok: true, text: okText ?? (typeof out === 'string' && out.trim() ? out.trim().split('\n').slice(-4).join('\n') : `${label} done.`) });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? String(e) });
    }
    setBusy(null);
    await refresh();
  }

  if (!st) return msg && !msg.ok ? <div className="empty muted">{msg.text}</div> : <PanelSkeleton />;
  if (!st.isRepo)
    return (
      <div className="empty">
        <div>
          <p className="muted">This folder is not a git repository yet.</p>
          <button className="btn primary" onClick={() => void run('git init', () => api.git.init(projectId))}>
            <GitCommitHorizontal size={15} /> Initialize repository
          </button>
        </div>
      </div>
    );

  const staged = st.files.filter((f) => f.index !== '.' && f.index !== '?' && !f.conflicted);
  const unstaged = st.files.filter((f) => f.worktree !== '.' || f.conflicted);

  const row = (f: GitFileChange, isStaged: boolean) => {
    const letter = f.conflicted ? 'U' : isStaged ? f.index : f.untracked ? '?' : f.worktree;
    const sel = selected?.path === f.path && selected.staged === isStaged;
    const slash = f.path.lastIndexOf('/');
    const name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    const dir = slash >= 0 ? f.path.slice(0, slash) : '';
    const discardFile = () => {
      if (confirm(f.untracked ? `"${f.path}" is a new file and will be deleted. Continue?` : `Discard all changes to "${f.path}"? This can't be undone.`))
        void run('Discard', () => api.git.discard(projectId, [f.path], f.untracked), 'Changes discarded.');
    };
    return (
      <div key={`${isStaged}-${f.path}`} className={`git-row ${sel ? 'active' : ''}`} onClick={() => setSelected({ path: f.path, staged: isStaged, untracked: f.untracked })} title={`${LETTER[letter] ?? letter}: ${f.path}`}>
        <span className={`git-letter l-${letter === '?' ? 'U' : letter}`}>{letter === '?' ? 'U' : letter}</span>
        <span className="git-file-meta grow">
          <span className="git-file-name ellipsis">{name}</span>
          {dir && <span className="git-file-dir ellipsis">{dir}</span>}
        </span>
        <span className="row-actions">
          {letter !== 'D' && (
            <button className="btn ghost icon git-act-quick" title="Open file" onClick={(e) => (e.stopPropagation(), onOpenFile(f.path))}>
              <FileCode size={13} />
            </button>
          )}
          {!isStaged && (
            <button className="btn ghost icon git-act-quick" title="Discard changes" onClick={(e) => (e.stopPropagation(), discardFile())}>
              <Undo2 size={13} />
            </button>
          )}
          {isStaged ? (
            <button className="btn ghost icon" title="Unstage" onClick={(e) => (e.stopPropagation(), void run('Unstage', () => api.git.unstage(projectId, [f.path]), 'Unstaged.'))}>
              <Minus size={13} />
            </button>
          ) : (
            <button className="btn ghost icon" title="Stage" onClick={(e) => (e.stopPropagation(), void run('Stage', () => api.git.stage(projectId, [f.path]), 'Staged.'))}>
              <Plus size={13} />
            </button>
          )}
          {(letter !== 'D' || !isStaged) && (
            <button
              className="btn ghost icon git-act-more"
              title="More actions"
              data-testid="git-row-more"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setRowMenu((cur) =>
                  cur && cur.f.path === f.path && cur.isStaged === isStaged
                    ? null
                    : { f, isStaged, letter, x: Math.max(8, Math.min(r.right - 160, innerWidth - 176)), y: Math.min(r.bottom + 4, innerHeight - 110) },
                );
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </span>
      </div>
    );
  };

  const doCommit = async (push: boolean) => {
    const all = staged.length === 0;
    if (all && !unstaged.length && !amend) return setMsg({ ok: false, text: 'No changes to commit.' });
    await run(
      push ? 'Commit & push' : 'Commit',
      async () => {
        const out = await api.git.commit(projectId, message, { amend, all });
        if (push) await api.git.push(projectId);
        return out;
      },
      push ? 'Committed and pushed.' : undefined,
    );
    setMessage('');
    setAmend(false);
  };

  return (
    <div className="git-panel">
      <div className="panel-toolbar">
        <BranchIcon size={14} className="muted" />
        <b className="ellipsis" title={st.upstream ? `${st.branch} → ${st.upstream}` : st.branch}>
          {st.branch}
        </b>
        {st.ahead > 0 && (
          <span className="chip" title="Commits to push">
            <ArrowUp size={11} />
            {st.ahead}
          </span>
        )}
        {st.behind > 0 && (
          <span className="chip" title="Commits to pull">
            <ArrowDown size={11} />
            {st.behind}
          </span>
        )}
        <div className="spacer" />
        {busy && <Loader2 size={14} className="spin muted" />}
        <button className="btn ghost small" disabled={Boolean(busy)} title="git fetch --all" onClick={() => void run('Fetch', () => api.git.fetch(projectId), 'Fetched.')}>
          <CloudDownload size={13} /> Fetch
        </button>
        <button className="btn ghost small" disabled={Boolean(busy)} title="git pull" onClick={() => void run('Pull', () => api.git.pull(projectId))}>
          <ArrowDown size={13} /> Pull
        </button>
        <button className="btn ghost small" disabled={Boolean(busy)} title={st.upstream ? 'git push' : 'git push -u origin <branch>'} onClick={() => void run('Push', () => api.git.push(projectId), 'Pushed.')}>
          <ArrowUp size={13} /> Push
        </button>
        <button className="btn ghost icon" title="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="seg small-seg">
        {(
          [
            ['changes', `Changes${st.files.length ? ` (${st.files.length})` : ''}`],
            ['history', 'History'],
            ['branches', 'Branches'],
            ['stash', 'Stash'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => (setTab(k), setShown(null))}>
            {label}
          </button>
        ))}
      </div>
      {msg && (
        <div className={msg.ok ? 'ok-box small' : 'err-box small'} style={{ margin: '6px 8px' }} onClick={() => setMsg(null)} title="Click to hide">
          {msg.text}
        </div>
      )}

      {tab === 'changes' && (
        <div className="git-body">
          <div className="git-list">
            {!commitOpen && !message.trim() ? (
              <button type="button" className="git-commit-trigger" data-testid="git-commit-toggle" onClick={() => setCommitOpen(true)}>
                <GitCommitHorizontal size={14} className="muted" />
                <span className="grow ellipsis">
                  {staged.length ? `Commit ${staged.length} staged…` : st.files.length ? `Commit ${st.files.length} changes…` : 'Write a commit message…'}
                </span>
                <ChevronDown size={14} className="muted" />
              </button>
            ) : (
              <div className="commit-box">
                <textarea
                  className="textarea"
                  rows={2}
                  placeholder={staged.length ? `Commit message (${keys('⌘Enter')} = commit)` : 'Commit message (nothing staged, so all changes will be committed)'}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void doCommit(false)}
                />
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <button className="btn primary small" disabled={Boolean(busy) || (!message.trim() && !amend)} onClick={() => void doCommit(false)}>
                    <Check size={13} /> Commit{staged.length ? '' : ' all'}
                  </button>
                  <button className="btn small" disabled={Boolean(busy) || (!message.trim() && !amend)} onClick={() => void doCommit(true)}>
                    <ArrowUp size={13} /> Commit &amp; push
                  </button>
                  <label className="row small muted" style={{ gap: 5, marginLeft: 'auto' }}>
                    <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
                  </label>
                  <button type="button" className="btn ghost icon git-commit-collapse" title="Collapse commit form" onClick={() => setCommitOpen(false)}>
                    <ChevronUp size={14} />
                  </button>
                </div>
              </div>
            )}
            {rowMenu && (
              <div className="explorer-menu" role="menu" style={{ left: rowMenu.x, top: rowMenu.y }} data-testid="git-row-menu">
                {rowMenu.letter !== 'D' && (
                  <button role="menuitem" onClick={() => (onOpenFile(rowMenu.f.path), setRowMenu(null))}>
                    <FileCode size={14} /> Open file
                  </button>
                )}
                {!rowMenu.isStaged && (
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      const target = rowMenu.f;
                      setRowMenu(null);
                      if (confirm(target.untracked ? `"${target.path}" is a new file and will be deleted. Continue?` : `Discard all changes to "${target.path}"? This can't be undone.`))
                        void run('Discard', () => api.git.discard(projectId, [target.path], target.untracked), 'Changes discarded.');
                    }}
                  >
                    <Undo2 size={14} /> Discard changes
                  </button>
                )}
              </div>
            )}
            {staged.length > 0 && (
              <>
                <div className="git-section">
                  <span>Staged</span>
                  <span className="wb-count">{staged.length}</span>
                  <div className="spacer" />
                  <button className="btn ghost small" onClick={() => void run('Unstage all', () => api.git.unstageAll(projectId), 'All changes unstaged.')}>
                    <Minus size={12} /> Unstage all
                  </button>
                </div>
                {staged.map((f) => row(f, true))}
              </>
            )}
            {unstaged.length > 0 && (
              <>
                <div className="git-section">
                  <span>Changes</span>
                  <span className="wb-count">{unstaged.length}</span>
                  <div className="spacer" />
                  <button className="btn ghost small" onClick={() => void run('Stage all', () => api.git.stageAll(projectId), 'All changes staged.')}>
                    <Plus size={12} /> Stage all
                  </button>
                </div>
                {unstaged.map((f) => row(f, false))}
              </>
            )}
            {!st.files.length && <div className="wb-empty">Working tree clean.</div>}
          </div>
          {selected && (
            <div className="git-diff">
              <div className="panel-toolbar small">
                <span className="ellipsis">
                  {selected.path} {selected.staged ? '(staged)' : ''}
                </span>
                <div className="spacer" />
                <button className="btn ghost small" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <DiffView text={diff} />
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="git-body">
          <div className="git-list">
            {commits.map((c) => (
              <div key={c.hash} className={`git-row commit-row ${shown === c.hash ? 'active' : ''}`} onClick={async () => (setShown(c.hash), setDiff(await api.git.show(projectId, c.hash)))}>
                <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span className="ellipsis">{c.subject}</span>
                  <span className="small muted ellipsis">
                    <code>{c.short}</code> · {c.author} · {new Date(c.date).toLocaleString()}
                    {c.refs && <span className="chip" style={{ marginLeft: 6 }}>{c.refs}</span>}
                  </span>
                </span>
              </div>
            ))}
            {!commits.length && <div className="wb-empty">No commits yet.</div>}
          </div>
          {shown && (
            <div className="git-diff">
              <DiffView text={diff} />
            </div>
          )}
        </div>
      )}

      {tab === 'branches' && (
        <div className="git-list">
          <div className="row" style={{ padding: 8 }}>
            <input className="input" placeholder="New branch name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />
            <button
              className="btn small primary"
              disabled={!newBranch.trim()}
              onClick={async () => {
                await run('Create branch', () => api.git.createBranch(projectId, newBranch.trim()), `Created and switched to branch "${newBranch.trim()}".`);
                setNewBranch('');
              }}
            >
              <Plus size={13} /> Create
            </button>
          </div>
          {(['local', 'remote'] as const).map((kind) => (
            <div key={kind}>
              <div className="git-section">{kind === 'local' ? 'Local' : 'Remote'}</div>
              {branches
                .filter((b) => b.remote === (kind === 'remote'))
                .map((b) => (
                  <div key={b.name} className={`git-row ${b.current ? 'active' : ''}`}>
                    <BranchIcon size={13} className="muted" />
                    <span className="grow ellipsis">
                      {b.name}
                      {b.upstream && <span className="small muted"> → {b.upstream}</span>}
                    </span>
                    {b.current ? (
                      <span className="chip">current</span>
                    ) : (
                      <span className="row-actions" style={{ display: 'flex' }}>
                        <button className="btn ghost small" title="Switch to this branch" onClick={() => void run('Checkout', () => api.git.checkout(projectId, b.name, b.remote), `Switched to "${b.name}".`)}>
                          Checkout
                        </button>
                        <button
                          className="btn ghost icon"
                          title={`Merge "${b.name}" into the current branch`}
                          onClick={() => confirm(`Merge "${b.name}" into "${st.branch}"?`) && void run('Merge', () => api.git.merge(projectId, b.name))}
                        >
                          <GitMerge size={13} />
                        </button>
                        {!b.remote && (
                          <button
                            className="btn ghost icon"
                            title="Delete branch"
                            onClick={() => confirm(`Delete local branch "${b.name}"?`) && void run('Delete branch', () => api.git.deleteBranch(projectId, b.name), `Deleted branch "${b.name}".`)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'stash' && (
        <div className="git-list">
          <div className="row" style={{ padding: 8 }}>
            <input className="input" placeholder="Stash message (optional)" value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} />
            <button
              className="btn small primary"
              disabled={!st.files.length}
              onClick={async () => {
                await run('Stash', () => api.git.stashSave(projectId, stashMsg), 'Changes stashed.');
                setStashMsg('');
              }}
            >
              Stash changes
            </button>
          </div>
          {stashes.map((s) => (
            <div key={s.ref} className="git-row">
              <span className="grow ellipsis">
                <code className="small">{s.ref}</code> {s.message}
              </span>
              <span className="row-actions" style={{ display: 'flex' }}>
                <button className="btn ghost small" onClick={() => void run('Apply', () => api.git.stashApply(projectId, s.ref), 'Stash applied.')}>
                  Apply
                </button>
                <button className="btn ghost small" onClick={() => void run('Pop', () => api.git.stashPop(projectId, s.ref), 'Stash popped.')}>
                  Pop
                </button>
                <button className="btn ghost icon" title="Drop" onClick={() => confirm(`Drop ${s.ref}? This can't be undone.`) && void run('Drop', () => api.git.stashDrop(projectId, s.ref), 'Stash dropped.')}>
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
          {!stashes.length && <div className="wb-empty">No stashes.</div>}
        </div>
      )}
    </div>
  );
}
