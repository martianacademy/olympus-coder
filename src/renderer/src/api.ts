import { clearDraft } from './drafts';
import type {
  UpdateInfo,
  LearnedNote,
  ProjectStats,
  RemoteStatus,
  PortInfo,
  TurnFileChange,
  ProcAction,
  RunningTask,
  TerminalView,
  AttachmentView,
  CatalogEntry,
  CatalogMethod,
  FileContent,
  FileEntry,
  ConnectorView,
  ImportCandidate,
  SkillView,
  ToolRule,
  FilePreview,
  GitBranch,
  GitCommit,
  GitStash,
  GitStatus,
  UserProfile,
  AgentDef,
  AgentStatus,
  AppState,
  LockOptions,
  LockState,
  MemoryView,
  Project,
  ScheduledTask,
  SearchHit,
  UsageSummary,
  SessionView,
  SubTaskView,
  Settings,
  Thread,
  ThreadMeta,
} from '@shared/types';

declare global {
  interface Window {
    desk: {
      invoke: (method: string, ...args: unknown[]) => Promise<any>;
      on: (fn: (channel: string, payload: any) => void) => () => void;
      pathForFile: (file: File) => string;
      /** Phone link only: marks a chat or terminal as on screen, so the Mac streams it (see remote/bridge.ts). */
      watch?: (kind: 'thread' | 'pty', id: string) => () => void;
    };
  }
}

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.desk.invoke(method, ...args);

/** When this window last asked for a terminal (Run on a command): only then may a new one cover the chat on a phone. */
let terminalAskedAt = 0;
export const terminalAskedRecently = () => Date.now() - terminalAskedAt < 10_000;
type LockResult = { ok: boolean; error?: string; state: LockState };

