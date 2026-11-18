import type { AcpSessionSupport, AcpSideEffect, DeletableAgentSession, DeleteChatTargets, HomeSessionOptions, NativeArchiveFilter, NativeSessionPage } from '@shared/acpSessions';
import type { Settings, ThreadMeta } from '@shared/types';
import { clearDraft } from './drafts';

/** Renderer calls for the ACP session lifecycle (handlers `acpSessions.*` in src/main/index.ts). */
const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.desk.invoke(method, ...args);

export type SessionStatusView = 'open' | 'saved' | 'missing' | 'unknown';

export const acpSessionsApi = {
  support: (agentId: string) => call<AcpSessionSupport>('acpSessions.support', agentId),
  list: (projectId: string, agentId: string, opts: { cursor?: string; archived?: NativeArchiveFilter } = {}) => call<NativeSessionPage>('acpSessions.list', projectId, agentId, opts),
  importSession: (projectId: string, agentId: string, session: { sessionId: string; title?: string; archived?: boolean }) =>
    call<ThreadMeta>('acpSessions.import', projectId, agentId, session),
  setArchived: (agentId: string, sessionId: string, archived: boolean) => call<AcpSideEffect>('acpSessions.archive', agentId, sessionId, archived),
  deleteNative: (agentId: string, sessionId: string) => call<AcpSideEffect>('acpSessions.deleteNative', agentId, sessionId),
  deletable: (threadId: string) => call<(DeletableAgentSession & { canDelete?: boolean })[]>('acpSessions.deletable', threadId),
  deleteTargets: (threadId: string) => call<DeleteChatTargets>('acpSessions.deleteTargets', threadId),
  deleteChat: (threadId: string, alsoAgentSessions: boolean, alsoSubsessions = false) =>
    call<Record<string, AcpSideEffect>>('acpSessions.deleteChat', threadId, alsoAgentSessions, alsoSubsessions).then((r) => (clearDraft(threadId), r)),
  rename: (threadId: string, title: string) => call<{ title: string; results: Record<string, AcpSideEffect> }>('acpSessions.rename', threadId, title),
  fork: (threadId: string, uptoItemId?: string) => call<{ meta: ThreadMeta; nativeFork: boolean }>('acpSessions.fork', threadId, uptoItemId),
  status: (threadId: string) => call<{ agentId: string; sessionId?: string; status: SessionStatusView }>('acpSessions.status', threadId),
  homeOptions: (projectId: string, agentId: string) => call<HomeSessionOptions>('acpSessions.homeOptions', projectId, agentId),
  setHomeOption: (agentId: string, configId: string, value: string) => call<Settings>('acpSessions.setHomeOption', agentId, configId, value),
};

/** "3 min ago", "Yesterday", "Mar 4" — for a session's last activity. */
export function sessionAge(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86_400) return 'Yesterday';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}
