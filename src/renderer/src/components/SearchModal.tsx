import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { AgentDef, SearchHit } from '@shared/types';
import { api } from '../api';
import { AgentLogo } from '../logos';

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** ⌘K: search every chat in every project, by title and message text. */
export function SearchModal({ agentDefs, onOpen, onClose }: { agentDefs: Record<string, AgentDef>; onOpen: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await api.searchThreads(q);
      if (n === seq.current) {
        setHits(r);
        setSel(0);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  const open = (h?: SearchHit) => {
    if (!h) return;
    onOpen(h.threadId);
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search-modal">
        <div className="modal-head" style={{ gap: 10 }}>
          <Search size={18} className="muted" />
          <input
            className="search-input"
            autoFocus
            placeholder="Search all chats…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(hits.length - 1, s + 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              if (e.key === 'Enter') open(hits[sel]);
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="modal-body" style={{ padding: 6, maxHeight: '60vh' }}>
          {q.trim() && !hits.length && <p className="muted" style={{ padding: '6px 10px' }}>No results.</p>}
          {!q.trim() && <p className="muted small" style={{ padding: '6px 10px' }}>Type any word from a title or message.</p>}
          {hits.map((h, i) => {
            const d = agentDefs[h.agentId];
            return (
              <div key={h.threadId} className={`search-hit ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => open(h)}>
                {d && <AgentLogo def={d} />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <b className="ellipsis">{highlight(h.title, q)}</b>
                    <span className="small muted" style={{ marginLeft: 'auto', flex: 'none' }}>
                      {h.projectName} · {new Date(h.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  {h.snippet !== h.title && <div className="small muted ellipsis">{highlight(h.snippet, q)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