export const api = {
  state: () => call<AppState>('app.state'),
  updateSettings: (patch: Partial<Settings>) => call<Settings>('settings.update', patch),
  pickSharedRoot: () => call<Settings | null>('settings.pickSharedRoot'),
  updateProfile: (patch: Partial<UserProfile>) => call<Settings>('profile.update', patch),

  unlock: (pw: string) => call<LockResult>('lock.unlock', pw),
  unlockTouchId: () => call<LockResult>('lock.touchId'),
  lockNow: () => call<LockState>('lock.lockNow'),
  setPassword: (current: string | null, next: string) => call<LockResult>('lock.setPassword', current, next),
  removePassword: (current: string) => call<LockResult>('lock.remove', current),
  lockOptions: (patch: Partial<LockOptions>) => call<LockState>('lock.options', patch),

  agents: () => call<{ defs: AgentDef[]; statuses: AgentStatus[] }>('agents.list'),
  catalog: () => call<CatalogEntry[]>('catalog.list'),
  addFromCatalog: (id: string, method: CatalogMethod) => call<{ defs: AgentDef[]; statuses: AgentStatus[] }>('catalog.add', id, method),
  autoAddInstalled: () => call<{ names: string[]; defs: AgentDef[]; statuses: AgentStatus[] }>('catalog.autoAdd'),
  installBuiltin: (id: string) => call<string>('catalog.installBuiltin', id),
  /** No id: re-read agents whose limits are stale (the limits UI opened). An id: read that agent now. */
  refreshLimits: (agentId?: string) => call<{ defs: AgentDef[]; statuses: AgentStatus[] }>('agents.refreshLimits', ...(agentId ? [agentId] : [])),
  checkAgent: (id: string) => call<AgentStatus>('agents.check', id),
  authAgent: (id: string, methodId: string, apiKey?: string) => call<AgentStatus>('agents.auth', id, methodId, apiKey),
  terminalLogin: (id: string, methodId: string) => call<string>('agents.terminalLogin', id, methodId),
  logoutAgent: (id: string) => call<AgentStatus>('agents.logout', id),
  restartAgent: (id: string) => call<AgentStatus>('agents.restart', id),
  setAgentLogo: (id: string, logo: string) => call<{ defs: AgentDef[]; statuses: AgentStatus[] }>('agents.setLogo', id, logo),
  addCustomAgent: (def: Pick<AgentDef, 'name' | 'command' | 'args' | 'env' | 'color' | 'logo'>) => call<{ defs: AgentDef[]; statuses: AgentStatus[] }>('agents.addCustom', def),
  removeCustomAgent: (id: string) => call<{ defs: AgentDef[]; statuses: AgentStatus[] }>('agents.removeCustom', id),

  ptyWrite: (id: string, data: string) => call<void>('pty.write', id, data),
  ptyResize: (id: string, cols: number, rows: number) => call<void>('pty.resize', id, cols, rows),
  ptyKill: (id: string) => call<void>('pty.kill', id),
  ptyBuffer: (id: string) => call<{ data: string; end: number; alive: boolean }>('pty.buffer', id),
  ptyForget: (id: string) => call<void>('pty.forget', id),
  termStart: (projectId: string) => call<string>('term.start', projectId),
  terminalList: (projectId: string) => call<TerminalView[]>('terminal.list', projectId),
  procs: () => call<RunningTask[]>('procs.list'),
  remoteStatus: () => call<RemoteStatus>('remote.status'),
  remoteEnable: (on: boolean) => call<RemoteStatus>('remote.enable', on),
  remoteSetLan: (on: boolean) => call<RemoteStatus>('remote.lan', on),
  remoteAllowFirewall: () => call<RemoteStatus>('remote.allowFirewall'),
  remotePair: () => call<RemoteStatus>('remote.pair'),
  remoteRemoveDevice: (id: string) => call<RemoteStatus>('remote.removeDevice', id),
  remoteTailscaleServe: () => call<RemoteStatus>('remote.tailscaleServe'),
  remoteCheckTailscale: () => call<RemoteStatus>('remote.checkTailscale'),
  remoteLink: () => call<string>('remote.link'),
  remoteSetRelayUrl: (url: string) => call<RemoteStatus>('remote.setRelayUrl', url),
  remoteResetLink: () => call<RemoteStatus>('remote.resetLink'),
  chatStates: () => call<{ threadId: string; status: string; pendingPermissions: number; permissionIds?: string[]; askIds?: string[]; background: string[] }[]>('chat.states'),
  ports: () => call<PortInfo[]>('ports.list'),
  stopPort: (pid: number) => call<void>('ports.stop', pid),
  testCommand: (projectId: string) => call<string | null>('tests.command', projectId),
  turnChanges: (threadId: string, itemId: string) => call<{ files: TurnFileChange[]; undone: boolean }>('turn.changes', threadId, itemId),
  turnFileDiff: (threadId: string, itemId: string, path: string) => call<string>('turn.fileDiff', threadId, itemId, path),
  turnUndoCheck: (threadId: string, itemId: string) => call<{ files: string[]; changedSince: string[] }>('turn.undoCheck', threadId, itemId),
  turnUndo: (threadId: string, itemId: string) => call<void>('turn.undo', threadId, itemId),
  secondOpinion: (threadId: string, itemId: string, agentIds: string[]) => call<string[]>('chat.secondOpinion', threadId, itemId, agentIds),
  turnRedo: (threadId: string, itemId: string) => call<void>('turn.redo', threadId, itemId),
  procControl: (id: string, action: ProcAction) => call<RunningTask[]>('procs.control', id, action),
  terminalClose: (ptyId: string) => call<void>('terminal.close', ptyId),
  terminalRerun: (ptyId: string) => call<{ ptyId: string; title: string }>('terminal.rerun', ptyId),
  runInTerminal: (projectId: string, command: string) => {
    terminalAskedAt = Date.now();
    return call<{ ptyId: string; title: string }>('terminal.run', projectId, command);
  },

  files: {
    list: (pid: string, rel: string) => call<FileEntry[]>('files.list', pid, rel),
    read: (pid: string, rel: string) => call<FileContent>('files.read', pid, rel),
    write: (pid: string, rel: string, text: string, mtime?: number) => call<{ mtime: number; conflict?: boolean }>('files.write', pid, rel, text, mtime),
    create: (pid: string, rel: string, dir: boolean) => call<FileEntry>('files.create', pid, rel, dir),
    rename: (pid: string, from: string, to: string) => call<void>('files.rename', pid, from, to),
    trash: (pid: string, rel: string) => call<void>('files.trash', pid, rel),
    reveal: (pid: string, rel: string) => call<void>('files.reveal', pid, rel),
    editors: () => call<{ id: string; name: string }[]>('files.editors'),
    openIn: (pid: string, rel: string, editorId: string) => call<void>('files.openIn', pid, rel, editorId),
    openDefault: (pid: string, rel: string) => call<void>('files.openDefault', pid, rel),
  },

  git: {
    status: (pid: string) => call<GitStatus>('git.status', pid),
    init: (pid: string) => call<string>('git.init', pid),
    diff: (pid: string, path: string, staged: boolean, untracked: boolean) => call<string>('git.diff', pid, path, staged, untracked),
    stage: (pid: string, paths: string[]) => call<string>('git.stage', pid, paths),
    stageAll: (pid: string) => call<string>('git.stageAll', pid),
    unstage: (pid: string, paths: string[]) => call<string>('git.unstage', pid, paths),
    unstageAll: (pid: string) => call<string>('git.unstageAll', pid),
    discard: (pid: string, paths: string[], untracked: boolean) => call<void>('git.discard', pid, paths, untracked),
    commit: (pid: string, message: string, opts: { amend?: boolean; all?: boolean }) => call<string>('git.commit', pid, message, opts),
    push: (pid: string, opts: { setUpstream?: boolean; force?: boolean } = {}) => call<string>('git.push', pid, opts),
    pull: (pid: string, rebase = false) => call<string>('git.pull', pid, rebase),
    fetch: (pid: string) => call<string>('git.fetch', pid),
    branches: (pid: string) => call<GitBranch[]>('git.branches', pid),
    checkout: (pid: string, name: string, remote: boolean) => call<string>('git.checkout', pid, name, remote),
    createBranch: (pid: string, name: string) => call<string>('git.createBranch', pid, name),
    deleteBranch: (pid: string, name: string, force = false) => call<string>('git.deleteBranch', pid, name, force),
    merge: (pid: string, name: string) => call<string>('git.merge', pid, name),
    log: (pid: string, limit = 100) => call<GitCommit[]>('git.log', pid, limit),
    show: (pid: string, hash: string) => call<string>('git.show', pid, hash),
    stashes: (pid: string) => call<GitStash[]>('git.stashes', pid),
    stashSave: (pid: string, message: string) => call<string>('git.stashSave', pid, message),
    stashPop: (pid: string, ref: string) => call<string>('git.stashPop', pid, ref),
    stashApply: (pid: string, ref: string) => call<string>('git.stashApply', pid, ref),
    stashDrop: (pid: string, ref: string) => call<string>('git.stashDrop', pid, ref),
  },

  projects: () => call<Project[]>('projects.list'),
  addProject: (path?: string) => call<Project | null>('projects.add', path),
  removeProject: (id: string) => call<void>('projects.remove', id),
  relocateProject: (id: string, path?: string) => call<Project | null>('projects.relocate', id, path),
  reorderProjects: (ids: string[]) => call<void>('projects.reorder', ids),
  revealProject: (id: string) => call<void>('projects.reveal', id),

  threads: (projectId: string) => call<ThreadMeta[]>('threads.list', projectId),
  thread: (id: string) => call<{ thread: Thread; session: SessionView } | null>('threads.get', id),
  createThread: (projectId: string, agentId: string, mode?: 'chat' | 'code') => call<Thread>('threads.create', projectId, agentId, mode),
  allThreads: () => call<ThreadMeta[]>('threads.all'),
  pinThread: (id: string, pinned: boolean) => call<ThreadMeta>('threads.pin', id, pinned),
  generalProject: () => call<Project>('projects.general'),
  forkThread: (id: string, uptoItemId?: string) => call<ThreadMeta>('threads.fork', id, uptoItemId),
  searchThreads: (query: string) => call<SearchHit[]>('threads.search', query),
  schedules: () => call<ScheduledTask[]>('schedules.list'),
  saveSchedule: (task: Partial<ScheduledTask>) => call<ScheduledTask[]>('schedules.save', task),
  deleteSchedule: (id: string) => call<ScheduledTask[]>('schedules.delete', id),
  runSchedule: (id: string) => call<string | null>('schedules.runNow', id),
  renameThread: (id: string, title: string) => call<void>('threads.rename', id, title),
  deleteThread: (id: string) => call<void>('threads.delete', id).then(() => clearDraft(id)),

  ensureSession: (threadId: string) => call<boolean>('chat.ensure', threadId),
  tasks: (threadId: string) => call<{ parent?: SubTaskView; children: SubTaskView[] }>('tasks.list', threadId),
  taskThread: (id: string) => call<Thread | null>('tasks.thread', id),
  send: (threadId: string, text: string, files: AttachmentView[] = []) => call<void>('chat.send', threadId, text, files),
  pickAttachments: () => call<AttachmentView[]>('attach.pick'),
  describeAttachments: (paths: string[]) => call<AttachmentView[]>('attach.describe', paths),
  openAttachment: (path: string) => call<void>('attach.open', path),
  saveAttachment: (name: string, mime: string, base64: string) => call<AttachmentView>('attach.saveData', name, mime, base64),
  cancel: (threadId: string) => call<void>('chat.cancel', threadId),
  stopTool: (threadId: string, toolItemId: string) => call<void>('chat.stopTool', threadId, toolItemId),
  switchAgent: (threadId: string, agentId: string) => call<SessionView>('chat.switchAgent', threadId, agentId),
  setConfig: (threadId: string, configId: string, value: string) => call<SessionView>('chat.setConfig', threadId, configId, value),
  permission: (threadId: string, itemId: string, optionId: string | null) => call<void>('chat.permission', threadId, itemId, optionId),
  /** Answer a question from the agent (ACP elicitation): accept with the form's content, decline, or cancel. */
  elicitation: (threadId: string, itemId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) =>
    call<void>('chat.elicitation', threadId, itemId, action, content ?? null),
  setAutoApprove: (threadId: string, on: boolean) => call<boolean>('chat.autoApprove', threadId, on),

  usage: (days = 30) => call<UsageSummary>('usage.summary', days),
  memory: (projectId: string) => call<MemoryView | null>('memory.get', projectId),
  revealMemory: (projectId: string) => call<void>('memory.reveal', projectId),
  openGlobalInstructions: () => call<void>('memory.openGlobal'),
  revealShared: () => call<void>('shared.reveal'),
  openExternal: (url: string) => call<void>('system.openExternal', url),
  currentUpdate: () => call<UpdateInfo | null>('updates.current'),
  skipUpdate: (version: string) => call<void>('updates.skip', version),
  preview: (ref: string, projectId?: string) => call<FilePreview>('preview.open', ref, projectId),
  previewSaveAs: (ref: string, projectId?: string) => call<{ saved: boolean; path?: string }>('preview.saveAs', ref, projectId),
  previewRaw: (ref: string, projectId?: string) =>
    call<{ name: string; mime: string; size: number; base64: string }>('preview.raw', ref, projectId),

  connectors: () => call<ConnectorView[]>('connectors.list'),
  saveConnector: (input: Omit<ConnectorView, 'id' | 'tools' | 'testedAt' | 'error'> & { id?: string }) => call<ConnectorView[]>('connectors.save', input),
  removeConnector: (id: string) => call<ConnectorView[]>('connectors.remove', id),
  enableConnector: (id: string, on: boolean) => call<ConnectorView[]>('connectors.enable', id, on),
  testConnector: (id: string) => call<ConnectorView[]>('connectors.test', id),
  connectorCandidates: () => call<ImportCandidate[]>('connectors.candidates'),

  setToolRules: (rules: ToolRule[]) => call<Settings>('tools.rules', rules),
  forgetSeenTools: () => call<Settings>('tools.forgetSeen'),

  skills: () => call<SkillView[]>('skills.list'),
  skill: (id: string) => call<SkillView>('skills.get', id),
  saveSkill: (input: { id?: string; name: string; description: string; body: string }) => call<SkillView[]>('skills.save', input),
  deleteSkill: (id: string) => call<SkillView[]>('skills.delete', id),
  enableSkill: (id: string, on: boolean) => call<SkillView[]>('skills.enable', id, on),
  skillCandidates: () => call<ImportCandidate[]>('skills.candidates'),
  importSkill: (path: string) => call<SkillView[]>('skills.import', path),
  revealSkills: () => call<void>('skills.reveal'),

  readMemory: (projectId: string, name: string) => call<string>('memory.read', projectId, name),
  writeMemory: (projectId: string, name: string, text: string) => call<void>('memory.write', projectId, name, text),
  writeProjectInstructions: (projectId: string, text: string) => call<void>('memory.writeProjectInstructions', projectId, text),
  projectStats: (projectId: string, days?: number) => call<ProjectStats>('projects.stats', projectId, days),
  profileNotes: () => call<LearnedNote[]>('profile.notes'),
  deleteProfileNote: (id: string) => call<LearnedNote[]>('profile.deleteNote', id),
  clearProfileNotes: () => call<LearnedNote[]>('profile.clearNotes'),
  deleteMemory: (projectId: string, name: string) => call<void>('memory.delete', projectId, name),
  createMemory: (projectId: string, m: { title: string; type: 'user' | 'feedback' | 'project' | 'reference'; description: string; body: string }) => call<string>('memory.create', projectId, m),
  writeGlobalInstructions: (text: string) => call<void>('memory.writeGlobal', text),
  previewOpenDefault: (path: string) => call<void>('preview.openDefault', path),
  previewReveal: (path: string) => call<void>('preview.reveal', path),
};

export const onEvent = (fn: (channel: string, payload: any) => void) => window.desk.on(fn);

/**
 * On a phone, tells the Mac this chat / terminal is on screen until the returned cleanup runs: chats and
 * terminals that are not get only light updates there. A no-op in the desktop window (it gets everything).
 */
export const remoteWatch = (kind: 'thread' | 'pty', id: string | null | undefined): (() => void) => (id && window.desk.watch ? window.desk.watch(kind, id) : () => {});
