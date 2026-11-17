import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, MoreHorizontal, PanelLeft, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type { FileEntry } from '@shared/types';
import { api } from '../api';
import { PanelSkeleton } from './Skeleton';
import { keys } from '../platform';
import { useAgentFileWrites, useReportEditorBuffers } from '../editorBuffers';
import { CodeEditor, WrapToggle, formatTextOnSave } from './Editor';
import { ExplorerMenu, type ExplorerMenuTarget } from './ExplorerMenu';
import '../acpClient.css';

interface OpenFile {
  path: string;
  /** Text on disk when last loaded or saved. */
  disk: string;
  /** Current editor text. */
  text: string;
  mtime: number;
  binary: boolean;
  tooLarge: boolean;
  /** An agent rewrote the file on disk while it had unsaved edits here; the edits are kept until the user picks. */
  agentChanged?: boolean;
  /** 1-based line to show, when opened from a chat location or the preview's "Edit in Files". */
  goLine?: number;
}

export interface FilesPanelHandle {
  /** Opens a project-relative path; `line` (1-based) puts the cursor there. */
  open: (path: string, line?: number) => void;
  saveActive: () => void;
}

/** Inline name field for new / renamed entries. Module-level so typing never remounts it; reports once (Enter, Esc or blur). */
function NameInput({ initial, onDone }: { initial: string; onDone: (v: string) => void }) {
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="rename-input"
      autoFocus
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') finish('');
      }}
    />
  );
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.split('/').pop() ?? p;

