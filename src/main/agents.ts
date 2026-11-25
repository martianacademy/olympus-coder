import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable';
import { acpTerminalKey } from '@shared/acpClient';
import { announceAgentWrite, readTextFile, writeTextFile, type FsContext } from './acpClientFs';
import { acpTerminals, acpTerminalStore, applyTerminalMeta, parseTerminalMeta, type TerminalContext } from './acpTerminals';
import { unsavedEditorText } from './editorBuffers';
import type { ClientConnection } from '@agentclientprotocol/sdk/unstable';
import type {
  AttachmentView,
  ContextUsage,
  RateLimitView,
  AgentDef,
  AgentStatus,
  AuthMethodView,
  ConfigOptionView,
  DeskEvents,
  Project,
  SessionView,
  Thread,
  ThreadItem,
  ToolContentView,
} from '@shared/types';
import { toBlocks } from './attachments';
import { chatMediaDir, mapLocations, mapToolContent, splitLocations, toolIdentityOf, toRichContents, type MediaStore } from './acpContent';
import { appendMessageContent } from '@shared/acpContent';
import { insertIndex, lastStreamItem } from '@shared/itemOrder';
import { recordUsage } from './usage';
import { fetchAgyQuota } from './agyQuota';
import { agentEnv, spawnable, which } from './env';
import { buildPreamble, ensureMemory, transcript } from './memory';
import { DEFAULT_CARRYOVER_TRANSCRIPT_CHARS, extractCarryoverMeta, threadHasConversation } from '@shared/freshCarryover';
import { buildGuide, claudeSessionMeta, guideHash, guideUpdate, readSessionGuide, reattachSystemText, sessionSystemPrompt, writeSessionGuide } from './guide';
import { mcpServersFor } from './orchestrator';
import { claimOlympusServerName, sharesMcpRegistry } from '@shared/olympusServer';
import { keepWake, scheduleOf } from './agenttimers';
import { acpServersFor } from './connectors';
import { parseDiffHunks } from '@shared/diffHunks';
import { workspaceProjectId } from '@shared/worktree';
import { applyHunkPatch, changedSince, changes, checkHunkStates, fileDiff, restore, snapshot } from './checkpoints';
import { resolveSkillSlash } from '@shared/skillSlash';
import { getSkill, listSkills } from './skills';
import {
  beginAgentInitiatedTurn,
  drainQueuedPrompts,
  handleAsyncTaskUpdate,
  initAgentInitiated,
  interruptAgentInitiatedTurn,
  noteAgentInitiatedUpdate,
  pauseQueuedPrompts,
  preserveUnknownSessionUpdates,
  stopAsyncTasks,
  unwrapSessionUpdate,
} from './agentInitiated';
import { ensureBootScript, ensureClaudeSdk, sdkBundled, sdkRoot, sdkVersionFor } from './claudeSdk';
import { cliCandidates, pickCli, type CliSpec } from './cliLocate';
import { findThread, getProject, getSecret, getSettings, saveThread, secretVarNamesForAgent, setSecret, sharedRoot, threadMeta, updateSettings } from './store';
import { steerOutcome, steerParams, steeringSupported, type SteerOutcome } from '@shared/promptQueue';
import { enqueue as enqueuePrompt } from './promptQueue';
import {
  cancelNativeSubagent,
  detachNativeSubagentsForConn,
  effectiveAutoApprove,
  handleNativeSubagentUpdate,
  initNativeSubagents,
  maybeMirrorInBandSubagent,
  noteSubagentModel,
  rootUserThread,
} from './nativeSubagents';
import { detachAgySubagents, initAgySubagents, noteAgyParentTurn, noteAgyProcessStarted, onAgyToolEvent } from './agySubagents';
import { forgetAgyIdleTurn } from './agyIdleTurns';
import { initClaudeSubagents, noteClaudeParentTurn } from './claudeSubagents';
import { answerElicitation, cancelElicitations, completeElicitation, createElicitation, initElicitations, type ElicitRuntime } from './elicitation';
import {
  agentTitleFor,
  applyCompactionChunk,
  applyCompactionUpdate,
  applyNotice,
  applyPlanRemoved,
  applyPlanUpdate,
  applySessionFailure,
  applyUserMessageChunk,
  continuesMessage,
  describeError,
  isAuthError,
  isSlashCommand,
  stopReasonText,
  type TurnState,
  type UpdateHost,
} from './sessionUpdates';
import {
  bestEffort,
  closeSession,
  forkSession,
  loadWithReplay,
  mergeReplay,
  reattachOrder,
  replayGates,
  sessionStatus,
  sessionSupport,
  takeForkSource,
} from './acpSessions';
import { setAcpSessionHost } from './acpSessionService';
import { acpMcp, loginLinks, mcpStatus, noteAuthStatus, reapplyProvider, setAcpConfigHost } from './acpConfigService';
import {
  authenticateParams,
  cliLoginArgs,
  cliLogoutArgsFor,
  cliSwitchArgsFor,
  effectiveAuthMethods,
  envForMethods,
  findRejectedExperimentalArg,
  type AgentAuthMeta,
} from './acpAuth';
import { afterSet, configRequest, configView, CONFIG_SESSION_CAPS, defaultsToApply, initialConfigOptions, mapConfigOptions, matchChoice, normalizeValue, withCurrentMode } from './acpConfig';
import { describeServers, mcpStatusFromUpdate, nextCreateAttempt, supportsAcpMcp } from './acpMcp';
import { limitsKindOf, probeCommandFor, ProbeSessions, runProbe, type LimitsKind } from './limitProbe';
import { openCodeDataDir, readOpenCodeCredentials, readOpenCodeLimits } from './providerLimits';
import { LimitsService, type LimitsReadResult } from './limitsService';

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};
export const setEmitter = (fn: Emit) => {
  emit = fn;
};

// ------------------------------------------------------------------ registry

const adapter = (pkg: string) => join(app.getAppPath(), 'node_modules', '@agentclientprotocol', pkg, 'dist', 'index.js');

/**
 * Claude Code and Codex adapters drive the real CLI. Use the one the user installed (so the installer can leave
 * out ~700 MB of CLI binaries); fall back to a copy bundled with the app (dev builds; Codex on Windows/macOS).
 * Installers never ship Claude's binary or Anthropic's SDK (proprietary): see claudeSdk.ts.
 */
