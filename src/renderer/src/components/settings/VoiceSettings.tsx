import { useEffect, useRef, useState } from 'react';
import { FilePlus2, Loader2, Mic, RefreshCw, Square } from 'lucide-react';
import { RECORDING_ENGINES, VOICE_LANGUAGES, type EngineState, type VoiceEngineId, type VoiceSettings as VoiceCfg, type VoiceStatus } from '@shared/voice';
import { MicRecorder, publishVoiceStatus, voiceApi } from '../../voice';

const ENGINE_LABEL: Record<VoiceEngineId, string> = {
  system: 'System dictation',
  'whisper-local': 'Whisper on this computer',
  openrouter: 'OpenRouter',
  'openai-compatible': 'Custom / local server',
};
const ENGINE_LINE: Record<VoiceEngineId, string> = {
  system: "The operating system's own dictation types into the box. Nothing is recorded by Olympus.",
  'whisper-local': 'whisper.cpp already installed here. Audio stays on this computer.',
  openrouter: 'Audio is sent to OpenRouter for transcription, billed to your OpenRouter key.',
  'openai-compatible': 'Any /v1/audio/transcriptions server: OpenAI, Groq, or a local speaches / faster-whisper server.',
};
const STATE_LABEL: Record<EngineState, string> = { ready: 'Ready', 'not-found': 'Not found', 'needs-key': 'Needs key', 'needs-setup': 'Needs setup', unsupported: 'Not available' };
const TEST_SECONDS = 5;

