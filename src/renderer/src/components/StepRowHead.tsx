import { useContext } from 'react';
import { ChevronRight } from 'lucide-react';
import { RefBaseContext } from '../fileLinks';
import type { ParsedToolStep, ToolItem } from '../toolStep';
import { describeToolAction } from '../workStepSummary';

/**
 * The one-line header of a tool step inside a `WorkGroup`: verb (`Ran`, `Read`, `Edited`, … / `Running` while live)
 * + target (command in mono, file name with its folder dimmed). The right side stays empty except a timer while
 * running, the duration on hover (CSS), and a red `exit N` / `Failed` when the step failed.
 */
export function StepRowHead({
  item,
  parsed,
  running,
  live,
  failed,
  hasBody,
  durLabel,
  onToggle,
}: {
  item: ToolItem;
  parsed: ParsedToolStep;
  running: boolean;
  live?: boolean;
  failed: boolean;
  hasBody: boolean;
  durLabel: string;
  onToggle: () => void;
}) {
  const base = useContext(RefBaseContext);
  const action = describeToolAction(item, running, base);
  const failLabel = parsed.isCommand && parsed.exitCode !== undefined && parsed.exitCode !== 0 ? `exit ${parsed.exitCode}` : 'Failed';

  return (
    <div className="tool-row-head" onClick={() => hasBody && onToggle()}>
      <span className={`tool-badge wg-verb ${running && live ? 'shimmer' : ''}`}>{action.verb}</span>
      {action.target ? (
        <span className={`grow ellipsis tool-row-title ${action.mono ? 'mono' : 'human'} ${parsed.isCommand ? 'cmd-term-title' : ''}`}>
          {action.target}
          {action.dir && <span className="tool-sub-target"> {action.dir}</span>}
        </span>
      ) : (
        <span className="grow" />
      )}
      {durLabel && <span className="tool-dur">{durLabel}</span>}
      {failed && <span className="cmd-exit bad">{failLabel}</span>}
      {!failed && item.status === 'interrupted' && <span className="status-pill">Stopped</span>}
      {hasBody && <ChevronRight size={13} className="wg-row-chev" />}
    </div>
  );
}