const CLI: Record<string, CliSpec & { envVar: string; bundled: string[]; install: string }> = {
  claude: {
    bin: 'claude',
    envVar: 'CLAUDE_CODE_EXECUTABLE',
    bundled: ['@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude'],
    install:
      process.platform === 'win32'
        ? 'Claude Code is not installed. Install it in PowerShell: irm https://claude.ai/install.ps1 | iex  (docs: https://docs.claude.com/en/docs/claude-code)'
        : 'Claude Code is not installed. Install it: curl -fsSL https://claude.ai/install.sh | bash  (or: npm install -g @anthropic-ai/claude-code; docs: https://docs.claude.com/en/docs/claude-code)',
    // Where Anthropic's native installer puts `claude`: found right after installing, before PATH reaches the app.
    dirs: [join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')],
    // npm's Windows shim (`claude`/`claude.cmd`) cannot be spawned by the adapter; the package's real binary can.
    npmExe: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  },
  codex: {
    bin: 'codex',
    envVar: 'CODEX_PATH',
    bundled: ['@openai', `codex-${process.platform}-${process.arch}`],
    install: 'Codex CLI not found. Install it with: npm install -g @openai/codex  (or: brew install codex)',
  },
};

/** The installed CLI to hand to the adapter, if usable. Windows .cmd shims can't be spawned by the adapters, so only .exe counts there. */
function installedCli(id: string): string | null {
  const c = CLI[id];
  if (!c) return null;
  return pickCli(cliCandidates(c, which(c.bin), process.platform, { APPDATA: process.env.APPDATA }), process.platform);
}
const bundledCli = (id: string) => Boolean(CLI[id]) && existsSync(join(app.getAppPath(), 'node_modules', ...CLI[id].bundled));

/**
 * Claude's adapter imports Anthropic's SDK, which installers leave out (claudeSdk.ts): the boot script + downloaded
 * SDK root to start it with, or null when the SDK ships with the app (dev runs, npm-installed headless servers).
 */
function claudeSdkBoot(def: AgentDef): { boot: string; root: string } | null {
  if (def.id !== 'claude' || !def.builtin || process.env.OLYMPUS_CLAUDE_ADAPTER) return null;
  const appPath = app.getAppPath();
  if (sdkBundled(appPath)) return null;
  const userData = app.getPath('userData');
  return { boot: ensureBootScript(userData), root: sdkRoot(userData, sdkVersionFor(appPath)) };
}

/** `command: "@node"` means: run the script with Electron's own Node, so no separate Node install is needed. */
export function builtinAgents(): AgentDef[] {
  return [
    {
      id: 'olympus',
      name: 'Olympus',
      badge: 'OL',
      color: '#f97316',
      description: 'Olympus CLI (oly acp) — connect 500+ models via one OpenRouter, AI Gateway, OpenAI-compatible key, or local Ollama.',
      builtin: true,
      command: process.env.OLYMPUS_CLI_BIN || 'oly',
      args: ['acp'],
      detectBinary: process.env.OLYMPUS_CLI_BIN || 'oly',
      installHint: 'Install Olympus CLI (oly) on your PATH or in ~/.olympus/bin/oly',
    },
    {
      id: 'claude',
      name: 'Claude Code',
      badge: 'CC',
      color: '#d97757',
      description: 'Anthropic Claude Code, via the official ACP adapter.',
      builtin: true,
      command: '@node',
      // OLYMPUS_CLAUDE_ADAPTER: a stand-in adapter script for tests (like OLYMPUS_AGY_BIN), never set in normal use.
      args: [process.env.OLYMPUS_CLAUDE_ADAPTER || adapter('claude-agent-acp')],
      installHint: CLI.claude.install,
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      badge: 'AG',
      color: '#4285f4',
      description: 'Google Antigravity CLI (agy acp).',
      builtin: true,
      command: process.env.OLYMPUS_AGY_BIN || 'agy',
      args: ['acp'],
      detectBinary: process.env.OLYMPUS_AGY_BIN || 'agy',
      installHint: 'Install the Antigravity CLI: https://antigravity.google/docs/cli',
    },
    {
      id: 'codex',
      name: 'Codex',
      badge: 'CX',
      color: '#10a37f',
      description: 'OpenAI Codex, via the official ACP adapter.',
      builtin: true,
      command: '@node',
      args: [adapter('codex-acp')],
      installHint: CLI.codex.install,
    },
  ];
}

export function allAgents(): AgentDef[] {
  return [...builtinAgents(), ...getSettings().customAgents];
}
const agentDef = (id: string) => allAgents().find((a) => a.id === id);
const authMetaOf = (def: AgentDef): AgentAuthMeta => ({ builtin: def.builtin, registryId: def.registryId, command: def.command });

// ------------------------------------------------------------------ one process per agent

class AgentConn {
  proc?: ChildProcess;
  conn?: ClientConnection;
  init?: any;
  starting?: Promise<void>;
  stderr: string[] = [];
  status: AgentStatus;
  /** Set once an agent rejects unstable ACP clientCapabilities (-32602), so retries send baseline v1 capabilities. */
  minimalCaps = false;
  /** Obsolete `--experimental-*` flags rejected by an upgraded CLI binary, stripped automatically on retry. */
  droppedArgs = new Set<string>();
  /** `olympus` server names registered in the running process (agy keeps one MCP registry per process). */
  mcpNames = new Set<string>();

  constructor(public def: AgentDef) {
    this.status = { id: def.id, state: 'unknown', authMethods: [], hasApiKey: false, canLogout: false };
  }

  setStatus(patch: Partial<AgentStatus>) {
    this.status = { ...this.status, ...patch };
    emit('agent:status', this.status);
  }

  installed(): boolean {
    if (CLI[this.def.id] && this.def.builtin) return Boolean(installedCli(this.def.id)) || bundledCli(this.def.id);
    if (this.def.command === '@node') return true;
    return Boolean(which(this.def.detectBinary || this.def.command));
  }

  secretEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of secretVarNamesForAgent(this.def.id)) {
      const v = getSecret(`${this.def.id}:${name}`);
      if (v) env[name] = v;
    }
    for (const m of this.status.authMethods) {
      if (m.envVar) {
        const v = getSecret(`${this.def.id}:${m.envVar}`);
        if (v) env[m.envVar] = v;
      }
    }
    // Before the first initialize we don't know the methods yet; check the usual names too.
    for (const name of ['OLYMPUS_CLOUD_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'OLYMPUS_OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']) {
      const v = getSecret(`${this.def.id}:${name}`);
      if (v) env[name] = v;
    }
    // Every saved variable of the agent's login methods (multi-variable `env_var` and CLI fallback methods included).
    Object.assign(env, envForMethods(this.def.id, this.init?.authMethods, getSecret, authMetaOf(this.def)));
    return env;
  }

  spawnSpec(extraArgs: string[] = []): { command: string; args: string[]; env: Record<string, string> } {
    const base: Record<string, string> = { OLYMPUS_SHARED_DIR: sharedRoot(), ...(this.def.env ?? {}), ...this.secretEnv() };
    const cli = this.def.builtin ? installedCli(this.def.id) : null;
    if (cli) base[CLI[this.def.id].envVar] = cli;
    const activeArgs = this.def.args.filter((a) => !this.droppedArgs.has(a));
    if (this.def.command === '@node') {
      const sdk = claudeSdkBoot(this.def);
      const args = sdk ? [sdk.boot, sdk.root, ...activeArgs, ...extraArgs] : [...activeArgs, ...extraArgs];
      return { command: process.execPath, args, env: agentEnv({ ...base, ELECTRON_RUN_AS_NODE: '1' }) };
    }
    return { ...spawnable(which(this.def.command) ?? this.def.command, [...activeArgs, ...extraArgs]), env: agentEnv(base) };
  }

  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.conn && this.init && !this.conn.signal.aborted) return;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!this.installed()) {
      this.setStatus({ state: 'not-installed', detail: this.def.installHint ?? `${this.def.command} not found (check your PATH).` });
      throw new Error(this.status.detail);
    }
    this.init = undefined;
    this.setStatus({ state: 'starting', detail: undefined });
    if (claudeSdkBoot(this.def)) {
      try {
        await ensureClaudeSdk({ appPath: app.getAppPath(), userData: app.getPath('userData'), onProgress: (detail) => this.setStatus({ state: 'starting', detail }) });
      } catch (e: any) {
        this.setStatus({ state: 'error', detail: `Could not download the Claude Agent SDK: ${e?.message ?? e}` });
        throw e;
      }
    }
    const spec = this.spawnSpec();
    const proc = spawn(spec.command, spec.args, { env: spec.env, cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.stderr = [];
    this.mcpNames = new Set();
    if (this.def.id === 'antigravity') noteAgyProcessStarted(Date.now());
    proc.stderr?.on('data', (d: Buffer) => {
      this.stderr.push(...d.toString().split('\n').filter(Boolean));
      if (this.stderr.length > 300) this.stderr.splice(0, this.stderr.length - 300);
    });
    const spawnError = new Promise<never>((_, reject) => proc.once('error', reject));
    // Only the current process may tear down the connection: after a restart, the old process's
    // late 'exit' event must not close the new one.
    proc.once('exit', (code) => {
      if (this.proc === proc) this.onExit(code);
    });

    const incoming = preserveUnknownSessionUpdates(Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);
    const stream = ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, incoming);
    // Codex also reports failures as typed `sessionFailure` records (shown as error / notice rows) instead of chat text.
    // Claude: `loadReplayEnd` marks the end of a `session/load` history replay (acpSessions.ts ReplayGates).
    const airCapabilities = this.def.id === 'claude'
      ? ['asyncTasks', 'backgroundSubagents', 'loadReplayEnd']
      : this.def.id === 'codex'
        ? ['asyncTasks', 'sessionFailure']
        : undefined;
    this.conn = client({ name: 'agentdesk' })
      .onNotification(methods.client.session.update, ({ params }) => routeUpdate(params))
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => requestPermission(params, signal))
      .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
        // A link during a login (Codex device code) belongs to the login dialog, not to a chat.
        (loginLinks.handles(this.def.id, params) ? loginLinks.request(this.def.id, params, signal) : createElicitation(params, signal)) as any,
      )
      .onNotification(methods.client.elicitation.complete, ({ params }) => {
        if (!loginLinks.complete((params as any)?.elicitationId)) completeElicitation(params);
      })
      // The app's `olympus` tools served on this connection, for agents with `mcpCapabilities.acp`.
      .onRequest(methods.client.mcp.message, acpMcp.handleRequest as any)
      .onRequest(methods.client.fs.readTextFile, ({ params }) => readTextFile(params, fsContext(params?.sessionId)))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => writeTextFile(params, fsContext(params?.sessionId)))
      .onRequest(methods.client.terminal.create, ({ params }) => acpTerminals.create(params, terminalContext(params?.sessionId)))
      .onRequest(methods.client.terminal.output, ({ params }) => acpTerminals.output(params, { sessionId: sessionRuntime(params?.sessionId).sessionId! }))
      .onRequest(methods.client.terminal.waitForExit, ({ params }) => acpTerminals.waitForExit(params, { sessionId: sessionRuntime(params?.sessionId).sessionId! }))
      .onRequest(methods.client.terminal.kill, ({ params }) => acpTerminals.kill(params, { sessionId: sessionRuntime(params?.sessionId).sessionId! }))
      .onRequest(methods.client.terminal.release, ({ params }) => acpTerminals.release(params, { sessionId: sessionRuntime(params?.sessionId).sessionId! }))
      .onNotification('_auth/status_update', (p: unknown) => p, ({ params }) => this.onAuthStatus(params))
      .onNotification('auth/status_update', (p: unknown) => p, ({ params }) => this.onAuthStatus(params))
      .connect(stream);

    const baseCaps = {
      // Agents read and write through Olympus (unsaved editor text, sandboxed) and run commands in its terminals.
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
    };
    const fullCaps = {
      ...baseCaps,
      subagents: {},
      // Plans by id (`plan_update` items / markdown / file, `plan_removed`), notices and context compaction rows.
      plan: {},
      // + boolean session settings (on/off toggles such as Claude's Fast mode).
      session: { notices: {}, compaction: {}, ...CONFIG_SESSION_CAPS },
      // Questions from the agent (Claude's AskUserQuestion, MCP servers' forms) and links to open (MCP OAuth).
      elicitation: { form: {}, url: {} },
      // `terminal_output_delta`: Codex and Claude Code stream their own commands' output in tool-call `_meta`.
      _meta: { terminal_output_delta: true, ...(airCapabilities ? { jetbrains: { air: { version: 1, capabilities: airCapabilities } } } : {}) },
    };
    const sendInit = (caps: any) =>
      this.conn!.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: caps,
        clientInfo: { name: 'olympus-coder', title: 'Olympus Coder', version: app.getVersion() },
      } as any);
    try {
      try {
        this.init = await Promise.race([
          spawnError,
          sendInit(this.minimalCaps ? baseCaps : fullCaps),
          timeout(60_000, 'Agent did not respond within 60s'),
        ]);
      } catch (initErr: any) {
        const errStr = `${initErr?.message ?? ''} ${initErr?.data ?? ''}`;
        if (!this.minimalCaps && (initErr?.code === -32602 || /invalid params|unknown field|extra inputs|unrecognized/i.test(errStr))) {
          this.minimalCaps = true;
          if (this.conn && !this.conn.signal.aborted && this.proc && this.proc.exitCode === null) {
            this.init = await Promise.race([spawnError, sendInit(baseCaps), timeout(60_000, 'Agent did not respond within 60s')]);
          } else {
            this.kill();
            return this.start();
          }
        } else {
          throw initErr;
        }
      }
    } catch (e: any) {
      const detail = `${describeError(e)}\n${this.stderr.slice(-8).join('\n')}`.trim();
      const activeArgs = this.def.args.filter((a) => !this.droppedArgs.has(a));
      const badExp = findRejectedExperimentalArg(activeArgs, `${describeError(e)}\n${this.stderr.join('\n')}`);
      if (badExp) {
        this.droppedArgs.add(badExp);
        this.kill();
        return this.start();
      }
      this.kill();
      const fallbackMethods: AuthMethodView[] = effectiveAuthMethods(this.def.id, undefined, authMetaOf(this.def)).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        flow: m.flow === 'env-vars' ? 'env-vars' : m.flow === 'api-key' ? 'api-key' : m.flow === 'terminal' ? 'terminal' : 'agent',
        envVar: m.vars.length === 1 ? m.vars[0].name : undefined,
      }));
      const savedSecrets = secretVarNamesForAgent(this.def.id);
      this.setStatus({
        state: 'error',
        detail,
        ...(fallbackMethods.length ? { authMethods: fallbackMethods } : {}),
        canLogout: savedSecrets.length > 0 || Boolean(cliLogoutArgsFor(this.def.id, authMetaOf(this.def))),
        hasApiKey: savedSecrets.length > 0,
      });
      throw e;
    }
    const meta = authMetaOf(this.def);
    const detailedMethods = effectiveAuthMethods(this.def.id, this.init.authMethods, meta);
    const authMethods: AuthMethodView[] = detailedMethods.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      flow: (m.flow === 'env-vars' ? 'env-vars' : m.flow === 'api-key' ? 'api-key' : m.flow === 'terminal' ? 'terminal' : 'agent') satisfies AuthMethodView['flow'],
      envVar: m.vars.length === 1 ? m.vars[0].name : undefined,
    }));
    const savedSecrets = secretVarNamesForAgent(this.def.id);
    this.setStatus({
      state: 'ready',
      version: this.init.agentInfo?.version,
      authMethods,
      canLogout: Boolean(this.init.agentCapabilities?.auth?.logout) || savedSecrets.length > 0 || Boolean(cliLogoutArgsFor(this.def.id, meta)),
      hasApiKey: savedSecrets.length > 0 || authMethods.some((m) => m.envVar && Boolean(getSecret(`${this.def.id}:${m.envVar}`))),
    });
    // Model provider routing lives in the agent process only: send the saved one again after every start.
    const conn = this.conn;
    void reapplyProvider(this.def.id, conn.agent as any, this.init.agentCapabilities).then((err) => {
      if (err) this.stderr.push(`[olympus] saved model provider refused: ${err}`);
    });
  }

  private onAuthStatus(params: any) {
    noteAuthStatus(this.def.id, params);
    const s = params?.authStatus ?? params;
    const kind = s?.kind ?? s?.state;
    if (kind === 'none' || kind === 'unauthenticated') this.setStatus({ state: 'needs-login' });
    // Claude reports the signed-in account and its plan, e.g. "Claude Max".
    const account = (s?.accounts ?? []).find((a: any) => a.active) ?? s?.accounts?.[0];
    if (account?.label && account.label !== this.status.plan) this.setStatus({ plan: account.label });
    if (kind === 'authenticated' && this.status.state === 'needs-login') this.setStatus({ state: 'ready', detail: undefined });
  }

  /** Read this agent's plan limits now (limitsService: Antigravity's daemon, or a hidden `/usage`-style session). */
  async refreshLimits(): Promise<void> {
    await limitsService.refresh(this.def.id, { reason: 'manual', force: true });
  }

  /**
   * Plan limits through the agent's local limits command (Claude `/usage`, Codex `/status`) in a hidden session:
   * never a chat, never in Tasks, updates swallowed by `probeSessions`. null = the agent has no such command.
   */
  async probeLimits(): Promise<LimitsReadResult | null> {
    await this.ensureStarted();
    if ((this.status.state as AgentStatus['state']) === 'needs-login') return { limits: [], loggedOut: true };
    const kind = limitsKindOf(this.def);
    const command = probeCommandFor(this.def.id, advertisedCommands(this.def.id), kind);
    const caps = this.init?.agentCapabilities ?? {};
    const dir = join(app.getPath('userData'), 'limits-probe');
    mkdirSync(dir, { recursive: true });
    const conn = this.conn!;
    const run = () =>
      runProbe({ request: (method, params) => conn.agent.request(method as any, params) }, probeSessions, {
        agentId: this.def.id,
        cwd: dir,
        command,
        canClose: Boolean(caps.sessionCapabilities?.close),
        kind,
        // Olympus CLI keeps every session on disk: delete the probe's instead of leaving one per read.
        deleteAfter: kind === 'olympus' && Boolean(caps.sessionCapabilities?.delete),
        // Claude: keep no transcript of the probe and start none of the user's MCP servers for it.
        meta: command === 'usage' || this.def.id === 'claude' ? { claudeCode: { options: { persistSession: false, strictMcpConfig: true, promptSuggestions: false } } } : undefined,
        timeoutMs: 45_000,
      });
    try {
      return await run();
    } catch (e) {
      // Codex needs one silent re-authentication per process before it opens sessions.
      if (isAuthError(e) && (await this.silentAuth())) return run();
      if (isAuthError(e)) return { limits: [], loggedOut: true };
      throw e;
    }
  }

  /**
   * Antigravity quota: reads `RetrieveUserQuotaSummary` from any running `agy acp` HTTP server or Antigravity IDE hub
   * in ~15 ms (`agyQuota.ts`). On a cold launch where neither is up yet, boots `agy acp` with one silent `session/new`
   * (0 tokens, $0, no MCP servers) so its in-process HTTP server and subscription tier (`_meta.antigravity.tier`) load.
   */
  async probeAgyLimits(): Promise<LimitsReadResult> {
    const fast = await fetchAgyQuota({ preferredPid: this.proc?.pid });
    if (fast) return { limits: fast, ...(this.status.plan ? { plan: this.status.plan } : {}), ...(fast.length ? {} : { empty: true }) };
    if (!this.installed() || this.status.state === 'needs-login') return { limits: [], unavailable: true };

    try {
      await this.ensureStarted();
    } catch (e) {
      if (isAuthError(e)) return { limits: [], loggedOut: true };
      return { limits: [], unavailable: true };
    }
    if ((this.status.state as AgentStatus['state']) === 'needs-login') return { limits: [], loggedOut: true };

    const dir = join(app.getPath('userData'), 'limits-probe');
    mkdirSync(dir, { recursive: true });
    let sid: string | undefined;
    let tier: string | undefined = this.status.plan;
    try {
      const res: any = await Promise.race([
        this.conn!.agent.request('session/new' as any, { cwd: dir, mcpServers: [] }),
        timeout(25_000, 'Opening Antigravity limits session timed out'),
      ]);
      sid = res?.sessionId;
      if (sid) probeSessions.open(sid);
      if (typeof res?._meta?.antigravity?.tier?.name === 'string' && res._meta.antigravity.tier.name) {
        tier = res._meta.antigravity.tier.name;
      }
      for (let i = 0; i < 20; i++) {
        const limits = await fetchAgyQuota({ preferredPid: this.proc?.pid });
        if (limits) return { limits, ...(tier ? { plan: tier } : {}), ...(limits.length ? {} : { empty: true }) };
        await new Promise((r) => setTimeout(r, 400));
      }
      if (tier && tier !== this.status.plan) this.setStatus({ plan: tier });
      return { limits: [], unavailable: true };
    } catch (e) {
      if (isAuthError(e)) return { limits: [], loggedOut: true };
      return { limits: [], unavailable: true };
    } finally {
      if (sid) {
        probeSessions.close(sid);
        if (this.init?.agentCapabilities?.sessionCapabilities?.close) {
          await Promise.race([this.conn!.agent.request('session/close' as any, { sessionId: sid }), timeout(5000, 'Closing Antigravity limits session timed out')]).catch(() => {});
        }
      }
    }
  }

  /** Plan limits from a usage update (Claude sends five-hour and weekly windows). */
  onLimits(meta: any) {
    const rl = meta?.['_claude/rateLimit'];
    const windows = rl?.unifiedWindows;
    if (!windows || typeof windows !== 'object') return;
    const LABEL: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)' };
    const limits: RateLimitView[] = Object.entries(windows).map(([window, w]: [string, any]) => ({
      window,
      // Other agents may send the same shape (the Olympus CLI contract) with their own `label`.
      label: LABEL[window] ?? (typeof w?.label === 'string' && w.label ? w.label.slice(0, 80) : window.replace(/_/g, ' ')),
      utilization: Math.max(0, Math.min(1, Number(w?.utilization ?? 0))),
      resetsAt: w?.resetsAt ? Number(w.resetsAt) * 1000 : undefined,
      status: w?.status,
    }));
    this.setStatus({ limits, limitsAt: Date.now(), limitsError: undefined });
    limitsService.limitsChanged();
  }

  private onExit(code: number | null) {
    const wasLive = this.conn && !this.conn.signal.aborted;
    this.conn?.close();
    this.conn = undefined;
    this.proc = undefined;
    this.detachRuntimes(`Agent process exited (code ${code}).`);
    if (wasLive && this.status.state !== 'needs-login') this.setStatus({ state: 'unknown', detail: `Process exited (${code})` });
  }

  /** Chats using this process start a fresh session on their next message. */
  private detachRuntimes(reason: string) {
    detachNativeSubagentsForConn(this, reason);
    if (this.def.id === 'antigravity') detachAgySubagents(reason);
    for (const rt of runtimes.values()) {
      if (rt.conn === this) {
        rt.conn = undefined;
        cancelElicitations(rt, 'expired');
        // Tools it was still running (including ones it had sent to the background) died with it.
        for (const item of interruptStale(rt.thread)) pushItem(rt, item);
        if (rt.running) {
          rt.running = false;
          addItem(rt, { kind: 'error', id: randomUUID(), agentId: rt.agentId, text: reason, ts: Date.now() });
        }
        if (rt.sessionId) dropSession(rt.sessionId);
        rt.sessionId = undefined;
        rt.status = 'idle';
        pushSession(rt);
        interruptAgentInitiatedTurn(rt);
      }
    }
  }

  kill() {
    const proc = this.proc;
    this.proc = undefined;
    this.conn?.close();
    this.conn = undefined;
    this.detachRuntimes('Agent restarted.');
    proc?.kill();
  }

  /** Best available answer to "is this agent logged in?" without starting a chat. */
  async checkAuth(): Promise<'ok' | 'needs-login' | 'unknown'> {
    await this.ensureStarted();
    if (this.init?.agentCapabilities?.auth?.status) {
      try {
        const r: any = await this.conn!.agent.request('auth/status', {});
        this.onAuthStatus(r);
        if (r?.state === 'unauthenticated') return 'needs-login';
        if (r?.state === 'authenticated') return 'ok';
      } catch {
        /* fall through */
      }
    }
    if (this.def.id === 'codex' && which('codex')) {
      const cmd = spawnable(which('codex')!, ['login', 'status']);
      const ok = await new Promise<boolean>((res) => execFile(cmd.command, cmd.args, { env: agentEnv(), timeout: 15_000 }, (err) => res(!err)));
      if (this.status.hasApiKey) return 'ok';
      return ok ? 'ok' : 'needs-login';
    }
    return 'unknown';
  }

  /** Re-authenticate silently when the CLI is already logged in (Codex needs this once per process). */
  async silentAuth(): Promise<boolean> {
    const status = await this.checkAuth();
    if (status === 'needs-login') return false;
    const detailed = effectiveAuthMethods(this.def.id, this.init?.authMethods, authMetaOf(this.def));
    const apiKeyMethod = detailed.find((m) => !m.synthetic && m.vars.length === 1 && Boolean(getSecret(`${this.def.id}:${m.vars[0].name}`)));
    const method = apiKeyMethod ?? (this.def.id === 'codex' ? detailed.find((m) => m.id === 'chat-gpt') : undefined);
    if (!method) return false;
    try {
      const val = method.vars[0] ? getSecret(`${this.def.id}:${method.vars[0].name}`) : undefined;
      await this.conn!.agent.request(methods.agent.authenticate, authenticateParams(method, val && method.vars[0] ? { [method.vars[0].name]: val } : {}) as any);
      return true;
    } catch {
      return false;
    }
  }
}

const conns = new Map<string, AgentConn>();
function getConn(agentId: string): AgentConn {
  let c = conns.get(agentId);
  const def = agentDef(agentId);
  if (!def) throw new Error(`Unknown agent ${agentId}`);
  if (!c) {
    c = new AgentConn(def);
    conns.set(agentId, c);
  } else c.def = def;
  return c;
}

