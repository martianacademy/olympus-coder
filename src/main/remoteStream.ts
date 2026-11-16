import type { ThreadItem } from '@shared/types';
import { diffItem, snapshot } from '@shared/itemPatch';
import { ptyBuffer } from './pty';

/**
 * What one phone connection receives. Measured on 2026-11-16 (hidden Electron + throttled 390px phone page): the
 * Mac forwarded every chat's whole streaming item on each chunk plus every terminal's output, ~880 KB/s for one
 * streaming chat, three busy background chats and a build log; on ~5 Mbit/s Wi-Fi the reply fell 5–8 s behind.
 *
 * So, per connection, once the phone has said what is on its screen (`RemoteView`):
 * - chats it shows get full items, then only patches (`thread:patch`, see shared/itemPatch.ts);
 * - other chats get just what the sidebar and badges need (permission / question / error items, tool status
 *   changes, slimmed down), and what changed meanwhile is sent when the phone opens one;
 * - terminals it does not show get no output (their scrollback is sent when it opens one);
 * - events are merged per item / terminal and written at most once per `intervalMs` (the first at once).
 * A phone that never sends a view (an older page) gets every event in full, as before.
 */

export interface RemoteView {
  threads: string[];
  ptys: string[];
  /** The phone understands `thread:patch`. */
  patch?: boolean;
  /** Items (`threadId\nitemId`) the phone has no copy of: send them in full next time. */
  resync?: string[];
}

/** Writes a batch; false when it could not be delivered (e.g. the phone is locked out). */
type Out = (batch: Array<[string, unknown]>) => boolean;
interface Queued {
  ch: string;
  p: any;
  /** A chat item for a chat on screen: diffed against what was sent at flush time. */
  item?: boolean;
}

const MAX_SENT = 400;
const MAX_DIRTY_PER_THREAD = 300;
const MAX_DIRTY_THREADS = 200;
const MAX_TOOL_STATUS = 2000;
/** A chat opened on the phone gets what changed this recently (it loads the rest itself, a moment earlier). */
const CATCH_UP_MS = 15_000;
/** Items a chat that is not on screen still needs (sidebar badges, Tasks): small and rare. */
const ALWAYS = new Set(['permission', 'elicitation', 'error']);

const cap = <K, V>(m: Map<K, V>, max: number) => {
  while (m.size > max) m.delete(m.keys().next().value as K);
};
const keyOf = (threadId: string, itemId: string) => `${threadId}\n${itemId}`;
const clean = (a: unknown, max = 64): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.length < 200).slice(0, max) : []);

export class RemoteStream {
  private view: { threads: Set<string>; ptys: Set<string>; patch: boolean } | null = null;
  /** What this phone last got of each on-screen item (a snapshot), oldest first. */
  private sent = new Map<string, unknown>();
  private toolStatus = new Map<string, string>();
  /** Chats not on screen: their items that changed meanwhile (live objects, latest wins) and when. */
  private dirty = new Map<string, Map<string, { item: ThreadItem; at: number }>>();
  private queue = new Map<string, Queued>();
  private n = 0;
  private timer: NodeJS.Timeout | undefined;
  private lastFlush = 0;

  private readonly out: Out;
  private readonly intervalMs: number;

  constructor(out: Out, intervalMs: number) {
    this.out = out;
    this.intervalMs = intervalMs;
  }

