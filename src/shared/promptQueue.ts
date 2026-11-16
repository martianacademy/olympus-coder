// Send while busy: messages typed while the agent works (or while its CLI is offline) wait in a per-chat queue, and
// every message Olympus sends carries a WhatsApp-style delivery state. Shared by src/main/promptQueue.ts and the
// renderer (DeliveryTicks.tsx, QueuedMessages.tsx).
import type { AgentStatus, AttachmentView, SessionView } from './types';

/**
 * A message the user sent that Olympus is holding: the agent is offline / starting / needs login, or it is busy with
 * a turn. Kept in the thread (`Thread.queue`) so it survives a restart, and editable or removable until it goes out.
 *
 * Olympus holds it rather than handing it to the agent's own prompt queue: a `session/cancel` (Stop) cancels every
 * prompt the agent has queued (claude-agent-acp `cancelTurns`), and a prompt already at the agent can't be edited.
 */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: AttachmentView[];
  ts: number;
  /** "Send now" was pressed: it goes first, by steering into the running turn or by stopping it. */
  urgent?: boolean;
  /** Written by the main session's agent / by the app (a message `sendPrompt` got while the chat was busy). */
  fromAgent?: string;
  fromApp?: boolean;
}

/** Delivery of a user message that left the queue (or was sent straight away). Old messages have none. */
export interface UserDelivery {
  /** `delivered`: the agent has it (a `session/prompt` went out, or `_session/steering` answered `injected`).
   *  `seen`: the agent produced output after getting it (its turn began / it reacted to the steered message). */
  state: 'delivered' | 'seen';
  /** How it reached the agent: as its own turn, or injected into the turn that was running. */
  via: 'prompt' | 'steer';
  at: number;
  seenAt?: number;
}

/** Why a queued message is still waiting. */
/** `held`: the user pressed Stop, so the queue waits until they send or press "Send now". */
export type QueueReason = 'offline' | 'starting' | 'login' | 'error' | 'busy' | 'held';

/** How "Send now" reaches a running turn: native mid-turn input, or Stop and send. */
export type SendNowStrategy = 'steer' | 'interrupt';

export interface QueuedPromptView extends QueuedPrompt {
  /** 1 = saved in Olympus only (the agent isn't connected); 2 = the agent is connected and gets it after this turn. */
  ticks: 1 | 2;
  reason: QueueReason;
  /** Hover text for the ticks. */
  label: string;
}

export interface PromptQueueView {
  threadId: string;
  items: QueuedPromptView[];
  /** What "Send now" will do with the agent of this chat. */
  sendNow: SendNowStrategy;
}

/** Main → renderer events of this slice (same `desk:event` channel and lock rule as the others). */
export interface PromptQueueEvents {
  'queue:state': PromptQueueView;
}

/** The agent's connection, as far as delivering a message goes. */
export function queueReason(agent: AgentStatus['state'] | undefined, session: SessionView['status'] | undefined, connected: boolean): QueueReason {
  if (agent === 'needs-login' || session === 'needs-login') return 'login';
  if (session === 'error' || agent === 'error' || agent === 'not-installed') return 'error';
  if (session === 'starting' || agent === 'starting' || agent === 'authenticating') return 'starting';
  if (!connected) return 'offline';
  return 'busy';
}

/** Hover text for a queued message's ticks. */
export function queuedLabel(reason: QueueReason, agentName: string): string {
  switch (reason) {
    case 'offline':
      return `Queued — ${agentName} is offline. It goes out when ${agentName} connects.`;
    case 'starting':
      return `Queued — ${agentName} is still starting.`;
    case 'login':
      return `Queued — ${agentName} needs you to log in.`;
    case 'error':
      return `Queued — ${agentName} could not start. Press Retry above.`;
    case 'busy':
      return `Queued — ${agentName} is connected and gets this when the current reply ends.`;
    case 'held':
      return `Held after Stop — ${agentName} is connected. Press Send now to send it.`;
  }
}

/** Hover text for a sent message's ticks. */
export function deliveryLabel(d: UserDelivery, agentName: string): string {
  if (d.state === 'seen') return d.via === 'steer' ? `Seen — ${agentName} picked this up in the running reply.` : `Seen — ${agentName} started on this.`;
  return d.via === 'steer' ? `Delivered into the running reply — ${agentName} hasn't reacted yet.` : `Delivered — ${agentName} has it.`;
}

/**
 * Whether the agent takes mid-turn input through the ACP steering extension (`_session/steering`): advertised as
 * `InitializeResponse._meta.steering.supported` by claude-agent-acp ≥ 0.10x and codex-acp 2.6.0; agy 1.5.8 doesn't.
 */
export function steeringSupported(init: unknown): boolean {
  const meta = (init as { _meta?: { steering?: { supported?: unknown } } } | undefined)?._meta;
  return meta?.steering?.supported === true;
}

/** The outcome of a `_session/steering` request (the adapters answer `injected`, `promptRequired`, `startedNewTurn` or `failed`). */
export type SteerOutcome = 'injected' | 'promptRequired' | 'failed';

export function steerOutcome(res: unknown): SteerOutcome {
  const o = (res as { outcome?: unknown } | undefined)?.outcome;
  // `startedNewTurn` only comes without the `promptRequired` opt-in, which Olympus always sends; treat it as delivered.
  if (o === 'injected' || o === 'startedNewTurn') return 'injected';
  if (o === 'promptRequired') return 'promptRequired';
  return 'failed';
}

/** Request params for `_session/steering`, with the host-owned idle fallback (the content comes back if no turn runs). */
export function steerParams(sessionId: string, prompt: unknown[]) {
  return { sessionId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' as const } } };
}
