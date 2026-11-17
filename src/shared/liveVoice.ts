import { encodeWav, TARGET_RATE } from './wav';

/**
 * Live voice (composer mic with the local whisper engine): pure logic shared by the renderer and the unit tests.
 * - `EnergyVad`: RMS energy voice-activity detection on 20 ms frames with an adaptive noise floor.
 * - `LiveSegmenter`: decides, in audio time, when a stretch of speech is final (a silence gap) and when to refresh the
 *   interim text. whisper-server is stateless (one WAV per request), so live text is a rolling re-transcription of the
 *   uncommitted audio (at most LIVE_WINDOW_MS long); committed audio is never transcribed again.
 * - `LiveSession`: drives one live session over an injected `transcribe` (one request in flight, commits first).
 * - `WakeDetector` + `matchWake`: "Hey Oly" on short VAD-gated speech segments.
 * - `matchEndPhrase`: "over" / "over and out" at the end of a committed segment ends the session.
 * Everything runs on 16 kHz mono Float32 samples (TARGET_RATE).
 */

export const LIVE_RATE = TARGET_RATE;
/** VAD frame length. */
export const VAD_FRAME_MS = 20;
/** How often the interim text is refreshed while someone speaks (audio time). */
export const LIVE_TICK_MS = 700;
/** Longest uncommitted stretch; past it the quietest point is cut and committed (bounds every request). */
export const LIVE_WINDOW_MS = 10_000;
/** Silence that ends a phrase (the user asked for ~100 ms). See MIN_COMMIT_SPEECH_MS / LONG_GAP_MS for the guards. */
export const COMMIT_GAP_MS = 100;
/** A short gap only commits once this much speech has piled up; whisper does badly on one-word clips. */
export const MIN_COMMIT_SPEECH_MS = 1200;
/** A gap this long commits whatever speech there is (a lone word, "over"). */
export const LONG_GAP_MS = 600;
/** A live session with no speech for this long stops by itself. */
export const AUTO_STOP_SILENCE_MS = 5000;
/** Speech needs at least this RMS (~ -38 dBFS) and VAD_FLOOR_FACTOR × the noise floor. */
export const VAD_MIN_RMS = 0.012;
export const VAD_FLOOR_FACTOR = 3;
/** Uncommitted text sent back to whisper as context (the prompt is "previous text"). */
export const CONTEXT_CHARS = 200;

const ms2s = (ms: number) => Math.round((ms * LIVE_RATE) / 1000);
const FRAME = ms2s(VAD_FRAME_MS);

export function rms(x: Float32Array, start = 0, end = x.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return end > start ? Math.sqrt(s / (end - start)) : 0;
}

/** RMS VAD: per complete 20 ms frame, speech or not. The floor drops fast and rises slowly (steady noise ≠ speech). */
export class EnergyVad {
  floor = 0.002;
  private rest = new Float32Array(0);

  threshold(): number {
    return Math.max(VAD_MIN_RMS, this.floor * VAD_FLOOR_FACTOR);
  }

