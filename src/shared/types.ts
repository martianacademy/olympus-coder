// Types shared by the main process, preload and renderer.
import type { RichContent, ToolIdentity, ToolLocation } from './acpContent';

import type { ElicitContent, ElicitSchema } from './elicitation';
import type { QueuedPrompt, UserDelivery } from './promptQueue';
import type { VoiceSettings } from './voice';
import type { ModelTags } from './modelTags';
import type { PanelContext, PanelTool } from './panels';
export type { ModelTags } from './modelTags';

export type AgentId = string;

/** How the app starts an ACP agent. `command` is resolved against the user's login-shell PATH. */
export interface AgentDef {
  id: AgentId;
  name: string;
  /** Two-letter badge shown in the dropdown. */
  badge: string;
  color: string;
  description: string;
  builtin: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** CLI used to detect whether the agent is installed (e.g. `agy`). Empty = bundled with the app. */
  detectBinary?: string;
  installHint?: string;
  /** A key from the bundled logo set, or a data: URL the user uploaded. Empty = detect from name/command. */
  logo?: string;
  /** Set when the agent was added from the ACP registry (its registry id). */
  registryId?: string;
}

/** How a catalog agent can be added. */
export type CatalogMethod = 'local' | 'npx' | 'uvx' | 'binary';

/** One agent from the ACP registry (or a built-in), as shown in onboarding and Settings. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  website?: string;
  version?: string;
  builtin: boolean;
  /** Already an agent in the app. */
  added: boolean;
  /** Its CLI is installed on this computer (path), so it can be added with no download. */
  localPath?: string;
  localVersion?: string;
  /** Ways to add it on this platform, best first. */
  methods: CatalogMethod[];
  /** Built-ins that are missing: the command that installs their CLI. */
  installCommand?: string;
  docs?: string;
  /** Requirements not met for a method, e.g. { npx: 'Node.js is not installed' }. */
  blocked: Partial<Record<CatalogMethod, string>>;
}

export type AgentState = 'unknown' | 'not-installed' | 'starting' | 'ready' | 'needs-login' | 'authenticating' | 'error';

export interface AuthMethodView {
  id: string;
  name: string;
  description?: string;
  /** terminal = run a login command in the in-app terminal; agent = the agent opens a browser itself; api-key / env-vars = paste key(s). */
  flow: 'terminal' | 'agent' | 'api-key' | 'env-vars';
  envVar?: string;
}

export interface RateLimitView {
  /** e.g. five_hour, seven_day */
  window: string;
  label: string;
  /** 0..1 */
  utilization: number;
  resetsAt?: number;
  status?: string;
  /** Model group the limit applies to (Antigravity: Gemini vs Claude & GPT). */
  group?: string;
  /** The agent's own explanation of the limit. */
  note?: string;
  /** Its reset time has passed: counted as reset (0% used) until fresh numbers arrive (`liveLimits`). */
  expired?: boolean;
}

export interface AgentStatus {
  id: AgentId;
  state: AgentState;
  /** Subscription / tier the agent reports, e.g. "Claude Max", "Google AI Ultra". */
  plan?: string;
  limits?: RateLimitView[];
  /** When `limits` were last read (epoch ms). */
  limitsAt?: number;
  /** A limits read for this agent is running now. */
  limitsRefreshing?: boolean;
  /** The last limits read failed (shown quietly next to the age). */
  limitsError?: string;
  /** The agent can report limits without a chat (local daemon or a local `/usage`-style command). */
  limitsReadable?: boolean;
  detail?: string;
  version?: string;
  authMethods: AuthMethodView[];
  hasApiKey: boolean;
  canLogout: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** The folder is gone (renamed or moved): the sidebar offers "Locate…" (projects.list only). */
  missing?: boolean;
}

/** Tokens the agent read for one turn (this message plus the whole context it carried). */
export interface PromptUsage {
  /** Fresh input tokens (not from cache). */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + cacheRead + cacheWrite: everything the model read this turn. */
  prompt: number;
}

/** Tokens the agent produced for one turn, and what the turn cost. */
export interface ReplyUsage {
  output: number;
  /** Reasoning tokens, when the agent reports them separately. */
  thought: number;
  durationMs: number;
  cost?: number;
  model?: string;
}

/** A file attached to a message. `preview` is a small data URL for images. */
export interface AttachmentView {
  name: string;
  path: string;
  mime: string;
  size: number;
  preview?: string;
  /**
   * Text the agent receives with this file, right before it (e.g. the legend of a marked-up image: what each mark
   * and pin means). Shown on the card's tooltip.
   */
  note?: string;
}

export interface ToolContentView {
  type: 'text' | 'diff' | 'terminal' | 'other';
  text?: string;
  /** `terminal` content: the agent's terminal id (the live output is in the tool item's `terminalKey`). */
  terminalId?: string;
  path?: string;
  oldText?: string | null;
  newText?: string;
  /** A content block that is not plain text (media, resource, link, text meant for the agent); `text` is its plain form. */
  rich?: RichContent;
}

