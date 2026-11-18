import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Loader2, Redo2, Undo2, X } from 'lucide-react';
import { parseDiffHunks } from '@shared/diffHunks';
import type { ThreadItem, TurnFileChange } from '@shared/types';
import { api, onEvent } from '../api';
import { useOpenFile } from '../fileLinks';
import { DiffView } from './GitPanel';

/** A preview ref that opens a turn's changes in the side panel instead of a file. */
export const turnRef = (threadId: string, itemId: string) => `olympus-turn:${threadId}/${itemId}`;
export const parseTurnRef = (ref: string) => {
  const m = /^olympus-turn:([^/]+)\/(.+)$/.exec(ref);
  return m ? { threadId: m[1], itemId: m[2] } : null;
};

type UserItem = Extract<ThreadItem, { kind: 'user' }>;
type FileState = 'applied' | 'reverted' | 'partial';
type HunkState = 'applied' | 'reverted' | 'modified';

/** Under a finished turn that changed files: one quiet line. Click it for the diff and Undo. */
export function TurnBar({ threadId, item }: { threadId: string; item: UserItem }) {
  const open = useOpenFile();
  const cp = item.checkpoint;
  if (!cp?.after || !cp.files) return null;
  return (
    <div className="turn-bar">
      <button className={`turn-chip ${cp.undone ? 'undone' : ''}`} onClick={() => open(turnRef(threadId, item.id))} title="Review files & hunks changed in this turn">
        <FileDiff size={13} />
        <span>
          {cp.files} file{cp.files > 1 ? 's' : ''} changed
        </span>
        {!cp.undone && !!cp.added && <span className="add">+{cp.added}</span>}
        {!cp.undone && !!cp.removed && <span className="del">−{cp.removed}</span>}
        {cp.undone && <span className="turn-undone">undone</span>}
      </button>
    </div>
  );
}

const STATUS_WORD = { A: 'added', M: 'changed', D: 'deleted' } as const;

interface OpenFileReview {
  diff: string;
  hunkStates: HunkState[];
}

