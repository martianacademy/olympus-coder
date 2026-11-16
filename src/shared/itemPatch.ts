/**
 * Small JSON patches for streaming chat items to phones. The Mac re-emits the whole item on every chunk (fine
 * over IPC, ~O(n²) bytes over Wi-Fi), so the phone link sends only what changed since the last copy that
 * phone got: text that grew is sent as the appended tail, unchanged fields are left out.
 *
 * - `{ a: string }`  the string grew: append this
 * - `{ s: value }`   set this value
 * - `{ o: { key: patch }, d?: [keys] }`  object: changed keys, deleted keys
 * - `{ l: length, i: { index: patch } }`  array: new length, changed entries
 */
export type ItemPatch = { a: string } | { s: unknown } | { o: Record<string, ItemPatch>; d?: string[] } | { l: number; i: Record<number, ItemPatch> };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A copy of the object/array shells; strings are shared (they are immutable), so this costs little memory. */
export function snapshot<T>(v: T): T {
  if (Array.isArray(v)) return v.map(snapshot) as T;
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const k in v) if (v[k] !== undefined) o[k] = snapshot(v[k]);
    return o as T;
  }
  return v;
}

/** What turns `prev` into `next`, or undefined when they are equal. `prev` must be a `snapshot`. */
export function diffItem(prev: unknown, next: unknown): ItemPatch | undefined {
  if (prev === next) return undefined;
  if (typeof next === 'string') {
    if (typeof prev === 'string' && next.length > prev.length && next.startsWith(prev)) return { a: next.slice(prev.length) };
    return { s: next };
  }
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return { s: next };
    const i: Record<number, ItemPatch> = {};
    let changed = prev.length !== next.length;
    for (let k = 0; k < next.length; k++) {
      const p = k < prev.length ? diffItem(prev[k], next[k]) : { s: next[k] };
      if (p) {
        i[k] = p;
        changed = true;
      }
    }
    return changed ? { l: next.length, i } : undefined;
  }
  if (isObj(next)) {
    if (!isObj(prev)) return { s: next };
    const o: Record<string, ItemPatch> = {};
    const d: string[] = [];
    let changed = false;
    for (const k in next) {
      if (next[k] === undefined) continue;
      const p = k in prev ? diffItem(prev[k], next[k]) : { s: next[k] };
      if (p) {
        o[k] = p;
        changed = true;
      }
    }
    for (const k in prev) {
      if (next[k] === undefined) {
        d.push(k);
        changed = true;
      }
    }
    if (!changed) return undefined;
    return d.length ? { o, d } : { o };
  }
  // number, boolean, null (equal primitives returned above)
  return { s: next };
}

/** `prev` with the patch applied, as a new value; parts the patch does not touch keep their identity. */
export function applyItemPatch(prev: unknown, p: ItemPatch): unknown {
  if ('s' in p) return p.s;
  if ('a' in p) return (typeof prev === 'string' ? prev : '') + p.a;
  if ('l' in p) {
    const base = Array.isArray(prev) ? prev : [];
    const out = base.slice(0, p.l);
    for (const k in p.i) out[Number(k)] = applyItemPatch(base[Number(k)], p.i[k]);
    return out;
  }
  const out: Record<string, unknown> = { ...(isObj(prev) ? prev : {}) };
  for (const k in p.o) out[k] = applyItemPatch(out[k], p.o[k]);
  for (const k of p.d ?? []) delete out[k];
  return out;
}
