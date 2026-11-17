// Unit tests for voice input (Settings → Voice): whisper.cpp binary + model detection against fake folders, WAV
// encoding/resampling, engine selection and whisper server → cli fallback, mic mode, the prompt builder, OpenRouter and
// OpenAI-compatible request shapes against a local MOCK HTTP server (no real API is called), the default for a settings
// file saved before voice existed, vocabulary extraction, and the microphone permission rule.
// Run: node tests/voice.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` is stubbed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-voice-unit-'));
const UD = join(TMP, 'userData');
const SHARED = join(TMP, 'shared');
for (const d of [UD, SHARED]) mkdirSync(d, { recursive: true });
delete process.env.OLYMPUS_HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
// A settings file saved before voice existed, by someone whose profile says they speak Hinglish.
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2, profile: { languages: 'Hinglish, English' } }));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) {
        try {
          return next(`${spec}.ts`, ctx);
        } catch {
          return next(`${spec}/index.ts`, ctx);
        }
      }
      throw e;
    }
  },
  load(url, ctx, next) {
    // MOCK of the few electron APIs these modules touch (not the real app).
    if (url === 'mock:electron')
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.1.0', on() {} };
export const safeStorage = { isEncryptionAvailable: () => false };
export const shell = {}; export const dialog = {}; export const BrowserWindow = { fromWebContents: () => null };
export const systemPreferences = {}; export const session = {};`,
      };
    return next(url, ctx);
  },
});

const D = await import(`${APP}/src/main/voice/detect.ts`);
const W = await import(`${APP}/src/shared/wav.ts`);
const V = await import(`${APP}/src/shared/voice.ts`);
const E = await import(`${APP}/src/main/voice/engines.ts`);
const H = await import(`${APP}/src/main/voice/httpEngines.ts`);
const WL = await import(`${APP}/src/main/voice/whisperLocal.ts`);
const VOC = await import(`${APP}/src/main/voice/vocab.ts`);
const P = await import(`${APP}/src/main/permissions.ts`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/** A sparse file of `mb` megabytes (no real disk use). */
function fakeFile(path, mb) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, Math.round(mb * 1024 * 1024));
}

// ---------- detection ----------
const HOME = join(TMP, 'home');
const BIN = join(TMP, 'bin');
fakeFile(join(HOME, '.cache', 'whisper-cpp', 'ggml-medium.bin'), 20);
fakeFile(join(HOME, '.cache', 'whisper-cpp', 'ggml-large-v3.bin'), 30);
fakeFile(join(HOME, '.cache', 'whisper-cpp', 'ggml-tiny.bin'), 1); // too small: a test model
fakeFile(join(HOME, '.cache', 'whisper-cpp', 'for-tests-ggml-base.bin'), 20);
fakeFile(join(HOME, '.cache', 'whisper-cpp', 'ggml-silero-v5.1.2.bin'), 20); // VAD, not speech
fakeFile(join(HOME, '.cache', 'whisper-cpp', 'notes.txt'), 20);
fakeFile(join(HOME, '.cache', 'hyperframes', 'whisper', 'models', 'ggml-small.en.bin'), 15);
fakeFile(join(HOME, 'Library', 'Application Support', 'MacWhisper', 'models', 'ggml-large-v3-turbo.bin'), 25);
fakeFile(join(HOME, 'elsewhere', 'my-model.bin'), 2);
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'whisper-server'), '#!/bin/sh\n');
chmodSync(join(BIN, 'whisper-server'), 0o755);
const ctx = { home: HOME, platform: 'darwin', pathEnv: `${join(TMP, 'nope')}:${BIN}` };

await test('detect: finds whisper-server on PATH, cli via PATH or fixed dirs', () => {
  const w = D.detectWhisper({ ...ctx, home: HOME });
  assert.equal(w.server, join(BIN, 'whisper-server'));
  // whisper-cli may exist in /opt/homebrew/bin on the test machine; it must be a real path when found.
  if (w.cli) assert.match(w.cli, /whisper-cli$/);
});

await test('detect: Windows looks for .exe', () => {
  const winBin = join(TMP, 'winbin');
  mkdirSync(winBin, { recursive: true });
  writeFileSync(join(winBin, 'whisper-cli.exe'), '');
  assert.equal(D.findBinary('whisper-cli', { home: HOME, platform: 'win32', pathEnv: winBin }), join(winBin, 'whisper-cli.exe'));
  assert.equal(D.findBinary('whisper-server', { home: HOME, platform: 'win32', pathEnv: winBin }), undefined);
});

await test('detect: models from known dirs, filtered and ranked (large-v3 > turbo > medium > small.en)', () => {
  const models = D.detectModels(ctx);
  assert.deepEqual(
    models.map((m) => m.name),
    ['large-v3', 'large-v3-turbo', 'medium', 'small.en'],
  );
  assert.equal(models[0].bytes, 30 * 1024 * 1024);
  assert.ok(models.every((m) => m.source === 'detected'));
});

await test('detect: an added model file is listed even if small / oddly named', () => {
  const models = D.detectModels(ctx, [join(HOME, 'elsewhere', 'my-model.bin'), join(HOME, 'missing.bin')]);
  const added = models.find((m) => m.source === 'added');
  assert.equal(added?.path, join(HOME, 'elsewhere', 'my-model.bin'));
  assert.equal(models.filter((m) => m.source === 'added').length, 1);
});

await test('detect: an empty home finds nothing', () => {
  const empty = join(TMP, 'empty-home');
  mkdirSync(empty);
  assert.deepEqual(D.detectModels({ home: empty, platform: 'linux', pathEnv: '' }), []);
});

// ---------- WAV ----------
await test('wav: header and samples of 16 kHz mono 16-bit PCM', () => {
  const s = new Float32Array([0, 1, -1, 0.5, 2, -2]);
  const b = W.encodeWav(s, 16000);
  assert.equal(b.length, 44 + 12);
  const h = W.readWavHeader(b);
  assert.deepEqual(h, { channels: 1, rate: 16000, bits: 16, dataBytes: 12 });
  const v = new DataView(b.buffer);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 16383, 32767, -32768]);
  assert.equal(String.fromCharCode(...b.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 12);
});

await test('wav: resample 48 kHz → 16 kHz keeps duration; mono mix averages', () => {
  const one = new Float32Array(48000).fill(0.5);
  const r = W.resample(one, 48000, 16000);
  assert.equal(r.length, 16000);
  assert.ok(Math.abs(r[100] - 0.5) < 1e-6);
  const up = W.resample(new Float32Array(8000), 8000, 16000);
  assert.equal(up.length, 16000);
  const m = W.mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual([...m], [0.5, 0.5]);
  assert.equal(W.wavSeconds(W.encodeWav(r)), 1);
  assert.equal(W.readWavHeader(new Uint8Array(10)), null);
});

// ---------- prompt, language, mic mode ----------
await test('prompt: Hinglish preset → en + romanized hint + vocab, capped', () => {
  assert.equal(V.engineLanguage('hinglish'), 'en');
  assert.equal(V.engineLanguage('auto'), undefined);
  assert.equal(V.engineLanguage('hi'), 'hi');
  const p = V.buildVoicePrompt('hinglish', ['ChatComposer', 'useAppSync', 'ChatComposer']);
  assert.ok(p.startsWith(V.HINGLISH_PROMPT));
  assert.ok(p.endsWith('ChatComposer, useAppSync.'));
  assert.equal(V.buildVoicePrompt('auto', []), '');
  const long = V.buildVoicePrompt('hinglish', Array.from({ length: 200 }, (_, i) => `identifierNumber${i}`));
  assert.ok(long.length <= V.MAX_PROMPT_CHARS, `prompt ${long.length} chars`);
});

await test('mic mode: system / record / hidden', () => {
  assert.equal(V.micModeFor('system', true, true), 'system');
  assert.equal(V.micModeFor('whisper-local', true, true), 'record');
  assert.equal(V.micModeFor('whisper-local', true, false), 'record'); // Linux with an engine
  assert.equal(V.micModeFor('system', true, false), 'none'); // Linux without one
  assert.equal(V.micModeFor('openrouter', false, false), 'none'); // phone page: no bridge
  assert.equal(V.micModeFor(undefined, true, true), 'system');
});

// ---------- engine selection and fallback ----------
const WAV = W.encodeWav(new Float32Array(1600));
const models = [
  { path: '/m/large.bin', name: 'large-v3', bytes: 1, source: 'detected' },
  { path: '/m/medium.bin', name: 'medium', bytes: 1, source: 'detected' },
];
const base = { ...V.DEFAULT_VOICE, language: 'hinglish' };

await test('engines: whisper-local uses the server with model, en and prompt', async () => {
  const calls = [];
  const r = await E.runTranscription(WAV, { ...base, engine: 'whisper-local' }, ['ChatComposer'], {
    whisper: () => ({ server: '/b/whisper-server', cli: '/b/whisper-cli', models }),
    key: () => undefined,
    serverRun: async (bin, o) => (calls.push({ bin, ...o }), 'namaste duniya'),
    cliRun: async () => assert.fail('cli must not run'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'namaste duniya');
  assert.equal(r.model, 'large.bin');
  assert.equal(calls[0].bin, '/b/whisper-server');
  assert.equal(calls[0].model, '/m/large.bin');
  assert.equal(calls[0].language, 'en');
  assert.ok(calls[0].prompt.includes('ChatComposer'));
});

await test('engines: server failure falls back to whisper-cli; chosen model kept', async () => {
  const r = await E.runTranscription(WAV, { ...base, engine: 'whisper-local', whisperModel: '/m/medium.bin' }, [], {
    whisper: () => ({ server: '/b/s', cli: '/b/c', models }),
    key: () => undefined,
    serverRun: async () => {
      throw new Error('port busy');
    },
    cliRun: async (bin, o) => `cli ${bin} ${o.model}`,
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'cli /b/c /m/medium.bin');
});

await test('engines: both whisper methods fail → error with both reasons', async () => {
  const r = await E.runTranscription(WAV, { ...base, engine: 'whisper-local' }, [], {
    whisper: () => ({ server: '/b/s', cli: '/b/c', models }),
    key: () => undefined,
    serverRun: async () => {
      throw new Error('A');
    },
    cliRun: async () => {
      throw new Error('B');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /server: A.*cli: B/);
});

await test('engines: missing binary / model / key / system → clear errors, no other engine used', async () => {
  const deps = { whisper: () => ({ models: [] }), key: () => undefined };
  assert.match((await E.runTranscription(WAV, { ...base, engine: 'whisper-local' }, [], deps)).error, /not installed/);
  assert.match((await E.runTranscription(WAV, { ...base, engine: 'whisper-local' }, [], { ...deps, whisper: () => ({ cli: '/c', models: [] }) })).error, /No whisper model/);
  assert.match((await E.runTranscription(WAV, { ...base, engine: 'openrouter' }, [], deps)).error, /No OpenRouter API key/);
  assert.match((await E.runTranscription(WAV, { ...base, engine: 'system' }, [], deps)).error, /does not transcribe/);
});

await test('engines: a stale chosen model falls back to the best detected one', () => {
  assert.equal(E.pickWhisperModel({ ...base, whisperModel: '/gone/model.bin' }, models), '/m/large.bin');
  assert.equal(E.pickWhisperModel({ ...base }, []), undefined);
});

await test('engines: statuses (found / not found / needs key / needs setup)', () => {
  const st = E.engineStatuses({ ...base }, { server: '/b/whisper-server', models }, { openrouter: false, custom: false }, 'darwin');
  assert.deepEqual(
    st.map((s) => [s.id, s.state]),
    [
      ['system', 'ready'],
      ['whisper-local', 'ready'],
      ['openrouter', 'needs-key'],
      ['openai-compatible', 'needs-setup'],
    ],
  );
  const linux = E.engineStatuses({ ...base }, { models: [] }, { openrouter: true, custom: false }, 'linux');
  assert.equal(linux[0].state, 'unsupported');
  assert.equal(linux[1].state, 'not-found');
  assert.equal(linux[2].state, 'needs-setup');
});

await test('whisper plan: server first, then cli', () => {
  assert.deepEqual(WL.whisperPlan({ server: 's', cli: 'c' }).map((p) => p.method), ['server', 'cli']);
  assert.deepEqual(WL.whisperPlan({ cli: 'c' }).map((p) => p.method), ['cli']);
  assert.deepEqual(WL.whisperPlan({}), []);
});

await test('whisper server: concurrent starts share one process; stop kills it; transcribe sends language + prompt', async () => {
  // A FAKE whisper-server (Node script) that logs its start and echoes the form fields it got.
  const fake = join(TMP, 'fake-whisper-server');
  const startLog = join(TMP, 'fake-starts.log');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const http = require('node:http');
const a = process.argv; const port = Number(a[a.indexOf('--port') + 1]);
appendFileSync(${JSON.stringify(startLog)}, process.pid + '\\n');
setTimeout(() => http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c.toString('latin1'))); req.on('end', () => {
    if (req.url !== '/inference') return res.end('ok');
    const f = (n) => (b.match(new RegExp('name="' + n + '"\\r\\n\\r\\n([^\\r]*)')) || [])[1];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: ' lang=' + f('language') + ' prompt=' + f('prompt') + ' ' }));
  });
}).listen(port, '127.0.0.1'), 300);
`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(startLog, '');
  const [p1, p2] = await Promise.all([WL.ensureServer(fake, '/m/a.bin'), WL.ensureServer(fake, '/m/a.bin')]);
  assert.equal(p1, p2);
  const starts = () => readFileSync(startLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(starts().length, 1, 'one process for two concurrent callers');
  assert.equal(WL.whisperServerRunning(), true);
  const text = await WL.transcribeWithServer(fake, { wav: WAV, model: '/m/a.bin', language: 'en', prompt: 'ChatComposer.' });
  assert.equal(text, 'lang=en prompt=ChatComposer.');
  assert.equal(starts().length, 1, 'reused');
  const pid = Number(starts()[0]);
  WL.stopWhisperServer();
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), 'the server process is gone after stop');
  assert.equal(WL.whisperServerRunning(), false);
});

