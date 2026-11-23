import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Loader2, Play } from 'lucide-react';
import type { Project, VerifyGateConfig, VerifyRunResult } from '@shared/types';
import { api } from '../api';

/**
 * Right-panel Info → Verify Gate section: lets the user enable automatic post-turn verification per project,
 * customize or auto-detect the check command (`npm run typecheck`, `npm test`, `cargo check`, `pytest`, …),
 * and test-run the command in 1 click.
 */
export function VerifyGateSection({ project }: { project: Project }) {
  const [cfg, setCfg] = useState<VerifyGateConfig>(() => project.verifyGate ?? { enabled: false });
  const [detected, setDetected] = useState<string | null>(null);
  const [cmdDraft, setCmdDraft] = useState(project.verifyGate?.command ?? '');
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<VerifyRunResult | null>(null);

  useEffect(() => {
    setCfg(project.verifyGate ?? { enabled: false });
    setCmdDraft(project.verifyGate?.command ?? '');
    setLastRun(null);
    void api
      .verifyGateInfo(project.id)
      .then((info) => {
        setCfg(info.config);
        setCmdDraft(info.config.command ?? '');
        setDetected(info.detectedCommand);
      })
      .catch(() => {});
  }, [project.id]);

  const save = async (patch: Partial<VerifyGateConfig>) => {
    const next: VerifyGateConfig = { ...cfg, ...patch };
    setCfg(next);
    await api.setVerifyGate(project.id, next).catch(() => {});
  };

  const runNow = async () => {
    setRunning(true);
    setLastRun(null);
    try {
      // Save any pending command text edit first.
      if (cmdDraft !== (cfg.command ?? '')) await save({ command: cmdDraft.trim() || undefined });
      const res = await api.runVerifyGate(project.id);
      setLastRun(res);
    } finally {
      setRunning(false);
    }
  };

  const effective = cmdDraft.trim() || detected;

  return (
    <div className="info-section" data-testid="verify-gate-section">
      <div className="info-title row" style={{ gap: 6, alignItems: 'center' }}>
        <span>Verify gate</span>
        <span className="grow" />
        <div className="seg compact" data-testid="verify-gate-toggle">
          <button type="button" className={!cfg.enabled ? 'active' : ''} onClick={() => void save({ enabled: false })}>
            Off
          </button>
          <button type="button" className={cfg.enabled ? 'active' : ''} onClick={() => void save({ enabled: true })}>
            Auto
          </button>
        </div>
      </div>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Runs after file-changing turns; sends failures back to the agent (max {cfg.maxRetries ?? 2} retries).
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          type="text"
          className="input mono small grow"
          data-testid="verify-gate-cmd"
          placeholder={detected ? `Auto: ${detected}` : 'e.g. npm run typecheck && npm test'}
          value={cmdDraft}
          onChange={(e) => setCmdDraft(e.target.value)}
          onBlur={() => {
            if (cmdDraft.trim() !== (cfg.command ?? '')) void save({ command: cmdDraft.trim() || undefined });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          }}
        />
        <button
          type="button"
          className="btn small ghost"
          data-testid="verify-gate-run"
          disabled={running || !effective}
          onClick={() => void runNow()}
          title={effective ? `Run "${effective}" now` : 'Enter a command first'}
        >
          {running ? <Loader2 size={12} className="spin" /> : <Play size={12} />} Check
        </button>
      </div>
      {lastRun && (
        <div
          className={`small row ${lastRun.ok ? '' : 'error-text'}`}
          data-testid="verify-gate-result"
          style={{ gap: 5, marginTop: 6, alignItems: 'center' }}
        >
          {lastRun.ok ? <CircleCheck size={13} style={{ color: 'var(--success)' }} /> : <CircleX size={13} />}
          <span>
            {lastRun.ok ? 'Passed' : `Failed (exit ${lastRun.exitCode})`} · {(lastRun.durationMs / 1000).toFixed(1)}s
          </span>
        </div>
      )}
    </div>
  );
}
