/**
 * Voice input (Settings → Voice): which engine turns the composer's mic into text.
 * - `system`: the OS's own dictation (macOS startDictation:, Windows Win+H); nothing is recorded by Olympus.
 * - `whisper-local`: whisper.cpp already installed on this machine (detected, never downloaded).
 * - `openrouter`: OpenRouter's speech-to-text endpoint (audio leaves the machine).
 * - `openai-compatible`: any `/v1/audio/transcriptions` server (OpenAI, Groq, or a local speaches/faster-whisper).
 * Shared by main (engines) and renderer (settings panel, composer).
 */

export type VoiceEngineId = 'system' | 'whisper-local' | 'openrouter' | 'openai-compatible';
/** Engines that record audio in the app (everything but the OS dictation). */
export const RECORDING_ENGINES: VoiceEngineId[] = ['whisper-local', 'openrouter', 'openai-compatible'];

export interface VoiceSettings {
  engine: VoiceEngineId;
  /** 'auto', 'hinglish' (spoken Hindi + English, written in Roman letters) or an ISO-639-1 code. */
  language: string;
  /** whisper-local: absolute path of the chosen ggml model. Empty = the best detected one. */
  whisperModel?: string;
  /** Model files the user added with "Add model file…" (kept next to the detected ones). */
  whisperExtraModels?: string[];
  openrouterModel?: string;
  /** Where the OpenRouter key comes from: 'voice' (saved in this panel) or an agent id that has OPENROUTER_API_KEY. */
  openrouterKeyFrom?: string;
  customBaseUrl?: string;
  customModel?: string;
  /** whisper-local only: live text while speaking, auto-stop after 5 s of silence, "over" ends it. Missing = on. */
  live?: boolean;
  /** whisper-local only: listen for "Hey Oly" while an Olympus window is focused. Missing = off. */
  wakeWord?: boolean;
  /** Recording engines: a short sound when the mic opens and when it closes. Missing = on. */
  sounds?: boolean;
}

export const DEFAULT_VOICE: VoiceSettings = { engine: 'system', language: 'auto' };

export const VOICE_LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'hinglish', label: 'Hinglish (Roman letters)' },
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'Hindi (Devanagari)' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'it', label: 'Italian' },
  { id: 'ru', label: 'Russian' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
  { id: 'zh', label: 'Chinese' },
  { id: 'ar', label: 'Arabic' },
  { id: 'bn', label: 'Bengali' },
  { id: 'ur', label: 'Urdu' },
  { id: 'ta', label: 'Tamil' },
  { id: 'te', label: 'Telugu' },
  { id: 'mr', label: 'Marathi' },
  { id: 'gu', label: 'Gujarati' },
];

/**
 * Hinglish preset: whisper is told the language is English and given a romanized Hinglish example, which keeps Hindi
 * words in Roman letters (with `auto` it writes them in Devanagari) and primes coding words. Measured 2026-11-17 on
 * large-v3: near-perfect romanized Hinglish on a synthetic clip.
 */
export const HINGLISH_PROMPT = 'Bhai yeh code check karo, phir npm run build chala ke test karo. Git commit, push, file, function.';

/** The language code an engine is asked for: Hinglish → 'en', Auto → none. */
export function engineLanguage(language: string): string | undefined {
  if (!language || language === 'auto') return undefined;
  if (language === 'hinglish') return 'en';
  return language;
}

/** Whisper's prompt window is ~224 tokens; keep the hint well under it (~ 600 characters). */
export const MAX_PROMPT_CHARS = 600;

/** Previous text sent along in live mode (whisper reads the prompt as what came before). */
export const MAX_CONTEXT_CHARS = 200;

/**
 * The prompt sent with a clip: the Hinglish example (for that preset) plus project words, short. In live mode the
 * session's last committed words go last (`context`, closest to the audio), and the project words make room for them.
 */
