import { useEffect, useState } from 'react';
import type { AcpConfigEvents, AgentProvidersView, AuthDetailsView, McpChatStatus, ProviderInput } from '@shared/acpConfig';
import { onEvent } from './api';

/** Renderer calls for ACP config, MCP status, model providers and login details (handlers `acpConfig.*` in src/main/index.ts). */
const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.desk.invoke(method, ...args);

export const acpConfigApi = {
  mcpStatus: (threadId: string) => call<McpChatStatus | null>('acpConfig.mcpStatus', threadId),
  providers: (agentId: string, start = true) => call<AgentProvidersView>('acpConfig.providers', agentId, start),
  setProvider: (agentId: string, input: ProviderInput) => call<AgentProvidersView>('acpConfig.setProvider', agentId, input),
  disableProvider: (agentId: string, providerId?: string) => call<AgentProvidersView>('acpConfig.disableProvider', agentId, providerId),
  authDetails: (agentId: string) => call<AuthDetailsView>('acpConfig.authDetails', agentId),
  loginWithVars: (agentId: string, methodId: string, values: Record<string, string>) => call<AuthDetailsView>('acpConfig.loginWithVars', agentId, methodId, values),
  forgetLoginVar: (agentId: string, name: string) => call<void>('acpConfig.forgetLoginVar', agentId, name),
  answerLoginLink: (agentId: string, action: 'accept' | 'decline' | 'cancel') => call<void>('acpConfig.answerLoginLink', agentId, action),
};

/** Subscribe to one of this slice's events. */
export function onAcpConfigEvent<K extends keyof AcpConfigEvents>(channel: K, fn: (payload: AcpConfigEvents[K]) => void): () => void {
  return onEvent((c, payload) => {
    if (c === channel) fn(payload as AcpConfigEvents[K]);
  });
}

/** Live MCP status of one chat (null until its session reports servers). */
export function useMcpStatus(threadId: string | undefined): McpChatStatus | null {
  const [status, setStatus] = useState<McpChatStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!threadId) return;
    let live = true;
    void acpConfigApi
      .mcpStatus(threadId)
      .then((s) => live && setStatus(s))
      .catch(() => {});
    const off = onAcpConfigEvent('mcp:status', (s) => {
      if (s.threadId === threadId) setStatus(s);
    });
    return () => {
      live = false;
      off();
    };
  }, [threadId]);
  return status;
}
