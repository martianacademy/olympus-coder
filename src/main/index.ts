import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppState, AttachmentView, DeskEvents, ProcAction, Settings, VerifyGateConfig } from '@shared/types';
import * as agents from './agents';
import * as attachments from './attachments';
import { readClipboardMessage, writeClipboard, type ClipboardPayload } from './clipboard';
import * as catalog from './catalog';
import { addCustomAgent, removeCustomAgent, type CustomAgentInput } from './customAgents';
import { agentEnv, loadLoginShellPath, userShell } from './env';
import * as files from './files';
import { listEditors, openDefault, openInEditor } from './openWith';
import * as git from './git';
import * as lock from './lock';
import { openInDefaultApp, openPreview, readPreviewRaw, revealInFinder, savePreviewAs } from './preview';
import { collectNativeSubagents } from '@shared/acpSessions';
import { pauseAgentTimersForQuit, restoreAgentTimers } from './agenttimers';
import { forgetOrchestratorThread, initOrchestrator, listTasks, secondOpinion, setChatDeleter, stopOrchestrator, userCancelled, userSent } from './orchestrator';
import { controlTask, runningTasks } from './processes';
import { listPorts, stopPortOwner } from './ports';
import { startHeatWatch } from './heat';
import { startJobWatch } from './jobwatch';
import { allowInFirewall, initRemote, remoteBroadcast, remoteStatus, removeDevice, resetPhoneLink, setRelayUrl, setRemoteEnabled, setRemoteLan, startPairing, stopRemote, tailscaleServe, checkTailscale } from './remote';
import { clearNotes, deleteNote, listNotes } from './usernotes';
import { relayLink } from './relay';
import { cleanUpCheckpoints, forgetCheckpoints } from './checkpoints';
import { detectTestCommand } from './testcmd';
import { isMuted, notifyAgent } from './appmsg';
import { detectVerifyCommand, effectiveVerifyCommand, evaluateTurnVerifyGate, resetVerifyRetries, runVerifyCommand } from './verifyGate';
import { initSavedCommands, savedCommandHandlers, savedCommandsQuitting } from './savedCommands';
import { busyTerminals, closeTerminal, flushTerminals, listTerminals, openTerminal, rerunTerminal, restoreTerminals, setTerminalEmitter } from './terminals';
import { createMemory, deleteMemoryFile, getMemoryView, globalInstructionsPath, memoryDir, readMemoryFile, writeGlobalInstructions, writeMemoryFile, writeProjectInstructions } from './memory';
import * as connectors from './connectors';
import * as skills from './skills';
import { forgetPty, killAllPtys, killPty, ptyBuffer, resizePty, startPty, writePty } from './pty';
import * as schedules from './schedules';
import * as store from './store';
import { watchProjectsFile, type ProjectsWatcher } from './projectWatch';
import { modelTags, startModelTags } from './modelTags';
import { cancelDownload, checkNow, currentUpdate, installAndRestart, lastUpdateCheck, onAppWillQuit, skipUpdate, startUpdateChecker, updateSettingChanged } from './updates';
import * as acpSessions from './acpSessionService';
import * as acpConfig from './acpConfigService';
import type { AcpConfigEvents, ProviderInput } from '@shared/acpConfig';
import { usageSummary } from './usage';
import { projectStats } from './projectstats';
import { workspaceProjectId } from '@shared/worktree';
import { configureWorktreeGit } from './worktrees';
import { chatWorktreeStatus, mergeChatWorktree, removeChatWorktree, removeDeletedChatWorktree, startChatWorktree } from './worktreeChats';
import type { AcpClientEvents, EditorBufferReport } from '@shared/acpClient';
import { setAgentWriteEmitter } from './acpClientFs';
import { acpTerminals, acpTerminalStore } from './acpTerminals';
import { forgetEditorClient, reportEditorBuffers } from './editorBuffers';
import type { PromptQueueEvents } from '@shared/promptQueue';
import * as promptQueue from './promptQueue';
import { resumeQueues, startPromptQueue } from './promptQueueHost';
import { startDictation } from './dictation';
import { initVoice, shutdownVoice, voiceCall } from './voice';
import { installPermissionHandlers } from './permissions';
import { initPanels, isAppSender, panelCall, panelWindows } from './panels';
import { hardenWindow, showWhenReady } from './windowGuards';

/** `OLYMPUS_TEST_HIDDEN=1`: an automated-test instance whose window must never take focus, clicks or screen space. */
const TEST_HIDDEN = process.env.OLYMPUS_TEST_HIDDEN === '1';
/** `OLYMPUS_HEADLESS=1`: pure-Node server build (`out/server/index.mjs`) with zero Electron GUI. */
const HEADLESS = process.env.OLYMPUS_HEADLESS === '1';

const APP_NAME = 'Olympus Coder';
/** When this app's main code was built (mtime of this file at start), to notice a newer install on disk. */
const RUNNING_BUILD = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    return 0;
  }
})();
app.setName(APP_NAME);
// Keep data in "Olympus Coder" (tests pass their own --user-data-dir), and carry over settings, app password
// and keys from the app's first name, AgentDesk.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const userData = join(app.getPath('appData'), APP_NAME);
  const old = join(app.getPath('appData'), 'AgentDesk');
  mkdirSync(userData, { recursive: true });
  for (const f of ['settings.json', 'lock.json', 'secrets.json']) {
    if (!existsSync(join(userData, f)) && existsSync(join(old, f))) copyFileSync(join(old, f), join(userData, f));
  }
  app.setPath('userData', userData);
}

let headlessBootPromise: Promise<void> | undefined;

/**
 * Boot entrypoint used by `src/server/cli.ts` after CLI flags (`--port`, `--lan`, `--relay`,
 * `--password`, `--project`) have been persisted to settings. Resolves once the HTTP/SSE/Relay
 * remote server is bound and ready to accept connections.
 */
export function readyForHeadless(): Promise<void> {
  if (!headlessBootPromise) {
    headlessBootPromise = bootMainProcess();
  }
  return headlessBootPromise;
}

// Guard against running two copies on the same `userData` before registering services or `will-quit` hooks
// (a duplicate instance exiting must never touch the primary instance's whisper-server or staged updates).
if (!HEADLESS) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    void bootMainProcess();
  }
}

