import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, Copy, ExternalLink, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api';
import { copyText } from '../clipboard';
import { isRemoteBrowser } from '../responsive';

/**
 * The explorer's "…" / right-click menu for a file, a folder, or the whole project (`rel` = ''): open it in an
 * installed code editor, with the default app, show it in the file manager, copy its path, rename, trash.
 * Actions that open something on the computer are left out on the phone page.
 */

export interface ExplorerMenuTarget {
  rel: string;
  dir: boolean;
  /** Where to show it (viewport coordinates). */
  x: number;
  y: number;
}

let editorsCache: Promise<{ id: string; name: string }[]> | null = null;
const loadEditors = () => (editorsCache ??= api.files.editors().catch(() => []));

const revealLabel = () => {
  const p = document.documentElement.dataset.platform;
  return p === 'darwin' ? 'Reveal in Finder' : p === 'win32' ? 'Show in Explorer' : 'Show in folder';
};

export function ExplorerMenu(props: {
  projectId: string;
  target: ExplorerMenuTarget;
  onClose: () => void;
  onRename?: () => void;
  onTrash?: () => void;
  onError: (msg: string) => void;
}) {
  const { projectId, target } = props;
  const local = !isRemoteBrowser();
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });

  useEffect(() => {
    if (local) void loadEditors().then(setEditors);
  }, [local]);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(target.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(target.y, innerHeight - r.height - 8)) });
  }, [target.x, target.y, editors.length]);

  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', props.onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', props.onClose);
    };
  }, [props.onClose]);

  const run = (fn: () => Promise<unknown>) => {
    props.onClose();
    void fn().catch((e) => props.onError(String(e?.message ?? e)));
  };

  return (
    <div ref={box} className="explorer-menu" role="menu" style={{ left: pos.left, top: pos.top }} data-testid="explorer-menu">
      {local && editors.length > 0 && (
        <>
          <div className="explorer-menu-label">Open in</div>
          {editors.map((ed) => (
            <button key={ed.id} role="menuitem" data-testid={`open-in-${ed.id}`} onClick={() => run(() => api.files.openIn(projectId, target.rel, ed.id))}>
              <AppWindow size={14} /> {ed.name}
            </button>
          ))}
          <div className="explorer-menu-sep" />
        </>
      )}
      {local && (
        <>
          <button role="menuitem" data-testid="open-default" onClick={() => run(() => api.files.openDefault(projectId, target.rel))}>
            {target.dir ? <FolderOpen size={14} /> : <ExternalLink size={14} />} {target.dir ? 'Open folder' : 'Open with default app'}
          </button>
          <button role="menuitem" data-testid="reveal" onClick={() => run(() => api.files.reveal(projectId, target.rel))}>
            <FolderOpen size={14} /> {revealLabel()}
          </button>
        </>
      )}
      <button role="menuitem" data-testid="copy-rel-path" onClick={() => run(() => copyText(target.rel || '.'))}>
        <Copy size={14} /> Copy relative path
      </button>
      {(props.onRename || props.onTrash) && <div className="explorer-menu-sep" />}
      {props.onRename && (
        <button role="menuitem" onClick={() => (props.onClose(), props.onRename!())}>
          <Pencil size={14} /> Rename
        </button>
      )}
      {props.onTrash && (
        <button role="menuitem" className="danger" onClick={() => (props.onClose(), props.onTrash!())}>
          <Trash2 size={14} /> Move to Trash
        </button>
      )}
    </div>
  );
}