export interface PlanEntryView {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: string;
}

/** How a notice is presented: `info`, `warning` or `error` (agents may send others; they show as info). */
export type NoticeSeverity = string;

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: string;
}

export type ThreadItem =
  | {
      kind: 'user';
      id: string;
      agentId: AgentId;
      text: string;
      ts: number;
      contextAttached?: boolean;
      attachments?: AttachmentView[];
      usage?: PromptUsage;
      /** Set when the main session's agent (the orchestrator) wrote this message, not the user. */
      fromAgent?: AgentId;
      /** Set on the app's own automatic message (e.g. "your sub-sessions have finished"). */
      fromApp?: boolean;
      /**
       * A user message that arrived from the agent's session (ACP `user_message_chunk`): typed in another client of
       * that session, replayed or injected by the agent. Not sent from Olympus, so it has no checkpoint or usage.
       */
      viaAgent?: boolean;
      /** Opens a turn the agent started by itself (background task result, compaction…), not a new task. */
      agentInitiated?: boolean;
      /** Snapshots of the project before and after this turn, for its diff and Undo. */
      checkpoint?: TurnCheckpoint;
      /** WhatsApp-style delivery (ticks) of a message the user sent from Olympus (src/main/promptQueue.ts). */
      delivery?: UserDelivery;
    }
  | {
      kind: 'agent';
      id: string;
      agentId: AgentId;
      /** The whole message as plain text (copy, search, history for other agents). */
      text: string;
      /** The message in order, set once it has content that is not plain text (images, audio, resources, links). */
      parts?: RichContent[];
      ts: number;
      usage?: ReplyUsage;
    }
  | { kind: 'thought'; id: string; agentId: AgentId; text: string; parts?: RichContent[]; ts: number }
  | {
      kind: 'tool';
      id: string;
      agentId: AgentId;
      toolCallId: string;
      title: string;
      /** Human-readable summary of what this tool call is doing (e.g. `toolSummary` or Bash `description`). */
      summary?: string;
      toolKind?: string;
      status: string;
      content: ToolContentView[];
      locations: string[];
      /** Locations with their line, set only when the agent gave a line for at least one. */
      locationRefs?: ToolLocation[];
      /** The real tool behind the step (ACP `name` + allowlisted `_meta`). */
      identity?: ToolIdentity;
      ts: number;
      /** When it finished (completed, failed or interrupted). */
      endedAt?: number;
      /** One of the app's own tools (sub-sessions, terminals): what was asked and what the app answered. */
      olympus?: OlympusCall;
      /** A live terminal behind this tool (`terminal/create`, or `_meta.terminal_*` from Codex / Claude Code), see shared/acpClient.ts. */
      terminalKey?: string;
      /** That terminal's output once it ended (the last ~64 KB), so the box still has it after a restart. */
      terminalText?: string;
      /** That terminal's exit code (null: ended by a signal or unknown). */
      terminalExitCode?: number | null;
      terminalSignal?: string;
    }
  | {
      kind: 'plan';
      id: string;
      agentId: AgentId;
      entries: PlanEntryView[];
      ts: number;
      /** ACP `plan_update` id (unset for the legacy `plan` update, which holds one plan per session). */
      planId?: string;
      /** The agent withdrew this plan (`plan_removed`): it is no longer shown. */
      removed?: boolean;
    }
  | {
      /** A plan the agent sent as a document (ACP `plan_update` of type `markdown` or `file`), e.g. an approved plan. */
      kind: 'plan-doc';
      id: string;
      agentId: AgentId;
      planId: string;
      format: 'markdown' | 'file';
      /** Markdown plans: the plan text (each update replaces it). */
      content?: string;
      /** File plans: the URI of the file holding the plan. */
      uri?: string;
      removed?: boolean;
      ts: number;
    }
  | {
      /** Fire-and-forget information from the agent (ACP `notice`), or a warning it reported about the session. */
      kind: 'notice';
      id: string;
      agentId: AgentId;
      severity: NoticeSeverity;
      title: string;
      description?: string;
      /** Identity of a notice the agent may update later (Codex session failures), to change it in place. */
      key?: string;
      ts: number;
    }
  | {
      /** The agent compacting its context (ACP `compaction_update` + `compaction_summary_chunk`). */
      kind: 'compaction';
      id: string;
      agentId: AgentId;
      compactionId: string;
      /** `in_progress`, `completed`, `failed` or `cancelled` (other values are shown as in progress). */
      status: string;
      /** What the agent kept, as text (summary chunks appended in order). */
      summary?: string;
      error?: string;
      ts: number;
      endedAt?: number;
    }
  | { kind: 'switch'; id: string; from: AgentId; to: AgentId; ts: number }
  | {
      kind: 'error';
      id: string;
      agentId: AgentId;
      text: string;
      ts: number;
      /** Identity of an error the agent may update later (Codex session failures), to change it in place. */
      key?: string;
    }
  | {
      kind: 'permission';
      id: string;
      agentId: AgentId;
      title: string;
      options: PermissionOptionView[];
      resolved?: string;
      ts: number;
    }
  | {
      /** The agent asks the user something (ACP `elicitation/create`): a form / AskUserQuestion, or a link to open. */
      kind: 'elicitation';
      id: string;
      agentId: AgentId;
      mode: 'form' | 'url';
      message: string;
      /** Form mode: the schema the agent asked with. */
      schema?: ElicitSchema;
      /** URL mode: the link (http/https only) and the id the agent's later `elicitation/complete` refers to. */
      url?: string;
      elicitationId?: string;
      toolCallId?: string;
      /** Unset while it waits for the user. */
      resolved?: ElicitResolution;
      /** What the user sent (form mode, accepted). */
      answer?: ElicitContent;
      /** URL mode: the agent reported the flow behind the link finished. */
      completed?: boolean;
      /** Olympus Coder itself asks the user to approve an action an agent requested (e.g. adding an agent). */
      confirm?: ConfirmRequest;
      ts: number;
    };