  push(ch: string, p: any) {
    if (ch === 'thread:item' && p?.item?.id) {
      const tid = String(p.threadId);
      const item = p.item as ThreadItem;
      const key = keyOf(tid, item.id);
      if (this.view && !this.view.threads.has(tid)) {
        const d = this.dirty.get(tid) ?? new Map<string, { item: ThreadItem; at: number }>();
        d.delete(item.id);
        d.set(item.id, { item, at: Date.now() });
        cap(d, MAX_DIRTY_PER_THREAD);
        this.dirty.delete(tid);
        this.dirty.set(tid, d);
        cap(this.dirty, MAX_DIRTY_THREADS);
        if (ALWAYS.has(item.kind)) this.enqueue(`i:${key}`, { ch, p });
        else if (item.kind === 'tool' && this.toolStatus.get(key) !== item.status) {
          this.toolStatus.set(key, item.status);
          cap(this.toolStatus, MAX_TOOL_STATUS);
          const slim = { kind: 'tool', id: item.id, agentId: item.agentId, toolCallId: item.toolCallId, title: item.title, status: item.status, content: [], locations: [], ts: item.ts };
          this.enqueue(`i:${key}`, { ch, p: { threadId: tid, item: slim } });
        }
        return this.schedule();
      }
      this.enqueue(`i:${key}`, { ch, p, item: Boolean(this.view) });
    } else if (ch === 'pty:data' && p?.ptyId) {
      if (this.view && !this.view.ptys.has(p.ptyId)) return;
      const k = `p:${p.ptyId}`;
      const prev = this.queue.get(k);
      if (prev) prev.p = { ptyId: p.ptyId, data: prev.p.data + p.data, end: p.end };
      else this.queue.set(k, { ch, p });
    } else this.enqueue(`e:${++this.n}`, { ch, p });
    this.schedule();
  }

  setView(v: RemoteView) {
    const threads = new Set(clean(v.threads));
    const ptys = new Set(clean(v.ptys));
    const old = this.view;
    this.view = { threads, ptys, patch: v.patch === true };
    for (const k of clean(v.resync, 500)) this.sent.delete(k);
    if (old) {
      // Chats that left the screen: forget what they got (they get full items again when reopened).
      for (const tid of old.threads) {
        if (threads.has(tid)) continue;
        for (const k of this.sent.keys()) if (k.startsWith(`${tid}\n`)) this.sent.delete(k);
      }
    }
    for (const tid of threads) {
      if (old?.threads.has(tid)) continue;
      // Newly on screen: what changed just now (the phone loaded the chat a moment earlier and may have missed it).
      const d = this.dirty.get(tid);
      this.dirty.delete(tid);
      const since = Date.now() - CATCH_UP_MS;
      for (const { item, at } of d?.values() ?? []) {
        if (at >= since) this.enqueue(`i:${keyOf(tid, item.id)}`, { ch: 'thread:item', p: { threadId: tid, item }, item: true });
      }
      for (const k of this.toolStatus.keys()) if (k.startsWith(`${tid}\n`)) this.toolStatus.delete(k);
    }
    for (const id of ptys) {
      if (!old || old.ptys.has(id)) continue;
      // Newly shown terminal: its scrollback (the terminal view skips what it already has by `end`).
      const b = ptyBuffer(id);
      if (b.data) this.queue.set(`p:${id}`, { ch: 'pty:data', p: { ptyId: id, data: b.data, end: b.end } });
    }
    this.schedule();
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.clear();
  }

  private enqueue(k: string, q: Queued) {
    this.queue.set(k, q);
  }

  private schedule() {
    if (this.timer || !this.queue.size) return;
    const wait = this.lastFlush + this.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush() {
    this.timer = undefined;
    this.lastFlush = Date.now();
    const batch: Array<[string, unknown]> = [];
    for (const q of this.queue.values()) {
      if (!q.item) {
        batch.push([q.ch, q.p]);
        continue;
      }
      const { threadId, item } = q.p as { threadId: string; item: ThreadItem };
      const key = keyOf(threadId, item.id);
      const prev = this.sent.get(key);
      if (prev !== undefined && this.view?.patch) {
        const patch = diffItem(prev, item);
        if (patch) batch.push(['thread:patch', { threadId, id: item.id, p: patch }]);
      } else batch.push(['thread:item', { threadId, item }]);
      this.sent.delete(key);
      this.sent.set(key, snapshot(item));
      cap(this.sent, MAX_SENT);
    }
    this.queue.clear();
    // Not delivered: the phone's copies are now behind what we noted, so it gets full items from here on.
    if (batch.length && !this.out(batch)) this.sent.clear();
  }
}
