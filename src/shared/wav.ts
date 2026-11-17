/**
 * Mic audio → the 16 kHz mono 16-bit PCM WAV every transcription engine accepts (whisper.cpp needs exactly this).
 * Pure functions, used by the renderer's recorder and the unit tests.
 */

export const TARGET_RATE = 16_000;

/** Down-mix to mono by averaging channels. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Linear-interpolation resample with a box pre-filter when downsampling (good enough for speech recognition). */
export function resample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  const win = ratio > 1 ? Math.floor(ratio) : 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    if (win > 1) {
      // Average the source samples this output sample covers (simple anti-aliasing).
      const start = Math.floor(pos);
      let sum = 0;
      let count = 0;
      for (let k = start; k < start + win && k < input.length; k++) {
        sum += input[k];
        count++;
      }
      out[i] = count ? sum / count : 0;
    } else {
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const f = pos - i0;
      out[i] = input[i0] * (1 - f) + input[i1] * f;
    }
  }
  return out;
}

/** 16-bit PCM WAV bytes for mono float samples in [-1, 1] (values outside are clipped). */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Header facts of a WAV, for checks (main refuses anything that isn't small 16 kHz-ish PCM). */
export function readWavHeader(b: Uint8Array): { rate: number; channels: number; bits: number; dataBytes: number } | null {
  if (b.length < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ') return null;
  return { channels: v.getUint16(22, true), rate: v.getUint32(24, true), bits: v.getUint16(34, true), dataBytes: v.getUint32(40, true) };
}

/** Seconds of audio in a 16-bit mono WAV. */
export function wavSeconds(b: Uint8Array): number {
  const h = readWavHeader(b);
  return h ? h.dataBytes / (h.rate * h.channels * (h.bits / 8)) : 0;
}
