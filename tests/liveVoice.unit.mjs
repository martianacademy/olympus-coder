// Unit tests: live voice (src/shared/liveVoice.ts) — RMS VAD, the commit/interim/auto-stop segmenter, the LiveSession
// driver over a FAKE transcriber (no whisper), the "Hey Oly" and "over" matchers, transcript cleanup, the wake detector,
// and the live prompt context in src/shared/voice.ts. Synthetic audio: noise bursts = "speech", zeros = silence.
// Run: node tests/liveVoice.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const L = await import(`${APP}/src/shared/liveVoice.ts`);
const V = await import(`${APP}/src/shared/voice.ts`);
const W = await import(`${APP}/src/shared/wav.ts`);
const { EnergyVad, LiveSegmenter, LiveSession, WakeDetector, matchWake, matchEndPhrase, cleanTranscript } = L;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}\n`, e);
    process.exitCode = 1;
  }
}

const RATE = 16000;
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const speech = (ms, amp = 0.15) => Float32Array.from({ length: (ms * RATE) / 1000 }, () => rand() * amp);
const silence = (ms) => new Float32Array((ms * RATE) / 1000);
/** Feeds audio in ~85 ms chunks (what the recorder sends at 48 kHz / 4096). */
function* chunks(x, n = 1365) {
  for (let o = 0; o < x.length; o += n) yield x.subarray(o, Math.min(o + n, x.length));
}
const cat = (...xs) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const sec = (samples) => samples / RATE;

function feed(seg, audio) {
  const commits = [];
  let stop;
  for (const c of chunks(audio)) {
    const r = seg.push(c);
    commits.push(...r.commits);
    if (r.stop && !stop) stop = { reason: r.stop, at: seg.total };
  }
  return { commits, stop };
}

await test('VAD: noise bursts are speech, zeros are not', () => {
  const v = new EnergyVad();
  const a = v.push(speech(200));
  const b = v.push(silence(200));
  assert.equal(a.length, 10);
  assert.ok(a.every((f) => f.speech));
  assert.ok(b.every((f) => !f.speech));
});

await test('VAD: quiet room noise below VAD_MIN_RMS is never speech', () => {
  const v = new EnergyVad();
  const f = v.push(speech(1000, 0.008)); // rms ≈ 0.0046
  assert.ok(f.every((x) => !x.speech));
});

await test('VAD: a steady loud hum stops counting as speech once the floor adapts', () => {
  const v = new EnergyVad();
  const f = v.push(speech(20_000, 0.04));
  assert.ok(f.slice(0, 5).every((x) => x.speech), 'starts as speech');
  assert.ok(f.slice(-50).every((x) => !x.speech), 'steady noise is not speech after the floor adapts');
});

await test('segmenter: 1.5 s phrase + 100 ms gap → one commit right at the gap', () => {
  const s = new LiveSegmenter();
  const { commits } = feed(s, cat(speech(1500), silence(200)));
  assert.equal(commits.length, 1);
  const c = commits[0];
  assert.equal(c.from, 0);
  assert.ok(sec(c.to) >= 1.6 && sec(c.to) <= 1.7, `commit at ${sec(c.to)} s`);
  assert.ok(c.speechMs >= 1400 && c.speechMs <= 1520, `speech ${c.speechMs}`);
});

await test('segmenter: short word + 100 ms gap waits; a 600 ms gap commits it', () => {
  const s = new LiveSegmenter();
  let r = feed(s, cat(speech(400), silence(300)));
  assert.equal(r.commits.length, 0, 'not committed after 300 ms of silence');
  r = feed(s, silence(400));
  assert.equal(r.commits.length, 1);
  assert.ok(Math.abs(sec(r.commits[0].to) - 1.0) < 0.1, `at ${sec(r.commits[0].to)}`);
});

await test('segmenter: brief intra-word dips (60 ms) never commit', () => {
  const s = new LiveSegmenter();
  const parts = [];
  for (let i = 0; i < 20; i++) parts.push(speech(200), silence(60));
  const { commits } = feed(s, cat(...parts));
  assert.equal(commits.length, 0);
});

await test('segmenter: commitGapMs option (150 ms) is respected', () => {
  const s = new LiveSegmenter({ commitGapMs: 150 });
  let r = feed(s, cat(speech(1500), silence(120)));
  assert.equal(r.commits.length, 0);
  r = feed(s, silence(100));
  assert.equal(r.commits.length, 1);
});

await test('segmenter: 14 s nonstop speech is cut at the quietest point inside the 10 s window', () => {
  const s = new LiveSegmenter();
  // A soft dip (still speech-ish, quieter) at 7.0–7.1 s.
  const audio = cat(speech(7000), speech(100, 0.03), speech(6900));
  const { commits } = feed(s, audio);
  assert.equal(commits.length, 1);
  const cut = sec(commits[0].to);
  assert.ok(cut > 6.95 && cut < 7.15, `cut at ${cut}`);
  assert.ok(sec(s.total - s.from) < 10, 'uncommitted stays inside the window');
});

await test('segmenter: interim every 700 ms of audio, only with speech, covering the uncommitted span', () => {
  const s = new LiveSegmenter();
  feed(s, silence(800));
  assert.equal(s.interim(), null, 'no speech, no interim');
  feed(s, speech(800));
  const i1 = s.interim();
  assert.ok(i1 && i1.to === s.total && i1.speechMs > 0);
  assert.equal(s.interim(), null, 'not again before 700 ms');
  feed(s, speech(700));
  assert.ok(s.interim());
});

await test('segmenter: leading silence is dropped (keeps 300 ms lead-in)', () => {
  const s = new LiveSegmenter();
  feed(s, silence(3000));
  assert.ok(sec(s.total - s.from) <= 1.05, `pending ${sec(s.total - s.from)}`);
});

await test('segmenter: auto-stop after 5 s with no speech (also from the start)', () => {
  const a = new LiveSegmenter();
  const r1 = feed(a, silence(6000));
  assert.equal(r1.stop?.reason, 'silence');
  assert.ok(Math.abs(sec(r1.stop.at) - 5) < 0.1, `stopped at ${sec(r1.stop.at)}`);
  const b = new LiveSegmenter();
  const r2 = feed(b, cat(speech(2000), silence(4500)));
  assert.equal(r2.stop, undefined, 'not at 4.5 s of silence');
  const r3 = feed(b, silence(700));
  assert.equal(r3.stop?.reason, 'silence');
});

await test('segmenter: maxSeconds stops', () => {
  const s = new LiveSegmenter({ maxSeconds: 3 });
  const parts = [];
  for (let i = 0; i < 10; i++) parts.push(speech(400), silence(50));
  const r = feed(s, cat(...parts));
  assert.equal(r.stop?.reason, 'max');
});

await test('segmenter: finish() returns the tail only when it holds speech; audio() is exact', () => {
  const s = new LiveSegmenter();
  const a = speech(500);
  feed(s, a);
  const f = s.finish();
  assert.ok(f && f.from === 0 && f.to === a.length);
  assert.deepEqual(s.audio(f.from, f.to), a);
  assert.equal(s.finish(), null);
  const q = new LiveSegmenter();
  feed(q, silence(500));
  assert.equal(q.finish(), null);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) {
  for (let i = 0; i < n; i++) await tick();
}

/** A fake engine that answers by clip length (interim refreshes and commits interleave by timing). */
const bySeconds = (rules, fallback = '') => (secs) => rules.find(([lo, hi]) => secs >= lo && secs <= hi)?.[2] ?? fallback;

function fakeSession(script, opts) {
  const calls = [];
  const ev = { interim: [], commits: [], wantStop: [], end: [], errors: [] };
  let session;
  session = new LiveSession(
    {
      transcribe: async (wav, context) => {
        calls.push({ seconds: W.wavSeconds(wav), context });
        await tick();
        const next = script.shift();
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(W.wavSeconds(wav)) : (next ?? '');
      },
      onInterim: (t) => ev.interim.push(t),
      onCommit: (t) => ev.commits.push(t),
      onWantStop: (r) => {
        ev.wantStop.push(r);
        session.stop(r);
      },
      onEnd: (r) => ev.end.push(r),
      onError: (m) => ev.errors.push(m),
    },
    opts,
  );
  return { session, calls, ev };
}

await test('session: interim while speaking, commit at the gap, stop → final commit → end', async () => {
  const answer = bySeconds([[0, 0.9, 'yeh code'], [1.3, 1.5, 'yeh code check'], [1.55, 1.7, 'yeh code check karo']], 'phir build');
  const { session, calls, ev } = fakeSession(Array(20).fill(answer));
  for (const c of chunks(speech(800))) session.push(c);
  await settle();
  assert.deepEqual(ev.interim, ['yeh code']);
  for (const c of chunks(cat(speech(700), silence(200)))) session.push(c);
  await settle();
  assert.deepEqual(ev.commits, ['yeh code check karo']);
  assert.equal(ev.interim.at(-1), '', 'interim cleared after the commit');
  for (const c of chunks(speech(1000))) session.push(c);
  session.stop('manual');
  await settle();
  assert.deepEqual(ev.commits, ['yeh code check karo', 'phir build']);
  assert.deepEqual(ev.end, ['manual']);
  assert.equal(calls.at(-1).context, 'yeh code check karo', 'committed text goes back as context');
  assert.ok(calls.every((c) => c.seconds <= 10.01));
});

await test('session: saying "over" commits the words before it and stops; later audio is dropped', async () => {
  const { session, ev } = fakeSession(Array(20).fill(bySeconds([[1.55, 1.7, 'bas itna hi, over.']], 'said after over')));
  for (const c of chunks(cat(speech(1500), silence(200)))) session.push(c);
  for (const c of chunks(cat(speech(1500), silence(700)))) session.push(c);
  await settle();
  assert.deepEqual(ev.commits, ['bas itna hi']);
  assert.deepEqual(ev.wantStop, ['over']);
  assert.deepEqual(ev.end, ['over']);
});

await test('session: 5 s silence asks to stop, then ends after draining', async () => {
  const { session, ev } = fakeSession(Array(20).fill(bySeconds([[1.55, 1.7, 'hello world']], 'hm')));
  for (const c of chunks(cat(speech(1500), silence(5200)))) session.push(c);
  await settle();
  assert.deepEqual(ev.commits, ['hello world']);
  assert.deepEqual(ev.wantStop, ['silence']);
  assert.deepEqual(ev.end, ['silence']);
});

await test('session: a stale interim (audio committed meanwhile) is not shown', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const script = [async () => (await gate, 'STALE'), 'final phrase'];
  const calls = [];
  const ev = { interim: [], commits: [] };
  const s = new LiveSession({
    transcribe: async (wav) => {
      calls.push(W.wavSeconds(wav));
      return script.shift()();
    },
    onInterim: (t) => ev.interim.push(t),
    onCommit: (t) => ev.commits.push(t),
    onWantStop: () => {},
    onEnd: () => {},
  });
  script[1] = ((t) => () => t)(script[1]);
  for (const c of chunks(speech(800))) s.push(c); // interim in flight (held)
  for (const c of chunks(cat(speech(800), silence(200)))) s.push(c); // commit queued meanwhile
  release();
  await settle();
  assert.ok(!ev.interim.includes('STALE'));
  assert.deepEqual(ev.commits, ['final phrase']);
});

await test('session: cancel drops queued work and never commits', async () => {
  const { session, ev } = fakeSession(['x', 'y']);
  for (const c of chunks(cat(speech(1500), silence(200)))) session.push(c);
  session.stop('cancel');
  await settle();
  assert.deepEqual(ev.commits, []);
  assert.deepEqual(ev.end, ['cancel']);
});

await test('session: an engine error is reported, the session still ends', async () => {
  const { session, ev } = fakeSession([new Error('whisper-server HTTP 500'), 'after the error']);
  for (const c of chunks(cat(speech(1500), silence(200)))) session.push(c);
  session.stop('manual');
  await settle();
  assert.deepEqual(ev.errors, ['whisper-server HTTP 500']);
  assert.deepEqual(ev.commits, ['after the error'], 'the queued commit still ran after a failed interim');
  assert.deepEqual(ev.end, ['manual']);
});

await test('session: [BLANK_AUDIO] and short-clip "Thank you." never reach the composer', async () => {
  const { session, ev } = fakeSession(['[BLANK_AUDIO]', 'Thank you.']);
  for (const c of chunks(cat(speech(300), silence(700)))) session.push(c);
  for (const c of chunks(cat(speech(300), silence(700)))) session.push(c);
  session.stop('manual');
  await settle();
  assert.deepEqual(ev.commits, []);
});

await test('matchWake: variants match, rest is what follows', () => {
  for (const t of [
    'Hey Oly', 'hey oli', 'Hey, Ollie!', 'Aey Oly.', 'Hey Olympus', 'hey olly', 'Hey Oley', 'Hi Oli', 'uh, hey Oly', 'HeyOly', 'A Oli', 'Hey Holy',
    // more spellings (asked 2026-11-17): hey/hi forms × oli/oliee/olye/… forms
    'Hey Oliee', 'Hey Olye', 'Hey Olie', 'Hey Olee', 'Hey Olli', 'Hey Olay', 'Hey Ooli', 'Hey Holly', 'Hey Holi', 'Hey Auli', 'Hey Awlee', 'Hey Oleigh',
    'Heyy Oli', 'Heyyy Oly', 'Hay Oly', 'Haye Oli', 'Hae Oly', 'Hii Oli', 'Hiya Oly', 'Hai Oli', 'Ae Oli', 'Ay Ollie', 'Aye Oly', 'Oye Oli', 'Hello Oly', 'Heya Oli',
    'Hey Oh Lee', 'Hey O Li', 'Hey, hey Oly', 'Hey hi Oli', 'HiOli', 'Heyollie', 'oyeoli', 'हे ओली', 'अरे ओली', 'Hey, Olly.', 'Oe olee, build chale o.', 'Hey Ali.', 'Hi ally',
    // accents and languages (asked 2026-11-17)
    'Hey Ohly', 'Hey Olí', 'Hëy Ólly', 'Hej Oli', 'Hoi Olly', 'Ehi Oli', 'Hola Oly', 'Olá Oli', 'Okay Oly', 'OK Oli', 'Okoli', 'Hallo Olli',
    'Hey Ouli', 'Hey Oaly', 'Hey Olei', 'Yo Oly', 'Ayy Oly', 'Arey Oli', 'Salut Oli', 'Merhaba Oli', 'Hey Ully',
    'হেই ওলি', 'ஹே ஒலி', 'హే ఓలీ', 'ಹೇ ಓಲಿ', 'હે ઓલી', 'ਹੇ ਓਲੀ', 'ഹേ ഒലി', 'ہے اولی', 'هاي أولي', 'Эй, Оли', 'Хей Олли', 'Привет, Оли',
    'Έι Όλι', 'เฮ้ โอลี่', '헤이 올리', '헤이올리', 'ヘイ、オリー', 'ヘイオリー', '嘿，奥利', '嘿欧力，打开文件',
    // real large-v3 outputs for accented "Hey Oly" (fr, es-MX, th, tr, ja voices)
    'Eoli, open the file.', 'Erioli, open the file.', 'Ejoli, open tfile.', 'heali.open the file', 'Hey ole yeh, file', 'Hey yori, open the file.',
  ]) {
    assert.equal(matchWake(t).matched, true, t);
  }
  assert.deepEqual(matchWake('Hey Oly, fix the build please.'), { matched: true, rest: 'fix the build please.' });
  assert.deepEqual(matchWake('Hey Ollie... yeh file kholo'), { matched: true, rest: 'yeh file kholo' });
  assert.deepEqual(matchWake('嘿欧力，打开文件'), { matched: true, rest: '打开文件' });
  assert.deepEqual(matchWake('Эй, Оли, открой файл'), { matched: true, rest: 'открой файл' });
});

await test('matchWake: near misses do not match', () => {
  for (const t of ['Oly', 'hello', 'Hey all', 'Holy cow', 'hey everyone, oly', 'I said hey oly to him yesterday', 'Hey Olive', 'oil', 'Hey hole', '', 'Ali', 'Hey oil', 'Hey old', 'Hola amigo', 'Okay', 'OK all good', '嘿，你好', 'オリー', '올리', 'Эй, привет', 'ஒலி', 'Hey Olga', 'Hey Holland', 'Hello, open the file.', 'Hey Rory', 'heal', 'eel', 'Erin', 'Hey Yo', 'hey you all', 'Eolian', 'Hey oil rig', 'Hello world', 'Oh, lee', 'Hey Oh', 'Ollie is here', 'Hey Owl']) {
    assert.equal(matchWake(t).matched, false, t);
  }
});

await test('matchEndPhrase: "over" / "over and out" at the end only', () => {
  assert.deepEqual(matchEndPhrase('bas itna hi, over.'), { ended: true, rest: 'bas itna hi' });
  assert.deepEqual(matchEndPhrase('Commit karo. Over and out!'), { ended: true, rest: 'Commit karo.' });
  assert.deepEqual(matchEndPhrase('Over.'), { ended: true, rest: '' });
  assert.deepEqual(matchEndPhrase('done over over'), { ended: true, rest: 'done' });
  assert.equal(matchEndPhrase('move it over here').ended, false);
  assert.equal(matchEndPhrase('overflow').ended, false);
  assert.equal(matchEndPhrase('takeover').ended, false);
  assert.equal(matchEndPhrase('').ended, false);
});

await test('cleanTranscript: tags out, stock silence phrases dropped only for short clips', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' (music) hello  [noise] world '), 'hello world');
  assert.equal(cleanTranscript('Thank you.', 600), '');
  assert.equal(cleanTranscript('Thank you.', 2000), 'Thank you.');
  assert.equal(cleanTranscript('...'), '');
  assert.equal(cleanTranscript('फ़ाइल खोलो'), 'फ़ाइल खोलो');
});

await test('WakeDetector: transcribes VAD segments, fires on "Hey Oly" with the rest; ignores clicks', async () => {
  const seen = [];
  const wakes = [];
  const replies = ['so the build is red', 'Hey Oly, open the file'];
  const d = new WakeDetector({
    transcribe: async (wav) => {
      seen.push(W.wavSeconds(wav));
      return replies.shift();
    },
    onWake: (rest) => wakes.push(rest),
  });
  for (const c of chunks(cat(silence(1000), speech(100), silence(600)))) d.push(c); // a click: too short
  await settle();
  assert.equal(seen.length, 0, 'click not transcribed');
  for (const c of chunks(cat(speech(1500), silence(500)))) d.push(c);
  await settle();
  assert.deepEqual(wakes, []);
  for (const c of chunks(cat(speech(900), silence(500)))) d.push(c);
  await settle();
  assert.deepEqual(wakes, ['open the file']);
  assert.equal(seen.length, 2);
  assert.ok(seen[1] > 0.9 && seen[1] < 1.6, `segment ${seen[1]} s (speech + pre-roll + end gap)`);
});

await test('WakeDetector: long speech is cut at 4 s; a segment ending while busy waits (newest only); close() stops it', async () => {
  let release;
  const seen = [];
  const d = new WakeDetector({
    transcribe: (wav) => {
      seen.push(W.wavSeconds(wav));
      return new Promise((r) => (release = () => r('nothing')));
    },
    onWake: () => assert.fail('no wake'),
  });
  for (const c of chunks(speech(4500))) d.push(c);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] <= 4.4, `cut at ${seen[0]}`);
  for (const c of chunks(cat(silence(500), speech(800), silence(500)))) d.push(c);
  for (const c of chunks(cat(speech(600), silence(500)))) d.push(c);
  assert.equal(seen.length, 1, 'not sent while busy');
  release();
  await settle();
  assert.equal(seen.length, 2, 'the newest waiting segment is checked after the request returns');
  assert.ok(seen[1] < 1.4, `newest (0.6 s speech) checked, got ${seen[1]} s`);
  release();
  await settle();
  d.close();
  for (const c of chunks(cat(speech(800), silence(500)))) d.push(c);
  assert.equal(seen.length, 2, 'closed');
});

await test('WakeDetector: "Hey … Oly" split by a pause is checked together; a click before a phrase is not joined', async () => {
  const seen = [];
  const wakes = [];
  // Whisper hears only "Olly." in the second part alone, the full phrase when the "hey" is included.
  const d = new WakeDetector({
    transcribe: async (wav) => {
      const secs = W.wavSeconds(wav);
      seen.push(secs);
      return secs > 1.6 ? 'Hey, Olly. Build chalao.' : 'Olly.';
    },
    onWake: (rest) => wakes.push(rest),
  });
  for (const c of chunks(cat(silence(500), speech(200), silence(600), speech(450), silence(500)))) d.push(c);
  await settle();
  assert.deepEqual(wakes, ['Build chalao.']);
  assert.equal(seen.length, 2, 'alone first, then joined');
  // A click (100 ms) before a non-wake phrase: no second, joined request.
  const seen2 = [];
  const d2 = new WakeDetector({ transcribe: async (wav) => (seen2.push(W.wavSeconds(wav)), 'so the build is red'), onWake: () => assert.fail('no wake') });
  for (const c of chunks(cat(silence(500), speech(100), silence(500), speech(900), silence(500)))) d2.push(c);
  await settle();
  assert.equal(seen2.length, 1);
  // A long phrase (not a lone "hey") before: not joined either.
  const seen3 = [];
  const d3 = new WakeDetector({ transcribe: async (wav) => (seen3.push(W.wavSeconds(wav)), 'Olly.'), onWake: () => assert.fail('no wake') });
  for (const c of chunks(cat(speech(1500), silence(500), speech(450), silence(500)))) d3.push(c);
  await settle(40);
  assert.equal(seen3.length, 2, 'each segment once, no join');
});

await test('voice.ts: live context goes last in the prompt, capped, vocab makes room', () => {
  const ctx = 'word '.repeat(100).trim();
  const p = V.buildVoicePrompt('hinglish', ['ChatComposer', 'liveVoice'], ctx);
  assert.ok(p.startsWith(V.HINGLISH_PROMPT));
  assert.ok(p.includes('ChatComposer, liveVoice.'));
  assert.ok(p.endsWith('word word'));
  assert.ok(p.length <= V.MAX_PROMPT_CHARS);
  const tail = p.slice(p.indexOf('liveVoice.') + 'liveVoice.'.length).trim();
  assert.ok(tail.length <= V.MAX_CONTEXT_CHARS && !tail.startsWith('ord'), 'cut at a word boundary');
  assert.equal(V.buildVoicePrompt('en', ['a']), 'a.', 'no context: unchanged');
  const many = Array.from({ length: 80 }, (_, i) => `identifier${i}`);
  assert.ok(V.buildVoicePrompt('hinglish', many, ctx).length <= V.MAX_PROMPT_CHARS);
});

await test('voice.ts: live mode + wake word are whisper-local only; live defaults on, wake off', () => {
  assert.equal(V.liveModeFor({ engine: 'whisper-local' }), true);
  assert.equal(V.liveModeFor({ engine: 'whisper-local', live: false }), false);
  assert.equal(V.liveModeFor({ engine: 'openrouter', live: true }), false);
  assert.equal(V.liveModeFor({ engine: 'openai-compatible' }), false);
  assert.equal(V.liveModeFor({ engine: 'system' }), false);
  assert.equal(V.liveModeFor(undefined), false);
  assert.equal(V.wakeWordFor({ engine: 'whisper-local' }), false);
  assert.equal(V.wakeWordFor({ engine: 'whisper-local', wakeWord: true }), true);
  assert.equal(V.wakeWordFor({ engine: 'openrouter', wakeWord: true }), false);
});

await test('earcons: own sounds — start = 3-note rising, stop = falling; short; quiet; sounds on by default for recording engines', async () => {
  const E = await import(`${APP}/src/shared/earcons.ts`);
  const up = E.EARCONS.start.map((n) => n.freq);
  const down = E.EARCONS.stop.map((n) => n.freq);
  assert.equal(up.length, 3, 'three notes (not a two-note bloop)');
  assert.ok(up[0] < up[1] && up[1] < up[2], 'start rises');
  assert.ok(down.length >= 2 && down.every((f, i) => i === 0 || f < down[i - 1]), 'stop falls');
  assert.notDeepEqual(up, down);
  assert.ok(E.earconMs('start') <= 300 && E.earconMs('stop') <= 300, `${E.earconMs('start')} / ${E.earconMs('stop')} ms`);
  assert.ok(E.EARCON_GAIN > 0 && E.EARCON_GAIN <= 0.2);
  assert.equal(V.micSoundsFor({ engine: 'whisper-local' }), true);
  assert.equal(V.micSoundsFor({ engine: 'openrouter' }), true);
  assert.equal(V.micSoundsFor({ engine: 'whisper-local', sounds: false }), false);
  assert.equal(V.micSoundsFor({ engine: 'system' }), false, 'OS dictation makes its own sound');
  assert.equal(V.micSoundsFor(undefined), false);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
