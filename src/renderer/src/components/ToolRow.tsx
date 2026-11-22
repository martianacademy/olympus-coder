import { memo, useContext, useEffect, useMemo, useState } from 'react';
import {
  Brain,
  Check,
  FilePen,
  FileText,
  FolderInput,
  Globe,
  Loader2,
  Play,
  Search,
  SquareArrowOutUpRight,
  SquareTerminal,
  ToggleLeft,
  Trash2,
  Wrench,
} from 'lucide-react';
import { formatBashCommand, formatCommandResult } from '../cmdFormat';
import { HighlightedCode } from '../codeHighlight';
import { detectResultLang } from '../codeLang';
import { LinkedText, RunCommandContext, useOpenFile } from '../fileLinks';
import { triggerFixError, useProjectId } from '../fixError';
import { useStepChoice } from '../prefs';
import { fmtTokens } from '../tokens';
import { fmtStepDuration, parseToolStep, type ParsedToolStep, type ToolItem } from '../toolStep';
import { extractStepFilePaths } from './InlineFilePreviews';
import { AcpTerminalBox } from './AcpTerminalBox';
import { toolIdentityLabel } from '@shared/acpContent';
import { LocationLinks, ToolRichContent } from './RichContent';
import { StepBody } from './StepBodies';
import { StepRowHead } from './StepRowHead';
import { BoxButton, CopyBoxButton, ExpandBoxButton, STEP_BOX_CAP, useBodyCap } from './StepBox';
import { StepIcon, toolStepKind } from './stepIcons';

/** Icons for each ACP tool category, shared by `ToolGroup` and `ToolRow`. */
export const KIND_ICON: Record<string, React.ReactNode> = {
  read: <FileText size={13} />,
  edit: <FilePen size={13} />,
  delete: <Trash2 size={13} />,
  move: <FolderInput size={13} />,
  search: <Search size={13} />,
  execute: <SquareTerminal size={13} />,
  think: <Brain size={13} />,
  fetch: <Globe size={13} />,
  switch_mode: <ToggleLeft size={13} />,
};

const STATUS_TIP: Record<string, string> = {
  pending: 'Waiting to start',
  in_progress: 'Running',
  completed: 'Done',
  failed: 'Failed',
  interrupted: "Stopped: the agent's process ended (the app was closed or restarted) before this finished",
};

const MAX_RENDER_CHARS = 16_000;

/** "≈1.2k tokens" estimate pill shared by `Chat`, `ToolGroup`, and standalone `ToolRow`. */
export function TokenTag({ n, live }: { n: number; live?: boolean }) {
  if (n < 20) return null;
  return (
    <span className={`token-tag ${live ? 'live' : ''}`} title="Roughly how many tokens this step produced (an estimate from its length)">
      ≈{fmtTokens(n)}
    </span>
  );
}

function RunAction({ command, onRun }: { command: string; onRun: (cmd: string) => void }) {
  const [ran, setRan] = useState(false);
  return (
    <BoxButton
      icon={ran ? <Check size={11} /> : <Play size={11} />}
      label={ran ? 'Started' : 'Run'}
      tip="Run this command in a new terminal tab in the right panel"
      testId="cmd-box-run"
      onClick={() => {
        const trimmed = command.trim();
        if (!trimmed) return;
        onRun(trimmed);
        setRan(true);
        setTimeout(() => setRan(false), 1500);
      }}
    />
  );
}

/**
 * Simple two-box command view (`BASH` for the formatted command, `RESULT` for stdout/stderr).
 * Turns red when the command fails or exits with a non-zero status code.
 */
