/**
 * Detached Workbench tools: the right-panel tools that can open in a window of their own (src/main/panels.ts).
 * Pure logic only (no Electron), so the registry and the URL query are unit-tested (tests/panels.unit.mjs).
 */

export const PANEL_TOOLS = ['files', 'git', 'terminal', 'tasks', 'info', 'web'] as const;
export type PanelTool = (typeof PANEL_TOOLS)[number];

export const PANEL_TITLES: Record<PanelTool, string> = {
  files: 'Files',
  git: 'Git',
  terminal: 'Terminal',
  tasks: 'Tasks',
  info: 'Info',
  web: 'Web',
};

export const isPanelTool = (v: unknown): v is PanelTool => typeof v === 'string' && (PANEL_TOOLS as readonly string[]).includes(v);

/** What a detached window shows: the main window's current code project and chat (null until it reports one). */
export interface PanelContext {
  projectId: string;
  threadId?: string;
}

/** The query a detached window is loaded with: `?panel=<tool>` (+ `&url=` for the Web tool). */
export function panelQuery(tool: PanelTool, url?: string): Record<string, string> {
  return url && tool === 'web' ? { panel: tool, url } : { panel: tool };
}

/** Reads `?panel=<tool>` (and the Web tool's url) back; null for the main window. */
export function parsePanelQuery(search: string): { tool: PanelTool; url?: string } | null {
  const q = new URLSearchParams(search);
  const tool = q.get('panel');
  if (!isPanelTool(tool)) return null;
  const url = q.get('url') ?? undefined;
  return tool === 'web' && url ? { tool, url } : { tool };
}

/**
 * One window per tool. `open` returns the tool's live window (focusing it is the caller's job) or makes one with
 * `create`; a window that reports closed (or was destroyed) is forgotten, so the next `open` makes a new one.
 */
export class PanelRegistry<W> {
  private readonly windows = new Map<PanelTool, W>();

  private readonly isAlive: (w: W) => boolean;

  constructor(isAlive: (w: W) => boolean) {
    this.isAlive = isAlive;
  }

  open(tool: PanelTool, create: () => W): { win: W; created: boolean } {
    const existing = this.get(tool);
    if (existing) return { win: existing, created: false };
    const win = create();
    this.windows.set(tool, win);
    return { win, created: true };
  }

  get(tool: PanelTool): W | undefined {
    const w = this.windows.get(tool);
    if (w !== undefined && !this.isAlive(w)) {
      this.windows.delete(tool);
      return undefined;
    }
    return w;
  }

  /** Called from the window's 'closed' event; ignores a stale window that was already replaced. */
  closed(tool: PanelTool, win: W): void {
    if (this.windows.get(tool) === win) this.windows.delete(tool);
  }

  /** The tool a window belongs to, if it is one of ours. */
  toolOf(win: W): PanelTool | undefined {
    for (const [tool, w] of this.windows) if (w === win) return tool;
    return undefined;
  }

  list(): PanelTool[] {
    return PANEL_TOOLS.filter((t) => this.get(t) !== undefined);
  }

  all(): W[] {
    return this.list().map((t) => this.windows.get(t)!);
  }
}
