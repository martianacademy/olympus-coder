import type { AgentId, ConfigOptionView } from './types';

/**
 * ACP session lifecycle as one agent supports it, read from its `initialize` answer
 * (`agentCapabilities.loadSession` and `agentCapabilities.sessionCapabilities.*`).
 */
export interface AcpSessionSupport {
  /** `session/load`: reattach and replay the history as `session/update`s. */
  load: boolean;
  /** `session/resume`: reattach without a replay. */
  resume: boolean;
  /** `session/list`, filtered by `cwd`, paged by cursor. */
  list: boolean;
  fork: boolean;
  close: boolean;
  /** `session/delete` (removes the agent's own saved session). */
  delete: boolean;
  /** `session/archive` + `session/unarchive` and the `archived` filter on `session/list`. */
  archive: boolean;
  status: boolean;
  /** `session/options`: the config a new session would start with, before it exists. */
  options: boolean;
  /** `session/set_title`. */
  setTitle: boolean;
  additionalDirectories: boolean;
}

/** One of the agent's own saved sessions (`session/list`), as the import list shows it. */
export interface NativeSessionView {
  sessionId: string;
  cwd: string;
  title: string;
  /** Last activity (ms since epoch), when the agent reports it. */
  updatedAt?: number;
  archived?: boolean;
  /** The Olympus chat already bound to this session, if any. */
  threadId?: string;
}

export interface NativeSessionPage {
  agentId: AgentId;
  support: AcpSessionSupport;
  sessions: NativeSessionView[];
  /** Pass back to get the next page; absent on the last page. */
  nextCursor?: string;
}

export type NativeArchiveFilter = 'exclude' | 'include' | 'only';

/** What happened to the agent's side of a chat on an Olympus action (rename, delete, close, fork…). */
export type AcpSideEffect = 'done' | 'unsupported' | 'not-running' | 'failed';

/** The new-chat home screen: the options a session of this agent would start with (`session/options`). */
export interface HomeSessionOptions {
  agentId: AgentId;
  supported: boolean;
  configOptions: ConfigOptionView[];
  error?: string;
}

/** What the delete dialog may offer for one chat: the agent sessions behind it that the agent can delete. */
export interface DeletableAgentSession {
  agentId: AgentId;
  sessionId: string;
}