function timeout(ms: number, msg: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

// ------------------------------------------------------------------ public agent API

export function agentStatuses(): { defs: AgentDef[]; statuses: AgentStatus[] } {
  const defs = allAgents();
  return {
    defs,
    statuses: defs.map((d) => {
      const c = getConn(d.id);
      if (c.status.state === 'unknown' && !c.installed()) c.status = { ...c.status, state: 'not-installed', detail: d.installHint };
      return c.status;
    }),
  };
}

// ------------------------------------------------------------------ plan limits without a chat

/** Hidden sessions that read limits (Claude `/usage`, Codex `/status`); their updates never reach a chat. */
const probeSessions = new ProbeSessions();
/** Slash commands each agent advertised in any session (kept after the chat closes), for `probeCommandFor`. */
const advertised = new Map<string, string[]>();
const advertisedCommands = (agentId: string) => advertised.get(agentId);
const kindOf = (agentId: string): LimitsKind | undefined => {
  const d = agentDef(agentId);
  return d ? limitsKindOf(d) : undefined;
};

/**
 * Keeps every ready agent's limits fresh (see limitsService.ts). Tests run with OLYMPUS_TEST_HIDDEN and poll only
 * the agents named in OLYMPUS_LIMITS_AGENTS, so a test app never reads the real Claude / Codex accounts.
 */
export const limitsService = new LimitsService({
  only: process.env.OLYMPUS_TEST_HIDDEN === '1' ? (process.env.OLYMPUS_LIMITS_AGENTS ?? '').split(',').map((x) => x.trim()).filter(Boolean) : undefined,
  ...(process.env.OLYMPUS_LIMITS_INTERVAL_MS ? { intervalMs: Number(process.env.OLYMPUS_LIMITS_INTERVAL_MS) } : {}),
});
limitsService.setHost({
  agents: () =>
    allAgents().map((d) => {
      const c = getConn(d.id);
      return {
        id: d.id,
        state: c.status.state,
        installed: c.installed(),
        running: Boolean(c.conn && !c.conn.signal.aborted),
        busy: [...runtimes.values()].some((rt) => rt.agentId === d.id && rt.running),
        limits: c.status.limits,
        limitsAt: c.status.limitsAt,
      };
    }),
  reader: (id) => {
    const kind = kindOf(id);
    if (kind === 'antigravity') return 'daemon';
    // OpenCode advertises no limits command (only init/review/goal/compact): read its saved provider logins.
    if (kind === 'opencode') return 'http';
    return probeCommandFor(id, advertisedCommands(id), kind) ? 'probe' : null;
  },
  // Only an agent with a known limits reader (Antigravity, Claude, Codex, Olympus CLI) is started just to read limits,
  // and never when logged out.
  mayStart: (id) => (kindOf(id) === 'antigravity' || Boolean(probeCommandFor(id, undefined, kindOf(id)))) && getConn(id).status.state !== 'needs-login',
  read: async (id, reader) => {
    if (reader === 'daemon') {
      return getConn(id).probeAgyLimits();
    }
    if (reader === 'http') {
      const env = { ...process.env, ...(agentDef(id)?.env ?? {}) };
      const r = await readOpenCodeLimits(readOpenCodeCredentials(openCodeDataDir(env)));
      return { limits: r.limits, note: r.note, plan: r.plan, ...(r.limits.length ? {} : { empty: true }) };
    }
    return getConn(id).probeLimits();
  },
  patch: (id, patch) => getConn(id).setStatus(patch),
  log: (msg) => {
    if (process.env.OLYMPUS_DEBUG_LIMITS) console.log(msg);
  },
});

/** Refresh plan limits for every agent that can report them without a chat (stale ones only unless forced). */
export async function refreshAllLimits(opts: { force?: boolean; maxAgeMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const all = Promise.all(allAgents().map((d) => limitsService.refresh(d.id, { reason: 'ui', force: opts.force, maxAgeMs: opts.maxAgeMs })));
  if (!opts.timeoutMs) return void (await all);
  await Promise.race([all, new Promise<void>((r) => setTimeout(r, opts.timeoutMs))]);
}

/** The refresh button next to an agent's limits: read now (bounded, so the button never spins forever). */
export async function refreshAgentLimits(agentId: string): Promise<AgentStatus> {
  await Promise.race([limitsService.refresh(agentId, { reason: 'button', force: true }), new Promise<void>((r) => setTimeout(r, 50_000))]);
  return getConn(agentId).status;
}

export async function checkAgent(agentId: string): Promise<AgentStatus> {
  const c = getConn(agentId);
  void limitsService.refresh(agentId, { reason: 'check', maxAgeMs: 2 * 60_000 });
  try {
    const r = await c.checkAuth();
    c.setStatus({ state: r === 'needs-login' ? 'needs-login' : 'ready', detail: r === 'unknown' ? 'The agent reports login status on the first chat.' : undefined });
  } catch {
    /* status already set */
  }
  return c.status;
}

/** Agent-handled login (browser opens), or API key. Terminal logins go through pty.ts. */
export async function authenticate(agentId: string, methodId: string, apiKey?: string): Promise<AgentStatus> {
  const c = getConn(agentId);
  await c.ensureStarted();
  const detailed = effectiveAuthMethods(agentId, c.init?.authMethods, authMetaOf(c.def)).find((x) => x.id === methodId);
  const m = c.status.authMethods.find((x) => x.id === methodId);
  const envVar = m?.envVar ?? (detailed?.vars.length === 1 ? detailed.vars[0].name : undefined);
  if (envVar) {
    if (!apiKey) throw new Error('API key required.');
    setSecret(`${agentId}:${envVar}`, apiKey.trim());
    restartAgent(agentId);
    await c.ensureStarted();
    if (detailed?.synthetic) {
      c.setStatus({ state: 'ready', detail: undefined, hasApiKey: true, canLogout: true });
      noteAuthStatus(agentId, { authStatus: { kind: 'api_key', label: 'API key' } });
      return c.status;
    }
  }
  c.setStatus({ state: 'authenticating', detail: m?.flow === 'agent' ? 'Complete the login in your browser…' : undefined });
  try {
    // Links the agent sends meanwhile (Codex device code) show in the login dialog (acpAuth.ts LoginLinks).
    const conn = c.conn!;
    const params = detailed ? authenticateParams(detailed, envVar && apiKey ? { [envVar]: apiKey.trim() } : {}) : { methodId };
    await Promise.race([loginLinks.during(agentId, () => conn.agent.request(methods.agent.authenticate, params as any)), timeout(10 * 60_000, 'Login did not complete within 10 minutes')]);
    c.setStatus({ state: 'ready', detail: undefined, hasApiKey: Boolean(envVar) || c.status.hasApiKey });
  } catch (e: any) {
    if (envVar && e?.code === -32601) {
      c.setStatus({ state: 'ready', detail: undefined, hasApiKey: true, canLogout: true });
    } else {
      c.setStatus({ state: 'needs-login', detail: describeError(e) });
    }
  }
  return c.status;
}

export async function logout(agentId: string): Promise<AgentStatus> {
  const c = getConn(agentId);
  await c.ensureStarted();
  try {
    await c.conn!.agent.request('logout', {});
  } catch (e: any) {
    if (e?.code === -32601) {
      try {
        await c.conn!.agent.request('auth/logout', {});
      } catch {
        /* some agents only support logout from their own CLI */
      }
    }
  }
  for (const name of secretVarNamesForAgent(agentId)) setSecret(`${agentId}:${name}`, null);
  for (const m of c.status.authMethods) if (m.envVar) setSecret(`${agentId}:${m.envVar}`, null);
  for (const name of Object.keys(envForMethods(agentId, c.init?.authMethods, getSecret, authMetaOf(c.def)))) setSecret(`${agentId}:${name}`, null);
  noteAuthStatus(agentId, { state: 'unauthenticated' });
  restartAgent(agentId);
  c.setStatus({ state: 'needs-login', hasApiKey: false, detail: undefined });
  return c.status;
}

export function restartAgent(agentId: string) {
  conns.get(agentId)?.kill();
}

export function terminalLoginSpec(agentId: string, methodId: string) {
  const c = getConn(agentId);
  const meta = authMetaOf(c.def);
  const baseEnv = { OLYMPUS_SHARED_DIR: sharedRoot(), ...(c.def.env ?? {}), ...c.secretEnv(), TERM: 'xterm-256color' };
  if (methodId === '__olympus_cli_logout' || methodId === '__olympus_cli_switch') {
    const cliArgs = methodId === '__olympus_cli_logout' ? cliLogoutArgsFor(agentId, meta) : cliSwitchArgsFor(agentId, meta);
    if (!cliArgs || c.def.command === '@node') throw new Error('This agent does not support interactive CLI account management.');
    const cmd = which(c.def.command) ?? c.def.command;
    const s = spawnable(cmd, cliLoginArgs(cmd, c.def.args, cliArgs));
    return { ...s, env: agentEnv(baseEnv) };
  }
  const m = effectiveAuthMethods(agentId, c.init?.authMethods, meta).find((x) => x.id === methodId);
  if (!m || m.flow !== 'terminal') throw new Error('This is not a terminal login method.');
  const envWithTerm = { ...baseEnv, ...(m.terminalEnv ?? {}) };
  const explicitCmd = m.terminalCommand ? which(m.terminalCommand) : null;
  if (explicitCmd) {
    const s = spawnable(explicitCmd, m.terminalArgs ?? []);
    return { ...s, env: agentEnv(envWithTerm) };
  }
  if (m.replaceAgentArgs && c.def.command !== '@node') {
    const cmd = which(c.def.command) ?? c.def.command;
    const s = spawnable(cmd, cliLoginArgs(cmd, c.def.args, m.terminalArgs ?? []));
    return { ...s, env: agentEnv(envWithTerm) };
  }
  const spec = c.spawnSpec(m.terminalArgs ?? []);
  return { ...spec, env: { ...spec.env, ...(m.terminalEnv ?? {}), TERM: 'xterm-256color' } };
}

export async function afterTerminalLogin(agentId: string): Promise<AgentStatus> {
  restartAgent(agentId);
  return checkAgent(agentId);
}

export function shutdownAgents() {
  for (const c of conns.values()) c.kill();
}

/** `session/close` for every chat's live session (agents that support it), before the app quits. At most `ms`. */
export async function closeAllSessions(ms = 1500): Promise<void> {
  const live = [...runtimes.values()].filter((rt) => rt.sessionId && rt.conn?.conn && !rt.conn.conn.signal.aborted && sessionSupport(rt.conn.init?.agentCapabilities).close);
  if (!live.length) return;
  await Promise.all(live.map((rt) => bestEffort(() => closeSession(rt.conn!.conn!.agent, rt.conn!.init?.agentCapabilities, rt.sessionId!), ms)));
}

// ------------------------------------------------------------------ chat runtimes

interface Runtime {
  thread: Thread;
  agentId: string;
  conn?: AgentConn;
  sessionId?: string;
  status: SessionView['status'];
  error?: string;
  running: boolean;
  configOptions: ConfigOptionView[];
  commands: SessionView['commands'];
  preambleSent: boolean;
  /** The operating guide went in as the ACP system prompt (else it goes in the first message's preamble). */
  guideInSystemPrompt: boolean;
  turn: TurnState;
  toolItems: Map<string, string>;
  pendingPerms: Map<string, (optionId: string | null) => void>;
  /** Open `elicitation/create` requests (questions from the agent), by thread item id. */
  pendingElicits: ElicitRuntime['pendingElicits'];
  ensuring?: Promise<boolean>;
  usage?: ContextUsage;
  /** Session cost already written to the usage log, to log each turn's share only. */
  loggedCost: number;
  /** Config option values to restore onto the next fresh `session/new` (used by `resetContext` to keep model/mode/effort). */
  pendingConfigOverrides?: [string, string][];
  /** A throwaway runtime that renders a `session/load` replay into items: nothing is saved, sent or scheduled. */
  scratch?: boolean;
}

const runtimes = new Map<string, Runtime>();
const bySession = new Map<string, Runtime>();

function runtimeFor(threadId: string): Runtime {
  let rt = runtimes.get(threadId);
  if (!rt) {
    const thread = findThread(threadId);
    if (!thread) throw new Error('Chat not found.');
    rt = {
      thread,
      agentId: thread.agentId,
      status: 'idle',
      running: false,
      configOptions: [],
      commands: [],
      preambleSent: false,
      guideInSystemPrompt: false,
      turn: {},
      toolItems: new Map(),
      pendingPerms: new Map(),
      pendingElicits: new Map(),
      loggedCost: 0,
    };
    runtimes.set(threadId, rt);
  }
  return rt;
}

function pushSession(rt: Runtime) {
  emit('session:state', {
    threadId: rt.thread.id,
    agentId: rt.agentId,
    status: rt.running ? 'running' : rt.status,
    error: rt.error,
    configOptions: rt.configOptions,
    commands: rt.commands,
    usage: rt.usage,
  });
}

const emitTimers = new Map<string, NodeJS.Timeout>();

/** Two ACP `_meta` objects as one (top-level keys belong to different agents, so a shallow merge is enough). */
function mergeMeta(a?: Record<string, unknown>, b?: Record<string, unknown>): { _meta?: Record<string, unknown> } {
  return a || b ? { _meta: { ...(a ?? {}), ...(b ?? {}) } } : {};
}
function pushItem(rt: Runtime, item: ThreadItem, throttle = false) {
  if (rt.scratch) return;
  saveThread(rt.thread);
  const send = () => {
    emitTimers.delete(item.id);
    emit('thread:item', { threadId: rt.thread.id, item });
  };
  if (!throttle) {
    clearTimeout(emitTimers.get(item.id));
    send();
  } else if (!emitTimers.has(item.id)) emitTimers.set(item.id, setTimeout(send, 65));
}

function addItem(rt: Runtime, item: ThreadItem) {
  // The agent's text/steps go above an Olympus confirm card that is still waiting (shared/itemOrder.ts).
  rt.thread.items.splice(insertIndex(rt.thread.items, item), 0, item);
  pushItem(rt, item);
  return item;
}

const subagentHost = {
  runtimeFor: (id: string) => runtimeFor(id),
  bySession: bySession as Map<string, any>,
  addItem: (rt: any, item: ThreadItem) => addItem(rt, item),
  pushItem: (rt: any, item: ThreadItem, throttle?: boolean) => pushItem(rt, item, throttle),
  pushSession: (rt: any) => pushSession(rt),
  interruptStale,
  emitMeta: (meta: any) => emit('thread:meta', meta),
  cancelSession: async (conn: any, sessionId: string) => {
    if (conn?.conn) await conn.conn.agent.notify(methods.agent.session.cancel, { sessionId } as any);
  },
  textOf: (c: any) => textOf(c),
};
initNativeSubagents(subagentHost);
initAgySubagents(subagentHost);
initClaudeSubagents(subagentHost);
initElicitations({
  bySession,
  runtimes: () => runtimes.values(),
  addItem: (rt, item) => addItem(rt as Runtime, item),
  pushItem: (rt, item) => pushItem(rt as Runtime, item),
  forThread: (threadId) => runtimeFor(threadId),
  log: (msg) => console.warn(msg),
});

export function sessionView(threadId: string): SessionView {
  const rt = runtimeFor(threadId);
  return { threadId, agentId: rt.agentId, status: rt.running ? 'running' : rt.status, error: rt.error, configOptions: rt.configOptions, commands: rt.commands, usage: rt.usage };
}

/**
 * The folder a chat works in, as a project record: its git worktree (virtual project id, src/shared/worktree.ts)
 * while one is active, else its project. Session cwd, turn checkpoints (shadow repo keyed by the virtual id),
 * client fs roots and terminals all use this; shared memory stays with the base project (memory.ts memoryDir).
 */
export function workspaceFor(thread: Pick<Thread, 'id' | 'projectId' | 'worktree'>): Project | undefined {
  return getProject(workspaceProjectId(thread));
}

/** Start (or resume) the ACP session for this chat's current agent. */
const warmed = new Set<string>();
export function ensureSession(threadId: string): Promise<boolean> {
  const rt = runtimeFor(threadId);
  // Take the project's first snapshot in the background when a chat opens, so the first turn doesn't wait for it.
  const p = workspaceFor(rt.thread);
  if (p && !warmed.has(p.id)) {
    warmed.add(p.id);
    void snapshot(p.id, p.path, 'baseline');
  }
  if (rt.sessionId && rt.conn?.conn && !rt.conn.conn.signal.aborted) return Promise.resolve(true);
  if (!rt.ensuring) rt.ensuring = doEnsure(rt).finally(() => (rt.ensuring = undefined));
  return rt.ensuring;
}

async function doEnsure(rt: Runtime): Promise<boolean> {
  const project = workspaceFor(rt.thread);
  if (!project) throw new Error(rt.thread.worktree ? `This chat's git worktree is missing: ${rt.thread.worktree.path}` : 'Project not found.');
  rt.status = 'starting';
  rt.error = undefined;
  pushSession(rt);
  const c = getConn(rt.agentId);
  try {
    await c.ensureStarted();
  } catch (e: any) {
    rt.status = 'error';
    rt.error = c.status.detail ?? e?.message;
    pushSession(rt);
    return false;
  }
  const auth = await c.checkAuth().catch(() => 'unknown' as const);
  if (auth === 'needs-login') {
    c.setStatus({ state: 'needs-login' });
    rt.status = 'needs-login';
    pushSession(rt);
    return false;
  }

  const memDir = ensureMemory(project);
  const caps = c.init?.agentCapabilities ?? {};
  const supportsDirs = Boolean(caps.sessionCapabilities?.additionalDirectories);
  const plain: any = {
    cwd: project.path,
    mcpServers: [] as any[],
    ...(supportsDirs ? { additionalDirectories: [memDir] } : {}),
    ...claudeSessionMeta(rt.agentId, memDir, Boolean(rt.thread.spawnedBy)),
  };
  // Every session gets the app's `olympus` MCP server (session info, and sub-session tools for a main session),
  // and the operating guide as a system prompt where the agent supports ACP `systemPrompt`. The server name is
  // claimed before the guide is built: the guide tells the agent which server is its own.
  let mcpServers: any[] = [];
  let guide = '';
  let base: any = plain;
  let olympusName = '';
  // What a refused `session/new` made the app leave out (acpMcp.ts nextCreateAttempt): those stay out of rebuilds.
  const droppedServers: { name: string; reason: string }[] = [];
  const retryNotes: string[] = [];
  let systemPromptOn = true;
  const buildRequest = async (serverName: string) => {
    olympusName = serverName;
    // Agents that host MCP over the ACP connection get the tools there (`mcp/message`); others an HTTP / stdio entry.
    const own = supportsAcpMcp(caps) && c.conn
      ? [await acpMcp.declare(c.conn.agent, rt.thread.id, serverName)]
      : await mcpServersFor(rt.thread.id, caps, serverName).catch(() => []);
    const left = new Set(droppedServers.map((d) => d.name));
    mcpServers = [...own, ...acpServersFor(rt.agentId, caps)].filter((sv) => !left.has(sv?.name));
    guide = getSettings().injectSharedContext ? buildGuide(project, rt.thread, rt.agentId) : '';
    const sysPrompt = systemPromptOn ? sessionSystemPrompt(guide, caps) : undefined;
    base = { ...plain, mcpServers, ...(sysPrompt ?? {}), ...mergeMeta(plain._meta, (sysPrompt as any)?._meta) };
    rt.guideInSystemPrompt = Boolean(sysPrompt);
  };
  await buildRequest(claimOlympusServerName(rt.agentId, rt.thread.id, c.mcpNames));
  const support = sessionSupport(caps);
  /** The agent's own choices for new sessions, sent with `session/new` when it accepts initial values (`session/options`). */
  // Typed by the options last seen for this agent: toggles go as `{ type: 'boolean', value }` (acpConfig.ts).
  const initialConfig = support.options ? initialConfigOptions(getSettings().agentDefaults?.[rt.agentId], knownOptionsForAgent(rt.agentId)) : [];

  /** The system prompt a resumed or loaded session was sent (undefined: none). */
  let reattachedWith: string | undefined;
  const createOnce = async (): Promise<any> => {
    const previous = rt.thread.acpSessions[rt.agentId];
    // A chat that shows no history yet (an import) prefers `session/load`: its replay is the only way to show it.
    const wantHistory = !rt.thread.items.some((i) => i.kind === 'user' || i.kind === 'agent');
    const status = previous && support.status ? await sessionStatus(c.conn!.agent, caps, previous) : undefined;
    const prior = previous ? readSessionGuide(previous) : undefined;
    for (const kind of reattachOrder(support, { previous, status, wantHistory })) {
      // The session's own system prompt, byte for byte (guide.ts reattachSystemText); guide changes since then go
      // with the next prompt as a compact update.
      reattachedWith = reattachSystemText(prior, guide, systemPromptOn ? caps : undefined, rt.agentId);
      const req = { ...plain, mcpServers, ...(reattachedWith ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: reattachedWith }] } } : {}) };
      try {
        if (kind === 'resume') {
          const r: any = await c.conn!.agent.request('session/resume', { ...req, sessionId: previous });
          rt.preambleSent = true; // the agent already has this chat's history
          return { ...r, sessionId: previous, __resumed: true };
        }
        // Updates that are state, not history (commands, mode, usage), reach this chat while the replay loads.
        bySession.set(previous!, rt);
        const { response, updates } = await loadWithReplay(c.conn!.agent, caps, { ...req, sessionId: previous! });
        const replayed = renderReplay(rt, updates);
        // An imported chat's user messages are the user's own turns, not messages injected by the agent.
        if (wantHistory) for (const item of replayed) if (item.kind === 'user') delete item.viaAgent;
        for (const item of mergeReplay(rt.thread.items, replayed)) addItem(rt, item);
        rt.preambleSent = true;
        return { ...response, sessionId: previous, __resumed: true };
      } catch {
        if (kind === 'load' && rt.sessionId !== previous && bySession.get(previous!) === rt) bySession.delete(previous!);
        // Fall back to a new session with the transcript in the preamble. The failed resume may already have
        // registered this chat's server in a shared registry (agy), where the same name again would be renamed:
        // the new session gets a name of its own, and a guide that names it.
        if (base !== plain && sharesMcpRegistry(rt.agentId)) await buildRequest(claimOlympusServerName(rt.agentId, rt.thread.id, c.mcpNames));
      }
    }
    // A chat forked at its end continues a copy of the parent's agent session (its real context, not a text replay).
    const fork = takeForkSource(rt.thread.id, rt.agentId);
    if (fork && support.fork) {
      try {
        const r = await forkSession(c.conn!.agent, caps, { ...base, sessionId: fork.sessionId });
        rt.preambleSent = true;
        return { ...r.response, sessionId: r.sessionId, __forked: true };
      } catch (e: any) {
        c.stderr.push(`[olympus] session/fork of ${fork.sessionId} failed (${e?.message ?? e}); starting a new session`);
      }
    }
    rt.preambleSent = false;
    return c.conn!.agent.request(methods.agent.session.new, (initialConfig.length ? { ...base, configOptions: initialConfig } : base) as any);
  };
  /**
   * An agent that rejects the extras still gets a working session, without as little as possible: the server
   * its error names, the servers of a transport it refused, then the system prompt, then the connectors, and
   * only then every server (acpMcp.ts nextCreateAttempt). Each step is told in the chat.
   */
  const create = async (): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await createOnce();
      } catch (e: any) {
        if (isAuthError(e) || attempt >= 6) throw e;
        const next = nextCreateAttempt(e, { servers: mcpServers, systemPrompt: rt.guideInSystemPrompt }, olympusName);
        if (!next) throw e;
        c.stderr.push(`[olympus] session/new refused (${e?.message ?? e}); ${next.note}`);
        droppedServers.push(...next.dropped);
        retryNotes.push(next.note);
        systemPromptOn = next.systemPrompt;
        const keepOwn = next.servers.some((sv) => sv?.name === olympusName);
        // A shared MCP registry (agy) may already hold the refused session's name: a fresh one for the retry.
        await buildRequest(keepOwn && sharesMcpRegistry(rt.agentId) ? claimOlympusServerName(rt.agentId, rt.thread.id, c.mcpNames) : olympusName);
        if (!keepOwn) {
          mcpServers = mcpServers.filter((sv) => sv?.name !== olympusName);
          base = { ...base, mcpServers };
        }
      }
    }
  };

  let res: any;
  try {
    res = await create();
  } catch (e: any) {
    if (isAuthError(e) && (await c.silentAuth())) {
      try {
        res = await create();
      } catch (e2: any) {
        e = e2;
      }
    }
    if (!res) {
      const detail = describeError(e);
      if (isAuthError(e)) {
        c.setStatus({ state: 'needs-login', detail });
        rt.status = 'needs-login';
        rt.error = detail;
      } else {
        rt.status = 'error';
        rt.error = detail;
      }
      pushSession(rt);
      return false;
    }
  }
  if (rt.sessionId && rt.sessionId !== res.sessionId) dropSession(rt.sessionId);
  else if (rt.sessionId) bySession.delete(rt.sessionId);
  if (rt.sessionId !== res.sessionId) {
    rt.usage = undefined;
    rt.loggedCost = 0;
  }
  rt.sessionId = res.sessionId;
  rt.conn = c;
  const tier = res._meta?.antigravity?.tier?.name;
  if (tier && tier !== c.status.plan) c.setStatus({ plan: tier });
  bySession.set(res.sessionId, rt);
  rt.thread.acpSessions[rt.agentId] = res.sessionId;
  saveThread(rt.thread);
  rt.configOptions = configView(res);
  if (rt.configOptions.length) knownAgentConfigs.set(rt.agentId, rt.configOptions);
  // The chat's MCP servers: what this session got, and what was left out on the way (and why).
  const at = Date.now();
  mcpStatus.begin(rt.thread.id, rt.agentId, [
    ...describeServers(mcpServers, olympusName, at),
    ...droppedServers.map((d) => ({ name: d.name, source: (d.name === olympusName ? 'olympus' : 'connector') as 'olympus' | 'connector', transport: 'stdio' as const, state: 'dropped' as const, reason: d.reason, at })),
  ], { acpTransport: supportsAcpMcp(caps) });
  for (const note of retryNotes) addItem(rt, { kind: 'notice', id: randomUUID(), agentId: rt.agentId, severity: 'warning', title: 'Session started with less', description: note, ts: Date.now() });
  // A brand-new session starts with the settings last chosen for this agent (a resumed one keeps its own).
  // What guide this ACP session has (guide.ts SessionGuide): a new or forked session got the current one as its system
  // prompt (or gets it in the first message); a reattached one keeps its record, or starts one from what it was sent.
  if (guide && !rt.scratch) {
    if (!res.__resumed) {
      writeSessionGuide(res.sessionId, rt.guideInSystemPrompt ? { system: guide, current: guide } : { system: '', current: '' });
      if (rt.guideInSystemPrompt) rt.thread.guideHash = guideHash(guide);
    } else if (!readSessionGuide(res.sessionId)) {
      const had = reattachedWith ?? (rt.thread.guideHash === guideHash(guide) ? guide : '');
      writeSessionGuide(res.sessionId, { system: reattachedWith ?? '', current: had });
      if (reattachedWith) rt.thread.guideHash = guideHash(guide);
    }
    saveThread(rt.thread);
  }
  const configOverrides = rt.pendingConfigOverrides;
  rt.pendingConfigOverrides = undefined;
  if (!res.__resumed && !res.__forked) {
    const toApply: [string, string][] = configOverrides?.length
      ? configOverrides
      : defaultsToApply(getSettings().agentDefaults?.[rt.agentId], rt.configOptions);
    for (const [id, value] of toApply) await applyConfig(rt, id, value).catch(() => {});
  }
  rt.status = 'idle';
  if (c.status.state !== 'ready') c.setStatus({ state: 'ready', detail: undefined });
  pushSession(rt);
  return true;
}

