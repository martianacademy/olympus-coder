import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Loader2, LogIn, LogOut, RefreshCw, SquareTerminal, X } from 'lucide-react';
import type { AgentDef, AgentStatus, AuthMethodView } from '@shared/types';
import { api } from '../api';
import { AgentLogo } from '../logos';
import type { AuthDetailsView } from '@shared/acpConfig';
import { acpConfigApi } from '../acpConfigApi';
import { AuthAccountLine, LoginLinkCard, LoginVarsForm, useAuthDetails } from './LoginExtras';
import { Terminal } from './Terminal';

/**
 * Full login flow for one agent, driven by the auth methods the agent itself advertises over ACP:
 *  - terminal: the agent's own login command runs in an in-app terminal (browser link / device code / prompts)
 *  - agent:    the agent opens the browser itself; we wait for it
 *  - api-key:  the key is stored encrypted in the macOS keychain and passed to the agent as an env var
 *  - env vars: an ACP `env_var` method with several variables (LoginVarsForm)
 * plus the signed-in account (`auth/status`), links the agent sends during a login (Codex device code) and logout.
 */
export function LoginDialog({ def, status, onClose }: { def: AgentDef; status?: AgentStatus; onClose: () => void }) {
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [keyFor, setKeyFor] = useState<AuthMethodView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useAuthDetails(def.id, status?.state);
  const [varsFor, setVarsFor] = useState<AuthDetailsView['methods'][number] | null>(null);

  useEffect(() => {
    if (!status?.authMethods.length) void api.checkAgent(def.id);
  }, [def.id]);

  useEffect(() => {
    if (status?.state === 'ready' && busy) setBusy(null);
  }, [status?.state]);

  const methods: AuthMethodView[] = details?.methods
    ? details.methods.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        flow: m.flow,
        envVar: m.vars.length === 1 ? m.vars[0].name : undefined,
      }))
    : (status?.authMethods ?? []);
  const done = status?.state === 'ready' && (exitCode === 0 || busy === null);

  async function start(m: AuthMethodView) {
    setError('');
    if (m.flow === 'terminal') {
      setExitCode(null);
      try {
        setPtyId(await api.terminalLogin(def.id, m.id));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    } else if (m.flow === 'api-key' || m.flow === 'env-vars') {
      // With the login details (variables of the method) the form can ask for every variable it needs.
      const d = details?.methods.find((x) => x.id === m.id && x.vars.length);
      if (d) setVarsFor(d);
      else if (m.envVar) setKeyFor(m);
      else {
        const loaded = await acpConfigApi.authDetails(def.id).catch(() => null);
        if (loaded) setDetails(loaded);
        const found = loaded?.methods.find((x) => x.id === m.id && x.vars.length);
        if (found) setVarsFor(found);
        else setError('Could not load environment variable fields for this login method.');
      }
    } else {
      setBusy(m.id);
      const s = await api.authAgent(def.id, m.id).catch((e) => ({ state: 'error', detail: e?.message }) as any);
      setBusy(null);
      if (s.state !== 'ready') setError(s.detail ?? "Login didn't complete.");
    }
  }

  async function saveKey() {
    if (!keyFor || !apiKey.trim()) return;
    setBusy(keyFor.id);
    const s = await api.authAgent(def.id, keyFor.id, apiKey.trim()).catch((e) => ({ state: 'error', detail: e?.message }) as any);
    setBusy(null);
    setApiKey('');
    if (s.state === 'ready') setKeyFor(null);
    else setError(s.detail ?? "Couldn't log in with this key.");
  }

  function close() {
    if (ptyId && exitCode === null) void api.ptyKill(ptyId);
    if (details?.link) void acpConfigApi.answerLoginLink(def.id, 'cancel');
    onClose();
  }

  const icon = (m: AuthMethodView) =>
    m.flow === 'terminal' ? <SquareTerminal size={16} /> : m.flow === 'api-key' || m.flow === 'env-vars' ? <KeyRound size={16} /> : <ExternalLink size={16} />;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !ptyId && close()}>
      <div className="modal narrow">
        <div className="modal-head row">
          <AgentLogo def={def} />
          <span>{def.name} — Login</span>
          <div className="spacer" />
          <span className="row small muted" style={{ fontWeight: 400 }}>
            <span className={`dot ${status?.state ?? 'unknown'}`} /> {status?.state === 'ready' ? 'Logged in / ready' : status?.state}
          </span>
          <button className="btn ghost icon" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body col" style={{ gap: 12 }}>
          {status?.state === 'starting' && (
            <div className="row muted">
              <Loader2 size={16} className="spin" /> Starting agent…
            </div>
          )}
          {status?.state === 'not-installed' && <div className="err-box">{status.detail}</div>}
          {status?.state === 'error' && status.detail && !error && (
            <div className="err-box" style={{ whiteSpace: 'pre-wrap' }}>
              {status.detail}
            </div>
          )}
          {done && !ptyId && <div className="perm" style={{ borderColor: 'var(--success)' }}>✓ {def.name} is ready. You can start chatting.</div>}
          <AuthAccountLine info={details?.info} />
          {details?.link && <LoginLinkCard agentId={def.id} link={details.link} />}

          {varsFor && (
            <LoginVarsForm
              agentId={def.id}
              agentName={def.name}
              method={varsFor}
              saved={details?.savedVars ?? []}
              onBack={() => setVarsFor(null)}
              onDone={(d) => {
                setDetails(d);
                setVarsFor(null);
                void api.checkAgent(def.id);
              }}
            />
          )}

          {!ptyId && !keyFor && !varsFor && (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Choose a login method. This is the same login the {def.name} CLI uses, so once you log in here, the CLI in your terminal stays logged in too.
              </p>
              {methods.map((m) => (
                <button key={m.id} className="btn" style={{ justifyContent: 'flex-start', padding: '10px 12px' }} disabled={Boolean(busy)} onClick={() => void start(m)}>
                  {busy === m.id ? <Loader2 size={16} className="spin" /> : icon(m)}
                  <span className="col" style={{ gap: 1, alignItems: 'flex-start' }}>
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    {m.description && <span className="small muted">{m.description}</span>}
                  </span>
                </button>
              ))}
              {!methods.length && status?.state !== 'starting' && <p className="muted">This agent didn't report any login methods. It may not need a login.</p>}
              {busy && !details?.link && <div className="muted small">Your browser should have opened. Finish logging in there, and this window will update automatically.</div>}
            </>
          )}

          {keyFor && (
            <div className="col">
              <label style={{ fontWeight: 600 }}>{keyFor.name}</label>
              <input className="input" type="password" placeholder={keyFor.envVar} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoFocus />
              <div className="small muted">The key is stored encrypted in the macOS Keychain, only on this computer, and passed to the agent as {keyFor.envVar}.</div>
              <div className="row">
                <button className="btn primary" disabled={!apiKey.trim() || Boolean(busy)} onClick={() => void saveKey()}>
                  {busy ? <Loader2 size={15} className="spin" /> : <LogIn size={15} />} Save & login
                </button>
                <button className="btn ghost" onClick={() => setKeyFor(null)}>
                  Back
                </button>
              </div>
            </div>
          )}

          {ptyId && (
            <>
              <Terminal ptyId={ptyId} onExit={setExitCode} />
              <div className="row small">
                {exitCode === null ? (
                  <span className="muted">Follow the steps in the terminal. Clicking a link opens your browser.</span>
                ) : exitCode === 0 ? (
                  <span style={{ color: 'var(--success)' }}>
                    {status?.state === 'ready' ? `✓ ${def.name} is signed in and ready.` : 'Login command finished. Checking status…'}
                  </span>
                ) : (
                  <span className="error-text">Login command failed (code {exitCode}).</span>
                )}
                <div className="spacer" />
                {exitCode !== null && (
                  <button className="btn small" onClick={() => setPtyId(null)}>
                    Back
                  </button>
                )}
              </div>
            </>
          )}
          {error && <div className="err-box">{error}</div>}
          {(status?.canLogout || details?.canLogout || details?.terminalSwitch) && !ptyId && !keyFor && !varsFor && (
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              {details?.terminalSwitch && (
                <button
                  className="btn small ghost"
                  title={`Switch the active saved account in ${def.name}`}
                  onClick={() => void start({ id: '__olympus_cli_switch', name: 'Switch account', flow: 'terminal' })}
                >
                  <RefreshCw size={13} /> Switch account
                </button>
              )}
              {(status?.canLogout || details?.canLogout) && (
                <button
                  className="btn small ghost"
                  title={`Log out of ${def.name}. This may also log out its CLI.`}
                  onClick={async () => {
                    if (details?.terminalLogout) {
                      if ((details.savedVars?.length ?? 0) > 0) await api.logoutAgent(def.id).catch(() => {});
                      await start({ id: '__olympus_cli_logout', name: 'Log out', flow: 'terminal' });
                      return;
                    }
                    if (confirm(`Log out of ${def.name}? This may also log out its CLI.`)) await api.logoutAgent(def.id);
                  }}
                >
                  <LogOut size={13} /> Log out of {def.name}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