// ---------- HTTP engines against a MOCK server ----------
const seen = [];
let orReject400 = false;
const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/or/models')) return res.end(JSON.stringify({ data: [{ id: 'openai/whisper-large-v3', name: 'Whisper Large V3' }, { id: 'x/y' }] }));
    if (req.url === '/or/audio/transcriptions') {
      const j = JSON.parse(body.toString());
      if (orReject400 && j.provider) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'unknown provider option' } }));
      }
      if (req.headers.authorization !== 'Bearer sk-or-test') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      return res.end(JSON.stringify({ text: ' mock openrouter text ', usage: { seconds: 1 } }));
    }
    if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: 'mock compatible text' }));
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const PORT = mock.address().port;
process.env.OLYMPUS_OPENROUTER_BASE = `http://127.0.0.1:${PORT}/or`;

await test('openrouter: JSON body with base64 wav, model, language, provider prompt; bearer key', async () => {
  seen.length = 0;
  const text = await H.openrouterTranscribe({ wav: WAV, model: 'openai/whisper-large-v3', apiKey: 'sk-or-test', language: 'en', prompt: 'ChatComposer.' });
  assert.equal(text, 'mock openrouter text');
  const req = seen[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.equal(req.headers.authorization, 'Bearer sk-or-test');
  const j = JSON.parse(req.body.toString());
  assert.equal(j.model, 'openai/whisper-large-v3');
  assert.equal(j.input_audio.format, 'wav');
  assert.deepEqual(Buffer.from(j.input_audio.data, 'base64'), Buffer.from(WAV));
  assert.equal(j.language, 'en');
  assert.equal(j.temperature, 0);
  assert.equal(j.provider.options.openai.prompt, 'ChatComposer.');
  assert.equal(j.prompt, undefined);
});

await test('openrouter: a 400 on the prompt option retries once without it; errors carry the message', async () => {
  seen.length = 0;
  orReject400 = true;
  const text = await H.openrouterTranscribe({ wav: WAV, model: 'm', apiKey: 'sk-or-test', prompt: 'p' });
  orReject400 = false;
  assert.equal(text, 'mock openrouter text');
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[1].body.toString()).provider, undefined);
  await assert.rejects(H.openrouterTranscribe({ wav: WAV, model: 'm', apiKey: 'wrong' }), /HTTP 401: bad key/);
});

