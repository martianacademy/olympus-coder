import { useEffect, useRef, useState } from 'react';
import { WakeDetector } from '@shared/liveVoice';
import { MicRecorder, voiceApi } from './voice';

/** Re-warm the whisper-server this often while "Hey Oly" listens (its idle stop is 10 min). */
const WAKE_KEEP_WARM_MS = 4 * 60_000;

/** True while this Olympus window has keyboard focus (the wake word only listens then). */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => typeof document !== 'undefined' && document.hasFocus());
  useEffect(() => {
    const check = () => setFocused(document.hasFocus() && document.visibilityState === 'visible');
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    document.addEventListener('visibilitychange', check);
    // Focus events can be missed (e.g. a native dialog); a cheap re-check keeps it honest.
    const t = setInterval(check, 1500);
    return () => {
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      document.removeEventListener('visibilitychange', check);
      clearInterval(t);
    };
  }, []);
  return focused;
}

/**
 * "Hey Oly": while `enabled`, not `paused` and the window is focused, the mic is open and short speech segments are
 * transcribed by the local whisper and fuzzy-matched. Losing focus closes the mic at once. On a match the mic is
 * released before `onWake(rest)` runs, so the live session that follows starts a fresh capture.
 */
export function useWakeWord(enabled: boolean, paused: boolean, threadId: string, onWake: (rest: string) => void): { listening: boolean; error: string } {
  const focused = useWindowFocused();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const wakeRef = useRef(onWake);
  wakeRef.current = onWake;
  const active = Boolean(voiceApi) && enabled && !paused && focused;

  useEffect(() => {
    if (!active || !voiceApi) return;
    let closed = false;
    let rec: MicRecorder | null = null;
    let det: WakeDetector | null = null;
    let warm: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      closed = true;
      clearInterval(warm);
      det?.close();
      rec?.cancel();
      rec = null;
      setListening(false);
    };
    void (async () => {
      const access = await voiceApi.micAccess().catch(() => ({ granted: true, status: '' }));
      if (closed) return;
      if (!access.granted) return setError('Microphone access is off.');
      det = new WakeDetector({
        transcribe: async (wav) => {
          const r = await voiceApi!.transcribeLive(wav, threadId);
          if (!r.ok) throw new Error(r.error ?? 'transcription failed');
          return r.text ?? '';
        },
        onWake: (rest) => {
          if (closed) return;
          close();
          wakeRef.current(rest);
        },
        onError: (m) => setError(m),
      });
      const r = new MicRecorder({ keep: false, onChunk: (x) => det?.push(x) });
      try {
        await r.start();
      } catch (e) {
        if (!closed) setError(e instanceof Error ? e.message : String(e));
        r.cancel();
        return;
      }
      if (closed) return r.cancel();
      rec = r;
      setError('');
      setListening(true);
      void voiceApi.prewarm().catch(() => {});
      // Keep the local model loaded while listening (it unloads after 10 min idle; a cold start doubled the wake
      // delay: ~1.4 s instead of ~0.7 s, measured). Stops with the loop, e.g. when the window loses focus.
      warm = setInterval(() => void voiceApi!.prewarm().catch(() => {}), WAKE_KEEP_WARM_MS);
    })();
    return close;
  }, [active, threadId]);

  return { listening, error };
}
