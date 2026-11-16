import { useEffect, useRef } from 'react';
import type { AgentFileWriteEvent, EditorBufferReport } from '@shared/acpClient';
import { onEvent } from './api';

/**
 * Tells the main process which files have unsaved edits in this window's editor, so an agent reading a file
 * (`fs/read_text_file`) gets what the user sees, and a write over unsaved edits shows a conflict instead of
 * losing them. The full list for a project is sent shortly after it changes and again every 20 s while it is
 * not empty (the main process forgets a window that stops reporting).
 */

/** This window (a phone tab and the desktop window report separately). */
const CLIENT_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `w${Math.random().toString(36).slice(2)}`;
const DEBOUNCE_MS = 300;
const HEARTBEAT_MS = 20_000;

const report = (projectId: string, list: EditorBufferReport[]) => void window.desk.invoke('editor.reportBuffers', CLIENT_ID, projectId, list).catch(() => {});

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => void window.desk?.invoke('editor.forgetClient', CLIENT_ID).catch(() => {}));
}

/** Reports `dirty` (unsaved files, paths relative to the project) for `projectId`; clears them on unmount. */
export function useReportEditorBuffers(projectId: string, dirty: EditorBufferReport[]) {
  const latest = useRef(dirty);
  latest.current = dirty;
  // A version that changes whenever the list or any text changes (string `!==` stops at the first difference).
  const prev = useRef<EditorBufferReport[]>([]);
  const version = useRef(0);
  if (dirty.length !== prev.current.length || dirty.some((d, i) => d.path !== prev.current[i].path || d.text !== prev.current[i].text)) {
    prev.current = dirty;
    version.current++;
  }
  const sent = useRef(false);

  useEffect(() => {
    // Nothing unsaved and nothing reported before: nothing to say.
    if (!latest.current.length && !sent.current) return;
    const t = setTimeout(() => {
      sent.current = latest.current.length > 0;
      report(projectId, latest.current);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [projectId, version.current]);

  useEffect(() => {
    const beat = setInterval(() => {
      if (latest.current.length) report(projectId, latest.current);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(beat);
      if (sent.current) report(projectId, []);
      sent.current = false;
    };
  }, [projectId]);
}

/** Calls `fn` when an agent wrote a file in project `projectId` (with the file's project-relative path). */
export function useAgentFileWrites(projectId: string, fn: (rel: string, write: AgentFileWriteEvent) => void) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(
    () =>
      onEvent((channel, payload: AgentFileWriteEvent) => {
        if (channel !== 'editor:agentWrite') return;
        const hit = payload.projects?.find((p) => p.projectId === projectId);
        if (hit) cb.current(hit.rel, payload);
      }),
    [projectId],
  );
}
