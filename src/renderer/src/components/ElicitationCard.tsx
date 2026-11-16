import { useMemo, useState } from 'react';
import { Check, ChevronRight, CircleCheck, CircleSlash, Clock, ExternalLink, Globe, Loader2, MessageCircleQuestionMark, X } from 'lucide-react';
import type { ThreadItem } from '@shared/types';
import { askQuestions, describeAnswer, fieldError, initialValue, parseElicitSchema, type ElicitField, type ElicitOption, type ElicitValue } from '@shared/elicitation';
import { api } from '../api';
import { isRemoteBrowser } from '../responsive';
import '../elicitation.css';

type AskItem = Extract<ThreadItem, { kind: 'elicitation' }>;
type Values = Record<string, ElicitValue | undefined>;

/**
 * A question from the agent (ACP elicitation). Claude Code's AskUserQuestion reads as plain questions with option
 * chips and an optional "Other" answer; any other form is drawn from its schema; a URL request shows the link with
 * Open link. Once answered it folds to one line with the answer, and opens again on click.
 */
export function ElicitationCard({ item, threadId, agentName, compact }: { item: AskItem; threadId: string; agentName: string; compact?: boolean }) {
  const waitingOnLink = item.mode === 'url' && item.resolved === 'accepted' && !item.completed;
  if (item.resolved && !waitingOnLink) return <AnsweredCard item={item} agentName={agentName} compact={compact} />;
  return item.mode === 'url' ? <UrlCard item={item} threadId={threadId} agentName={agentName} compact={compact} /> : <FormCard item={item} threadId={threadId} agentName={agentName} compact={compact} />;
}

function send(threadId: string, item: AskItem, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) {
  return api.elicitation(threadId, item.id, action, content);
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function DismissButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="btn ghost icon elicit-dismiss" title="Dismiss without answering" aria-label="Dismiss without answering" onClick={onClick} disabled={disabled} data-testid="elicit-cancel">
      <X size={14} />
    </button>
  );
}

// ------------------------------------------------------------------ form mode

function FormCard({ item, threadId, agentName, compact }: { item: AskItem; threadId: string; agentName: string; compact?: boolean }) {
  const { fields } = useMemo(() => parseElicitSchema(item.schema), [item.schema]);
  const ask = useMemo(() => askQuestions(fields), [fields]);
  const [values, setValues] = useState<Values>(() => Object.fromEntries(fields.map((f) => [f.key, initialValue(f)])));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setValue = (key: string, v: ElicitValue | undefined) => setValues((cur) => ({ ...cur, [key]: v }));

  const errors = Object.fromEntries(fields.map((f) => [f.key, fieldError(f, values[f.key])]).filter(([, e]) => e)) as Record<string, string>;
  const answeredSomething = !ask || ask.some((q) => {
    const v = values[q.choice.key];
    const o = q.other ? values[q.other.key] : undefined;
    return (Array.isArray(v) ? v.length > 0 : Boolean(v)) || (typeof o === 'string' && o.trim() !== '');
  });

  const act = async (action: 'accept' | 'decline' | 'cancel') => {
    if (busy) return;
    if (action === 'accept') {
      setTried(true);
      if (Object.keys(errors).length || !answeredSomething) return;
    }
    setBusy(true);
    setError('');
    try {
      await send(threadId, item, action, action === 'accept' ? toContent(fields, values) : undefined);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void act('accept');
    }
  };

  const single = ask?.length === 1 ? ask[0] : undefined;
  return (
    <div className={`elicit ${compact ? 'compact' : ''}`} data-testid="elicit-card" data-mode="form" data-ask={ask ? '1' : '0'}>
      <div className="elicit-head">
        <MessageCircleQuestionMark size={15} className="elicit-icon" />
        <span className="grow ellipsis">{ask ? `${agentName} has a question` : `${agentName} needs a few details`}</span>
        <DismissButton onClick={() => void act('cancel')} disabled={busy} />
      </div>
      {single?.choice.title && <div className="elicit-tag">{single.choice.title}</div>}
      {item.message && <div className="elicit-message">{item.message}</div>}

      {ask ? (
        ask.map((q, i) => (
          <div key={q.choice.key} className="elicit-q" data-testid={`elicit-q-${i}`}>
            {ask.length > 1 && (
              <div className="elicit-q-head">
                {q.choice.title && <span className="elicit-tag">{q.choice.title}</span>}
                {q.choice.description && <span className="elicit-q-text">{q.choice.description}</span>}
              </div>
            )}
            <Options field={q.choice} value={values[q.choice.key]} onChange={(v) => setValue(q.choice.key, v)} />
            {q.other && (
              <input
                className="elicit-input elicit-other"
                data-testid={`elicit-other-${i}`}
                placeholder={q.choice.kind === 'multi' ? 'Add your own answer (optional)' : 'Other: type your own answer (optional)'}
                value={typeof values[q.other.key] === 'string' ? (values[q.other.key] as string) : ''}
                onChange={(e) => setValue(q.other!.key, e.target.value)}
                onKeyDown={onEnter}
              />
            )}
          </div>
        ))
      ) : (
        <div className="elicit-fields">
          {fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key]} error={tried ? errors[f.key] : undefined} onChange={(v) => setValue(f.key, v)} onEnter={onEnter} />
          ))}
        </div>
      )}

      {(error || (tried && ask && !answeredSomething)) && (
        <div className="elicit-error" role="alert">
          {error || 'Pick an option or type an answer, or choose Skip.'}
        </div>
      )}
      <div className="elicit-actions">
        <button type="button" className="btn primary small" onClick={() => void act('accept')} disabled={busy} data-testid="elicit-submit">
          {busy ? <Loader2 size={13} className="spin" /> : null} Submit
        </button>
        <button type="button" className="btn ghost small" title="Tell the agent you'd rather not answer" onClick={() => void act('decline')} disabled={busy} data-testid="elicit-decline">
          Skip
        </button>
      </div>
    </div>
  );
}