export function switchAgent(threadId: string, agentId: string): SessionView {
  const rt = runtimeFor(threadId);
  if (rt.agentId === agentId) return sessionView(threadId);
  if (rt.running) throw new Error('Wait for the current reply to finish, or press Stop.');
  if (rt.thread.items.length) {
    addItem(rt, { kind: 'switch', id: randomUUID(), from: rt.agentId, to: agentId, ts: Date.now() });
    // Any older ACP session for `agentId` predates turns handled by the previous agent, so start fresh with the full transcript.
    delete rt.thread.acpSessions[agentId];
  }
  closeRuntimeSession(rt);
  if (rt.sessionId) dropSession(rt.sessionId);
  rt.agentId = agentId;
  rt.thread.agentId = agentId;
  rt.sessionId = undefined;
  rt.conn = undefined;
  rt.preambleSent = false;
  rt.configOptions = [];
  rt.commands = [];
  rt.usage = undefined;
  rt.loggedCost = 0;
  rt.pendingConfigOverrides = undefined;
  rt.status = 'idle';
  rt.error = undefined;
  saveThread(rt.thread);
  emit('thread:meta', threadMeta(rt.thread));
  pushSession(rt);
  void ensureSession(threadId);
  return sessionView(threadId);
}

/**
 * Start a clean ACP session for the SAME agent inside the same chat thread, keeping 100% of visible
 * messages and shadow-git Undo checkpoints intact while dropping bloated raw tool outputs from the
 * agent's context window. The next prompt carries a compact (~2k-4k token) Fresh Context Carryover brief.
 */
export function resetContext(threadId: string): SessionView {
  const rt = runtimeFor(threadId);
  if (rt.running) throw new Error('Wait for the current reply to finish, or press Stop.');
  if (!threadHasConversation(rt.thread.items)) return sessionView(threadId);

  let lastPromptTokens: number | undefined;
  for (let i = rt.thread.items.length - 1; i >= 0; i--) {
    const it = rt.thread.items[i];
    if (it.kind === 'user' && it.usage?.prompt) {
      lastPromptTokens = it.usage.prompt;
      break;
    }
  }
  const previousUsed = rt.usage?.used || lastPromptTokens;
  const previousSize = rt.usage?.size;
  const compact = transcript(rt.thread, DEFAULT_CARRYOVER_TRANSCRIPT_CHARS);
  const meta = extractCarryoverMeta(rt.thread, compact);

  // Preserve the user's current model, mode, and reasoning effort across the fresh session.
  const preservedConfigs: [string, string][] = rt.configOptions
    .filter((o) => o.id && o.currentValue)
    .map((o) => [o.id, o.currentValue]);

  addItem(rt, {
    kind: 'context-reset',
    id: randomUUID(),
    agentId: rt.agentId,
    ts: Date.now(),
    ...(previousUsed ? { previousUsed } : {}),
    ...(previousSize ? { previousSize } : {}),
    estimatedCarryover: meta.estimatedTokens,
    editedFilesCount: meta.editedFiles.length,
  });

  delete rt.thread.acpSessions[rt.agentId];
  closeRuntimeSession(rt);
  if (rt.sessionId) dropSession(rt.sessionId);
  rt.sessionId = undefined;
  rt.conn = undefined;
  rt.preambleSent = false;
  rt.usage = undefined;
  rt.loggedCost = 0;
  rt.pendingConfigOverrides = preservedConfigs.length ? preservedConfigs : undefined;
  rt.status = 'idle';
  rt.error = undefined;
  saveThread(rt.thread);
  emit('thread:meta', threadMeta(rt.thread));
  pushSession(rt);
  void ensureSession(threadId);
  return sessionView(threadId);
}

/** Called after every finished turn (the orchestrator uses it to wake a main session whose sub-sessions are done). */
const turnEndListeners: ((threadId: string) => void)[] = [];
/** Adds a listener for "a chat's turn just ended" (several modules listen). */
export const setTurnEndListener = (fn: (threadId: string) => void) => {
  turnEndListeners.push(fn);
};
const onTurnEnd = (threadId: string) => {
  for (const fn of turnEndListeners)
    try {
      fn(threadId);
    } catch {
      /* one listener must not stop the others */
    }
};

initAgentInitiated({
  addItem: (rt, item) => addItem(rt as Runtime, item),
  pushItem: (rt, item, throttle) => pushItem(rt as Runtime, item, throttle),
  pushSession: (rt) => pushSession(rt as Runtime),
  snapshotBefore: async (rt, label) => {
    const project = workspaceFor((rt as Runtime).thread);
    return project ? snapshot(project.id, project.path, `before: ${label.slice(0, 60)}`) : undefined;
  },
  finishCheckpoint: async (rt, item, before) => {
    const runtime = rt as Runtime;
    const project = workspaceFor(runtime.thread);
    if (project) await finishCheckpoint(runtime, item, project.id, project.path, before);
  },
  onTurnEnd,
  // Antigravity streams work it started itself over ACP: its transcript mirror stays quiet meanwhile (no duplicates).
  onAgentTurn: (rt, running) => noteAgyParentTurn(rt as Runtime, running, { liveAcp: true }),
});

export interface PromptOpts {
  fromAgent?: string;
  fromApp?: boolean;
  /** Sent from the composer or its queue: the message gets delivery ticks (src/main/promptQueue.ts). */
  delivery?: boolean;
}

export async function sendPrompt(threadId: string, text: string, attachments: AttachmentView[] = [], opts: PromptOpts = {}): Promise<void> {
  return startPrompt(threadId, text, attachments, opts).done;
}

/**
 * Starts a turn: the user item is added at once and returned, `done` settles when the turn ends. While a turn runs
 * (the user's, or one the agent started itself) the message waits in the chat's send-while-busy queue instead.
 */
export function startPrompt(threadId: string, text: string, attachments: AttachmentView[] = [], opts: PromptOpts = {}): { item?: ThreadItem; done: Promise<void> } {
  if (!opts.fromApp) freshUserTurnHook?.(threadId);
  const rt = runtimeFor(threadId);
  if (rt.running) {
    enqueuePrompt(threadId, text, attachments, { fromAgent: opts.fromAgent, fromApp: opts.fromApp });
    return { done: Promise.resolve() };
  }
  const userItem: ThreadItem = {
    kind: 'user',
    id: randomUUID(),
    agentId: rt.agentId,
    text,
    ts: Date.now(),
    ...(attachments.length ? { attachments } : {}),
    ...(opts.fromAgent ? { fromAgent: opts.fromAgent } : {}),
    ...(opts.fromApp ? { fromApp: true } : {}),
    ...(opts.delivery ? { delivery: { state: 'delivered' as const, via: 'prompt' as const, at: Date.now() } } : {}),
  };
  const hadHistory = rt.thread.items.some((i) => i.kind === 'user' || i.kind === 'agent');
  addItem(rt, userItem);
  if (rt.thread.title === 'New chat') {
    rt.thread.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || attachments[0]?.name || 'New chat';
    emit('thread:meta', threadMeta(rt.thread));
  }
  rt.running = true;
  rt.turn = {};
  pushSession(rt);
  return { item: userItem, done: runTurn(rt, userItem, text, attachments, hadHistory) };
}

