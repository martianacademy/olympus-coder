import { useCallback, useEffect, useState } from 'react';
import type { SavedCommand } from '@shared/savedCommands';
import { onEvent } from './api';

/** Renderer calls for saved commands (handlers `saved.*` in src/main/savedCommands.ts). */
const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.desk.invoke(method, ...args);

export interface SavedNotice {
  stoppedByRestart: string[];
  guardTripped: string[];
}

type Run = { ptyId: string; title: string; alreadyRunning?: boolean };

export const savedApi = {
  list: (projectId: string) => call<SavedCommand[]>('saved.list', projectId),
  saveFromTerminal: (ptyId: string) => call<SavedCommand>('saved.saveFromTerminal', ptyId),
  update: (id: string, patch: Partial<Pick<SavedCommand, 'title' | 'command' | 'cwd' | 'autoStart' | 'keepRunning'>>) => call<SavedCommand>('saved.update', id, patch),
  remove: (id: string) => call<void>('saved.delete', id),
  run: (id: string) => call<Run>('saved.run', id),
  stop: (id: string) => call<void>('saved.stop', id),
  notice: (projectId: string) => call<SavedNotice>('saved.notice', projectId),
  dismiss: (projectId: string, kind: 'restart' | 'guard', id?: string) => call<void>('saved.dismiss', projectId, kind, id),
  restartAll: (projectId: string) => call<{ started: number; errors: string[] }>('saved.restartAll', projectId),
};

/** An IPC error as a plain sentence. */
export const errText = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** A project's saved commands and its restart / guard notices, live. */
export function useSavedCommands(projectId: string) {
  const [list, setList] = useState<SavedCommand[]>([]);
  const [notice, setNotice] = useState<SavedNotice>({ stoppedByRestart: [], guardTripped: [] });
  const reload = useCallback(async () => {
    try {
      const [l, n] = await Promise.all([savedApi.list(projectId), savedApi.notice(projectId)]);
      setList(l);
      setNotice(n);
    } catch {
      /* an older main process without saved commands */
    }
  }, [projectId]);
  useEffect(() => {
    setList([]);
    void reload();
    return onEvent((ch, p) => {
      // Terminal changes too: a linked tab's status is read from its terminal.
      if ((ch === 'savedcmd:changed' || ch === 'terminal:changed') && p?.projectId === projectId) void reload();
    });
  }, [projectId, reload]);
  return { list, notice, reload };
}
