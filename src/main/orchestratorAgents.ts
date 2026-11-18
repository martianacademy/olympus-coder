import type { AgentStatus, ConfigOptionView, Thread } from '@shared/types';
import { formatLimitLine, formatLimitsAge, formatResetTime, liveLimits, quotaState } from '@shared/quota';
import {
  agentStatuses,
  configureSession,
  ensureSession,
  knownOptionsForAgent,
  limitsService,
  sendPrompt,
  sessionView,
  switchAgent,
  type SessionConfigRequest,
} from './agents';
import { agentName } from './guide';
import { findThread, getSettings } from './store';

/** Structured user/agent-facing validation error returned cleanly over MCP without stack traces. */
export class ToolError extends Error {}

/**
 * Before a quota decision: re-read agents whose limits are older than ~2 minutes (or whose reset time passed),
 * waiting at most `timeoutMs` — a slow agent finishes in the background and never holds up the MCP call.
 */
export async function ensureFreshLimits(timeoutMs = 4000): Promise<void> {
  await limitsService.ensureFresh(timeoutMs).catch(() => {});
}

/** Concise summary of ready fallback CLI agents (and any remaining model groups on `excludeAgentId`). */
export function fallbackAgentsSummary(excludeAgentId?: string, statusMap?: Map<string, AgentStatus>): string {
  const { defs, statuses } = agentStatuses();
  const byId = statusMap ?? new Map(statuses.map((s) => [s.id, s]));
  const parts: string[] = [];

  if (excludeAgentId) {
    const cur = byId.get(excludeAgentId);
    const q = quotaState(cur);
    if (!q.out && q.availableGroups.length) {
      parts.push(
        `other model groups on ${agentName(excludeAgentId)} (${q.availableGroups
          .map((g) => `${g.label}${g.utilization !== undefined ? ` ${Math.round((1 - g.utilization) * 100)}% left` : ''}`)
          .join(', ')})`,
      );
    }
  }

  const others = defs
    .filter((d) => d.id !== excludeAgentId)
    .filter((d) => {
      const st = byId.get(d.id);
      if (!st || st.state === 'not-installed' || st.state === 'needs-login' || st.state === 'error') return false;
      return !quotaState(st).out;
    })
    .map((d) => {
      const st = byId.get(d.id);
      const opts = knownOptionsForAgent(d.id);
      const curModel = opts.find((o) => o.category === 'model' || o.id === 'model')?.currentValue ?? getSettings().agentDefaults?.[d.id]?.model;
      const q = quotaState(st);
      const groupNote = q.availableGroups.length
        ? `, ${q.availableGroups.map((g) => `${g.label} ${g.utilization !== undefined ? `${Math.round((1 - g.utilization) * 100)}% left` : 'ok'}`).join(' / ')}`
        : '';
      return `${d.id} (${d.name}${curModel ? `, model ${curModel}` : ''}${groupNote})`;
    });

  if (others.length) parts.push(`ready agents: ${others.join('; ')}`);
  return parts.length ? `Available fallback — ${parts.join(' · ')}.` : 'No other ready agents with verified quota were found; check list_agents.';
}

/**
 * Verifies that `agentId` is installed, logged in, and not known to be at 100% of its usage limit
 * for `model`. Throws an actionable `ToolError` naming available fallback agents/models if blocked.
 */
export async function assertAgentQuotaAvailable(agentId: string, model?: string): Promise<void> {
  await ensureFreshLimits();
  const { defs, statuses } = agentStatuses();
  if (!defs.some((d) => d.id === agentId)) {
    throw new ToolError(`Unknown agent "${agentId}". Available agents: ${defs.map((d) => d.id).join(', ')}.`);
  }
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const st = byId.get(agentId);
  if (st?.state === 'not-installed') {
    throw new ToolError(`${agentName(agentId)} is not installed. ${fallbackAgentsSummary(agentId, byId)}`);
  }
  if (st?.state === 'needs-login') {
    throw new ToolError(`${agentName(agentId)} needs the user to log in first. ${fallbackAgentsSummary(agentId, byId)}`);
  }
  const effectiveModel =
    model?.trim() ||
    knownOptionsForAgent(agentId).find((o) => o.category === 'model' || o.id === 'model')?.currentValue ||
    getSettings().agentDefaults?.[agentId]?.model;
  const q = quotaState(st, effectiveModel);
  if (q.out) {
    const reset = formatResetTime(q.resetsAt);
    const hitLabel = q.limits.map((l) => l.label).join(', ');
    const windowLabel = hitLabel ? ` (${hitLabel}${reset ? `, ${reset}` : ''})` : reset ? ` (${reset})` : '';
    const scope = effectiveModel && q.otherGroupsLeft.length ? ` for model "${effectiveModel}" (${q.otherGroupsLeft.join(', ')} models still have quota)` : '';
    throw new ToolError(
      `${agentName(agentId)} has reached its usage limit${scope}${windowLabel}. ${fallbackAgentsSummary(agentId, byId)} Choose another agent or model group.`,
    );
  }
}

function formatOptions(opts: ConfigOptionView[], saved: Record<string, string> | undefined): string[] {
  if (!opts.length) {
    const entries = Object.entries(saved ?? {}).filter(([k]) => !k.startsWith('__'));
    return entries.length ? [`  saved defaults: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`] : ['  options: reported once a session starts with this agent'];
  }
  return opts.map((o) => {
    const choices = o.options.map((x) => (x.value === o.currentValue ? `${x.value}*` : x.value)).join(', ');
    return `  ${o.id} (${o.name}): current=${o.currentValue} · choices=[${choices}]`;
  });
}

