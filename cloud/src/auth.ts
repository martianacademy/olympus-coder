/**
 * Token hashing (`oly_live_...` -> SHA-256 hex) and constant-time HMAC-SHA256 webhook verification
 * using native WebCrypto (`crypto.subtle`) — zero external crypto dependencies.
 */

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function extractBearerOrApiKey(req: Request): string | undefined {
  const auth = req.headers.get('authorization')?.trim();
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  const xApiKey = req.headers.get('x-api-key')?.trim();
  return xApiKey || undefined;
}

export function generateOlympusToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `oly_live_${hex}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function signHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a billing webhook HMAC-SHA256 signature (`x-olympus-signature` or `webhook-signature: sha256=<hex>`).
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const cleaned = signatureHeader.trim().replace(/^(?:sha256=|v1,)/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleaned)) return false;
  const expected = await signHmacSha256Hex(secret, rawBody);
  return constantTimeEqual(cleaned, expected);
}