  /** Classifies the complete frames in `samples` (a partial frame waits for the next call). */
  push(samples: Float32Array): { speech: boolean; rms: number }[] {
    const x = this.rest.length ? concat(this.rest, samples) : samples;
    const out: { speech: boolean; rms: number }[] = [];
    let o = 0;
    for (; o + FRAME <= x.length; o += FRAME) {
      const r = rms(x, o, o + FRAME);
      const speech = r > this.threshold();
      if (r < this.floor) this.floor = Math.max(0.0005, r);
      else this.floor += (r - this.floor) * (speech ? 0.0005 : 0.01);
      out.push({ speech, rms: r });
    }
    this.rest = x.slice(o);
    return out;
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const c = new Float32Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

export interface Span {
  /** Absolute sample indices since the session started. */
  from: number;
  to: number;
  /** Speech inside the span, ms. */
  speechMs: number;
  /** Commits carry their samples (the segmenter drops committed audio right away). */
  audio?: Float32Array;
}

export type LiveStopReason = 'manual' | 'silence' | 'over' | 'max' | 'cancel';

/**
 * Audio bookkeeping for one live session. Feed 16 kHz samples with `push`; it returns the spans to commit (final
 * text) and whether the session should stop. `interim()` hands out the uncommitted span when an interim refresh is due.
 */
export class LiveSegmenter {
  private vad = new EnergyVad();
  /** Audio from `base` (absolute index) to `total`. Everything before `from` is committed and dropped. */
  private buf = new Float32Array(LIVE_RATE * 16);
  private base = 0;
  total = 0;
  /** Start of the uncommitted audio. */
  from = 0;
  /** Per-frame (speech, rms) for the uncommitted audio, frame k covers samples [framesBase + k*FRAME, +FRAME). */
  private frames: { speech: boolean; rms: number }[] = [];
  private framesBase = 0;
  private lastSpeechEnd = 0;
  private lastInterim = 0;
  private silenceRun = 0;
  done = false;

  private readonly opts: { commitGapMs?: number; maxSeconds?: number };

  constructor(opts: { commitGapMs?: number; maxSeconds?: number } = {}) {
    this.opts = opts;
  }

  get commitGapMs() {
    return this.opts.commitGapMs ?? COMMIT_GAP_MS;
  }

  /** Speech in the uncommitted audio, ms. */
  uncommittedSpeechMs(): number {
    return this.speechMsBetween(this.from, this.total);
  }

  private speechMsBetween(from: number, to: number): number {
    let n = 0;
    for (let k = 0; k < this.frames.length; k++) {
      const s = this.framesBase + k * FRAME;
      if (s >= from && s + FRAME <= to && this.frames[k].speech) n++;
    }
    return n * VAD_FRAME_MS;
  }

  push(samples: Float32Array): { commits: Span[]; stop?: LiveStopReason } {
    if (this.done) return { commits: [] };
    this.append(samples);
    for (const f of this.vad.push(samples)) {
      this.frames.push(f);
      const end = this.framesBase + this.frames.length * FRAME;
      if (f.speech) {
        this.silenceRun = 0;
        this.lastSpeechEnd = end;
      } else this.silenceRun += VAD_FRAME_MS;
    }
    const commits: Span[] = [];
    const speech = this.uncommittedSpeechMs();
    const end = this.framesBase + this.frames.length * FRAME;
    if (speech === 0) {
      // Only silence pending: let it go (keep 300 ms of lead-in for the next word).
      if (end - this.from > ms2s(1000)) this.advance(end - ms2s(300));
    } else if (this.silenceRun >= this.commitGapMs && (speech >= MIN_COMMIT_SPEECH_MS || this.silenceRun >= LONG_GAP_MS)) {
      commits.push({ from: this.from, to: end, speechMs: speech, audio: this.audio(this.from, end) });
      this.advance(end);
    } else if (end - this.from >= ms2s(LIVE_WINDOW_MS)) {
      const cut = this.quietestCut(this.from + ms2s(LIVE_WINDOW_MS / 2), end - ms2s(500));
      commits.push({ from: this.from, to: cut, speechMs: this.speechMsBetween(this.from, cut), audio: this.audio(this.from, cut) });
      this.advance(cut);
    }
    let stop: LiveStopReason | undefined;
    if (this.total - this.lastSpeechEnd >= ms2s(AUTO_STOP_SILENCE_MS)) stop = 'silence';
    else if (this.total >= ms2s((this.opts.maxSeconds ?? Infinity) * 1000)) stop = 'max';
    return { commits, stop };
  }

  /** The uncommitted span, when it has speech and LIVE_TICK_MS of new audio arrived since the last interim. */
  interim(): Span | null {
    if (this.done || this.total - this.lastInterim < ms2s(LIVE_TICK_MS)) return null;
    const speechMs = this.uncommittedSpeechMs();
    if (!speechMs) return null;
    this.lastInterim = this.total;
    return { from: this.from, to: this.total, speechMs };
  }

  /** Ends the session: the last uncommitted span (if it holds speech) is the final commit. */
  finish(): Span | null {
    if (this.done) return null;
    this.done = true;
    const speechMs = this.uncommittedSpeechMs();
    return speechMs >= 100 ? { from: this.from, to: this.total, speechMs, audio: this.audio(this.from, this.total) } : null;
  }

  /** A copy of the samples in [from, to). */
  audio(from: number, to: number): Float32Array {
    const a = Math.max(from, this.base) - this.base;
    const b = Math.min(to, this.total) - this.base;
    return this.buf.slice(a, Math.max(a, b));
  }

  private quietestCut(lo: number, hi: number): number {
    let best = hi;
    let bestRms = Infinity;
    // 100 ms windows (5 frames), lowest mean RMS; cut in its middle.
    for (let k = 0; k + 5 <= this.frames.length; k++) {
      const s = this.framesBase + k * FRAME;
      if (s < lo || s + 5 * FRAME > hi) continue;
      let r = 0;
      for (let j = 0; j < 5; j++) r += this.frames[k + j].rms;
      if (r < bestRms) {
        bestRms = r;
        best = s + Math.floor((5 * FRAME) / 2);
      }
    }
    return Math.max(this.from + 1, Math.min(best, this.total));
  }

  private advance(to: number) {
    this.from = Math.max(this.from, to);
    this.lastInterim = Math.max(this.lastInterim, this.from);
    // Drop committed frames and audio.
    const k = Math.floor((this.from - this.framesBase) / FRAME);
    if (k > 0) {
      this.frames.splice(0, k);
      this.framesBase += k * FRAME;
    }
    const drop = this.from - this.base;
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.total - this.base);
      this.base = this.from;
    }
  }