const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Settings → Voice: which engine the composer's mic uses, its model and language, and a 5-second test. */
export function VoiceSettings({ agentNames }: { agentNames: Record<string, string> }) {
  const [st, setSt] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState('');
  const [orModels, setOrModels] = useState<{ id: string; name: string }[] | null>(null);
  const [orBusy, setOrBusy] = useState(false);
  const [orKey, setOrKey] = useState('');
  const [custom, setCustom] = useState<{ url: string; model: string; key: string } | null>(null);
  const [test, setTest] = useState<{ phase: 'idle' | 'recording' | 'transcribing'; left?: number; text?: string; meta?: string; error?: string }>({ phase: 'idle' });
  const testRec = useRef<MicRecorder | null>(null);

  const apply = (s: VoiceStatus) => {
    setSt(s);
    publishVoiceStatus(s);
  };
  const run = async (fn: () => Promise<VoiceStatus>) => {
    setError('');
    try {
      apply(await fn());
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    if (!voiceApi) return;
    void voiceApi.status().then(apply, (e) => setError(errText(e)));
    return () => testRec.current?.cancel();
  }, []);
  useEffect(() => {
    if (st && !custom) setCustom({ url: st.settings.customBaseUrl ?? '', model: st.settings.customModel ?? '', key: '' });
  }, [st]);

  const s = st?.settings;
  const engine = s?.engine ?? 'system';
  // OpenRouter's model list (public endpoint, no key) loads when the engine is shown.
  useEffect(() => {
    if (engine === 'openrouter' && !orModels && !orBusy) void loadOrModels();
  }, [engine]);

  async function loadOrModels() {
    if (!voiceApi) return;
    setOrBusy(true);
    try {
      setOrModels(await voiceApi.openrouterModels());
    } catch (e) {
      setError(`Could not load OpenRouter models: ${errText(e)}`);
    }
    setOrBusy(false);
  }

  if (!voiceApi) return <span className="small muted">Voice input is set up on the computer.</span>;
  if (!st || !s) return <Loader2 size={16} className="spin" />;
  const save = (patch: Partial<VoiceCfg>) => run(() => voiceApi!.save(patch));
  const statusOf = (id: VoiceEngineId) => st.engines.find((e) => e.id === id);

  async function runTest() {
    if (!voiceApi) return;
    setTest({ phase: 'recording', left: TEST_SECONDS });
    const access = await voiceApi.micAccess().catch(() => ({ granted: true, status: '' }));
    if (!access.granted) return setTest({ phase: 'idle', error: 'Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.' });
    const r = new MicRecorder();
    try {
      await r.start();
    } catch (e) {
      return setTest({ phase: 'idle', error: `Couldn't start recording: ${errText(e)}` });
    }
    testRec.current = r;
    void voiceApi.prewarm().catch(() => {});
    for (let left = TEST_SECONDS; left > 0; left--) {
      setTest({ phase: 'recording', left });
      await new Promise((res) => setTimeout(res, 1000));
      if (testRec.current !== r) return; // cancelled
    }
    testRec.current = null;
    const wav = r.stop();
    setTest({ phase: 'transcribing' });
    const t0 = performance.now();
    const res = await voiceApi.transcribe(wav).catch((e) => ({ ok: false, error: errText(e), text: '', ms: 0, model: '' }));
    const total = ((performance.now() - t0) / 1000).toFixed(1);
    if (!res.ok) setTest({ phase: 'idle', error: res.error ?? 'Failed' });
    else setTest({ phase: 'idle', text: res.text || '(no speech heard)', meta: `${total} s${res.model ? ` · ${res.model}` : ''}` });
  }
  function stopTest() {
    testRec.current?.cancel();
    testRec.current = null;
    setTest({ phase: 'idle' });
  }

  const keyFrom = s.openrouterKeyFrom ?? (st.openrouter.voiceKeySaved ? 'voice' : st.openrouter.keySources[0]?.id ?? 'voice');
  const recording = RECORDING_ENGINES.includes(engine);

  return (
    <div className="voice-settings" data-testid="voice-settings">
      <h3>Voice</h3>
      <span className="small muted">What the mic button next to Send uses.</span>

      <div className="field">
        <label>Engine</label>
        <div className="voice-engines" role="radiogroup" aria-label="Voice engine">
          {(['system', 'whisper-local', 'openrouter', 'openai-compatible'] as VoiceEngineId[]).map((id) => {
            const es = statusOf(id);
            return (
              <button
                key={id}
                role="radio"
                aria-checked={engine === id}
                className={`voice-engine ${engine === id ? 'active' : ''}`}
                disabled={es?.state === 'unsupported'}
                onClick={() => void save({ engine: id })}
                data-testid={`voice-engine-${id}`}
              >
                <span className="voice-engine-head">
                  <span className="voice-radio" aria-hidden="true" />
                  <span className="voice-engine-name">{ENGINE_LABEL[id]}</span>
                  {es && (
                    <span className={`voice-state ${es.state}`} data-testid={`voice-state-${id}`}>
                      {STATE_LABEL[es.state]}
                    </span>
                  )}
                </span>
                <span className="small muted voice-engine-line">{es && es.state !== 'ready' ? es.detail : ENGINE_LINE[id]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {engine === 'whisper-local' && (
        <div className="field">
          <label htmlFor="voice-model">Model</label>
          {st.whisper.models.length ? (
            <select id="voice-model" className="input" value={s.whisperModel || st.whisper.models[0].path} onChange={(e) => void save({ whisperModel: e.target.value })} data-testid="voice-model">
              {st.whisper.models.map((m) => (
                <option key={m.path} value={m.path} title={m.path}>
                  {m.name} · {fmtSize(m.bytes)}
                  {m.source === 'added' ? ' · added' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="small muted">No ggml model found in the usual folders.</span>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" onClick={() => void run(() => voiceApi!.addModel())} data-testid="voice-add-model">
              <FilePlus2 size={13} /> Add model file…
            </button>
            <button className="btn ghost small" onClick={() => void run(() => voiceApi!.status())} title="Look for whisper.cpp and models again">
              <RefreshCw size={13} /> Rescan
            </button>
          </div>
          <span className="small muted" data-testid="voice-whisper-bins">
            {st.whisper.server || st.whisper.cli
              ? `${st.whisper.server ? `whisper-server: ${st.whisper.server}` : `whisper-cli: ${st.whisper.cli}`}${st.whisper.running ? ' · running' : ''}`
              : 'whisper.cpp not found. Install it (for example `brew install whisper-cpp`) and press Rescan.'}
          </span>
          <span className="small muted">Larger models are more accurate and slower. The model stays loaded for 10 minutes after use.</span>
        </div>
      )}

      {engine === 'whisper-local' && (
        <div className="field">
          <label>Live mode</label>
          <label className="check-item">
            <input type="checkbox" checked={s.live !== false} onChange={(e) => void save({ live: e.target.checked })} data-testid="voice-live" />
            Live transcription
          </label>
          <span className="small muted">Words appear while you speak. Say “over” or stay quiet for 5 seconds to stop. Off: record, then transcribe once.</span>
          <label className="check-item">
            <input type="checkbox" checked={s.wakeWord === true} onChange={(e) => void save({ wakeWord: e.target.checked })} data-testid="voice-wake" />
            “Hey Oly” wake word
          </label>
          <span className="small muted">Listens only while an Olympus window is focused; the mic closes when you switch away. Audio stays on this computer.</span>
        </div>
      )}

      {engine === 'openrouter' && (
        <div className="field">
          <span className="small voice-warn">Audio leaves this computer and goes to OpenRouter.</span>
          <label htmlFor="voice-or-key">API key</label>
          <select id="voice-or-key" className="input" value={keyFrom} onChange={(e) => void save({ openrouterKeyFrom: e.target.value })} data-testid="voice-or-keyfrom">
            {st.openrouter.keySources.map((k) => (
              <option key={k.id} value={k.id}>
                Key saved for {agentNames[k.id] ?? k.id}
              </option>
            ))}
            <option value="voice">{st.openrouter.voiceKeySaved ? 'Key saved here' : 'Enter a key here'}</option>
          </select>
          {keyFrom === 'voice' && (
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                type="password"
                placeholder={st.openrouter.voiceKeySaved ? '•••••••• (saved, type to replace)' : 'sk-or-…'}
                value={orKey}
                onChange={(e) => setOrKey(e.target.value)}
                data-testid="voice-or-key-input"
              />
              <button
                className="btn small"
                disabled={!orKey.trim()}
                onClick={() =>
                  void run(async () => {
                    await voiceApi!.setKey('openrouter', orKey);
                    setOrKey('');
                    return voiceApi!.save({ openrouterKeyFrom: 'voice' });
                  })
                }
                data-testid="voice-or-key-save"
              >
                Save
              </button>
              {st.openrouter.voiceKeySaved && (
                <button className="btn ghost small" onClick={() => void run(() => voiceApi!.setKey('openrouter', null))}>
                  Remove
                </button>
              )}
            </div>
          )}
          <label htmlFor="voice-or-model">Model</label>
          <div className="row" style={{ gap: 8 }}>
            {orModels?.length ? (
              <select id="voice-or-model" className="input" value={s.openrouterModel ?? ''} onChange={(e) => void save({ openrouterModel: e.target.value })} data-testid="voice-or-model">
                <option value="" disabled>
                  Pick a model
                </option>
                {orModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="voice-or-model"
                className="input"
                placeholder="openai/whisper-large-v3"
                defaultValue={s.openrouterModel ?? ''}
                onBlur={(e) => e.target.value.trim() !== (s.openrouterModel ?? '') && void save({ openrouterModel: e.target.value.trim() })}
                data-testid="voice-or-model-input"
              />
            )}
            <button className="btn ghost small" disabled={orBusy} onClick={() => void loadOrModels()} title="Load OpenRouter's transcription models">
              {orBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            </button>
          </div>
        </div>
      )}

      {engine === 'openai-compatible' && custom && (
        <div className="field">
          <span className="small muted">Audio goes to the server below. A localhost URL keeps it on this computer.</span>
          <label htmlFor="voice-custom-url">Server URL</label>
          <input id="voice-custom-url" className="input" placeholder="http://localhost:8000/v1 or https://api.groq.com/openai/v1" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} data-testid="voice-custom-url" />
          <label htmlFor="voice-custom-model">Model</label>
          <input id="voice-custom-model" className="input" placeholder="whisper-large-v3" value={custom.model} onChange={(e) => setCustom({ ...custom, model: e.target.value })} data-testid="voice-custom-model" />
          <label htmlFor="voice-custom-key">API key (optional)</label>
          <input
            id="voice-custom-key"
            className="input"
            type="password"
            placeholder={st.custom.keySaved ? '•••••••• (saved, type to replace)' : 'Leave empty for a local server'}
            value={custom.key}
            onChange={(e) => setCustom({ ...custom, key: e.target.value })}
            data-testid="voice-custom-key"
          />
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn small"
              onClick={() =>
                void run(async () => {
                  if (custom.key.trim()) await voiceApi!.setKey('custom', custom.key);
                  setCustom({ ...custom, key: '' });
                  return voiceApi!.save({ customBaseUrl: custom.url.trim(), customModel: custom.model.trim() });
                })
              }
              data-testid="voice-custom-save"
            >
              Save
            </button>
            {st.custom.keySaved && (
              <button className="btn ghost small" onClick={() => void run(() => voiceApi!.setKey('custom', null))}>
                Remove key
              </button>
            )}
          </div>
        </div>
      )}

      {recording && (
        <div className="field">
          <label htmlFor="voice-lang">Language</label>
          <select id="voice-lang" className="input" value={s.language} onChange={(e) => void save({ language: e.target.value })} data-testid="voice-language">
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="small muted">
            {s.language === 'hinglish'
              ? 'Hindi and English mixed, written in Roman letters. File names and code words from the chat are passed as hints.'
              : 'File names and code words from the chat are passed as hints.'}
          </span>
        </div>
      )}

      {recording && (
        <div className="field">
          <label>Sounds</label>
          <label className="check-item">
            <input type="checkbox" checked={s.sounds !== false} onChange={(e) => void save({ sounds: e.target.checked })} data-testid="voice-sounds" />
            Play a sound when the mic opens and closes
          </label>
        </div>
      )}

      {recording && (
        <div className="field">
          <label>Test</label>
          <div className="row" style={{ gap: 8 }}>
            {test.phase === 'recording' ? (
              <button className="btn small" onClick={stopTest} data-testid="voice-test-stop">
                <Square size={12} fill="currentColor" /> Recording… {test.left}s
              </button>
            ) : (
              <button className="btn small" disabled={test.phase === 'transcribing'} onClick={() => void runTest()} data-testid="voice-test">
                {test.phase === 'transcribing' ? <Loader2 size={13} className="spin" /> : <Mic size={13} />} {test.phase === 'transcribing' ? 'Transcribing…' : `Record ${TEST_SECONDS} s`}
              </button>
            )}
          </div>
          {test.text !== undefined && (
            <div className="voice-test-out" data-testid="voice-test-out">
              <div>{test.text}</div>
              <span className="small muted" data-testid="voice-test-meta">
                {test.meta}
              </span>
            </div>
          )}
          {test.error && (
            <span className="small error-text" data-testid="voice-test-error">
              {test.error}
            </span>
          )}
        </div>
      )}

      {error && <div className="small error-text">{error}</div>}
    </div>
  );
}
