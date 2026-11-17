import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  buildVoicePrompt,
  engineLanguage,
  type TranscribeResult,
  type VoiceEngineStatus,
  type VoiceSettings,
  type WhisperModelInfo,
} from '@shared/voice';
import { openaiCompatibleTranscribe, openrouterTranscribe } from './httpEngines';
import { transcribeWithCli, transcribeWithServer, whisperPlan, type WhisperOpts } from './whisperLocal';

/**
 * Engine selection for one clip, with every outside dependency passed in (the unit test swaps them for fakes).
 * Failure of the chosen engine is returned as an error; the composer then offers the OS dictation. Nothing silently
 * switches to a different engine (that could send audio somewhere the user didn't pick).
 */

export interface WhisperFound {
  server?: string;
  cli?: string;
  models: WhisperModelInfo[];
}

export interface EngineDeps {
  whisper: () => WhisperFound;
  /** 'openrouter' resolves the chosen source (this panel's key or an agent's); 'custom' is this panel's key. */
  key: (which: 'openrouter' | 'custom', settings: VoiceSettings) => string | undefined;
  serverRun?: (bin: string, o: WhisperOpts) => Promise<string>;
  cliRun?: (bin: string, o: WhisperOpts) => Promise<string>;
  openrouter?: typeof openrouterTranscribe;
  openaiCompatible?: typeof openaiCompatibleTranscribe;
  now?: () => number;
}

/** The model file whisper-local uses: the chosen one if it still exists, else the best detected one. */
export function pickWhisperModel(settings: VoiceSettings, models: WhisperModelInfo[]): string | undefined {
  if (settings.whisperModel && (models.some((m) => m.path === settings.whisperModel) || existsSync(settings.whisperModel))) return settings.whisperModel;
  return models[0]?.path;
}

export function engineStatuses(settings: VoiceSettings, w: WhisperFound, keys: { openrouter: boolean; custom: boolean }, platform: string): VoiceEngineStatus[] {
  const sys: VoiceEngineStatus =
    platform === 'darwin'
      ? { id: 'system', state: 'ready', detail: 'macOS Dictation' }
      : platform === 'win32'
        ? { id: 'system', state: 'ready', detail: 'Windows Voice Typing (Win+H)' }
        : { id: 'system', state: 'unsupported', detail: 'No system dictation on this platform' };
  const model = pickWhisperModel(settings, w.models);
  const bin = w.server ?? w.cli;
  const local: VoiceEngineStatus = !bin
    ? { id: 'whisper-local', state: 'not-found', detail: 'whisper.cpp not found (whisper-server or whisper-cli)' }
    : !model
      ? { id: 'whisper-local', state: 'not-found', detail: 'No ggml model found' }
      : { id: 'whisper-local', state: 'ready', detail: `${basename(bin)} · ${w.models.length} model${w.models.length === 1 ? '' : 's'}` };
  const or: VoiceEngineStatus = keys.openrouter
    ? { id: 'openrouter', state: settings.openrouterModel ? 'ready' : 'needs-setup', detail: settings.openrouterModel ? settings.openrouterModel : 'Pick a model' }
    : { id: 'openrouter', state: 'needs-key', detail: 'Needs an OpenRouter API key' };
  const custom: VoiceEngineStatus =
    settings.customBaseUrl && settings.customModel
      ? { id: 'openai-compatible', state: 'ready', detail: `${hostOf(settings.customBaseUrl)} · ${settings.customModel}${keys.custom ? ' · key saved' : ''}` }
      : { id: 'openai-compatible', state: 'needs-setup', detail: 'Needs a server URL and model' };
  return [sys, local, or, custom];
}

function hostOf(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runTranscription(wav: Uint8Array, settings: VoiceSettings, vocab: string[], deps: EngineDeps): Promise<TranscribeResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const language = engineLanguage(settings.language);
  const prompt = buildVoicePrompt(settings.language, vocab);
  const done = (text: string, model: string): TranscribeResult => ({ ok: true, text, engine: settings.engine, model, ms: Math.round(now() - t0) });
  const fail = (error: string): TranscribeResult => ({ ok: false, engine: settings.engine, error, ms: Math.round(now() - t0) });
  try {
    switch (settings.engine) {
      case 'system':
        return fail('System dictation types straight into the box; it does not transcribe recordings.');
      case 'whisper-local': {
        const w = deps.whisper();
        const model = pickWhisperModel(settings, w.models);
        const plan = whisperPlan(w);
        if (!plan.length) return fail('whisper.cpp is not installed (no whisper-server or whisper-cli found).');
        if (!model) return fail('No whisper model file found. Add one in Settings → Voice.');
        const errors: string[] = [];
        for (const step of plan) {
          try {
            const run = step.method === 'server' ? (deps.serverRun ?? transcribeWithServer) : (deps.cliRun ?? transcribeWithCli);
            const text = await run(step.bin, { wav, model, language, prompt });
            return done(text, basename(model));
          } catch (e) {
            errors.push(`${step.method}: ${msg(e)}`);
          }
        }
        return fail(errors.join(' · '));
      }
      case 'openrouter': {
        const apiKey = deps.key('openrouter', settings);
        if (!apiKey) return fail('No OpenRouter API key. Add one in Settings → Voice.');
        const model = settings.openrouterModel ?? '';
        const text = await (deps.openrouter ?? openrouterTranscribe)({ wav, model, apiKey, language, prompt });
        return done(text, model);
      }
      case 'openai-compatible': {
        const model = settings.customModel ?? '';
        const text = await (deps.openaiCompatible ?? openaiCompatibleTranscribe)({
          wav,
          model,
          baseUrl: settings.customBaseUrl ?? '',
          apiKey: deps.key('custom', settings),
          language,
          prompt,
        });
        return done(text, model);
      }
    }
  } catch (e) {
    return fail(msg(e));
  }
  return fail('Unknown engine.');
}
