/**
 * Max Effort (Dual-Mind Adversarial Thinking) coordinator.
 *
 * Orchestrates two frontier ACP sessions (Lead Solver + Red-Team Mind-Critic) before final synthesis/execution:
 *   1. Parallel Blind Thinking (zero peer contamination — prevents anchoring bias).
 *   2. Stuck-Thinking Watchdog (interrupts runaway solo thinking loops and hands partial raw CoT to the peer critic).
 *   3. Rolling 1-Round Mind-Critique (swaps captured ACP `thought` chunks + `<scratchpad>` traces without context bloat).
 *   4. Final Synthesis & Execution in the parent thread via Lead Solver.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_EFFORT,
  buildBlindPrompt,
  buildCarryoverLedger,
  buildCritiquePrompt,
  buildSynthesisPrompt,
  extractMindTrace,
  normalizeMaxEffort,
  parseVerdictConverged,
  pickDefaultCriticAgent,
  type MaxDeliberationItem,
  type MaxEffortSettings,
  type MaxRoundTrace,
} from '@shared/maxEffort';
import type { AttachmentView, DeskEvents, SessionView, Thread, ThreadItem } from '@shared/types';
import { agentStatuses, cancel, configureSession, ensureSession, preferReadOnlyMode, sendPrompt, sessionView, startPrompt } from './agents';
import { createThread, findThread, getSettings, saveThread, saveThreadNow, threadMeta, updateSettings } from './store';

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};

interface ActiveMaxRun {
  threadId: string;
  item: MaxDeliberationItem;
  solverChildId?: string;
  criticChildId?: string;
  aborted: boolean;
  abortListeners: Set<() => void>;
}

const activeRuns = new Map<string, ActiveMaxRun>();

export function initMaxEffort(fn: Emit): void {
  emit = fn;
}

export function isMaxEffortRunning(threadId: string): boolean {
  return activeRuns.has(threadId);
}

/** Effective Max Effort configuration for a thread (merges global defaults + thread overrides + smart critic fallback). */
export function effectiveMaxEffort(thread: Pick<Thread, 'agentId' | 'maxEffort'>): MaxEffortSettings & { criticAgentId: string } {
  const globalCfg = normalizeMaxEffort(getSettings().maxEffort, DEFAULT_MAX_EFFORT);
  const merged = normalizeMaxEffort(thread.maxEffort, globalCfg);
  const { defs, statuses } = agentStatuses();
  const statusMap = Object.fromEntries(statuses.map((s) => [s.id, s]));
  const validExplicit = merged.criticAgentId && defs.some((d) => d.id === merged.criticAgentId) ? merged.criticAgentId : undefined;
  const criticAgentId = validExplicit ?? pickDefaultCriticAgent(thread.agentId, defs, statusMap);
  return { ...merged, criticAgentId };
}

/** Update per-thread Max Effort settings (and persist as new global defaults for convenience). */
export function updateThreadMaxEffort(threadId: string, patch: Partial<MaxEffortSettings>): MaxEffortSettings & { criticAgentId: string } {
  const t = findThread(threadId);
  const nextGlobal = normalizeMaxEffort(patch, normalizeMaxEffort(getSettings().maxEffort, DEFAULT_MAX_EFFORT));
  updateSettings({ maxEffort: nextGlobal });
  if (!t) {
    const { defs, statuses } = agentStatuses();
    const critic = nextGlobal.criticAgentId ?? pickDefaultCriticAgent(getSettings().defaultAgent, defs, Object.fromEntries(statuses.map((s) => [s.id, s])));
    return { ...nextGlobal, criticAgentId: critic };
  }
  t.maxEffort = normalizeMaxEffort(patch, normalizeMaxEffort(t.maxEffort, nextGlobal));
  saveThreadNow(t);
  emit('thread:meta', threadMeta(t));
  return effectiveMaxEffort(t);
}

function pushSessionState(threadId: string, statusOverride?: SessionView['status']) {
  const base = sessionView(threadId);
  emit('session:state', statusOverride ? { ...base, status: statusOverride } : base);
}

function pushDelibItem(thread: Thread, item: MaxDeliberationItem) {
  thread.updatedAt = Date.now();
  saveThread(thread);
  emit('thread:item', { threadId: thread.id, item: structuredClone(item) });
}

