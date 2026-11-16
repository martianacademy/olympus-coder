import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, MessageSquarePlus } from 'lucide-react';
import { api } from '../api';
import { addDraftFiles, getDraft } from '../drafts';

/**
 * "Add to message": puts a file that is already in the chat (an attachment, agent media in
 * `<sharedRoot>/attachments/chats/<threadId>/`, a file a tool touched) into the active composer's draft by path,
 * with no re-upload, like pasting a copied message does. The composer on screen (a chat's, or the home draft)
 * registers itself through `useAttachments` → `useComposerTarget`.
 */

interface Target {
  key: string;
  /** Shows a quiet note under the composer (e.g. the file no longer exists). */
  note: (msg: string) => void;
}

const targets: Target[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const current = (): Target | undefined => targets[targets.length - 1];

/** Registers the composer for `draftKey` while it is mounted (the latest mounted one receives added files). */
export function useComposerTarget(draftKey: string, note: (msg: string) => void) {
  useEffect(() => {
    const t: Target = { key: draftKey, note };
    targets.push(t);
    emit();
    return () => {
      const i = targets.indexOf(t);
      if (i >= 0) targets.splice(i, 1);
      emit();
    };
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** True while a composer is on screen to receive files. */
export function useCanAddToMessage(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => targets.length > 0,
  );
}

/** Puts the caret at the end of the visible composer's text field. */
function focusComposer() {
  const fields = [...document.querySelectorAll<HTMLTextAreaElement>('.growable-textarea textarea')].filter((t) => t.offsetParent !== null);
  const ta = fields[fields.length - 1];
  if (!ta) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollIntoView({ block: 'nearest' });
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[a-z]:[\\/]/i.test(p);

/**
 * Adds `ref` to the active composer's draft and focuses it. Returns false when there is no composer or the file is
 * gone (the composer then shows a quiet note). A file already in the draft is not added twice.
 */
export async function addToMessage(ref: string, opts: { name?: string; mime?: string } = {}): Promise<boolean> {
  const t = current();
  if (!t) return false;
  let path = ref.replace(/^file:\/\//i, '');
  try {
    // Tool steps may show project-relative paths: the preview resolves them like the panel does.
    if (!isAbsolute(path)) path = (await api.preview(path)).path;
    if (getDraft(t.key).files.some((f) => f.path === path)) {
      focusComposer();
      return true;
    }
    const [d] = await api.describeAttachments([path]);
    if (!d) {
      t.note(`${opts.name || path.split(/[\\/]/).pop()} no longer exists, so it was not added`);
      return false;
    }
    addDraftFiles(t.key, [{ ...d, name: opts.name || d.name, mime: opts.mime || d.mime }]);
    focusComposer();
    return true;
  } catch (e: unknown) {
    t.note(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Small icon button for chat files; hidden when no composer is on screen. */
export function AddToMessageButton({
  path,
  name,
  mime,
  className = 'btn ghost icon rich-act',
  size = 12,
  label,
  onAdded,
}: {
  path: string;
  name?: string;
  mime?: string;
  className?: string;
  size?: number;
  label?: string;
  onAdded?: () => void;
}) {
  const can = useCanAddToMessage();
  const [done, setDone] = useState(false);
  if (!can) return null;
  return (
    <button
      type="button"
      className={className}
      title="Add to message"
      aria-label={`Add ${name ?? 'this file'} to the message`}
      data-testid="add-to-message"
      onClick={(e) => {
        e.stopPropagation();
        void addToMessage(path, { name, mime }).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1400);
          onAdded?.();
        });
      }}
    >
      {done ? <Check size={size} aria-hidden="true" /> : <MessageSquarePlus size={size} aria-hidden="true" />}
      {label ? ` ${label}` : null}
    </button>
  );
}
