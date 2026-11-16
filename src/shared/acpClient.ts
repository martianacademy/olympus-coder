/**
 * Types shared by the main process and the window for the ACP client methods Olympus serves to agents:
 * `fs/read_text_file`, `fs/write_text_file` and `terminal/*`, plus the "terminals" an agent reports
 * through tool-call `_meta` (`terminal_info` / `terminal_output(_delta)` / `terminal_exit`, used by
 * Codex and Claude Code for their own commands).
 */

/** How a command ended (ACP `TerminalExitStatus`). `exitCode` is null when a signal ended it. */
export interface AcpExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/**
 * One terminal as the window shows it (without its output text).
 * `source: 'client'` — Olympus runs the process for the agent (`terminal/create`).
 * `source: 'agent'` — the agent runs it and streams it in tool-call `_meta`; Olympus only shows it.
 */
export interface AcpTerminalMeta {
  /** `<owner>/<terminalId>`, see {@link acpTerminalKey}. */
  key: string;
  /** The chat (thread id) the terminal belongs to. */
  owner: string;
  terminalId: string;
  source: 'client' | 'agent';
  /** The command line as shown in the BASH box. */
  command?: string;
  cwd?: string;
  /** Set once the command ended. */
  exitStatus?: AcpExitStatus;
  /** The process is still running. */
  running: boolean;
  /** The agent released it (`terminal/release`); its output stays viewable. */
  released: boolean;
  /** The window copy keeps only the end of the output; earlier text was dropped. */
  clipped: boolean;
  /** Total characters ever written (also counts dropped ones), to line up live appends with a snapshot. */
  end: number;
  startedAt: number;
  endedAt?: number;
}

/** A terminal with the output the window shows (the last ~512 KB, ANSI codes kept). */
export interface AcpTerminalSnapshot extends AcpTerminalMeta {
  output: string;
}

/**
 * The `acp:terminal` event. `append` is new output whose last character is at `end`;
 * `meta` is sent when anything other than the output changed (start, exit, release).
 */
export interface AcpTerminalEvent {
  key: string;
  append?: string;
  end?: number;
  meta?: AcpTerminalMeta;
}

/** An agent wrote a file through `fs/write_text_file` (main process side). */
export interface AgentFileWrite {
  /** Absolute real path that was written. */
  path: string;
  content: string;
  /** The file had unsaved edits in an editor when the agent wrote it: keep them and ask the user. */
  conflict: boolean;
  /** The file did not exist before. */
  created: boolean;
  ts: number;
}

/** The `editor:agentWrite` event: the write without its text (editors re-read the file), with the projects it is in. */
export interface AgentFileWriteEvent extends Omit<AgentFileWrite, 'content'> {
  /** Each project the file is in, with the file's path relative to it. */
  projects: { projectId: string; rel: string }[];
}

/** One unsaved editor buffer, reported by the window (path relative to the project folder). */
export interface EditorBufferReport {
  path: string;
  text: string;
}

/** Events this feature sends to the window, on the same `desk:event` channel as `DeskEvents`. */
export interface AcpClientEvents {
  'acp:terminal': AcpTerminalEvent;
  'editor:agentWrite': AgentFileWriteEvent;
}

/** The id of a terminal in the app: terminal ids are only unique within one agent session, so they are scoped to a chat. */
export const acpTerminalKey = (owner: string, terminalId: string) => `${owner}/${terminalId}`;