/** What goes to the main process: the values as typed, date-times as ISO strings (local time on this device). */
function toContent(fields: ElicitField[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) continue;
    out[f.key] = f.kind === 'text' && f.format === 'date-time' && typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : v;
  }
  return out;
}

function Options({ field, value, onChange }: { field: Extract<ElicitField, { kind: 'choice' | 'multi' }>; value: ElicitValue | undefined; onChange: (v: ElicitValue | undefined) => void }) {
  const multi = field.kind === 'multi';
  const picked = new Set(multi ? (Array.isArray(value) ? value : []) : typeof value === 'string' ? [value] : []);
  const rows = field.options.some((o) => o.description);
  const toggle = (o: ElicitOption) => {
    if (multi) onChange(picked.has(o.value) ? [...picked].filter((x) => x !== o.value) : [...picked, o.value]);
    else onChange(picked.has(o.value) ? undefined : o.value);
  };
  return (
    <div className={`elicit-options ${rows ? 'rows' : ''}`} role={multi ? 'group' : 'radiogroup'} aria-label={field.title ?? field.description ?? undefined}>
      {field.options.map((o) => {
        const on = picked.has(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={on}
            className={`elicit-opt ${on ? 'on' : ''} ${multi ? 'multi' : ''}`}
            onClick={() => toggle(o)}
            data-testid="elicit-opt"
            data-value={o.value}
          >
            <span className="elicit-mark" aria-hidden>
              {on && <Check size={11} strokeWidth={3} />}
            </span>
            <span className="elicit-opt-text">
              <span className="elicit-opt-title">{o.title}</span>
              {o.description && <span className="elicit-opt-desc">{o.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const INPUT_TYPE: Record<string, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };

function Field({ field: f, value, error, onChange, onEnter }: { field: ElicitField; value: ElicitValue | undefined; error?: string; onChange: (v: ElicitValue | undefined) => void; onEnter: (e: React.KeyboardEvent) => void }) {
  const label = f.title ?? f.key;
  const help = f.title ? f.description : undefined;
  let control: React.ReactNode;
  if (f.kind === 'boolean') {
    return (
      <label className="elicit-field elicit-bool" data-testid={`elicit-field-${f.key}`}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span className="elicit-label-text">
          {label}
          {help && <span className="elicit-help">{help}</span>}
        </span>
      </label>
    );
  }
  if (f.kind === 'multi') control = <Options field={f} value={value} onChange={onChange} />;
  else if (f.kind === 'choice' && f.options.length <= 6) control = <Options field={f} value={value} onChange={onChange} />;
  else if (f.kind === 'choice')
    control = (
      <select className="elicit-input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose…</option>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.title}
          </option>
        ))}
      </select>
    );
  else if (f.kind === 'number')
    control = (
      <input
        className="elicit-input"
        type="number"
        inputMode={f.integer ? 'numeric' : 'decimal'}
        step={f.integer ? 1 : 'any'}
        min={f.minimum}
        max={f.maximum}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        onKeyDown={onEnter}
      />
    );
  else
    control = (
      <input
        className="elicit-input"
        type={INPUT_TYPE[f.format ?? ''] ?? 'text'}
        maxLength={f.maxLength}
        placeholder={f.kind === 'text' && f.format === 'uri' ? 'https://' : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter}
      />
    );
  return (
    <div className={`elicit-field ${error ? 'bad' : ''}`} data-testid={`elicit-field-${f.key}`}>
      <div className="elicit-label">
        <span className="elicit-label-text">{label}</span>
        {!f.required && <span className="elicit-optional">optional</span>}
      </div>
      {(help || (!f.title && f.description)) && <div className="elicit-help">{help ?? f.description}</div>}
      {control}
      {error && <div className="elicit-field-error">{error}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ URL mode

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function UrlCard({ item, threadId, agentName, compact }: { item: AskItem; threadId: string; agentName: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const url = item.url ?? '';
  const opened = item.resolved === 'accepted';
  const act = async (action: 'accept' | 'decline' | 'cancel') => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await send(threadId, item, action);
      if (action === 'accept' && /^https?:\/\//i.test(url)) {
        // On a phone the link opens there; on the Mac in the default browser (http/https only, checked again in main).
        if (isRemoteBrowser()) window.open(url, '_blank', 'noopener,noreferrer');
        else await api.openExternal(url);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`elicit ${compact ? 'compact' : ''}`} data-testid="elicit-card" data-mode="url">
      <div className="elicit-head">
        <ExternalLink size={15} className="elicit-icon" />
        <span className="grow ellipsis">{agentName} needs you to open a link</span>
        {!opened && <DismissButton onClick={() => void act('cancel')} disabled={busy} />}
      </div>
      {item.message && <div className="elicit-message">{item.message}</div>}
      <div className="elicit-url" title={url}>
        <Globe size={13} className="muted" />
        <b>{hostOf(url)}</b>
        <span className="ellipsis muted">{url}</span>
      </div>
      {error && (
        <div className="elicit-error" role="alert">
          {error}
        </div>
      )}
      {opened ? (
        <div className="elicit-wait" data-testid="elicit-waiting">
          <Loader2 size={13} className="spin" /> Finish in your browser. Waiting for {agentName} to confirm…
        </div>
      ) : (
        <div className="elicit-actions">
          <button type="button" className="btn primary small" onClick={() => void act('accept')} disabled={busy} data-testid="elicit-open">
            <ExternalLink size={13} /> Open link
          </button>
          <button type="button" className="btn ghost small" title="Tell the agent you won't open this link" onClick={() => void act('decline')} disabled={busy} data-testid="elicit-decline">
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ answered

function AnsweredCard({ item, agentName, compact }: { item: AskItem; agentName: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => describeAnswer(item.schema, item.answer, item.message), [item.schema, item.answer, item.message]);
  let icon = <CircleCheck size={14} className="ok-text" />;
  let outcome: string;
  if (item.resolved === 'accepted') {
    if (item.mode === 'url') outcome = 'Link opened · done';
    else if (lines.length === 1) outcome = lines[0].value;
    else outcome = lines.length ? `${lines.length} answers sent` : 'Sent';
  } else {
    icon = item.resolved === 'expired' ? <Clock size={14} className="muted" /> : <CircleSlash size={14} className="muted" />;
    outcome =
      item.resolved === 'declined' ? (item.mode === 'url' ? 'Declined' : 'Skipped') : item.resolved === 'withdrawn' ? 'No longer needed' : item.resolved === 'expired' ? 'Expired' : 'Dismissed';
  }
  const question = item.message || (item.mode === 'url' ? 'Open a link' : 'Question');
  return (
    <div className={`elicit done ${open ? 'open' : ''} ${compact ? 'compact' : ''}`} data-testid="elicit-card" data-mode={item.mode} data-resolved={item.resolved}>
      <button type="button" className="elicit-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="elicit-summary">
        {icon}
        <span className="elicit-sum-q ellipsis">{question}</span>
        <span className="elicit-sum-a ellipsis" data-testid="elicit-outcome">
          {outcome}
        </span>
        <ChevronRight size={13} className="elicit-chev" />
      </button>
      {open && (
        <div className="elicit-detail">
          <div className="elicit-detail-from">{agentName} asked</div>
          {item.message && <div className="elicit-message">{item.message}</div>}
          {item.mode === 'url' && item.url && (
            <div className="elicit-url" title={item.url}>
              <Globe size={13} className="muted" />
              <b>{hostOf(item.url)}</b>
              <span className="ellipsis muted">{item.url}</span>
            </div>
          )}
          {lines.length > 0 && (
            <dl className="elicit-answers">
              {lines.map((l, i) => (
                <div key={i} className="elicit-answer">
                  {l.label && l.label !== item.message && <dt>{l.label}</dt>}
                  <dd>{l.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