await test('openrouter: model list from the transcription models endpoint', async () => {
  seen.length = 0;
  const list = await H.openrouterModels();
  assert.equal(seen[0].url, '/or/models?output_modalities=transcription');
  assert.deepEqual(list, [
    { id: 'openai/whisper-large-v3', name: 'Whisper Large V3' },
    { id: 'x/y', name: 'x/y' },
  ]);
});

await test('openai-compatible: multipart file + model + language + prompt, optional key, base URL normalized', async () => {
  seen.length = 0;
  const text = await H.openaiCompatibleTranscribe({ wav: WAV, model: 'whisper-large-v3', baseUrl: `http://127.0.0.1:${PORT}/`, language: 'en', prompt: 'useAppSync.' });
  assert.equal(text, 'mock compatible text');
  const req = seen[0];
  assert.equal(req.url, '/v1/audio/transcriptions');
  assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(req.headers.authorization, undefined);
  const body = req.body.toString('latin1');
  assert.match(body, /name="file"; filename="audio.wav"\r\nContent-Type: audio\/wav/);
  assert.match(body, /name="model"\r\n\r\nwhisper-large-v3\r\n/);
  assert.match(body, /name="language"\r\n\r\nen\r\n/);
  assert.match(body, /name="prompt"\r\n\r\nuseAppSync.\r\n/);
  assert.ok(req.body.includes(Buffer.from(WAV)), 'the wav bytes are in the upload');
  seen.length = 0;
  await H.openaiCompatibleTranscribe({ wav: WAV, model: 'm', baseUrl: `http://127.0.0.1:${PORT}/v1/audio/transcriptions`, apiKey: 'gsk-test' });
  assert.equal(seen[0].url, '/v1/audio/transcriptions');
  assert.equal(seen[0].headers.authorization, 'Bearer gsk-test');
  assert.equal(H.normalizeBaseUrl('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1');
  assert.equal(H.normalizeBaseUrl('http://localhost:8000'), 'http://localhost:8000/v1');
});

await test('engines: openrouter + custom go through runTranscription with key and settings', async () => {
  seen.length = 0;
  const r = await E.runTranscription(WAV, { ...base, engine: 'openrouter', openrouterModel: 'openai/whisper-large-v3' }, ['ChatComposer'], {
    whisper: () => ({ models: [] }),
    key: (which) => (which === 'openrouter' ? 'sk-or-test' : undefined),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'mock openrouter text');
  const r2 = await E.runTranscription(WAV, { ...base, engine: 'openai-compatible', customBaseUrl: `http://127.0.0.1:${PORT}`, customModel: 'w' }, [], {
    whisper: () => ({ models: [] }),
    key: () => undefined,
  });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.text, 'mock compatible text');
});

// ---------- defaults for an old settings file ----------
await test('settings: an old settings file keeps the system engine; Hinglish profile → Hinglish language', async () => {
  const VI = await import(`${APP}/src/main/voice/index.ts`);
  const s = VI.voiceSettings();
  assert.equal(s.engine, 'system');
  assert.equal(s.language, 'hinglish');
  assert.deepEqual(V.normalizeVoice(undefined), { engine: 'system', language: 'auto' });
  assert.equal(V.normalizeVoice({ engine: 'bogus' }).engine, 'system');
  assert.equal(V.defaultVoiceLanguage('English'), 'auto');
  // Saving keeps the choice and other fields.
  const st = VI.saveVoice({ engine: 'openai-compatible', customBaseUrl: 'http://localhost:9', customModel: 'm' });
  assert.equal(st.settings.engine, 'openai-compatible');
  assert.equal(VI.voiceSettings().language, 'hinglish');
});

// ---------- vocabulary ----------
await test('vocab: code-like identifiers ranked by count; file stems', () => {
  const ids = VOC.extractIdentifiers(['Fix ChatComposer and useAppSync in ChatComposer.tsx', 'the snake_case_name and package.json, ChatComposer again', 'plain words only']);
  assert.equal(ids[0], 'ChatComposer');
  assert.ok(ids.includes('useAppSync') && ids.includes('snake_case_name') && ids.includes('package.json') && ids.includes('ChatComposer.tsx'));
  assert.ok(!ids.includes('plain'));
  const stems = VOC.fileStems(['src/a/index.ts', 'src/ChatComposer.tsx', 'src/voice-input.ts', 'README.md', 'src/x.ts'], 8, ['voice-input']);
  assert.deepEqual(stems, ['voice-input', 'ChatComposer']);
});

// ---------- microphone permission rule ----------
await test('permissions: media only for the app window, main frame, app URL, audio only', () => {
  const isApp = P.makeIsAppUrl('/Applications/X.app/Contents/Resources/app/out/renderer', 'http://localhost:5173/');
  const ok = { wcType: 'window', isAppWindow: true, isMainFrame: true, url: 'file:///Applications/X.app/Contents/Resources/app/out/renderer/index.html', mediaTypes: ['audio'] };
  assert.equal(P.allowMedia(ok, isApp), true);
  assert.equal(P.allowMedia({ ...ok, url: 'http://localhost:5173/index.html' }, isApp), true); // dev server
  assert.equal(P.allowMedia({ ...ok, wcType: 'webview' }, isApp), false); // Web tab preview
  assert.equal(P.allowMedia({ ...ok, isAppWindow: false }, isApp), false);
  assert.equal(P.allowMedia({ ...ok, isMainFrame: false }, isApp), false);
  assert.equal(P.allowMedia({ ...ok, mediaTypes: ['audio', 'video'] }, isApp), false); // no camera
  assert.equal(P.allowMedia({ ...ok, mediaTypes: [] }, isApp), false);
  assert.equal(P.allowMedia({ ...ok, url: 'http://localhost:3000/' }, isApp), false); // a dev server preview origin
  assert.equal(P.allowMedia({ ...ok, url: 'file:///Users/x/evil.html' }, isApp), false);
  assert.equal(P.allowMedia({ ...ok, url: 'file:///Applications/X.app/Contents/Resources/app/out/renderer-evil/a.html' }, isApp), false);
  assert.equal(P.allowMedia({ ...ok, url: 'https://example.com/' }, isApp), false);
  // Without a dev URL only the bundled folder counts.
  assert.equal(P.allowMedia({ ...ok, url: 'http://localhost:5173/' }, P.makeIsAppUrl('/r')), false);
});

mock.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
