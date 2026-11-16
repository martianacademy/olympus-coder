import type { ThreadItem } from '@shared/types';

/**
 * A rough token count for text the agent produced, worked out from its length: about 4 characters per token
 * for English and code, 2 for other scripts. Agents don't report tokens per step, so this is an estimate and
 * is always shown with "≈".
 */
export function textTokens(s: string): number {
  if (!s) return 0;
  // For multi-kilobyte blobs (diffs, logs), stride-sampling gives an indistinguishable `≈` token estimate in O(1).
  if (s.length > 16_384) {
    const step = Math.ceil(s.length / 4096);
    let ascii = 0;
    let sampled = 0;
    for (let i = 0; i < s.length; i += step) {
      if (s.charCodeAt(i) < 128) ascii++;
      sampled++;
    }
    const asciiRatio = sampled ? ascii / sampled : 1;
    const estAscii = s.length * asciiRatio;
    return Math.round(estAscii / 4 + (s.length - estAscii) / 2);
  }
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.round(ascii / 4 + (s.length - ascii) / 2);
}

const itemTokenCache = new WeakMap<ThreadItem, { sig: string; val: number }>();

function itemSig(i: ThreadItem): string {
  if (i.kind === 'agent' || i.kind === 'thought') return `${i.text.length}`;
  if (i.kind === 'tool') {
    const last = i.content[i.content.length - 1];
    const lastLen = last ? (last.type === 'diff' ? (last.newText?.length ?? 0) : (last.text?.length ?? 0)) : 0;
    return `${i.title.length}:${i.content.length}:${lastLen}`;
  }
  return '';
}

export function itemTokens(i: ThreadItem): number {
  if (i.kind !== 'agent' && i.kind !== 'thought' && i.kind !== 'tool') return 0;
  const sig = itemSig(i);
  const hit = itemTokenCache.get(i);
  if (hit && hit.sig === sig) return hit.val;
  let val = 0;
  if (i.kind === 'agent' || i.kind === 'thought') {
    val = textTokens(i.text);
  } else {
    val = textTokens(i.title);
    for (const c of i.content) val += c.type === 'diff' ? textTokens(c.newText ?? '') : textTokens(c.text ?? '');
  }
  itemTokenCache.set(i, { sig, val });
  return val;
}

export const estimateTokens = (items: ThreadItem[]) => items.reduce((a, i) => a + itemTokens(i), 0);

export const fmtTokens = (n: number) => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);