/** Cancel an in-progress Max Effort deliberation and any running Solver/Critic lab sub-sessions. */
export async function cancelMaxEffort(threadId: string): Promise<boolean> {
  const run = activeRuns.get(threadId);
  if (!run) return false;
  run.aborted = true;
  for (const fn of run.abortListeners) fn();
  run.abortListeners.clear();
  activeRuns.delete(threadId);

  const stops: Promise<unknown>[] = [];
  if (run.solverChildId) stops.push(cancel(run.solverChildId).catch(() => {}));
  if (run.criticChildId) stops.push(cancel(run.criticChildId).catch(() => {}));
  await Promise.all(stops);

  const t = findThread(threadId);
  if (t) {
    run.item.status = 'cancelled';
    run.item.phaseLabel = 'Deliberation stopped';
    run.item.endedAt = Date.now();
    pushDelibItem(t, run.item);
    saveThreadNow(t);
  }
  pushSessionState(threadId);
  return true;
}

/** Spawn a read-only deliberation lab child thread visible in the parent's Tasks panel. */
async function createLabChild(parent: Thread, agentId: string, roleLabel: string, problemText: string): Promise<Thread> {
  const { defs } = agentStatuses();
  const name = defs.find((d) => d.id === agentId)?.name ?? agentId;
  const child = createThread(parent.projectId, agentId, {
    title: `${roleLabel} · ${name}`,
    parentId: parent.id,
    secondOpinion: true,
    task: problemText.slice(0, 240),
    mode: parent.mode ?? 'max',
  });
  emit('thread:meta', threadMeta(child));
  try {
    if (await ensureSession(child.id)) {
      await preferReadOnlyMode(child.id).catch(() => {});
      await configureSession(child.id, { effort: 'high' }).catch(() => {});
    }
  } catch {
    /* handled when startPrompt runs */
  }
  return child;
}

/** Run one prompt on a lab child with an optional Stuck-Thinking Watchdog timer and clean abort support. */
async function runChildTurn(
  run: ActiveMaxRun,
  childId: string,
  prompt: string,
  files: AttachmentView[],
  watchdogSeconds: number,
): Promise<{ thought: string; reply: string; watchdog: boolean }> {
  if (run.aborted) return { thought: '', reply: '', watchdog: false };
  const childBefore = findThread(childId);
  const startIdx = childBefore ? childBefore.items.length : 0;
  let watchdog = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const { done } = startPrompt(childId, prompt, files, { fromApp: true });

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    run.abortListeners.add(onAbort);
    if (watchdogSeconds > 0) {
      timer = setTimeout(() => {
        watchdog = true;
        void cancel(childId).finally(() => {
          run.abortListeners.delete(onAbort);
          resolve();
        });
      }, watchdogSeconds * 1000);
    }
    void done.finally(() => {
      if (timer) clearTimeout(timer);
      run.abortListeners.delete(onAbort);
      resolve();
    });
  });

  const childAfter = findThread(childId);
  const slice = childAfter ? childAfter.items.slice(startIdx) : [];
  const trace = extractMindTrace(slice);
  return { thought: trace.thought, reply: trace.reply, watchdog };
}

