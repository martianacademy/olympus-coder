import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppState, AttachmentView, DeskEvents, ProcAction, Settings } from '@shared/types';
import * as agents from './agents';
import * as attachments from './attachments';
import { readClipboardMessage, writeClipboard, type ClipboardPayload } from './clipboard';
import * as catalog from './catalog';
import { addCustomAgent, removeCustomAgent, type CustomAgentInput } from './customAgents';
import { agentEnv, loadLoginShellPath, userShell } from './env';
import * as files from './files';
import * as git from './git';
import * as lock from './lock';
import { openInDefaultApp, openPreview, readPreviewRaw, revealInFinder, savePreviewAs } from './preview';
import { initOrchestrator, listTasks, secondOpinion, setChatDeleter, stopOrchestrator, userCancelled, userSent } from './orchestrator';
import { controlTask, runningTasks } from './processes';
import { listPorts, stopPortOwner } from './ports';
import { startHeatWatch } from './heat';
import { startJobWatch } from './jobwatch';
import { allowInFirewall, initRemote, remoteBroadcast, remoteStatus, removeDevice, resetPhoneLink, setRelayUrl, setRemoteEnabled, setRemoteLan, startPairing, stopRemote, tailscaleServe, checkTailscale } from './remote';
import { clearNotes, deleteNote, listNotes } from './usernotes';
import { relayLink } from './relay';
import { cleanUpCheckpoints, forgetCheckpoints } from './checkpoints';
import { detectTestCommand } from './testcmd';
import { busyTerminals, closeTerminal, flushTerminals, listTerminals, openTerminal, rerunTerminal, restoreTerminals, setTerminalEmitter } from './terminals';
import { createMemory, deleteMemoryFile, getMemoryView, globalInstructionsPath, memoryDir, readMemoryFile, writeGlobalInstructions, writeMemoryFile, writeProjectInstructions } from './memory';
import * as connectors from './connectors';
import * as skills from './skills';
import { forgetPty, killAllPtys, killPty, ptyBuffer, resizePty, startPty, writePty } from './pty';
import * as schedules from './schedules';
import * as store from './store';
import * as acpSessions from './acpSessionService';
import * as acpConfig from './acpConfigService';
import type { AcpConfigEvents, ProviderInput } from '@shared/acpConfig';
import { usageSummary } from './usage';
import { projectStats } from './projectstats';
import type { AcpClientEvents, EditorBufferReport } from '@shared/acpClient';
import { setAgentWriteEmitter } from './acpClientFs';
import { acpTerminals, acpTerminalStore } from './acpTerminals';
import { forgetEditorClient, reportEditorBuffers } from './editorBuffers';
import type { PromptQueueEvents } from '@shared/promptQueue';
import * as promptQueue from './promptQueue';
import { resumeQueues, startPromptQueue } from './promptQueueHost';

/** `OLYMPUS_TEST_HIDDEN=1`: an automated-test instance whose window must never take focus, clicks or screen space. */
const TEST_HIDDEN = process.env.OLYMPUS_TEST_HIDDEN === '1';

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

loadLoginShellPath();
const here = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;

const emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => {
  // Nothing but the lock state reaches the window while the app is locked.
  // (Phones are handled on their own: one that typed the password keeps working while this window is locked.)
  remoteBroadcast(channel, payload);
  // The send-while-busy queue follows session state and new items from the same events (src/main/promptQueue.ts).
  promptQueue.observe(channel, payload);
  if (lock.isLocked() && channel !== 'lock:state') return;
  win?.webContents.send('desk:event', channel, payload);
};
agents.setEmitter(emit);
initOrchestrator(emit);
setTerminalEmitter(emit);
/** The ACP client features' events (live agent terminals, files agents wrote): same channel and lock rule as `emit`. */
const emitAcp = <K extends keyof AcpClientEvents>(channel: K, payload: AcpClientEvents[K]) => {
  remoteBroadcast(channel, payload);
  if (lock.isLocked()) return;
  win?.webContents.send('desk:event', channel, payload);
};
acpTerminalStore.setEmitter(emitAcp);
startPromptQueue(emit, <K extends keyof PromptQueueEvents>(channel: K, payload: PromptQueueEvents[K]) => {
  remoteBroadcast(channel, payload);
  if (lock.isLocked()) return;
  win?.webContents.send('desk:event', channel, payload);
});
/** Config / MCP status / login events (src/main/acpConfigService.ts): same channel and lock rule. */
acpConfig.initAcpConfigService({
  secrets: { getSecret: store.getSecret, setSecret: store.setSecret },
  emit: <K extends keyof AcpConfigEvents>(channel: K, payload: AcpConfigEvents[K]) => {
    remoteBroadcast(channel, payload);
    if (lock.isLocked()) return;
    win?.webContents.send('desk:event', channel, payload);
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
  win?.webContents.send('desk:event', 'lock:state', s);
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
    if (patch.sharedRoot) mkdirSync(patch.sharedRoot, { recursive: true });
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
    return store.updateSettings({ sharedRoot: r.filePaths[0] });
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
  'procs.list': () => runningTasks(),
  'ports.list': () => listPorts(),
  'ports.stop': (pid: number) => stopPortOwner(pid),
  'procs.control': (id: string, action: ProcAction) => controlTask(id, action),
  'terminal.close': (ptyId: string) => closeTerminal(ptyId),
  'terminal.rerun': (ptyId: string) => rerunTerminal(ptyId),

  'files.list': (projectId: string, rel: string) => files.listDir(projectId, rel),
  'files.read': (projectId: string, rel: string) => files.readFile(projectId, rel),
  'files.write': (projectId: string, rel: string, text: string, mtime?: number) => files.writeFile(projectId, rel, text, mtime),
  'files.create': (projectId: string, rel: string, dir: boolean) => files.createEntry(projectId, rel, dir),
  'files.rename': (projectId: string, from: string, to: string) => files.renameEntry(projectId, from, to),
  'files.trash': (projectId: string, rel: string) => files.trashEntry(projectId, rel),
  'files.reveal': (projectId: string, rel: string) => files.revealEntry(projectId, rel),

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

  'projects.list': () => store.listProjects(),
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
    store.removeProject(id);
    forgetCheckpoints(id);
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
  'threads.create': (projectId: string, agentId: string, mode?: 'chat' | 'code') => {
    const t = store.createThread(projectId, agentId, { ...(mode ? { mode } : {}), ...(agents.autoApproveDefault(agentId) ? { autoApprove: true } : {}) });
    store.updateSettings({ lastThreadId: t.id, lastProjectId: projectId });
    return t;
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
    void agents.cancel(id).catch(() => {});
    agents.forgetThread(id);
    promptQueue.forget(id);
    store.deleteThread(t);
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
  /** Delete a chat; with `alsoAgentSessions` (opt-in in the dialog) each agent deletes its own saved session too. */
  'acpSessions.deleteChat': async (id: string, alsoAgentSessions: boolean) => {
    const results = store.findThread(id) ? await acpSessions.beforeDeleteChat(id, Boolean(alsoAgentSessions)) : {};
    await handlers['threads.delete'](id);
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
  'projects.stats': (projectId: string, days?: number) => projectStats(projectOrThrow(projectId), days),

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
  'system.openExternal': (url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  },
};

acpSessions.initAcpSessionService({
  store,
  ensureSession: (threadId) => agents.ensureSession(threadId),
  knownOptions: (agentId) => agents.knownOptionsForAgent(agentId),
});
// The orchestrator's delete_subsession tool removes a chat exactly like the sidebar's Delete (agent session closed,
// the agent's own saved session kept).
setChatDeleter(async (id) => handlers['acpSessions.deleteChat'](id, false));

const ALLOWED_WHILE_LOCKED = new Set(['app.state', 'lock.unlock', 'lock.touchId', 'app.buildInfo', 'app.restart']);

void initRemote(handlers, () => lock.isLocked());

ipcMain.handle('desk:invoke', async (_e, method: string, args: unknown[]) => {
  if (lock.isLocked() && !ALLOWED_WHILE_LOCKED.has(method)) throw new Error('LOCKED');
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown method ${method}`);
  return fn(...(args ?? []));
});

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
  // A web preview may only show a local dev server, with no Node, no preload and its own session.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete (prefs as any).preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (!isLocalUrl(params.src)) e.preventDefault();
  });
  win.once('ready-to-show', () => {
    if (!win) return;
    if (!TEST_HIDDEN) return win.show();
    // Automated tests: render normally but never take the user's keyboard focus or clicks, never sit on top of their
    // work, and stay out of the Dock / Mission Control (an opacity-0 window still steals focus and input).
    win.setFocusable(false);
    win.setIgnoreMouseEvents(true);
    win.setOpacity(0);
    win.setSkipTaskbar(true);
    if (process.platform === 'darwin') win.setHiddenInMissionControl(true);
    win.showInactive();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, '../renderer/index.html'));
  win.on('closed', () => (win = null));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => win?.webContents.send('desk:event', 'menu', 'new-chat') },
          { label: 'Search Chats', accelerator: 'CmdOrCtrl+K', click: () => win?.webContents.send('desk:event', 'menu', 'search') },
          { label: 'Chat Mode', accelerator: 'CmdOrCtrl+1', click: () => win?.webContents.send('desk:event', 'menu', 'mode-chat') },
          { label: 'Code Mode', accelerator: 'CmdOrCtrl+2', click: () => win?.webContents.send('desk:event', 'menu', 'mode-code') },
          { label: 'Save File', accelerator: 'CmdOrCtrl+S', click: () => win?.webContents.send('desk:event', 'menu', 'save') },
          { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: () => win?.webContents.send('desk:event', 'menu', 'terminal') },
          { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => win?.webContents.send('desk:event', 'menu', 'sidebar') },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('desk:event', 'menu', 'settings') },
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

app.whenReady().then(() => {
  // A dev run is Electron.app, whose Dock icon is Electron's; show ours (the packaged app uses build/icon.png).
  if (!app.isPackaged && process.platform === 'darwin') {
    const dockIcon = join(app.getAppPath(), 'build', 'icon-dock.png');
    if (existsSync(dockIcon)) app.dock?.setIcon(dockIcon);
    if (TEST_HIDDEN) {
      // Never activate or bring the test app forward on macOS (no Dock icon, no menu bar takeover).
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    }
  }
  mkdirSync(store.sharedRoot(), { recursive: true });
  // Native parts (vibrancy, menus, dialogs) follow the app's own light / dark choice.
  nativeTheme.themeSource = store.getSettings().theme.mode;
  lock.startLockWatchers();
  schedules.startScheduler(emit);
  // Plan limits of every ready agent, without a chat: at start, every 5 minutes and right after each reset time.
  agents.limitsService.start(4000);
  buildMenu();
  restoreTerminals();
  // Leftovers of failed snapshots (e.g. a huge project's first try) are removed a little after start.
  setTimeout(cleanUpCheckpoints, 8000);
  startHeatWatch(emit);
  startJobWatch();
  createWindow();
  // Messages still queued when the app last closed go out once their agent connects (src/main/promptQueue.ts).
  setTimeout(() => resumeQueues(), 1500);
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

/** http(s) on this machine: localhost, 127.x, 0.0.0.0, [::1] — the only pages the Web tab will show. */
const isLocalUrl = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)$/i.test(u.hostname);
  } catch {
    return false;
  }
};

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
  if (!quitConfirmed) {
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
  flushTerminals();
  stopRemote();
  agents.shutdownAgents();
  stopOrchestrator();
  killAllPtys();
  acpTerminals.killAll();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
