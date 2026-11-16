import { useEffect, useState } from 'react';
import { Check, Plus, ShieldCheck, ShieldX, Trash2, Workflow } from 'lucide-react';
import type { AgentDef, ConnectorView, Settings, ToolRule } from '@shared/types';
import { api } from '../../api';
import { AgentLogo } from '../../logos';
import { AgentSelect } from '../AgentSelect';

const KINDS: [string, string][] = [
  ['kind:read', 'Any file read'],
  ['kind:edit', 'Any file edit'],
  ['kind:execute', 'Any command'],
  ['kind:fetch', 'Any web fetch'],
  ['kind:delete', 'Any delete'],
];
const COMMON = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const label = (tool: string) => KINDS.find(([k]) => k === tool)?.[1] ?? tool;
const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Settings → Tools: answers for permission requests, so routine calls don't interrupt you. A rule names a tool
 * (or a kind of action), optionally only when the command or file matches a pattern, and allows or denies it.
 */
export function ToolsSettings({ settings, agentDefs, onSettings }: { settings: Settings; agentDefs: AgentDef[]; onSettings: (s: Settings) => void }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [form, setForm] = useState<Omit<ToolRule, 'id'>>({ agent: '*', tool: '', match: '', action: 'allow' });
  useEffect(() => void api.connectors().then(setConnectors), []);
  // The main process adds "asked for recently" entries while agents work, so read the settings fresh.
  useEffect(() => void api.state().then((s) => onSettings(s.settings)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const rules = settings.toolRules ?? [];
  const seenTools = settings.seenTools ?? [];
  const save = async (next: ToolRule[]) => onSettings(await api.setToolRules(next));
  const add = (r: Omit<ToolRule, 'id'>) => {
    if (!r.tool.trim()) return;
    void save([...rules, { ...r, id: newId(), tool: r.tool.trim(), match: r.match?.trim() || undefined }]);
  };
  const agentName = (id: string) => (id === '*' ? 'All agents' : (agentDefs.find((d) => d.id === id)?.name ?? id));
  const suggestions = [
    ...new Set([
      ...KINDS.map(([k]) => k),
      ...COMMON,
      ...seenTools.map((t) => t.tool),
      ...connectors.flatMap((c) => (c.tools ?? []).map((t) => `mcp__${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}__${t.name}`)),
    ]),
  ];

  return (
    <>
      <h3>Tools</h3>
      <p className="muted small">
        Decide once how agents may use a tool, instead of answering the same permission request again and again. The first matching rule answers; anything without a
        rule still asks you. Tool names come from the agent (Claude: <code>Bash</code>, <code>Edit</code>, <code>mcp__server__tool</code>); "Any command" and the other
        kinds work for every agent.
      </p>

      <div className="card set-card">
        <div className="row small" style={{ gap: 8 }}>
          <Workflow size={15} className="muted" />
          <span className="grow">
            <b>Olympus Coder's own tools</b> (session info, spawn / wait / message sub-sessions)
          </span>
          <span className="task-badge ok">always allowed</span>
        </div>
      </div>

      <div className="field">
        <label>Rules</label>
        {rules.length === 0 && <span className="small muted">No rules yet — every request asks you. Add one below, or from the tools agents asked for recently.</span>}
        {rules.map((r, i) => (
          <div key={r.id} className="row set-row">
            <span className={`task-badge ${r.action === 'allow' ? 'ok' : 'bad'}`}>{r.action === 'allow' ? 'Allow' : 'Deny'}</span>
            <b className="mono small">{label(r.tool)}</b>
            {r.match && <span className="small muted mono ellipsis">when “{r.match}”</span>}
            <span className="small muted grow row" style={{ gap: 5 }}>
              · {agentDefs.find((d) => d.id === r.agent) ? <AgentLogo def={agentDefs.find((d) => d.id === r.agent)!} size={15} /> : null}
              {agentName(r.agent)}
            </span>
            {i > 0 && (
              <button className="btn ghost small" title="Check this rule earlier" onClick={() => void save([...rules.slice(0, i - 1), r, rules[i - 1], ...rules.slice(i + 1)])}>
                ↑
              </button>
            )}
            <button className="btn ghost icon" title="Delete rule" onClick={() => void save(rules.filter((x) => x.id !== r.id))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="card set-card">
        <b className="small">New rule</b>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <select className="input" style={{ width: 'auto' }} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as 'allow' | 'deny' })}>
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          <input className="input mono" style={{ flex: '1 1 180px' }} list="tool-names" placeholder="Tool, e.g. Bash or kind:execute" value={form.tool} onChange={(e) => setForm({ ...form, tool: e.target.value })} />
          <datalist id="tool-names">
            {suggestions.map((s) => (
              <option key={s} value={s}>
                {label(s) !== s ? label(s) : undefined}
              </option>
            ))}
          </datalist>
          <input className="input mono" style={{ flex: '1 1 160px' }} placeholder="only when… (optional, * = anything)" value={form.match ?? ''} onChange={(e) => setForm({ ...form, match: e.target.value })} />
          <AgentSelect value={form.agent} agents={agentDefs} allLabel="All agents" width={190} onChange={(id) => setForm({ ...form, agent: id })} />
          <button
            className="btn small primary"
            disabled={!form.tool.trim()}
            onClick={() => {
              add(form);
              setForm({ agent: '*', tool: '', match: '', action: 'allow' });
            }}
          >
            <Plus size={13} /> Add
          </button>
        </div>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Example: Allow · <code>kind:execute</code> · only when <code>npm test*</code> — runs your tests without asking, but still asks for every other command.
        </p>
      </div>

      <div className="field">
        <div className="row">
          <label className="grow">Asked for recently</label>
          {seenTools.length > 0 && (
            <button className="btn ghost small" onClick={() => void api.forgetSeenTools().then(onSettings)}>
              Clear
            </button>
          )}
        </div>
        {seenTools.length === 0 && <span className="small muted">Tools appear here after an agent asks you for permission.</span>}
        {seenTools.map((t) => {
          const def = agentDefs.find((d) => d.id === t.agent);
          const ruled = rules.some((r) => (r.agent === '*' || r.agent === t.agent) && r.tool === t.tool && !r.match);
          return (
            <div key={`${t.agent}:${t.tool}`} className="row set-row">
              {def && <AgentLogo def={def} size={16} />}
              <b className="mono small">{label(t.tool)}</b>
              <span className="small muted ellipsis grow mono" title={t.example}>
                {t.example}
              </span>
              {ruled ? (
                <span className="small muted row" style={{ gap: 3 }}>
                  <Check size={12} /> has a rule
                </span>
              ) : (
                <>
                  <button className="btn small" title={`Always allow ${t.tool} for ${def?.name ?? t.agent}`} onClick={() => add({ agent: t.agent, tool: t.tool, action: 'allow' })}>
                    <ShieldCheck size={13} /> Always allow
                  </button>
                  <button className="btn ghost small" title={`Always deny ${t.tool} for ${def?.name ?? t.agent}`} onClick={() => add({ agent: t.agent, tool: t.tool, action: 'deny' })}>
                    <ShieldX size={13} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
