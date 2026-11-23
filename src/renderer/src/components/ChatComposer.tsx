import { memo, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  Mic,
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type { AgentDef, AgentStatus, SessionView } from '@shared/types';
import { api, onEvent } from '../api';
import { addFilesToMessage } from './AddToMessage';
import { useComposerResize } from '../composerResize';
import { LiveSession, type LiveStopReason } from '@shared/liveVoice';
import { liveModeFor, micSoundsFor, wakeWordFor } from '@shared/voice';
import { playEarcon } from '../earcons';
import { MAX_RECORD_SECONDS, MicRecorder, micMode, useVoiceStatus, voiceApi } from '../voice';
import { useWakeWord } from '../wakeWord';
import '../liveVoice.css';
import { useDraft } from '../drafts';
import { useOpenFile } from '../fileLinks';
import { setExpandSteps, useExpandSteps } from '../prefs';
import { promptQueueApi, usePromptQueue } from '../promptQueueApi';
import { quotaState } from '../quota';
import { AttachButton, AttachmentChips, useAttachments } from './Attachments';
import { CompactButton } from './CompactButton';
import { FreshContextButton } from './FreshContextButton';
import { ConfigPill } from './ConfigPills';
import { useSlashMenu } from './SlashMenu';
import { SwitchAgents } from './SwitchAgents';
import { estimateTokens } from './TokenStats';
import { ContextMeter, fmtReset, LimitsFreshness } from './Usage';
import { enterSends } from '../platform';

const NO_COMMANDS: SessionView['commands'] = [];

export interface ChatComposerProps {
  threadId: string;
  agentId: string;
  autoApprove?: boolean;
  session: SessionView | null;
  /** The agent is compacting this chat's context (`isCompacting` over the thread's items). */
  compacting?: boolean;
  /** True once this chat has at least one turn (enables 1-click Fresh context carryover). */
  hasHistory?: boolean;
  /** Timestamp of the latest user/agent turn for >5m cache-cold hint. */
  lastTurnTs?: number;
  agentDef?: AgentDef;
  agentDefs: Record<string, AgentDef>;
  agentStatus?: AgentStatus;
  allStatuses?: Record<string, AgentStatus>;
  onLogin: () => void;
  onUsage?: () => void;
  /** Compact chip next to the context ring (Code mode has it in the Info panel instead). */
  compactInComposer?: boolean;
  onSwitchAgent?: (agentId: string) => void;
  onAutoApprove?: (on: boolean) => void;
  onSendingChange: (sending: boolean) => void;
  onStickToBottom: () => void;
}

/**
 * Isolated chat composer: owns the `<textarea>` draft state, attachments, height auto-sizing, and config pills
 * so typing in the composer never triggers React reconciliation over the message/tool list above it.
 */
export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const { threadId, agentId, autoApprove, session, agentDef } = props;
  const { text, setText, clear: clearThreadDraft } = useDraft(threadId);
  const openFile = useOpenFile();
  const expandSteps = useExpandSteps();
  const ta = useRef<HTMLTextAreaElement>(null);
  const resize = useComposerResize(ta);
  const att = useAttachments(threadId);
  const running = session?.status === 'running';
  const needsLogin = session?.status === 'needs-login' || props.agentStatus?.state === 'needs-login';
  // The long "queued" hint doesn't fit a narrow composer (phones, a narrow window): a short one there.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ta.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 460));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const slash = useSlashMenu({ text, setText, commands: session?.commands ?? NO_COMMANDS, ta });
  const queue = usePromptQueue(threadId);
  const [dictateNote, setDictateNote] = useState<{ text: string; error?: boolean; offerSystem?: boolean } | null>(null);
  useEffect(() => {
    if (!dictateNote) return;
    const t = setTimeout(() => setDictateNote(null), dictateNote.offerSystem ? 20_000 : 8000);
    return () => clearTimeout(t);
  }, [dictateNote]);
  // Settings → Voice decides what the mic does: the OS dictation, or record here and transcribe with an engine.
  const voiceStatus = useVoiceStatus();
  const mic = micMode(voiceStatus, Boolean(api.startDictation));

  // Mic: focus the box with the caret at the end, then start the OS's own dictation. Dictated words arrive as native
  // text input, so the textarea's onChange keeps the draft (and Send) in sync like typing does.
  // The OS doesn't say when its dictation ends, so the button shows "listening" from the click until the box loses
  // focus, Esc, Send, a second click (which ends it by taking focus away), or 30 s without new text (macOS itself
  // stops dictation after about 30 s of silence).
  const [listening, setListening] = useState(false);
  async function dictate() {
    const el = ta.current;
    if (!el || !api.startDictation) return;
    if (listening) {
      setListening(false);
      el.blur();
      requestAnimationFrame(() => el.focus());
      return;
    }
    el.focus();
    el.setSelectionRange(el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length);
    const r = await api.startDictation().catch((e: unknown) => ({ ok: false, error: String(e), hint: undefined }));
    if (!r.ok) setDictateNote({ text: `Dictation didn't start: ${r.error ?? 'unknown error'}`, error: true });
    else if (r.hint) setDictateNote({ text: r.hint });
    else setListening(true);
  }
  useEffect(() => {
    const el = ta.current;
    if (!listening || !el) return;
    const stop = () => setListening(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stop();
    const idle = setTimeout(stop, 30_000);
    el.addEventListener('blur', stop);
    el.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(idle);
      el.removeEventListener('blur', stop);
      el.removeEventListener('keydown', onKey);
    };
  }, [listening, text]);

  // Recording engines (whisper-local, OpenRouter, custom server): click to record, click again to stop, then the text
  // goes in at the caret. Esc cancels. Stops by itself after MAX_RECORD_SECONDS.
  // Live mode (whisper-local, Settings → Voice → Live transcription): text appears while speaking (muted interim line),
  // each phrase is committed at a silence gap, 5 s of silence or saying "over" stops it (src/shared/liveVoice.ts).
  const [rec, setRec] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MicRecorder | null>(null);
  const live = useRef<LiveSession | null>(null);
  const [interim, setInterim] = useState('');
  /** Bumped on cancel so a transcription that comes back later is dropped. */
  const recRun = useRef(0);
  /** Mic open/close sound (Settings → Voice → Sounds). The open sound ends before capture starts, so it isn't recorded. */
  const sound = (id: 'start' | 'stop') => (micSoundsFor(voiceStatus?.settings) ? playEarcon(id) : Promise.resolve());
  function cancelRecording() {
    recRun.current++;
    if (recorder.current) void sound('stop');
    recorder.current?.cancel();
    recorder.current = null;
    live.current?.stop('cancel');
    live.current = null;
    setInterim('');
    setRec('idle');
  }
  function insertAtCaret(t: string) {
    const el = ta.current;
    setText((prev) => {
      const start = el && document.activeElement === el ? (el.selectionStart ?? prev.length) : prev.length;
      const end = el && document.activeElement === el ? (el.selectionEnd ?? start) : prev.length;
      const before = prev.slice(0, start);
      const after = prev.slice(end);
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      const trail = after && !/^\s/.test(after) ? ' ' : '';
      const next = `${before}${lead}${t}${trail}${after}`;
      const caret = (before + lead + t).length;
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
      return next;
    });
  }
  async function startRecording(forceLive = false) {
    if (!voiceApi) return;
    setDictateNote(null);
    if (forceLive || liveModeFor(voiceStatus?.settings)) return startLive();
    const access = await voiceApi.micAccess().catch(() => ({ granted: true, status: 'unknown' }));
    if (!access.granted) {
      setDictateNote({ text: 'Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.', error: true, offerSystem: Boolean(api.startDictation) });
      return;
    }
    const r = new MicRecorder();
    await sound('start');
    try {
      await r.start();
    } catch (e) {
      setDictateNote({ text: `Couldn't start recording: ${e instanceof Error ? e.message : String(e)}`, error: true, offerSystem: Boolean(api.startDictation) });
      return;
    }
    recorder.current = r;
    setElapsed(0);
    setRec('recording');
    ta.current?.focus();
    // A local whisper-server starts loading its model while the user speaks.
    void voiceApi.prewarm().catch(() => {});
  }
  async function startLive() {
    if (!voiceApi) return;
    const access = await voiceApi.micAccess().catch(() => ({ granted: true, status: 'unknown' }));
    if (!access.granted) {
      setDictateNote({ text: 'Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.', error: true, offerSystem: Boolean(api.startDictation) });
      return;
    }
    const run = ++recRun.current;
    const mine = () => run === recRun.current;
    const session = new LiveSession(
      {
        transcribe: async (wav, context) => {
          const r = await voiceApi!.transcribeLive(wav, threadId, context);
          if (!r.ok) throw new Error(r.error ?? 'transcription failed');
          return r.text ?? '';
        },
        onInterim: (t) => mine() && setInterim(t),
        onCommit: (t) => mine() && insertAtCaret(t),
        onWantStop: (reason) => mine() && stopLive(reason),
        onEnd: (reason) => {
          if (!mine()) return;
          live.current = null;
          setInterim('');
          setRec('idle');
          if (reason === 'silence') setDictateNote({ text: 'Stopped after 5 s of silence.' });
        },
        onError: (m) => mine() && setDictateNote({ text: `Voice engine failed: ${m}`, error: true, offerSystem: Boolean(api.startDictation) }),
      },
      { maxSeconds: MAX_RECORD_SECONDS },
    );
    const r = new MicRecorder({ keep: false, onChunk: (x) => session.push(x) });
    await sound('start');
    if (!mine()) return;
    try {
      await r.start();
    } catch (e) {
      setDictateNote({ text: `Couldn't start recording: ${e instanceof Error ? e.message : String(e)}`, error: true, offerSystem: Boolean(api.startDictation) });
      return;
    }
    if (!mine()) return r.cancel();
    recorder.current = r;
    live.current = session;
    setInterim('');
    setElapsed(0);
    setRec('recording');
    ta.current?.focus();
    void voiceApi.prewarm().catch(() => {});
  }
  /** Mic off now; the last phrase is still being transcribed until the session ends. */
  function stopLive(reason: LiveStopReason) {
    const session = live.current;
    if (!session) return;
    if (recorder.current) void sound('stop');
    recorder.current?.cancel();
    recorder.current = null;
    setRec('transcribing');
    session.stop(reason);
  }
  async function stopRecording() {
    if (live.current) return stopLive('manual');
    const r = recorder.current;
    if (!r || !voiceApi) return;
    recorder.current = null;
    const run = ++recRun.current;
    const wav = r.stop();
    void sound('stop');
    if (r.seconds < 0.3 && wav.length < 16_000) {
      setRec('idle');
      return;
    }
    setRec('transcribing');
    const res = await voiceApi.transcribe(wav, threadId).catch((e: unknown) => ({ ok: false, error: String(e), text: undefined }));
    if (run !== recRun.current) return;
    setRec('idle');
    if (res.ok && res.text?.trim()) insertAtCaret(res.text.trim());
    else if (res.ok) setDictateNote({ text: 'No speech heard.' });
    else setDictateNote({ text: `Voice engine failed: ${res.error ?? 'unknown error'}`, error: true, offerSystem: Boolean(api.startDictation) });
  }
  useEffect(() => {
    if (rec === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const tick = rec === 'recording' ? setInterval(() => {
      const secs = recorder.current?.seconds ?? 0;
      setElapsed(secs);
      if (secs >= MAX_RECORD_SECONDS) void stopRecording();
    }, 250) : null;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (tick) clearInterval(tick);
    };
  }, [rec]);
  // A different chat, or the composer going away: drop any recording.
  useEffect(() => () => cancelRecording(), [threadId]);
  function onMic() {
    if (mic === 'record') {
      if (rec === 'idle') void startRecording();
      else if (rec === 'recording') void stopRecording();
      return;
    }
    void dictate();
  }
  // "Hey Oly" (Settings → Voice): listens only while this window is focused and the mic is free.
  const wake = useWakeWord(mic === 'record' && wakeWordFor(voiceStatus?.settings), rec !== 'idle', threadId, (rest) => {
    const el = ta.current;
    el?.focus();
    if (el) el.setSelectionRange(el.value.length, el.value.length);
    if (rest) insertAtCaret(rest);
    void startRecording(true);
  });
  const fmtElapsed = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [threadId]);

  // Text sent here from elsewhere in the app (e.g. "Ask agent to fix" on a terminal error or detached window): into the box, not sent.
  useEffect(() => {
    const insert = (t: string) => {
      setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${t}` : t));
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        el.scrollTop = el.scrollHeight;
      });
    };
    const on = (e: Event) => insert((e as CustomEvent<{ text: string }>).detail.text);
    const offEvent = onEvent((ch, payload) => {
      if (ch !== 'panel:compose' || !payload?.text) return;
      if (Array.isArray(payload.files) && payload.files.length) addFilesToMessage(payload.files);
      insert(String(payload.text));
    });
    window.addEventListener('olympus:compose', on);
    return () => {
      window.removeEventListener('olympus:compose', on);
      offEvent();
    };
  }, [setText]);

  // Always sendable: while the agent works (or is offline) the message waits in the chat's queue, with ticks.
  const canSend = Boolean(text.trim() || att.files.length);
  async function send() {
    if (!canSend) return;
    setListening(false);
    if (rec === 'recording') cancelRecording();
    const t = text.trim();
    const files = att.files;
    clearThreadDraft();
    props.onStickToBottom();
    props.onSendingChange(true);
    try {
      await promptQueueApi.submit(threadId, t, files);
    } finally {
      props.onSendingChange(false);
    }
  }

  const model = session?.configOptions.find((o) => o.category === 'model')?.currentValue;
  const q = quotaState(props.agentStatus, model);

  return (
    <div className="composer-wrap">
      {q.out && !needsLogin && (() => {
        const others = Object.values(props.agentDefs).filter(
          (d) =>
            d.id !== agentId &&
            !['not-installed', 'error', 'needs-login'].includes(props.allStatuses?.[d.id]?.state ?? 'unknown') &&
            !quotaState(props.allStatuses?.[d.id]).out,
        );
        return (
          <div className="banner quota-banner">
            <AlertTriangle size={17} />
            <span className="quota-text">
              <b>{agentDef?.name} is out of quota</b>
              {q.limits[0] ? ` (${q.limits.map((l) => l.label).join(', ')})` : ''}
              {q.resetsAt ? ` — ${fmtReset(q.resetsAt)}, at ${new Date(q.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '.'}
              {q.otherGroupsLeft.length ? ` ${q.otherGroupsLeft.join(', ')} models still work — change the model below.` : ''}
              <LimitsFreshness status={props.agentStatus} agentName={agentDef?.name} />
            </span>
            <SwitchAgents agents={others} statuses={props.allStatuses ?? {}} onSwitch={(id) => props.onSwitchAgent?.(id)} />
          </div>
        );
      })()}
      {needsLogin && (
        <div className="banner">
          <ShieldAlert size={17} />
          <span className="grow">
            {agentDef?.name} needs you to log in.
            {session?.error && <span className="muted small"> ({session.error})</span>}
          </span>
          <button className="btn small primary" onClick={props.onLogin}>
            Login
          </button>
        </div>
      )}
      {session?.status === 'error' && session.error && (
        <div className="banner" style={{ borderColor: 'var(--danger)' }}>
          <span className="grow small" style={{ whiteSpace: 'pre-wrap' }}>
            {session.error}
          </span>
          <button className="btn small" onClick={props.onLogin}>
            Login
          </button>
          <button className="btn small" onClick={() => void api.ensureSession(threadId)}>
            Retry
          </button>
        </div>
      )}
      <div className={`composer ${att.dragging ? 'dragging' : ''}`} {...att.dropProps}>
        <div
          className={`composer-resize ${resize.sized ? 'sized' : ''}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize message box"
          title="Drag to resize · double-click to reset"
          onPointerDown={resize.onPointerDown}
          onDoubleClick={resize.reset}
          data-testid="composer-resize"
        />
        {slash.menu}
        <AttachmentChips files={att.files} onRemove={att.remove} onAnnotate={att.annotate} onOpen={(a, el) => att.open(a, el, openFile)} />
        <div className="growable-textarea" data-replicated-value={text}>
          <textarea
            ref={ta}
            rows={1}
            style={resize.style}
            spellCheck={false}
            value={text}
            placeholder={running ? (narrow ? 'Queue a message…' : `Message ${agentDef?.name ?? 'Agent'} — it gets it when this reply ends…`) : `Message ${agentDef?.name ?? 'Agent'}…`}
            title="Enter = send · Shift+Enter = new line · ⌘V = paste screenshot"
            onChange={(e) => setText(e.target.value)}
            onPaste={att.onPaste}
            {...slash.textareaProps}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (enterSends(e)) {
                e.preventDefault();
                void send();
              }
            }}
            data-testid="composer"
          />
          {slash.ghost}
        </div>
        <div className="composer-bar">
          <AttachButton onClick={() => void att.pick()} onFiles={att.addRawFiles} />
          {att.error && <span className="error-text small ellipsis">{att.error}</span>}
          {interim && (
            <span className="small live-interim" title={interim} data-testid="live-interim" aria-live="polite">
              {interim.length > 90 ? `…${interim.slice(-90)}` : interim}
            </span>
          )}
          {dictateNote && (
            <span className={`small ellipsis dictate-note ${dictateNote.error ? 'error-text' : 'muted'}`} title={dictateNote.text} data-testid="dictate-note">
              {dictateNote.text}
            </span>
          )}
          {dictateNote?.offerSystem && api.startDictation && (
            <button
              className="btn ghost small dictate-fallback"
              type="button"
              title="Use the operating system's dictation instead"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setDictateNote(null);
                void dictate();
              }}
              data-testid="dictate-fallback"
            >
              System dictation
            </button>
          )}
          <div className="spacer" />
          {session?.status === 'starting' && (
            <span className="small muted row" style={{ gap: 4 }}>
              <Loader2 size={13} className="spin" /> connecting…
            </span>
          )}
          {text.trim() && (
            <span className="type-estimate" title="Estimate for the message you typed (≈4 characters = 1 token). The exact count appears under the message after you send it.">
              ≈ {estimateTokens(text).toLocaleString()} tokens
            </span>
          )}
          {props.compactInComposer !== false && (
            <CompactButton threadId={threadId} session={session} compacting={Boolean(props.compacting)} queue={queue} variant="chip" />
          )}
          <FreshContextButton
            threadId={threadId}
            session={session}
            hasHistory={Boolean(props.hasHistory)}
            lastTurnTs={props.lastTurnTs}
            onlyWhenElevated={props.compactInComposer === false}
            variant="chip"
          />
          <ContextMeter usage={session?.usage} onClick={props.onUsage} />
          <div className="composer-send">
            {mic === 'record' && rec === 'recording' && (
              <span className="dictate-time" data-testid="dictate-time" aria-live="polite">
                {fmtElapsed(elapsed)}
              </span>
            )}
            {mic === 'record' && rec === 'transcribing' && (
              <span className="dictate-time muted" data-testid="dictate-transcribing">
                Transcribing…
              </span>
            )}
            {mic === 'record' && rec === 'idle' && wake.listening && (
              <span className="wake-hint" title="Listening for “Hey Oly” while Olympus is focused (Settings → Voice)" data-testid="wake-hint">
                <span className="wake-dot" aria-hidden="true" />
                Hey Oly
              </span>
            )}
            {mic !== 'none' && (
              <button
                className={`btn ghost icon dictate-btn ${listening || rec === 'recording' ? 'listening' : ''}`}
                title={
                  mic === 'record'
                    ? rec === 'recording'
                      ? live.current
                        ? 'Live… click to stop, or say “over” (stops after 5 s of silence, Esc cancels)'
                        : 'Recording… click to stop (Esc cancels)'
                      : rec === 'transcribing'
                        ? 'Transcribing…'
                        : 'Voice input (Settings → Voice)'
                    : listening
                      ? 'Listening… click to stop'
                      : 'Dictate (system dictation)'
                }
                aria-label={mic === 'record' ? (rec === 'recording' ? 'Stop recording' : 'Voice input') : listening ? 'Stop dictation' : 'Dictate (system dictation)'}
                aria-pressed={listening || rec === 'recording'}
                disabled={rec === 'transcribing'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onMic}
                type="button"
                data-testid="dictate"
                data-mode={mic}
                data-state={mic === 'record' ? rec : listening ? 'listening' : 'idle'}
                data-live={mic === 'record' && liveModeFor(voiceStatus?.settings) ? 'on' : undefined}
              >
                {rec === 'transcribing' ? <Loader2 size={17} className="spin" aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
              </button>
            )}
            {running && (
              <button className="btn small stop-btn" onClick={() => void api.cancel(threadId)} title="Stop the current reply" data-testid="stop">
                <Square size={12} fill="currentColor" /> Stop
              </button>
            )}
            <button
              className="btn primary icon send-btn"
              disabled={!canSend}
              onClick={() => void send()}
              title={running ? 'Queue — sent when the current reply ends' : 'Send'}
              data-testid="send"
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
        {att.dragging && <div className="drop-hint">Drop files here</div>}
      </div>
      <div className="composer-pills">
        <button
          className={`pill-toggle ${autoApprove ? 'on' : ''}`}
          title={
            autoApprove
              ? 'Every permission request in this chat is approved automatically. Click to ask again.'
              : "Approve every permission request in this chat automatically (like the agent's bypass mode). New chats with this agent start the same way."
          }
          onClick={() => void api.setAutoApprove(threadId, !autoApprove).then((on) => props.onAutoApprove?.(on))}
          data-testid="approve-all"
        >
          {autoApprove ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />} {autoApprove ? 'Approve all' : 'Ask first'}
        </button>
        <button
          className={`pill-toggle ${expandSteps ? 'on' : ''}`}
          title={expandSteps ? 'Thinking and tool steps open by themselves. Click to keep them folded.' : 'Thinking and tool steps stay folded until you click them. Click to have them open by themselves.'}
          onClick={() => setExpandSteps(!expandSteps)}
          data-testid="expand-steps"
        >
          {expandSteps ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />} {expandSteps ? 'Steps open' : 'Steps folded'}
        </button>
        {(session?.configOptions ?? []).map((o) => (
          <ConfigPill key={o.id} option={o} disabled={running} onChange={(v) => void api.setConfig(threadId, o.id, v)} />
        ))}
      </div>
    </div>
  );
});
