import { useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Check, Loader2, Play, Square } from 'lucide-react';
import { stopAcpTerminal, useAcpTerminal } from '../acpTerminal';
import { cleanTerminalText, formatBashCommand, formatCommandResult } from '../cmdFormat';
import { LinkedText, RunCommandContext } from '../fileLinks';
import { fmtStepDuration } from '../toolStep';
import { BoxButton, CopyBoxButton, ExpandBoxButton, STEP_BOX_CAP, useBodyCap } from './StepBox';
import '../acpClient.css';

/** Characters drawn in the RESULT box; Copy still gives everything the app kept. */
const MAX_RENDER_CHARS = 16_000;

/** Re-renders every second while `on` (the running clock). */
function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/**
 * BASH + RESULT boxes for a command whose output streams live: a terminal Olympus runs for the agent
 * (`terminal/create`) or one the agent reports in tool-call `_meta` (Codex, Claude Code). Same look as the
 * static command box. While the command runs the RESULT box follows the newest output (unless the user
 * scrolled up) and offers Stop for commands Olympus runs.
 *
 * After a restart the app no longer has the live terminal: then `fallbackOutput` (the text saved in the
 * chat) is shown instead.
 */
export function AcpTerminalBox({
  termKey,
  command,
  fallbackOutput,
  fallbackExitCode,
  toolStatus,
  standalone,
}: {
  termKey: string;
  /** Command to show when the terminal does not report one. */
  command?: string;
  fallbackOutput?: string;
  fallbackExitCode?: number;
  /** The tool card's status (`in_progress`, `completed`, `failed`, `interrupted`, …). */
  toolStatus?: string;
  standalone?: boolean;
}) {
  const term = useAcpTerminal(termKey);
  const runInTerminal = useContext(RunCommandContext);
  const cmdCap = useBodyCap(STEP_BOX_CAP);
  const outCap = useBodyCap(STEP_BOX_CAP);
  const [stopping, setStopping] = useState(false);
  const [ran, setRan] = useState(false);

  const shownCommand = term?.command || command || '';
  const running = term ? term.running : toolStatus === 'pending' || toolStatus === 'in_progress';
  useTick(running && !!term);

  const exitCode = term ? term.exitStatus?.exitCode : fallbackExitCode;
  const signal = term?.exitStatus?.signal ?? null;
  const failed = (exitCode !== undefined && exitCode !== null && exitCode !== 0) || !!signal || toolStatus === 'failed';

  const raw = term ? term.output : (fallbackOutput ?? '');
  const hiddenChars = Math.max(0, raw.length - MAX_RENDER_CHARS);
  const tail = hiddenChars ? raw.slice(hiddenChars) : raw;
  // Live text is only cleaned (cheap); the finished text also gets the JSON prettifier.
  const shown = useMemo(() => (running ? cleanTerminalText(tail).trimEnd() : formatCommandResult(tail)), [tail, running]);
  const fullForCopy = useMemo(() => cleanTerminalText(raw).trimEnd(), [raw]);
  const clippedNote = hiddenChars > 0 || term?.clipped;

  // Follow the newest output while running, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const body = outCap.innerRef.current?.parentElement;
    if (!body || !running) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
    if (nearBottom || body.dataset.follow !== 'off') body.scrollTop = body.scrollHeight;
  }, [shown, running, outCap.innerRef]);

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  const errCls = failed ? 'is-error' : '';
  const elapsed = term ? fmtStepDuration((term.endedAt ?? Date.now()) - term.startedAt) : '';
  const canStop = !!term && term.source === 'client' && term.running;

  let status: React.ReactNode = null;
  if (running) {
    status = (
      <span className="step-box-meta acp-term-live" data-testid="acp-term-running">
        <Loader2 size={11} className="spin" />
        {stopping ? 'Stopping…' : `Running${elapsed ? ` · ${elapsed}` : ''}`}
      </span>
    );
  } else if (failed) {
    status = (
      <span className="step-box-meta cmd-box-err-meta" data-testid="acp-term-exit">
        {signal ? `stopped (${signal})` : exitCode !== undefined && exitCode !== null ? `exit ${exitCode}` : 'failed'}
      </span>
    );
  } else if (term?.exitStatus && elapsed) {
    status = <span className="step-box-meta acp-term-done">{elapsed}</span>;
  }

  return (
    <div
      className={`tool-body step-boxes cmd-terminal-box acp-term ${standalone ? 'standalone' : ''} ${errCls}`}
      data-testid="acp-terminal-box"
      data-terminal-key={termKey}
      data-error={failed ? 'true' : undefined}
      data-running={running ? 'true' : undefined}
    >
      {shownCommand && (
        <div className={`step-box cmd-box cmd-bash-box ${errCls} ${cmdCap.expanded ? 'is-expanded' : ''}`} data-box-kind="command">
          <div className="step-box-head">
            <span className="cmd-box-label">BASH</span>
            {term?.cwd && (
              <span className="step-box-meta acp-term-cwd" title={term.cwd}>
                {term.cwd.split(/[\\/]/).filter(Boolean).pop()}
              </span>
            )}
            <span className="grow" />
            <span className="step-box-actions">
              {runInTerminal && (
                <BoxButton
                  icon={ran ? <Check size={11} /> : <Play size={11} />}
                  label={ran ? 'Started' : 'Run'}
                  tip="Run this command in a new terminal tab in the right panel"
                  testId="acp-term-run"
                  onClick={() => {
                    runInTerminal(shownCommand.trim());
                    setRan(true);
                    setTimeout(() => setRan(false), 1500);
                  }}
                />
              )}
              <CopyBoxButton text={shownCommand} label="Copy" tip="Copy command" testId="acp-term-copy-cmd" />
              {(cmdCap.overflows || cmdCap.expanded) && <ExpandBoxButton expanded={cmdCap.expanded} onToggle={cmdCap.toggle} testId="acp-term-expand-cmd" />}
            </span>
          </div>
          <div className="step-box-body mono">
            <div ref={cmdCap.innerRef} className="step-box-inner">
              <pre className="step-box-pre cmd-terminal-prompt">{formatBashCommand(shownCommand)}</pre>
            </div>
          </div>
        </div>
      )}

      <div className={`step-box cmd-box cmd-result-box ${errCls} ${outCap.expanded ? 'is-expanded' : ''}`} data-box-kind="command">
        <div className="step-box-head">
          <span className="cmd-box-label">RESULT</span>
          <span className="grow" />
          {status}
          <span className="step-box-actions">
            {canStop && (
              <BoxButton
                icon={<Square size={10} />}
                label="Stop"
                tip="Stop this command"
                testId="acp-term-stop"
                className="acp-term-stop"
                onClick={() => {
                  setStopping(true);
                  void stopAcpTerminal(termKey);
                }}
              />
            )}
            {fullForCopy && <CopyBoxButton text={fullForCopy} label="Copy" tip="Copy the output" testId="acp-term-copy-out" />}
            {(outCap.overflows || outCap.expanded) && <ExpandBoxButton expanded={outCap.expanded} onToggle={outCap.toggle} testId="acp-term-expand-out" />}
          </span>
        </div>
        <div
          className="step-box-body mono"
          onScroll={(e) => {
            const b = e.currentTarget;
            b.dataset.follow = b.scrollHeight - b.scrollTop - b.clientHeight < 48 ? 'on' : 'off';
          }}
        >
          <div ref={outCap.innerRef} className="step-box-inner">
            {clippedNote && shown && (
              <div className="acp-term-clipped" title="Copy gives all the output the app kept">
                Earlier output hidden — showing the end
              </div>
            )}
            {shown ? (
              <pre className={`step-box-pre cmd-terminal-out ${failed ? 'err' : ''}`} data-testid="acp-term-output">
                <LinkedText text={shown} />
              </pre>
            ) : running ? (
              <div className="cmd-terminal-empty mono live">
                <Loader2 size={12} className="spin" />
                <span>Waiting for output…</span>
              </div>
            ) : toolStatus === 'interrupted' ? (
              <div className="cmd-terminal-empty mono">Stopped before completion</div>
            ) : (
              <div className={`cmd-terminal-empty mono ${failed ? 'err' : ''}`}>
                {failed ? (signal ? `Stopped (${signal}) — no output` : exitCode != null ? `Exited with code ${exitCode} — no output` : 'Command failed — no output') : 'No output'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