async function bootMainProcess(): Promise<void> {
loadLoginShellPath();
const here = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;

/** Every app window: the main one and each detached Workbench tool (src/main/panels.ts). */
const allWindows = (): BrowserWindow[] => [...(win && !win.isDestroyed() ? [win] : []), ...panelWindows()];
/** Sends one desk:event to every app window. Callers apply the lock rule; the phone is NOT sent here (remoteBroadcast). */
const sendToWindows = (channel: string, payload: unknown) => {
  for (const w of allWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('desk:event', channel, payload);
};

const emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => {
  // Nothing but the lock state reaches the window while the app is locked.
  // (Phones are handled on their own: one that typed the password keeps working while this window is locked.)
  remoteBroadcast(channel, payload);
  // The send-while-busy queue follows session state and new items from the same events (src/main/promptQueue.ts).
  promptQueue.observe(channel, payload);
  if (lock.isLocked() && channel !== 'lock:state') return;
  sendToWindows(channel, payload);
};
agents.setEmitter(emit);
agents.onFreshUserTurn((threadId) => resetVerifyRetries(threadId));
agents.onAfterTurnCheckpoint(({ thread, changedFiles }) => {
  // A worktree chat's checks run in its worktree (virtual project: base settings, worktree folder).
  const project = store.getProject(workspaceProjectId(thread));
  if (!project || project.id === store.GENERAL_PROJECT_ID || !project.verifyGate?.enabled) return;
  void evaluateTurnVerifyGate({
    threadId: thread.id,
    project,
    changedFilesCount: changedFiles,
    muted: isMuted(thread.id),
    isReadOnlyRole: Boolean(thread.nativeSubagent || thread.secondOpinion),
    shell: userShell().command,
    env: agentEnv(),
  }).then((out) => {
    if (out.action === 'skipped' || !out.result) return;
    const secs = `${(out.result.durationMs / 1000).toFixed(1)}s`;
    if (out.action === 'passed') {
      agents.appendNoticeToThread(thread.id, 'info', 'Verify gate passed', `$ ${out.result.command} (exit 0 in ${secs})`);
    } else if (out.action === 'retry' && out.prompt) {
      agents.appendNoticeToThread(
        thread.id,
        'warning',
        `Verify gate failed (${out.attempt}/${out.maxRetries})`,
        `$ ${out.result.command} exited with ${out.result.exitCode} in ${secs} — asking agent to fix`,
      );
      notifyAgent(thread.id, out.prompt);
    } else if (out.action === 'exhausted') {
      agents.appendNoticeToThread(
        thread.id,
        'error',
        `Verify gate still failing after ${out.maxRetries} retries`,
        `$ ${out.result.command} exited with ${out.result.exitCode}. Auto-retry stopped.`,
      );
    }
  });
});
// Every deletion in main (sidebar, delete_subsession, disposable sub-sessions) tells the window and the phone.
store.onThreadDeleted((t) => {
  emit('thread:deleted', { id: t.id, projectId: t.projectId, ...(t.parentId ? { parentId: t.parentId } : {}) });
  // Its git worktree goes too: uncommitted work is committed on the branch first and an unmerged branch is kept.
  void removeDeletedChatWorktree(t);
});
configureWorktreeGit(() => agentEnv());
// projects.json written by the app or from outside (an agent, a script): the sidebar updates without a reload.
let projectsWatch: ProjectsWatcher | null = null;
const announceProjects = () => emit('projects:changed', store.listProjectsWithMissing());
store.onProjectsWritten(() => projectsWatch?.notify());
initOrchestrator(emit);
setTerminalEmitter(emit);
/** The ACP client features' events (live agent terminals, files agents wrote): same channel and lock rule as `emit`. */
const emitAcp = <K extends keyof AcpClientEvents>(channel: K, payload: AcpClientEvents[K]) => {
  remoteBroadcast(channel, payload);
  if (lock.isLocked()) return;
  sendToWindows(channel, payload);
};
acpTerminalStore.setEmitter(emitAcp);
startPromptQueue(emit, <K extends keyof PromptQueueEvents>(channel: K, payload: PromptQueueEvents[K]) => {
  remoteBroadcast(channel, payload);
  if (lock.isLocked()) return;
  sendToWindows(channel, payload);
});
/** Config / MCP status / login events (src/main/acpConfigService.ts): same channel and lock rule. */
acpConfig.initAcpConfigService({
  secrets: { getSecret: store.getSecret, setSecret: store.setSecret },
  emit: <K extends keyof AcpConfigEvents>(channel: K, payload: AcpConfigEvents[K]) => {
    remoteBroadcast(channel, payload);
    if (lock.isLocked()) return;
    sendToWindows(channel, payload);
  },
});
setAgentWriteEmitter(({ content: _text, ...w }) => {
  // The window's editors know files by project and relative path.
  const projects: { projectId: string; rel: string }[] = [];
  for (const p of store.listProjects()) {
    let root = p.path;
    try {
      root = realpathSync.native(p.path);
    } catch {
      continue;
    }
    const rel = relative(root, w.path);
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) projects.push({ projectId: p.id, rel: rel.split(sep).join('/') });
  }
  emitAcp('editor:agentWrite', { ...w, projects });
});
lock.onLockChange((s) => {
  sendToWindows('lock:state', s);
});

function appState(): AppState {
  return { settings: store.getSettings(), lock: lock.lockState(), platform: process.platform, home: homedir(), version: app.getVersion() };
}

const projectOrThrow = (id: string) => {
  const p = store.getProject(id);
  if (!p) throw new Error('Project not found.');
  return p;
};

const handlers: Record<string, (...args: any[]) => unknown> = {
  'app.state': () => appState(),
  'settings.update': (patch: Partial<Settings>) => {
    const s = store.updateSettings(patch);
    if (patch.theme) nativeTheme.themeSource = s.theme.mode;
    if (patch.sharedRoot) {
      mkdirSync(patch.sharedRoot, { recursive: true });
      projectsWatch?.rearm();
    }
    if ('updateMode' in patch || 'updateWifiOnly' in patch) updateSettingChanged();
    return s;
  },

  /** Choose the shared folder (memory, chats, skills). Existing data stays where it was. */
  'settings.pickSharedRoot': async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the shared memory folder',
      defaultPath: store.getSettings().sharedRoot,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (r.canceled || !r.filePaths[0]) return null;
    mkdirSync(r.filePaths[0], { recursive: true });
    const s = store.updateSettings({ sharedRoot: r.filePaths[0] });
    projectsWatch?.rearm();
    return s;
  },
  'profile.update': (patch: Partial<Settings['profile']>) => store.updateSettings({ profile: { ...store.getSettings().profile, ...patch } }),

  'lock.unlock': (password: string) => lock.unlockWithPassword(password),
  'lock.touchId': () => lock.unlockWithTouchId(),
  'lock.lockNow': () => lock.lockNow(),
  'lock.setPassword': (current: string | null, next: string) => lock.setPassword(current, next),
  'lock.remove': (current: string) => lock.removePassword(current),
  'lock.options': (patch) => lock.setLockOptions(patch),

  'agents.list': () => agents.agentStatuses(),
  'agents.check': (id: string) => agents.checkAgent(id),
  'catalog.list': () => catalog.listCatalog(),
  'catalog.add': async (id: string, method) => {
    await catalog.addFromCatalog(id, method, emit);
    return agents.agentStatuses();
  },
  'catalog.autoAdd': async () => {
    const names = await catalog.autoAddInstalled(emit);
    return { names, ...agents.agentStatuses() };
  },
  /** Installs a built-in agent's CLI (e.g. npm install -g @anthropic-ai/claude-code) in a visible terminal. */
  'catalog.installBuiltin': (id: string) => {
    const cmd = catalog.builtinInstallCommand(id);
    if (!cmd) throw new Error('No install command for this agent — see its docs.');
    const sh = userShell();
    const args = process.platform === 'win32' ? (/powershell|pwsh/i.test(sh.command) ? ['-NoLogo', '-Command', cmd] : ['/d', '/s', '/c', cmd]) : ['-lc', cmd];
    return startPty({ command: sh.command, args, env: agentEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', PROMPT_EOL_MARK: '' }), cwd: homedir() }, emit, () => {
      agents.restartAgent(id);
      void agents.checkAgent(id);
    });
  },
  /** The limits UI opened (stale agents only), or its refresh button for one agent (read now). */
  'agents.refreshLimits': async (agentId?: string) => {
    if (agentId) await agents.refreshAgentLimits(agentId);
    else await agents.refreshAllLimits({ maxAgeMs: 2 * 60_000, timeoutMs: 50_000 });
    return agents.agentStatuses();
  },
  'agents.auth': (id: string, methodId: string, apiKey?: string) => agents.authenticate(id, methodId, apiKey),
  'agents.terminalLogin': (id: string, methodId: string) => {
    const spec = agents.terminalLoginSpec(id, methodId);
    return startPty(spec, emit, () => void agents.afterTerminalLogin(id));
  },
  'agents.logout': (id: string) => agents.logout(id),
  'agents.restart': (id: string) => {
    agents.restartAgent(id);
    return agents.checkAgent(id);
  },
  'agents.addCustom': (def: CustomAgentInput) => {
    addCustomAgent(def, emit);
    return agents.agentStatuses();
  },
  'agents.setLogo': (id: string, logo: string) => {
    store.updateSettings({ customAgents: store.getSettings().customAgents.map((a) => (a.id === id ? { ...a, logo: logo || undefined } : a)) });
    return agents.agentStatuses();
  },
  'agents.removeCustom': (id: string) => {
    removeCustomAgent(id, emit);
    return agents.agentStatuses();
  },

  'pty.write': (id: string, data: string) => writePty(id, data),
  'pty.resize': (id: string, cols: number, rows: number) => resizePty(id, cols, rows),
  'pty.kill': (id: string) => killPty(id),
  'pty.buffer': (id: string) => ptyBuffer(id),
  'pty.forget': (id: string) => forgetPty(id),
  /** An interactive login shell in the project folder, for the Code view's terminal panel. */
  /** Run button on a shell code block: a new terminal tab with the command typed in. */
  'terminal.run': (projectId: string, command: string) => openTerminal(projectId, command),
  'term.start': (projectId: string) => openTerminal(projectId).ptyId,
  'terminal.list': (projectId: string) => listTerminals(projectId),
  'remote.status': () => remoteStatus(),
  'remote.enable': (on: boolean) => setRemoteEnabled(on),
  'remote.lan': (on: boolean) => setRemoteLan(on),
  'remote.allowFirewall': () => allowInFirewall(),
  'remote.pair': () => startPairing(),
  'remote.removeDevice': (id: string) => removeDevice(id),
  'remote.tailscaleServe': () => tailscaleServe(),
  'remote.checkTailscale': () => checkTailscale(),
  'remote.link': () => relayLink(),
  'remote.setRelayUrl': (url: string) => setRelayUrl(url),
  'remote.resetLink': () => resetPhoneLink(),
  'tests.command': (projectId: string) => {
    const p = store.getProject(projectId);
    return p ? detectTestCommand(p.path) : null;
  },
  'projects.verifyGateInfo': (projectId: string) => {
    const p = projectOrThrow(projectId);
    return { config: p.verifyGate ?? { enabled: false }, detectedCommand: detectVerifyCommand(p.path) };
  },
  'projects.setVerifyGate': (projectId: string, cfg: VerifyGateConfig) => {
    const updated = store.updateProjectVerifyGate(store.baseProjectId(projectId), cfg);
    announceProjects();
    return updated ?? null;
  },
  'projects.runVerifyGate': async (projectId: string) => {
    const p = projectOrThrow(projectId);
    const cmd = effectiveVerifyCommand(p);
    if (!cmd) throw new Error('No verify command configured.');
    return runVerifyCommand(p.path, cmd, { shell: userShell().command, env: agentEnv() });
  },
  'procs.list': () => runningTasks(),
  'ports.list': () => listPorts(),
  'ports.stop': (pid: number) => stopPortOwner(pid),
  'procs.control': (id: string, action: ProcAction) => controlTask(id, action),
  'terminal.close': (ptyId: string) => closeTerminal(ptyId),
  'terminal.rerun': (ptyId: string) => rerunTerminal(ptyId),
  ...savedCommandHandlers,

  'files.list': (projectId: string, rel: string) => files.listDir(projectId, rel),
  'files.read': (projectId: string, rel: string) => files.readFile(projectId, rel),
  'files.write': (projectId: string, rel: string, text: string, mtime?: number) => files.writeFile(projectId, rel, text, mtime),
  'files.create': (projectId: string, rel: string, dir: boolean) => files.createEntry(projectId, rel, dir),
  'files.rename': (projectId: string, from: string, to: string) => files.renameEntry(projectId, from, to),
  'files.trash': (projectId: string, rel: string) => files.trashEntry(projectId, rel),
  'files.reveal': (projectId: string, rel: string) => files.revealEntry(projectId, rel),
  /** "Open with" in the explorer: installed code editors, and opening a project path in one / the default app. */
  'files.editors': () => listEditors(),
  'files.openIn': (projectId: string, rel: string, editorId: string) => openInEditor(projectId, rel, editorId),
  'files.openDefault': (projectId: string, rel: string) => openDefault(projectId, rel),

  /** A window's unsaved editor files for a project (the full list; empty = none), read by agents' `fs/read_text_file`. */
  'editor.reportBuffers': (clientId: string, projectId: string, list: EditorBufferReport[]) => reportEditorBuffers(clientId, projectOrThrow(projectId).path, list),
  'editor.forgetClient': (clientId: string) => forgetEditorClient(clientId),
  /** An agent terminal's output and state for a tool box (live updates follow as `acp:terminal` events). */
  'acpTerminal.snapshot': (key: string) => acpTerminalStore.snapshot(key),
  /** Stop button on a tool box: stops a command Olympus runs for an agent. */
  'acpTerminal.stop': (key: string) => acpTerminals.killKey(key),

  'git.status': (pid: string) => git.status(pid),
  'git.init': (pid: string) => git.init(pid),
  'git.diff': (pid: string, path: string, staged: boolean, untracked: boolean) => git.diff(pid, path, staged, untracked),
  'git.workingDiff': (pid: string, maxChars?: number) => git.workingDiff(pid, maxChars),
  'git.stage': (pid: string, paths: string[]) => git.stage(pid, paths),
  'git.stageAll': (pid: string) => git.stageAll(pid),
  'git.unstage': (pid: string, paths: string[]) => git.unstage(pid, paths),
  'git.unstageAll': (pid: string) => git.unstageAll(pid),
  'git.discard': (pid: string, paths: string[], untracked: boolean) => git.discard(pid, paths, untracked),
  'git.commit': (pid: string, message: string, opts) => git.commit(pid, message, opts),
  'git.push': (pid: string, opts) => git.push(pid, opts),
  'git.pull': (pid: string, rebase: boolean) => git.pull(pid, rebase),
  'git.fetch': (pid: string) => git.fetchAll(pid),
  'git.branches': (pid: string) => git.branches(pid),
  'git.checkout': (pid: string, name: string, remote: boolean) => git.checkout(pid, name, remote),
  'git.createBranch': (pid: string, name: string) => git.createBranch(pid, name),
  'git.deleteBranch': (pid: string, name: string, force: boolean) => git.deleteBranch(pid, name, force),
  'git.merge': (pid: string, name: string) => git.merge(pid, name),
  'git.log': (pid: string, limit?: number) => git.log(pid, limit),
  'git.show': (pid: string, hash: string) => git.show(pid, hash),
  'git.stashes': (pid: string) => git.stashes(pid),
  'git.stashSave': (pid: string, message: string) => git.stashSave(pid, message),
  'git.stashPop': (pid: string, ref: string) => git.stashPop(pid, ref),
  'git.stashApply': (pid: string, ref: string) => git.stashApply(pid, ref),
  'git.stashDrop': (pid: string, ref: string) => git.stashDrop(pid, ref),

  'projects.list': () => store.listProjectsWithMissing(),
  'projects.reorder': (ids: string[]) => store.reorderProjects(ids),
  'projects.add': async (path?: string) => {
    let dir = path;
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose project folder' });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    const p = store.addProject(dir);
    store.updateSettings({ lastProjectId: p.id });
    return p;
  },
  'projects.remove': (id: string) => {
    id = store.baseProjectId(id);
    store.removeProject(id);
    forgetCheckpoints(id);
  },
  /** The project's folder was renamed or moved: pick it (or pass the path) and point the project there. */
  'projects.relocate': async (id: string, path?: string) => {
    id = store.baseProjectId(id);
    const p = store.projectRecord(id);
    if (!p) return null;
    let dir = path;
    if (!dir) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: `Locate "${p.name}"`, defaultPath: dirname(p.path) });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    return store.relocateProject(id, dir);
  },
  'projects.reveal': (id: string) => {
    const p = store.getProject(id);
    if (p) shell.openPath(p.path);
  },

  'threads.list': (projectId: string) => store.listThreads(projectId).filter((t) => !t.nativeSubagent),
  'threads.get': (id: string) => {
    const t = store.findThread(id);
    if (!t) return null;
    store.updateSettings({ lastThreadId: id, lastProjectId: t.projectId });
    return { thread: t, session: agents.sessionView(id) };
  },
  'threads.all': () => store.listAllThreads(),
  'threads.pin': (id: string, pinned: boolean) => store.updateThreadMeta(id, { pinned }),
  'projects.general': () => store.generalProject(),
  'threads.create': async (projectId: string, agentId: string, mode?: 'chat' | 'code', opts?: { worktree?: boolean }) => {
    projectId = store.baseProjectId(projectId);
    const t = store.createThread(projectId, agentId, { ...(mode ? { mode } : {}), ...(agents.autoApproveDefault(agentId) ? { autoApprove: true } : {}) });
    if (opts?.worktree) {
      // The worktree exists before any agent session, so the first session/new already gets it as cwd.
      try {
        await startChatWorktree(t);
        emit('thread:meta', store.threadMeta(t));
      } catch (e: any) {
        store.deleteThread(t);
        throw new Error(e?.message ?? String(e));
      }
    }
    store.updateSettings({ lastThreadId: t.id, lastProjectId: projectId });
    return t;
  },
  /** Git worktree chats (src/main/worktreeChats.ts): live status, merge / squash into the base branch, remove. */
  'worktree.status': (threadId: string) => chatWorktreeStatus(threadId),
  'worktree.merge': async (threadId: string, mode: 'merge' | 'squash', message?: string) => {
    const r = await mergeChatWorktree(threadId, mode, message);
    const t = store.findThread(threadId);
    if (r.ok && t) emit('thread:meta', store.threadMeta(t));
    return r;
  },
  'worktree.remove': async (threadId: string) => {
    const r = await removeChatWorktree(threadId);
    const t = store.findThread(threadId);
    if (r.ok && t) emit('thread:meta', store.threadMeta(t));
    return { ok: r.ok, ...(r.branchKept ? { branchKept: true } : {}), ...(r.error ? { error: r.error } : {}) };
  },
  'threads.rename': (id: string, title: string) => {
    const t = store.findThread(id);
    if (t) {
      t.title = title;
      // The user's own name wins over titles the agent suggests later (session_info_update).
      t.titleSetByUser = true;
      store.saveThreadNow(t);
    }
  },
  'threads.fork': (id: string, uptoItemId?: string) => {
    const parent = store.findThread(id);
    if (!parent) throw new Error('Chat not found.');
    store.flushThreads();
    const t = store.forkThread(parent, uptoItemId);
    store.updateSettings({ lastThreadId: t.id, lastProjectId: t.projectId });
    return store.threadMeta(t);
  },
  'threads.search': (query: string) => store.searchThreads(query),
  'threads.delete': (id: string) => {
    const t = store.findThread(id);
    if (!t) return;
    const all = [
      ...collectNativeSubagents(store.listThreads(t.projectId), id)
        .map((m) => store.findThread(m.id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c)),
      t,
    ];
    for (const cur of all) {
      void agents.cancel(cur.id).catch(() => {});
      agents.forgetThread(cur.id);
      promptQueue.forget(cur.id);
      forgetOrchestratorThread(cur.id);
      store.deleteThread(cur);
    }
  },

  // ACP session lifecycle (src/main/acpSessionService.ts): import from an agent, delete / rename / fork with the
  // agent's own session, and the new-chat home screen's options.
  'acpConfig.mcpStatus': (threadId: string) => acpConfig.mcpStatusFor(threadId),
  'acpConfig.providers': (agentId: string, start?: boolean) => acpConfig.providersView(agentId, start !== false),
  'acpConfig.setProvider': (agentId: string, input: ProviderInput) => acpConfig.setProvider(agentId, input),
  'acpConfig.disableProvider': (agentId: string, providerId?: string) => acpConfig.disableProvider(agentId, providerId),
  'acpConfig.authDetails': (agentId: string) => acpConfig.authDetails(agentId),
  'acpConfig.loginWithVars': (agentId: string, methodId: string, values: Record<string, string>) => acpConfig.loginWithVars(agentId, methodId, values),
  'acpConfig.forgetLoginVar': (agentId: string, name: string) => acpConfig.forgetLoginVar(agentId, name),
  'acpConfig.answerLoginLink': (agentId: string, action: 'accept' | 'decline' | 'cancel') => acpConfig.answerLoginLink(agentId, action),
  'acpSessions.support': (agentId: string) => acpSessions.supportFor(agentId),
  'acpSessions.list': (projectId: string, agentId: string, opts?: { cursor?: string; archived?: 'exclude' | 'include' | 'only' }) => acpSessions.listNative(projectId, agentId, opts),
  'acpSessions.import': async (projectId: string, agentId: string, session: { sessionId: string; title?: string; archived?: boolean }) => {
    const meta = await acpSessions.importNative(projectId, agentId, session);
    store.updateSettings({ lastThreadId: meta.id, lastProjectId: meta.projectId });
    return meta;
  },
  'acpSessions.archive': (agentId: string, sessionId: string, archived: boolean) => acpSessions.setNativeArchived(agentId, sessionId, archived),
  'acpSessions.deleteNative': (agentId: string, sessionId: string) => acpSessions.deleteNative(agentId, sessionId),
  'acpSessions.deletable': (threadId: string) => acpSessions.deletableSessions(threadId),
  'acpSessions.deleteTargets': (threadId: string) => acpSessions.deleteTargets(threadId),
  /** Delete a chat; opt-in checkboxes in DeleteChatDialog can also delete its sub-sessions and/or saved agent sessions. */
  'acpSessions.deleteChat': async (id: string, alsoAgentSessions: boolean, alsoSubsessions = false) => {
    const subIds = alsoSubsessions ? acpSessions.subsessionsOf(id).map((s) => s.id) : [];
    const ids = store.findThread(id) ? [...subIds, id] : subIds;
    const results = ids.length ? await acpSessions.beforeDeleteChats(ids, Boolean(alsoAgentSessions)) : {};
    for (const tid of ids) await handlers['threads.delete'](tid);
    return results;
  },
  /** Rename a chat and the agent sessions behind it; resolves the title the chat ends up with. */
  'acpSessions.rename': async (id: string, title: string) => {
    await handlers['threads.rename'](id, title);
    return acpSessions.syncTitle(id, title);
  },
  'acpSessions.fork': (id: string, uptoItemId?: string) => {
    const r = acpSessions.forkChat(id, uptoItemId);
    store.updateSettings({ lastThreadId: r.meta.id, lastProjectId: r.meta.projectId });
    return r;
  },
  'acpSessions.status': (threadId: string) => acpSessions.chatSessionStatus(threadId),
  'acpSessions.homeOptions': (projectId: string, agentId: string) => acpSessions.homeOptions(projectId, agentId),
  'acpSessions.setHomeOption': (agentId: string, configId: string, value: string) => acpSessions.setHomeOption(agentId, configId, value),

  'chat.ensure': (threadId: string) => agents.ensureSession(threadId),
  /** The app's code as loaded now vs. on disk: they differ after a new version was installed under a running app. */
  'app.buildInfo': () => {
    let onDisk = RUNNING_BUILD;
    try {
      onDisk = statSync(fileURLToPath(import.meta.url)).mtimeMs;
    } catch {
      /* keep running build */
    }
    return { running: RUNNING_BUILD, onDisk, updated: Math.abs(onDisk - RUNNING_BUILD) > 1000 };
  },
  /** Restart into the installed version (the quit warning still asks if work is running). */
  'app.restart': () => {
    app.relaunch();
    app.quit();
  },
  'chat.states': () => agents.allRunStates(),
  'turn.changes': (threadId: string, itemId: string) => agents.turnChanges(threadId, itemId),
  'turn.fileDiff': (threadId: string, itemId: string, path: string) => agents.turnFileDiff(threadId, itemId, path),
  'turn.fileReview': (threadId: string, itemId: string, path: string) => agents.turnFileReview(threadId, itemId, path),
  'turn.setFile': (threadId: string, itemId: string, path: string, to: 'before' | 'after') => agents.turnSetFile(threadId, itemId, path, to),
  'turn.setHunk': (threadId: string, itemId: string, path: string, hunkIndex: number, action: 'revert' | 'apply') =>
    agents.turnSetHunk(threadId, itemId, path, hunkIndex, action),
  'turn.undoCheck': (threadId: string, itemId: string) => agents.undoCheck(threadId, itemId),
  'turn.undo': (threadId: string, itemId: string) => agents.undoTurn(threadId, itemId),
  'chat.secondOpinion': (threadId: string, itemId: string, agentIds: string[]) => secondOpinion(threadId, itemId, agentIds),
  'turn.redo': (threadId: string, itemId: string) => agents.redoTurn(threadId, itemId),
  /** Tasks panel: the session's parent and sub-sessions with live status. */
  'tasks.list': (threadId: string) => listTasks(threadId),
  /** A sub-session's full transcript for the Tasks panel (unlike threads.get, it doesn't become the "last chat"). */
  'tasks.thread': (id: string) => store.findThread(id) ?? null,
  // Returns at once; the turn streams back through 'thread:item' and 'session:state' events.
  'chat.send': (threadId: string, text: string, files: AttachmentView[] = []) => {
    userSent(threadId);
    void agents.sendPrompt(threadId, text, files, { delivery: true }).catch(() => {});
  },
  'attach.pick': () => attachments.pick(win),
  'attach.describe': (paths: string[]) => attachments.describe(paths),
  'attach.open': (path: string) => {
    if (existsSync(path)) void shell.openPath(path);
  },
  'attach.saveData': (name: string, mime: string, base64: string) => attachments.saveData(name, mime, base64),
  /** Desktop copy: text, HTML and (macOS) a copied message's files as file URLs. Denied over remote. */
  'clipboard.write': (p: ClipboardPayload) => writeClipboard(p),
  'clipboard.readMessage': () => readClipboardMessage(),
  'chat.cancel': (threadId: string) => {
    userCancelled(threadId);
    promptQueue.onUserStop(threadId);
    return agents.cancel(threadId);
  },
  /** Composer send: goes out now, or waits in the chat's queue while the agent is busy or offline (ticks show which). */
  'queue.submit': (threadId: string, text: string, files: AttachmentView[] = []) => {
    userSent(threadId);
    return promptQueue.submit(threadId, text, files);
  },
  'queue.get': (threadId: string) => promptQueue.view(threadId),
  'queue.remove': (threadId: string, id: string) => promptQueue.remove(threadId, id) ?? null,
  'queue.edit': (threadId: string, id: string, text: string) => promptQueue.edit(threadId, id, text),
  /** Steer it into the running turn where the agent can, else stop the turn and send it. */
  'queue.sendNow': (threadId: string, id: string) => promptQueue.sendNow(threadId, id),
  'chat.stopTool': (threadId: string, toolItemId: string) => {
    userCancelled(threadId);
    return agents.stopTool(threadId, toolItemId);
  },
  'chat.switchAgent': (threadId: string, agentId: string) => agents.switchAgent(threadId, agentId),
  'chat.resetContext': (threadId: string) => agents.resetContext(threadId),
  'chat.setConfig': (threadId: string, configId: string, value: string) => agents.setConfigOption(threadId, configId, value),
  'chat.autoApprove': (threadId: string, on: boolean) => agents.setAutoApprove(threadId, on),
  'chat.permission': (threadId: string, itemId: string, optionId: string | null) => agents.resolvePermission(threadId, itemId, optionId),
  'chat.elicitation': (threadId: string, itemId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown> | null) =>
    agents.resolveElicitation(threadId, itemId, action, content),

  'schedules.list': () => schedules.listSchedules(),
  'schedules.save': (task) => schedules.saveSchedule(task, emit),
  'schedules.delete': (id: string) => schedules.deleteSchedule(id, emit),
  'schedules.runNow': (id: string) => schedules.runSchedule(id, emit),

  'usage.summary': (days?: number) => usageSummary(days),
  'projects.stats': (projectId: string, days?: number) => projectStats(projectOrThrow(store.baseProjectId(projectId)), days),

  'memory.get': (projectId: string) => {
    const p = store.getProject(projectId);
    return p ? getMemoryView(p) : null;
  },
  'memory.reveal': (projectId: string) => {
    const p = store.getProject(projectId);
    if (p) shell.openPath(memoryDir(p));
  },
  'memory.openGlobal': () => shell.openPath(globalInstructionsPath()),
  'shared.reveal': () => shell.openPath(store.sharedRoot()),
  'preview.open': (ref: string, projectId?: string) => openPreview(ref, projectId),
  'preview.saveAs': (ref: string, projectId?: string) => savePreviewAs(win, ref, projectId),
  'preview.raw': (ref: string, projectId?: string) => readPreviewRaw(ref, projectId),

  'connectors.list': () => connectors.listConnectors(),
  'connectors.save': (input: connectors.ConnectorInput) => connectors.saveConnector(input),
  'connectors.remove': (id: string) => connectors.removeConnector(id),
  'connectors.enable': (id: string, on: boolean) => connectors.setConnectorEnabled(id, on),
  'connectors.test': (id: string) => connectors.testConnector(id),
  'connectors.candidates': () => connectors.importCandidates(),

  'tools.rules': (rules: Settings['toolRules']) => store.updateSettings({ toolRules: rules }),
  'tools.forgetSeen': () => store.updateSettings({ seenTools: [] }),

  'skills.list': () => skills.listSkills(),
  'skills.get': (id: string) => skills.getSkill(id),
  'skills.save': (input: { id?: string; name: string; description: string; body: string }) => skills.saveSkill(input),
  'skills.delete': (id: string) => skills.deleteSkill(id),
  'skills.enable': (id: string, on: boolean) => skills.setSkillEnabled(id, on),
  'skills.candidates': () => skills.skillImportCandidates(),
  'skills.import': (path: string) => skills.importSkill(path),
  'skills.reveal': () => {
    mkdirSync(skills.skillsDir(), { recursive: true });
    void shell.openPath(skills.skillsDir());
  },

  'memory.read': (projectId: string, name: string) => readMemoryFile(projectOrThrow(projectId), name),
  'memory.write': (projectId: string, name: string, text: string) => writeMemoryFile(projectOrThrow(projectId), name, text),
  'memory.delete': (projectId: string, name: string) => deleteMemoryFile(projectOrThrow(projectId), name),
  'memory.create': (projectId: string, m: Parameters<typeof createMemory>[1]) => createMemory(projectOrThrow(projectId), m),
  'memory.writeGlobal': (text: string) => writeGlobalInstructions(text),
  'profile.notes': () => listNotes(),
  'profile.deleteNote': (id: string) => deleteNote(id),
  'profile.clearNotes': () => clearNotes(),
  'memory.writeProjectInstructions': (projectId: string, text: string) => writeProjectInstructions(projectOrThrow(projectId), text),
  'preview.openDefault': (path: string) => openInDefaultApp(path),
  'preview.reveal': (path: string) => revealInFinder(path),
  /** A newer release than this app (src/main/updates.ts), or null; "Not now" skips that version. */
  'updates.current': () => currentUpdate(),
  'updates.skip': (version: string) => skipUpdate(String(version)),
  'updates.check': () => checkNow(),
  'updates.lastCheck': () => lastUpdateCheck(),
  'updates.cancel': () => cancelDownload(),
  /** "Restart to update": quits (the running-work warning still asks); a helper swaps the app and relaunches it. */
  'updates.install': () => installAndRestart(),
  /** Model capability tags (Free / Vision / Reasoning / Tools) for the model picker (src/main/modelTags.ts). */
  'models.tags': () => modelTags(),
  'system.openExternal': (url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  },
};

