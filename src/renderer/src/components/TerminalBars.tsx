import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, CircleCheck, CircleX, RotateCw, X } from 'lucide-react';
import { useOpenFile } from '../fileLinks';
import type { TestResult } from '../tests';
import { terminalFind, terminalFindClear } from './Terminal';

/** Find in the terminal's output: text, or "Errors" to step through lines that look like failures. */
export function FindBar({ ptyId, onClose }: { ptyId: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [errors, setErrors] = useState(false);
  const [pos, setPos] = useState<{ index: number; total: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const find = (backwards = false, restart = false, query = q, mode: 'text' | 'errors' = errors ? 'errors' : 'text') =>
    setPos(mode === 'text' && !query ? null : terminalFind(ptyId, query, { mode, backwards, restart }));
  const close = () => {
    terminalFindClear(ptyId);
    onClose();
  };
  return (
    <div className="find-bar" onKeyDown={(e) => e.key === 'Escape' && close()}>
      <input
        ref={input}
        value={q}
        placeholder={errors ? 'Error lines' : 'Find'}
        readOnly={errors}
        onChange={(e) => {
          setQ(e.target.value);
          find(false, true, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            find(!e.shiftKey);
          }
        }}
      />
      <span className="find-count small muted">{pos ? (pos.total ? `${pos.index}/${pos.total}` : 'none') : ''}</span>
      <button className="btn ghost icon" title="Previous (Enter)" onClick={() => find(true)}>
        <ChevronUp size={13} />
      </button>
      <button className="btn ghost icon" title="Next (Shift+Enter)" onClick={() => find(false)}>
        <ChevronDown size={13} />
      </button>
      <button
        className={`btn ghost small find-errors ${errors ? 'on' : ''}`}
        title="Step through lines that look like errors"
        onClick={() => {
          const on = !errors;
          setErrors(on);
          find(true, true, q, on ? 'errors' : 'text');
        }}
      >
        <AlertTriangle size={12} /> Errors
      </button>
      <button className="btn ghost icon" title="Close (Esc)" onClick={close}>
        <X size={12} />
      </button>
    </div>
  );
}

/** One line over the terminal after a test run: passed / failed, the failed tests on click, and what to do next. */
export function TestBar(props: { result: TestResult; canCompose: boolean; onRerun: (cmd: string) => void; onAskFix: () => void; onDismiss: () => void }) {
  const r = props.result;
  const [open, setOpen] = useState(false);
  const openFile = useOpenFile();
  const ok = r.failed === 0;
  return (
    <div className={`test-bar ${ok ? 'ok' : 'bad'}`}>
      <div className="test-bar-row">
        {ok ? <CircleCheck size={13} className="ok-text" /> : <CircleX size={13} className="bad-text" />}
        <span className="test-counts">
          {ok ? (
            <b>All {r.passed} passed</b>
          ) : (
            <button className="link-btn" onClick={() => setOpen((o) => !o)} title="Show the failed tests">
              <b>{r.failed} failed</b> {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
          {!ok && <span className="muted">{r.passed} passed</span>}
          {r.skipped > 0 && <span className="muted">{r.skipped} skipped</span>}
          <span className="muted test-runner">{r.runner}</span>
        </span>
        <span className="grow" />
        {!ok && r.rerunFailed && (
          <button className="btn ghost small" title={r.rerunFailed} onClick={() => props.onRerun(r.rerunFailed!)}>
            <RotateCw size={12} /> Rerun failed
          </button>
        )}
        {!ok && props.canCompose && (
          <button className="btn small primary" onClick={props.onAskFix} title="Puts the failures into the chat's message box, for you to send">
            Ask agent to fix
          </button>
        )}
        <button className="btn ghost icon" title="Hide" onClick={props.onDismiss}>
          <X size={12} />
        </button>
      </div>
      {open && !ok && (
        <div className="test-fails">
          {r.failures.length ? (
            r.failures.slice(0, 50).map((f, i) => (
              <div key={i} className="test-fail">
                <CircleX size={11} className="bad-text" />
                <span className="ellipsis grow mono">{f.name}</span>
                {f.ref && (
                  <span className="file-ref inline small" onClick={() => openFile(f.ref!)} title={`Open ${f.ref}`}>
                    {f.ref}
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="small muted">The runner didn't list the failed tests' names.</div>
          )}
        </div>
      )}
    </div>
  );
}