async function runTurn(rt: Runtime, userItem: ThreadItem, text: string, attachments: AttachmentView[], hadHistory: boolean): Promise<void> {
  const threadId = rt.thread.id;
  const project = workspaceFor(rt.thread)!;
  const ok = await ensureSession(threadId);
  if (!ok) {
    rt.running = false;
    // It never reached the agent: no "delivered" ticks.
    if (userItem.kind === 'user' && userItem.delivery) {
      userItem.delivery = undefined;
      pushItem(rt, userItem);
    }
    const reason = rt.error ? ` (${rt.error})` : '';
    const msg = rt.status === 'needs-login' ? `${agentDef(rt.agentId)?.name ?? rt.agentId} needs you to log in${reason}. Press "Login" above, then send the message again.` : (rt.error ?? 'Agent failed to start.');
    addItem(rt, { kind: 'error', id: randomUUID(), agentId: rt.agentId, text: msg, ts: Date.now() });
    pushSession(rt);
    return;
  }

  // Snapshot the project before the agent touches it, for this turn's diff and Undo.
  const before = await snapshot(project.id, project.path, `before: ${text.slice(0, 60)}`);
  if (before) {
    (userItem as any).checkpoint = { before };
    pushItem(rt, userItem);
  }

  const blocks: any[] = [];
  const inject = getSettings().injectSharedContext;
  const guideNow = inject ? buildGuide(project, rt.thread, rt.agentId) : '';
  // An agent command ("/review x") only works as the prompt's first block (Claude Code's local commands need it to
  // be the only one): it goes alone, and the preamble or guide update waits for the next normal message.
  // An Olympus shared skill invocation ("/quantum ...", "/math ...") injects its SKILL.md playbook cleanly instead.
  const skillSlash = resolveSkillSlash(text, rt.commands, { listSkills, getSkill });
  const command = !skillSlash && isSlashCommand(text);
  // The guide this session has (guide.ts SessionGuide): its system prompt never changes, so a newer guide goes as a
  // message, once, with only the sections that changed.
  const had = rt.sessionId ? readSessionGuide(rt.sessionId) : undefined;
  const hadHash = had ? (had.current ? guideHash(had.current) : undefined) : rt.thread.guideHash;
  const noteGuide = () => {
    rt.thread.guideHash = guideHash(guideNow);
    if (had && rt.sessionId) writeSessionGuide(rt.sessionId, { ...had, current: guideNow });
  };
  // The first message carries the guide itself when the agent has no system prompt for it.
  const guideInFirstMessage = !command && !rt.preambleSent && inject && !rt.guideInSystemPrompt;
  if (!command && !rt.preambleSent && inject) {
    blocks.push({ type: 'text', text: buildPreamble(project, { ...rt.thread, items: rt.thread.items.slice(0, -1) }, rt.agentId, hadHistory, guideInFirstMessage ? guideNow : undefined) });
    if (guideInFirstMessage && guideNow) noteGuide();
    (userItem as any).contextAttached = true;
    pushItem(rt, userItem);
  }
  if (!command && guideNow && !guideInFirstMessage && hadHash !== guideHash(guideNow)) {
    const update = guideUpdate(had?.current ?? '', guideNow);
    if (update) blocks.push({ type: 'text', text: update });
    noteGuide();
    if (update) (userItem as any).contextAttached = true;
    pushItem(rt, userItem);
  }
  // The file list is also spelled out in text, mapping `@name -> path` so user `@filename` references resolve unambiguously.
  const list = attachments.length
    ? `\n\nAttached files:\n${attachments.map((a) => `- @${a.name} → ${a.path} (${a.mime})${a.note ? ` — ${a.note}` : ''}`).join('\n')}`
    : '';
  if (skillSlash) blocks.push({ type: 'text', text: skillSlash.skillBlock });
  const promptBody = skillSlash
    ? skillSlash.userText || (attachments.length ? 'Apply the active skill instructions above to the attached files.' : 'Apply the active skill instructions above to this conversation.')
    : command
      ? text.trimStart()
      : text || 'See the attached files.';
  blocks.push({ type: 'text', text: promptBody + list });
  blocks.push(...toBlocks(attachments, rt.conn?.init?.agentCapabilities?.promptCapabilities ?? {}));
  if (!command) rt.preambleSent = true;
  rt.turn.sentTexts = blocks.filter((b) => b.type === 'text').map((b) => b.text);

  const started = Date.now();
  noteAgyParentTurn(rt, true);
  noteClaudeParentTurn(rt, true);
  try {
    const res: any = await rt.conn!.conn!.agent.request(methods.agent.session.prompt, { sessionId: rt.sessionId!, prompt: blocks } as any);
    const turn = logTurnUsage(rt, res);
    attachTurnUsage(rt, userItem, res, turn, Date.now() - started);
    // Codex puts the failure that ended the turn on the response (see applySessionFailure).
    const failure = res?._meta?.jetbrains?.air?.sessionFailure;
    if (failure && applySessionFailure(updateHost, rt, failure)) markNeedsLogin(rt);
    const stopped = stopReasonText(res?.stopReason);
    if (stopped) addItem(rt, { kind: 'error', id: randomUUID(), agentId: rt.agentId, text: stopped, ts: Date.now() });
  } catch (e: any) {
    if (isAuthError(e)) {
      markNeedsLogin(rt);
      rt.sessionId = undefined;
    }
    addItem(rt, { kind: 'error', id: randomUUID(), agentId: rt.agentId, text: describeError(e), ts: Date.now() });
  } finally {
    rt.running = false;
    rt.turn.sentTexts = undefined;
    noteAgyParentTurn(rt, false);
    noteClaudeParentTurn(rt, false);
    limitsService.turnEnded(rt.agentId);
    for (const [id, resolve] of rt.pendingPerms) {
      resolve(null);
      rt.pendingPerms.delete(id);
    }
    pushSession(rt);
    try {
      onTurnEnd(threadId);
    } catch {
      /* listeners must not break the chat */
    }
    if (before) void finishCheckpoint(rt, userItem, project.id, project.path, before);
    drainQueuedPrompts(rt);
  }
}

/**
 * Sends a queued message (src/main/promptQueue.ts): connects first, so a message whose agent can't start stays in the
 * queue (one tick) instead of becoming a failed turn. `busy` = a turn runs; it goes out after it.
 */
export async function deliverPrompt(
  threadId: string,
  text: string,
  attachments: AttachmentView[] = [],
  opts: PromptOpts = {},
): Promise<{ outcome: 'sent' | 'busy' | 'offline'; item?: ThreadItem; done?: Promise<void> }> {
  const rt = runtimeFor(threadId);
  if (rt.scratch) return { outcome: 'offline' };
  if (rt.running) return { outcome: 'busy' };
  const ok = await ensureSession(threadId).catch(() => false);
  if (!ok) return { outcome: 'offline' };
  if (rt.running) return { outcome: 'busy' };
  return { outcome: 'sent', ...startPrompt(threadId, text, attachments, { ...opts, delivery: true }) };
}

/** Whether this chat's agent takes mid-turn input (`_session/steering`, Claude Code and Codex). */
export function canSteer(threadId: string): boolean {
  const rt = runtimes.get(threadId);
  return Boolean(rt && !rt.scratch && steeringSupported(rt.conn?.init));
}

/**
 * "Send now" into the running turn (ACP steering extension). On `injected` the message is added to the chat and the
 * agent's next output starts a new reply below it; `promptRequired` = no turn runs any more (send it normally).
 */
export async function steerPrompt(
  threadId: string,
  text: string,
  attachments: AttachmentView[] = [],
  opts: { fromApp?: boolean } = {},
): Promise<{ outcome: SteerOutcome; item?: ThreadItem }> {
  const rt = runtimes.get(threadId);
  if (!rt || rt.scratch || !rt.sessionId || !rt.conn?.conn || !steeringSupported(rt.conn.init)) return { outcome: 'failed' };
  if (!rt.running) return { outcome: 'promptRequired' };
  const list = attachments.length ? `\n\nAttached files:\n${attachments.map((a) => `- ${a.path} (${a.mime})`).join('\n')}` : '';
  const first = (text || 'See the attached files.') + list;
  const blocks: any[] = [{ type: 'text', text: first }, ...toBlocks(attachments, rt.conn.init?.agentCapabilities?.promptCapabilities ?? {})];
  // The agent may echo the steered message back (`user_message_chunk`): it is already in the chat.
  rt.turn.sentTexts = [...(rt.turn.sentTexts ?? []), first];
  let outcome: SteerOutcome;
  try {
    outcome = steerOutcome(await rt.conn.conn.agent.request('_session/steering', steerParams(rt.sessionId, blocks)));
  } catch {
    outcome = 'failed';
  }
  if (outcome !== 'injected') return { outcome };
  const item: ThreadItem = {
    kind: 'user',
    id: randomUUID(),
    agentId: rt.agentId,
    text,
    ts: Date.now(),
    ...(attachments.length ? { attachments } : {}),
    // A message from Olympus itself (a sub-session's result) shows as the app's, without the user's delivery ticks.
    ...(opts.fromApp ? { fromApp: true as const } : { delivery: { state: 'delivered' as const, via: 'steer' as const, at: Date.now() } }),
  };
  addItem(rt, item);
  // What the agent says next answers this message: a new reply below it, not more of the one above.
  rt.turn.agentItemId = rt.turn.thoughtItemId = rt.turn.agentMsgId = rt.turn.thoughtMsgId = undefined;
  return { outcome, item };
}

/** The agent's CLI state and this chat's session state, for the queue's ticks (`connected` = it can take a prompt). */
export function connectionState(threadId: string): { agent?: AgentStatus['state']; session?: SessionView['status']; connected: boolean } {
  const rt = runtimes.get(threadId);
  const agentId = rt?.agentId ?? findThread(threadId)?.agentId;
  const agent = agentId ? getConn(agentId).status.state : undefined;
  const session = rt?.running ? 'running' : (rt?.status ?? 'idle');
  const live = Boolean(rt?.sessionId && rt.conn?.conn && !rt.conn.conn.signal.aborted);
  return { agent, session, connected: live || (agent === 'ready' && session !== 'starting' && session !== 'error' && session !== 'needs-login') };
}

function markNeedsLogin(rt: Runtime) {
  rt.conn?.setStatus({ state: 'needs-login' });
  rt.status = 'needs-login';
}

let afterCheckpointHook: ((info: { thread: Thread; changedFiles: number }) => void) | undefined;
export const onAfterTurnCheckpoint = (fn: (info: { thread: Thread; changedFiles: number }) => void) => (afterCheckpointHook = fn);

let freshUserTurnHook: ((threadId: string) => void) | undefined;
export const onFreshUserTurn = (fn: (threadId: string) => void) => (freshUserTurnHook = fn);

/** After a turn: the "after" snapshot and what changed, shown under the turn. */
async function finishCheckpoint(rt: Runtime, userItem: ThreadItem, projectId: string, cwd: string, before: string) {
  if (userItem.kind !== 'user') return;
  const after = await snapshot(projectId, cwd, 'after turn');
  if (!after) return;
  const files = await changes(projectId, cwd, before, after).catch(() => []);
  userItem.checkpoint = {
    before,
    after,
    files: files.length,
    added: files.reduce((a, f) => a + f.added, 0),
    removed: files.reduce((a, f) => a + f.removed, 0),
  };
  pushItem(rt, userItem);
  if (files.length > 0) afterCheckpointHook?.({ thread: rt.thread, changedFiles: files.length });
}

export function appendNoticeToThread(
  threadId: string,
  severity: 'info' | 'warning' | 'error',
  title: string,
  description?: string,
) {
  const rt = runtimeFor(threadId);
  addItem(rt, {
    kind: 'notice',
    id: randomUUID(),
    agentId: rt.agentId,
    severity,
    title,
    ...(description ? { description } : {}),
    ts: Date.now(),
  });
}

function turnFor(threadId: string, itemId: string) {
  const rt = runtimeFor(threadId);
  const item = rt.thread.items.find((i) => i.id === itemId);
  if (!item || item.kind !== 'user' || !item.checkpoint?.after) throw new Error('No snapshot for this turn.');
  const project = workspaceFor(rt.thread);
  if (!project) throw new Error('Project not found.');
  return { rt, item, cp: item.checkpoint, project };
}

/** What a turn changed (from its snapshots). */
export async function turnChanges(threadId: string, itemId: string) {
  const { cp, project } = turnFor(threadId, itemId);
  const files = await changes(project.id, project.path, cp.before, cp.after!);
  const paths = files.map((f) => f.path);
  const [diffFromAfter, diffFromBefore] = paths.length
    ? await Promise.all([
        changedSince(project.id, project.path, cp.after!, paths).catch(() => [] as string[]),
        changedSince(project.id, project.path, cp.before, paths).catch(() => paths),
      ])
    : [[], []];
  const afterSet = new Set(diffFromAfter);
  const beforeSet = new Set(diffFromBefore);
  const fileStates: Record<string, 'applied' | 'reverted' | 'partial'> = {};
  for (const p of paths) {
    fileStates[p] = !afterSet.has(p) ? 'applied' : !beforeSet.has(p) ? 'reverted' : 'partial';
  }
  return { files, undone: Boolean(cp.undone), fileStates };
}

export async function turnFileDiff(threadId: string, itemId: string, path: string) {
  const { cp, project } = turnFor(threadId, itemId);
  return fileDiff(project.id, project.path, cp.before, cp.after!, path);
}

/** Diff + per-hunk live working-tree status (`applied`, `reverted`, `modified`) for Turn Review. */
export async function turnFileReview(threadId: string, itemId: string, path: string) {
  const { cp, project } = turnFor(threadId, itemId);
  const diff = await fileDiff(project.id, project.path, cp.before, cp.after!, path);
  const parsed = parseDiffHunks(diff);
  const hunkStates = parsed.hunks.length ? await checkHunkStates(project.id, project.path, parsed.hunks.map((h) => h.patch)) : [];
  return { diff, hunkStates };
}

/** Revert (`to: 'before'`) or re-apply (`to: 'after'`) a single file from a turn's checkpoint. */
export async function turnSetFile(threadId: string, itemId: string, path: string, to: 'before' | 'after') {
  const { rt, cp, project } = turnFor(threadId, itemId);
  if (rt.running) throw new Error('Wait for the agent to finish this turn first.');
  const files = await changes(project.id, project.path, cp.before, cp.after!);
  if (!files.some((f) => f.path === path)) throw new Error('File is not part of this turn.');
  await restore(project.id, project.path, to === 'before' ? cp.before : cp.after!, [path]);
  return turnChanges(threadId, itemId);
}

/** Revert (`action: 'revert'`) or re-apply (`action: 'apply'`) one diff hunk of a file in a turn's checkpoint. */
export async function turnSetHunk(threadId: string, itemId: string, path: string, hunkIndex: number, action: 'revert' | 'apply') {
  const { rt, cp, project } = turnFor(threadId, itemId);
  if (rt.running) throw new Error('Wait for the agent to finish this turn first.');
  const diff = await fileDiff(project.id, project.path, cp.before, cp.after!, path);
  const hunk = parseDiffHunks(diff).hunks[hunkIndex];
  if (!hunk) throw new Error('Diff hunk not found.');
  await applyHunkPatch(project.id, project.path, hunk.patch, action === 'revert');
  const [review, overview] = await Promise.all([turnFileReview(threadId, itemId, path), turnChanges(threadId, itemId)]);
  return { ...review, fileStates: overview.fileStates };
}

/** Before an Undo: the files it would put back, and which of them changed again after the turn. */
export async function undoCheck(threadId: string, itemId: string) {
  const { cp, project } = turnFor(threadId, itemId);
  const files = (await changes(project.id, project.path, cp.before, cp.after!)).map((f) => f.path);
  return { files, changedSince: await changedSince(project.id, project.path, cp.after!, files) };
}

/** Puts the files a turn changed back to how they were before it (a snapshot of now is kept for Redo). */
export async function undoTurn(threadId: string, itemId: string): Promise<void> {
  const { rt, item, cp, project } = turnFor(threadId, itemId);
  if (cp.undone) return;
  if (rt.running) throw new Error('Wait for the agent to finish this turn first.');
  const files = (await changes(project.id, project.path, cp.before, cp.after!)).map((f) => f.path);
  if (!files.length) return;
  const backup = await restore(project.id, project.path, cp.before, files);
  item.checkpoint = { ...cp, undone: backup };
  pushItem(rt, item);
}

/** Brings an undone turn's changes back (the files as they were right before the Undo). */
export async function redoTurn(threadId: string, itemId: string): Promise<void> {
  const { rt, item, cp, project } = turnFor(threadId, itemId);
  if (!cp.undone) return;
  if (rt.running) throw new Error('Wait for the agent to finish first.');
  const files = (await changes(project.id, project.path, cp.before, cp.after!)).map((f) => f.path);
  await restore(project.id, project.path, cp.undone, files);
  item.checkpoint = { ...cp, undone: undefined };
  pushItem(rt, item);
}

export async function cancel(threadId: string) {
  const t = findThread(threadId);
  // Questions still open in this chat (or its sub-agent thread) are answered "cancel" before the session stops.
  const open = runtimes.get(threadId);
  if (open) cancelElicitations(open);
  if (t?.nativeSubagent && (await cancelNativeSubagent(threadId))) return;
  const rt = runtimeFor(threadId);
  pauseQueuedPrompts(rt, true);
  // Commands Olympus runs for this chat's agent stop with the turn (the agent can still read their output).
  acpTerminals.killOwner(threadId);
  try {
    await stopAsyncTasks(rt);
    for (const [id, resolve] of rt.pendingPerms) {
      resolve(null);
      rt.pendingPerms.delete(id);
    }
    if (rt.sessionId && rt.conn?.conn) await rt.conn.conn.agent.notify(methods.agent.session.cancel, { sessionId: rt.sessionId } as any);
  } finally {
    pauseQueuedPrompts(rt, false);
  }
}

const knownAgentConfigs = new Map<string, ConfigOptionView[]>();

/** Last known session config options (model, mode, effort…) reported by an agent. */
export function knownOptionsForAgent(agentId: string): ConfigOptionView[] {
  for (const rt of runtimes.values()) {
    if (rt.agentId === agentId && rt.configOptions.length) return rt.configOptions;
  }
  return knownAgentConfigs.get(agentId) ?? [];
}

/** Sends one session setting to the agent (no saving). */
async function applyConfig(rt: Runtime, configId: string, value: string) {
  const agent = rt.conn!.conn!.agent;
  // `session/set_mode` for a legacy mode; `session/set_config_option` (`{ type: 'boolean', value }` for toggles) otherwise.
  const req = configRequest(rt.sessionId!, rt.configOptions, configId, value);
  const r: any = await agent.request(req.method as any, req.params as any);
  rt.configOptions = afterSet(rt.configOptions, configId, value, r);
  if (rt.configOptions.length) knownAgentConfigs.set(rt.agentId, rt.configOptions);
}

export interface SessionConfigRequest {
  model?: string;
  mode?: string;
  effort?: string;
  config?: Record<string, string>;
}

/**
 * Applies session-scoped config overrides (model, mode, effort, or explicit option ids) to a session
 * WITHOUT overwriting the user's saved global `agentDefaults`. Used by orchestrator sub-session tools.
 */
