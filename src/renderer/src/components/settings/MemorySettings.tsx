import { useEffect, useRef, useState } from 'react';
import { Brain, FileText, FolderOpen, Plus, Save, ScrollText, Trash2 } from 'lucide-react';
import type { MemoryView, Project } from '@shared/types';
import { api } from '../../api';
import { CodeEditor } from '../Editor';

type MemType = 'user' | 'feedback' | 'project' | 'reference';
const clean = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Settings → Shared memory, the editor half: AGENTS.md (instructions for every agent) and each project's memory
 * files — the same one-fact-per-file folder and MEMORY.md index the agents read and write.
 */
export function MemoryEditor() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState('');
  const [mem, setMem] = useState<MemoryView | null>(null);
  const [agentsMd, setAgentsMd] = useState<string | null>(null);
  const [agentsSaved, setAgentsSaved] = useState('');
  const [file, setFile] = useState<{ name: string; text: string; saved: string } | null>(null);
  const [adding, setAdding] = useState<{ title: string; type: MemType; description: string; body: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [instr, setInstr] = useState<{ text: string; saved: string } | null>(null);
  const pidRef = useRef(pid);
  pidRef.current = pid;

  useEffect(() => {
    void Promise.all([api.projects(), api.generalProject()]).then(([ps, g]) => {
      const all = [...ps, g];
      setProjects(all);
      setPid((p) => p || all[0]?.id || '');
    });
  }, []);
  const load = async (id = pid) => {
    if (!id) return;
    const m = await api.memory(id);
    if (id !== pidRef.current) return; // the user picked another project meanwhile
    setMem(m);
    // Only fill the editor when it is empty (just switched project), so reloads never drop unsaved edits.
    if (m) setInstr((cur) => cur ?? { text: m.projectInstructions, saved: m.projectInstructions });
    if (agentsMd === null && m) {
      setAgentsMd(m.globalInstructions);
      setAgentsSaved(m.globalInstructions);
    }
  };
  useEffect(() => {
    setFile(null);
    setInstr(null);
    void load(pid);
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (t: string) => {
    setMsg(t);
    setTimeout(() => setMsg(''), 1800);
  };
  const openFile = async (name: string) => {
    const text = await api.readMemory(pid, name);
    setAdding(null);
    setFile({ name, text, saved: text });
  };
  const saveInstr = async () => {
    if (!instr) return;
    await api.writeProjectInstructions(pid, instr.text);
    setInstr({ ...instr, saved: instr.text });
    flash('Project instructions saved');
  };
  const saveFile = async () => {
    if (!file) return;
    await api.writeMemory(pid, file.name, file.text);
    setFile({ ...file, saved: file.text });
    flash('Saved');
    void load();
  };

  return (
    <>
      <div className="field">
        <div className="row">
          <label className="grow">AGENTS.md — instructions for every agent and project</label>
          {agentsMd !== null && agentsMd !== agentsSaved && <span className="small muted">unsaved</span>}
          <button
            className="btn small"
            disabled={agentsMd === null || agentsMd === agentsSaved}
            onClick={async () => {
              await api.writeGlobalInstructions(agentsMd ?? '');
              setAgentsSaved(agentsMd ?? '');
              flash('AGENTS.md saved');
            }}
          >
            <Save size={13} /> Save
          </button>
        </div>
        <div className="set-editor">
          {agentsMd !== null && <CodeEditor path="AGENTS.md" value={agentsMd} dark={dark} onChange={setAgentsMd} onSave={() => void api.writeGlobalInstructions(agentsMd).then(() => setAgentsSaved(agentsMd))} />}
        </div>
        <span className="small muted">Sent to every new agent session. Your ~/.claude, ~/.gemini and ~/.codex files are separate and not changed.</span>
      </div>

      <div className="field">
        <div className="row" style={{ gap: 8 }}>
          <label className="grow">Project</label>
          <select className="input" style={{ width: 'auto', maxWidth: 260 }} value={pid} onChange={(e) => setPid(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === 'general' ? 'General (chats)' : p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <div className="row">
          <label className="grow row" style={{ gap: 6 }}>
            <ScrollText size={14} /> Instructions for this project
          </label>
          {instr && instr.text !== instr.saved && <span className="small muted">unsaved</span>}
          <button className="btn small" disabled={!instr || instr.text === instr.saved} onClick={() => void saveInstr()}>
            <Save size={13} /> Save
          </button>
        </div>
        <div className="set-editor">
          {instr && (
            <CodeEditor
              key={pid}
              path="INSTRUCTIONS.md"
              value={instr.text}
              dark={dark}
              onChange={(text) => setInstr((c) => (c ? { ...c, text } : c))}
              onSave={() => void saveInstr()}
            />
          )}
        </div>
        <span className="small muted">
          Your rules for this project only — e.g. "Rust: no unwrap() in library code", "every result needs a proof". Every agent gets them in full and must follow
          them; running chats get changes with their next message.
        </span>
      </div>

      <div className="field">
        <div className="row" style={{ gap: 8 }}>
          <label className="grow">Project memory</label>
          <button className="btn small" onClick={() => void api.revealMemory(pid)} title="Open the folder">
            <FolderOpen size={13} />
          </button>
          <button className="btn small primary" onClick={() => (setFile(null), setAdding({ title: '', type: 'project', description: '', body: '' }))}>
            <Plus size={13} /> New memory
          </button>
        </div>
        {mem && <span className="small muted ellipsis mono">{mem.dir}</span>}
        <div className="mem-grid">
          <div className="mem-list">
            {(mem?.files ?? []).map((f) => (
              <div key={f.name} className={`mem-item ${file?.name === f.name ? 'active' : ''}`} onClick={() => void openFile(f.name)}>
                {f.name === 'MEMORY.md' ? <Brain size={13} /> : <FileText size={13} className="muted" />}
                <span className="ellipsis grow">{f.name}</span>
              </div>
            ))}
            {mem && mem.files.length <= 1 && <div className="small muted" style={{ padding: 6 }}>No memories yet. Agents add them when you say "remember …".</div>}
          </div>
          <div className="mem-edit">
            {file && (
              <>
                <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                  <b className="small grow ellipsis">{file.name}</b>
                  {file.text !== file.saved && <span className="small muted">unsaved</span>}
                  <button className="btn small" disabled={file.text === file.saved} onClick={() => void saveFile()}>
                    <Save size={13} /> Save
                  </button>
                  {file.name !== 'MEMORY.md' && (
                    <button
                      className="btn ghost icon"
                      title="Move to Trash (and drop its index line)"
                      onClick={async () => {
                        if (!confirm(`Move ${file.name} to the Trash?`)) return;
                        await api.deleteMemory(pid, file.name);
                        setFile(null);
                        void load();
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                <div className="set-editor">
                  <CodeEditor key={file.name} path={file.name} value={file.text} dark={dark} onChange={(text) => setFile((f) => (f ? { ...f, text } : f))} onSave={() => void saveFile()} />
                </div>
              </>
            )}
            {adding && (
              <div className="col" style={{ gap: 8 }}>
                <input className="input" placeholder="Title, e.g. Deploys go through staging first" value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} autoFocus />
                <div className="row" style={{ gap: 8 }}>
                  <select className="input" style={{ width: 'auto' }} value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value as MemType })}>
                    <option value="project">project</option>
                    <option value="user">user</option>
                    <option value="feedback">feedback</option>
                    <option value="reference">reference</option>
                  </select>
                  <input className="input" placeholder="One-line description (shown in the index)" value={adding.description} onChange={(e) => setAdding({ ...adding, description: e.target.value })} />
                </div>
                <textarea className="input" rows={5} placeholder="The fact. For feedback/project, add **Why:** and **How to apply:** lines." value={adding.body} onChange={(e) => setAdding({ ...adding, body: e.target.value })} />
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn small primary"
                    onClick={async () => {
                      try {
                        const name = await api.createMemory(pid, adding);
                        setAdding(null);
                        await load();
                        void openFile(name);
                        flash('Memory added');
                      } catch (e) {
                        setMsg(clean(e));
                      }
                    }}
                  >
                    Add memory
                  </button>
                  <button className="btn small" onClick={() => setAdding(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!file && !adding && <div className="small muted" style={{ padding: 10 }}>Pick a file to read or edit it.</div>}
          </div>
        </div>
        {msg && <span className="small" style={{ color: 'var(--success)' }}>{msg}</span>}
      </div>
    </>
  );
}