function CommandTerminalBox({
  item,
  parsed,
  standalone,
  running,
  failed,
}: {
  item: ToolItem;
  parsed: ParsedToolStep;
  standalone?: boolean;
  running: boolean;
  failed: boolean;
}) {
  const openFile = useOpenFile();
  const projectId = useProjectId();
  const runInTerminal = useContext(RunCommandContext);
  const cmdCap = useBodyCap(STEP_BOX_CAP);
  const outCap = useBodyCap(STEP_BOX_CAP);

  const formattedCommand = useMemo(() => formatBashCommand(parsed.command), [parsed.command]);
  const formattedOutput = useMemo(() => formatCommandResult(parsed.output), [parsed.output]);

  const clippedOutput = formattedOutput.slice(0, MAX_RENDER_CHARS);
  const clipNote =
    formattedOutput.length > MAX_RENDER_CHARS
      ? `\n… (${formattedOutput.length - MAX_RENDER_CHARS} more characters — use Copy for the full text)`
      : '';
  const shownOutput = clippedOutput + clipNote;

  // Colours only once the command has finished and succeeded: live output and error text stay plain.
  const resultLang = useMemo(
    () => (running || failed ? null : detectResultLang(parsed.command, clippedOutput)),
    [running, failed, parsed.command, clippedOutput],
  );

  const errCls = failed ? 'is-error' : '';

  return (
    <div
      className={`tool-body step-boxes cmd-terminal-box ${standalone ? 'standalone' : ''} ${errCls}`}
      data-testid="cmd-terminal-box"
      data-error={failed ? 'true' : undefined}
    >
      <div
        className={`step-box cmd-box cmd-bash-box ${errCls} ${cmdCap.expanded ? 'is-expanded' : ''}`}
        data-testid="cmd-bash-box"
        data-box-kind="command"
      >
        <div className="step-box-head">
          <span className="cmd-box-label">COMMAND</span>
          <span className="grow" />
          <span className="step-box-actions">
            {runInTerminal && <RunAction command={parsed.command} onRun={runInTerminal} />}
            <CopyBoxButton text={parsed.command} label="Copy" tip="Copy command" testId="cmd-box-copy-cmd" />
            {(cmdCap.overflows || cmdCap.expanded) && (
              <ExpandBoxButton expanded={cmdCap.expanded} onToggle={cmdCap.toggle} testId="cmd-box-expand" />
            )}
          </span>
        </div>
        <div className="step-box-body mono">
          <div ref={cmdCap.innerRef} className="step-box-inner">
            <pre className="step-box-pre cmd-terminal-prompt">
              <HighlightedCode text={formattedCommand} lang="shell" />
            </pre>
          </div>
        </div>
      </div>

      <div
        className={`step-box cmd-box cmd-result-box ${errCls} ${outCap.expanded ? 'is-expanded' : ''}`}
        data-testid="cmd-result-box"
        data-box-kind="command"
      >
        <div className="step-box-head">
          <span className="cmd-box-label">RESPONSE</span>
          <span className="grow" />
          {failed && (
            <span className="step-box-meta cmd-box-err-meta">
              {parsed.exitCode !== undefined ? `exit ${parsed.exitCode}` : 'failed'}
            </span>
          )}
          <span className="step-box-actions">
            {failed && !running && (
              <BoxButton
                icon={<Wrench size={11} />}
                label="Fix error"
                tip="Put this failed command, output, and uncommitted git diff into the message box"
                testId="cmd-box-fix-error"
                onClick={() =>
                  void triggerFixError({
                    source: 'command',
                    title: parsed.headerTitle || 'Command',
                    command: parsed.command,
                    exitCode: parsed.exitCode,
                    output: formattedOutput || item.title,
                    projectId,
                  })
                }
              />
            )}
            {parsed.truncatedOutputPath && (
              <BoxButton
                icon={<SquareArrowOutUpRight size={11} />}
                label="Full output"
                tip="Open the full untruncated output file in the side panel"
                testId="cmd-box-full-output"
                onClick={() => openFile(parsed.truncatedOutputPath!)}
              />
            )}
            {formattedOutput && (
              <CopyBoxButton text={formattedOutput} label="Copy" tip="Copy the response" testId="cmd-box-copy-out" />
            )}
            {(outCap.overflows || outCap.expanded) && (
              <ExpandBoxButton expanded={outCap.expanded} onToggle={outCap.toggle} testId="cmd-result-expand" />
            )}
          </span>
        </div>
        <div className="step-box-body mono">
          <div ref={outCap.innerRef} className="step-box-inner">
            {formattedOutput ? (
              <pre className={`step-box-pre cmd-terminal-out ${failed ? 'err' : ''}`}>
                {resultLang ? (
                  <>
                    <HighlightedCode
                      text={clippedOutput}
                      lang={resultLang.lang}
                      gutters={resultLang.gutters}
                      perLine={resultLang.perLine}
                    />
                    {clipNote && <span className="hl-m">{clipNote}</span>}
                  </>
                ) : (
                  <LinkedText text={shownOutput} />
                )}
              </pre>
            ) : running ? (
              <div className="cmd-terminal-empty mono live">
                <Loader2 size={12} className="spin" />
                <span>Running…</span>
              </div>
            ) : item.status === 'interrupted' ? (
              <div className="cmd-terminal-empty mono">Stopped before completion</div>
            ) : (
              <div className={`cmd-terminal-empty mono ${failed ? 'err' : ''}`}>
                {failed
                  ? parsed.exitCode !== undefined
                    ? `Exited with code ${parsed.exitCode} — no output`
                    : 'Command failed — no output'
                  : 'No output'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface ToolRowProps {
  item: ToolItem;
  /** Opens this row by default unless the user explicitly collapses it. */
  defaultOpen?: boolean;
  /** Renders as a standalone single-step card without an outer `ToolGroup` wrapper header. */
  standalone?: boolean;
  /** True when this step belongs to the currently active turn. */
  live?: boolean;
  /** Token estimate displayed on standalone single-step cards. */
  tokens?: number;
  /** Invoked right before a manual user toggle so a parent `ToolGroup` can pin its own open state if needed. */
  onBeforeToggle?: () => void;
}

/**
 * Renders a tool call card (`standalone`) or a step row inside a multi-step `WorkGroup`.
 * - Shell commands render in authentic terminal monospace font (`$ command`) with an embedded console view.
 * - File-touching steps render inline visual previews for images, videos, audio, PDFs, and Office documents.
 */
export const ToolRow = memo(function ToolRow({ item, defaultOpen, standalone, live, tokens, onBeforeToggle }: ToolRowProps) {
  const [choice, setChoice] = useStepChoice(`tool:${item.id}`);
  const openFile = useOpenFile();

  const parsed = parseToolStep(item);
  const running = item.status === 'pending' || item.status === 'in_progress';
  const badExit = parsed.exitCode !== undefined && parsed.exitCode !== 0;
  const failed = item.status === 'failed' || badExit;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const durLabel = running
    ? fmtStepDuration(Math.max(0, now - item.ts))
    : fmtStepDuration(parsed.durationMs);

  const diffs = item.content.filter((c) => c.type === 'diff');
  const stepPaths = parsed.isCommand ? [] : extractStepFilePaths(item.locations, parsed.input);
  const hasRich = item.content.some((c) => c.rich);
  const identity = toolIdentityLabel(item.identity, `${item.title} ${parsed.toolLabel}`);
  const hasBody =
    parsed.isCommand ||
    hasRich ||
    Boolean(item.locationRefs?.length) ||
    diffs.length > 0 ||
    Boolean(parsed.output) ||
    Boolean(parsed.input) ||
    stepPaths.length > 0;

  const open = choice ?? Boolean(defaultOpen);
  const toggleOpen = () => {
    onBeforeToggle?.();
    setChoice(!open);
  };
  const stepKind = toolStepKind(item, parsed);

  const innerCls = `tool-row ${parsed.isCommand ? 'is-cmd' : ''} ${failed ? 'is-failed' : ''} ${open ? 'is-open' : ''}`;
  const headNode = (
    <StepRowHead
      item={item}
      parsed={parsed}
      running={running}
      live={live}
      failed={failed}
      hasBody={parsed.isCommand ? true : hasBody}
      durLabel={durLabel}
      onToggle={toggleOpen}
    />
  );

  const bodyNode = parsed.isCommand
    ? open &&
      (item.terminalKey ? (
        <AcpTerminalBox
          termKey={item.terminalKey}
          command={parsed.command}
          fallbackOutput={parsed.output}
          fallbackExitCode={parsed.exitCode}
          toolStatus={item.status}
          standalone={standalone}
        />
      ) : (
        <CommandTerminalBox item={item} parsed={parsed} standalone={standalone} running={running} failed={failed} />
      ))
    : open &&
      hasBody && (
        <div className={`tool-body step-boxes ${standalone ? 'standalone' : ''}`} data-testid="step-boxes">
          {identity && (
            <div className="rich-tool-identity mono small muted" data-testid="tool-identity">
              {identity}
            </div>
          )}
          {item.locationRefs?.length ? <LocationLinks locations={item.locationRefs} /> : null}
          <StepBody item={item} parsed={parsed} kind={stepKind} diffs={diffs} stepPaths={stepPaths} running={running} />
          {hasRich && <ToolRichContent entries={item.content} />}
        </div>
      );

  if (!standalone) {
    return (
      <div className={innerCls} data-testid={parsed.isCommand ? 'tool-row-cmd' : 'tool-row'} data-step-kind={stepKind}>
        {headNode}
        {bodyNode}
      </div>
    );
  }

  return (
    <div
      className={`tool-group tool-single work-group ${parsed.isCommand ? 'is-cmd' : ''} ${failed ? 'is-failed has-failed' : ''} ${running && live ? 'is-live' : ''}`}
      data-testid={parsed.isCommand ? 'tool-row-cmd' : 'tool-row'}
      data-step-kind={stepKind}
    >
      <div className="tool-group-body work-group-body">
        <div className={`wg-step ${running ? 'wg-step-running' : failed ? 'wg-step-failed' : ''}`}>
          <span className="wg-step-icon">{running ? <Loader2 size={13} className="spin" /> : <StepIcon kind={stepKind} size={14} />}</span>
          <div className={innerCls}>
            {headNode}
            {bodyNode}
          </div>
        </div>
      </div>
    </div>
  );
});