acpSessions.initAcpSessionService({
  store,
  ensureSession: (threadId) => agents.ensureSession(threadId),
  knownOptions: (agentId) => agents.knownOptionsForAgent(agentId),
  worktreeStatus: (threadId) => chatWorktreeStatus(threadId),
});
// The orchestrator's delete_subsession tool removes a chat exactly like the sidebar's Delete (agent session closed,
// the agent's own saved session kept).
setChatDeleter(async (id) => handlers['acpSessions.deleteChat'](id, false));

const ALLOWED_WHILE_LOCKED = new Set(['app.state', 'lock.unlock', 'lock.touchId', 'app.buildInfo', 'app.restart']);

const remoteInitPromise = initRemote(handlers, () => lock.isLocked());

if (!HEADLESS) {
ipcMain.handle('desk:invoke', async (_e, method: string, args: unknown[]) => {
  if (lock.isLocked() && !ALLOWED_WHILE_LOCKED.has(method)) throw new Error('LOCKED');
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  return fn(...(args ?? []));
});
// The composer's mic button: starts the OS's own dictation. Desktop window only (not in `handlers`, so never remote).
ipcMain.handle('desk:dictate', (e) => (lock.isLocked() ? { ok: false, error: 'LOCKED' } : startDictation(e.sender)));
// Settings → Voice and the recording mic (src/main/voice). Desktop window only, like desk:dictate: the phone/relay can
// never record, transcribe or touch voice keys. Only the app's own window may call it.
ipcMain.handle('desk:voice', (e, method: string, args: unknown[]) => {
  if (lock.isLocked()) throw new Error('LOCKED');
  if (!win || e.sender !== win.webContents) throw new Error('Not allowed');
  return voiceCall(e.sender, method, args ?? []);
});
// Detached Workbench tool windows (src/main/panels.ts). App windows only (not in `handlers`, so never remote).
initPanels({
  preload: join(here, '../preload/index.mjs'),
  rendererHtml: join(here, '../renderer/index.html'),
  devUrl: process.env.ELECTRON_RENDERER_URL,
  testHidden: TEST_HIDDEN,
  mainWindow: () => win,
  send: (channel, payload) => {
    if (!lock.isLocked()) sendToWindows(channel, payload);
  },
});
ipcMain.handle('desk:panels', (e, method: string, args: unknown[]) => {
  if (lock.isLocked()) throw new Error('LOCKED');
  if (!isAppSender(e.sender)) throw new Error('Not allowed');
  return panelCall(e.sender, method, args ?? []);
});
}