  private append(x: Float32Array) {
    const used = this.total - this.base;
    if (used + x.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, used + x.length));
      next.set(this.buf.subarray(0, used));
      this.buf = next;
    }
    this.buf.set(x, used);
    this.total += x.length;
  }
}

/** whisper's non-speech tags and the stock phrases it invents for near-silence. */
const SILENCE_PHRASES = /^(thank you|thanks|thanks for watching|thank you for watching|you|bye|okay|subscribe)[.!]?$/i;

/** Text as it goes into the composer: no [BLANK_AUDIO] / (music) tags; stock hallucinations of short clips dropped. */
export function cleanTranscript(text: string, speechMs = Infinity): string {
  const t = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (speechMs < 1000 && SILENCE_PHRASES.test(t)) return '';
  return t;
}

const WORD = /[\p{L}\p{M}\p{N}']+/gu;

function words(text: string): { w: string; start: number; end: number }[] {
  return [...text.matchAll(WORD)].map((m) => ({ w: m[0].toLowerCase().replace(/'/g, ''), start: m.index!, end: m.index! + m[0].length }));
}

const END_WORDS = new Set(['over', 'ovar', 'ovr', 'ओवर']);

/** "… over" / "… over and out" at the very end (only punctuation after): ended, with the text before it. */
export function matchEndPhrase(text: string): { ended: boolean; rest: string } {
  const ws = words(text);
  const n = ws.length;
  if (!n) return { ended: false, rest: text };
  let cut = -1;
  if (n >= 3 && END_WORDS.has(ws[n - 3].w) && ws[n - 2].w === 'and' && ws[n - 1].w === 'out') cut = ws[n - 3].start;
  else if (END_WORDS.has(ws[n - 1].w)) cut = ws[n - 1].start;
  if (cut < 0) return { ended: false, rest: text };
  // "over over": both go.
  let rest = text.slice(0, cut);
  const before = words(rest);
  if (before.length && END_WORDS.has(before[before.length - 1].w)) rest = rest.slice(0, before[before.length - 1].start);
  return { ended: true, rest: rest.replace(/[\s,;:—–-]+$/u, '').trim() };
}

/**
 * "Hey Oly" in any accent or script. whisper writes what it hears, so the matcher accepts: a greeting (hey/hi/hello/
 * ok and how other languages and accents say or spell them) followed by the name (oly/oli/olly/ollie/… in Latin
 * letters, or written in Indian, Arabic/Urdu, Cyrillic, Greek, Thai, Japanese, Korean or Chinese script).
 * A greeting alone or the name alone never wakes. Latin words are compared without accents ("olí" = "oli").
 */
const GREETINGS = new Set([
  // English and accents
  'hey', 'heyy', 'heyyy', 'hay', 'haye', 'hae', 'hei', 'heh', 'he', 'hee', 'hie', 'hy', 'hiy', 'hii', 'hi', 'hiya', 'hai',
  'heya', 'heyo', 'ey', 'eyy', 'eh', 'ei', 'ae', 'aey', 'aye', 'ay', 'ayy', 'ai', 'a', 'yo', 'ok', 'okay', 'okey', 'oke',
  'hello', 'helo', 'hallo', 'hullo', 'hola', 'ola', 'oi', 'oe', 'oy', 'oye', 'oyee', 'arey', 'are', 'arre', 'ji',
  // other languages (Latin script)
  'hej', 'hoi', 'hoy', 'ehi', 'ciao', 'salut', 'moi', 'merhaba', 'selam', 'halo', 'hai', 'cze', 'czesc', 'salve', 'ahoj',
  // Indian scripts
  'हे', 'हेय', 'है', 'हाय', 'ऐ', 'ए', 'अरे', 'ओए', 'ओय', 'हेलो', 'हैलो', 'हेई',
  'হে', 'হেই', 'হাই', 'এই', 'ওহে', // Bengali
  'ஹே', 'ஹாய்', 'ஏய்', 'ஹலோ', // Tamil
  'హే', 'హాయ్', 'ఏయ్', 'హలో', // Telugu
  'ಹೇ', 'ಹಾಯ್', 'ಏಯ್', 'ಹಲೋ', // Kannada
  'હે', 'હાય', 'એ', 'હેલો', // Gujarati
  'ਹੇ', 'ਹਾਏ', 'ਓਏ', 'ਹੈਲੋ', // Punjabi
  'ഹേ', 'ഹായ്', 'ഏയ്', // Malayalam
  // Arabic / Urdu / Persian
  'ہے', 'ہائے', 'اے', 'ارے', 'ہیلو', 'هاي', 'هي', 'يا', 'مرحبا', 'هلو', 'سلام',
  // Cyrillic, Greek, Thai
  'эй', 'хей', 'хэй', 'хай', 'привет', 'алло', 'гей', 'έι', 'ει', 'γεια', 'χέι', 'เฮ', 'เฮ้', 'เฮย์', 'หวัดดี',
  // Korean (spaced)
  '헤이', '하이', '야', '안녕',
]);
/**
 * The name in Latin letters: o/au/aw/ou/oa (+h) + l(l) + an ending — oly, oli, olly, olli, ollie, olie, oliee, olye,
 * oley, olee, olay, olei, ohly, ohli, ooli, auli, awlee, ouli, oaly, holy, holi, holly, olympus … (never "all", "oil",
 * "olive", "hole", "old").
 */
const NAME_CORE = String.raw`(?:o+|au|aw|ou|oa)h?l+(?:y+|i+|ie+|ee+|ey+|ye+|ay|ai|ae|ei|ii|ea|eigh|yi|ympus|ympia)`;
const NAME = new RegExp(`^h?${NAME_CORE}$`);
/** Said fast, "Hey Oly" comes back as "Hey Ali" (measured on large-v3); accepted on purpose, only after a greeting. */
const NAME_EXTRA = new Set(['ali', 'aly', 'alee', 'alli', 'ally', 'alie', 'oley', 'olli', 'uli', 'ulli', 'ully', 'ole', 'olé',
  // r for l (Japanese/Korean accents: "Hey yori")
  'ori', 'orii', 'orie', 'oree', 'ory', 'yori', 'yoli', 'yolly']);
/** The name written in other scripts (how whisper transliterates "Oly"/"Olly"/"Ollie"). */
const NAME_SCRIPTS = new Set([
  'ओली', 'ओलि', 'ओल्ली', 'ऑली', 'ऑलि', 'होली', 'ओलिम्पस', 'ओलिंपस', // Hindi/Marathi
  'ওলি', 'ওলী', 'অলি', 'অলী', 'ওল্লি', // Bengali
  'ஒலி', 'ஓலி', 'ஒல்லி', 'ஆலி', // Tamil
  'ఓలీ', 'ఒలి', 'ఓలి', 'ఒల్లి', 'ఆలీ', // Telugu
  'ಓಲಿ', 'ಒಲಿ', 'ಓಲೀ', 'ಒಲ್ಲಿ', // Kannada
  'ઓલી', 'ઓલિ', 'ઑલી', // Gujarati
  'ਓਲੀ', 'ਓਲਿ', 'ਔਲੀ', // Punjabi
  'ഓലി', 'ഒലി', 'ഒല്ലി', // Malayalam
  'اولی', 'اولي', 'أولي', 'اوليا', 'آلی', 'عالی', 'اولّی', // Urdu/Arabic/Persian
  'оли', 'олли', 'оле', 'оливер', 'олі', 'олімп', 'олимпус', // Cyrillic
  'όλι', 'ολι', 'όλυ', 'ολύ', // Greek
  'โอลี่', 'โอลี', 'ออลลี่', 'โอลี้', // Thai
  '올리', '오리', '올이', '얼리', // Korean
]);
/** Name split in two by whisper: "oh lee", "o li", "o'lie". */
const NAME_HEAD = new Set(['o', 'oh', 'ow', 'au', 'aw', 'ou']);
const NAME_TAIL = /^(?:l+(?:y+|i+|ie+|ee+|ey+|ye+|ay|ai|ea)|lie|lee|ly|li|ley)$/;
/** One word: "heyoly", "hioli", "okoli", and accent run-togethers measured on large-v3: "eoli", "ejoli", "erioli", "heali". */
const JOINED = new RegExp(`^(?:hey+|hay|hei|he|hi+|aey|ae|ay|ey|e|ei|ej|eri|ehi|hej|oye|ok|okay|hello|hola)(?:${NAME_CORE}|ali|aly|ole)$`);
/** Scripts written without spaces (Chinese, Japanese) and run-together Korean: greeting + name inside one run. */
const CJK_WAKE = /(?:嘿|嗨|喂|哎|黑|海|ヘイ|ねえ|ハイ|へい|헤이|하이|야)[\s、，,!！。]*(?:欧力|奥利|欧利|奥莉|欧莉|奧利|歐力|歐利|噢力|哦利|哦力|オリー|オーリー|オリ|オリィ|올리|오리)/u;
/** The wake phrase may follow a little noise ("uh hey oly"); it must start within the first few words. */
const WAKE_SEARCH_WORDS = 2;

/** Latin letters without accents ("olí" → "oli"); other scripts unchanged. */
function plain(w: string): string {
  return /^[\p{Script=Latin}\p{M}']+$/u.test(w) ? w.normalize('NFD').replace(/\p{M}/gu, '') : w;
}

function isGreeting(w: string): boolean {
  return GREETINGS.has(w) || GREETINGS.has(plain(w));
}

/** End index of the name starting at word `j`, or -1. */
function nameAt(ws: { w: string; end: number }[], j: number): number {
  const a = ws[j];
  if (!a) return -1;
  const p = plain(a.w);
  if (NAME.test(p) || NAME_EXTRA.has(p) || NAME_SCRIPTS.has(a.w)) return a.end;
  const b = ws[j + 1];
  if (b && NAME_HEAD.has(p) && NAME_TAIL.test(plain(b.w))) return b.end;
  return -1;
}

const restAfter = (text: string, end: number) => text.slice(end).replace(/^[\s,.!?;:—–।、，。！？-]+/u, '').trim();

/** "Hey Oly" (fuzzy, any accent/script) near the start of `text`; `rest` is whatever was said after it. */
export function matchWake(text: string): { matched: boolean; rest: string } {
  const ws = words(text);
  for (let i = 0; i < Math.min(ws.length, WAKE_SEARCH_WORDS); i++) {
    let end = -1;
    if (JOINED.test(plain(ws[i].w))) end = ws[i].end;
    else if (isGreeting(ws[i].w)) {
      end = nameAt(ws, i + 1);
      // "Hey, hey Oly" / "hey hi oly": one more greeting in between.
      if (end < 0 && ws[i + 1] && isGreeting(ws[i + 1].w)) end = nameAt(ws, i + 2);
    }
    if (end >= 0) return { matched: true, rest: restAfter(text, end) };
  }
  // Chinese / Japanese: no spaces, so look for greeting+name near the start of the text itself.
  const m = CJK_WAKE.exec(text);
  if (m && m.index <= 6) return { matched: true, rest: restAfter(text, m.index + m[0].length) };
  return { matched: false, rest: '' };
}

export interface LiveDeps {
  /** Transcribes a 16 kHz mono WAV; `context` is the session's recent committed text. */
  transcribe: (wav: Uint8Array, context: string) => Promise<string>;
  onInterim: (text: string) => void;
  onCommit: (text: string) => void;
  /** The session wants the mic released (silence, "over", max length); the caller then calls `stop(reason)`. */
  onWantStop: (reason: LiveStopReason) => void;
  /** Every request done after `stop`; the session is over. */
  onEnd: (reason: LiveStopReason) => void;
  onError?: (message: string) => void;
}

/**
 * One live session: mic samples in, interim + committed text out. One transcription in flight at a time; queued
 * commits go first (in order), and an interim refresh only runs when nothing else waits. An interim answer for audio
 * that has been committed meanwhile is dropped.
 */
export class LiveSession {
  readonly seg: LiveSegmenter;
  private queue: Span[] = [];
  private busy = false;
  private stopping: LiveStopReason | null = null;
  private ended = false;
  private committed = '';
  private interimShown = '';

  private readonly deps: LiveDeps;

  constructor(deps: LiveDeps, opts: { commitGapMs?: number; maxSeconds?: number } = {}) {
    this.deps = deps;
    this.seg = new LiveSegmenter(opts);
  }

  get stopped() {
    return this.stopping !== null;
  }

  push(samples: Float32Array) {
    if (this.stopping) return;
    const r = this.seg.push(samples);
    for (const c of r.commits) this.enqueue(c);
    if (r.stop) this.deps.onWantStop(r.stop);
    void this.pump();
  }

  /** Final commit of what's left, then `onEnd` once every request is back. */
  stop(reason: LiveStopReason = 'manual') {
    if (this.stopping) return;
    this.stopping = reason;
    if (reason === 'cancel') {
      this.queue = [];
      this.seg.done = true;
    } else {
      const last = this.seg.finish();
      if (last) this.enqueue(last);
    }
    void this.pump();
  }

  private enqueue(s: Span) {
    this.queue.push(s);
  }

  private setInterim(t: string) {
    if (t === this.interimShown) return;
    this.interimShown = t;
    this.deps.onInterim(t);
  }

  private async run(span: Span): Promise<string> {
    const wav = encodeWav(span.audio ?? this.seg.audio(span.from, span.to), LIVE_RATE);
    const raw = await this.deps.transcribe(wav, this.committed.slice(-CONTEXT_CHARS));
    return cleanTranscript(raw, span.speechMs);
  }

  private async pump(): Promise<void> {
    if (this.busy || this.ended) return;
    this.busy = true;
    try {
      for (;;) {
        const commit = this.queue.shift();
        if (commit) {
          let text = '';
          try {
            text = await this.run(commit);
          } catch (e) {
            this.deps.onError?.(e instanceof Error ? e.message : String(e));
          }
          if (this.stopping === 'cancel') break;
          const end = matchEndPhrase(text);
          if (end.ended) text = end.rest;
          if (text) {
            this.committed = `${this.committed} ${text}`.trim();
            this.deps.onCommit(text);
          }
          this.setInterim('');
          if (end.ended && !this.stopping) {
            // Anything said after "over" is dropped.
            this.queue = [];
            this.deps.onWantStop('over');
            this.stop('over');
            this.queue = [];
          }
          continue;
        }
        if (this.stopping) break;
        const span = this.seg.interim();
        if (!span) break;
        let text = '';
        try {
          text = await this.run(span);
        } catch (e) {
          // Report it; queued commits still run (the same span isn't due again until more audio arrives).
          this.deps.onError?.(e instanceof Error ? e.message : String(e));
          continue;
        }
        // Committed meanwhile (or stopped): stale.
        if (this.stopping || this.seg.from !== span.from || this.queue.length) continue;
        this.setInterim(text);
      }
    } finally {
      this.busy = false;
    }
    if (this.stopping && !this.queue.length && !this.ended) {
      this.ended = true;
      this.setInterim('');
      this.deps.onEnd(this.stopping);
    }
  }
}

/** Wake listening: a speech segment ends after this much silence. */
export const WAKE_END_GAP_MS = 350;
/** Segments shorter than this (clicks, coughs) aren't transcribed on their own. */
export const WAKE_MIN_SPEECH_MS = 250;
/** Longer speech is cut here and checked anyway ("Hey Oly, fix the build" said in one breath). */
export const WAKE_MAX_SEGMENT_MS = 4000;
/** Audio kept before a segment's first speech frame (so the "h" of "hey" isn't lost). */
export const WAKE_PREROLL_MS = 250;
/**
 * "Hey … Oly" said with a pause: a short segment (a lone "hey", under WAKE_JOIN_SHORT_MS of speech) that ended at most
 * this long before the next one is checked together with it. Measured: "Hey [550 ms] Oly" never woke before this.
 */
export const WAKE_JOIN_GAP_MS = 1200;
export const WAKE_JOIN_SHORT_MS = 700;
/** …but a click (under this) is never taken for a "hey". */
export const WAKE_JOIN_MIN_MS = 150;

export interface WakeDeps {
  transcribe: (wav: Uint8Array) => Promise<string>;
  onWake: (rest: string) => void;
  onError?: (m: string) => void;
}

interface WakeSeg {
  /** Absolute sample range (pre-roll included). */
  from: number;
  to: number;
  speechMs: number;
}

/**
 * Listens for "Hey Oly": VAD-gated short segments, transcribed one at a time and fuzzy-matched. A segment that ends
 * while a request is out waits (only the newest waiting one is kept). If a segment doesn't match and a short segment
 * just before it might be its "hey", the two are checked together. Keeps only the last few seconds of audio.
 */
export class WakeDetector {
  private vad = new EnergyVad();
  /** Recent audio as chunks with their absolute start sample. */
  private buf: { at: number; x: Float32Array }[] = [];
  /** Samples pushed so far / samples the VAD has classified. */
  private total = 0;
  private vadPos = 0;
  private inSpeech = false;
  private segFrom = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private segMs = 0;
  /** The previous segment (transcribed or too short), for joining a lone "hey". */
  private prev: WakeSeg | null = null;
  private busy = false;
  private waiting: { seg: WakeSeg; prev: WakeSeg | null } | null = null;
  private closed = false;
  private readonly deps: WakeDeps;

  constructor(deps: WakeDeps) {
    this.deps = deps;
  }

  close() {
    this.closed = true;
    this.buf = [];
    this.waiting = null;
  }

  push(samples: Float32Array) {
    if (this.closed) return;
    this.buf.push({ at: this.total, x: samples });
    this.total += samples.length;
    for (const f of this.vad.push(samples)) {
      this.vadPos += FRAME;
      if (f.speech) {
        if (!this.inSpeech) {
          this.inSpeech = true;
          this.segFrom = Math.max(0, this.vadPos - FRAME - ms2s(WAKE_PREROLL_MS));
        }
        this.speechMs += VAD_FRAME_MS;
        this.silenceMs = 0;
      } else if (this.inSpeech) this.silenceMs += VAD_FRAME_MS;
      if (this.inSpeech) this.segMs += VAD_FRAME_MS;
      if (this.inSpeech && (this.silenceMs >= WAKE_END_GAP_MS || this.segMs >= WAKE_MAX_SEGMENT_MS)) this.endSegment();
    }
    // Keep enough audio for the longest segment plus a joined "hey" before it.
    const keep = ms2s(WAKE_MAX_SEGMENT_MS + WAKE_JOIN_GAP_MS + WAKE_JOIN_SHORT_MS + WAKE_PREROLL_MS + 500);
    while (this.buf.length > 1 && this.buf[1].at <= this.total - keep) this.buf.shift();
  }

  private endSegment() {
    const seg: WakeSeg = { from: this.segFrom, to: this.vadPos, speechMs: this.speechMs };
    this.inSpeech = false;
    this.speechMs = this.silenceMs = this.segMs = 0;
    const prev = this.prev;
    this.prev = seg;
    if (seg.speechMs < WAKE_MIN_SPEECH_MS) return; // a click, or a lone short "hey": kept as `prev` only
    if (this.busy) {
      this.waiting = { seg, prev };
      return;
    }
    void this.check(seg, prev);
  }

  private joinable(seg: WakeSeg, prev: WakeSeg | null): prev is WakeSeg {
    return Boolean(prev && prev.speechMs >= WAKE_JOIN_MIN_MS && prev.speechMs <= WAKE_JOIN_SHORT_MS && seg.from - prev.to <= ms2s(WAKE_JOIN_GAP_MS) && prev.from >= this.buf[0]?.at);
  }

  private async check(seg: WakeSeg, prev: WakeSeg | null) {
    this.busy = true;
    try {
      let m = await this.match(seg.from, seg.to, seg.speechMs);
      // No wake: maybe a pause split "hey … oly" — try it with the short segment just before.
      if (!m.matched && !this.closed && this.joinable(seg, prev)) m = await this.match(prev.from, seg.to, seg.speechMs + prev.speechMs);
      if (this.closed) return;
      if (m.matched) {
        this.waiting = null;
        this.deps.onWake(m.rest);
        return;
      }
    } catch (e) {
      this.deps.onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
    const next = this.waiting;
    this.waiting = null;
    if (next && !this.closed) void this.check(next.seg, next.prev);
  }

  private async match(from: number, to: number, speechMs: number) {
    const text = await this.deps.transcribe(encodeWav(this.audio(from, to), LIVE_RATE));
    return matchWake(cleanTranscript(text, speechMs));
  }

  private audio(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    for (const c of this.buf) {
      const a = Math.max(from, c.at);
      const b = Math.min(to, c.at + c.x.length);
      if (b > a) out.set(c.x.subarray(a - c.at, b - c.at), a - from);
    }
    return out;
  }
}