export async function configureSession(threadId: string, req: SessionConfigRequest): Promise<{ applied: string[]; options: ConfigOptionView[] }> {
  const rt = runtimeFor(threadId);
  if (!(await ensureSession(threadId))) {
    const name = agentDef(rt.agentId)?.name ?? rt.agentId;
    throw new Error(rt.status === 'needs-login' ? `${name} needs login before it can run.` : (rt.error ?? `${name} failed to start.`));
  }
  const agentTitle = agentDef(rt.agentId)?.name ?? rt.agentId;
  const pairs: { label: string; find: () => ConfigOptionView | undefined; value: string }[] = [];
  if (req.model?.trim()) {
    pairs.push({
      label: 'model',
      find: () => rt.configOptions.find((o) => o.category === 'model' || o.id === 'model'),
      value: req.model.trim(),
    });
  }
  if (req.mode?.trim()) {
    pairs.push({
      label: 'mode',
      find: () => rt.configOptions.find((o) => o.category === 'mode' || o.id === '__mode' || o.id === 'mode'),
      value: req.mode.trim(),
    });
  }
  if (req.effort?.trim()) {
    pairs.push({
      label: 'effort',
      find: () => rt.configOptions.find((o) => o.category === 'thought_level' || /^(effort|reasoning_effort|thinking|thought_level)$/i.test(o.id)),
      value: req.effort.trim(),
    });
  }
  if (req.config && typeof req.config === 'object') {
    for (const [k, v] of Object.entries(req.config)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const keyLc = k.trim().toLowerCase();
      pairs.push({
        label: k,
        find: () => rt.configOptions.find((o) => o.id.toLowerCase() === keyLc || o.name.toLowerCase() === keyLc),
        value: v.trim(),
      });
    }
  }
  const applied: string[] = [];
  for (const p of pairs) {
    const opt = p.find();
    if (!opt) {
      const supported = rt.configOptions.map((o) => `${o.id} (${o.name})`).join(', ') || 'none';
      throw new Error(`${agentTitle} does not expose a "${p.label}" setting. Supported settings: ${supported}.`);
    }
    const choice = matchChoice(opt, p.value);
    if (!choice) {
      const valid = opt.options.map((x) => (x.name && x.name !== x.value ? `${x.value} (${x.name})` : x.value)).join(', ');
      throw new Error(`Invalid ${opt.name} "${p.value}" for ${agentTitle}. Available values: ${valid}.`);
    }
    if (opt.currentValue !== choice.value) await applyConfig(rt, opt.id, choice.value);
    applied.push(`${opt.id}=${choice.value}`);
  }
  if (applied.length) pushSession(rt);
  return { applied, options: rt.configOptions };
}

function rememberDefault(agentId: string, key: string, value: string) {
  const all = getSettings().agentDefaults ?? {};
  updateSettings({ agentDefaults: { ...all, [agentId]: { ...(all[agentId] ?? {}), [key]: value } } });
}

/** The user changed a session setting: apply it, and remember it as this agent's default for new chats. */
export async function setConfigOption(threadId: string, configId: string, value: string) {
  const rt = runtimeFor(threadId);
  if (!(await ensureSession(threadId))) return sessionView(threadId);
  await applyConfig(rt, configId, value);
  rememberDefault(rt.agentId, configId, normalizeValue(rt.configOptions.find((o) => o.id === configId), value));
  pushSession(rt);
  return sessionView(threadId);
}

/**
 * "Approve all" for one chat: the app answers its permission requests with allow (deny rules from Settings → Tools
 * still win). Turning it on also approves anything already waiting. Remembered for the agent's next chats.
 */
export function setAutoApprove(threadId: string, on: boolean): boolean {
  const rt = runtimeFor(threadId);
  rt.thread.autoApprove = on;
  saveThread(rt.thread);
  emit('thread:meta', threadMeta(rt.thread));
  rememberDefault(rt.agentId, '__autoApprove', on ? '1' : '0');
  if (on) {
    for (const targetRt of runtimes.values()) {
      if (targetRt.thread.id !== threadId && !(targetRt.thread.nativeSubagent && rootUserThread(targetRt.thread).id === threadId)) continue;
      for (const it of targetRt.thread.items) {
        if (it.kind !== 'permission' || it.resolved || !targetRt.pendingPerms.has(it.id)) continue;
        const allow = it.options.find((o) => o.kind === 'allow_once') ?? it.options.find((o) => o.kind.startsWith('allow'));
        if (allow) resolvePermission(targetRt.thread.id, it.id, allow.optionId);
      }
    }
  }
  return on;
}

/** Whether a new chat with this agent should start with "Approve all" on. */
export const autoApproveDefault = (agentId: string) => getSettings().agentDefaults?.[agentId]?.__autoApprove === '1';

/** For the orchestrator: is this chat's agent working, and is it blocked on the user? */
/**
 * Tools and permission requests that can no longer finish because the agent process that owned them is gone:
 * tools become "interrupted", open permission cards "Expired". Returns the items it changed.
 */
export function interruptStale(thread: Thread): ThreadItem[] {
  const out: ThreadItem[] = [];
  for (const item of thread.items) {
    if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
      item.status = 'interrupted';
      item.endedAt = Date.now();
      out.push(item);
    } else if (item.kind === 'permission' && !item.resolved) {
      item.resolved = 'Expired';
      out.push(item);
    } else if (item.kind === 'elicitation' && !item.resolved) {
      item.resolved = 'expired';
      out.push(item);
    }
  }
  if (out.length) saveThread(thread);
  return out;
}

function extractToolCommandHint(item: Extract<ThreadItem, { kind: 'tool' }>): string | undefined {
  for (const c of item.content) {
    if (c.type === 'diff' || !c.text) continue;
    if (/^Input:(?:\s|$)/.test(c.text)) {
      const raw = c.text.replace(/^Input:\s*/, '').trim();
      if (raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          for (const [k, v] of Object.entries(obj)) {
            if (/^(commandline|command|cmd)$/i.test(k) && typeof v === 'string' && v.trim()) return v.trim();
          }
        } catch {
          /* ignore malformed JSON */
        }
      }
    }
    const fenced = /^```(?:bash|sh|zsh|shell|console)?\n([\s\S]*?)```$/m.exec(c.text.trim());
    if (fenced?.[1]?.trim()) return fenced[1].trim();
  }
  return undefined;
}

/** Stops an in-progress or stuck background tool step (cancelling the active turn if it is still running). */
export async function stopTool(threadId: string, toolItemId: string): Promise<void> {
  const rt = runtimeFor(threadId);
  const item = rt.thread.items.find((i) => i.id === toolItemId);
  if (item?.kind === 'tool') {
    await stopAsyncTasks(rt, item.toolCallId.startsWith('async:') ? item.toolCallId.slice('async:'.length) : item.id);
  }
  if (rt.running) {
    await cancel(threadId).catch(() => {});
  }
  if (item && item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
    item.status = 'interrupted';
    item.endedAt = Date.now();
    saveThread(rt.thread);
    pushItem(rt, item);
  }
}

/** Each running agent process, with the chats it serves and their unfinished tool cards (to match commands to chats). */
export function agentProcesses(): {
  agentId: string;
  pid: number;
  threads: { threadId: string; running: boolean; tools: { id: string; title: string; command?: string }[] }[];
}[] {
  const out: ReturnType<typeof agentProcesses> = [];
  for (const [agentId, c] of conns) {
    const pid = c.proc?.pid;
    if (!pid || c.proc?.exitCode !== null) continue;
    const threads = [...runtimes.values()]
      .filter((rt) => rt.conn === c)
      .map((rt) => ({
        threadId: rt.thread.id,
        running: rt.running,
        tools: rt.thread.items
          .filter((i): i is Extract<ThreadItem, { kind: 'tool' }> => i.kind === 'tool' && (i.status === 'in_progress' || i.status === 'pending'))
          .map((i) => ({ id: i.id, title: i.title, command: extractToolCommandHint(i) })),
      }));
    out.push({ agentId, pid, threads });
  }
  return out;
}

/** What is still working right now, in words, for the quit warning: chats mid-turn and tools left running in the background. */
export function runningWork(): string[] {
  const out: string[] = [];
  for (const rt of runtimes.values()) {
    const name = conns.get(rt.agentId)?.def.name ?? rt.agentId;
    if (rt.running) out.push(`${name} is working: ${rt.thread.title}`);
    else if (rt.conn)
      for (const i of rt.thread.items)
        if (i.kind === 'tool' && (i.status === 'in_progress' || i.status === 'pending')) out.push(`${name}, in the background: ${i.title.split('\n')[0].slice(0, 80)}`);
  }
  return out;
}

/** Every chat that has a live runtime: working, waiting for a permission, or failed — for the sidebar dots. */
export function allRunStates(): { threadId: string; status: string; pendingPermissions: number; permissionIds: string[]; askIds: string[]; background: string[] }[] {
  return [...runtimes.values()].map((rt) => ({
    threadId: rt.thread.id,
    status: rt.running ? 'running' : rt.status,
    pendingPermissions: rt.thread.items.filter((i) => i.kind === 'permission' && !i.resolved).length,
    permissionIds: rt.thread.items.filter((i) => i.kind === 'permission' && !i.resolved).map((i) => i.id),
    // Questions from the agent waiting for an answer; unlike permissions they can outlive a turn (MCP login links).
    askIds: [...rt.pendingElicits.keys()],
    // Tools still running after the turn ended (sent to the agent's background), while its process lives.
    background: rt.conn ? rt.thread.items.filter((i) => i.kind === 'tool' && (i.status === 'in_progress' || i.status === 'pending')).map((i) => i.id) : [],
  }));
}

export function runState(threadId: string): { running: boolean; status: SessionView['status']; error?: string; pendingPermissions: number } {
  const rt = runtimes.get(threadId);
  // A question from the agent blocks it like a permission request does.
  return { running: Boolean(rt?.running), status: rt?.status ?? 'idle', error: rt?.error, pendingPermissions: (rt?.pendingPerms.size ?? 0) + (rt?.pendingElicits.size ?? 0) };
}

/** Chats (main or sub-session) running this agent right now or waiting on the user, e.g. before removing it. */
export function chatsUsingAgent(agentId: string): string[] {
  return [...runtimes.values()]
    .filter((rt) => !rt.scratch && rt.agentId === agentId && (rt.running || rt.pendingPerms.size > 0 || rt.pendingElicits.size > 0))
    .map((rt) => rt.thread.id);
}

/** A spawned sub-session starts with its parent's agent settings (mode, model, effort…) when it runs the same agent. */
/** Switches a chat to its agent's read-only / plan mode when it has one (Claude "plan", Codex "read-only" …). */
export async function preferReadOnlyMode(threadId: string): Promise<boolean> {
  const rt = runtimeFor(threadId);
  if (!rt.conn?.conn) return false;
  for (const o of rt.configOptions) {
    if (o.category !== 'mode' && o.id !== '__mode') continue;
    const v = o.options.find((x) => /\b(plan|read[- ]?only|ask|suggest)\b/i.test(`${x.value} ${x.name}`));
    if (!v) continue;
    if (o.currentValue !== v.value) await applyConfig(rt, o.id, v.value).catch(() => {});
    pushSession(rt);
    return true;
  }
  return false;
}

export async function inheritSettings(fromThreadId: string, toThreadId: string): Promise<void> {
  const from = runtimes.get(fromThreadId);
  const to = runtimeFor(toThreadId);
  if (!from || from.agentId !== to.agentId) return;
  for (const o of from.configOptions) {
    const t = to.configOptions.find((x) => x.id === o.id);
    if (t && t.currentValue !== o.currentValue && t.options.some((v) => v.value === o.currentValue)) {
      await applyConfig(to, o.id, o.currentValue).catch(() => {});
    }
  }
}

export function resolvePermission(threadId: string, itemId: string, optionId: string | null) {
  const rt = runtimeFor(threadId);
  rt.pendingPerms.get(itemId)?.(optionId);
  rt.pendingPerms.delete(itemId);
}

/** The user's answer to a question card: `accept` (with the form's content), `decline` or `cancel`. */
export function resolveElicitation(threadId: string, itemId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown> | null) {
  answerElicitation(runtimeFor(threadId), itemId, action, content);
}

export function forgetThread(threadId: string) {
  const rt = runtimes.get(threadId);
  if (!rt) return;
  closeRuntimeSession(rt);
  if (rt.sessionId) {
    forgetAgyIdleTurn(rt.sessionId);
    dropSession(rt.sessionId);
  }
  runtimes.delete(threadId);
  acpTerminalStore.forgetOwner(threadId);
  mcpStatus.forget(threadId);
  void acpMcp.release(threadId);
}

// ------------------------------------------------------------------ client fs + terminals (acpClientFs.ts, acpTerminals.ts)

/** A session is no longer this app's: its terminals are stopped and released (their output stays in the chat). */
function dropSession(sessionId: string) {
  bySession.delete(sessionId);
  acpTerminals.releaseSession(sessionId);
}

/** The chat behind a client request (`fs/*`, `terminal/*`); unknown sessions are refused. */
function sessionRuntime(sessionId: unknown): Runtime {
  const rt = typeof sessionId === 'string' ? bySession.get(sessionId) : undefined;
  if (!rt || rt.scratch) throw RequestError.sessionNotFound(String(sessionId));
  return rt;
}

function runtimeProject(rt: Runtime) {
  const project = workspaceFor(rt.thread);
  if (!project) throw RequestError.internalError(undefined, 'The project of this chat is gone.');
  return project;
}

/** Sandbox for `fs/*`: the project folder and the session's additional folder (shared memory), plus temp. */
function fsContext(sessionId: unknown): FsContext {
  const project = runtimeProject(sessionRuntime(sessionId));
  return { roots: [project.path, ensureMemory(project)], unsavedText: unsavedEditorText, onWritten: announceAgentWrite };
}

function terminalContext(sessionId: unknown): TerminalContext {
  const rt = sessionRuntime(sessionId);
  const project = runtimeProject(rt);
  return {
    sessionId: rt.sessionId!,
    owner: rt.thread.id,
    defaultCwd: project.path,
    env: agentEnv(),
    // Agents ask the user before a command (session/request_permission); outside a turn nothing is asked, so nothing runs.
    mayRun: () => rt.running || 'Olympus only runs commands while the agent is working on a turn.',
  };
}

/** Last part of a terminal's output kept on its tool card (the box still has it after a restart). */
const MAX_TERMINAL_TEXT = 64_000;

/** Copies a finished terminal's output and exit onto its tool card. */
function saveTerminalResult(item: Extract<ThreadItem, { kind: 'tool' }>, key: string): boolean {
  const m = acpTerminalStore.meta(key);
  if (!m || (!m.exitStatus && !m.released)) return false;
  item.terminalText = acpTerminalStore.tailText(key, MAX_TERMINAL_TEXT) ?? item.terminalText;
  if (m.exitStatus) {
    item.terminalExitCode = m.exitStatus.exitCode;
    if (m.exitStatus.signal) item.terminalSignal = m.exitStatus.signal;
  }
  return true;
}

/**
 * Links a tool card to the terminal behind it: ACP `terminal` content (`terminal/create`) or the
 * `_meta.terminal_*` stream Codex and Claude Code send for their own commands. Live updates go to the
 * terminal store (shown by AcpTerminalBox); a `session/load` replay only rebuilds the saved text on the card.
 */
function attachTerminals(rt: Runtime, item: ThreadItem, u: any) {
  if (item.kind !== 'tool') return;
  const ids: string[] = [];
  for (const c of Array.isArray(u?.content) ? u.content : []) if (c?.type === 'terminal' && typeof c.terminalId === 'string' && c.terminalId) ids.push(c.terminalId);
  if (rt.scratch) {
    for (const t of parseTerminalMeta(u?._meta)) {
      ids.push(t.terminalId);
      const ended = item.terminalExitCode !== undefined;
      if (t.output && !ended) {
        const text = (item.terminalText ?? '') + t.output;
        item.terminalText = text.length > MAX_TERMINAL_TEXT ? text.slice(text.length - MAX_TERMINAL_TEXT) : text;
      }
      if (t.exit && !ended) {
        item.terminalExitCode = t.exit.exitCode;
        if (t.exit.signal) item.terminalSignal = t.exit.signal;
      }
    }
  } else {
    for (const key of applyTerminalMeta(acpTerminalStore, rt.thread.id, u?._meta, u?.rawInput)) ids.push(key.slice(rt.thread.id.length + 1));
  }
  if (!ids.length) return;
  item.terminalKey ??= acpTerminalKey(rt.thread.id, ids[0]);
  if (!rt.scratch && item.terminalText === undefined) saveTerminalResult(item, item.terminalKey);
}

// A terminal ended (or was released) after its card was last updated: save its output on the card.
acpTerminalStore.onChange((m) => {
  if (!m.exitStatus && !m.released) return;
  const rt = runtimes.get(m.owner);
  if (!rt) return;
  for (const item of rt.thread.items) {
    if (item.kind === 'tool' && item.terminalKey === m.key && saveTerminalResult(item, m.key)) pushItem(rt, item);
  }
});

/**
 * Release the agent side of a chat's live session (`session/close`), best effort and in the background. The id
 * stays in `thread.acpSessions`, so the chat can still resume or load it later.
 */
function closeRuntimeSession(rt: Runtime) {
  const sessionId = rt.sessionId;
  const conn = rt.conn;
  if (!sessionId || !conn?.conn || conn.conn.signal.aborted) return;
  const caps = conn.init?.agentCapabilities;
  if (!sessionSupport(caps).close) return;
  void bestEffort(() => closeSession(conn.conn!.agent, caps, sessionId));
}

/**
 * A `session/load` replay as chat items, made by the same code as live updates (applyUpdate) on a throwaway
 * runtime: nothing is saved, sent, scheduled or claimed. Tools still open at the end belonged to a turn that
 * ended long ago, so they show as interrupted.
 */
function renderReplay(rt: Runtime, updates: any[]): ThreadItem[] {
  const scratch: Runtime = {
    thread: { ...rt.thread, items: [], acpSessions: {} },
    agentId: rt.agentId,
    status: 'idle',
    running: true,
    configOptions: [],
    commands: [],
    preambleSent: true,
    guideInSystemPrompt: false,
    turn: {},
    toolItems: new Map(),
    pendingPerms: new Map(),
    pendingElicits: new Map(),
    loggedCost: 0,
    scratch: true,
  };
  const start = Date.now() - updates.length;
  updates.forEach((u, n) => applyUpdate(scratch, u, start + n));
  // Not interruptStale: it saves the thread, and this scratch copy shares the real chat's id.
  for (const item of scratch.thread.items) {
    if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
      item.status = 'interrupted';
      item.endedAt ??= item.ts;
    } else if (item.kind === 'permission' && !item.resolved) item.resolved = 'Expired';
    else if (item.kind === 'elicitation' && !item.resolved) item.resolved = 'expired';
  }
  return scratch.thread.items;
}