function createWindow() {
  win = new BrowserWindow({
    ...(TEST_HIDDEN ? { focusable: false, skipTaskbar: true } : {}),
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    // macOS: frosted-glass sidebar. The page paints its own opaque panels; only the sidebar lets it through.
    ...(process.platform === 'darwin'
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000' }
      : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#fcfcfd' }),
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // For the Web tab (a dev server preview). Every <webview> is checked in 'will-attach-webview' below.
      webviewTag: true,
    },
  });
  // A web preview may only show a local dev server (no Node, no preload, own session); links go to the browser.
  hardenWindow(win);
  // OLYMPUS_TEST_HIDDEN: shown without focus, clicks or screen space (src/main/windowGuards.ts).
  showWhenReady(win, TEST_HIDDEN);
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

/**
 * Menu commands reach every app window (a detached Files window needs Cmd+S); each window ignores the ones it has no
 * use for. Save goes only to the focused app window when there is one, so the main editor and a detached one never
 * both save on one key press.
 */
function sendMenu(cmd: string, focused?: Electron.BaseWindow) {
  if (lock.isLocked()) return;
  const target = cmd === 'save' ? allWindows().find((w) => w === focused) : undefined;
  if (target) target.webContents.send('desk:event', 'menu', cmd);
  else sendToWindows('menu', cmd);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: (_i, w) => sendMenu('new-chat', w) },
          { label: 'Search Chats', accelerator: 'CmdOrCtrl+K', click: (_i, w) => sendMenu('search', w) },
          { label: 'Chat Mode', accelerator: 'CmdOrCtrl+1', click: (_i, w) => sendMenu('mode-chat', w) },
          { label: 'Code Mode', accelerator: 'CmdOrCtrl+2', click: (_i, w) => sendMenu('mode-code', w) },
          { label: 'Save File', accelerator: 'CmdOrCtrl+S', click: (_i, w) => sendMenu('save', w) },
          { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: (_i, w) => sendMenu('terminal', w) },
          { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: (_i, w) => sendMenu('sidebar', w) },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: (_i, w) => sendMenu('settings', w) },
          { type: 'separator' },
          { label: `Lock ${APP_NAME}`, accelerator: 'CmdOrCtrl+L', click: () => lock.lockNow() },
          { type: 'separator' },
          isMac ? { role: 'close' as const } : { role: 'quit' as const },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