/** What an Olympus-owned confirm card shows: a title, labelled rows (commands in monospace) and the yes button. */
export interface ConfirmRequest {
  title: string;
  rows: { label: string; value: string; code?: boolean }[];
  /** Label of the approve button, e.g. "Add agent". */
  action: string;
  danger?: boolean;
}

export type ElicitResolution = 'accepted' | 'declined' | 'cancelled' | 'withdrawn' | 'expired';

export interface ThreadMeta {
  id: string;
  projectId: string;
  title: string;
  agentId: AgentId;
  createdAt: number;
  updatedAt: number;
  /** Set on a sub-session: the chat it was forked from, or the main session that spawned it. */
  parentId?: string;
  /** Set on a sub-session the main session's agent started with spawn_subsession (same id as parentId). */
  spawnedBy?: string;
  /** A spawned sub-session that is deleted once it finished, its report was read and the parent's turn ended. */
  disposable?: boolean;
  /** Set on a native sub-agent spawned by a CLI agent itself (Claude Agent/Task, Codex collab, Antigravity invoke_subagent/swarm). */
  nativeSubagent?: boolean;
  /** Role or sub-agent type reported by the CLI agent (e.g. "Explore", "Plan", "Codebase Researcher", "swarm"). */
  subagentRole?: string;
  /** Model used by this sub-agent when reported by the CLI agent. */
  subagentModel?: string;
  /** Underlying ACP or native conversation id for this sub-agent, used to attach updates across turns. */
  nativeSessionId?: string;
  /** The task brief the orchestrator gave a spawned sub-session. */
  task?: string;
  /** Fingerprint of the operating guide this chat's agent last received, to resend it when the guide changes. */
  guideHash?: string;
  /** A second opinion: another agent asked about one message of the parent chat, read-only (no file changes). */
  secondOpinion?: boolean;
  /** The user renamed this chat: titles the agent suggests later (ACP `session_info_update`) no longer replace it. */
  titleSetByUser?: boolean;
  /** "Approve all": the app answers every permission request in this chat with allow (an app-level bypass mode). */
  autoApprove?: boolean;
  /** Set on chats started by a scheduled task. */
  scheduleId?: string;
  /** 'chat' = general conversation (Chat mode); 'code' (default) = coding session in a project. */
  mode?: UiMode;
  pinned?: boolean;
}

export interface Thread extends ThreadMeta {
  items: ThreadItem[];
  /** Last ACP session id per agent, used to resume after a restart. */
  acpSessions: Record<AgentId, string>;
  /** Messages sent while the agent was busy or offline, waiting to go out (src/main/promptQueue.ts). */
  queue?: QueuedPrompt[];
}

