import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Brain, Check, FolderOpen, FolderPlus, Loader2, LogIn, RefreshCw, Repeat, Workflow } from 'lucide-react';
import type { AgentDef, AgentStatus, AppState, Project } from '@shared/types';
import { api, onEvent } from '../api';
import { MOD } from '../platform';
import { applyTheme } from '../theme';
import { STATE_LABEL } from './AgentPicker';
import { AgentLogo } from '../logos';
import { AppMark } from './AppMark';
import { LoginDialog } from './LoginDialog';
import { AgentCatalog } from './AgentCatalog';
import { LockOptionsForm, PasswordForm, ThemeEditor } from './Settings';

const STEPS = ['Welcome', 'Profile', 'Agents', 'Theme', 'Password', 'Project'];

/** First-run flow: what the app is, agent logins, theme, app password, first project. */
export function Onboarding({ state, onState, onDone }: { state: AppState; onState: (s: AppState) => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [defs, setDefs] = useState<AgentDef[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [login, setLogin] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    void api.agents().then((r) => {
      setDefs(r.defs);
      setStatuses(Object.fromEntries(r.statuses.map((s) => [s.id, s])));
    });
    return onEvent((ch, p) => {
      if (ch === 'agent:status') setStatuses((s) => ({ ...s, [p.id]: p }));
    });
  }, []);

  useEffect(() => applyTheme(state.settings.theme), [state.settings.theme]);

  const checkAll = async () => {
    for (const d of defs) {
      if (statuses[d.id]?.state === 'not-installed') continue;
      setChecking((c) => ({ ...c, [d.id]: true }));
      api
        .checkAgent(d.id)
        .catch(() => {})
        .finally(() => setChecking((c) => ({ ...c, [d.id]: false })));
    }
  };
  useEffect(() => {
    if (step === 2 && defs.length) void checkAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, defs.length]);

  const setProfile = async (patch: Partial<AppState['settings']['profile']>) => {
    onState({ ...state, settings: { ...state.settings, profile: { ...state.settings.profile, ...patch } } });
    await api.updateProfile(patch);
  };

  const setTheme = async (theme: AppState['settings']['theme']) => onState({ ...state, settings: await api.updateSettings({ theme }) });

  return (
    <div className="fullscreen">
      <div className="drag" />
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex' }}>
        <div className="onb">
          <div className="onb-steps">
            {STEPS.map((s, i) => (
              <span key={s} className={i <= step ? 'on' : ''} title={s} />
            ))}
          </div>

          {step === 0 && (
            <div className="onb-hero">
              <AppMark size={54} bare />
              <h1>Welcome to Olympus Coder</h1>
              <p className="muted">Every coding agent in one chat, sharing one memory.</p>
              <div className="onb-feats">
                <span>
                  <Repeat size={14} /> Switch agents mid-chat
                </span>
                <span>
                  <Brain size={14} /> One shared memory
                </span>
                <span>
                  <Workflow size={14} /> Sub-agents in parallel
                </span>
              </div>
              <div className="onb-folder">
                <FolderOpen size={17} className="muted" />
                <div className="col grow" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}>
                  <span className="small muted">Memory folder</span>
                  <span className="mono ellipsis" title={state.settings.sharedRoot}>
                    {state.settings.sharedRoot.replace(/^\/Users\/[^/]+/, '~')}
                  </span>
                </div>
                <button
                  className="btn small"
                  onClick={async () => {
                    const s = await api.pickSharedRoot();
                    if (s) onState({ ...state, settings: s });
                  }}
                >
                  Change
                </button>
              </div>
              <span className="small muted">Your ~/.claude, ~/.gemini and ~/.codex folders are never changed.</span>
            </div>
          )}

          {step === 1 && (
            <>
              <h1>Your profile</h1>
              <p className="muted">This appears in the bottom left. You can also tell agents who you are, so each one tailors its answers to you.</p>
              <div className="grid-2">
                <input className="input" placeholder="Name" value={state.settings.profile.name} onChange={(e) => void setProfile({ name: e.target.value })} data-testid="onb-name" />
                <input className="input" placeholder="Role (e.g. Founder, Full-stack dev)" value={state.settings.profile.role} onChange={(e) => void setProfile({ role: e.target.value })} />
                <input className="input" placeholder="Email (optional)" value={state.settings.profile.email} onChange={(e) => void setProfile({ email: e.target.value })} />
                <input className="input" placeholder="Language / style (e.g. Hinglish)" value={state.settings.profile.languages} onChange={(e) => void setProfile({ languages: e.target.value })} />
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className={`switch ${state.settings.profile.shareWithAgents ? 'on' : ''}`} onClick={() => void setProfile({ shareWithAgents: !state.settings.profile.shareWithAgents })} />
                <span>Share these details with agents</span>
              </div>
              <p className="small muted">Add a photo and other details later from your profile in the bottom left.</p>
            </>
          )}

          {step === 2 && (
            <>
              <h1>Connect agents</h1>
              <p className="muted">Click Login for any agent that needs it. You can also do this later in Settings → Agents.</p>
              {defs.map((d) => {
                const s = statuses[d.id];
                return (
                  <div className="card agent-card row" key={d.id}>
                    <AgentLogo def={d} />
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{d.name}</div>
                      <div className="small muted row" style={{ gap: 5 }}>
                        {checking[d.id] ? <Loader2 size={12} className="spin" /> : <span className={`dot ${s?.state ?? 'unknown'}`} />}
                        {checking[d.id] ? 'Checking…' : STATE_LABEL[s?.state ?? 'unknown']}
                        {s?.version && ` · v${s.version}`}
                      </div>
                      {s?.state === 'not-installed' && <div className="small muted">{s.detail}</div>}
                    </div>
                    {s?.state === 'ready' ? (
                      <span className="chip" style={{ color: 'var(--success)' }}>
                        <Check size={13} /> Ready
                      </span>
                    ) : (
                      s?.state !== 'not-installed' && (
                        <button className="btn small primary" onClick={() => setLogin(d.id)}>
                          <LogIn size={13} /> Login
                        </button>
                      )
                    )}
                  </div>
                );
              })}
              <button className="btn small" onClick={() => void checkAll()}>
                <RefreshCw size={13} /> Check again
              </button>
              <div style={{ marginTop: 18 }}>
                <AgentCatalog
                  autoAdd
                  onChanged={() =>
                    void api.agents().then((r) => {
                      setDefs(r.defs);
                      setStatuses(Object.fromEntries(r.statuses.map((x) => [x.id, x])));
                    })
                  }
                />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h1>Choose your look</h1>
              <p className="muted">You can change every color, font, and size later in Settings → Appearance.</p>
              <ThemeEditor theme={state.settings.theme} onChange={(t) => void setTheme(t)} compact />
            </>
          )}

          {step === 4 && (
            <>
              <h1>App password</h1>
              <p className="muted">
                Keep your code hidden if you hand your laptop to someone. Once a password is set, the app locks every time it opens, after sleep, and when you press{' '}
                <span className="kbd">{MOD}</span> <span className="kbd">L</span>.
              </p>
              {state.lock.enabled ? (
                <div className="col" style={{ gap: 14 }}>
                  <div className="chip" style={{ color: 'var(--success)', alignSelf: 'flex-start' }}>
                    <Check size={13} /> Password set
                  </div>
                  <LockOptionsForm lock={state.lock} onLock={(lock) => onState({ ...state, lock })} />
                </div>
              ) : (
                <PasswordForm lock={state.lock} onLock={(lock) => onState({ ...state, lock })} />
              )}
            </>
          )}

          {step === 5 && (
            <>
              <h1>First project</h1>
              <p className="muted">Choose a folder with your code. Each project gets its own shared memory.</p>
              {project ? (
                <div className="card agent-card row">
                  <Check size={16} color="var(--success)" />
                  <div className="grow">
                    <b>{project.name}</b>
                    <div className="small muted">{project.path}</div>
                  </div>
                </div>
              ) : (
                <button className="btn" onClick={async () => setProject(await api.addProject())}>
                  <FolderPlus size={15} /> Choose folder
                </button>
              )}
            </>
          )}

          <div className="onb-foot">
            {step > 0 && (
              <button className="btn ghost" onClick={() => setStep((s) => s - 1)}>
                <ArrowLeft size={15} /> Back
              </button>
            )}
            <div className="spacer" />
            {(step === 1 || step === 2 || step === 4) && step < STEPS.length - 1 && (
              <button className="btn ghost" onClick={() => setStep((s) => s + 1)}>
                Skip
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button className="btn primary" onClick={() => setStep((s) => s + 1)} data-testid="onb-next">
                Next <ArrowRight size={15} />
              </button>
            ) : (
              <button className="btn primary" onClick={onDone} data-testid="onb-done">
                Get started <ArrowRight size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      {login && defs.find((d) => d.id === login) && <LoginDialog def={defs.find((d) => d.id === login)!} status={statuses[login]} onClose={() => setLogin(null)} />}
    </div>
  );
}