const readyPromise = app.whenReady().then(async () => {
  // A dev run is Electron.app, whose Dock icon is Electron's; show ours (the packaged app uses build/icon.png).
  if (!HEADLESS && !app.isPackaged && process.platform === 'darwin') {
    const dockIcon = join(app.getAppPath(), 'build', 'icon-dock.png');
    if (existsSync(dockIcon)) app.dock?.setIcon(dockIcon);
    if (TEST_HIDDEN) {
      // Never activate or bring the test app forward on macOS (no Dock icon, no menu bar takeover).
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    }
  }
  mkdirSync(store.sharedRoot(), { recursive: true });
  projectsWatch = watchProjectsFile({ dir: store.sharedRoot, onChange: announceProjects });
  if (!HEADLESS) {
    // Microphone only for the app's own window, audio only (src/main/permissions.ts).
    installPermissionHandlers(join(here, '../renderer'), process.env.ELECTRON_RENDERER_URL);
    initVoice();
    // Native parts (vibrancy, menus, dialogs) follow the app's own light / dark choice.
    nativeTheme.themeSource = store.getSettings().theme.mode;
    lock.startLockWatchers();
    startUpdateChecker(emit);
  }
  schedules.startScheduler(emit);
  // Model capability tags: cached registry, refreshed in the background when older than 7 days.
  startModelTags(emit);
  // Plan limits of every ready agent, without a chat: at start, every 5 minutes and right after each reset time.
  agents.limitsService.start(4000);
  if (!HEADLESS) buildMenu();
  restoreTerminals();
  initSavedCommands(emit);
  // Leftovers of failed snapshots (e.g. a huge project's first try) are removed a little after start.
  setTimeout(cleanUpCheckpoints, 8000);
  if (!HEADLESS) startHeatWatch(emit);
  startJobWatch();
  if (!HEADLESS) createWindow();
  // Messages and agent wake-up timers still pending when the app last closed resume once ready.
  setTimeout(() => {
    resumeQueues();
    restoreAgentTimers(join(app.getPath('userData'), 'agent-timers.json'), (id) => Boolean(store.findThread(id)));
  }, 1500);
  if (!HEADLESS) {
    app.on('activate', () => {
      // The main window, even when a detached tool window is still open.
      if (!win) createWindow();
    });
  }
  await remoteInitPromise;
});

