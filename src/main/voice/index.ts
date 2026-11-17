import { app, BrowserWindow, dialog, systemPreferences, type WebContents } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultVoiceLanguage,
  normalizeVoice,
  RECORDING_ENGINES,
  type TranscribeRequest,
  type TranscribeResult,
  type VoiceSettings,
  type VoiceStatus,
} from '@shared/voice';
import { readWavHeader } from '@shared/wav';
import * as store from '../store';
import { detectWhisper, type DetectCtx } from './detect';
import { engineStatuses, pickWhisperModel, runTranscription, type WhisperFound } from './engines';
import { openrouterModels } from './httpEngines';
import { extractIdentifiers, fileStems, projectFiles } from './vocab';
import { ensureServer, initWhisperPidFile, stopWhisperServer, whisperServerRunning } from './whisperLocal';

/**
 * Settings → Voice and the composer's recording mic (desktop window only: its own IPC channel `desk:voice`, never in
 * the `handlers` table the phone/relay can call, so no remote page can record or read keys).
 */

const OPENROUTER_VAR = 'OPENROUTER_API_KEY';
const VOICE_OR_KEY = `voice:${OPENROUTER_VAR}`;
const VOICE_CUSTOM_KEY = 'voice:CUSTOM_API_KEY';
/** 5 minutes of 16 kHz 16-bit mono is ~9.6 MB; anything bigger is refused. */
const MAX_WAV_BYTES = 12 * 1024 * 1024;

const log = (...a: unknown[]) => console.log('[voice]', ...a);

export function initVoice() {
  initWhisperPidFile(join(app.getPath('userData'), 'whisper-server.pid'));
}

export function shutdownVoice() {
  stopWhisperServer();
}

export function voiceSettings(): VoiceSettings {
  const s = store.getSettings();
  return normalizeVoice(s.voice, s.voice?.language ?? defaultVoiceLanguage(s.profile?.languages));
}

function detectCtx(): DetectCtx {
  return { home: homedir(), platform: process.platform, pathEnv: process.env.PATH ?? '', localAppData: process.env.LOCALAPPDATA };
}

function whisperFound(settings = voiceSettings()): WhisperFound {
  return detectWhisper(detectCtx(), settings.whisperExtraModels ?? []);
}

/** Agents with a saved OPENROUTER_API_KEY (not this panel's own key). */
function agentKeyOwners(): string[] {
  return store.secretOwners(OPENROUTER_VAR).filter((o) => o !== 'voice');
}

function key(which: 'openrouter' | 'custom', s: VoiceSettings): string | undefined {
  if (which === 'custom') return store.getSecret(VOICE_CUSTOM_KEY);
  const from = s.openrouterKeyFrom;
  if (from && from !== 'voice') return store.getSecret(`${from}:${OPENROUTER_VAR}`);
  if (from === 'voice') return store.getSecret(VOICE_OR_KEY);
  // Not chosen yet: this panel's key, else the first agent's.
  return store.getSecret(VOICE_OR_KEY) ?? agentKeyOwners().map((o) => store.getSecret(`${o}:${OPENROUTER_VAR}`)).find(Boolean);
}

export function voiceStatus(): VoiceStatus {
  const settings = voiceSettings();
  const w = whisperFound(settings);
  const owners = agentKeyOwners();
  const voiceKeySaved = Boolean(store.getSecret(VOICE_OR_KEY));
  return {
    settings,
    engines: engineStatuses(settings, w, { openrouter: Boolean(key('openrouter', settings)), custom: Boolean(store.getSecret(VOICE_CUSTOM_KEY)) }, process.platform),
    whisper: { server: w.server, cli: w.cli, models: w.models, running: whisperServerRunning() },
    openrouter: { keySources: owners.map((id) => ({ id, label: id })), voiceKeySaved },
    custom: { keySaved: Boolean(store.getSecret(VOICE_CUSTOM_KEY)) },
    platform: process.platform,
  };
}

export function saveVoice(patch: Partial<VoiceSettings>): VoiceStatus {
  const next = { ...voiceSettings(), ...patch };
  store.updateSettings({ voice: next });
  if (next.engine !== 'whisper-local') stopWhisperServer();
  return voiceStatus();
}