// Agent connections for the session lifecycle outside a chat (import list, delete, rename, home options).
/** Connections already given the silent re-auth a chat would do first (Codex needs it once per process). */
const lifecycleAuthed = new WeakSet<object>();
setAcpSessionHost({
  connection: async (agentId, start) => {
    const c = getConn(agentId);
    if (start) await c.ensureStarted();
    if (!c.conn || c.conn.signal.aborted) return null;
    if (start && !lifecycleAuthed.has(c.conn)) {
      lifecycleAuthed.add(c.conn);
      await c.silentAuth().catch(() => false);
      if (c.status.state === 'needs-login') return null;
    }
    return { conn: c.conn.agent, caps: c.init?.agentCapabilities ?? {} };
  },
  configView: (res) => configView(res),
});
setAcpConfigHost({
  connection: async (agentId, start) => {
    const c = getConn(agentId);
    if (start) await c.ensureStarted();
    if (!c.conn || c.conn.signal.aborted) return null;
    return { conn: c.conn.agent as any, caps: c.init?.agentCapabilities ?? {} };
  },
  rawAuthMethods: (agentId) => getConn(agentId).init?.authMethods ?? [],
  restartAgent: async (agentId) => {
    restartAgent(agentId);
    await getConn(agentId).ensureStarted();
  },
  agentMeta: (agentId) => {
    const d = agentDef(agentId);
    return d ? authMetaOf(d) : undefined;
  },
  savedVarNames: (agentId) => secretVarNamesForAgent(agentId),
  markAuthenticated: (agentId) => {
    const saved = secretVarNamesForAgent(agentId);
    getConn(agentId).setStatus({ state: 'ready', detail: undefined, hasApiKey: saved.length > 0, canLogout: saved.length > 0 || getConn(agentId).status.canLogout });
  },
});

// ------------------------------------------------------------------ incoming ACP traffic

/**
 * Plain text of one content block, for places that keep text only (user message replays, compaction summaries,
 * notices). Agent messages and tool content keep every block (`toRichContents` / `mapToolContent`).
 */
function textOf(content: any): string {
  if (!content) return '';
  if (content.type === 'text') return content.text ?? '';
  if (content.type === 'resource_link') return `[${content.title ?? content.name ?? content.uri}](${content.uri})`;
  if (content.type === 'image') return '[Image]';
  if (content.type === 'audio') return '[Audio]';
  return '';
}

/**
 * Where a chat's media from the agent goes. A `session/load` replay (scratch runtime) shares the real chat's id
 * and its items are merged into that chat, so it writes there too; files are named by content hash, so replaying
 * the same history again writes nothing new.
 */
const mediaOf = (rt: Runtime): MediaStore => ({ dir: chatMediaDir(sharedRoot(), rt.thread.id) });

const OLYMPUS_LABEL: Record<string, string> = {
  session_info: 'Session info',
  list_agents: 'List agents',
  run_in_terminal: 'Run in terminal',
  read_terminal: 'Read terminal',
  list_saved_commands: 'List saved commands',
  run_saved_command: 'Run saved command',
  spawn_subsession: 'Spawn sub-session',
  configure_subsession: 'Configure sub-session',
  wait_for_subsessions: 'Wait for sub-sessions',
  get_subsession: 'Check sub-session',
  message_subsession: 'Message sub-session',
  cancel_subsession: 'Cancel sub-session',
  delete_subsession: 'Delete sub-session',
  list_schedules: 'List scheduled tasks',
  save_schedule: 'Save scheduled task',
  delete_schedule: 'Delete scheduled task',
  run_schedule: 'Run scheduled task',
  search_agent_registry: 'Search agent registry',
  add_agent: 'Add agent',
  add_custom_agent: 'Add custom agent',
  remove_agent: 'Remove agent',
  remember_about_user: 'Learned about you',
};
/** Readable titles for the app's own `olympus` tools, e.g. "Spawn sub-session: Add retry to fetchUser". */
// ---- the app's own tool calls, recorded from its MCP server and attached to the agent's tool cards ----

type OlympusRecord = import('@shared/types').OlympusCall;
const olympusPending = new Map<string, OlympusRecord[]>();

/** A card of this tool still waiting for its answer: running, or announced in the last two minutes (never an old one from history). */
const isOpenOlympusCard = (i: ThreadItem, tool: string) =>
  i.kind === 'tool' && !i.olympus?.result && i.olympus?.tool === tool && (i.status === 'in_progress' || i.status === 'pending' || Date.now() - i.ts < 120_000);

/** The olympus MCP server answered a tool call from this chat's agent: put it on the matching tool card. */
export function recordOlympusCall(threadId: string, rec: OlympusRecord) {
  const rt = runtimes.get(threadId);
  const item = rt?.thread.items.find((i) => isOpenOlympusCard(i, rec.tool));
  if (rt && item && item.kind === 'tool') {
    item.olympus = rec;
    pushItem(rt, item);
    return;
  }
  // The card hasn't arrived yet (some agents announce the tool call after running it): attach it then.
  olympusPending.set(threadId, [...(olympusPending.get(threadId) ?? []), rec].slice(-20));
}

function claimOlympus(rt: Runtime, item: ThreadItem, rawTitle?: string, rawInput?: any) {
  if (item.kind !== 'tool') return;
  // Remember which of the app's tools this card is, from the agent's own name for it (before it is relabelled).
  if (!item.olympus) {
    const name = olympusToolName(rawTitle, rawInput);
    if (!name) return;
    item.olympus = { tool: name };
  }
  if (item.olympus.result) return;
  const tool = item.olympus.tool;
  const list = olympusPending.get(rt.thread.id);
  if (!tool || !list?.length) return;
  const at = list.findIndex((r) => r.tool === tool);
  if (at < 0) return;
  item.olympus = { ...list[at] };
  list.splice(at, 1);
}

/** A one-line summary of what a tool was asked to do, from its input (a sub-agent's task, a search query …). */
function inputSummary(rawInput: any): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  // Keys differ in case between agents (Antigravity sends "Prompt", "Role").
  const lower = Object.fromEntries(Object.entries(rawInput).map(([k, v]) => [k.toLowerCase(), v]));
  const str = (k: string) => (typeof lower[k] === 'string' && lower[k].trim() ? String(lower[k]).replace(/\s+/g, ' ').trim() : '');
  const who = str('role') || str('name') || str('title') || str('description');
  const what = str('task') || str('prompt') || str('query') || str('pattern') || str('url') || str('command') || str('message');
  const out = who && what ? `${who} — ${what}` : who || what;
  return out ? out.slice(0, 120) : undefined;
}

/**
 * Extracts a short human-readable summary for a tool step (e.g. Antigravity `toolSummary`,
 * Claude Code / Codex `description`, or Claude Code's pre-completion 1-line Bash description)
 * so it survives on `ThreadItem.summary` even after `tool_call_update` replaces `content` with output.
 */
export function extractToolSummary(
  rawInput: unknown,
  content: ToolContentView[] | undefined,
  kind: string | undefined,
  status: string | undefined,
  rawTitle?: string,
): string | undefined {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const lower = Object.fromEntries(Object.entries(rawInput as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]));
    const pickStr = (k: string) => (typeof lower[k] === 'string' && lower[k].trim() ? String(lower[k]).replace(/\s+/g, ' ').trim() : '');
    const explicit = pickStr('toolsummary') || pickStr('description') || (olympusToolName(rawTitle) === 'run_in_terminal' ? pickStr('title') : '');
    if (explicit) return explicit.slice(0, 200);
  }
  const preCompletion = !status || status === 'pending' || status === 'in_progress';
  if (kind === 'execute' && preCompletion && content && content.length === 1 && content[0].type === 'text' && content[0].text) {
    const line = content[0].text.replace(/\r\n/g, '\n');
    const trimmed = line.trim();
    if (
      trimmed &&
      trimmed.length <= 200 &&
      !line.trim().includes('\n') &&
      !trimmed.startsWith('```') &&
      !/^(?:Input:|Output:|Created At:|Exit code -?\d+|Command exited with code )/.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return undefined;
}

/** A tool's input and output as text, for tools that send no content of their own (e.g. an agent's sub-agent). */
export function rawAsContent(raw: any, label: string): ToolContentView[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  return text.trim() ? [{ type: 'text', text: `${label}\n${text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text}` }] : [];
}

/**
 * The app's own tool behind a tool card's title, whatever the agent calls it: "mcp__olympus__spawn_subsession"
 * (Claude Code), "olympus.spawn_subsession" (Codex), "mcp_olympus_e59f0f5b_spawn_subsession" (Antigravity adds
 * a code), with or without "Run ", or the bare tool name.
 */
export function olympusToolName(title: string | undefined, rawInput?: any): string | undefined {
  // Antigravity's generic call_mcp_tool ("MCP Tool spawn_subsession") names the server and tool in its input.
  const server = typeof rawInput?.ServerName === 'string' ? rawInput.ServerName.trim() : '';
  if (OLYMPUS_SERVER_RE.test(server)) {
    const n = String(rawInput?.ToolName ?? '').trim().toLowerCase();
    if (OLYMPUS_LABEL[n]) return n;
  }
  const t = (title ?? '').trim().replace(/^Run\s+/, '').split(/[\s:(]/)[0];
  // The server is "olympus" or a per-chat "olympus_<8 hex>" (see olympusServerName), which agy may suffix again.
  const m = /olympus(?:[_.]{1,2}[0-9a-f]{4,16})*[_.]{1,2}([a-z_]+)$/i.exec(t);
  const name = (m ? m[1] : t).toLowerCase();
  return OLYMPUS_LABEL[name] ? name : undefined;
}

/** "olympus", or a per-chat name such as "olympus_f1e6d384" (Antigravity may add one more "_<hash>"). */
const OLYMPUS_SERVER_RE = /^olympus(?:_[0-9a-f]{4,16})*$/i;

function toolTitle(title: string | undefined, rawInput: any): string | undefined {
  const name = olympusToolName(title, rawInput);
  const m = name ? [title ?? '', name] : null;
  if (!m || !OLYMPUS_LABEL[m[1]]) {
    // A bare tool name ("Run invoke_subagent") says little: add what it was asked to do.
    const s = inputSummary(rawInput);
    if (title && s && /^(Run )?[\w.:-]+$/.test(title.trim()) && !title.includes(s)) return `${title}: ${s}`;
    return title;
  }
  const extra =
    m[1] === 'spawn_subsession' && rawInput?.title
      ? `: ${rawInput.title}`
      : m[1] === 'configure_subsession' && (rawInput?.agent || rawInput?.model)
        ? `: ${[rawInput.agent, rawInput.model].filter(Boolean).join(' · ')}`
        : m[1] === 'save_schedule' && rawInput?.name
          ? `: ${String(rawInput.name).slice(0, 120)}`
          : (m[1] === 'delete_schedule' || m[1] === 'run_schedule') && rawInput?.id
            ? `: ${String(rawInput.id).slice(0, 80)}`
            : m[1] === 'remember_about_user' && rawInput?.note
              ? `: ${String(rawInput.note).slice(0, 160)}`
              : m[1] === 'run_in_terminal' && rawInput?.command
                ? `: ${String(rawInput.command).slice(0, 160)}`
                : '';
  return `${OLYMPUS_LABEL[m[1]]}${extra}`;
}

/** The item a streamed chunk can continue: the newest one, not counting a waiting Olympus confirm card. */
function lastItem(rt: Runtime) {
  return lastStreamItem(rt.thread.items);
}

const updateHost: UpdateHost = {
  addItem: (rt, item) => addItem(rt as Runtime, item),
  pushItem: (rt, item, throttle) => pushItem(rt as Runtime, item, throttle),
  textOf: (c) => textOf(c),
};

function routeUpdate(params: any) {
  const u = unwrapSessionUpdate(params?.update);
  // A hidden limits session (`/usage`, `/status`): its reply is read there and never shown anywhere.
  if (probeSessions.offer(params?.sessionId, u)) return;
  // History replayed by an open `session/load` is rendered by the load itself (renderReplay), not as live updates.
  if (replayGates.offer(params?.sessionId, u)) return;
  const baseRt = bySession.get(params?.sessionId);
  if (!baseRt) return;
  if (handleAsyncTaskUpdate(baseRt, u)) return;
  if (handleNativeSubagentUpdate(baseRt, u)) return;
  const rt: Runtime = (maybeMirrorInBandSubagent(baseRt, u) as Runtime | undefined) ?? baseRt;
  if (noteAgentInitiatedUpdate(rt, u)) return;
  if (!rt.running && !rt.thread.nativeSubagent && ['agent_message', 'agent_message_chunk', 'agent_thought', 'agent_thought_chunk', 'tool_call', 'plan', 'plan_update'].includes(String(u?.sessionUpdate))) {
    beginAgentInitiatedTurn(rt);
  }
  applyUpdate(rt, u, Date.now());
}

/** Session updates that describe state, not history: a replay renderer (scratch runtime) ignores them. */
const STATE_UPDATE_KINDS = new Set(['usage_update', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update']);

/** Tool calls left open at once that mean the agent's model is stuck in a loop, not working in parallel. */
const RUNAWAY_OPEN_TOOLS = 150;

/**
 * Stops a turn whose agent keeps starting tool calls without any of them running (a model repeating one call
 * thousands of times, seen with OpenCode + DeepSeek): the turn is cancelled and one error says why.
 */
function stopRunawayTurn(rt: Runtime) {
  const items = rt.thread.items;
  rt.turn.toolCalls = (rt.turn.toolCalls ?? 0) + 1;
  rt.turn.toolsFrom ??= items.length - 1;
  if (rt.turn.toolCalls < RUNAWAY_OPEN_TOOLS || rt.turn.toolCalls % 25) return;
  let open = 0;
  // Only this turn's calls: a card an earlier turn left open does not count.
  for (let i = items.length - 1; i >= Math.min(rt.turn.toolsFrom, items.length - 1) && i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'tool' && (it.status === 'pending' || it.status === 'in_progress')) open++;
  }
  if (open < RUNAWAY_OPEN_TOOLS) return;
  rt.turn.runaway = true;
  const text = `Stopped: the agent started ${open} tool calls without any of them finishing, so its model looks stuck in a loop. Send the message again, or pick another model.`;
  addItem(rt, { kind: 'error', id: randomUUID(), agentId: rt.agentId, text, ts: Date.now() });
  void cancel(rt.thread.id).catch(() => {});
}

/** One session update applied to a chat's items and state (live, or a scratch runtime rendering a replay). */
function applyUpdate(rt: Runtime, u: any, now: number) {
  if (rt.scratch && STATE_UPDATE_KINDS.has(String(u?.sessionUpdate))) return;
  // An MCP server's startup status (Codex `mcp__<name>__startup` tool call, Claude notice): the chat's MCP status
  // (never from a load replay or a sub-agent's child session). Codex's tool call is only status, not a step.
  const mcp = mcpStatusFromUpdate(u);
  if (mcp) {
    if (!rt.scratch && !rt.thread.nativeSubagent) mcpStatus.apply(rt.thread.id, mcp);
    if (mcp.hide) return;
  }
  switch (u?.sessionUpdate) {
    case 'agent_message':
    case 'agent_thought':
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const isMsg = u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_message';
      const isChunk = u.sessionUpdate.endsWith('_chunk');
      const kind = isMsg ? 'agent' : 'thought';
      const key = kind === 'agent' ? 'agentItemId' : 'thoughtItemId';
      const msgKey = kind === 'agent' ? 'agentMsgId' : 'thoughtMsgId';
      const blocks = toRichContents(u.content, mediaOf(rt));
      // Several text blocks in one update are separate paragraphs.
      for (let n = 1; n < blocks.length; n++) {
        const b = blocks[n];
        if (b.type === 'text' && blocks[n - 1].type === 'text') blocks[n] = { ...b, text: `\n${b.text}` };
      }
      if (!blocks.length) return;
      const last = lastItem(rt);
      // A different ACP messageId is a new message, even when it directly follows the previous one.
      if (isChunk && last && last.id === rt.turn[key] && (last.kind === 'agent' || last.kind === 'thought') && last.kind === kind && continuesMessage(rt.turn[msgKey], u.messageId)) {
        Object.assign(last, appendMessageContent(last, blocks));
        if (typeof u.messageId === 'string' && u.messageId) rt.turn[msgKey] = u.messageId;
        pushItem(rt, last, true);
      } else {
        const item = { kind, id: randomUUID(), agentId: rt.agentId, ...appendMessageContent({ text: '' }, blocks), ts: now } as ThreadItem;
        rt.turn[key] = item.id;
        rt.turn[msgKey] = typeof u.messageId === 'string' && u.messageId ? u.messageId : undefined;
        addItem(rt, item);
      }
      return;
    }
    case 'user_message':
    case 'user_message_chunk':
      // A sub-agent's own thread gets its task this way (nativeSubagents.ts); here: the root chat's own messages.
      if (!rt.thread.nativeSubagent && !u._meta?.claudeCode?.parentToolUseId) applyUserMessageChunk(updateHost, rt, u, now);
      return;
    case 'plan_update':
      applyPlanUpdate(updateHost, rt, u, now);
      return;
    case 'plan_removed':
      applyPlanRemoved(updateHost, rt, u);
      return;
    case 'notice':
      applyNotice(updateHost, rt, u, now);
      return;
    case 'compaction_update':
      applyCompactionUpdate(updateHost, rt, u, now);
      return;
    case 'compaction_summary_chunk':
      applyCompactionChunk(updateHost, rt, u, now);
      return;
    case 'tool_call': {
      // A turn already stopped as a runaway loop: the calls still streaming in are not shown.
      if (rt.turn.runaway) return;
      if (!rt.scratch) onAgyToolEvent(rt, u);
      const mappedContent = u.content?.length ? mapToolContent(u.content, mediaOf(rt)) : undefined;
      const item: ThreadItem = {
        kind: 'tool',
        id: randomUUID(),
        agentId: rt.agentId,
        toolCallId: u.toolCallId,
        title: toolTitle(u.title, u.rawInput) ?? 'Tool',
        summary: extractToolSummary(u.rawInput, mappedContent, u.kind, u.status, u.title),
        toolKind: u.kind,
        status: u.status ?? 'pending',
        content: mappedContent ?? rawAsContent(u.rawInput, 'Input:'),
        ...splitLocations(mapLocations(u.locations)),
        ts: now,
      };
      const identity = toolIdentityOf(u);
      if (identity) item.identity = identity;
      rt.toolItems.set(u.toolCallId, item.id);
      if (!rt.scratch) claimOlympus(rt, item, u.title, u.rawInput);
      attachTerminals(rt, item, u);
      addItem(rt, item);
      const wake = rt.scratch ? undefined : scheduleOf(u.title, u.rawInput);
      if (wake) keepWake(rt.thread.id, u.toolCallId, wake.ms, wake.note);
      if (!rt.scratch) stopRunawayTurn(rt);
      return;
    }
    case 'tool_call_update': {
      if (!rt.scratch) onAgyToolEvent(rt, u);
      const id = rt.toolItems.get(u.toolCallId);
      const item = rt.thread.items.find((i) => i.id === id);
      if (!item || item.kind !== 'tool') return;
      if (u.title) item.title = toolTitle(u.title, u.rawInput) ?? item.title;
      else if (item.title === OLYMPUS_LABEL.spawn_subsession && u.rawInput?.title) item.title = `${item.title}: ${u.rawInput.title}`;
      else if (item.title === OLYMPUS_LABEL.remember_about_user && u.rawInput?.note) item.title = `${item.title}: ${String(u.rawInput.note).slice(0, 160)}`;
      if (u.kind) item.toolKind = u.kind;
      const effectiveStatus = u.status ?? item.status;
      const mappedUpdateContent = u.content?.length ? mapToolContent(u.content, mediaOf(rt)) : undefined;
      const nextSummary = extractToolSummary(u.rawInput, mappedUpdateContent, item.toolKind, effectiveStatus, u.title ?? item.title);
      if (nextSummary) item.summary = nextSummary;
      if (u.status) {
        item.status = u.status;
        if ((u.status === 'completed' || u.status === 'failed') && !item.endedAt) item.endedAt = Date.now();
      }
      if (mappedUpdateContent) item.content = mappedUpdateContent;
      else if (u.rawOutput !== undefined && !item.content.some((c) => c.type === 'diff')) {
        // No content of its own (e.g. a sub-agent): show what it returned.
        item.content = [...item.content.filter((c) => !c.text?.startsWith('Output:')), ...rawAsContent(u.rawOutput, 'Output:')];
      }
      if (u.locations) {
        delete item.locationRefs;
        Object.assign(item, splitLocations(mapLocations(u.locations)));
      }
      if (u.name || u._meta) item.identity = toolIdentityOf(u, item.identity);
      if (u.rawInput && !rt.scratch) {
        const wake = scheduleOf(u.title ?? item.olympus?.tool ?? item.title, u.rawInput);
        if (wake) keepWake(rt.thread.id, u.toolCallId, wake.ms, wake.note);
      }
      if (!rt.scratch) claimOlympus(rt, item, u.title, u.rawInput);
      attachTerminals(rt, item, u);
      pushItem(rt, item, true);
      return;
    }
    case 'plan': {
      const entries = (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status, priority: e.priority }));
      const existing = rt.thread.items.find((i) => i.id === rt.turn.planItemId);
      if (existing && existing.kind === 'plan') {
        existing.entries = entries;
        pushItem(rt, existing, true);
      } else {
        const item: ThreadItem = { kind: 'plan', id: randomUUID(), agentId: rt.agentId, entries, ts: now };
        rt.turn.planItemId = item.id;
        addItem(rt, item);
      }
      return;
    }
    case 'usage_update': {
      rt.usage = {
        used: Number(u.used ?? 0),
        size: Number(u.size ?? 0),
        cost: u.cost ?? rt.usage?.cost,
        model: u._meta?.['_claude/model'] ?? rt.usage?.model,
      };
      noteSubagentModel(rt, u._meta?.['_claude/model']);
      rt.conn?.onLimits(u._meta);
      pushSession(rt);
      return;
    }
    case 'available_commands_update':
      rt.commands = (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description, inputHint: c.input?.hint || undefined }));
      if (!rt.scratch && rt.commands.length) advertised.set(rt.agentId, rt.commands.map((c) => c.name));
      pushSession(rt);
      return;
    case 'current_mode_update':
      rt.configOptions = withCurrentMode(rt.configOptions, u.currentModeId);
      if (rt.configOptions.length && !rt.thread.nativeSubagent) knownAgentConfigs.set(rt.agentId, rt.configOptions);
      pushSession(rt);
      return;
    case 'config_option_update': {
      const mapped = mapConfigOptions(u.configOptions);
      const modelOpt = mapped.find((o) => o.category === 'model' || o.id === 'model');
      const childToolId = typeof u._meta?.claudeCode?.parentToolUseId === 'string' ? u._meta.claudeCode.parentToolUseId : undefined;
      if (childToolId && !rt.thread.nativeSubagent) {
        noteSubagentModel(rt, modelOpt?.currentValue, childToolId);
        return;
      }
      rt.configOptions = mapped;
      if (rt.thread.nativeSubagent) noteSubagentModel(rt, modelOpt?.currentValue);
      else if (rt.configOptions.length) knownAgentConfigs.set(rt.agentId, rt.configOptions);
      pushSession(rt);
      return;
    }
    case 'session_info_update': {
      const failure = u._meta?.jetbrains?.air?.sessionFailure;
      if (failure && applySessionFailure(updateHost, rt, failure, now)) {
        markNeedsLogin(rt);
        pushSession(rt);
      }
      const title = agentTitleFor(rt.thread, u.title);
      if (title) {
        rt.thread.title = title;
        saveThread(rt.thread);
        emit('thread:meta', threadMeta(rt.thread));
      }
      return;
    }
    default:
      return;
  }
}

