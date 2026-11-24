import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, ArrowUp, ChevronDown, Flame, Folder, FolderPlus, ShieldCheck } from 'lucide-react';
import { DEFAULT_MAX_EFFORT, normalizeMaxEffort, pickDefaultCriticAgent } from '@shared/maxEffort';
import type { AgentDef, AgentStatus, AttachmentView, MaxEffortSettings, Project, ThreadMeta } from '@shared/types';
import type { AgentsInfo } from '../App';
import { useDraft } from '../drafts';
import { useOpenFile } from '../fileLinks';
import { AgentLogo } from '../logos';
import { enterSends } from '../platform';
import { AttachButton, AttachmentChips, useAttachments } from './Attachments';
import '../maxEffort.css';

const MAX_DRAFT_KEY = '__max_home__';
const ROUND_OPTIONS = [1, 2, 3, 4] as const;
const WATCHDOG_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 120, label: '2m watchdog' },
  { seconds: 180, label: '3m watchdog' },
  { seconds: 300, label: '5m watchdog' },
  { seconds: 0, label: 'Watchdog off' },
];

/**
 * Compact Dual-Mind configuration strip shown in Max mode headers and on the Max start screen:
 * Lead Solver picker ⇄ Adversarial Critic picker, Critique Rounds (1–4), and Stuck-Thinking Watchdog.
 */
