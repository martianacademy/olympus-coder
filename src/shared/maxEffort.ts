/**
 * Shared types, mind-trace extraction, rolling thought-window pruning, and prompt builders for
 * Olympus Coder's Max Effort (Dual-Mind Adversarial Thinking) mode.
 *
 * Pure TypeScript with zero Node/Electron imports so both main and renderer (and unit tests) share one contract.
 */
import type { AgentDef, AgentId, AgentStatus, ThreadItem } from './types';

export interface MaxEffortSettings {
  /** Second frontier model acting as the adversarial mind-critic. Auto-picked from a different family when unset. */
  criticAgentId?: AgentId;
  /** Maximum cross-critique rounds after the initial parallel blind pass (1–4, default 2). */
  maxRounds: number;
  /** Seconds before a spinning thinking turn is interrupted so its partial raw thinking can be critiqued (default 180, 0 = off). */
  watchdogSeconds: number;
}

export interface MaxRoundTrace {
  /** 0 = initial parallel blind pass; 1..N = cross-mind adversarial critique rounds. */
  round: number;
  phase: 'blind' | 'critique';
  solverThought: string;
  solverReply: string;
  solverWatchdog?: boolean;
  criticThought: string;
  criticReply: string;
  criticWatchdog?: boolean;
  solverConverged: boolean;
  criticConverged: boolean;
  durationMs: number;
}

export interface MaxDeliberationItem {
  kind: 'max-deliberation';
  id: string;
  solverAgentId: AgentId;
  criticAgentId: AgentId;
  solverChildId?: string;
  criticChildId?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  phaseLabel: string;
  maxRounds: number;
  converged?: boolean;
  rounds: MaxRoundTrace[];
  error?: string;
  ts: number;
  endedAt?: number;
}

export const DEFAULT_MAX_EFFORT: MaxEffortSettings = {
  maxRounds: 2,
  watchdogSeconds: 180,
};

/** Clamp user-provided Max Effort settings into safe bounds. */
export function normalizeMaxEffort(patch?: Partial<MaxEffortSettings>, base: MaxEffortSettings = DEFAULT_MAX_EFFORT): MaxEffortSettings {
  const roundsRaw = Number(patch?.maxRounds ?? base.maxRounds);
  const maxRounds = Number.isFinite(roundsRaw) ? Math.min(4, Math.max(1, Math.round(roundsRaw))) : base.maxRounds;
  const wdRaw = Number(patch?.watchdogSeconds ?? base.watchdogSeconds);
  const watchdogSeconds = Number.isFinite(wdRaw) ? (wdRaw <= 0 ? 0 : Math.min(600, Math.max(30, Math.round(wdRaw)))) : base.watchdogSeconds;
  const criticAgentId = (patch && 'criticAgentId' in patch ? patch.criticAgentId : base.criticAgentId)?.trim() || undefined;
  return { ...(criticAgentId ? { criticAgentId } : {}), maxRounds, watchdogSeconds };
}

const PREFERRED_CRITIC_ORDER = ['claude', 'antigravity', 'codex', 'olympus', 'qwen-code', 'gemini', 'opencode'];

/**
 * Choose the best default adversarial critic for `solverId`: prefers a ready agent from a DIFFERENT model family
 * so the two minds have uncorrelated blind spots; falls back to `solverId` only when one agent is usable.
 */
export function pickDefaultCriticAgent(solverId: AgentId, defs: AgentDef[], statuses: Record<string, AgentStatus | undefined>): AgentId {
  const usable = defs.filter((d) => {
    const st = statuses[d.id]?.state;
    return st !== 'not-installed' && st !== 'needs-login' && st !== 'error';
  });
  const pool = usable.length ? usable : defs;
  const others = pool.filter((d) => d.id !== solverId);
  if (!others.length) return solverId;
  for (const pref of PREFERRED_CRITIC_ORDER) {
    const hit = others.find((d) => d.id === pref || d.registryId === pref);
    if (hit) return hit.id;
  }
  return others[0].id;
}

