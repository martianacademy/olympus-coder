import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AgentStatus, AppState, DeskEvents, Project, SessionView, Thread, ThreadItem, ThreadMeta, UiMode } from '@shared/types';
import { withItem } from '@shared/itemOrder';
import { onEvent, terminalAskedRecently } from './api';
import { clearDraft } from './drafts';
import { addTerminal, type WorkbenchTab } from './components/Workbench';
import type { SettingsTab } from './components/Settings';
import { isRemoteBrowser, WORKBENCH_SHEET_BP } from './responsive';
import { applyTheme, onSystemThemeChange } from './theme';
import { useVisibleInterval } from './visibility';
import type { AgentsInfo } from './App';

export interface AppSyncParams {
  state: AppState | null;
  setState: Dispatch<SetStateAction<AppState | null>>;
  setAgents: Dispatch<SetStateAction<AgentsInfo>>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setThreads: Dispatch<SetStateAction<Record<string, ThreadMeta[]>>>;
  setActive: Dispatch<SetStateAction<Thread | null>>;
  setSession: Dispatch<SetStateAction<SessionView | null>>;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab | null>>;
  setLoginAgent: Dispatch<SetStateAction<string | null>>;
  setShowProfile: Dispatch<SetStateAction<boolean>>;
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  setWbTab: Dispatch<SetStateAction<WorkbenchTab>>;
  setWbOpen: Dispatch<SetStateAction<boolean>>;
  setSbCollapsed: Dispatch<SetStateAction<boolean>>;
  isDrawerSidebar: boolean;
  sbCollapsed: boolean;
  isSheetWorkbench: boolean;
  wbOpen: boolean;
  mode: UiMode;
  activeIdRef: RefObject<string | null>;
  lastStatusRef: RefObject<string | undefined>;
  previewCtxRef: RefObject<{ projectId?: string; workbench: boolean }>;
  mainRef: RefObject<HTMLElement | null>;
  onMenuCommand: (cmd: string) => void;
  /** A chat was deleted anywhere (this window, the main process, a phone): leave it if it is open. */
  onThreadDeleted: (d: DeskEvents['thread:deleted']) => void;
  /** projects.json changed anywhere (this window, an agent's create_project, an outside write): the new list. */
  onProjectsChanged: (list: Project[]) => void;
}

/**
 * Synchronizes global DOM attributes (theme, platform, vibrancy, splash screen, `<main inert>`),
 * Escape dismissal for mobile overlays, and live IPC event streams from the main process.
 *
 * @param params - Live state setters and refs from the root `App` component.
 * @returns `{ dark, refreshKey }` reflecting the active color scheme and debounced workspace change counter.
 */