export function setVoiceKey(which: 'openrouter' | 'custom', value: string | null): VoiceStatus {
  store.setSecret(which === 'openrouter' ? VOICE_OR_KEY : VOICE_CUSTOM_KEY, value?.trim() || null);
  return voiceStatus();
}

export async function addModelFile(sender: WebContents): Promise<VoiceStatus> {
  const win = BrowserWindow.fromWebContents(sender);
  const opts = { title: 'Add a whisper.cpp model', properties: ['openFile' as const], filters: [{ name: 'ggml model', extensions: ['bin'] }] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return voiceStatus();
  const s = voiceSettings();
  const extra = [...new Set([...(s.whisperExtraModels ?? []), r.filePaths[0]])];
  return saveVoice({ whisperExtraModels: extra, whisperModel: r.filePaths[0] });
}

/** Starts the warm whisper-server while the user is still speaking (no-op for other engines). */
export async function prewarm(settings?: Partial<VoiceSettings>): Promise<{ ok: boolean; error?: string }> {
  const s = { ...voiceSettings(), ...(settings ?? {}) };
  if (s.engine !== 'whisper-local') return { ok: true };
  const w = whisperFound(s);
  const model = pickWhisperModel(s, w.models);
  if (!w.server || !model) return { ok: true };
  try {
    await ensureServer(w.server, model);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** macOS: asks for microphone access once (the system prompt); true when allowed. Other platforms: true. */
export async function micAccess(): Promise<{ granted: boolean; status: string }> {
  if (process.platform !== 'darwin') return { granted: true, status: 'granted' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return { granted: true, status };
  if (status === 'denied' || status === 'restricted') return { granted: false, status };
  const granted = await systemPreferences.askForMediaAccess('microphone');
  return { granted, status: granted ? 'granted' : 'denied' };
}

/** Recent identifiers in this chat plus code-like file names of its project. */
async function vocabFor(threadId?: string): Promise<string[]> {
  if (!threadId) return [];
  const t = store.findThread(threadId);
  if (!t) return [];
  const texts = t.items
    .slice(-30)
    .reverse()
    .flatMap((i) => (i.kind === 'user' || i.kind === 'agent' ? [i.text] : []));
  const idents = extractIdentifiers(texts, 12);
  const p = store.getProject(t.projectId);
  const stems = p ? fileStems(await projectFiles(p.path), 8, idents) : [];
  return [...idents, ...stems];
}

export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  const wav = req.wav instanceof Uint8Array ? req.wav : new Uint8Array(req.wav as ArrayBufferLike);
  if (wav.byteLength > MAX_WAV_BYTES) return { ok: false, error: 'Recording is too long.' };
  const h = readWavHeader(wav);
  if (!h || h.bits !== 16) return { ok: false, error: 'Not a 16-bit WAV recording.' };
  const settings = { ...voiceSettings(), ...(req.settings ?? {}) };
  if (!RECORDING_ENGINES.includes(settings.engine)) return { ok: false, error: 'The chosen voice engine does not record.' };
  const vocab = await vocabFor(req.threadId);
  const r = await runTranscription(wav, settings, vocab, { whisper: () => whisperFound(settings), key });
  log(settings.engine, r.ok ? `ok ${r.ms} ms, ${r.text?.length ?? 0} chars` : `failed: ${r.error}`);
  return r;
}

export async function listOpenrouterModels() {
  return openrouterModels();
}

/** The `desk:voice` channel's methods (sender is the desktop window's web contents). */
export async function voiceCall(sender: WebContents, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'status':
      return voiceStatus();
    case 'save':
      return saveVoice((args[0] ?? {}) as Partial<VoiceSettings>);
    case 'setKey':
      return setVoiceKey(args[0] === 'custom' ? 'custom' : 'openrouter', (args[1] as string | null) ?? null);
    case 'addModel':
      return addModelFile(sender);
    case 'openrouterModels':
      return listOpenrouterModels();
    case 'prewarm':
      return prewarm(args[0] as Partial<VoiceSettings> | undefined);
    case 'micAccess':
      return micAccess();
    case 'transcribe':
      return transcribe(args[0] as TranscribeRequest);
    default:
      throw new Error(`Unknown voice method ${method}`);
  }
}