export function MaxEffortBar(props: {
  defs: AgentDef[];
  statuses: Record<string, AgentStatus>;
  solverId: string;
  config?: Partial<MaxEffortSettings>;
  disabled?: boolean;
  onChangeSolver: (agentId: string) => void;
  onChangeConfig: (patch: Partial<MaxEffortSettings>) => void;
}) {
  const [openMenu, setOpenMenu] = useState<'solver' | 'critic' | 'rounds' | 'watchdog' | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  const normalized = normalizeMaxEffort(props.config, DEFAULT_MAX_EFFORT);
  const criticId = useMemo(() => {
    if (normalized.criticAgentId && props.defs.some((d) => d.id === normalized.criticAgentId)) return normalized.criticAgentId;
    return pickDefaultCriticAgent(props.solverId, props.defs, props.statuses);
  }, [normalized.criticAgentId, props.solverId, props.defs, props.statuses]);

  const solverDef = props.defs.find((d) => d.id === props.solverId) ?? props.defs[0];
  const criticDef = props.defs.find((d) => d.id === criticId) ?? props.defs[0];

  const swap = () => {
    if (props.disabled || !criticDef || !solverDef) return;
    const prevSolver = solverDef.id;
    props.onChangeSolver(criticDef.id);
    props.onChangeConfig({ criticAgentId: prevSolver });
  };

  const wdLabel =
    normalized.watchdogSeconds <= 0 ? 'Off' : `${Math.round(normalized.watchdogSeconds / 60)}m`;

  return (
    <div className="max-bar" ref={wrapRef} data-testid="max-effort-bar">
      <div className="picker">
        <button
          type="button"
          className="max-role-pill"
          disabled={props.disabled}
          title="Lead Solver — proposes solutions and executes the final verified plan"
          onClick={() => setOpenMenu(openMenu === 'solver' ? null : 'solver')}
          data-testid="max-solver-picker"
        >
          <span className="max-role-tag">Solver</span>
          {solverDef && <AgentLogo def={solverDef} size={16} />}
          <span className="max-role-name">{solverDef?.name ?? props.solverId}</span>
          <ChevronDown size={12} className="muted" />
        </button>
        {openMenu === 'solver' && (
          <div className="menu">
            {props.defs.map((d) => (
              <div
                key={d.id}
                className={`menu-item ${d.id === props.solverId ? 'active' : ''}`}
                onClick={() => {
                  props.onChangeSolver(d.id);
                  setOpenMenu(null);
                }}
              >
                <AgentLogo def={d} size={18} />
                <span className="grow ellipsis">{d.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="max-swap-btn"
        disabled={props.disabled}
        title="Swap Lead Solver and Mind-Critic"
        aria-label="Swap Lead Solver and Mind-Critic"
        onClick={swap}
        data-testid="max-swap-agents"
      >
        <ArrowLeftRight size={13} />
      </button>

      <div className="picker">
        <button
          type="button"
          className="max-role-pill"
          disabled={props.disabled}
          title="Adversarial Mind-Critic — inspects raw thinking to catch silent leaps and rescue discarded sparks"
          onClick={() => setOpenMenu(openMenu === 'critic' ? null : 'critic')}
          data-testid="max-critic-picker"
        >
          <span className="max-role-tag">Critic</span>
          {criticDef && <AgentLogo def={criticDef} size={16} />}
          <span className="max-role-name">{criticDef?.name ?? criticId}</span>
          <ChevronDown size={12} className="muted" />
        </button>
        {openMenu === 'critic' && (
          <div className="menu">
            {props.defs.map((d) => (
              <div
                key={d.id}
                className={`menu-item ${d.id === criticId ? 'active' : ''}`}
                onClick={() => {
                  props.onChangeConfig({ criticAgentId: d.id });
                  setOpenMenu(null);
                }}
              >
                <AgentLogo def={d} size={18} />
                <span className="grow ellipsis">{d.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="picker">
        <button
          type="button"
          className="max-meta-pill"
          disabled={props.disabled}
          title="Maximum adversarial mind-critique rounds after the initial blind pass (stops early once both converge)"
          onClick={() => setOpenMenu(openMenu === 'rounds' ? null : 'rounds')}
          data-testid="max-rounds-picker"
        >
          Rounds <b>{normalized.maxRounds}</b>
          <ChevronDown size={11} />
        </button>
        {openMenu === 'rounds' && (
          <div className="menu">
            {ROUND_OPTIONS.map((n) => (
              <div
                key={n}
                className={`menu-item ${normalized.maxRounds === n ? 'active' : ''}`}
                onClick={() => {
                  props.onChangeConfig({ maxRounds: n });
                  setOpenMenu(null);
                }}
              >
                {n} critique {n === 1 ? 'round' : 'rounds'}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="picker">
        <button
          type="button"
          className="max-meta-pill"
          disabled={props.disabled}
          title="Stuck-Thinking Watchdog — interrupts runaway solo thinking loops and hands partial raw thinking to the peer critic"
          onClick={() => setOpenMenu(openMenu === 'watchdog' ? null : 'watchdog')}
          data-testid="max-watchdog-picker"
        >
          <ShieldCheck size={12} /> Watchdog <b>{wdLabel}</b>
        </button>
        {openMenu === 'watchdog' && (
          <div className="menu">
            {WATCHDOG_OPTIONS.map((w) => (
              <div
                key={w.seconds}
                className={`menu-item ${normalized.watchdogSeconds === w.seconds ? 'active' : ''}`}
                onClick={() => {
                  props.onChangeConfig({ watchdogSeconds: w.seconds });
                  setOpenMenu(null);
                }}
              >
                {w.label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Max Effort start screen: Dual-Mind selector, composer, project picker, and recent Max sessions. */
export function MaxHome(props: {
  projects: Project[];
  general: Project | null;
  agents: AgentsInfo;
  solverId: string;
  projectId: string;
  config?: Partial<MaxEffortSettings>;
  recents: ThreadMeta[];
  onSolver: (id: string) => void;
  onConfig: (patch: Partial<MaxEffortSettings>) => void;
  onProject: (id: string) => void;
  onAddProject: () => void;
  onStart: (text: string, files: AttachmentView[]) => void;
  onOpen: (id: string) => void;
}) {
  const { text, setText, clear } = useDraft(MAX_DRAFT_KEY);
  const openFile = useOpenFile();
  const [projMenu, setProjMenu] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const projWrap = useRef<HTMLDivElement>(null);
  const att = useAttachments(MAX_DRAFT_KEY);

  useEffect(() => {
    ta.current?.focus();
  }, []);
  useEffect(() => {
    if (!projMenu) return;
    const close = (e: MouseEvent) => !projWrap.current?.contains(e.target as Node) && setProjMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [projMenu]);

  const allProjects = useMemo(() => [...(props.general ? [props.general] : []), ...props.projects], [props.general, props.projects]);
  const project = allProjects.find((p) => p.id === props.projectId) ?? allProjects[0];
  const canSend = Boolean(text.trim() || att.files.length);

  const send = () => {
    if (!canSend) return;
    const files = att.files;
    const trimmed = text.trim();
    clear();
    props.onStart(trimmed, files);
  };

  return (
    <div className={`chat-home ${att.dragging ? 'pane-dragging' : ''}`} {...att.dropProps} data-testid="max-home">
      <div className="chat-home-inner">
        <h1 className="greeting">
          <Flame size={28} color="var(--accent)" /> Max Effort · Dual-Mind
        </h1>
        <p className="max-home-sub">
          Two frontier models think independently in parallel, cross-examine each other’s raw thinking to break mental ruts, and converge before final execution.
        </p>

        <div className={`home-composer ${att.dragging ? 'dragging' : ''}`}>
          <AttachmentChips files={att.files} onRemove={att.remove} onAnnotate={att.annotate} onOpen={(a, el) => att.open(a, el, openFile)} />
          <div className="growable-textarea" data-replicated-value={text}>
            <textarea
              onPaste={att.onPaste}
              ref={ta}
              rows={3}
              spellCheck={false}
              value={text}
              placeholder="Describe a hard math proof, scientific hypothesis, or complex system problem…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (enterSends(e)) {
                  e.preventDefault();
                  send();
                }
              }}
              data-testid="max-home-composer"
            />
          </div>
          <div className="composer-bar">
            <AttachButton onClick={() => void att.pick()} onFiles={att.addRawFiles} />
            {att.error && <span className="error-text small ellipsis">{att.error}</span>}
            <div className="spacer" />
            <div className="composer-send">
              <button className="btn primary icon send-btn" disabled={!canSend} onClick={send} title="Start Dual-Mind deliberation" data-testid="max-home-send">
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
          {att.dragging && <div className="drop-hint">Drop files here</div>}
        </div>

        <div className="max-home-controls">
          <MaxEffortBar
            defs={props.agents.defs}
            statuses={props.agents.statuses}
            solverId={props.solverId}
            config={props.config}
            onChangeSolver={props.onSolver}
            onChangeConfig={props.onConfig}
          />
          <div className="picker" ref={projWrap}>
            <button type="button" className="max-meta-pill" onClick={() => setProjMenu((v) => !v)} title="Workspace context (General for pure math/science, or a project folder)">
              <Folder size={13} /> <b>{project?.id === 'general' ? 'No repo (pure reasoning)' : project?.name}</b> <ChevronDown size={11} />
            </button>
            {projMenu && (
              <div className="menu">
                {allProjects.map((p) => (
                  <div
                    key={p.id}
                    className={`menu-item ${p.id === project?.id ? 'active' : ''}`}
                    onClick={() => {
                      props.onProject(p.id);
                      setProjMenu(false);
                    }}
                  >
                    <Folder size={14} /> {p.id === 'general' ? 'No repo (pure reasoning)' : p.name}
                  </div>
                ))}
                <div
                  className="menu-item"
                  onClick={() => {
                    setProjMenu(false);
                    props.onAddProject();
                  }}
                >
                  <FolderPlus size={14} /> Add folder…
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
