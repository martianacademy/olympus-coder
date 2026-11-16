import { PhoneSettings } from './settings/PhoneSettings';
import { ThemeEditor } from './settings/AppearanceSettings';
import { useState } from 'react';
import { Bot, Brain, FolderOpen, Loader2, Lock, LogIn, LogOut, Palette, Plug, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Smartphone, Sparkles, Trash2, Wrench, X } from 'lucide-react';
import type { AppState, LockState, Settings } from '@shared/types';
import type { AgentsInfo } from '../App';
import { api } from '../api';
import { MOD } from '../platform';
import { STATE_LABEL } from './AgentPicker';
import { AgentLogo, LogoPicker } from '../logos';
import { AgentCatalog } from './AgentCatalog';
import { AgentSelect } from './AgentSelect';
import { ConnectorsSettings } from './settings/ConnectorsSettings';
import { ProviderSettings } from './settings/ProviderSettings';
import { ToolsSettings } from './settings/ToolsSettings';
import { SkillsSettings } from './settings/SkillsSettings';
import { MemoryEditor } from './settings/MemorySettings';

export type SettingsTab = 'general' | 'agents' | 'connectors' | 'tools' | 'skills' | 'memory' | 'appearance' | 'phone' | 'security';

export function SettingsModal(props: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  state: AppState;
  agents: AgentsInfo;
  onState: (s: AppState) => void;
  onAgents: () => Promise<void>;
  onLogin: (id: string) => void;
  onClose: () => void;
}) {
  const { state } = props;
  const update = async (patch: Partial<Settings>) => props.onState({ ...state, settings: await api.updateSettings(patch) });
  // Settings saved by an older main process may not have the newer fields yet.
  const orch = state.settings.orchestrator ?? { enabled: true, maxParallel: 3, maxPerSession: 8 };
  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <SlidersHorizontal size={15} /> },
    { id: 'agents', label: 'Agents & login', icon: <Bot size={15} /> },
    { id: 'connectors', label: 'Connectors', icon: <Plug size={15} /> },
    { id: 'tools', label: 'Tools', icon: <Wrench size={15} /> },
    { id: 'skills', label: 'Skills', icon: <Sparkles size={15} /> },
    { id: 'memory', label: 'Shared memory', icon: <Brain size={15} /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette size={15} /> },
    { id: 'phone', label: 'Phone', icon: <Smartphone size={15} /> },
    { id: 'security', label: 'App password', icon: <Lock size={15} /> },
  ];
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal">
        <div className="modal-head">
          Settings
          <div className="spacer" />
          <button className="btn ghost icon" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="settings">
          <nav className="settings-nav">
            {tabs.map((t) => (
              <button key={t.id} className={props.tab === t.id ? 'active' : ''} onClick={() => props.onTab(t.id)}>
                {t.icon} {t.label}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {props.tab === 'general' && (
              <>
                <h3>General</h3>
                <div className="field">
                  <label>Default agent for new chats</label>
                  <AgentSelect value={state.settings.defaultAgent} agents={props.agents.defs} onChange={(id) => void update({ defaultAgent: id })} />
                </div>
                <div className="field">
                  <div className="row">
                    <button
                      className={`switch ${orch.enabled ? 'on' : ''}`}
                      onClick={() => void update({ orchestrator: { ...orch, enabled: !orch.enabled } })}
                      data-testid="orchestrator-toggle"
                    />
                    <label>Orchestrator: main sessions delegate work to sub-sessions</label>
                  </div>
                  <span className="small muted">
                    In Code mode the main session's agent plans and checks, and hands substantial, independent pieces to sub-sessions that run in parallel. You watch them live in the
                    Tasks panel. Sub-sessions never start their own sub-sessions. Takes effect for new agent sessions.
                  </span>
                  {orch.enabled && (
                    <div className="row" style={{ gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                      <label className="row small" style={{ gap: 6 }}>
                        Running at once
                        <select
                          className="input"
                          style={{ width: 70 }}
                          value={orch.maxParallel}
                          onChange={(e) => void update({ orchestrator: { ...orch, maxParallel: Number(e.target.value) } })}
                        >
                          {[1, 2, 3, 4, 5, 6].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="row small" style={{ gap: 6 }}>
                        Per session
                        <select
                          className="input"
                          style={{ width: 70 }}
                          value={orch.maxPerSession}
                          onChange={(e) => void update({ orchestrator: { ...orch, maxPerSession: Number(e.target.value) } })}
                        >
                          {[2, 4, 6, 8, 12, 16, 20].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
                <div className="field">
                  <label>Onboarding</label>
                  <div>
                    <button className="btn" onClick={() => void update({ onboarded: false })}>
                      <RotateCcw size={14} /> Run onboarding again
                    </button>
                  </div>
                </div>
                <p className="small muted">Olympus Coder v{state.version}</p>
              </>
            )}
            {props.tab === 'agents' && <AgentsSettings agents={props.agents} onAgents={props.onAgents} onLogin={props.onLogin} />}
            {props.tab === 'connectors' && <ConnectorsSettings agentDefs={props.agents.defs} />}
            {props.tab === 'tools' && <ToolsSettings settings={state.settings} agentDefs={props.agents.defs} onSettings={(settings) => props.onState({ ...state, settings })} />}
            {props.tab === 'skills' && <SkillsSettings />}
            {props.tab === 'phone' && <PhoneSettings onTab={props.onTab} lock={state.lock} onLock={(lock) => props.onState({ ...state, lock })} />}
            {props.tab === 'appearance' && <ThemeEditor theme={state.settings.theme} onChange={(theme) => void update({ theme })} />}
            {props.tab === 'security' && <SecuritySettings lock={state.lock} onLock={(lock) => props.onState({ ...state, lock })} />}
            {props.tab === 'memory' && (
              <>
                <h3>Shared memory</h3>
                <p className="muted small">All agents share one folder: projects, chats, and each project's memory. Claude, Antigravity, and Codex keep their own folders (~/.claude, ~/.gemini, ~/.codex), and the app never touches them.</p>
                <div className="field">
                  <label>Shared folder</label>
                  <div className="row">
                    <input className="input" value={state.settings.sharedRoot} readOnly />
                    <button className="btn" onClick={() => void api.revealShared()}>
                      <FolderOpen size={14} /> Open
                    </button>
                    <button
                      className="btn"
                      title="Pick another folder. Chats and memory already saved stay in the old one."
                      onClick={async () => {
                        const s = await api.pickSharedRoot();
                        if (s) props.onState({ ...state, settings: s });
                      }}
                    >
                      Change
                    </button>
                  </div>
                  <span className="small muted">
                    Contains: <code>AGENTS.md</code> (instructions shared by all agents), <code>memory/&lt;project&gt;/</code>, <code>threads/</code>, <code>projects.json</code>
                  </span>
                </div>
                <div className="field">
                  <div className="row">
                    <button className={`switch ${state.settings.injectSharedContext ? 'on' : ''}`} onClick={() => void update({ injectSharedContext: !state.settings.injectSharedContext })} />
                    <label>Send the operating guide, shared memory and the earlier conversation to each new agent session</label>
                  </div>
                  <span className="small muted">
                    The guide tells each agent which session it is in (and its parent), how the shared memory works, and the rules: verify before claiming, no cheating, report what
                    wasn't verified. When off, an agent you switch to can't see the earlier chat either.
                  </span>
                </div>
                <MemoryEditor />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ agents

export function AgentsSettings({ agents, onAgents, onLogin }: { agents: AgentsInfo; onAgents: () => Promise<void>; onLogin: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', command: '', args: '', env: '', logo: '' });
  const [logoFor, setLogoFor] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const check = async (id: string) => {
    setChecking(id);
    await api.checkAgent(id).catch(() => {});
    setChecking(null);
  };
  return (
    <>
      <h3>Agents & login</h3>
      <p className="muted small">Each agent uses the same login as its own CLI. "Check" starts the agent to see whether it needs a login.</p>
      {agents.defs.map((d) => {
        const s = agents.statuses[d.id];
        return (
          <div className="card agent-card" key={d.id}>
            <div className="row">
              {d.builtin ? (
                <AgentLogo def={d} size={28} />
              ) : (
                <button className="btn ghost icon" title="Change logo" onClick={() => setLogoFor(logoFor === d.id ? null : d.id)}>
                  <AgentLogo def={d} size={28} />
                </button>
              )}
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{d.name}</div>
                <div className="small muted row" style={{ gap: 5 }}>
                  <span className={`dot ${s?.state ?? 'unknown'}`} /> {STATE_LABEL[s?.state ?? 'unknown']}
                  {s?.version && ` · v${s.version}`}
                  {s?.hasApiKey && ' · API key saved'}
                </div>
              </div>
              <button className="btn small" disabled={checking === d.id} onClick={() => void check(d.id)}>
                {checking === d.id ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Check
              </button>
              <button className="btn small primary" onClick={() => onLogin(d.id)} disabled={s?.state === 'not-installed'}>
                <LogIn size={13} /> Login
              </button>
              {s?.canLogout && (
                <button
                  className="btn small"
                  title="Logout"
                  onClick={async () => {
                    if (confirm(`Log out of ${d.name}? This may also log out its CLI.`)) await api.logoutAgent(d.id);
                  }}
                >
                  <LogOut size={13} />
                </button>
              )}
              {!d.builtin && (
                <button
                  className="btn small danger"
                  onClick={async () => {
                    if (confirm(`Remove ${d.name}?`)) {
                      await api.removeCustomAgent(d.id);
                      await onAgents();
                    }
                  }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {d.description}
            </div>
            {s?.state !== 'not-installed' && <ProviderSettings agentId={d.id} agentName={d.name} />}
            {logoFor === d.id && (
              <div style={{ marginTop: 10 }}>
                <LogoPicker
                  value={d.logo ?? ''}
                  preview={d}
                  onChange={async (logo) => {
                    await api.setAgentLogo(d.id, logo);
                    await onAgents();
                  }}
                />
              </div>
            )}
            {s?.detail && (s.state === 'error' || s.state === 'not-installed') && (
              <div className="err-box small" style={{ marginTop: 6 }}>
                {s.detail}
              </div>
            )}
          </div>
        );
      })}
      <div className="field">
        <label>Find and add agents</label>
        <span className="small muted">Agents installed on this computer, and every agent in the official ACP registry.</span>
        <AgentCatalog onChanged={() => void onAgents()} />
      </div>
      {!adding ? (
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add an ACP agent by command (Gemini CLI, OpenCode, Qwen…)
        </button>
      ) : (
        <div className="card agent-card col">
          <b>New agent</b>
          <span className="small muted">
            Any CLI that speaks the Agent Client Protocol (ACP). For example: <code>gemini --experimental-acp</code>, <code>opencode acp</code>.
          </span>
          <input className="input" placeholder="Name (e.g. Gemini CLI)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="Command (e.g. gemini)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
          <input className="input" placeholder="Arguments (e.g. --experimental-acp)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
          <input className="input" placeholder="Env (optional, KEY=value, comma-separated)" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
          <LogoPicker value={form.logo} preview={{ id: '', name: form.name, command: form.command, args: form.args.split(/\s+/) }} onChange={(logo) => setForm({ ...form, logo })} />
          <div className="row">
            <button
              className="btn primary"
              disabled={!form.name.trim() || !form.command.trim()}
              onClick={async () => {
                const env = Object.fromEntries(
                  form.env
                    .split(',')
                    .map((x) => x.trim())
                    .filter((x) => x.includes('='))
                    .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]),
                );
                await api.addCustomAgent({ name: form.name.trim(), command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [], env, color: '', logo: form.logo });
                setForm({ name: '', command: '', args: '', env: '', logo: '' });
                setAdding(false);
                await onAgents();
              }}
            >
              Add
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ theme

export { ThemeEditor };

// ------------------------------------------------------------------ app password

export function PasswordForm({ lock, onLock, onDone }: { lock: LockState; onLock: (l: LockState) => void; onDone?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    if (next !== confirmPw) return setMsg({ ok: false, text: "Passwords don't match." });
    const r = await api.setPassword(lock.enabled ? current : null, next);
    onLock(r.state);
    setMsg(r.ok ? { ok: true, text: 'Password saved.' } : { ok: false, text: r.error ?? 'Error' });
    if (r.ok) {
      setCurrent('');
      setNext('');
      setConfirmPw('');
      onDone?.();
    }
  }
  return (
    <div className="col" style={{ maxWidth: 360 }}>
      {lock.enabled && <input className="input" type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      <input className="input" type="password" placeholder={lock.enabled ? 'New password' : 'Password'} value={next} onChange={(e) => setNext(e.target.value)} data-testid="pw-new" />
      <input className="input" type="password" placeholder="Confirm password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} data-testid="pw-confirm" />
      <div className="row">
        <button className="btn primary" disabled={!next} onClick={() => void save()}>
          <Lock size={14} /> {lock.enabled ? 'Change password' : 'Set password'}
        </button>
      </div>
      {msg && <div className={msg.ok ? 'small' : 'error-text'} style={msg.ok ? { color: 'var(--success)' } : undefined}>{msg.text}</div>}
    </div>
  );
}

export function LockOptionsForm({ lock, onLock }: { lock: LockState; onLock: (l: LockState) => void }) {
  const opt = lock.options;
  const set = async (patch: Partial<LockState['options']>) => onLock(await api.lockOptions(patch));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <label style={{ minWidth: 200 }}>Auto-lock after inactivity</label>
        <select className="select" style={{ width: 180 }} value={opt.autoLockMinutes} onChange={(e) => void set({ autoLockMinutes: Number(e.target.value) })}>
          {[1, 2, 5, 10, 15, 30, 60, 0].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? 'Never' : `${m} min`}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <button className={`switch ${opt.lockOnSleep ? 'on' : ''}`} onClick={() => void set({ lockOnSleep: !opt.lockOnSleep })} />
        <span>Lock the app when the laptop sleeps or the screen locks</span>
      </div>
      {lock.touchIdAvailable && (
        <div className="row">
          <button className={`switch ${opt.touchId ? 'on' : ''}`} onClick={() => void set({ touchId: !opt.touchId })} />
          <span>Unlock with Touch ID</span>
        </div>
      )}
    </div>
  );
}

function SecuritySettings({ lock, onLock }: { lock: LockState; onLock: (l: LockState) => void }) {
  const [removePw, setRemovePw] = useState('');
  const [err, setErr] = useState('');
  return (
    <>
      <h3>App password</h3>
      <p className="muted small">
        If you need to hand your laptop to someone, press <span className="kbd">{MOD}</span> <span className="kbd">L</span> to hide all projects, chats, and code. The app also asks for the password every time it opens.
      </p>
      <div className="field">
        <label>{lock.enabled ? 'Change password' : 'Set password'}</label>
        <PasswordForm lock={lock} onLock={onLock} />
      </div>
      {lock.enabled && (
        <>
          <div className="field">
            <label>Lock options</label>
            <LockOptionsForm lock={lock} onLock={onLock} />
          </div>
          <div className="field">
            <label>Lock the app</label>
            <div>
              <button className="btn" onClick={() => void api.lockNow()}>
                <Lock size={14} /> Lock now
              </button>
            </div>
          </div>
          <div className="field">
            <label>Remove password</label>
            <div className="row" style={{ maxWidth: 420 }}>
              <input className="input" type="password" placeholder="Current password" value={removePw} onChange={(e) => setRemovePw(e.target.value)} />
              <button
                className="btn danger"
                onClick={async () => {
                  const r = await api.removePassword(removePw);
                  setRemovePw('');
                  onLock(r.state);
                  setErr(r.ok ? '' : (r.error ?? ''));
                }}
              >
                Remove
              </button>
            </div>
            {err && <div className="error-text">{err}</div>}
          </div>
        </>
      )}
      <p className="small muted">
        Note: this lock hides everything inside Olympus Coder. To fully protect files on disk, also turn on FileVault and use a separate macOS user account.
      </p>
    </>
  );
}
