import type { Thread, ThreadItem } from './types';

/** Number of newest items kept with full attachments, thoughts, and generous tool payloads for remote phones. */
const RECENT_KEEP = 120;
/** Per-entry cap (chars) for tool diffs/outputs inside the recent window (UI already clips at 16,000 chars). */
const RECENT_CAP = 24_000;
/** Per-entry cap (chars) for older collapsed tool steps beyond the recent window. */
const OLD_CAP = 400;
const OLD_TITLE_CAP = 300;
const OLD_THOUGHT_CAP = 300;

/**
 * Returns a lightweight shallow-copied `Thread` suited for remote phone/browser sessions (LAN & Cloudflare Relay).
 *
 * - Never mutates the original in-memory or on-disk thread.
 * - Preserves 100% of `user` and `agent` text and `usage` fields across the entire thread so token/cost stats
 *   (`SessionStats`) and "Show earlier messages" stay exact.
 * - Trims bulky historical `tool.diff` bodies, long terminal/tool outputs, and older inline base64 attachment
 *   previews (keeping `path`/`name`/`mime` so clicking any attachment still opens it in `MediaViewer`).
 */
export function slimThreadForRemote(thread: Thread): Thread {
  const items = thread.items;
  if (!Array.isArray(items) || items.length === 0) return thread;
  const cutoff = Math.max(0, items.length - RECENT_KEEP);
  let anyChanged = false;

  const out: ThreadItem[] = items.map((it, idx) => {
    const isRecent = idx >= cutoff;
    const cap = isRecent ? RECENT_CAP : OLD_CAP;

    if (it.kind === 'user') {
      if (!isRecent && it.attachments?.some((a) => a.preview)) {
        anyChanged = true;
        return {
          ...it,
          attachments: it.attachments.map(({ preview: _drop, ...rest }) => rest),
        };
      }
      return it;
    }

    if (it.kind === 'thought') {
      if (!isRecent && it.text.length > OLD_THOUGHT_CAP) {
        anyChanged = true;
        return { ...it, text: `${it.text.slice(0, OLD_THOUGHT_CAP)}…` };
      }
      return it;
    }

    if (it.kind !== 'tool') return it;

    let changed = false;
    let title = it.title;
    if (!isRecent && title.length > OLD_TITLE_CAP) {
      title = `${title.slice(0, OLD_TITLE_CAP)}…`;
      changed = true;
    }

    let terminalText = it.terminalText;
    if (typeof terminalText === 'string' && terminalText.length > cap) {
      terminalText = terminalText.slice(-cap);
      changed = true;
    }

    let olympus = it.olympus;
    if (olympus && typeof olympus.result === 'string' && olympus.result.length > cap) {
      olympus = { ...olympus, result: `${olympus.result.slice(0, cap)}…` };
      changed = true;
    }

    let content = it.content;
    if (Array.isArray(content) && content.length > 0) {
      let contentChanged = false;
      const nextContent = content.map((c) => {
        if (c.type === 'diff') {
          const ot = c.oldText ?? '';
          const nt = c.newText ?? '';
          if (ot.length + nt.length > cap) {
            contentChanged = true;
            if (isRecent) {
              const half = Math.floor(cap / 2);
              return { ...c, oldText: ot.slice(0, half), newText: nt.slice(0, half) };
            }
            return { type: 'diff' as const, path: c.path, oldText: '', newText: '' };
          }
          return c;
        }
        if (!c.rich && typeof c.text === 'string' && c.text.length > cap) {
          contentChanged = true;
          return { ...c, text: `${c.text.slice(0, cap)}\n…` };
        }
        return c;
      });
      if (contentChanged) {
        content = nextContent;
        changed = true;
      }
    }

    if (!changed) return it;
    anyChanged = true;
    return { ...it, title, terminalText, olympus, content };
  });

  return anyChanged ? { ...thread, items: out } : thread;
}