// run_in_terminal runs a command, so it is not on this list: it asks like any command (or follows Approve all / Tools rules).
const OLYMPUS_TOOLS = [
  'session_info',
  'list_agents',
  'read_terminal',
  'list_saved_commands',
  'spawn_subsession',
  'configure_subsession',
  'wait_for_subsessions',
  'get_subsession',
  'message_subsession',
  'cancel_subsession',
  'delete_subsession',
  'list_schedules',
  'save_schedule',
  'delete_schedule',
  'run_schedule',
  // These four change the agent list, but Olympus asks the user itself first (a confirm card in the chat).
  'search_agent_registry',
  'add_agent',
  'add_custom_agent',
  'remove_agent',
  // Adds a folder to the sidebar (and may open a chat there); the new chat asks for its own edits and commands.
  'create_project',
];

/**
 * The app's own `olympus` tools (orchestrator.ts) need no approval: they only start, steer and read sub-sessions,
 * and those sub-sessions still ask for their own edits and commands. Identified by the adapter's structured tool
 * name (Claude: `_meta.claudeCode`), or an exact tool-name match — never by a substring of free text.
 */
function isOlympusTool(tc: any): boolean {
  const cc = tc?._meta?.claudeCode;
  if (cc?.mcpServer?.name === 'olympus' && OLYMPUS_TOOLS.some((t) => cc.toolName === `mcp__olympus__${t}`)) return true;
  // Antigravity's generic call_mcp_tool names the server and the tool in its input.
  const inp = tc?.rawInput;
  if (typeof inp?.ServerName === 'string' && OLYMPUS_SERVER_RE.test(inp.ServerName.trim()) && OLYMPUS_TOOLS.includes(String(inp.ToolName ?? '').trim().toLowerCase())) return true;
  const names = [tc?.name, tc?.title].filter((x): x is string => typeof x === 'string').map((n) => n.trim());
  return names.some((n) => {
    const m = OLYMPUS_TOOL_NAME_RE.exec(n);
    return Boolean(m && OLYMPUS_TOOLS.includes(m[1].toLowerCase()));
  });
}

/**
 * The whole title/name is one of the app's tool names, in any adapter's spelling: mcp__olympus__x (Claude),
 * olympus.x / mcp.olympus.x (Codex), mcp_olympus_x or mcp_olympus_<code>_x (Antigravity, with or without "Run ").
 */
const OLYMPUS_TOOL_NAME_RE = /^(?:Run\s+)?(?:mcp(?:__|_|\.))?olympus(?:_[0-9a-f]{4,16})*(?:__|_|\.)([a-z_]+)$/i;

/** What a permission request is about, for Settings → Tools rules: a tool name if the agent gives one, else its kind. */
function toolKey(tc: any): { tool: string; kind?: string; title: string } {
  const cc = tc?._meta?.claudeCode;
  const name = typeof cc?.toolName === 'string' ? cc.toolName : typeof tc?.name === 'string' && tc.name ? tc.name : undefined;
  return { tool: name ? olympusRuleKey(name) : tc?.kind ? `kind:${tc.kind}` : 'unknown', kind: tc?.kind, title: String(tc?.title ?? '') };
}

/** The app's tools under a chat's own server name, any spelling: "olympus" + "_<hex>" codes, a separator, the tool. */
const OLYMPUS_RULE_KEY_RE = /^((?:mcp(?:__|_|\.))?olympus)(?:_[0-9a-f]{4,16})+(__|_|\.)([a-z_]+)$/i;

/**
 * A rule for one of the app's tools applies in every chat: Antigravity's per-chat server names are keyed without
 * the chat's code ("mcp_olympus_f1e6d384_run_in_terminal", "…_f1e6d384_0002_…" → "mcp_olympus_run_in_terminal").
 */
function olympusRuleKey(tool: string): string {
  const m = OLYMPUS_RULE_KEY_RE.exec(tool.trim());
  return m && OLYMPUS_LABEL[m[3].toLowerCase()] ? `${m[1]}${m[2]}${m[3]}` : tool;
}

const globMatch = (pattern: string, text: string) =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's').test(text);

function matchRule(agentId: string, k: ReturnType<typeof toolKey>) {
  return getSettings().toolRules.find(
    (r) =>
      (r.agent === '*' || r.agent === agentId) &&
      (olympusRuleKey(r.tool) === k.tool || (k.kind !== undefined && r.tool === `kind:${k.kind}`)) &&
      (!r.match || globMatch(r.match, k.title)),
  );
}

function rememberTool(agentId: string, k: ReturnType<typeof toolKey>) {
  const seen = getSettings().seenTools.filter((t) => !(t.agent === agentId && t.tool === k.tool));
  updateSettings({ seenTools: [{ agent: agentId, tool: k.tool, kind: k.kind, example: k.title.slice(0, 200), ts: Date.now() }, ...seen].slice(0, 60) });
}

const pick = (options: any[], kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);

/** Shown on a permission card the agent withdrew (`$/cancel_request`) before the user answered. */
const PERMISSION_WITHDRAWN = 'No longer needed';

function requestPermission(params: any, signal?: AbortSignal): Promise<any> {
  if (probeSessions.has(params?.sessionId)) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  if (process.env.OLYMPUS_DEBUG_PERMS) console.log('[perm]', JSON.stringify(params).slice(0, 1500));
  const options: any[] = params?.options ?? [];
  if (isOlympusTool(params?.toolCall)) {
    const allow = pick(options, ['allow_once', 'allow_always']);
    if (allow) return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
  }
  const rt0 = bySession.get(params?.sessionId);
  if (rt0) {
    // Settings → Tools: a rule answers for the user; otherwise remember the tool so a rule can be made from it.
    const k = toolKey(params?.toolCall);
    const rule = matchRule(rt0.agentId, k);
    // A second opinion is read-only: reading and searching are fine, changing files is refused.
    if (rt0.thread.secondOpinion || (rt0.thread.nativeSubagent && rootUserThread(rt0.thread).secondOpinion)) {
      const item = rt0.thread.items.find((i) => i.id === rt0.toolItems.get(params?.toolCall?.toolCallId));
      const kind = params?.toolCall?.kind ?? (item?.kind === 'tool' ? item.toolKind : undefined);
      if (kind && ['read', 'search', 'fetch', 'think'].includes(kind)) {
        const o = pick(options, ['allow_once', 'allow_always']);
        if (o) return Promise.resolve({ outcome: { outcome: 'selected', optionId: o.optionId } });
      }
      if (kind && ['edit', 'delete', 'move'].includes(kind)) {
        const o = pick(options, ['reject_once', 'reject_always']);
        return Promise.resolve(o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } });
      }
    }
    if (effectiveAutoApprove(rt0.thread) && rule?.action !== 'deny') {
      const o = pick(options, ['allow_once', 'allow_always']);
      if (o) return Promise.resolve({ outcome: { outcome: 'selected', optionId: o.optionId } });
    }
    if (rule?.action === 'allow') {
      const o = pick(options, ['allow_once', 'allow_always']);
      if (o) return Promise.resolve({ outcome: { outcome: 'selected', optionId: o.optionId } });
    } else if (rule?.action === 'deny') {
      const o = pick(options, ['reject_once', 'reject_always']);
      return Promise.resolve(o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } });
    }
    try {
      rememberTool(rt0.agentId, k);
    } catch {
      /* best-effort */
    }
  }
  const rt = rt0;
  if (!rt) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  const tc = params.toolCall ?? {};
  const toolItemId = rt.toolItems.get(tc.toolCallId);
  const toolItem = rt.thread.items.find((i) => i.id === toolItemId);
  const title = tc.title ?? (toolItem?.kind === 'tool' ? toolItem.title : 'Permission required');
  const item: ThreadItem = {
    kind: 'permission',
    id: randomUUID(),
    agentId: rt.agentId,
    title,
    options: (params.options ?? []).map((o: any) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    ts: Date.now(),
  };
  addItem(rt, item);
  return new Promise((resolve) => {
    const finish = (optionId: string | null, label?: string) => {
      signal?.removeEventListener('abort', withdraw);
      if (item.kind === 'permission') item.resolved = label ?? (optionId ? (item.options.find((o) => o.optionId === optionId)?.name ?? optionId) : 'Cancelled');
      pushItem(rt, item);
      resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    };
    // The agent withdrew the request (ACP `$/cancel_request`, which aborts this handler): the card stops waiting.
    const withdraw = () => {
      if (!rt.pendingPerms.delete(item.id)) return;
      finish(null, PERMISSION_WITHDRAWN);
    };
    rt.pendingPerms.set(item.id, (optionId) => finish(optionId));
    if (signal?.aborted) withdraw();
    else signal?.addEventListener('abort', withdraw, { once: true });
  });
}

/** One usage-log line per finished turn, from the token counts the agent returns with the prompt response. */
function logTurnUsage(rt: Runtime, res: any): { cost?: number; model?: string } {
  const u = res?.usage;
  if (!u) return {};
  const sessionCost = rt.usage?.cost?.currency === 'USD' ? rt.usage.cost.amount : undefined;
  const cost = sessionCost !== undefined ? Math.max(0, sessionCost - rt.loggedCost) : undefined;
  if (sessionCost !== undefined) rt.loggedCost = sessionCost;
  const model = rt.usage?.model ?? res?._meta?.quota?.model_usage?.[0]?.model ?? rt.configOptions.find((o) => o.category === 'model')?.currentValue;
  try {
    recordUsage({
      ts: Date.now(),
      agentId: rt.agentId,
      threadId: rt.thread.id,
      projectId: rt.thread.projectId,
      model,
      input: Number(u.inputTokens ?? 0),
      output: Number(u.outputTokens ?? 0) + Number(u.thoughtTokens ?? 0),
      cacheRead: Number(u.cachedReadTokens ?? 0),
      cacheWrite: Number(u.cachedWriteTokens ?? 0),
      total: Number(u.totalTokens ?? 0),
      cost,
    });
  } catch {
    /* the log is best-effort */
  }
  return { cost, model };
}

/**
 * Put the turn's token counts on the messages themselves: what was read on the user's message, what was
 * written (plus time and cost) on the agent's last reply of the turn. Saved with the chat.
 */
function attachTurnUsage(rt: Runtime, userItem: ThreadItem, res: any, turn: { cost?: number; model?: string }, durationMs: number) {
  const u = res?.usage;
  if (userItem.kind !== 'user') return;
  if (u) {
    const input = Number(u.inputTokens ?? 0);
    const cacheRead = Number(u.cachedReadTokens ?? 0);
    const cacheWrite = Number(u.cachedWriteTokens ?? 0);
    userItem.usage = { input, cacheRead, cacheWrite, prompt: input + cacheRead + cacheWrite };
    pushItem(rt, userItem);
  }
  const from = rt.thread.items.indexOf(userItem);
  const reply = [...rt.thread.items.slice(from + 1)].reverse().find((i) => i.kind === 'agent');
  if (reply?.kind === 'agent') {
    reply.usage = {
      output: Number(u?.outputTokens ?? 0),
      thought: Number(u?.thoughtTokens ?? 0),
      durationMs,
      cost: turn.cost,
      model: turn.model,
    };
    pushItem(rt, reply);
  }
}
