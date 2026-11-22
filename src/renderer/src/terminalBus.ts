/** Shared terminal tab focus bus so App/Workbench don't pull xterm.js into the initial bundle. */

/** The tab in front, per project, for the whole app session (the list itself lives in the main process). */
export const activeTerminal = new Map<string, string>();

/** A terminal the main process opened (Run button, an agent's run_in_terminal): bring its tab forward. */
export function addTerminal(projectId: string, ptyId: string): void {
  activeTerminal.set(projectId, ptyId);
  window.dispatchEvent(new CustomEvent('olympus:terminal-added', { detail: { projectId, ptyId } }));
}