app.on('second-instance', () => {
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (TEST_HIDDEN) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

// Inside a web preview, links that open new windows go to the user's browser.
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

/**
 * Quitting ends every agent and terminal the app started. When something is still working, say what and ask
 * first; on macOS "Keep running" closes the window and leaves the work going (the app stays in the Dock).
 */
let quitConfirmed = false;
/** Agent sessions get `session/close` once before the agents are stopped (at most 1.5 s, then the quit goes on). */
let sessionsClosed = false;
app.on('before-quit', (e) => {
  if (!HEADLESS && !quitConfirmed) {
    const work = [...agents.runningWork(), ...busyTerminals().map((t) => `Terminal: ${t.title}`)];
    if (work.length) {
      e.preventDefault();
      const mac = process.platform === 'darwin';
      const buttons = mac ? ['Quit and stop them', 'Keep running', 'Cancel'] : ['Quit and stop them', 'Cancel'];
      const shown = work.slice(0, 8).map((w) => `• ${w}`);
      if (work.length > 8) shown.push(`• …and ${work.length - 8} more`);
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        message: `${work.length === 1 ? 'One thing is' : `${work.length} things are`} still running`,
        detail: `${shown.join('\n')}\n\nQuitting stops ${work.length === 1 ? 'it' : 'them'}. Terminal output is kept and comes back next time, but the programs end.${mac ? ' "Keep running" closes the window and leaves them going; Olympus stays in the Dock.' : ''}`,
        buttons,
        defaultId: mac ? 1 : 1,
        cancelId: buttons.length - 1,
        noLink: true,
      });
      if (choice !== 0) {
        if (mac && choice === 1) for (const w of BrowserWindow.getAllWindows()) w.close();
        // On Windows / Linux the quit came from closing the last window: bring a window back.
        else if (!BrowserWindow.getAllWindows().length) createWindow();
        return;
      }
    }
    quitConfirmed = true;
  }
  if (!sessionsClosed) {
    sessionsClosed = true;
    e.preventDefault();
    void agents.closeAllSessions(1500).finally(() => app.quit());
    return;
  }
  store.flushThreads();
  projectsWatch?.close();
  flushTerminals();
  savedCommandsQuitting();
  pauseAgentTimersForQuit();
  stopRemote();
  agents.shutdownAgents();
  stopOrchestrator();
  killAllPtys();
  acpTerminals.killAll();
  shutdownVoice();
});
// The quit is certain now: a downloaded update is installed by a detached helper once this process has exited.
app.on('will-quit', () => {
  app.releaseSingleInstanceLock();
  // The warm whisper-server never outlives the app.
  shutdownVoice();
  try {
    onAppWillQuit();
  } catch (e) {
    console.error('[updates] could not start the install helper:', e);
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
await readyPromise;
}