export interface ConfigOptionView {
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface ContextUsage {
  used: number;
  size: number;
  /** Cumulative cost of this agent session, when the agent reports it. */
  cost?: { amount: number; currency: string };
  model?: string;
}

export interface SessionView {
  threadId: string;
  agentId: AgentId;
  usage?: ContextUsage;
  status: 'idle' | 'starting' | 'running' | 'needs-login' | 'error';
  error?: string;
  configOptions: ConfigOptionView[];
  commands: { name: string; description?: string; inputHint?: string }[];
}

export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_TOKENS = ['bg', 'panel', 'surface', 'border', 'text', 'muted', 'accent', 'accentText', 'danger', 'success', 'warning', 'code'] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemePalette = Record<ThemeToken, string>;

export type EditorSyntaxTheme = 'auto' | 'one-dark' | 'github' | 'monokai' | 'dracula' | 'nord' | 'solarized';
export type EditorLineNumbers = 'on' | 'relative' | 'off';
export type EditorActiveLine = 'both' | 'line' | 'gutter' | 'off';
export type EditorWhitespace = 'none' | 'trailing' | 'all';
export type EditorCursorStyle = 'line' | 'block' | 'underline';
export type EditorCursorBlink = 'blink' | 'smooth' | 'solid';
export type EditorSurface = 'surface' | 'code' | 'bg';
export type TerminalCursorStyle = 'bar' | 'block' | 'underline';
export type StepsSize = 'smaller' | 'default' | 'larger' | 'largest';
export type ChatWidth = 'narrow' | 'default' | 'wide';

export interface ThemeSettings {
  preset: string;
  mode: ThemeMode;
  /** Legacy global accent (pre per-mode colors). Kept for old settings files; migrated once on load. */
  accent?: string;
  /** Legacy global color overrides, same story. */
  overrides: Partial<ThemePalette>;
  /** Custom colors are per mode: a color set while dark stays dark's, light keeps its own (store.ts migrates the legacy ones once). */
  accentDark?: string;
  accentLight?: string;
  overridesDark?: Partial<ThemePalette>;
  overridesLight?: Partial<ThemePalette>;
  fontSize: number;
  uiFont: string;
  codeFont: string;
  radius: number;
  density: 'compact' | 'comfortable';
  /** Weight of ordinary text (300–500) and of bold text, headings and labels (500–800). */
  textWeight?: number;
  boldWeight?: number;
  /** Chat messages' text size in px (0 = same as the app), line spacing, and code size in px. */
  chatFontSize?: number;
  lineHeight?: number;
  codeFontSize?: number;
  /** How thinking reads: slanted or upright, how faint (40–100 %), and its size (80–100 % of the text). */
  thinkingItalic?: boolean;
  thinkingOpacity?: number;
  thinkingSize?: number;
  /** Text size of the steps between replies (WorkGroup rows, BASH / RESULT and file boxes), relative to chat text. */
  stepsSize?: StepsSize;
  /** Width of the chat column, composer and banners. */
  chatWidth?: ChatWidth;

  // ---------- sidebar ----------
  /** Space in px below each project group in the sidebar (default 2). */
  sidebarProjectGap?: number;
  /** Space in px between chat rows in the sidebar, sessions and sub-sessions alike (default 0). */
  sidebarRowGap?: number;
  /** Sidebar text size in px for project, session and sub-session names (0 = same as the app font size). */
  sidebarFontSize?: number;

  // ---------- code editor customization ----------
  /** Dedicated editor font family ('' = follow `codeFont`). */
  editorFontFamily?: string;
  /** Dedicated editor font size in px (0 = follow `codeFontSize`). */
  editorFontSize?: number;
  /** Editor font weight (300–600). */
  editorFontWeight?: number;
  /** Editor line height multiplier (1.2–2.1). */
  editorLineHeight?: number;
  /** Editor character letter spacing in px (-0.5 to 1.5). */
  editorLetterSpacing?: number;
  /** Enable programming font ligatures (`=>`, `!==`, `->`). */
  editorLigatures?: boolean;
  /** Syntax color scheme (`auto` follows light/dark mode). */
  editorSyntaxTheme?: EditorSyntaxTheme;
  /** Editor canvas background token. */
  editorSurface?: EditorSurface;
  /** Gutter line numbering mode (`on`, Vim-style `relative`, or `off`). */
  editorLineNumbers?: EditorLineNumbers;
  /** Show code-folding chevrons in the gutter. */
  editorFoldGutter?: boolean;
  /** Highlight the active cursor line and/or gutter. */
  editorActiveLine?: EditorActiveLine;
  /** Render subtle vertical indentation guides per tab stop. */
  editorIndentGuides?: boolean;
  /** Vertical column ruler guide (0 = hidden, or column e.g. 80 / 100 / 120). */
  editorRulerColumn?: number;
  /** Render space/tab markers (`none`, `trailing`, or `all`). */
  editorRenderWhitespace?: EditorWhitespace;
  /** Highlight matching `()[]{}` brackets near the cursor. */
  editorBracketMatching?: boolean;
  /** Highlight other occurrences of the currently selected word. */
  editorSelectionMatch?: boolean;
  /** Allow scrolling almost a full viewport past the last line. */
  editorScrollPastEnd?: boolean;
  /** Caret shape (`line`, `block`, or `underline`). */
  editorCursorStyle?: EditorCursorStyle;
  /** Caret line thickness in px (1–4) when `editorCursorStyle === 'line'`. */
  editorCursorWidth?: number;
  /** Caret blink animation (`blink`, `smooth`, or `solid`). */
  editorCursorBlink?: EditorCursorBlink;
  /** Spaces per tab stop (2, 4, or 8). */
  editorTabSize?: number;
  /** Insert hard `\t` tabs instead of spaces when indenting. */
  editorIndentWithTabs?: boolean;
  /** Automatically close brackets and quotes while typing. */
  editorAutoCloseBrackets?: boolean;
  /** Strip trailing spaces/tabs from lines when saving a file. */
  editorTrimTrailingWhitespace?: boolean;
  /** Ensure saved files end with a trailing newline character. */
  editorFinalNewline?: boolean;

