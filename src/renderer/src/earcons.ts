import { EARCON_GAIN, EARCONS, earconMs, type EarconId } from '@shared/earcons';

/** Plays an Olympus mic sound (see src/shared/earcons.ts). Resolves when it has finished; never throws. */
let ctx: AudioContext | null = null;

export async function playEarcon(id: EarconId): Promise<void> {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const n of EARCONS[id]) {
      const start = t0 + n.at / 1000;
      const end = start + n.ms / 1000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(EARCON_GAIN, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      g.connect(ctx.destination);
      // A sine plus a faint octave: a soft bell rather than a beep.
      for (const [mult, level] of [
        [1, 1],
        [2, 0.15],
      ] as const) {
        const o = ctx.createOscillator();
        const lv = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = n.freq * mult;
        lv.gain.value = level;
        o.connect(lv).connect(g);
        o.start(start);
        o.stop(end + 0.02);
      }
    }
    await new Promise((r) => setTimeout(r, earconMs(id) + 30));
  } catch {
    /* no audio output: silently skip */
  }
}
