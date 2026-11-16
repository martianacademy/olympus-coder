import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Users } from 'lucide-react';
import type { AgentDef } from '@shared/types';
import { AgentLogo } from '../logos';

/**
 * A dropdown for choosing an agent that shows each agent's logo — a native <select> can only show text.
 * `allLabel` adds an "all agents" choice with the value '*'.
 */
export function AgentSelect(props: { value: string; agents: AgentDef[]; onChange: (id: string) => void; allLabel?: string; width?: number | string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const cur = props.agents.find((a) => a.id === props.value);
  const pick = (id: string) => {
    props.onChange(id);
    setOpen(false);
  };
  const row = (id: string, label: string, icon: React.ReactNode) => (
    <div key={id} className={`menu-item ${props.value === id ? 'selected' : ''}`} onClick={() => pick(id)} role="option" aria-selected={props.value === id}>
      {icon}
      <span className="grow ellipsis">{label}</span>
      {props.value === id && <Check size={14} className="muted" />}
    </div>
  );
  return (
    <div className="agent-select" ref={ref} style={{ width: props.width }}>
      <button type="button" className="select agent-select-btn" disabled={props.disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {cur ? <AgentLogo def={cur} size={18} /> : <Users size={16} className="muted" />}
        <span className="grow ellipsis">{cur?.name ?? props.allLabel ?? 'Choose an agent'}</span>
        <ChevronDown size={15} className="muted" />
      </button>
      {open && (
        <div className="menu agent-select-menu" role="listbox">
          {props.allLabel && row('*', props.allLabel, <Users size={16} className="muted" />)}
          {props.agents.map((a) => row(a.id, a.name, <AgentLogo def={a} size={18} />))}
        </div>
      )}
    </div>
  );
}