/** Execute a full Dual-Mind deliberation turn on a `mode === 'max'` thread, then synthesize in the main session. */
export async function runMaxEffortTurn(threadId: string, text: string, files: AttachmentView[] = []): Promise<void> {
  const thread = findThread(threadId);
  if (!thread) return;
  if (activeRuns.has(threadId)) return;

  const cfg = effectiveMaxEffort(thread);
  const { defs } = agentStatuses();
  const solverName = defs.find((d) => d.id === thread.agentId)?.name ?? thread.agentId;
  const criticName = defs.find((d) => d.id === cfg.criticAgentId)?.name ?? cfg.criticAgentId;

  // 1. Append clean user prompt item to parent chat immediately.
  const userItem: ThreadItem = {
    kind: 'user',
    id: randomUUID(),
    agentId: thread.agentId,
    text,
    ts: Date.now(),
    ...(files.length ? { attachments: files } : {}),
    delivery: { state: 'seen', via: 'prompt', at: Date.now() },
  };
  thread.items.push(userItem);
  if (thread.title === 'New chat') {
    thread.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || files[0]?.name || 'Max session';
    emit('thread:meta', threadMeta(thread));
  }
  emit('thread:item', { threadId: thread.id, item: userItem });

  // 2. Append live MaxDeliberationItem right below the user message.
  const delib: MaxDeliberationItem = {
    kind: 'max-deliberation',
    id: randomUUID(),
    solverAgentId: thread.agentId,
    criticAgentId: cfg.criticAgentId,
    status: 'running',
    phaseLabel: `Blind thinking · ${solverName} + ${criticName}`,
    maxRounds: cfg.maxRounds,
    rounds: [],
    ts: Date.now(),
  };
  thread.items.push(delib);

  const run: ActiveMaxRun = {
    threadId,
    item: delib,
    aborted: false,
    abortListeners: new Set(),
  };
  activeRuns.set(threadId, run);
  pushDelibItem(thread, delib);
  pushSessionState(threadId, 'running');

  try {
    const [solverChild, criticChild] = await Promise.all([
      createLabChild(thread, thread.agentId, 'Solver Lab', text),
      createLabChild(thread, cfg.criticAgentId, 'Critic Lab', text),
    ]);
    run.solverChildId = solverChild.id;
    run.criticChildId = criticChild.id;
    delib.solverChildId = solverChild.id;
    delib.criticChildId = criticChild.id;
    pushDelibItem(thread, delib);

    // Phase 1: Parallel Blind Thinking (Round 0)
    const t0 = Date.now();
    const [blindS, blindC] = await Promise.all([
      runChildTurn(run, solverChild.id, buildBlindPrompt(text, 'solver'), files, cfg.watchdogSeconds),
      runChildTurn(run, criticChild.id, buildBlindPrompt(text, 'critic'), files, cfg.watchdogSeconds),
    ]);
    if (run.aborted) return;

    delib.rounds.push({
      round: 0,
      phase: 'blind',
      solverThought: blindS.thought,
      solverReply: blindS.reply,
      ...(blindS.watchdog ? { solverWatchdog: true } : {}),
      criticThought: blindC.thought,
      criticReply: blindC.reply,
      ...(blindC.watchdog ? { criticWatchdog: true } : {}),
      solverConverged: false,
      criticConverged: false,
      durationMs: Date.now() - t0,
    });
    pushDelibItem(thread, delib);

    // Phase 2: Rolling 1-Round Cross-Mind Critique (Rounds 1..maxRounds)
    let converged = false;
    for (let r = 1; r <= cfg.maxRounds; r++) {
      if (run.aborted) return;
      const prev = delib.rounds[delib.rounds.length - 1];
      const ledger = buildCarryoverLedger(delib.rounds.slice(0, -1));
      delib.phaseLabel = `Mind-critique round ${r}/${cfg.maxRounds} · ${solverName} ⇄ ${criticName}`;
      pushDelibItem(thread, delib);

      const rt0 = Date.now();
      const [critS, critC] = await Promise.all([
        runChildTurn(
          run,
          solverChild.id,
          buildCritiquePrompt({
            problemText: text,
            round: r,
            maxRounds: cfg.maxRounds,
            role: 'solver',
            ownPrevReply: prev.solverReply,
            peerName: criticName,
            peerThought: prev.criticThought,
            peerReply: prev.criticReply,
            peerWatchdog: prev.criticWatchdog,
            ledger,
          }),
          [],
          cfg.watchdogSeconds,
        ),
        runChildTurn(
          run,
          criticChild.id,
          buildCritiquePrompt({
            problemText: text,
            round: r,
            maxRounds: cfg.maxRounds,
            role: 'critic',
            ownPrevReply: prev.criticReply,
            peerName: solverName,
            peerThought: prev.solverThought,
            peerReply: prev.solverReply,
            peerWatchdog: prev.solverWatchdog,
            ledger,
          }),
          [],
          cfg.watchdogSeconds,
        ),
      ]);
      if (run.aborted) return;

      const sConv = !critS.watchdog && parseVerdictConverged(critS.reply);
      const cConv = !critC.watchdog && parseVerdictConverged(critC.reply);
      delib.rounds.push({
        round: r,
        phase: 'critique',
        solverThought: critS.thought,
        solverReply: critS.reply,
        ...(critS.watchdog ? { solverWatchdog: true } : {}),
        criticThought: critC.thought,
        criticReply: critC.reply,
        ...(critC.watchdog ? { criticWatchdog: true } : {}),
        solverConverged: sConv,
        criticConverged: cConv,
        durationMs: Date.now() - rt0,
      });
      pushDelibItem(thread, delib);

      if (sConv && cConv) {
        converged = true;
        break;
      }
    }

    if (run.aborted) return;

    // Phase 3: Final Synthesis & Execution on the parent session
    delib.status = 'completed';
    delib.converged = converged;
    delib.phaseLabel = converged ? `Converged · ${solverName} ⇄ ${criticName}` : `Completed ${cfg.maxRounds} critique round(s)`;
    delib.endedAt = Date.now();
    pushDelibItem(thread, delib);
    saveThreadNow(thread);

    activeRuns.delete(threadId);
    const synthPrompt = buildSynthesisPrompt({
      problemText: text,
      rounds: delib.rounds,
      converged,
      solverName,
      criticName,
    });
    await sendPrompt(threadId, synthPrompt, files, { fromApp: true });
  } catch (err: any) {
    if (!run.aborted) {
      delib.status = 'failed';
      delib.error = err?.message ?? String(err);
      delib.phaseLabel = 'Deliberation failed';
      delib.endedAt = Date.now();
      pushDelibItem(thread, delib);
      saveThreadNow(thread);
    }
  } finally {
    activeRuns.delete(threadId);
    pushSessionState(threadId);
  }
}