export function useAppSync(params: AppSyncParams): { dark: boolean; refreshKey: number } {
  const {
    state,
    setState,
    setAgents,
    setProjects,
    setThreads,
    setActive,
    setSession,
    setSettingsTab,
    setLoginAgent,
    setShowProfile,
    setShowSearch,
    setWbTab,
    setWbOpen,
    setSbCollapsed,
    isDrawerSidebar,
    sbCollapsed,
    isSheetWorkbench,
    wbOpen,
    mode,
    activeIdRef,
    lastStatusRef,
    previewCtxRef,
    mainRef,
  } = params;

  const [dark, setDark] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [, setClock] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const menuRef = useRef(params.onMenuCommand);
  menuRef.current = params.onMenuCommand;
  const deletedRef = useRef(params.onThreadDeleted);
  deletedRef.current = params.onThreadDeleted;
  const projectsRef = useRef(params.onProjectsChanged);
  projectsRef.current = params.onProjectsChanged;
  const tasksShown = useRef<Set<string>>(new Set());
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Relative times ("2m ago") tick every 30 s while the window is on screen (and refresh at once when it is back).
  useVisibleInterval(() => setClock((c) => c + 1), 30_000);

  // Dismiss open mobile navigation drawer or mobile workbench sheet on Escape.
  useEffect(() => {
    if (!(isDrawerSidebar && !sbCollapsed) && !(isSheetWorkbench && wbOpen)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isDrawerSidebar && !sbCollapsed) setSbCollapsed(true);
      else if (isSheetWorkbench && wbOpen) setWbOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDrawerSidebar, sbCollapsed, isSheetWorkbench, wbOpen, setSbCollapsed, setWbOpen]);

  // Make `<main>` inert while the narrow navigation drawer is open as a modal overlay (`navigation-drawer` pattern).
  useEffect(() => {
    const el = mainRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (!el) return;
    el.inert = isDrawerSidebar && !sbCollapsed;
  }, [isDrawerSidebar, sbCollapsed, mainRef]);

  const loaded = Boolean(state);
  useEffect(() => {
    if (!loaded) return;
    const el = document.getElementById('splash');
    if (!el) return;
    const t = setTimeout(() => {
      el.classList.add('gone');
      setTimeout(() => el.remove(), 400);
    }, Math.max(0, 1100 - performance.now()));
    return () => clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    if (!state) return;
    const remote = isRemoteBrowser();
    document.documentElement.classList.toggle('vibrant', state.platform === 'darwin' && !remote);
    document.documentElement.dataset.platform = remote ? 'web' : state.platform;
  }, [state?.platform]);

  useEffect(() => {
    if (!state) return;
    const apply = () => {
      applyTheme(state.settings.theme);
      setDark(document.documentElement.dataset.theme === 'dark');
    };
    apply();
    return onSystemThemeChange(apply);
  }, [state?.settings.theme]);

  useEffect(() => {
    const bump = () => {
      if (bumpTimer.current) clearTimeout(bumpTimer.current);
      bumpTimer.current = setTimeout(() => setRefreshKey((k) => k + 1), 700);
    };
    return onEvent((channel, payload) => {
      switch (channel) {
        case 'lock:state':
          if (payload.locked) {
            setActive(null);
            setSession(null);
            setSettingsTab(null);
            setLoginAgent(null);
            setShowProfile(false);
            setShowSearch(false);
            setProjects([]);
            setThreads({});
          }
          setState((s) => (s ? { ...s, lock: payload } : s));
          break;
        case 'agent:status':
          setAgents((a) => ({ ...a, statuses: { ...a.statuses, [(payload as AgentStatus).id]: payload as AgentStatus } }));
          break;
        case 'agents:changed': {
          const r = payload as DeskEvents['agents:changed'];
          setAgents({ defs: r.defs, statuses: Object.fromEntries(r.statuses.map((x) => [x.id, x])) });
          break;
        }
        case 'thread:item': {
          if (payload.threadId !== activeIdRef.current) break;
          const item = payload.item as ThreadItem;
          if (item.kind === 'tool' && item.status === 'completed') bump();
          // Same order as the saved chat: agent items go above a waiting Olympus confirm card (shared/itemOrder.ts).
          setActive((t) => (t ? { ...t, items: withItem(t.items, item) } : t));
          break;
        }
        case 'thread:meta': {
          const m = payload as ThreadMeta;
          // On desktop, auto-open Tasks once when the orchestrator or CLI agent spawns its first sub-session/sub-agent; on phone, avoid covering chat unannounced.
          if ((m.spawnedBy || m.nativeSubagent) && m.parentId === activeIdRef.current && !tasksShown.current.has(m.parentId)) {
            tasksShown.current.add(m.parentId);
            if (window.innerWidth > WORKBENCH_SHEET_BP) {
              setWbTab('tasks');
              setWbOpen(true);
            }
          }
          if (!m.nativeSubagent) {
            setThreads((all) => {
              const list = all[m.projectId] ?? [];
              const next = list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : [m, ...list];
              return { ...all, [m.projectId]: next.sort((a, b) => b.updatedAt - a.updatedAt) };
            });
          }
          if (m.id === activeIdRef.current) setActive((t) => (t ? { ...t, title: m.title, agentId: m.agentId, autoApprove: m.autoApprove } : t));
          break;
        }
        case 'projects:changed':
          projectsRef.current(payload as DeskEvents['projects:changed']);
          break;
        case 'thread:deleted': {
          const d = payload as DeskEvents['thread:deleted'];
          clearDraft(d.id);
          deletedRef.current(d);
          setThreads((all) => (all[d.projectId]?.some((x) => x.id === d.id) ? { ...all, [d.projectId]: all[d.projectId].filter((x) => x.id !== d.id) } : all));
          break;
        }
        case 'session:state':
          if (payload.threadId === activeIdRef.current) {
            if (lastStatusRef.current === 'running' && payload.status !== 'running') bump();
            lastStatusRef.current = payload.status;
            setSession(payload);
          }
          break;
        case 'terminal:opened':
          addTerminal(payload.projectId, payload.ptyId);
          // A terminal opened elsewhere (the Mac, an agent) must not cover the chat on a phone, nor stream its output there.
          if (
            payload.projectId === previewCtxRef.current.projectId &&
            previewCtxRef.current.workbench &&
            (window.innerWidth > WORKBENCH_SHEET_BP || terminalAskedRecently())
          ) {
            setWbTab('terminal');
            setWbOpen(true);
          }
          break;
        case 'menu':
          menuRef.current(payload);
          break;
      }
    });
  }, [
    activeIdRef,
    lastStatusRef,
    previewCtxRef,
    setActive,
    setAgents,
    setLoginAgent,
    setProjects,
    setSession,
    setSettingsTab,
    setShowProfile,
    setShowSearch,
    setState,
    setThreads,
    setWbOpen,
    setWbTab,
  ]);

  return { dark, refreshKey };
}
