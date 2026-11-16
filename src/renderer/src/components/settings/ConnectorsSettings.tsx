import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Globe, Loader2, Pencil, Plug, Plus, SquareTerminal, Trash2, Zap } from 'lucide-react';
import type { AgentDef, ConnectorView, ImportCandidate } from '@shared/types';
import { api } from '../../api';
import { AgentLogo } from '../../logos';

type Form = { id?: string; name: string; transport: 'stdio' | 'http'; command: string; args: string; env: string; url: string; headers: string; agents: 'all' | string[]; enabled: boolean; source?: string };
const EMPTY: Form = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', agents: 'all', enabled: true };

const toLines = (o: Record<string, string>, sep: string) => Object.entries(o).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const fromLines = (s: string, sep: RegExp) =>
  Object.fromEntries(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = sep.exec(l);
        return m ? [l.slice(0, m.index).trim(), l.slice(m.index + m[0].length).trim()] : [l, ''];
      }),
  );

/** Settings → Connectors: MCP servers set up once and given to every agent (or the ones you pick). */
export function ConnectorsSettings({ agentDefs }: { agentDefs: AgentDef[] }) {
  const [list, setList] = useState<ConnectorView[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cands, setCands] = useState<ImportCandidate[] | null>(null);

  useEffect(() => void api.connectors().then(setList), []);

  const edit = (c?: ConnectorView) => {
    setError('');
    setForm(
      c
        ? { id: c.id, name: c.name, transport: c.transport, command: c.command ?? '', args: (c.args ?? []).join('\n'), env: toLines(c.env, '='), url: c.url ?? '', headers: toLines(c.headers, ': '), agents: c.agents, enabled: c.enabled, source: c.source }
        : { ...EMPTY },
    );
  };
  const save = async () => {
    if (!form) return;
    setError('');
    try {
      const next = await api.saveConnector({
        id: form.id,
        name: form.name,
        enabled: form.enabled,
        transport: form.transport,
        command: form.command,
        args: form.args.split('\n').map((a) => a.trim()).filter(Boolean),
        env: fromLines(form.env, /=/),
        url: form.url,
        headers: fromLines(form.headers, /:\s*/),
        agents: form.agents,
        source: form.source,
      });
      setList(next);
      const saved = next.find((c) => c.name === form.name.trim());
      setForm(null);
      if (saved) void test(saved.id);
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };
  const test = async (id: string) => {
    setTesting(id);
    try {
      setList(await api.testConnector(id));
      setOpen(id);
    } finally {
      setTesting(null);
    }
  };
  const importOne = async (c: ImportCandidate) => {
    if (!c.connector) return;
    const next = await api.saveConnector({ ...c.connector, enabled: true, agents: 'all' });
    setList(next);
    setCands((cs) => (cs ?? []).filter((x) => x !== c));
  };

  return (
    <>
      <h3>Connectors</h3>
      <p className="muted small">
        MCP servers you set up once here are given to every agent session — Claude Code, Codex, Antigravity and the rest — so all of them get the same tools (GitHub, a
        database, a browser…). Values you enter for env vars and headers are stored encrypted in the keychain. Changes apply to new sessions.
      </p>
      <div className="row" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn small primary" onClick={() => edit()}>
          <Plus size={13} /> Add connector
        </button>
        <button className="btn small" onClick={() => void api.connectorCandidates().then(setCands)}>
          <Download size={13} /> Import from Claude / Codex / Gemini
        </button>
      </div>

      {cands && (
        <div className="card set-card">
          <div className="row">
            <b className="grow">Found in your other tools</b>
            <button className="btn ghost small" onClick={() => setCands(null)}>
              Close
            </button>
          </div>
          <p className="small muted" style={{ margin: '4px 0 8px' }}>
            Read-only: importing copies the settings here and never changes those files. Claude Code and Codex already load their own servers, so import mainly for the
            other agents.
          </p>
          {cands.length === 0 && <div className="small muted">Nothing new to import.</div>}
          {cands.map((c) => (
            <div key={`${c.source}:${c.name}`} className="row set-row">
              {c.connector?.transport === 'http' ? <Globe size={14} className="muted" /> : <SquareTerminal size={14} className="muted" />}
              <b>{c.name}</b>
              <span className="small muted ellipsis grow">
                {c.connector?.transport === 'http' ? c.connector.url : `${c.connector?.command} ${(c.connector?.args ?? []).join(' ')}`} · {c.source}
              </span>
              <button className="btn small" onClick={() => void importOne(c)}>
                Import
              </button>
            </div>
          ))}
        </div>
      )}

      {form && (
        <div className="card set-card">
          <div className="field" style={{ marginTop: 0 }}>
            <label>Name</label>
            <input className="input" value={form.name} placeholder="github" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </div>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            <button className={form.transport === 'stdio' ? 'active' : ''} onClick={() => setForm({ ...form, transport: 'stdio' })}>
              <SquareTerminal size={13} /> Command
            </button>
            <button className={form.transport === 'http' ? 'active' : ''} onClick={() => setForm({ ...form, transport: 'http' })}>
              <Globe size={13} /> URL
            </button>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <div className="field">
                <label>Command</label>
                <input className="input mono" value={form.command} placeholder="npx" onChange={(e) => setForm({ ...form, command: e.target.value })} />
              </div>
              <div className="field">
                <label>Arguments (one per line)</label>
                <textarea className="input mono" rows={3} value={form.args} placeholder={'-y\n@modelcontextprotocol/server-github'} onChange={(e) => setForm({ ...form, args: e.target.value })} />
              </div>
              <div className="field">
                <label>Environment (KEY=value, one per line)</label>
                <textarea className="input mono" rows={2} value={form.env} placeholder="GITHUB_TOKEN=ghp_…" onChange={(e) => setForm({ ...form, env: e.target.value })} />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>URL</label>
                <input className="input mono" value={form.url} placeholder="https://example.com/mcp" onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </div>
              <div className="field">
                <label>Headers (Name: value, one per line)</label>
                <textarea className="input mono" rows={2} value={form.headers} placeholder="Authorization: Bearer …" onChange={(e) => setForm({ ...form, headers: e.target.value })} />
              </div>
            </>
          )}
          <div className="field">
            <label>Agents</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
              <label className="row small" style={{ gap: 5 }}>
                <input type="checkbox" checked={form.agents === 'all'} onChange={(e) => setForm({ ...form, agents: e.target.checked ? 'all' : agentDefs.map((d) => d.id) })} /> All agents
              </label>
              {form.agents !== 'all' &&
                agentDefs.map((d) => (
                  <label key={d.id} className="row small" style={{ gap: 5 }}>
                    <input
                      type="checkbox"
                      checked={(form.agents as string[]).includes(d.id)}
                      onChange={(e) => {
                        const cur = form.agents as string[];
                        setForm({ ...form, agents: e.target.checked ? [...cur, d.id] : cur.filter((x) => x !== d.id) });
                      }}
                    />
                    <AgentLogo def={d} size={16} /> {d.name}
                  </label>
                ))}
            </div>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small primary" onClick={() => void save()}>
              Save and test
            </button>
            <button className="btn small" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {list.length === 0 && !form && (
        <div className="set-empty">
          <Plug size={22} className="muted" />
          <span className="muted small">No connectors yet. Add one, or import the servers you already set up for Claude, Codex or Gemini.</span>
        </div>
      )}
      {list.map((c) => (
        <div key={c.id} className="card set-card">
          <div className="row" style={{ gap: 8 }}>
            {c.transport === 'http' ? <Globe size={16} className="muted" /> : <SquareTerminal size={16} className="muted" />}
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div className="small muted ellipsis mono">{c.transport === 'http' ? c.url : `${c.command} ${(c.args ?? []).join(' ')}`}</div>
            </div>
            <button className="btn small" disabled={testing === c.id} onClick={() => void test(c.id)} title="Start it and list its tools">
              {testing === c.id ? <Loader2 size={13} className="spin" /> : <Zap size={13} />} Test
            </button>
            <button className="btn ghost icon" title="Edit" onClick={() => edit(c)}>
              <Pencil size={14} />
            </button>
            <button
              className="btn ghost icon"
              title="Remove"
              onClick={async () => {
                if (confirm(`Remove the connector "${c.name}"? Its saved env values are deleted too.`)) setList(await api.removeConnector(c.id));
              }}
            >
              <Trash2 size={14} />
            </button>
            <button className={`switch ${c.enabled ? 'on' : ''}`} title={c.enabled ? 'On' : 'Off'} onClick={() => void api.enableConnector(c.id, !c.enabled).then(setList)} />
          </div>
          <div className="row small muted" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span className="row" style={{ gap: 4 }}>
              {c.agents === 'all'
                ? 'All agents'
                : c.agents.length
                  ? c.agents.map((a) => {
                      const d = agentDefs.find((x) => x.id === a);
                      return d ? <AgentLogo key={a} def={d} size={15} /> : <span key={a}>{a}</span>;
                    })
                  : 'No agents'}
            </span>
            {c.source && <span>· from {c.source}</span>}
            {c.error ? (
              <span className="error-text">· {c.error.split('\n')[0]}</span>
            ) : c.tools ? (
              <span className="link-like" onClick={() => setOpen(open === c.id ? null : c.id)}>
                · {c.tools.length} {c.tools.length === 1 ? "tool" : "tools"} {open === c.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            ) : (
              <span>· not tested yet</span>
            )}
          </div>
          {open === c.id && c.error && <pre className="set-pre">{c.error}</pre>}
          {open === c.id && c.tools && (
            <div className="set-tools">
              {c.tools.map((t) => (
                <div key={t.name} className="small">
                  <code>{t.name}</code> <span className="muted">{t.description?.split('\n')[0]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