/** Diff viewer with per-hunk Revert / Re-apply buttons on each `@@ ... @@` hunk header. */
function TurnHunkDiff({
  diff,
  hunkStates,
  busyKey,
  onHunkAction,
}: {
  diff: string;
  hunkStates: HunkState[];
  busyKey: string | null;
  onHunkAction: (hunkIndex: number, action: 'revert' | 'apply') => void;
}) {
  const parsed = parseDiffHunks(diff);
  if (!parsed.hunks.length) return <DiffView text={diff} />;
  return (
    <div className="turn-hunk-list" data-testid="turn-hunk-list">
      {parsed.hunks.map((h) => {
        const st = hunkStates[h.index] ?? 'applied';
        const hkKey = `hunk:${h.index}`;
        return (
          <div key={h.index} className={`turn-hunk is-${st}`} data-testid="turn-hunk" data-hunk-state={st}>
            <div className="row d-hunk turn-hunk-head" style={{ padding: '4px 10px', gap: 8, alignItems: 'center' }}>
              <span className="mono ellipsis grow" style={{ fontSize: '0.88em' }}>
                {h.header}
              </span>
              {st === 'reverted' && <span className="small muted">reverted</span>}
              {st === 'modified' && <span className="small muted">edited since</span>}
              {st === 'applied' && (
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="turn-hunk-revert"
                  disabled={Boolean(busyKey)}
                  onClick={() => onHunkAction(h.index, 'revert')}
                  title="Revert only this hunk in the working tree"
                >
                  {busyKey === hkKey ? <Loader2 size={11} className="spin" /> : <Undo2 size={11} />} Revert hunk
                </button>
              )}
              {st === 'reverted' && (
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="turn-hunk-apply"
                  disabled={Boolean(busyKey)}
                  onClick={() => onHunkAction(h.index, 'apply')}
                  title="Re-apply this hunk to the working tree"
                >
                  {busyKey === hkKey ? <Loader2 size={11} className="spin" /> : <Redo2 size={11} />} Re-apply hunk
                </button>
              )}
            </div>
            <pre className="diff-view" style={{ margin: 0 }}>
              {h.lines.map((l, i) => {
                const cls = l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : '';
                return (
                  <div key={i} className={cls}>
                    {l || ' '}
                  </div>
                );
              })}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

/** The side panel view of one turn's changes: whole-turn Undo/Redo, per-file Undo/Re-apply, and per-hunk Revert/Re-apply. */
export function TurnChangesView({ threadId, itemId, onClose }: { threadId: string; itemId: string; onClose: () => void }) {
  const [files, setFiles] = useState<TurnFileChange[] | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({});
  const [undone, setUndone] = useState(false);
  const [open, setOpen] = useState<Record<string, OpenFileReview | null>>({});
  const [busy, setBusy] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [error, setError] = useState('');
  const openFile = useOpenFile();

  const loadReview = async (path: string) => {
    const rev = await api
      .turnFileReview(threadId, itemId, path)
      .catch(async () => ({ diff: await api.turnFileDiff(threadId, itemId, path), hunkStates: [] as HunkState[] }));
    setOpen((o) => (path in o ? { ...o, [path]: rev } : o));
  };

  const load = (autoExpandSingle = false) =>
    api
      .turnChanges(threadId, itemId)
      .then((r) => {
        setFiles(r.files);
        setUndone(r.undone);
        setFileStates(r.fileStates ?? {});
        if (autoExpandSingle && r.files.length === 1) void toggle(r.files[0].path, true);
      })
      .catch((e) => setError(clean(e)));

  useEffect(() => {
    setFiles(null);
    setFileStates({});
    setOpen({});
    setError('');
    void load(true);
    return onEvent((ch, p) => {
      if (ch === 'thread:item' && p.threadId === threadId && p.item.id === itemId && p.item.kind === 'user') setUndone(Boolean(p.item.checkpoint?.undone));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, itemId]);

  const toggle = async (path: string, force = false) => {
    if (!force && path in open) return setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== path)));
    setOpen((o) => ({ ...o, [path]: null }));
    try {
      await loadReview(path);
    } catch (e) {
      setOpen((o) => (path in o ? { ...o, [path]: { diff: `Could not load the diff: ${clean(e)}`, hunkStates: [] } } : o));
    }
  };

  const actFile = async (path: string, to: 'before' | 'after') => {
    setBusyItem(`file:${path}`);
    setError('');
    try {
      const r = await api.turnSetFile(threadId, itemId, path, to);
      setFiles(r.files);
      setFileStates(r.fileStates);
      if (path in open) await loadReview(path);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusyItem(null);
    }
  };

  const actHunk = async (path: string, hunkIndex: number, action: 'revert' | 'apply') => {
    setBusyItem(`${path}:hunk:${hunkIndex}`);
    setError('');
    try {
      const r = await api.turnSetHunk(threadId, itemId, path, hunkIndex, action);
      setFileStates(r.fileStates);
      setOpen((o) => (path in o ? { ...o, [path]: { diff: r.diff, hunkStates: r.hunkStates } } : o));
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusyItem(null);
    }
  };

  const [confirm, setConfirm] = useState<{ files: string[]; changedSince: string[] } | null>(null);
  const act = async (what: 'ask' | 'undo' | 'redo') => {
    setBusy(true);
    setError('');
    try {
      if (what === 'ask') setConfirm(await api.turnUndoCheck(threadId, itemId));
      else if (what === 'undo') {
        await api.turnUndo(threadId, itemId);
        setConfirm(null);
        setUndone(true);
        await load();
        for (const p of Object.keys(open)) await loadReview(p);
      } else {
        await api.turnRedo(threadId, itemId);
        setUndone(false);
        await load();
        for (const p of Object.keys(open)) await loadReview(p);
      }
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };

  const added = files?.reduce((a, f) => a + f.added, 0) ?? 0;
  const removed = files?.reduce((a, f) => a + f.removed, 0) ?? 0;
  return (
    <div className="file-preview turn-view" data-testid="turn-review">
      <div className="fp-head">
        <span className="fp-icon muted">
          <FileDiff size={15} />
        </span>
        <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <span className="fp-name">Changes in this turn</span>
          <span className="small muted">
            {files ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Loading…'}
            {files && (added || removed) ? (
              <>
                {' · '}
                <span className="add">+{added}</span> <span className="del">−{removed}</span>
              </>
            ) : null}
            {undone ? ' · undone' : ''}
          </span>
        </div>
        {files && files.length > 0 && (
          <button className={`btn small turn-action ${undone ? '' : 'danger-soft'}`} disabled={busy || Boolean(busyItem)} onClick={() => void act(undone ? 'redo' : 'ask')} title={undone ? 'Bring the changes back' : 'Put these files back to how they were before this turn'}>
            {busy ? <Loader2 size={13} className="spin" /> : undone ? <Redo2 size={13} /> : <Undo2 size={13} />}
            {undone ? 'Redo' : 'Undo turn'}
          </button>
        )}
        <button className="btn ghost icon" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {error && <div className="turn-error small">{error}</div>}
      {confirm && !undone && (
        <div className={`turn-confirm ${confirm.changedSince.length ? 'warn' : ''}`}>
          <div>
            {confirm.changedSince.length ? (
              <>
                <b>
                  {confirm.changedSince.length === 1 ? 'One of these files' : `${confirm.changedSince.length} of these files`} changed again after this turn.
                </b>{' '}
                Undo puts {confirm.changedSince.length > 1 ? 'them' : 'it'} back to before the turn too, so those later edits go as well (Redo brings everything back):{' '}
                <span className="mono">{confirm.changedSince.slice(0, 4).join(', ')}{confirm.changedSince.length > 4 ? '…' : ''}</span>
              </>
            ) : (
              <>
                Put {confirm.files.length} file{confirm.files.length > 1 ? 's' : ''} back to how {confirm.files.length > 1 ? 'they were' : 'it was'} before this turn? Redo brings the changes back.
              </>
            )}
          </div>
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn small ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn small primary" disabled={busy} onClick={() => void act('undo')}>
              {busy ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />} Undo
            </button>
          </div>
        </div>
      )}
      {undone && <div className="turn-note small">These files are back to how they were before the turn. Redo brings the changes back.</div>}
      <div className="turn-files">
        {files?.map((f) => {
          const st = fileStates[f.path] ?? 'applied';
          const rev = open[f.path];
          return (
            <div key={f.path} className="turn-file" data-testid="turn-file" data-file-path={f.path} data-file-state={st}>
              <div className="turn-file-head" onClick={() => void toggle(f.path)}>
                {f.path in open ? <ChevronDown size={13} className="muted" /> : <ChevronRight size={13} className="muted" />}
                <span className={`turn-status s-${f.status}`} title={STATUS_WORD[f.status]}>
                  {f.status}
                </span>
                <span
                  className="ellipsis grow mono turn-path"
                  title={`${f.path} — open the file`}
                  onClick={(e) => {
                    if (f.status === 'D') return;
                    e.stopPropagation();
                    openFile(f.path);
                  }}
                >
                  {f.path}
                </span>
                {st !== 'applied' && <span className="small muted">{st}</span>}
                {f.binary ? (
                  <span className="small muted">binary</span>
                ) : (
                  <span className="small turn-counts">
                    {f.added > 0 && <span className="add">+{f.added}</span>} {f.removed > 0 && <span className="del">−{f.removed}</span>}
                  </span>
                )}
                <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  {st !== 'reverted' && (
                    <button
                      type="button"
                      className="btn ghost small"
                      data-testid="turn-file-undo"
                      disabled={busy || Boolean(busyItem)}
                      onClick={() => void actFile(f.path, 'before')}
                      title="Put only this file back to before the turn"
                    >
                      {busyItem === `file:${f.path}` ? <Loader2 size={11} className="spin" /> : <Undo2 size={11} />} Undo file
                    </button>
                  )}
                  {st !== 'applied' && (
                    <button
                      type="button"
                      className="btn ghost small"
                      data-testid="turn-file-redo"
                      disabled={busy || Boolean(busyItem)}
                      onClick={() => void actFile(f.path, 'after')}
                      title="Restore this file to how the turn left it"
                    >
                      {busyItem === `file:${f.path}` ? <Loader2 size={11} className="spin" /> : <Redo2 size={11} />} Re-apply
                    </button>
                  )}
                </span>
              </div>
              {f.path in open &&
                (rev === null ? (
                  <div className="small muted" style={{ padding: '6px 12px' }}>
                    Loading…
                  </div>
                ) : f.binary ? (
                  <DiffView text={rev?.diff ?? ''} />
                ) : (
                  <TurnHunkDiff
                    diff={rev?.diff ?? ''}
                    hunkStates={rev?.hunkStates ?? []}
                    busyKey={busyItem?.startsWith(`${f.path}:`) ? busyItem.slice(f.path.length + 1) : null}
                    onHunkAction={(idx, action) => void actHunk(f.path, idx, action)}
                  />
                ))}
            </div>
          );
        })}
        {files && !files.length && <div className="small muted" style={{ padding: 14 }}>This turn didn't change any files.</div>}
      </div>
    </div>
  );
}

const clean = (e: unknown) => String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
