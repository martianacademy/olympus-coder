import { useEffect, useState } from 'react';
import { Download, FolderOpen, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { ImportCandidate, SkillView } from '@shared/types';
import { api } from '../../api';
import { CodeEditor } from '../Editor';

type Form = { id?: string; name: string; description: string; body: string };
const TEMPLATE = `# What this skill is for

When to use it, in one or two sentences.

## Steps

1. …
2. …

## Rules

- …
`;
const clean = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Settings → Skills: reusable instructions every agent can use. Each lives in <shared folder>/skills/<name>/SKILL.md;
 * the operating guide lists the enabled ones, and an agent reads the file when a task matches its description.
 */
export function SkillsSettings() {
  const [list, setList] = useState<SkillView[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState('');
  const [cands, setCands] = useState<ImportCandidate[] | null>(null);
  const dark = document.documentElement.dataset.theme === 'dark';
  useEffect(() => void api.skills().then(setList), []);

  const edit = async (s?: SkillView) => {
    setError('');
    if (!s) return setForm({ name: '', description: '', body: TEMPLATE });
    const full = await api.skill(s.id);
    setForm({ id: s.id, name: full.name, description: full.description, body: full.body ?? '' });
  };
  const save = async () => {
    if (!form) return;
    try {
      setList(await api.saveSkill(form));
      setForm(null);
    } catch (e) {
      setError(clean(e));
    }
  };

  return (
    <>
      <h3>Skills</h3>
      <p className="muted small">
        A skill is a short playbook for one kind of task — "write a release note", "add an API endpoint the way this team does it". Skills here are shared by every
        agent: each new session lists the enabled ones, and the agent opens a skill's instructions when your request matches its description.
      </p>
      <div className="row" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn small primary" onClick={() => void edit()}>
          <Plus size={13} /> New skill
        </button>
        <button className="btn small" onClick={() => void api.skillCandidates().then(setCands)}>
          <Download size={13} /> Import
        </button>
        <button className="btn small" onClick={() => void api.revealSkills()}>
          <FolderOpen size={13} /> Open folder
        </button>
      </div>

      {cands && (
        <div className="card set-card">
          <div className="row">
            <b className="grow">Skills found on this computer</b>
            <button className="btn ghost small" onClick={() => setCands(null)}>
              Close
            </button>
          </div>
          <p className="small muted" style={{ margin: '4px 0 8px' }}>
            From ~/.claude/skills, ~/.codex/skills, ~/.gemini/skills and your projects. Importing copies the folder; the original is never changed.
          </p>
          {cands.length === 0 && <div className="small muted">Nothing new to import.</div>}
          {cands.map((c) => (
            <div key={c.path} className="row set-row">
              <Sparkles size={14} className="muted" />
              <div className="grow" style={{ minWidth: 0 }}>
                <b className="small">{c.name}</b> <span className="small muted">· {c.source}</span>
                <div className="small muted ellipsis">{c.description}</div>
              </div>
              <button
                className="btn small"
                onClick={async () => {
                  setList(await api.importSkill(c.path!));
                  setCands((cs) => (cs ?? []).filter((x) => x !== c));
                }}
              >
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
            <input className="input" value={form.name} placeholder="release-notes" onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus={!form.id} />
          </div>
          <div className="field">
            <label>Description — when should an agent use it?</label>
            <input className="input" value={form.description} placeholder="Use when writing release notes or a changelog entry." onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field">
            <label>Instructions (Markdown)</label>
            <div className="set-editor">
              <CodeEditor path="SKILL.md" value={form.body} dark={dark} onChange={(body) => setForm((f) => (f ? { ...f, body } : f))} onSave={() => void save()} />
            </div>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small primary" onClick={() => void save()}>
              Save
            </button>
            <button className="btn small" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {list.length === 0 && !form && (
        <div className="set-empty">
          <Sparkles size={22} className="muted" />
          <span className="muted small">No shared skills yet. Write one, or import the skills you already have for Claude or Codex.</span>
        </div>
      )}
      {list.map((s) => (
        <div key={s.id} className="card set-card">
          <div className="row" style={{ gap: 8 }}>
            <Sparkles size={16} className="muted" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <div className="small muted">{s.description}</div>
            </div>
            <button className="btn ghost icon" title="Edit" onClick={() => void edit(s)}>
              <Pencil size={14} />
            </button>
            <button
              className="btn ghost icon"
              title="Move to Trash"
              onClick={async () => {
                if (confirm(`Move the skill "${s.name}" to the Trash?`)) setList(await api.deleteSkill(s.id));
              }}
            >
              <Trash2 size={14} />
            </button>
            <button className={`switch ${s.enabled ? 'on' : ''}`} title={s.enabled ? 'On' : 'Off'} onClick={() => void api.enableSkill(s.id, !s.enabled).then(setList)} />
          </div>
        </div>
      ))}
    </>
  );
}
