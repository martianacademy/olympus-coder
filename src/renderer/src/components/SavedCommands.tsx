import { useEffect, useState } from 'react';
import { ChevronRight, History, Pencil, Play, ShieldAlert, Square, SquareArrowOutUpRight, Trash2, X } from 'lucide-react';
import { GUARD_FAILURES, GUARD_WINDOW_MS, isInterrupt, statusText, type SavedCommand } from '@shared/savedCommands';
import { errText, savedApi, type SavedNotice } from '../savedCommandsApi';
import { commandTip } from '../cmdFormat';
import '../savedCommands.css';

/**
 * Saved commands in the terminal panel (see src/shared/savedCommands.ts): a quiet strip after a restart for the
 * ones that were running when Olympus closed, a guard notice when one kept failing, and the per-project list.
 */

const dot = (c: SavedCommand) => (c.lastStatus === 'running' ? 'live' : c.lastStatus === 'guard-tripped' || (c.lastStatus === 'stopped' && c.lastExitCode && !isInterrupt(c.lastExitCode)) ? 'fail' : c.lastStatus === 'stopped-by-restart' ? 'stopped' : '');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The "stopped when Olympus closed" strip and guard notices, above the terminals. Nothing when there is nothing. */
export function SavedStrip({ projectId, list, notice, onShow }: { projectId: string; list: SavedCommand[]; notice: SavedNotice; onShow: (ptyId: string) => void }) {
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const stopped = notice.stoppedByRestart.map((id) => list.find((c) => c.id === id)).filter((c): c is SavedCommand => Boolean(c));
  const tripped = notice.guardTripped.map((id) => list.find((c) => c.id === id)).filter((c): c is SavedCommand => Boolean(c));
  const run = async (c: SavedCommand) => {
    setError('');
    try {
      onShow((await savedApi.run(c.id)).ptyId);
    } catch (e) {
      setError(errText(e));
    }
  };
  if (!stopped.length && !tripped.length) return null;
  return (
    <div className="saved-notices">
      {stopped.length > 0 && (
        <div className="saved-strip" data-testid="saved-restart-strip">
          <div className="saved-strip-line">
            <History size={13} />
            <span className="ellipsis">{plural(stopped.length, 'saved command')} stopped when Olympus closed</span>
            <button
              className="btn small primary"
              data-testid="saved-restart-all"
              title={stopped.map((c) => commandTip(c.command, 80)).join('\n')}
              onClick={async () => {
                setError('');
                const r = await savedApi.restartAll(projectId).catch((e) => ({ started: 0, errors: [errText(e)] }));
                if (r.errors.length) setError(r.errors.join(' · '));
              }}
            >
              Restart all
            </button>
            <button className="btn small ghost" aria-expanded={choosing} onClick={() => setChoosing((v) => !v)} title="Pick which ones to start">
              Choose
            </button>
            <button className="btn ghost icon" title="Dismiss" aria-label="Dismiss" onClick={() => void savedApi.dismiss(projectId, 'restart')}>
              <X size={12} />
            </button>
          </div>
          {choosing && (
            <div className="saved-choose">
              {stopped.map((c) => (
                <div key={c.id} className="saved-choose-row">
                  <span className="saved-title ellipsis">{c.title}</span>
                  <span className="saved-cmd mono ellipsis" title={commandTip(c.command)}>
                    {c.command}
                  </span>
                  <button className="btn ghost icon" title={`Run: ${commandTip(c.command)}`} aria-label="Run" onClick={() => void run(c)}>
                    <Play size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {tripped.map((c) => (
        <div key={c.id} className="saved-strip guard" data-testid="saved-guard-notice">
          <div className="saved-strip-line">
            <ShieldAlert size={13} />
            <span className="ellipsis" title={commandTip(c.command)}>
              Stopped restarting <b>{c.title}</b>: it failed {GUARD_FAILURES} times within {GUARD_WINDOW_MS / 60_000} minutes
            </span>
            <button className="btn small ghost" title={`Run once more: ${commandTip(c.command)}`} onClick={() => void run(c)}>
              Run
            </button>
            <button className="btn ghost icon" title="Dismiss" aria-label="Dismiss" onClick={() => void savedApi.dismiss(projectId, 'guard', c.id)}>
              <X size={12} />
            </button>
          </div>
          <code className="saved-cmd mono ellipsis">{c.command}</code>
        </div>
      ))}
      {error && <div className="saved-error error-text">{error}</div>}
    </div>
  );
}

/** The project's saved commands, folded under one quiet header. Nothing when none are saved. */
export function SavedList({ list, open, onToggle, onShow }: { list: SavedCommand[]; open: boolean; onToggle: () => void; onShow: (ptyId: string) => void }) {
  if (!list.length) return null;
  const running = list.filter((c) => c.lastStatus === 'running').length;
  return (
    <div className={`saved-list ${open ? 'open' : ''}`} data-testid="saved-list">
      <button className="saved-head" aria-expanded={open} onClick={onToggle} title={open ? 'Hide saved commands' : 'Show saved commands'}>
        <ChevronRight size={13} className="saved-chevron" />
        <span>Saved commands</span>
        <span className="saved-count">{running ? `${running} of ${list.length} running` : list.length}</span>
      </button>
      {open && (
        <div className="saved-rows">
          {list.map((c) => (
            <SavedRow key={c.id} c={c} onShow={onShow} />
          ))}
        </div>
      )}
    </div>
  );
}

function SavedRow({ c, onShow }: { c: SavedCommand; onShow: (ptyId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);
  const running = c.lastStatus === 'running';
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="saved-row" data-testid="saved-row" data-status={c.lastStatus}>
      <div className="saved-row-line">
        <span className={`term-dot ${dot(c)}`} title={statusText(c)} aria-label={statusText(c)} />
        <div className="saved-text">
          <span className="saved-title ellipsis">
            {c.title}
            {c.autoStart && <span className="saved-flag">auto-start</span>}
            {c.keepRunning && <span className="saved-flag">keep running</span>}
          </span>
          <span className="saved-cmd mono ellipsis" title={commandTip(c.command)}>
            {c.command}
          </span>
          {c.cwd && (
            <span className="saved-cwd mono ellipsis" title={`Runs in ${c.cwd}`}>
              in {c.cwd}
            </span>
          )}
        </div>
        <div className="saved-actions">
          {running && c.ptyId ? (
            <>
              <button className="btn ghost icon" title="Show its terminal" aria-label="Show its terminal" onClick={() => onShow(c.ptyId!)}>
                <SquareArrowOutUpRight size={12} />
              </button>
              <button className="btn ghost icon" title="Stop (it is not restarted)" aria-label="Stop" onClick={() => void act(() => savedApi.stop(c.id))}>
                <Square size={11} />
              </button>
            </>
          ) : (
            <button className="btn ghost icon" data-testid="saved-run" title={`Run in a new terminal: ${commandTip(c.command)}`} aria-label="Run" onClick={() => void act(async () => onShow((await savedApi.run(c.id)).ptyId))}>
              <Play size={12} />
            </button>
          )}
          <button className="btn ghost icon" title="Edit" aria-label="Edit" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
            <Pencil size={12} />
          </button>
          {confirmDelete ? (
            <button className="btn small danger" title="Forget this saved command (a running terminal keeps running)" onClick={() => void act(() => savedApi.remove(c.id))}>
              Delete?
            </button>
          ) : (
            <button className="btn ghost icon" title="Delete" aria-label="Delete" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      {editing && <SavedEdit c={c} onDone={() => setEditing(false)} />}
      {error && <div className="saved-error error-text">{error}</div>}
    </div>
  );
}

function SavedEdit({ c, onDone }: { c: SavedCommand; onDone: () => void }) {
  const [title, setTitle] = useState(c.title);
  const [command, setCommand] = useState(c.command);
  const [cwd, setCwd] = useState(c.cwd ?? '');
  const [autoStart, setAutoStart] = useState(c.autoStart);
  const [keepRunning, setKeepRunning] = useState(c.keepRunning);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    try {
      await savedApi.update(c.id, { title, command, cwd, autoStart, keepRunning });
      onDone();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <form
      className="saved-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <span>Name</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>Command</span>
        <textarea className="mono" rows={2} value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
      </label>
      <label>
        <span>Folder</span>
        <input className="mono" value={cwd} placeholder="Project folder" onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
      </label>
      <label className="saved-check">
        <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
        <span>Start when Olympus starts</span>
      </label>
      {autoStart && (
        <div className="saved-hint">
          Each time Olympus starts it runs <code className="mono">{command.trim() || '…'}</code> in <code className="mono">{cwd.trim() || 'the project folder'}</code>.
        </div>
      )}
      <label className="saved-check">
        <input type="checkbox" checked={keepRunning} onChange={(e) => setKeepRunning(e.target.checked)} />
        <span>Restart it when it stops</span>
      </label>
      {(autoStart || keepRunning) && (
        <div className="saved-hint">
          Olympus stops starting it by itself after {GUARD_FAILURES} failed starts within {GUARD_WINDOW_MS / 60_000} minutes (a start fails when it exits with an error or within a minute). Stop or closing its tab never restarts it.
        </div>
      )}
      {error && <div className="saved-error error-text">{error}</div>}
      <div className="saved-edit-actions">
        <button type="button" className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn small primary">
          Save
        </button>
      </div>
    </form>
  );
}
