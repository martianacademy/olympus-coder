import { useEffect, useState } from 'react';
import { Brain, FileCode, FolderOpen, GitBranch, Laptop, RotateCw } from 'lucide-react';
import type { AgentDef, AgentStatus, GitStatus, MemoryView, PortInfo, Project, SessionView, Thread } from '@shared/types';
import { api } from '../api';
import { useModelTags } from '../modelTags';
import { PanelSkeleton } from './Skeleton';
import { AgentLogo } from '../logos';
import { isRemoteBrowser } from '../responsive';
import { lastTurnTimestamp, threadHasConversation } from '@shared/freshCarryover';
import { canCompact, CompactButton, isCompacting } from './CompactButton';
import { FreshContextButton } from './FreshContextButton';
import { McpStatusSection } from './McpStatusSection';
import { usePromptQueue } from '../promptQueueApi';
import { SessionStats } from './TokenStats';
import { LimitBars, LimitsFreshness } from './Usage';
import { VerifyGateSection } from './VerifyGateSection';
import { WorktreeSection } from './WorktreeSection';
import { parseWorktreeProjectId } from '@shared/worktree';
import type { WorkbenchTab } from './Workbench';

/** "Compact context" + universal "Fresh context" under the context ring in the Info panel. */
function InfoContextActions({ thread, session }: { thread: Thread; session: SessionView | null }) {
  const queue = usePromptQueue(thread.id);
  const compacting = isCompacting(thread.items, session?.status === 'running');
  const supportsCompact = canCompact(session);
  const hasHistory = threadHasConversation(thread.items);
  if (!supportsCompact && !hasHistory) return null;
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {supportsCompact && <CompactButton threadId={thread.id} session={session} compacting={compacting} queue={queue} variant="full" />}
      <FreshContextButton
        threadId={thread.id}
        session={session}
        hasHistory={hasHistory}
        lastTurnTs={lastTurnTimestamp(thread.items)}
        hasCompactNotice={supportsCompact}
        variant="full"
      />
    </div>
  );
}

