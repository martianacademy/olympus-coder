import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Eraser, FlaskConical, Globe, Play, Plus, RotateCw, Search, Square, SquareTerminal, X } from 'lucide-react';
import type { PortInfo, TerminalView } from '@shared/types';
import { api, onEvent } from '../api';
import { portInUse } from '../compose';
import { triggerFixError } from '../fixError';
import { WORKBENCH_SHEET_BP } from '../responsive';
import { parseTestOutput, type TestResult } from '../tests';
import { Terminal, terminalAction, terminalLineCount, terminalText, terminalTextFrom } from './Terminal';
import { FindBar, TestBar } from './TerminalBars';
import { devServerUrl, openWebPreview } from './WebPreview';

/** The tab in front, per project, for the whole app session (the list itself lives in the main process). */
const activeTerminal = new Map<string, string>();
/** Projects whose Terminal tab already opened its first shell by itself this app session. */
const autoOpened = new Set<string>();

/** A terminal the main process opened (Run button, an agent's run_in_terminal): bring its tab forward. */
export function addTerminal(projectId: string, ptyId: string) {
  activeTerminal.set(projectId, ptyId);
  window.dispatchEvent(new CustomEvent('olympus:terminal-added', { detail: { projectId, ptyId } }));
}

const dotClass = (t: TerminalView) => (t.alive ? 'live' : t.restored ? 'stopped' : t.exitCode && t.exitCode !== 0 ? 'fail' : 'done');
const stateText = (t: TerminalView) =>
  t.alive ? (t.busy ? 'running' : 'shell open') : t.restored ? 'stopped when Olympus was closed' : `exited${t.exitCode !== undefined ? `, code ${t.exitCode}` : ''}`;

/**
 * Multi-tab PTY terminal workspace with live test-runner parsing, dev-server detection,
 * port-conflict resolution, and one-tap "Ask agent to fix" chat composition.
 */
