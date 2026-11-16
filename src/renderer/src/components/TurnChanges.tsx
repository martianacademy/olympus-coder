import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Loader2, Redo2, Undo2, X } from 'lucide-react';
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

/** Under a finished turn that changed files: one quiet line. Click it for the diff and Undo. */
export function TurnBar({ threadId, item }: { threadId: string; item: UserItem }) {
  const open = useOpenFile();
  const cp = item.checkpoint;
  if (!cp?.after || !cp.files) return null;
  return (
    <div className="turn-bar">
      <button className={`turn-chip ${cp.undone ? 'undone' : ''}`} onClick={() => open(turnRef(threadId, item.id))} title="See what this turn changed, and undo it">
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

/** The side panel view of one turn's changes: files with their diffs, and Undo / Redo. */
export function TurnChangesView({ threadId, itemId, onClose }: { threadId: string; itemId: string; onClose: () => void }) {
  const [files, setFiles] = useState<TurnFileChange[] | null>(null);
  const [undone, setUndone] = useState(false);
  const [open, setOpen] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openFile = useOpenFile();

  const load = () =>
    api
      .turnChanges(threadId, itemId)
      .then((r) => {
        setFiles(r.files);
        setUndone(r.undone);
        // A single file opens by itself.
        if (r.files.length === 1) void toggle(r.files[0].path, true);
      })
      .catch((e) => setError(clean(e)));
  useEffect(() => {
    setFiles(null);
    setOpen({});
    setError('');
    void load();
    // The chat item changes when the turn is undone or redone (here or elsewhere).
    return onEvent((ch, p) => {
      if (ch === 'thread:item' && p.threadId === threadId && p.item.id === itemId && p.item.kind === 'user') setUndone(Boolean(p.item.checkpoint?.undone));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, itemId]);

  const toggle = async (path: string, force = false) => {
    if (!force && path in open) return setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== path)));
    setOpen((o) => ({ ...o, [path]: null }));
    const text = await api.turnFileDiff(threadId, itemId, path).catch((e) => `Could not load the diff: ${clean(e)}`);
    setOpen((o) => (path in o ? { ...o, [path]: text } : o));
  };

  /** Undo asks first, inside the panel: which files go back, and a warning if some changed again since. */
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
      } else {
        await api.turnRedo(threadId, itemId);
        setUndone(false);
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
    <div className="file-preview turn-view">
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
          <button className={`btn small turn-action ${undone ? '' : 'danger-soft'}`} disabled={busy} onClick={() => void act(undone ? 'redo' : 'ask')} title={undone ? 'Bring the changes back' : 'Put these files back to how they were before this turn'}>
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
        {files?.map((f) => (
          <div key={f.path} className="turn-file">
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
              {f.binary ? <span className="small muted">binary</span> : (
                <span className="small turn-counts">
                  {f.added > 0 && <span className="add">+{f.added}</span>} {f.removed > 0 && <span className="del">−{f.removed}</span>}
                </span>
              )}
            </div>
            {f.path in open && (open[f.path] === null ? <div className="small muted" style={{ padding: '6px 12px' }}>Loading…</div> : <DiffView text={open[f.path] ?? ''} />)}
          </div>
        ))}
        {files && !files.length && <div className="small muted" style={{ padding: 14 }}>This turn didn't change any files.</div>}
      </div>
    </div>
  );
}

const clean = (e: unknown) => String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