/** Full catalog of CLI agents, live quota windows, and configurable parameters (`model`, `mode`, `effort`). */
export async function formatAgentCatalog(currentAgentId: string): Promise<string> {
  await ensureFreshLimits(8000);
  const { defs, statuses } = agentStatuses();
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const defaults = getSettings().agentDefaults ?? {};

  const blocks = defs.map((d) => {
    const st = byId.get(d.id);
    const q = quotaState(st);
    const stateLabel = q.out ? 'quota-exceeded' : (st?.state ?? 'unknown');
    const head = `### ${d.id} — ${d.name}${d.id === currentAgentId ? ' (this session)' : ''} · ${stateLabel}${st?.plan ? ` · plan: ${st.plan}` : ''}`;
    const age = st?.limitsAt ? ` (${formatLimitsAge(st.limitsAt).toLowerCase()})` : '';
    // A read that found nothing to count says so honestly ("LM Studio · local model, no limits"), never "not reported".
    const note = st?.limitsNote ? [`  ${st.limits?.length ? 'also' : `limits${age}`}: ${st.limitsNote}`] : [];
    const limitLines = st?.limits?.length ? [`  limits${age}: ${liveLimits(st.limits).map(formatLimitLine).join(' · ')}`, ...note] : note.length ? note : ['  limits: not reported yet'];
    const optLines = formatOptions(knownOptionsForAgent(d.id), defaults[d.id]);
    return [head, ...limitLines, ...optLines].join('\n');
  });

  return [
    'Configured CLI agents in Olympus Coder (* marks current default choice):',
    '',
    blocks.join('\n\n'),
    '',
    'Pass `agent`, `model`, `mode`, `effort`, or `config` to `spawn_subsession`, `configure_subsession`, or `message_subsession`.',
  ].join('\n');
}

export function extractConfigRequest(args: any): SessionConfigRequest {
  const model = typeof args?.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
  const mode = typeof args?.mode === 'string' && args.mode.trim() ? args.mode.trim() : undefined;
  const effort = typeof args?.effort === 'string' && args.effort.trim() ? args.effort.trim() : undefined;
  const config =
    args?.config && typeof args.config === 'object' && !Array.isArray(args.config)
      ? Object.fromEntries(Object.entries(args.config).filter(([, v]) => typeof v === 'string' && String(v).trim()).map(([k, v]) => [k, String(v).trim()]))
      : undefined;
  return { model, mode, effort, ...(config && Object.keys(config).length ? { config } : {}) };
}

export function hasConfigOverrides(req: SessionConfigRequest): boolean {
  return Boolean(req.model || req.mode || req.effort || (req.config && Object.keys(req.config).length));
}

/**
 * Switches an idle/stopped sub-session's CLI agent and/or session parameters (`model`, `mode`, `effort`, `config`),
 * preserving its entire conversation history in place without consuming another `maxPerSession` slot.
 * Optionally sends a follow-up `prompt` right after reconfiguring.
 */
export async function reconfigureSubsession(
  parent: Thread,
  child: Thread,
  args: any,
  opts: { isActive: (id: string) => boolean; clearCancelled: (id: string) => void },
): Promise<string> {
  if (opts.isActive(child.id)) {
    throw new ToolError(`"${child.title}" is still running. Call cancel_subsession or wait_for_subsessions before switching its agent or settings.`);
  }
  const requestedAgent = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined;
  const cfg = extractConfigRequest(args);
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';

  if (!requestedAgent && !hasConfigOverrides(cfg) && !prompt) {
    throw new ToolError('Provide at least one of "agent", "model", "mode", "effort", "config", or "prompt".');
  }

  const targetAgent = requestedAgent ?? child.agentId;
  await assertAgentQuotaAvailable(targetAgent, cfg.model);

  const changes: string[] = [];
  const prevAgent = child.agentId;
  if (requestedAgent && requestedAgent !== prevAgent) {
    switchAgent(child.id, requestedAgent);
    changes.push(`agent: ${agentName(prevAgent)} → ${agentName(requestedAgent)}`);
  }

  const ok = await ensureSession(child.id);
  if (!ok) {
    const sv = sessionView(child.id);
    throw new ToolError(
      sv.status === 'needs-login'
        ? `${agentName(targetAgent)} needs login before it can run. ${fallbackAgentsSummary(targetAgent)}`
        : (sv.error ?? `${agentName(targetAgent)} failed to start. ${fallbackAgentsSummary(targetAgent)}`),
    );
  }

  if (hasConfigOverrides(cfg)) {
    try {
      const res = await configureSession(child.id, cfg);
      if (res.applied.length) changes.push(...res.applied);
    } catch (e: any) {
      throw new ToolError(e?.message ?? String(e));
    }
  }

  const updated = findThread(child.id) ?? child;
  const currentOpts = sessionView(updated.id).configOptions;
  const activeSummary = currentOpts.map((o) => `${o.id}=${o.currentValue}`).join(', ');

  if (prompt) {
    opts.clearCancelled(updated.id);
    void sendPrompt(updated.id, prompt, [], { fromAgent: parent.agentId }).catch(() => {});
    return `Updated "${updated.title}" (${updated.id})${changes.length ? ` [${changes.join(', ')}]` : ''} and sent follow-up task to ${agentName(updated.agentId)}${activeSummary ? ` (${activeSummary})` : ''}. Call wait_for_subsessions to get its report.`;
  }

  return `Updated "${updated.title}" (${updated.id}): ${changes.length ? changes.join(', ') : 'no changes needed'} · active on ${agentName(updated.agentId)}${activeSummary ? ` (${activeSummary})` : ''}. Send its next instruction with message_subsession (or configure_subsession with "prompt").`;
}
