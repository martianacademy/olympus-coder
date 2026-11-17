/**
 * Transcription over HTTP:
 * - OpenRouter: `POST {base}/audio/transcriptions`, JSON with base64 audio (docs: openrouter.ai/docs/guides/overview/multimodal/stt).
 *   There is no top-level prompt; vocabulary hints go per provider under `provider.options.<slug>.prompt`.
 * - OpenAI-compatible: `POST {base}/audio/transcriptions`, multipart `file` + `model` (OpenAI, Groq, speaches,
 *   faster-whisper-server…).
 * `fetchImpl` is injectable so unit tests can point at a local mock server.
 */

type FetchLike = typeof fetch;

export const OPENROUTER_BASE = () => (process.env.OLYMPUS_OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const TIMEOUT_MS = 120_000;

async function errorOf(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail ?? body;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch {
    /* plain text */
  }
  return `HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 300)}` : ''}`;
}

export interface HttpTranscribeOpts {
  wav: Uint8Array;
  model: string;
  apiKey?: string;
  language?: string;
  prompt?: string;
  fetchImpl?: FetchLike;
}

export function openrouterBody(o: Omit<HttpTranscribeOpts, 'fetchImpl' | 'apiKey'>, withPrompt = true): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: o.model,
    input_audio: { data: Buffer.from(o.wav).toString('base64'), format: 'wav' },
    temperature: 0,
  };
  if (o.language) body.language = o.language;
  if (withPrompt && o.prompt) body.provider = { options: { openai: { prompt: o.prompt }, groq: { prompt: o.prompt } } };
  return body;
}

export async function openrouterTranscribe(o: HttpTranscribeOpts): Promise<string> {
  if (!o.apiKey) throw new Error('No OpenRouter API key.');
  if (!o.model) throw new Error('Pick an OpenRouter transcription model.');
  const f = o.fetchImpl ?? fetch;
  const send = (withPrompt: boolean) =>
    f(`${OPENROUTER_BASE()}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Olympus Coder' },
      body: JSON.stringify(openrouterBody(o, withPrompt)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let res = await send(true);
  // A provider that rejects the per-provider prompt option: try once more without it.
  if (res.status === 400 && o.prompt) res = await send(false);
  if (!res.ok) throw new Error(await errorOf(res));
  const j = (await res.json()) as { text?: string };
  if (typeof j.text !== 'string') throw new Error('OpenRouter returned no text.');
  return j.text.trim();
}

export async function openrouterModels(fetchImpl: FetchLike = fetch): Promise<{ id: string; name: string }[]> {
  const res = await fetchImpl(`${OPENROUTER_BASE()}/models?output_modalities=transcription`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(await errorOf(res));
  const j = (await res.json()) as { data?: { id: string; name?: string }[] };
  return (j.data ?? []).filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, name: m.name || m.id }));
}

/** "http://localhost:8000" → ".../v1"; "https://api.groq.com/openai/v1/" stays; a pasted ".../audio/transcriptions" is trimmed. */
export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '');
  u = u.replace(/\/audio\/transcriptions$/, '');
  if (!/\/v\d+$/.test(u)) u = `${u}/v1`;
  return u;
}

export async function openaiCompatibleTranscribe(o: HttpTranscribeOpts & { baseUrl: string }): Promise<string> {
  if (!o.baseUrl.trim()) throw new Error('Set the server URL.');
  if (!o.model) throw new Error('Set the model name.');
  const f = o.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(o.wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', o.model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (o.language) form.append('language', o.language);
  if (o.prompt) form.append('prompt', o.prompt);
  const res = await f(`${normalizeBaseUrl(o.baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await errorOf(res));
  const raw = await res.text();
  try {
    const j = JSON.parse(raw) as { text?: string };
    if (typeof j.text === 'string') return j.text.trim();
  } catch {
    /* some servers answer plain text */
  }
  return raw.trim();
}
