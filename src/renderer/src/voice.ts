import { useEffect, useState } from 'react';
import { micModeFor, type TranscribeResult, type VoiceSettings, type VoiceStatus } from '@shared/voice';
import { encodeWav, mixToMono, resample, TARGET_RATE } from '@shared/wav';

/**
 * Renderer side of voice input: the `desk:voice` bridge (desktop window only; null on the phone page), a shared
 * status cache for the settings panel and the composer, and the mic recorder (getUserMedia → 16 kHz mono WAV).
 */

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.desk.voice!(method, ...args);

export const voiceApi =
  typeof window !== 'undefined' && window.desk?.voice
    ? {
        status: () => call<VoiceStatus>('status'),
        save: (patch: Partial<VoiceSettings>) => call<VoiceStatus>('save', patch),
        setKey: (which: 'openrouter' | 'custom', value: string | null) => call<VoiceStatus>('setKey', which, value),
        addModel: () => call<VoiceStatus>('addModel'),
        openrouterModels: () => call<{ id: string; name: string }[]>('openrouterModels'),
        prewarm: (settings?: Partial<VoiceSettings>) => call<{ ok: boolean; error?: string }>('prewarm', settings),
        micAccess: () => call<{ granted: boolean; status: string }>('micAccess'),
        transcribe: (wav: Uint8Array, threadId?: string, settings?: Partial<VoiceSettings>) => call<TranscribeResult>('transcribe', { wav, threadId, settings }),
      }
    : null;

let cached: VoiceStatus | null = null;
const subs = new Set<(s: VoiceStatus) => void>();

export function publishVoiceStatus(s: VoiceStatus) {
  cached = s;
  for (const f of subs) f(s);
}

export async function refreshVoiceStatus(): Promise<VoiceStatus | null> {
  if (!voiceApi) return null;
  const s = await voiceApi.status();
  publishVoiceStatus(s);
  return s;
}

/** The latest voice status (fetched once, updated whenever Settings → Voice saves). */
export function useVoiceStatus(): VoiceStatus | null {
  const [s, setS] = useState<VoiceStatus | null>(cached);
  useEffect(() => {
    subs.add(setS);
    if (!cached) void refreshVoiceStatus().catch(() => {});
    return () => {
      subs.delete(setS);
    };
  }, []);
  return s;
}

/** Records the microphone until `stop()`; returns 16 kHz mono 16-bit WAV bytes. */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private rate = 48_000;

  async start(): Promise<void> {
    const ask = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    // A mic that never answers must not leave the button stuck: give up after 10 s (and release it if it comes later).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void ask.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
        reject(new Error('the microphone did not respond'));
      }, 10_000);
    });
    try {
      this.stream = await Promise.race([ask, timeout]);
    } finally {
      clearTimeout(timer);
    }
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is simple and fine for speech; an AudioWorklet would need a separate module file.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    // Must reach the destination for onaudioprocess to fire; the output buffer stays silent.
    this.node.connect(this.ctx.destination);
  }

  /** Seconds recorded so far. */
  get seconds(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0) / this.rate;
  }

  private release() {
    this.node?.disconnect();
    this.node = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  stop(): Uint8Array {
    this.release();
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return encodeWav(resample(mixToMono([all]), this.rate, TARGET_RATE), TARGET_RATE);
  }

  cancel() {
    this.release();
    this.chunks = [];
  }
}

export const MAX_RECORD_SECONDS = 300;

/** What the composer's mic does right now (see `micModeFor`). */
export function micMode(status: VoiceStatus | null, systemAvailable: boolean): 'record' | 'system' | 'none' {
  return micModeFor(status?.settings.engine, Boolean(voiceApi), systemAvailable);
}
