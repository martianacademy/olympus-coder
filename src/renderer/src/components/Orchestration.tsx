import { memo } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, CircleSlash, GitBranch, Loader2, Send } from 'lucide-react';
import type { ThreadItem } from '@shared/types';
import { LinkedText } from '../fileLinks';
import { useStepChoice } from '../prefs';

type ToolItem = Extract<ThreadItem, { kind: 'tool' }>;

/** The app's sub-session tools: shown as a conversation between this session and its sub-sessions. */
export const ORCH_TOOLS = new Set(['spawn_subsession', 'configure_subsession', 'message_subsession', 'wait_for_subsessions', 'get_subsession', 'cancel_subsession']);
const LABELS: Record<string, string> = {
  'Spawn sub-session': 'spawn_subsession',
  'Configure sub-session': 'configure_subsession',
  'Message sub-session': 'message_subsession',
  'Wait for sub-sessions': 'wait_for_subsessions',
  'Check sub-session': 'get_subsession',
  'Stop sub-session': 'cancel_subsession',
};

const olympusToolCache = new WeakMap<ToolItem, string | null>();
const withOlympusCache = new WeakMap<ToolItem, ToolItem>();

/** Which app tool a card is, also for cards saved before the app recorded it (from the agent's name or our label). */
export function olympusTool(t: ToolItem): string | undefined {
  if (t.olympus?.tool) return t.olympus.tool;
  const hit = olympusToolCache.get(t);
  if (hit !== undefined) return hit ?? undefined;
  const title = t.title.trim().replace(/^Run\s+/, '');
  let found: string | undefined;
  for (const [label, name] of Object.entries(LABELS)) {
    if (title.startsWith(label)) {
      found = name;
      break;
    }
  }
  if (!found) {
    const m = /olympus(?:[_.]{1,2}[0-9a-f]{4,16})?[_.]{1,2}([a-z_]+)/i.exec(title.split(/[\s:(]/)[0]);
    found = m && ORCH_TOOLS.has(m[1].toLowerCase()) ? m[1].toLowerCase() : undefined;
  }
  olympusToolCache.set(t, found ?? null);
  return found;
}

/** For an old card: what the agent sent, read back from the input it showed. */
function inputOf(t: ToolItem): any {
  const c = t.content.find((x) => x.text?.startsWith('Input:'));
  try {
    return c ? JSON.parse(c.text!.replace(/^Input:\s*/, '')) : {};
  } catch {
    return {};
  }
}

/** The card with its app-tool details, filled in from its input when the app didn't record the call. */
export function withOlympus(t: ToolItem): ToolItem {
  if (t.olympus?.result !== undefined || !olympusTool(t)) return t;
  const cached = withOlympusCache.get(t);
  if (cached) return cached;
  const tool = olympusTool(t)!;
  const input = inputOf(t);
  const text =
    tool === 'spawn_subsession'
      ? input.task
      : tool === 'message_subsession'
        ? (input.text ?? input.message)
        : tool === 'configure_subsession'
          ? [input.agent && `agent=${input.agent}`, input.model && `model=${input.model}`, input.mode && `mode=${input.mode}`, input.effort && `effort=${input.effort}`, input.prompt]
              .filter(Boolean)
              .join(' · ')
          : undefined;
  const enriched: ToolItem = { ...t, olympus: { tool, ...t.olympus, text: t.olympus?.text ?? text, target: t.olympus?.target ?? (input.title ? { id: '', title: String(input.title) } : undefined) } };
  withOlympusCache.set(t, enriched);
  return enriched;
}

export const orchKind = (t: ToolItem): 'spawn' | 'message' | 'check' | 'cancel' | undefined => {
  const n = olympusTool(t);
  return n === 'spawn_subsession'
    ? 'spawn'
    : n === 'message_subsession' || n === 'configure_subsession'
      ? 'message'
      : n === 'wait_for_subsessions' || n === 'get_subsession'
        ? 'check'
        : n === 'cancel_subsession'
          ? 'cancel'
          : undefined;
};

const live = (t: ToolItem) => t.status === 'in_progress' || t.status === 'pending';

function Target({ t, onOpen }: { t: ToolItem; onOpen?: (id: string) => void }) {
  const target = t.olympus?.target;
  if (!target) return <span className="muted">a sub-session</span>;
  return target.id && onOpen ? (
    <button className="link-btn orch-target" onClick={() => onOpen(target.id)} title="Open this sub-session">
      {target.title}
    </button>
  ) : (
    <b className="orch-target">{target.title}</b>
  );
}

function Fold({ stepKey, label, text, startOpen }: { stepKey: string; label: string; text: string; startOpen?: boolean }) {
  const [choice, setChoice] = useStepChoice(stepKey);
  const open = choice ?? Boolean(startOpen);
  return (
    <div className="orch-fold">
      <button className="link-btn small muted" onClick={() => setChoice(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {label}
      </button>
      {open && (
        <pre className="orch-text">
          <LinkedText text={text} />
        </pre>
      )}
    </div>
  );
}

/**
 * A run of the session's sub-session tool calls as conversation lines: "↗ Started 3 sub-sessions" (each with
 * its task), "→ To Short 3: …", "← Checked on sub-sessions ×12" (with the latest report), "Stopped …". The text
 * comes from what the app itself sent and answered, so it reads the same whichever agent made the calls.
 */
export const OrchestrationGroup = memo(
  function OrchestrationGroup({ kind, items, onOpen }: { kind: 'spawn' | 'message' | 'check' | 'cancel'; items: ToolItem[]; onOpen?: (id: string) => void }) {
  const running = items.some(live);
  const failed = items.filter((t) => t.olympus?.isError || t.status === 'failed');
  if (kind === 'spawn')
    return (
      <div className="orch">
        <div className="orch-head">
          <GitBranch size={14} className="orch-icon" />
          <span>
            Started {items.length} sub-session{items.length > 1 ? 's' : ''}
          </span>
          {running && <Loader2 size={12} className="spin muted" />}
        </div>
        {items.map((t) => (
          <div key={t.id} className="orch-row">
            <ArrowUpRight size={13} className="muted" />
            <div className="orch-body">
              <Target t={t} onOpen={onOpen} />
              {t.olympus?.isError && <div className="small error-text">{t.olympus.result}</div>}
              {t.olympus?.text && <Fold stepKey={`orch-task:${t.id}`} label="Task" text={t.olympus.text} />}
            </div>
          </div>
        ))}
      </div>
    );
  if (kind === 'message')
    return (
      <div className="orch">
        {items.map((t) => (
          <div key={t.id} className="orch-row">
            <Send size={13} className="orch-icon" />
            <div className="orch-body">
              <div>
                {olympusTool(t) === 'configure_subsession' ? 'Configured ' : 'Message to '}
                <Target t={t} onOpen={onOpen} />
                {live(t) && <Loader2 size={12} className="spin muted" style={{ marginLeft: 6 }} />}
              </div>
              {t.olympus?.text && <div className="orch-quote">{t.olympus.text}</div>}
              {t.olympus?.isError && <div className="small error-text">{t.olympus.result}</div>}
            </div>
          </div>
        ))}
      </div>
    );
  if (kind === 'cancel')
    return (
      <div className="orch">
        {items.map((t) => (
          <div key={t.id} className="orch-row">
            <CircleSlash size={13} className="muted" />
            <div className="orch-body">
              Stopped <Target t={t} onOpen={onOpen} />
            </div>
          </div>
        ))}
      </div>
    );
  // Checks: one line for the whole run, the latest answer inside.
  const answered = [...items].reverse().find((t) => t.olympus?.result);
  const who = [...new Set(items.map((t) => t.olympus?.target?.title ?? t.olympus?.text).filter(Boolean))].slice(0, 3).join(', ');
  return (
    <div className="orch">
      <div className="orch-row">
        {running ? <Loader2 size={13} className="spin orch-icon" /> : <ArrowDownLeft size={13} className="orch-icon" />}
        <div className="orch-body">
          <div>
            {running ? 'Waiting for sub-sessions' : 'Checked on sub-sessions'}
            {who && <span className="muted"> · {who}</span>}
            {items.length > 1 && <span className="muted"> · ×{items.length}</span>}
            {failed.length > 0 && <span className="error-text"> · {failed.length} failed</span>}
          </div>
          {answered?.olympus?.result ? (
            <Fold stepKey={`orch-report:${items[0].id}`} label={items.length > 1 ? 'Latest report' : 'Report'} text={answered.olympus.result} />
          ) : (
            !running && <div className="small muted">The answer wasn't recorded (this call happened before the app kept them).</div>
          )}
        </div>
      </div>
    </div>
  );
  },
  (a, b) => a.kind === b.kind && a.onOpen === b.onOpen && a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]),
);
