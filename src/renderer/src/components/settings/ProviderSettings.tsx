import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Save } from 'lucide-react';
import type { AgentProvidersView, ProviderKeyHeader, ProviderSlotView } from '@shared/acpConfig';
import { acpConfigApi } from '../../acpConfigApi';
import '../../acpConfig.css';

const API_TYPE_LABEL: Record<string, string> = { anthropic: 'Anthropic API', openai: 'OpenAI API', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', azure: 'Azure OpenAI' };
const KEY_HEADER_LABEL: Record<ProviderKeyHeader, string> = {
  authorization: 'Authorization: Bearer <key>',
  'x-api-key': 'x-api-key: <key>',
  'api-key': 'api-key: <key> (Azure)',
  none: 'No key (the gateway needs none)',
};
const defaultHeader = (apiType: string): ProviderKeyHeader => (apiType === 'azure' ? 'api-key' : apiType === 'vertex' ? 'none' : 'authorization');
const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

type Form = { apiType: string; baseUrl: string; keyHeader: ProviderKeyHeader; apiKey: string; projectId: string; region: string };

/**
 * Settings → Agents → one agent: "Model provider" (ACP `providers/*`). Shown only for agents that advertise it;
 * an agent that isn't running yet offers a quiet "Model provider…" link that starts it to ask.
 * The key is write-only here: it goes to the main process's encrypted store and never comes back.
 */
export function ProviderSettings({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [view, setView] = useState<AgentProvidersView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'disable' | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    let live = true;
    void acpConfigApi
      .providers(agentId, false)
      .then((v) => live && setView(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agentId]);

  const slot: ProviderSlotView | undefined = view?.slots.find((s) => s.providerId === view.saved?.providerId) ?? view?.slots[0];

  useEffect(() => {
    if (!slot || form) return;
    const saved = view?.saved;
    const apiType = saved?.apiType ?? slot.current?.apiType ?? slot.supported[0] ?? '';
    setForm({
      apiType,
      baseUrl: saved?.baseUrl ?? '',
      keyHeader: saved?.keyHeader ?? defaultHeader(apiType),
      apiKey: '',
      projectId: saved?.vertex?.projectId ?? '',
      region: saved?.vertex?.region ?? '',
    });
  }, [slot, view?.saved]);

  async function load() {
    setBusy('load');
    setError('');
    try {
      setView(await acpConfigApi.providers(agentId, true));
      setOpen(true);
    } catch (e) {
      setError(errText(e));
    }
    setBusy(null);
  }

  async function save() {
    if (!slot || !form) return;
    setBusy('save');
    setError('');
    try {
      const v = await acpConfigApi.setProvider(agentId, {
        providerId: slot.providerId,
        apiType: form.apiType,
        baseUrl: form.baseUrl.trim(),
        keyHeader: form.keyHeader,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(form.apiType === 'vertex' ? { vertex: { projectId: form.projectId.trim(), region: form.region.trim() } } : {}),
      });
      setView(v);
      setForm((f) => (f ? { ...f, apiKey: '' } : f));
    } catch (e) {
      setError(errText(e));
    }
    setBusy(null);
  }

  async function disable() {
    if (!confirm(`Stop using the custom model provider? ${agentName} goes back to its own login.`)) return;
    setBusy('disable');
    setError('');
    try {
      setView(await acpConfigApi.disableProvider(agentId, slot?.providerId));
      setForm(null);
    } catch (e) {
      setError(errText(e));
    }
    setBusy(null);
  }

  if (!view) return null;
  if (view.known && !view.supported) return null;
  if (!view.known) {
    return (
      <div className="provider-section">
        <button className="btn ghost small muted" style={{ alignSelf: 'flex-start' }} disabled={busy === 'load'} onClick={() => void load()} title={`Start ${agentName} to see whether it can use your own model provider (API base URL and key).`}>
          {busy === 'load' ? <Loader2 size={13} className="spin" /> : <ChevronRight size={13} />} Model provider…
        </button>
        {error && <div className="small error-text">{error}</div>}
      </div>
    );
  }

  const using = view.saved;
  const current = slot?.current;
  const summary = using
    ? `${API_TYPE_LABEL[using.apiType] ?? using.apiType} · ${hostOf(using.baseUrl)}${using.hasKey ? ' · key saved' : ''}`
    : current
      ? `${agentName}'s own setup (${API_TYPE_LABEL[current.apiType] ?? current.apiType} · ${hostOf(current.baseUrl)})`
      : `${agentName}'s own login`;

  return (
    <div className="provider-section" data-testid={`provider-${agentId}`}>
      <div className="provider-head">
        <button className="btn ghost small" onClick={() => setOpen(!open)} aria-expanded={open} title="Route this agent's model requests through your own API endpoint and key.">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Model provider
        </button>
        <span className="provider-current" title={summary}>
          {summary}
        </span>
      </div>
      {using?.error && <div className="small error-text">Last start: {using.error}</div>}
      {open && slot && form && (
        <>
          <div className="provider-form">
            <label htmlFor={`pv-type-${agentId}`}>API type</label>
            <select
              id={`pv-type-${agentId}`}
              className="input"
              value={form.apiType}
              onChange={(e) => setForm({ ...form, apiType: e.target.value, keyHeader: defaultHeader(e.target.value) })}
            >
              {slot.supported.map((t) => (
                <option key={t} value={t}>
                  {API_TYPE_LABEL[t] ?? t}
                </option>
              ))}
            </select>
            <label htmlFor={`pv-url-${agentId}`}>Base URL</label>
            <input id={`pv-url-${agentId}`} className="input" placeholder="https://gateway.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} spellCheck={false} />
            {form.apiType === 'vertex' && (
              <>
                <label htmlFor={`pv-proj-${agentId}`}>Project ID</label>
                <input id={`pv-proj-${agentId}`} className="input" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} spellCheck={false} />
                <label htmlFor={`pv-region-${agentId}`}>Region</label>
                <input id={`pv-region-${agentId}`} className="input" placeholder="us-east5" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} spellCheck={false} />
              </>
            )}
            <label htmlFor={`pv-hdr-${agentId}`}>Key header</label>
            <select id={`pv-hdr-${agentId}`} className="input" value={form.keyHeader} onChange={(e) => setForm({ ...form, keyHeader: e.target.value as ProviderKeyHeader })}>
              {(Object.keys(KEY_HEADER_LABEL) as ProviderKeyHeader[]).map((h) => (
                <option key={h} value={h}>
                  {KEY_HEADER_LABEL[h]}
                </option>
              ))}
            </select>
            {form.keyHeader !== 'none' && (
              <>
                <label htmlFor={`pv-key-${agentId}`}>API key</label>
                <input
                  id={`pv-key-${agentId}`}
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder={using?.hasKey ? 'Saved — leave empty to keep it' : 'Paste the key'}
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </>
            )}
          </div>
          <div className="small muted">
            The key is stored encrypted on this computer and sent only to {agentName}, which uses it for this endpoint. {agentName} checks the endpoint by listing its models when you save.
          </div>
          <div className="provider-actions">
            <button className="btn small primary" disabled={busy !== null || !form.baseUrl.trim()} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 size={13} className="spin" /> : <Save size={13} />} {using ? 'Update provider' : 'Use this provider'}
            </button>
            {using && (
              <button className="btn small" disabled={busy !== null} onClick={() => void disable()} title={`Forget this provider and its key; ${agentName} uses its own login again.`}>
                {busy === 'disable' ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} Use {agentName}'s own login
              </button>
            )}
          </div>
        </>
      )}
      {view.error && <div className="small error-text">{view.error}</div>}
      {error && <div className="small error-text">{error}</div>}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