export function buildVoicePrompt(language: string, vocab: string[], context = ''): string {
  const base = language === 'hinglish' ? HINGLISH_PROMPT : '';
  let ctx = context.replace(/\s+/g, ' ').trim();
  if (ctx.length > MAX_CONTEXT_CHARS) ctx = ctx.slice(-MAX_CONTEXT_CHARS).replace(/^\S*\s/, '');
  const words: string[] = [];
  let len = base.length + (ctx ? ctx.length + 1 : 0);
  for (const w of vocab) {
    const t = w.trim();
    if (!t || words.includes(t)) continue;
    if (len + t.length + 2 > MAX_PROMPT_CHARS) break;
    words.push(t);
    len += t.length + 2;
  }
  return [base, words.length ? `${words.join(', ')}.` : '', ctx].filter(Boolean).join(' ');
}

/** Settings saved before voice existed (or partly): fill the defaults. The engine stays 'system' unless picked. */
export function normalizeVoice(saved: Partial<VoiceSettings> | undefined, fallbackLanguage = 'auto'): VoiceSettings {
  const engine: VoiceEngineId = ['system', 'whisper-local', 'openrouter', 'openai-compatible'].includes(saved?.engine as string)
    ? (saved!.engine as VoiceEngineId)
    : 'system';
  return { ...DEFAULT_VOICE, language: fallbackLanguage, ...(saved ?? {}), engine };
}

/** Default language for someone who never picked one: Hinglish when their profile mentions Hindi/Hinglish. */
export function defaultVoiceLanguage(profileLanguages: string | undefined): string {
  return /hindi|hinglish|हिन्दी|हिंदी/i.test(profileLanguages ?? '') ? 'hinglish' : 'auto';
}

export interface WhisperModelInfo {
  path: string;
  name: string;
  bytes: number;
  /** Found in a known folder, or added by the user. */
  source: 'detected' | 'added';
}

export type EngineState = 'ready' | 'not-found' | 'needs-key' | 'needs-setup' | 'unsupported';

export interface VoiceEngineStatus {
  id: VoiceEngineId;
  state: EngineState;
  /** One short line for the UI, e.g. "whisper-server in /opt/homebrew/bin" or "Key from Claude Code". */
  detail: string;
}

export interface VoiceStatus {
  settings: VoiceSettings;
  engines: VoiceEngineStatus[];
  whisper: { server?: string; cli?: string; models: WhisperModelInfo[]; running: boolean };
  openrouter: { keySources: { id: string; label: string }[]; voiceKeySaved: boolean };
  custom: { keySaved: boolean };
  platform: string;
}

export interface TranscribeRequest {
  /** 16 kHz mono 16-bit PCM WAV. */
  wav: Uint8Array;
  threadId?: string;
  /** Override the saved engine/settings (Settings → Voice → Test before saving). */
  settings?: Partial<VoiceSettings>;
  /** Live mode: the session's recent committed text, appended to the prompt. */
  context?: string;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  engine?: VoiceEngineId;
  /** Model actually used (file name or model id). */
  model?: string;
  ms?: number;
  error?: string;
}

/**
 * What the composer's mic does: 'record' with an in-app engine, 'system' for the OS dictation, 'none' hides it
 * (Linux without a recording engine, or a page without the desktop voice bridge such as the phone page).
 */
/** Live mode (streaming text, auto-stop, "over") is for the local engine only: nothing streams to a paid/remote API. */
export function liveModeFor(settings: Pick<VoiceSettings, 'engine' | 'live'> | undefined): boolean {
  return settings?.engine === 'whisper-local' && settings.live !== false;
}

/** "Hey Oly" listening: local engine only (it transcribes every short thing said while Olympus is focused). */
export function wakeWordFor(settings: Pick<VoiceSettings, 'engine' | 'wakeWord'> | undefined): boolean {
  return settings?.engine === 'whisper-local' && settings.wakeWord === true;
}

/** Mic open/close sounds: recording engines only (the OS dictation makes its own), on unless turned off. */
export function micSoundsFor(settings: Pick<VoiceSettings, 'engine' | 'sounds'> | undefined): boolean {
  return Boolean(settings && RECORDING_ENGINES.includes(settings.engine) && settings.sounds !== false);
}

export function micModeFor(engine: VoiceEngineId | undefined, hasVoiceBridge: boolean, systemAvailable: boolean): 'record' | 'system' | 'none' {
  if (hasVoiceBridge && engine && engine !== 'system') return 'record';
  return systemAvailable ? 'system' : 'none';
}
