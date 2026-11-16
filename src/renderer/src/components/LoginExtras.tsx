import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, LogIn, UserRound } from 'lucide-react';
import type { AuthDetailsView, AuthInfoView, LoginLinkView } from '@shared/acpConfig';
import { acpConfigApi, onAcpConfigEvent } from '../acpConfigApi';
import { api } from '../api';
import { isRemoteBrowser } from '../responsive';

const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Login details of one agent (methods with their variables, account, open link), kept live. Null until known. */
export function useAuthDetails(agentId: string, refreshKey: unknown) {
  const [details, setDetails] = useState<AuthDetailsView | null>(null);
  useEffect(() => {
    let live = true;
    void acpConfigApi
      .authDetails(agentId)
      .then((d) => live && setDetails(d))
      .catch(() => live && setDetails(null));
    const offInfo = onAcpConfigEvent('auth:info', (p) => p.agentId === agentId && setDetails((d) => (d ? { ...d, info: p.info } : d)));
    const offLink = onAcpConfigEvent('auth:link', (p) => {
      if (p.agentId !== agentId) return;
      setDetails((d) => {
        if (!d) return d;
        const { link: _old, ...rest } = d;
        return p.link ? { ...rest, link: p.link } : rest;
      });
    });
    return () => {
      live = false;
      offInfo();
      offLink();
    };
  }, [agentId, refreshKey]);
  return [details, setDetails] as const;
}

/** "Signed in as …" from the agent's `auth/status` (account label, email / organization, plan). */
export function AuthAccountLine({ info }: { info?: AuthInfoView }) {
  if (!info || info.state !== 'authenticated') return null;
  const a = info.accounts.find((x) => x.active) ?? info.accounts[0];
  const how = info.kind === 'api_key' ? 'API key' : info.kind === 'gateway' ? 'Custom gateway' : info.kind === 'external' ? 'External credentials' : undefined;
  const detail = [a?.email && a.email !== a.label ? a.email : undefined, a?.organization, a?.plan, how].filter(Boolean).join(' · ');
  return (
    <div className="row small" style={{ gap: 6, minWidth: 0 }} data-testid="auth-account">
      <UserRound size={14} className="muted" style={{ flex: 'none' }} />
      <span className="ellipsis">
        Signed in{a ? ` as ${a.label}` : ''}
        {detail && <span className="muted"> · {detail}</span>}
      </span>
    </div>
  );
}

/** A link the agent sent during the login (e.g. Codex's device code): its message stays visible after opening. */
export function LoginLinkCard({ agentId, link }: { agentId: string; link: LoginLinkView }) {
  const remote = isRemoteBrowser();
  return (
    <div className="col" style={{ gap: 8 }} data-testid="login-link">
      <div style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>{link.message}</div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <a
          className="btn small primary"
          style={{ textDecoration: 'none' }}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          title={link.url}
          onClick={(e) => {
            if (!remote) {
              e.preventDefault();
              void api.openExternal(link.url);
            }
            void acpConfigApi.answerLoginLink(agentId, 'accept');
          }}
        >
          <ExternalLink size={13} /> Open sign-in page
        </a>
        <button className="btn small ghost" onClick={() => void acpConfigApi.answerLoginLink(agentId, 'decline')}>
          Cancel this login
        </button>
      </div>
    </div>
  );
}

/**
 * Values a login method needs (one API key, or several variables of an `env_var` method). Saved values are not
 * shown, only that one is saved; leaving a saved field empty keeps it.
 */
export function LoginVarsForm(props: { agentId: string; agentName: string; method: AuthDetailsView['methods'][number]; saved: string[]; onDone: (d: AuthDetailsView) => void; onBack: () => void }) {
  const { method } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allOptional = method.vars.length > 0 && method.vars.every((v) => v.optional);
  const ready = allOptional
    ? method.vars.some((v) => Boolean(values[v.name]?.trim()) || props.saved.includes(v.name))
    : method.vars.every((v) => v.optional || Boolean(values[v.name]?.trim()) || props.saved.includes(v.name));

  async function submit() {
    setBusy(true);
    setError('');
    try {
      props.onDone(await acpConfigApi.loginWithVars(props.agentId, method.id, values));
      setValues({});
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  }

  return (
    <div className="col" style={{ gap: 8 }} data-testid="login-vars">
      <div style={{ fontWeight: 600 }}>{method.name}</div>
      {method.description && <div className="small muted">{method.description}</div>}
      {method.vars.map((v) => (
        <label key={v.name} className="col" style={{ gap: 4 }}>
          <span className="small">
            {v.label ?? v.name}
            {v.label && <span className="muted mono"> · {v.name}</span>}
            {v.optional && <span className="muted"> · optional</span>}
          </span>
          <input
            className="input"
            type={v.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={props.saved.includes(v.name) ? 'Saved — leave empty to keep it' : v.name}
            value={values[v.name] ?? ''}
            onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
          />
        </label>
      ))}
      <div className="small muted">
        Stored encrypted on this computer and passed to {props.agentName} as environment variables.
        {method.link && (
          <>
            {' '}
            <a href={method.link} target="_blank" rel="noreferrer">
              Where do I get this?
            </a>
          </>
        )}
      </div>
      <div className="row">
        <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? <Loader2 size={15} className="spin" /> : <LogIn size={15} />} Save & login
        </button>
        <button className="btn ghost" onClick={props.onBack}>
          Back
        </button>
      </div>
      {error && <div className="err-box">{error}</div>}
    </div>
  );
}