export function TerminalPanel({ projectId, visible, canCompose, onClose }: { projectId: string; visible: boolean; canCompose: boolean; onClose: () => void }) {
  const [list, setList] = useState<TerminalView[] | null>(null);
  const [active, setActiveState] = useState<string | null>(activeTerminal.get(projectId) ?? null);
  const [copied, setCopied] = useState(false);
  const [testCmd, setTestCmd] = useState<string | null>(null);
  useEffect(() => {
    setTestCmd(null);
    void api.testCommand(projectId).then(setTestCmd).catch(() => {});
  }, [projectId]);
  const [results, setResults] = useState<Record<string, TestResult | null>>({});
  const marks = useRef<Record<string, number>>({});
  const parseTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [portIssue, setPortIssue] = useState<Record<string, { port: number; owner?: PortInfo; freed?: boolean; error?: string } | null>>({});
  const [finding, setFinding] = useState(false);
  const [devUrl, setDevUrl] = useState<Record<string, string | null>>({});
  const devSeen = useRef(new Set<string>());
  const [errored, setErrored] = useState<Record<string, boolean>>({});

  const readResults = (id: string) => {
    clearTimeout(parseTimers.current[id]);
    parseTimers.current[id] = setTimeout(() => {
      const text = terminalTextFrom(id, marks.current[id] ?? 0);
      const r = parseTestOutput(text);
      setResults((all) => (JSON.stringify(all[id] ?? null) === JSON.stringify(r) ? all : { ...all, [id]: r }));
      const dev = devServerUrl(text);
      if (dev && !devSeen.current.has(`${id} ${dev}`)) {
        devSeen.current.add(`${id} ${dev}`);
        setDevUrl((all) => ({ ...all, [id]: dev }));
      }
      const port = portInUse(text);
      if (port && portIssue[id]?.port !== port)
        void api.ports().then((ps) => {
          const owner = ps.find((p) => p.port === port && !p.self);
          setPortIssue((all) => ({ ...all, [id]: { port, owner } }));
        });
    }, 700);
  };

  const newCommand = (id: string) => {
    marks.current[id] = terminalLineCount(id);
    setResults((all) => (all[id] ? { ...all, [id]: null } : all));
    setPortIssue((all) => (all[id] ? { ...all, [id]: null } : all));
  };

  const freePort = async (id: string) => {
    const issue = portIssue[id];
    if (!issue?.owner) return;
    try {
      await api.stopPort(issue.owner.pid);
      setPortIssue((all) => ({ ...all, [id]: { ...issue, freed: true } }));
    } catch (e: any) {
      setPortIssue((all) => ({ ...all, [id]: { ...issue, error: String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } }));
    }
  };

  const setActive = (id: string | null) => {
    if (id) activeTerminal.set(projectId, id);
    setActiveState(id);
  };

  const runCommand = async (command: string, preferId?: string) => {
    const idle = (tabs: TerminalView[]) => tabs.find((t) => t.ptyId === preferId && t.alive && !t.busy) ?? tabs.find((t) => t.command === command && t.alive && !t.busy);
    const target = idle(await api.terminalList(projectId));
    if (target) {
      newCommand(target.ptyId);
      setActive(target.ptyId);
      await api.ptyWrite(target.ptyId, `${command}\r`);
    } else await api.runInTerminal(projectId, command);
  };

  const markError = (id: string, on: boolean) => setErrored((e) => (Boolean(e[id]) === on ? e : { ...e, [id]: on }));

  const askFixTests = (t: TerminalView, r: TestResult) => {
    const failedLines = r.failures.slice(0, 20).map((f) => `- ${f.name}${f.ref && !f.name.startsWith(f.ref) ? ` (${f.ref})` : ''}`);
    void triggerFixError({
      source: 'tests',
      title: `${r.failed} test${r.failed > 1 ? 's' : ''} failed (${r.runner}) in terminal "${t.title}"`,
      output: terminalText(t.ptyId, 80),
      failedItems: failedLines,
      projectId,
    });
    if (typeof window !== 'undefined' && window.innerWidth <= WORKBENCH_SHEET_BP) onClose();
  };

  const askFix = (t: TerminalView) => {
    void triggerFixError({
      source: 'terminal',
      title: t.title,
      output: terminalText(t.ptyId, 60),
      projectId,
    });
    markError(t.ptyId, false);
    if (typeof window !== 'undefined' && window.innerWidth <= WORKBENCH_SHEET_BP) onClose();
  };

  const refresh = useCallback(
    async (focus?: string) => {
      const l = await api.terminalList(projectId);
      setList(l);
      setActiveState((a) => {
        const want = focus ?? activeTerminal.get(projectId) ?? a;
        const pick = want && l.some((t) => t.ptyId === want) ? want : (l[l.length - 1]?.ptyId ?? null);
        if (pick) activeTerminal.set(projectId, pick);
        return pick;
      });
      return l;
    },
    [projectId],
  );

  const adding = useRef(false);
  const add = async () => {
    if (adding.current) return;
    adding.current = true;
    try {
      await refresh(await api.termStart(projectId));
    } finally {
      adding.current = false;
    }
  };

  useEffect(() => {
    setList(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (visible && list && !list.length && !autoOpened.has(projectId)) {
      autoOpened.add(projectId);
      void add();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, list, projectId]);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; ptyId: string }>).detail;
      if (d.projectId === projectId) void refresh(d.ptyId);
    };
    window.addEventListener('olympus:terminal-added', on);
    const off = onEvent((ch, p) => {
      if (ch === 'terminal:changed' && p.projectId === projectId) void refresh();
    });
    return () => {
      window.removeEventListener('olympus:terminal-added', on);
      off();
    };
  }, [projectId, refresh]);

  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.editor-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, list?.length]);

  const close = async (id: string) => {
    const rest = (list ?? []).filter((t) => t.ptyId !== id);
    if (active === id) setActive(rest[rest.length - 1]?.ptyId ?? null);
    await api.terminalClose(id);
    void refresh();
  };

  const rerun = async (id: string) => {
    const r = await api.terminalRerun(id);
    await refresh(r.ptyId);
  };

  const tabs = list ?? [];
  const current = tabs.find((t) => t.ptyId === active);

  return (
    <div className="terminal-panel">
      <div className="editor-tabs term-tabs">
        <div
          className="tabs-scroll"
          ref={strip}
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {tabs.map((t) => (
            <div
              key={t.ptyId}
              className={`editor-tab term-tab ${t.ptyId === active ? 'active' : ''} ${t.alive ? '' : 'ended'}`}
              title={`${t.command ?? t.title}\n(${stateText(t)})`}
              onClick={() => setActive(t.ptyId)}
              onAuxClick={(e) => e.button === 1 && void close(t.ptyId)}
            >
              <span className={`term-dot ${dotClass(t)}`} />
              <span className="tab-label">{t.title}</span>
              <X size={12} className="tab-x" onClick={(e) => (e.stopPropagation(), void close(t.ptyId))} />
            </div>
          ))}
        </div>
        <button className="btn ghost icon term-add" title="New terminal" aria-label="New terminal" onClick={() => void add()}>
          <Plus size={14} />
        </button>
      </div>
      {current && (
        // The active terminal's actions, on their own line under the tabs: small icons, nothing that runs a command
        // again by accident next to the tabs.
        <div className="term-toolbar" data-testid="term-toolbar">
          <span className={`term-toolbar-cmd ellipsis ${current.command ? 'mono' : ''}`} title={current.command ?? current.title}>
            {current.command ?? current.title}
          </span>
          <div className="term-tools">
            {testCmd && (
              <button className="btn ghost icon" title={`Run tests: ${testCmd}`} onClick={() => void runCommand(testCmd)}>
                <FlaskConical size={13} />
              </button>
            )}
            {!current.alive ? (
              <button className="btn ghost icon term-rerun" title={current.command ? `Run again: ${current.command}` : 'Start a new shell here'} aria-label={current.command ? 'Run again' : 'Restart'} onClick={() => void rerun(current.ptyId)} data-testid="term-rerun">
                {current.command ? <Play size={13} /> : <RotateCw size={13} />}
              </button>
            ) : (
              <button className="btn ghost icon" title="Stop (Ctrl+C)" onClick={() => active && terminalAction(active, 'interrupt')}>
                <Square size={12} />
              </button>
            )}
            <button className="btn ghost icon" title={`Find (${navigator.platform.toLowerCase().includes('mac') ? '⌘F' : 'Ctrl+Shift+F'})`} onClick={() => setFinding((f) => !f)}>
              <Search size={13} />
            </button>
            <button className="btn ghost icon" title="Clear" onClick={() => active && terminalAction(active, 'clear')}>
              <Eraser size={13} />
            </button>
            <button
              className="btn ghost icon"
              title={copied ? 'Copied' : 'Copy output (or the selection)'}
              onClick={() => {
                if (active && terminalAction(active, 'copy')) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }
              }}
            >
              <Copy size={13} className={copied ? 'ok' : ''} />
            </button>
          </div>
        </div>
      )}
      {current && results[current.ptyId] && (
        <TestBar
          result={results[current.ptyId]!}
          canCompose={canCompose}
          onRerun={(cmd) => void runCommand(cmd, current.ptyId)}
          onAskFix={() => askFixTests(current, results[current.ptyId]!)}
          onDismiss={() => setResults((all) => ({ ...all, [current.ptyId]: null }))}
        />
      )}
      <div className="terminal-stack">
        {tabs.map((t) => (
          <div key={t.ptyId} className="term-slot" style={{ display: t.ptyId === active ? 'block' : 'none' }}>
            <Terminal
              ptyId={t.ptyId}
              visible={visible && t.ptyId === active}
              onError={() => markError(t.ptyId, true)}
              onCommand={() => {
                markError(t.ptyId, false);
                newCommand(t.ptyId);
              }}
              onOutput={() => readResults(t.ptyId)}
              onFind={() => setFinding(true)}
            />
          </div>
        ))}
        {current && finding && <FindBar key={current.ptyId} ptyId={current.ptyId} onClose={() => setFinding(false)} />}
        {current && portIssue[current.ptyId] && (
          <div className="term-fix port">
            <AlertTriangle size={13} />
            {portIssue[current.ptyId]!.freed ? (
              <span>Port {portIssue[current.ptyId]!.port} is free now — run your command again.</span>
            ) : portIssue[current.ptyId]!.owner ? (
              <span title={portIssue[current.ptyId]!.owner!.command}>
                Port {portIssue[current.ptyId]!.port} is taken by <b>{portIssue[current.ptyId]!.owner!.name}</b> (pid {portIssue[current.ptyId]!.owner!.pid})
              </span>
            ) : (
              <span>Port {portIssue[current.ptyId]!.port} is in use, but its program couldn't be found (it may belong to another user).</span>
            )}
            {portIssue[current.ptyId]!.error && <span className="error-text">{portIssue[current.ptyId]!.error}</span>}
            {portIssue[current.ptyId]!.owner && !portIssue[current.ptyId]!.freed && (
              <button className="btn small primary" onClick={() => void freePort(current.ptyId)} title={`Stop ${portIssue[current.ptyId]!.owner!.command}`}>
                Stop it
              </button>
            )}
            {portIssue[current.ptyId]!.freed && current.command && current.alive && !current.busy && (
              <button className="btn small primary" onClick={() => void runCommand(current.command!, current.ptyId)}>
                Run again
              </button>
            )}
            <button className="btn ghost icon" title="Dismiss" onClick={() => setPortIssue((all) => ({ ...all, [current.ptyId]: null }))}>
              <X size={12} />
            </button>
          </div>
        )}
        {current && devUrl[current.ptyId] && !portIssue[current.ptyId] && !errored[current.ptyId] && (
          <div className="term-fix dev">
            <Globe size={13} />
            <span>
              Dev server at <b className="mono">{devUrl[current.ptyId]!.replace(/^https?:\/\//, '').replace(/\/$/, '')}</b>
            </span>
            <button
              className="btn small primary"
              onClick={() => {
                openWebPreview(devUrl[current.ptyId]!);
                setDevUrl((all) => ({ ...all, [current.ptyId]: null }));
              }}
            >
              Preview
            </button>
            <button className="btn ghost icon" title="Dismiss" onClick={() => setDevUrl((all) => ({ ...all, [current.ptyId]: null }))}>
              <X size={12} />
            </button>
          </div>
        )}
        {current && errored[current.ptyId] && canCompose && !results[current.ptyId]?.failed && !portIssue[current.ptyId] && (
          <div className="term-fix">
            <AlertTriangle size={13} />
            <span>Looks like an error</span>
            <button className="btn small primary" onClick={() => askFix(current)} title="Puts the error output into the chat's message box, for you to send">
              Ask agent to fix
            </button>
            <button className="btn ghost icon" title="Dismiss" onClick={() => markError(current.ptyId, false)}>
              <X size={12} />
            </button>
          </div>
        )}
        {list && !list.length && (
          <div className="term-empty">
            <SquareTerminal size={22} />
            <span>No terminal open</span>
            <button className="btn small" onClick={() => void add()}>
              <Plus size={13} /> New terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
