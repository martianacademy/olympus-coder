import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Copy, GitBranch, Loader2, Users, X } from 'lucide-react';
import type { AgentDef, AttachmentView } from '@shared/types';
import { api } from '../api';
import { copyMessage } from '../clipboard';
import { AgentLogo } from '../logos';

export interface SecondOpinionTarget {
  threadId: string;
  itemId: string;
  agentId: string;
  agentDefs: Record<string, AgentDef>;
}

/**
 * Hover actions under a message: copy it (a user message with its attachments, so pasting into any composer
 * restores both), ask other agents for a second opinion, or fork a sub-session.
 */
export function MsgActions({
  text,
  attachments,
  onFork,
  align,
  secondOpinion,
}: {
  text: string;
  attachments?: AttachmentView[];
  onFork: () => void;
  align: 'start' | 'end';
  secondOpinion?: SecondOpinionTarget;
}) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const [asking, setAsking] = useState(false);
  return (
    <div className={`msg-actions ${asking ? 'pinned' : ''}`} style={{ justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }}>
      {secondOpinion && (
        <button className="btn ghost icon" title="Second opinion: ask other agents about this" onClick={() => setAsking((a) => !a)}>
          <Users size={14} />
        </button>
      )}
      {asking && secondOpinion && <SecondOpinionPopover {...secondOpinion} onClose={() => setAsking(false)} />}
      <button
        className="btn ghost icon"
        title={copied === 'fail' ? 'Could not copy: the clipboard is not available here' : attachments?.length ? 'Copy message and attachments' : 'Copy'}
        data-testid="msg-copy"
        data-copied={copied || undefined}
        onClick={() => {
          void copyMessage({ text, attachments }).then((ok) => {
            setCopied(ok ? 'ok' : 'fail');
            setTimeout(() => setCopied(''), ok ? 1200 : 2400);
          });
        }}
      >
        {copied === 'ok' ? <Check size={14} /> : copied === 'fail' ? <X size={14} /> : <Copy size={14} />}
      </button>
      <button className="btn ghost icon" title="Fork from here (new sub-session)" onClick={onFork}>
        <GitBranch size={14} />
      </button>
    </div>
  );
}

/**
 * Ask other agents about one message, in parallel and read-only. Lists the agents other than this chat's, with
 * the ones that can't run (not installed, not logged in) greyed out.
 */
function SecondOpinionPopover(props: SecondOpinionTarget & { onClose: () => void }) {
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const others = Object.values(props.agentDefs).filter((d) => d.id !== props.agentId);
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    const top = el?.closest('.chat-scroll')?.getBoundingClientRect().top ?? 0;
    if (el && el.getBoundingClientRect().top < top + 8) setBelow(true);
  }, [statuses]);
  const ready = (id: string) => !['not-installed', 'needs-login', 'error'].includes(statuses[id] ?? 'unknown');
  useEffect(() => {
    void api.agents().then((r) => {
      const st = Object.fromEntries(r.statuses.map((s) => [s.id, s.state]));
      setStatuses(st);
      setPicked(new Set(others.filter((d) => !['not-installed', 'needs-login', 'error'].includes(st[d.id] ?? 'unknown')).map((d) => d.id)));
    });
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && props.onClose();
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    return () => document.removeEventListener('mousedown', off);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await api.secondOpinion(props.threadId, props.itemId, [...picked]);
      window.dispatchEvent(new CustomEvent('olympus:show-tasks'));
      props.onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`so-pop ${below ? 'below' : ''}`} ref={box}>
      <div className="so-title">Second opinion</div>
      <div className="so-sub">Other agents look at this message read-only and reply with the cause and a fix. Answers show in Tasks.</div>
      <div className="so-list">
        {others.map((d) => (
          <label key={d.id} className={`so-agent ${ready(d.id) ? '' : 'off'}`} title={ready(d.id) ? '' : statuses[d.id] === 'needs-login' ? 'Needs login' : 'Not available'}>
            <input
              type="checkbox"
              disabled={!ready(d.id)}
              checked={picked.has(d.id)}
              onChange={(e) =>
                setPicked((p) => {
                  const n = new Set(p);
                  if (e.target.checked) n.add(d.id);
                  else n.delete(d.id);
                  return n;
                })
              }
            />
            <AgentLogo def={d} size={16} />
            <span className="grow ellipsis">{d.name}</span>
            {!ready(d.id) && <span className="small muted">{statuses[d.id] === 'needs-login' ? 'log in first' : 'not available'}</span>}
          </label>
        ))}
        {!others.length && <div className="small muted">No other agents are set up.</div>}
      </div>
      {error && <div className="small error-text">{error}</div>}
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn small ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!picked.size || busy} onClick={() => void go()}>
          {busy ? <Loader2 size={12} className="spin" /> : null} Ask {picked.size || ''} agent{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}