  // ---------- integrated terminal customization ----------
  /** Dedicated terminal font size in px (0 = follow `codeFontSize`). */
  terminalFontSize?: number;
  /** Terminal line height multiplier (1.0–1.6). */
  terminalLineHeight?: number;
  /** Terminal cursor shape (`bar`, `block`, `underline`). */
  terminalCursorStyle?: TerminalCursorStyle;
  /** Blink the terminal cursor. */
  terminalCursorBlink?: boolean;
  /** Maximum lines kept in terminal scrollback (1000–50000). */
  terminalScrollback?: number;
}

export type UiMode = 'chat' | 'code';

export interface UserProfile {
  name: string;
  email: string;
  role: string;
  location: string;
  github: string;
  website: string;
  languages: string;
  about: string;
  avatarColor: string;
  /** Small data: URL (resized in the renderer), or empty for initials. */
  avatar: string;
  /** Tell every agent who the user is (added to the shared context). */
  shareWithAgents: boolean;
  /** Let agents note what they learn about the user (style, thinking, interests…); on unless turned off. */
  learnAboutUser?: boolean;
}

/** Something an agent learned about the user, kept so every new session can adapt to them. */
export interface LearnedNote {
  id: string;
  section: 'communication' | 'thinking' | 'problem_solving' | 'interests' | 'context' | 'preferences';
  text: string;
  ts: number;
  agentId?: string;
}

export interface Settings {
  onboarded: boolean;
  /** The one-time "set an app password" suggestion: hidden until a time ("Not now") or for good. */
  securityNudge?: { snoozedUntil?: number; never?: boolean };
  /** The phone app: off until turned on; listens on 127.0.0.1:port (or 0.0.0.0:port when `lan` is enabled). */
  remote?: { enabled: boolean; port: number; lan?: boolean; relayUrl?: string };
  /** Bumped when a design update changes defaults that existing users should get once. */
  designVersion?: number;
  uiMode: UiMode;
  profile: UserProfile;
  sharedRoot: string;
  /** These settings took the one-time ~/.agents → ~/.olympus switch (sharedMigration.ts). */
  migratedFromAgents?: boolean;
  defaultAgent: AgentId;
  injectSharedContext: boolean;
  theme: ThemeSettings;
  customAgents: AgentDef[];
  orchestrator: OrchestratorSettings;
  /** MCP servers every agent session gets (Settings → Connectors). Env and header values live in the keychain. */
  connectors: ConnectorDef[];
  /** Auto-answers for permission requests (Settings → Tools). */
  toolRules: ToolRule[];
  /** Tools agents recently asked permission for, to make rules from. */
  seenTools: SeenTool[];
  /** Shared skills (folder names under <sharedRoot>/skills) the user turned off. */
  disabledSkills: string[];
  /** Per agent: the last value chosen for each session setting (mode, model, effort…), applied to new chats.
   *  `__autoApprove` ('1' / '0') is the "Approve all" pill. */
  agentDefaults: Record<string, Record<string, string>>;
  lastProjectId?: string;
  lastThreadId?: string;
  /** Send a message into an agent's chat when a terminal command it left running finishes. Off: agents check
   *  their own pending work (read_terminal, set_timer). Sub-sessions have their own setting below. */
  notifyAgentsWhenWorkEnds?: boolean;
  /** Tell the parent session the moment one of its sub-sessions finishes, with the result (orchestrator.ts
   *  `maybeWake`). Default on; only an explicit `false` turns it off. */
  notifyParentOnSubsessionEnd?: boolean;
  /** How new releases arrive (src/main/updates.ts): 'notify' shows a notice, 'auto' also downloads and checks the
   *  update in the background and installs it on restart, 'off' never asks GitHub. Default 'notify'. */
  updateMode?: UpdateMode;
  /** Auto mode, macOS: download only while the Mac is on Wi-Fi. Default off. */
  updateWifiOnly?: boolean;
  /** Auto mode: install a downloaded update when the user quits Olympus. Default on. */
  updateInstallOnQuit?: boolean;
  /** @deprecated Replaced by `updateMode` (false → 'off'); only read once to migrate. */
  checkForUpdates?: boolean;
  /** A release version the user dismissed in the update notice: not shown again. */
  skippedUpdate?: string;
  /** Settings → Voice: the mic button's transcription engine (src/shared/voice.ts). Missing = OS dictation. */
  voice?: Partial<VoiceSettings>;
}

export interface ConnectorDef {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** Names only; values are stored encrypted. */
  envKeys?: string[];
  url?: string;
  headerKeys?: string[];
  /** 'all', or the agent ids that get it. */
  agents: 'all' | string[];
  /** Where it was imported from, e.g. "~/.codex/config.toml". */
  source?: string;
  /** From the last "Test": the tools it offers, or the error. */
  tools?: { name: string; description?: string }[];
  testedAt?: number;
  error?: string;
}

/** A connector with its env / header values, for the Settings form. */
export interface ConnectorView extends ConnectorDef {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface ToolRule {
  id: string;
  /** '*' or an agent id. */
  agent: string;
  /** A tool name (e.g. "Bash", "Edit", "mcp__github__create_issue") or a kind ("kind:execute", "kind:edit", "kind:read"). */
  tool: string;
  /** Optional glob on the request's title (the command, the file), e.g. "npm test*". */
  match?: string;
  action: 'allow' | 'deny';
}

export interface SeenTool {
  agent: string;
  tool: string;
  kind?: string;
  /** The last request's title, as an example. */
  example: string;
  ts: number;
}

export interface SkillView {
  /** Folder name under <sharedRoot>/skills. */
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  /** SKILL.md without its frontmatter (only when one skill is read). */
  body?: string;
  /** From ~/.agents/skills (installed with `npx skills`): listed and used, but not edited or deleted here. */
  readOnly?: boolean;
}

/** A skill or connector found in another tool's folder, offered for import (read-only; never changed). */
export interface ImportCandidate {
  name: string;
  source: string;
  description?: string;
  path?: string;
  connector?: Omit<ConnectorView, 'id' | 'enabled' | 'agents'>;
}

/** Main sessions plan and delegate; sub-sessions do the hands-on work (see main/orchestrator.ts). */
export interface OrchestratorSettings {
  enabled: boolean;
  /** Sub-sessions of one main session that may run at the same time. */
  maxParallel: number;
  /** Sub-sessions one main session may spawn in total. */
  maxPerSession: number;
}

/** A sub-session as the Tasks panel (and the orchestrator's tools) see it. */
export interface SubTaskView {
  meta: ThreadMeta;
  status: 'starting' | 'running' | 'waiting-permission' | 'done' | 'failed' | 'idle' | 'needs-login' | 'quota-exceeded' | 'cancelled';
  /** What it is doing right now (latest tool or plan step). */
  activity?: string;
  /** Last reply, cut to a few lines. */
  lastReply?: string;
  error?: string;
  filesTouched: string[];
  toolCount: number;
  pendingPermissions: number;
  /** True when a live native CLI sub-agent advertises ACP `session/cancel` support. */
  canCancel?: boolean;
  startedAt?: number;
  endedAt?: number;
  /**
   * Identity of the outcome the orchestrator should hear about: the last reply or error since the last real task
   * message. Maintenance an agent does on its own afterwards (e.g. compacting its context) leaves it unchanged.
   */
  resultId?: string;
}

export interface LockOptions {
  autoLockMinutes: number; // 0 = never
  lockOnSleep: boolean;
  touchId: boolean;
}

export interface LockState {
  enabled: boolean;
  locked: boolean;
  touchIdAvailable: boolean;
  options: LockOptions;
  retryAfterMs: number;
}

export interface AppState {
  settings: Settings;
  lock: LockState;
  platform: string;
  home: string;
  version: string;
}

export interface SearchHit {
  threadId: string;
  projectId: string;
  projectName: string;
  title: string;
  agentId: AgentId;
  snippet: string;
  updatedAt: number;
}

export type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekly';

export interface ScheduledTask {
  id: string;
  name: string;
  projectId: string;
  agentId: AgentId;
  prompt: string;
  kind: ScheduleKind;
  /** once: timestamp to run at. */
  at?: number;
  /** interval: minutes between runs. */
  everyMinutes?: number;
  /** daily / weekly: local time "HH:MM". */
  time?: string;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  weekday?: number;
  enabled: boolean;
  nextRun?: number;
  lastRun?: number;
  lastThreadId?: string;
  createdAt: number;
}

export interface MemoryView {
  dir: string;
  index: string;
  files: { name: string; size: number; mtime: number }[];
  globalInstructionsPath: string;
  globalInstructions: string;
  /** This project's instructions from the user (INSTRUCTIONS.md in its memory folder), given to every agent in full. */
  projectInstructionsPath: string;
  projectInstructions: string;
}

/** Events the main process pushes to the renderer. */
export interface DeskEvents {
  'thread:item': { threadId: string; item: ThreadItem };
  'thread:meta': ThreadMeta;
  'session:state': SessionView;
  'agent:status': AgentStatus;
  'lock:state': LockState;
  'pty:data': { ptyId: string; data: string; end: number };
  'pty:exit': { ptyId: string; exitCode: number };
  /** A terminal the app opened for the user (Run button, or an agent's run_in_terminal): show it in the workbench. */
  'terminal:opened': { projectId: string; ptyId: string; title: string; command?: string };
  /** A program has kept several cores busy for about a minute, or the Mac reports it is getting hot. */
  'heat:alert': { reason: 'cpu' | 'thermal'; thermal: string; task?: RunningTask };
  /** A project's terminal list changed (opened, closed, exited, restarted). */
  'terminal:changed': { projectId: string };
  'schedules:changed': ScheduledTask[];
  'catalog:progress': { id: string; phase: 'download' | 'verify' | 'extract' | 'done' | 'error'; received?: number; total?: number; error?: string };
  /** An agent was added or removed outside the Settings screen (e.g. by an agent's add_agent tool). */
  'agents:changed': { defs: AgentDef[]; statuses: AgentStatus[] };
  /** A chat was deleted (from the sidebar, by delete_subsession, or a disposable sub-session cleaned up). */
  'thread:deleted': { id: string; projectId: string; parentId?: string };
  /** A newer release than this app exists (null: none, or it was skipped / checking is off). */
  'update:available': UpdateInfo | null;
  /** An update check finished (Settings → General shows the result). */
  'update:checked': UpdateCheck;
  /** The model capability tags were refreshed from the models.dev registry (src/main/modelTags.ts). */
  'models:tags': ModelTags;
  /** A detached Workbench tool window closed; `reattach`: by its Re-attach button (the main window shows that tab). */
  'panel:closed': { tool: PanelTool; reattach: boolean };
  /** The project / chat detached tool windows follow changed (the main window's current code chat). */
  'panel:context': PanelContext | null;
  /** A detached tool asks the main window to show a tab (and open a file, or a terminal). */
  'panel:show': { tab: string; path?: string; line?: number; ptyId?: string; threadId?: string };
}

/** A newer Olympus Coder release found on GitHub (src/main/updates.ts). */
export interface UpdateInfo {
  version: string;
  /** The release page ("What's new"). */
  pageUrl: string;
  /** The installer for this platform and CPU, or the release page when there is none. */
  downloadUrl: string;
  /** Auto mode: downloading (with progress) or downloaded, checked and ready to install on restart. */
  state?: 'downloading' | 'ready';
  received?: number;
  total?: number;
  /** Why the automatic update stopped and only the notice is left (bad checksum, no permission…). */
  problem?: string;
}

export type UpdateMode = 'notify' | 'auto' | 'off';

/** The last update check, shown next to "Check now" in Settings. */
export interface UpdateCheck {
  at: number;
  text: string;
}

// ---------- code mode: files, git, terminals ----------

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

/** A file (or folder) opened from a link in the chat, ready to show formatted in the side panel. */
export interface FilePreview {
  /** What was clicked, as written. */
  ref: string;
  /** Absolute path. */
  path: string;
  name: string;
  line?: number;
  kind: 'text' | 'markdown' | 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'dir' | 'binary' | 'too-large' | 'missing';
  size?: number;
  mtime?: number;
  text?: string;
  /** Sanitized HTML representation for rich documents (.docx, .doc, .rtf, .odt). */
  html?: string;
  /** Images, videos, audio, and PDFs, as a data: URL. */
  dataUrl?: string;
  /** Optional QuickLook visual preview thumbnail (for PDFs, videos, and Office/iWork documents). */
  thumbUrl?: string;
  mime?: string;
  entries?: { name: string; dir: boolean }[];
  /** Set when the file is inside a project, so it can be opened in the editor. */
  projectId?: string;
  rel?: string;
}

export interface FileContent {
  path: string;
  text: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  mtime: number;
}

export interface GitFileChange {
  path: string;
  /** For renames: the old path. */
  from?: string;
  /** Index (staged) status letter and worktree status letter, as in `git status --porcelain`: M A D R C U ? or '.'. */
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitFileChange[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: number;
  subject: string;
  refs: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  lastCommit: number;
}

export interface GitStash {
  ref: string;
  message: string;
}

// ---------- usage log ----------

export interface UsageRecord {
  ts: number;
  agentId: AgentId;
  threadId: string;
  projectId: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Cost of this turn in USD, when the agent reports cost. */
  cost?: number;
}

export interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface UsageSummary {
  days: number;
  byAgent: Record<AgentId, UsageTotals>;
  /** Oldest day first; `total` per agent per day. */
  byDay: { day: string; agents: Record<AgentId, number>; cost: number }[];
  topThreads: { threadId: string; title: string; agentId: AgentId; total: number; cost: number }[];
  today: UsageTotals;
}

/** One project's dashboard (gear on its row): usage, activity and work done, over the last `days` days. */
export interface ProjectStats {
  days: number;
  sessions: { total: number; sub: number; active: number; byAgent: Record<AgentId, number> };
  tokens: UsageTotals;
  byAgent: Record<AgentId, UsageTotals>;
  /** Oldest day first. */
  byDay: { day: string; agents: Record<AgentId, number>; tools: number; messages: number; cost: number }[];
  /** Tool calls started in each hour of the day (0–23), local time. */
  byHour: number[];
  tools: { total: number; failed: number; byKind: { kind: string; count: number }[] };
  messages: number;
  /** Time agents spent working on turns (message sent → turn's last event). */
  agentTimeMs: number;
  errors: number;
  permissions: number;
  filesTouched: number;
  topFiles: { path: string; count: number }[];
  topThreads: { threadId: string; title: string; agentId: AgentId; total: number; cost: number; tools: number }[];
  firstActivity?: number;
  lastActivity?: number;
  memoryNotes: number;
  bugs: number;
  instructions: boolean;
}

/** A workbench terminal as the main process tracks it. */
export interface TerminalView {
  ptyId: string;
  projectId: string;
  title: string;
  command?: string;
  /** The shell is running. */
  alive: boolean;
  /** The shell is running a program right now (not sitting at its prompt). */
  busy: boolean;
  exitCode?: number;
  /** Came back after a restart: its output only; the process ended when Olympus closed. */
  restored?: boolean;
  startedAt: number;
  /** The chat whose agent opened it. */
  threadId?: string;
}

export type ProcAction = 'pause' | 'resume' | 'stop';

/** A program the app started that is running right now (an agent's command, or one in a workbench terminal). */
export interface RunningTask {
  /** `agent:<pid>` or `terminal:<ptyId>`. */
  id: string;
  source: 'agent' | 'terminal';
  /** The command (or a terminal's title). */
  title: string;
  /** A terminal's full command, when it was opened with one. */
  command?: string;
  agentId?: string;
  /** The chat whose agent ran it (best guess when the command can't be matched to a tool card). */
  threadId?: string;
  /** The tool card in that chat this command belongs to. */
  toolItemId?: string;
  ptyId?: string;
  projectId?: string;
  rootPid: number;
  pids: number[];
  /** Each process in the tree (for the expanded card). */
  procs?: { pid: number; cpu: number; memMB: number; command: string }[];
  /** CPU use summed over the tree, in percent of one core (NaN where unknown). */
  cpu: number;
  memMB: number;
  /** Seconds since it started. */
  secs: number;
  paused: boolean;
  canPause: boolean;
}

/** A turn's snapshots (commits in the project's shadow checkpoint repo). */
export interface TurnCheckpoint {
  before: string;
  after?: string;
  /** Files the turn changed, and lines added / removed. */
  files?: number;
  added?: number;
  removed?: number;
  /** Set while the turn is undone: the snapshot taken just before the undo, which Redo restores. */
  undone?: string;
}

export interface TurnFileChange {
  path: string;
  status: 'A' | 'M' | 'D';
  added: number;
  removed: number;
  binary: boolean;
}

/** A TCP port a program is listening on. */
export interface PortInfo {
  port: number;
  address: string;
  pid: number;
  /** Short program name (node, python3, ControlCenter …). */
  name: string;
  command: string;
  /** Olympus started it (a terminal or an agent's command). */
  startedHere: boolean;
  /** The app itself (e.g. its MCP server). */
  self: boolean;
}

/** A call to one of the app's own (olympus MCP) tools, recorded by the app itself, so it shows the same for every agent. */
export interface OlympusCall {
  tool: string;
  /** The sub-session it was about (spawned, messaged, checked, stopped). */
  target?: { id: string; title: string };
  /** What the agent sent: a sub-session's task, a message, a command. */
  text?: string;
  /** What the app answered the agent (reports, status), as plain text. */
  result?: string;
  isError?: boolean;
}

/** A phone paired with this Mac for the remote app. */
export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen?: number;
  /** How it connects: through the relay (QR + password) or the local / Tailscale server (6-digit code). */
  via?: 'relay' | 'local';
}

export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** Listen on dual-stack [::]:port / 0.0.0.0:port so devices on the same Wi-Fi / LAN can open the unified app directly. */
  lan: boolean;
  /** http://<lan-ip-or-bonjour>:port addresses when `lan` is enabled (empty otherwise). */
  lanUrls: string[];
  /** True when the primary LAN interface is tethered to an iPhone Personal Hotspot (172.20.10.x). */
  hotspotDetected?: boolean;
  /** macOS Application Firewall status for the running app bundle when `lan` is enabled. */
  firewall?: { active: boolean; allowed: boolean; appPath: string };
  /** http://127.0.0.1:port — the same app the phone gets, for trying it on this Mac. */
  localUrl: string;
  /** Only after the user asks (checking runs the Tailscale app, which can open its window). */
  tailscale?: { installed: boolean; running: boolean; dnsName?: string; serving: boolean; url?: string; error?: string; serveCommand: string };
  devices: RemoteDevice[];
  pairing?: { code: string; expiresAt: number };
  relay: { url: string; defaultUrl: string; state: 'off' | 'connecting' | 'online' | 'error'; error?: string; phones: number; passwordSet: boolean };
}

/** Result of the composer's mic button starting the OS's own dictation (src/main/dictation.ts). */
export interface DictationResult {
  ok: boolean;
  /** How it was started: macOS `startDictation:` action or Windows Voice Typing (Win+H). */
  method?: 'mac-startDictation' | 'win-voice-typing';
  /** A one-time tip for the user, e.g. Dictation is turned off in System Settings. */
  hint?: string;
  error?: string;
}