/** Ports in use on this machine, programs Olympus started first, each with Stop (asked once inline). */
function PortsCard() {
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState('');
  const load = () => void api.ports().then(setPorts).catch(() => setPorts([]));
  useEffect(load, []);

  const stop = async (p: PortInfo) => {
    setError('');
    try {
      await api.stopPort(p.pid);
      setConfirm(null);
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  const [all, setAll] = useState(false);
  const list = (ports ?? []).filter((p) => !p.self);
  const shown = all ? list : list.slice(0, 6);

  return (
    <div className="info-section">
      <div className="info-title row" style={{ gap: 6 }}>
        Ports in use
        <span className="grow" />
        <button className="btn ghost icon" title="Refresh" onClick={load}>
          <RotateCw size={12} />
        </button>
      </div>
      {ports === null && <PanelSkeleton rows={3} head={false} />}
      {ports !== null && !list.length && <div className="small muted">No program is listening on a port.</div>}
      {shown.map((p) => (
        <div key={`${p.pid}:${p.port}`} className="info-row port-row" title={`${p.command}\npid ${p.pid} · ${p.address}`}>
          <span className="port-num mono">:{p.port}</span>
          <span className="ellipsis grow">
            {p.name}
            {p.startedHere && <span className="port-here">started here</span>}
          </span>
          {confirm === p.pid ? (
            <>
              <button className="btn small ghost" onClick={() => setConfirm(null)}>
                Keep
              </button>
              <button className="btn small danger" onClick={() => void stop(p)}>
                Stop {p.name}
              </button>
            </>
          ) : (
            <button className="btn ghost small port-stop" onClick={() => (p.startedHere ? void stop(p) : setConfirm(p.pid))} title={`Stop ${p.name} (pid ${p.pid})`}>
              Stop
            </button>
          )}
        </div>
      ))}
      {list.length > shown.length && (
        <button className="btn ghost small muted" onClick={() => setAll(true)}>
          Show {list.length - shown.length} more
        </button>
      )}
      {error && <div className="small error-text">{error}</div>}
    </div>
  );
}

const OUTPUTS_SHOWN = 10;
/** Tool kinds that write files (ACP), for tools that report a location but no diff. */
const WRITE_KINDS = new Set(['edit', 'delete', 'move']);

export function InfoPanel(props: {
  project: Project;
  thread: Thread | null;
  agentDef?: AgentDef;
  /** Every agent, so per-agent rows in this chat's stats show each agent's logo. */
  agentDefs?: Record<string, AgentDef>;
  agentStatus?: AgentStatus;
  session: SessionView | null;
  git: GitStatus | null;
  refreshKey: number;
  onOpenFile: (p: string) => void;
  onTab: (t: WorkbenchTab) => void;
  onThreadChanged?: () => void;
}) {
  const remote = isRemoteBrowser();
  const tags = useModelTags();
  const [mem, setMem] = useState<MemoryView | null>(null);
  // A worktree chat's panels get the virtual project id (`<projectId>__wt_<threadId>`); shared memory stays the
  // base project's.
  const memoryProjectId = parseWorktreeProjectId(props.project.id)?.projectId ?? props.project.id;
  useEffect(() => {
    void api.memory(memoryProjectId).then(setMem);
  }, [memoryProjectId, props.refreshKey]);

  // Files the agent changed or created in this chat (not ones it only read), newest first.
  const outputs = [
    ...new Set(
      (props.thread?.items ?? [])
        .flatMap((i) => {
          if (i.kind !== 'tool') return [];
          const diffs = i.content.filter((c) => c.type === 'diff' && c.path).map((c) => c.path!);
          return diffs.length ? diffs : WRITE_KINDS.has(i.toolKind ?? '') ? i.locations : [];
        })
        .reverse(),
    ),
  ].map((p) => (p.startsWith(`${props.project.path}/`) ? p.slice(props.project.path.length + 1) : p));
  const [allOutputs, setAllOutputs] = useState(false);
  const shownOutputs = allOutputs ? outputs : outputs.slice(0, OUTPUTS_SHOWN);

  const model = props.session?.configOptions.find((o) => o.category === 'model');

  return (
    <div className="info-panel">
      <div className="info-section">
        <div className="info-title">Environment</div>
        <div className="info-row">
          <Laptop size={15} className="muted" /> {remote ? 'Your Mac (remote)' : 'This computer'}
        </div>
        <div
          className={`info-row ${remote ? '' : 'link-like'}`}
          onClick={remote ? undefined : () => void api.revealProject(props.project.id)}
          title={props.project.path}
        >
          <FolderOpen size={15} className="muted" /> <span className="ellipsis">{props.project.name}</span>
          <span className="small muted ellipsis">{props.project.path.replace(/^\/Users\/[^/]+/, '~')}</span>
        </div>
        {props.agentDef && (
          <div className="info-row">
            <AgentLogo def={props.agentDef} size={18} />
            {props.agentDef.name}
            {model && <span className="small muted">· {model.options.find((x) => x.value === model.currentValue)?.name}</span>}
            <span className={`dot ${props.session?.status === 'running' ? 'starting' : props.agentStatus?.state ?? 'unknown'}`} style={{ marginLeft: 'auto' }} />
          </div>
        )}
      </div>
      <McpStatusSection threadId={props.thread?.id} />
      {props.thread && (
        <div className="info-section">
          <div className="info-title">Tokens in this chat</div>
          <SessionStats
            thread={props.thread}
            usage={props.session?.usage}
            modelValue={model?.currentValue}
            tags={tags}
            agentDefs={{ ...(props.agentDefs ?? {}), ...(props.agentDef ? { [props.agentDef.id]: props.agentDef } : {}) }}
            action={<InfoContextActions thread={props.thread} session={props.session} />}
          />
        </div>
      )}
      {(props.agentStatus?.plan || props.agentStatus?.limits?.length) && (
        <div className="info-section">
          <div className="info-title">Plan{props.agentStatus?.plan ? ` · ${props.agentStatus.plan}` : ''}</div>
          {props.agentStatus?.limits?.length ? <LimitBars limits={props.agentStatus.limits} /> : <div className="small muted">{props.agentStatus?.limitsNote ?? 'This agent does not report its limits.'}</div>}
          {props.agentStatus?.limits?.length && props.agentStatus.limitsNote ? <div className="small muted">{props.agentStatus.limitsNote}</div> : null}
          <LimitsFreshness status={props.agentStatus} agentName={props.agentDef?.name} />
        </div>
      )}
      {props.git?.isRepo && (
        <div className="info-section">
          <div className="info-title">Git</div>
          <div className="info-row link-like" onClick={() => props.onTab('git')}>
            <GitBranch size={15} className="muted" /> {props.git.branch}
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              {props.git.files.length} changes{props.git.ahead ? ` · ↑${props.git.ahead}` : ''}
              {props.git.behind ? ` · ↓${props.git.behind}` : ''}
            </span>
          </div>
        </div>
      )}
      <div className="info-section">
        <div className="info-title">Shared memory</div>
        <div className={`info-row ${remote ? '' : 'link-like'}`} onClick={remote ? undefined : () => void api.revealMemory(memoryProjectId)}>
          <Brain size={15} className="muted" /> {mem ? `${mem.files.filter((f) => f.name !== 'MEMORY.md').length} memories` : '…'}
          {!remote && (
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              Open folder
            </span>
          )}
        </div>
        {mem?.index && <pre className="info-pre">{mem.index.replace(/^# Shared memory index[\s\S]*?\n\n(?:One line[^\n]*\n\n)?/, '').trim() || '(empty)'}</pre>}
      </div>
      <PortsCard />
      {props.thread?.worktree && (
        <WorktreeSection
          thread={props.thread}
          running={props.session?.status === 'running'}
          refreshKey={props.refreshKey}
          onOpenFile={props.onOpenFile}
          onThreadChanged={props.onThreadChanged}
        />
      )}
      {props.project.id !== 'general' && <VerifyGateSection project={props.project} />}
      <div className="info-section">
        <div className="info-title row">
          <span className="grow">Changed files</span>
          {outputs.length > 0 && <span className="info-count" data-testid="outputs-count">{outputs.length}</span>}
        </div>
        {outputs.length ? (
          <div className="info-files" data-testid="outputs-list">
            {shownOutputs.map((p) => (
              <button key={p} className="info-file" onClick={() => props.onOpenFile(p)} title={p}>
                <FileCode size={14} className="info-file-icon" />
                <span className="info-file-name ellipsis">{p.split('/').pop()}</span>
                <span className="info-file-dir ellipsis">{p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}</span>
              </button>
            ))}
            {outputs.length > OUTPUTS_SHOWN && (
              <button className="info-more" onClick={() => setAllOutputs((a) => !a)} data-testid="outputs-more">
                {allOutputs ? 'Show fewer' : `Show all ${outputs.length}`}
              </button>
            )}
          </div>
        ) : (
          <div className="small muted">The agent has not changed any files in this chat yet.</div>
        )}
      </div>
    </div>
  );
}