/** Explorer + editor for one project. `gitMarks` colors changed files; `refreshKey` reloads after agent turns. */
export const FilesPanel = forwardRef<FilesPanelHandle, { projectId: string; dark: boolean; gitMarks: Record<string, string>; refreshKey: number; onSaved?: () => void }>(function FilesPanel(
  { projectId, dark, gitMarks, refreshKey, onSaved },
  ref,
) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [creating, setCreating] = useState<{ dir: string; isDir: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<(ExplorerMenuTarget & { entry?: FileEntry }) | null>(null);
  const [error, setError] = useState('');
  const filesRef = useRef(files);
  filesRef.current = files;
  const childrenRef = useRef(children);
  childrenRef.current = children;

  // Agents read unsaved text (fs/read_text_file) instead of the stale file on disk.
  useReportEditorBuffers(
    projectId,
    files.filter((f) => f.text !== f.disk && !f.binary && !f.tooLarge).map((f) => ({ path: f.path, text: f.text })),
  );

  const loadDir = useCallback(
    async (rel: string) => {
      try {
        const list = await api.files.list(projectId, rel);
        setChildren((c) => ({ ...c, [rel]: list }));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [projectId],
  );

  const refreshTree = useCallback(() => {
    for (const d of expanded) void loadDir(d);
  }, [expanded, loadDir]);

  useEffect(() => {
    void loadDir('');
  }, [loadDir]);

  // After an agent turn: refresh the tree and reload open files that changed on disk and have no unsaved edits.
  useEffect(() => {
    if (!refreshKey) return;
    refreshTree();
    for (const f of filesRef.current) {
      if (f.text !== f.disk || f.binary || f.tooLarge) continue;
      void api.files
        .read(projectId, f.path)
        .then((c) => {
          if (c.mtime !== f.mtime) setFiles((all) => all.map((x) => (x.path === f.path && x.text === x.disk ? { ...x, disk: c.text, text: c.text, mtime: c.mtime } : x)));
        })
        .catch(() => setFiles((all) => all.filter((x) => x.path !== f.path)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const open = useCallback(
    async (path: string, line?: number) => {
      setError('');
      if (typeof window !== 'undefined' && window.innerWidth <= 620) setShowTree(false);
      if (filesRef.current.some((f) => f.path === path)) {
        if (line) setFiles((all) => all.map((x) => (x.path === path ? { ...x, goLine: line } : x)));
        return setActive(path);
      }
      try {
        const c = await api.files.read(projectId, path);
        setFiles((all) => [...all, { path, disk: c.text, text: c.text, mtime: c.mtime, binary: c.binary, tooLarge: c.tooLarge, goLine: line }]);
        setActive(path);
        // Reveal it in the tree.
        const parts = path.split('/');
        const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
        setExpanded((e) => new Set([...e, ...dirs]));
        for (const d of dirs) if (!children[d]) void loadDir(d);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [projectId, children, loadDir],
  );

  async function save(path = active) {
    const f = filesRef.current.find((x) => x.path === path);
    if (!f) return;
    const nextText = formatTextOnSave(f.text);
    if (nextText === f.disk) return;
    let r = await api.files.write(projectId, f.path, nextText, f.mtime);
    if (r.conflict) {
      if (!confirm(`"${nameOf(f.path)}" changed on disk (possibly by an agent). Save your version and overwrite those changes?`)) return;
      r = await api.files.write(projectId, f.path, nextText);
    }
    setFiles((all) => all.map((x) => (x.path === f.path ? { ...x, disk: nextText, text: nextText, mtime: r.mtime } : x)));
    onSaved?.();
  }

  // An agent wrote a file (fs/write_text_file): reload it when it has no unsaved edits, else keep them and ask.
  useAgentFileWrites(projectId, (rel, w) => {
    if (w.created) {
      // Every loaded folder on the way down (a new `gen/deep/x.txt` shows `gen` in the root too).
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (d === '' || childrenRef.current[d]) void loadDir(d);
      }
    }
    const f = filesRef.current.find((x) => x.path === rel);
    if (!f || f.binary || f.tooLarge) return;
    void api.files
      .read(projectId, rel)
      .then((c) =>
        setFiles((all) =>
          all.map((x) => {
            if (x.path !== rel) return x;
            if (x.text === x.disk || c.text === x.text) return { ...x, disk: c.text, text: c.text, mtime: c.mtime, agentChanged: false };
            // Rewritten with the same text the edits started from: nothing to choose.
            if (c.text === x.disk) return { ...x, mtime: c.mtime };
            return { ...x, agentChanged: true };
          }),
        ),
      )
      .catch(() => {});
  });

  /** Conflict banner: take the agent's version (undo with ⌘Z brings the edits back) or keep the unsaved edits. */
  async function resolveAgentChange(path: string, take: boolean) {
    if (!take) return setFiles((all) => all.map((x) => (x.path === path ? { ...x, agentChanged: false } : x)));
    try {
      const c = await api.files.read(projectId, path);
      setFiles((all) => all.map((x) => (x.path === path ? { ...x, disk: c.text, text: c.text, mtime: c.mtime, agentChanged: false } : x)));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useImperativeHandle(ref, () => ({ open: (p, line) => void open(p, line), saveActive: () => void save() }));

  function close(path: string) {
    const f = files.find((x) => x.path === path);
    if (f && f.text !== f.disk && !confirm(`"${nameOf(path)}" has unsaved changes. Close without saving?`)) return;
    const rest = files.filter((x) => x.path !== path);
    setFiles(rest);
    if (active === path) setActive(rest[rest.length - 1]?.path ?? null);
    if (!rest.length && typeof window !== 'undefined' && window.innerWidth <= 620) setShowTree(true);
  }

  function toggle(dir: string) {
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(dir)) n.delete(dir);
      else {
        n.add(dir);
        if (!children[dir]) void loadDir(dir);
      }
      return n;
    });
  }

  async function create(name: string) {
    if (!creating || !name.trim()) return setCreating(null);
    const rel = creating.dir ? `${creating.dir}/${name.trim()}` : name.trim();
    try {
      await api.files.create(projectId, rel, creating.isDir);
      await loadDir(creating.dir);
      if (!creating.isDir) void open(rel);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
    setCreating(null);
  }

  async function rename(from: string, name: string) {
    setRenaming(null);
    if (!name.trim() || name === nameOf(from)) return;
    const to = dirOf(from) ? `${dirOf(from)}/${name.trim()}` : name.trim();
    try {
      await api.files.rename(projectId, from, to);
      await loadDir(dirOf(from));
      setFiles((all) => all.map((f) => (f.path === from ? { ...f, path: to } : f)));
      if (active === from) setActive(to);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function trash(entry: FileEntry) {
    if (!confirm(`Move "${entry.name}" to the Trash? (You can restore it from the Trash in Finder.)`)) return;
    try {
      await api.files.trash(projectId, entry.path);
      await loadDir(dirOf(entry.path));
      setFiles((all) => all.filter((f) => f.path !== entry.path && !f.path.startsWith(`${entry.path}/`)));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  const renderDir = (dir: string, depth: number): React.ReactNode => (
    <>
      {creating?.dir === dir && (
        <div className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
          {creating.isDir ? <Folder size={14} className="muted" /> : <File size={14} className="muted" />}
          <NameInput initial="" onDone={(v) => void create(v)} />
        </div>
      )}
      {(children[dir] ?? []).map((e) => {
        const open_ = expanded.has(e.path);
        const mark = gitMarks[e.path] ?? (e.dir ? Object.keys(gitMarks).some((p) => p.startsWith(`${e.path}/`)) && '•' : undefined);
        return (
          <div key={e.path}>
            <div
              className={`tree-row ${active === e.path ? 'active' : ''} ${mark ? `git-${mark === '?' ? 'new' : mark === 'D' ? 'del' : 'mod'}` : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => (e.dir ? toggle(e.path) : void open(e.path))}
              onContextMenu={(ev) => (ev.preventDefault(), setMenu({ rel: e.path, dir: e.dir, x: ev.clientX, y: ev.clientY, entry: e }))}
              title={e.path}
            >
              {e.dir ? open_ ? <ChevronDown size={13} className="muted" /> : <ChevronRight size={13} className="muted" /> : <span style={{ width: 13 }} />}
              {e.dir ? open_ ? <FolderOpen size={14} className="muted" /> : <Folder size={14} className="muted" /> : <File size={14} className="muted" />}
              {renaming === e.path ? <NameInput initial={e.name} onDone={(v) => void rename(e.path, v)} /> : <span className="grow tree-name">{e.name}</span>}
              {mark && <span className="git-mark">{mark === '?' ? 'U' : mark}</span>}
              <span className="row-actions">
                {e.dir && (
                  <>
                    <button className="btn ghost icon" title="New file" onClick={(ev) => (ev.stopPropagation(), setExpanded((x) => new Set([...x, e.path])), !children[e.path] && void loadDir(e.path), setCreating({ dir: e.path, isDir: false }))}>
                      <FilePlus size={12} />
                    </button>
                    <button className="btn ghost icon" title="New folder" onClick={(ev) => (ev.stopPropagation(), setExpanded((x) => new Set([...x, e.path])), !children[e.path] && void loadDir(e.path), setCreating({ dir: e.path, isDir: true }))}>
                      <FolderPlus size={12} />
                    </button>
                  </>
                )}
                <button className="btn ghost icon" title="Rename" onClick={(ev) => (ev.stopPropagation(), setRenaming(e.path))}>
                  <Pencil size={11} />
                </button>
                <button className="btn ghost icon" title="Move to Trash" onClick={(ev) => (ev.stopPropagation(), void trash(e))}>
                  <Trash2 size={12} />
                </button>
                <button
                  className="btn ghost icon"
                  title="More: open in an editor, reveal, copy path"
                  data-testid="tree-row-more"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    const r = ev.currentTarget.getBoundingClientRect();
                    setMenu({ rel: e.path, dir: e.dir, x: r.right - 4, y: r.bottom + 4, entry: e });
                  }}
                >
                  <MoreHorizontal size={13} />
                </button>
              </span>
            </div>
            {e.dir && open_ && renderDir(e.path, depth + 1)}
          </div>
        );
      })}
    </>
  );

  const current = files.find((f) => f.path === active);

  return (
    <div className="files-panel">
      {showTree && (
        <div className="explorer">
          <div className="panel-toolbar">
            <span className="small muted explorer-title" style={{ fontWeight: 600 }}>
              EXPLORER
            </span>
            <div className="spacer" />
            <button className="btn ghost icon" title="New file" onClick={() => setCreating({ dir: '', isDir: false })}>
              <FilePlus size={14} />
            </button>
            <button className="btn ghost icon" title="New folder" onClick={() => setCreating({ dir: '', isDir: true })}>
              <FolderPlus size={14} />
            </button>
            <button className="btn ghost icon" title="Refresh" onClick={refreshTree} data-testid="explorer-refresh">
              <RefreshCw size={13} />
            </button>
            <button
              className="btn ghost icon"
              title="Open the project folder in an editor or the file manager"
              data-testid="explorer-more"
              onClick={(ev) => {
                const r = ev.currentTarget.getBoundingClientRect();
                setMenu({ rel: '', dir: true, x: r.left, y: r.bottom + 4 });
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
          <div className="tree">{children[''] || error ? renderDir('', 0) : <PanelSkeleton head={false} />}</div>
          {menu && (
            <ExplorerMenu
              projectId={projectId}
              target={menu}
              onClose={() => setMenu(null)}
              onError={setError}
              onRename={menu.entry ? () => setRenaming(menu.entry!.path) : undefined}
              onTrash={menu.entry ? () => void trash(menu.entry!) : undefined}
            />
          )}
        </div>
      )}
      <div className="editor-area">
        <div className="editor-tabs">
          <button className="btn ghost icon" title={showTree ? 'Hide explorer' : 'Show explorer'} aria-label={showTree ? 'Hide explorer' : 'Show explorer'} data-testid="files-toggle-tree" onClick={() => setShowTree((s) => !s)}>
            <PanelLeft size={14} />
          </button>
          <div className="tabs-scroll">
            {files.map((f) => (
              <div
                key={f.path}
                className={`editor-tab ${f.path === active ? 'active' : ''}`}
                onClick={() => {
                  setActive(f.path);
                  if (typeof window !== 'undefined' && window.innerWidth <= 620) setShowTree(false);
                }}
                title={f.path}
              >
                <span className="ellipsis">{nameOf(f.path)}</span>
                {f.text !== f.disk ? (
                  <span className="dirty-dot" onClick={(e) => (e.stopPropagation(), close(f.path))} title="Unsaved — close" />
                ) : (
                  <X size={12} className="tab-x" onClick={(e) => (e.stopPropagation(), close(f.path))} />
                )}
              </div>
            ))}
          </div>
          {current && current.text !== current.disk && (
            <button className="btn small primary" onClick={() => void save()} title="Save (⌘S)">
              <Save size={13} /> Save
            </button>
          )}
        </div>
        {error && (
          <div className="err-box small" style={{ margin: 8 }}>
            {error}{' '}
            <button className="btn ghost small" onClick={() => setError('')}>
              <X size={12} />
            </button>
          </div>
        )}
        {current ? (
          current.binary || current.tooLarge ? (
            <div className="empty muted">{current.binary ? 'This is a binary file and cannot be opened in the editor.' : 'This file is larger than 2 MB and cannot be edited here.'}</div>
          ) : (
            <>
              <div className="editor-path small muted">
                <span className="ellipsis grow">{current.path}</span>
                <WrapToggle />
              </div>
              {current.agentChanged && (
                <div className="agent-conflict small" role="alert" data-testid="editor-agent-conflict">
                  <span className="agent-conflict-text">An agent changed this file on disk while you had unsaved edits. Your edits are kept.</span>
                  <span className="agent-conflict-actions">
                    <button className="btn ghost small" data-testid="editor-agent-take" title="Replace your unsaved edits with the agent's version (undo brings them back)" onClick={() => void resolveAgentChange(current.path, true)}>
                      Load agent's version
                    </button>
                    <button className="btn ghost small" data-testid="editor-agent-keep" title="Keep your edits. Saving asks before it overwrites the agent's change." onClick={() => void resolveAgentChange(current.path, false)}>
                      Keep mine
                    </button>
                  </span>
                </div>
              )}
              <CodeEditor
                key={current.path}
                path={current.path}
                // The editor's own text, so switching tabs (a remount) keeps unsaved edits; a new value from outside
                // (reload, agent write, "Load agent's version") replaces the document as one undoable change.
                value={current.text}
                dark={dark}
                line={current.goLine}
                onChange={(text) => setFiles((all) => all.map((x) => (x.path === current.path ? { ...x, text, goLine: undefined } : x)))}
                onSave={() => void save(current.path)}
              />
            </>
          )
        ) : (
          <div className="empty muted small">Select a file in the explorer. Press {keys('⌘S')} to save.</div>
        )}
      </div>
    </div>
  );
});
