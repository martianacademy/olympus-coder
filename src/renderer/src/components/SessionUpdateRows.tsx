import { memo } from 'react';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, CircleSlash, ExternalLink, FileText, Info, ListChecks, Loader2, Shrink } from 'lucide-react';
import type { ThreadItem } from '@shared/types';
import { api } from '../api';
import { useOpenFile } from '../fileLinks';
import { useStepChoice } from '../prefs';
import { isRemoteBrowser } from '../responsive';
import { fmtStepDuration } from '../toolStep';
import { Markdown } from './ChatMarkdown';
import '../sessionUpdates.css';

type NoticeItem = Extract<ThreadItem, { kind: 'notice' }>;
type CompactionItem = Extract<ThreadItem, { kind: 'compaction' }>;
type PlanDocItem = Extract<ThreadItem, { kind: 'plan-doc' }>;

const SEVERITY_ICON = { info: Info, warning: AlertTriangle, error: AlertCircle } as const;

/** A notice from the agent (ACP `notice`): one quiet line, tinted only for warnings and errors. */
export const NoticeRow = memo(function NoticeRow({ item }: { item: NoticeItem }) {
  const severity: keyof typeof SEVERITY_ICON = item.severity === 'warning' || item.severity === 'error' ? item.severity : 'info';
  const Icon = SEVERITY_ICON[severity];
  return (
    <div className={`acp-notice sev-${severity}`} data-testid="notice" data-severity={severity} role={severity === 'error' ? 'alert' : 'status'}>
      <Icon size={14} className="acp-notice-icon" aria-hidden="true" />
      <div className="acp-notice-text">
        <span className="acp-notice-title">{item.title}</span>
        {item.description && <span className="acp-notice-desc">{item.description}</span>}
      </div>
    </div>
  );
});

const COMPACTION_LABEL: Record<string, string> = {
  completed: 'Context compacted',
  failed: 'Context compaction failed',
  cancelled: 'Context compaction cancelled',
};

/** The agent compacting its context: "Compacting context…", then the outcome, with the summary one click away. */
export const CompactionRow = memo(function CompactionRow({ item }: { item: CompactionItem }) {
  const [choice, setChoice] = useStepChoice(`compaction:${item.id}`);
  const open = choice ?? false;
  const label = COMPACTION_LABEL[item.status];
  const running = !label;
  const took = item.endedAt ? fmtStepDuration(item.endedAt - item.ts) : '';
  const icon = running ? (
    <Loader2 size={13} className="spin" />
  ) : item.status === 'failed' ? (
    <AlertCircle size={13} />
  ) : item.status === 'cancelled' ? (
    <CircleSlash size={13} />
  ) : (
    <Shrink size={13} />
  );
  const head = (
    <>
      <span className="compaction-icon">{icon}</span>
      <span className={running ? 'shimmer' : ''}>{label ?? 'Compacting context…'}</span>
      {took && <span className="compaction-meta">{took}</span>}
      {item.summary && (open ? <ChevronDown size={13} className="compaction-chev" /> : <ChevronRight size={13} className="compaction-chev" />)}
    </>
  );
  return (
    <div className={`compaction s-${running ? 'running' : item.status}`} data-testid="compaction" data-status={item.status}>
      {item.summary ? (
        <button
          type="button"
          className="compaction-head"
          aria-expanded={open}
          title={open ? 'Hide what the agent kept' : 'Show what the agent kept'}
          onClick={() => setChoice(!open)}
          data-testid="compaction-toggle"
        >
          {head}
        </button>
      ) : (
        <div className="compaction-head">{head}</div>
      )}
      {item.error && <div className="compaction-error">{item.error}</div>}
      {open && item.summary && (
        <div className="compaction-summary msg-agent" data-testid="compaction-summary">
          <Markdown text={item.summary} />
        </div>
      )}
    </div>
  );
});

/** Local path of a `file:` URI, or undefined for other schemes. */
function filePath(uri: string): string | undefined {
  if (!/^file:/i.test(uri)) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

/** A plan the agent sent as a document (ACP `plan_update` markdown / file), e.g. the plan approved in plan mode. */
export const PlanDocBlock = memo(function PlanDocBlock({ item, agentName }: { item: PlanDocItem; agentName?: string }) {
  const [choice, setChoice] = useStepChoice(`plandoc:${item.id}`);
  const open = choice ?? true;
  const openFile = useOpenFile();
  const path = item.uri ? filePath(item.uri) : undefined;
  const web = item.uri && /^https?:\/\//i.test(item.uri) ? item.uri : undefined;
  const name = path ? path.split(/[\\/]/).pop() || path : item.uri;
  const openLink = () => {
    if (path) openFile(path);
    else if (web) {
      if (isRemoteBrowser()) window.open(web, '_blank', 'noopener,noreferrer');
      else void api.openExternal(web);
    }
  };
  return (
    <div className="plan-doc msg-wrap" data-testid="plan-doc" data-format={item.format}>
      <div className="plan-doc-head">
        <ListChecks size={14} className="plan-doc-icon" aria-hidden="true" />
        <span className="plan-doc-label">Plan</span>
        {agentName && <span className="plan-doc-from ellipsis">from {agentName}</span>}
        <span className="grow" />
        {item.format === 'markdown' && (
          <button
            type="button"
            className="btn ghost icon plan-doc-toggle"
            title={open ? 'Collapse plan' : 'Expand plan'}
            aria-expanded={open}
            onClick={() => setChoice(!open)}
            data-testid="plan-doc-toggle"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </div>
      {item.format === 'markdown' ? (
        open && (
          <div className="plan-doc-body msg-agent">
            <Markdown text={item.content ?? ''} />
          </div>
        )
      ) : path || web ? (
        <button type="button" className="plan-doc-file" title={`Open ${path ?? web}`} onClick={openLink} data-testid="plan-doc-file">
          {path ? <FileText size={14} /> : <ExternalLink size={14} />}
          <span className="plan-doc-file-name ellipsis">{name}</span>
          {path && <span className="plan-doc-file-path ellipsis">{path}</span>}
        </button>
      ) : (
        <div className="plan-doc-file is-static">
          <FileText size={14} />
          <span className="plan-doc-file-name ellipsis">{item.uri}</span>
        </div>
      )}
    </div>
  );
});
