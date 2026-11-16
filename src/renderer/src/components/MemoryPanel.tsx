import { useEffect, useState } from 'react';
import { FileText, FolderOpen, RefreshCw, X } from 'lucide-react';
import type { MemoryView } from '@shared/types';
import { api } from '../api';

/** Shows the shared memory folder for the current project, so you can watch one agent's memory appear for the next. */
export function MemoryPanel({ projectId, threadItems, onClose }: { projectId: string; threadItems: number; onClose: () => void }) {
  const [mem, setMem] = useState<MemoryView | null>(null);
  const load = () => void api.memory(projectId).then(setMem);
  useEffect(load, [projectId, threadItems]);
  return (
    <aside className="memory-panel">
      <div className="titlebar" style={{ padding: '0 10px' }}>
        <b>Shared memory</b>
        <div className="spacer" />
        <button className="btn ghost icon" title="Refresh" onClick={load}>
          <RefreshCw size={14} />
        </button>
        <button className="btn ghost icon" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="sidebar-scroll col" style={{ gap: 10 }}>
        {mem && (
          <>
            <div className="small muted" style={{ wordBreak: 'break-all' }}>
              {mem.dir}
            </div>
            <div className="row">
              <button className="btn small" onClick={() => void api.revealMemory(projectId)}>
                <FolderOpen size={14} /> Open folder
              </button>
              <button className="btn small" onClick={() => void api.openGlobalInstructions()}>
                <FileText size={14} /> AGENTS.md
              </button>
            </div>
            <div className="small" style={{ fontWeight: 600 }}>
              MEMORY.md
            </div>
            <pre>{mem.index || '(empty)'}</pre>
            <div className="small" style={{ fontWeight: 600 }}>
              Files ({mem.files.length})
            </div>
            {mem.files.map((f) => (
              <div key={f.name} className="row small">
                <FileText size={13} className="muted" />
                <span className="grow ellipsis">{f.name}</span>
                <span className="muted">{new Date(f.mtime).toLocaleTimeString()}</span>
              </div>
            ))}
            <p className="small muted">Every agent gets this folder and index in each new session. Tell one agent "remember…", then pick another agent from the dropdown and ask it.</p>
          </>
        )}
      </div>
    </aside>
  );
}