/** Trim a long thought trace to a rolling head + tail window so a 50k-char thinking loop never blows up prompt tokens. */
export function clampThoughtWindow(text: string, maxChars = 6000): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const headLen = Math.floor(maxChars * 0.36);
  const tailLen = maxChars - headLen - 40;
  return `${clean.slice(0, headLen).trimEnd()}\n\n… [middle thinking omitted] …\n\n${clean.slice(-tailLen).trimStart()}`;
}

/**
 * Extract both streamed ACP `thought` chunks AND any `<scratchpad>...</scratchpad>` block (used by providers like
 * Anthropic/OpenAI that redact raw chain-of-thought over ACP), plus the clean visible reply outside `<scratchpad>`.
 */
export function extractMindTrace(items: ThreadItem[], maxThoughtChars = 6000): { thought: string; reply: string } {
  const rawThoughts = items
    .filter((i): i is Extract<ThreadItem, { kind: 'thought' }> => i.kind === 'thought' && Boolean(i.text?.trim()))
    .map((i) => i.text.trim())
    .join('\n\n');

  const agentTexts = items
    .filter((i): i is Extract<ThreadItem, { kind: 'agent' }> => i.kind === 'agent' && Boolean(i.text?.trim()))
    .map((i) => i.text.trim());
  const fullAgent = agentTexts.join('\n\n');

  const scratchMatches = [...fullAgent.matchAll(/<scratchpad>([\s\S]*?)<\/scratchpad>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const reply = fullAgent.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, '').trim();

  const combinedThought = [rawThoughts, ...scratchMatches].filter(Boolean).join('\n\n---\n\n');
  return {
    thought: clampThoughtWindow(combinedThought, maxThoughtChars),
    reply: clampThoughtWindow(reply, 4500),
  };
}

/**
 * Strict convergence detector: returns true ONLY when the model explicitly writes `VERDICT: CONVERGED` and does not
 * flag `VERDICT: CONTINUE` or `FATAL_FLAW:` in the same message (prevents premature sycophantic agreement).
 */
export function parseVerdictConverged(reply: string): boolean {
  if (!reply) return false;
  if (/FATAL_FLAW\s*:/i.test(reply)) return false;
  const matches = [...reply.matchAll(/VERDICT\s*:\s*(CONVERGED|CONTINUE)/gi)];
  if (!matches.length) return false;
  return matches[matches.length - 1][1].toUpperCase() === 'CONVERGED';
}

/** Phase-1 prompt: parallel blind thinking with zero peer contamination (prevents anchoring bias). */
export function buildBlindPrompt(problemText: string, role: 'solver' | 'critic'): string {
  const roleLine =
    role === 'solver'
      ? 'Role: Lead Solver (Blind Pass). Derive the strongest candidate solution, bounds, or architecture from first principles.'
      : 'Role: Independent Challenger (Blind Pass). Attack the problem independently from an orthogonal angle and look for counterexamples or hidden traps.';
  return [
    'MAX EFFORT · DUAL-MIND DELIBERATION — ROUND 0 (PARALLEL BLIND THINKING)',
    roleLine,
    'Rules during deliberation:',
    '- Do NOT modify, create, or delete any workspace files. Read-only inspection only.',
    '- Because some providers redact internal chain-of-thought, ALWAYS start your reply with a concise `<scratchpad>...</scratchpad>` block recording: (1) hypotheses & angles you explored, (2) promising sparks you discarded and why, (3) subtle assumptions that could break.',
    '- Outside `<scratchpad>`, present your concrete candidate solution / bounds / proof sketch or technical design.',
    '',
    'Problem:',
    problemText,
  ].join('\n');
}

/** Rolling compact ledger of prior rounds so raw thinking from old rounds is never accumulated in context. */
export function buildCarryoverLedger(rounds: MaxRoundTrace[]): string {
  if (!rounds.length) return '';
  return rounds
    .map((r) => {
      const tag = r.phase === 'blind' ? 'Round 0 (Blind Pass)' : `Round ${r.round} (Critique)`;
      const s = (r.solverReply || r.solverThought).slice(0, 500).replace(/\s+/g, ' ').trim();
      const c = (r.criticReply || r.criticThought).slice(0, 500).replace(/\s+/g, ' ').trim();
      return `- ${tag}:\n  • Solver summary: ${s || '(interrupted during thinking)'}\n  • Critic summary: ${c || '(interrupted during thinking)'}`;
    })
    .join('\n');
}

/** Phase-2 prompt: inspect the peer model's actual raw thinking + scratchpad to break mental ruts & rescue sparks. */
export function buildCritiquePrompt(args: {
  problemText: string;
  round: number;
  maxRounds: number;
  role: 'solver' | 'critic';
  ownPrevReply: string;
  peerName: string;
  peerThought: string;
  peerReply: string;
  peerWatchdog?: boolean;
  ledger: string;
}): string {
  const watchdogNote = args.peerWatchdog
    ? `NOTE: ${args.peerName} hit the Stuck-Thinking Watchdog while spinning in deep casework. Diagnose the exact mental rut in its raw thinking below and rescue any valid spark it prematurely abandoned!`
    : `Inspect ${args.peerName}'s raw thinking and candidate solution below with adversarial rigor.`;

  return [
    `MAX EFFORT · DUAL-MIND MIND-CRITIQUE — ROUND ${args.round} OF ${args.maxRounds}`,
    args.role === 'solver'
      ? 'Role: Lead Solver. Audit the Critic’s raw thinking & objections, defend only what is ironclad, abandon broken assumptions, and synthesize any stronger path.'
      : 'Role: Red-Team Mind-Critic. Do NOT rubber-stamp or politely agree! Audit the Solver’s raw thinking for silent leaps, false bounds, missed edge cases, and prematurely discarded sparks.',
    watchdogNote,
    'Rules:',
    '- Do NOT edit or write any files during deliberation.',
    '- Include a `<scratchpad>...</scratchpad>` block with your updated internal verification and counterexample checks.',
    '- Address specifically: (1) Flaws or silent jumps in peer thinking, (2) Abandoned sparks worth rescuing, (3) Refined solution / proof / architecture.',
    '- End your reply with EXACTLY one verdict line:',
    '  `VERDICT: CONVERGED` — ONLY if zero logical/technical flaws remain and both bounds/claims are verified.',
    '  `VERDICT: CONTINUE` — if you found a flaw, counterexample, or stronger direction that needs refinement.',
    '',
    'Original Problem:',
    args.problemText,
    ...(args.ledger ? ['', 'Prior Rounds Ledger (compact):', args.ledger] : []),
    '',
    `Your Previous Position:\n${args.ownPrevReply || '(none — interrupted in thinking)'}`,
    '',
    `<peer_raw_thinking agent="${args.peerName}">\n${args.peerThought || '(provider hid raw CoT; inspect peer reply below)'}\n</peer_raw_thinking>`,
    '',
    `<peer_reply agent="${args.peerName}">\n${args.peerReply || '(no final reply — interrupted by watchdog during thinking)'}\n</peer_reply>`,
  ].join('\n');
}

/** Phase-3 prompt: hand the distilled Dual-Mind breakthrough to the main-thread Lead Solver for final execution/proof. */
export function buildSynthesisPrompt(args: {
  problemText: string;
  rounds: MaxRoundTrace[];
  converged: boolean;
  solverName: string;
  criticName: string;
}): string {
  const last = args.rounds[args.rounds.length - 1];
  const statusLine = args.converged
    ? `Dual-Mind deliberation CONVERGED after ${args.rounds.length} pass(es) between ${args.solverName} and ${args.criticName}.`
    : `Dual-Mind deliberation completed ${args.rounds.length} pass(es) between ${args.solverName} and ${args.criticName} without full convergence — surface any remaining trade-off honestly.`;

  return [
    `[Max Effort · Dual-Mind Synthesis] ${statusLine}`,
    'Use the verified insights and ruled-out dead-ends below to now deliver the complete, rigorous final solution (or execute and verify the required workspace changes if this is a coding task). Do not mention internal prompt tags like `<scratchpad>` or `VERDICT:` in your user-facing answer.',
    '',
    'Original User Request:',
    args.problemText,
    '',
    `Final ${args.solverName} Position:\n${last?.solverReply || last?.solverThought || ''}`,
    '',
    `Final ${args.criticName} Critique:\n${last?.criticReply || last?.criticThought || ''}`,
  ].join('\n');
}
