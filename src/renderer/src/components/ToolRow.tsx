import { memo, useContext, useEffect, useMemo, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
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
} from 'lucide-react';
import { formatBashCommand, formatCommandResult } from '../cmdFormat';
import { HighlightedCode } from '../codeHighlight';
import { detectResultLang } from '../codeLang';
import { LinkedText, RunCommandContext, useOpenFile } from '../fileLinks';
import { useStepChoice } from '../prefs';
import { fmtTokens } from '../tokens';
import { fmtStepDuration, parseToolStep, type ParsedToolStep, type ToolItem } from '../toolStep';
import { describeToolForHeader } from '../workStepSummary';
import { extractStepFilePaths } from './InlineFilePreviews';
import { AcpTerminalBox } from './AcpTerminalBox';
import { toolIdentityLabel } from '@shared/acpContent';
import { LocationLinks, ToolRichContent } from './RichContent';
import { StepBody } from './StepBodies';
import { StepRowHead } from './StepRowHead';
import { BoxButton, CopyBoxButton, ExpandBoxButton, STEP_BOX_CAP, useBodyCap } from './StepBox';
import { StepIcon, stepKindColor, toolStepKind } from './stepIcons';

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
          <span className="cmd-box-label">BASH</span>
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
          <span className="cmd-box-label">RESULT</span>
          <span className="grow" />
          {failed && (
            <span className="step-box-meta cmd-box-err-meta">
              {parsed.exitCode !== undefined ? `exit ${parsed.exitCode}` : 'failed'}
            </span>
          )}
          <span className="step-box-actions">
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
              <CopyBoxButton text={formattedOutput} label="Copy" tip="Copy result output" testId="cmd-box-copy-out" />
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
  const kind = stepKindColor(stepKind);
  const file = stepPaths[0] ?? diffs.find((c) => c.path)?.path;
  const statusClass = badExit && item.status === 'completed' ? 'failed' : item.status;
  const chevSize = standalone ? 14 : 13;

  const rootCls = standalone
    ? `tool-group tool-single ${parsed.isCommand ? 'is-cmd' : ''} ${failed ? 'is-failed' : ''}`
    : `tool-row ${parsed.isCommand ? 'is-cmd' : ''} ${failed ? 'is-failed' : ''} ${open ? 'is-open' : ''}`;
  const headCls = `tool-row-head ${standalone ? 'standalone' : ''}`;

  if (parsed.isCommand) {
    const cmdLine = parsed.headerTitle || parsed.command || 'command';

    return (
      <div className={rootCls} data-testid="tool-row-cmd">
        {/* Inside a WorkGroup: the calm verb + target line; standalone cards keep the full header below. */}
        {!standalone ? (
          <StepRowHead
            item={item}
            parsed={parsed}
            running={running}
            live={live}
            failed={failed}
            hasBody={true}
            durLabel={durLabel}
            onToggle={toggleOpen}
          />
        ) : (
        <div className={headCls} onClick={toggleOpen}>
          <span className="tool-kind k-execute">
            {running ? <Loader2 size={13} className="spin" /> : <SquareTerminal size={13} />}
          </span>
          <span className="tool-badge k-execute mono">{parsed.toolLabel}</span>
          <span className={`grow ellipsis tool-row-title mono cmd-term-title ${running && live ? 'shimmer' : ''}`}>
            <span className="cmd-dollar">$ </span>
            {cmdLine}
            {parsed.summary && <span className="cmd-comment">  # {parsed.summary}</span>}
          </span>
          {standalone && tokens !== undefined && <TokenTag n={tokens} live={Boolean(live && running)} />}
          {durLabel && <span className="tool-dur mono">{durLabel}</span>}
          {parsed.exitCode !== undefined ? (
            <span className={`cmd-exit mono ${badExit ? 'bad' : 'ok'}`}>exit {parsed.exitCode}</span>
          ) : item.status === 'failed' ? (
            <span className="cmd-exit mono bad">failed</span>
          ) : null}
          {standalone && item.status === 'interrupted' && (
            <span className="status-pill" title={STATUS_TIP.interrupted}>
              stopped
            </span>
          )}
          <span className={`tool-status ${statusClass}`} />
          {open ? <ChevronDown size={chevSize} className="muted" /> : <ChevronRight size={chevSize} className="muted" />}
        </div>
        )}

        {open &&
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
          ))}
      </div>
    );
  }

  const desc = describeToolForHeader(item, parsed);
  const rawPrimary = parsed.summary || desc.params || parsed.headerTitle;
  const showPrimary = Boolean(rawPrimary && rawPrimary.toLowerCase() !== parsed.toolLabel.toLowerCase());
  const subTarget = desc.params || parsed.headerTitle;
  const showSubTarget = Boolean(
    parsed.summary &&
      subTarget &&
      subTarget.toLowerCase() !== parsed.summary.toLowerCase() &&
      subTarget.toLowerCase() !== parsed.toolLabel.toLowerCase(),
  );

  return (
    <div className={rootCls} data-testid="tool-row" data-step-kind={stepKind}>
      {!standalone ? (
        <StepRowHead
          item={item}
          parsed={parsed}
          running={running}
          live={live}
          failed={failed}
          hasBody={hasBody}
          durLabel={durLabel}
          onToggle={toggleOpen}
        />
      ) : (
      <div className={headCls} onClick={() => hasBody && toggleOpen()}>
        <span className={`tool-kind k-${kind}`}>
          {running ? <Loader2 size={13} className="spin" /> : <StepIcon kind={stepKind} size={13} />}
        </span>
        <span className={`tool-badge k-${kind}`}>{parsed.toolLabel}</span>
        {showPrimary ? (
          <span
            className={`grow tool-row-title ${!parsed.summary && desc.isMono ? 'mono ellipsis' : 'human'} ${running && live ? 'shimmer' : ''}`}
          >
            {rawPrimary}
            {showSubTarget && <span className="tool-sub-target mono"> · {subTarget}</span>}
          </span>
        ) : (
          <span className="grow" />
        )}
        {standalone && tokens !== undefined && <TokenTag n={tokens} live={Boolean(live && running)} />}
        {durLabel && <span className="tool-dur">{durLabel}</span>}
        {file && (
          <button
            className="btn ghost icon tool-open"
            title={`Open ${file} in the side panel`}
            onClick={(e) => {
              e.stopPropagation();
              openFile(file);
            }}
          >
            <FileText size={13} />
          </button>
        )}
        {standalone && item.status === 'interrupted' && (
          <span className="status-pill" title={STATUS_TIP.interrupted}>
            stopped
          </span>
        )}
        <span className={`tool-status ${statusClass}`} />
        {hasBody && (open ? <ChevronDown size={chevSize} className="muted" /> : <ChevronRight size={chevSize} className="muted" />)}
      </div>
      )}
      {open && hasBody && (
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
      )}
    </div>
  );
});
