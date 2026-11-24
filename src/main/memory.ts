import { shell } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { buildFreshCarryoverSection, DEFAULT_CARRYOVER_TRANSCRIPT_CHARS, isFreshCarryoverPending } from '@shared/freshCarryover';
import type { MemoryView, Project, Thread } from '@shared/types';
import { notesForAgents } from './usernotes';
import { pathSlug } from './relocate';
import { baseProject, baseProjectId, GENERAL_PROJECT_ID, getSettings, listThreads, sharedRoot } from './store';

/**
 * Shared memory lives in one folder that every agent reads and writes:
 *   <sharedRoot>/AGENTS.md                 global instructions for all agents
 *   <sharedRoot>/memory/<project-slug>/    one fact per file + MEMORY.md index + BUGS.md log
 *   <sharedRoot>/threads/<project-id>/     every chat session's JSON transcript across all agents
 * Nothing in ~/.claude, ~/.gemini or ~/.codex is written by Olympus. Claude Code's own auto-memory
 * is redirected here per session (see claudeSessionMeta in guide.ts).
 */

/** Same rule as Claude Code's ~/.claude/projects/<slug> (relocate.ts). */
export const projectSlug = pathSlug;
/** Memory always belongs to the base project, also for a worktree chat's virtual project (store.baseProject). */
export const memoryDir = (p: Project) => join(sharedRoot(), 'memory', projectSlug(baseProject(p).path));

/**
 * The auto-memory folder Claude Code uses for this project when it runs outside Olympus (Claude desktop, the
 * `claude` CLI): ~/.claude/projects/<slug>/memory, same slug rule as ours. Returned only when it has an index.
 */
export function claudeNativeMemory(p: Project): string | undefined {
  const dir = join(homedir(), '.claude', 'projects', projectSlug(baseProject(p).path), 'memory');
  try {
    return statSync(join(dir, 'MEMORY.md')).size > 0 ? dir : undefined;
  } catch {
    return undefined;
  }
}

export const globalInstructionsPath = () => join(sharedRoot(), 'AGENTS.md');
/** The user's rules for one project (language, style, how results must be proven…), given to every agent in full. */
export const PROJECT_INSTRUCTIONS = 'INSTRUCTIONS.md';
export const projectInstructionsPath = (p: Project) => join(memoryDir(p), PROJECT_INSTRUCTIONS);
const INSTRUCTIONS_MAX = 16_000;

export function readProjectInstructions(p: Project): string {
  return readText(projectInstructionsPath(p), INSTRUCTIONS_MAX).trim();
}

export function writeProjectInstructions(p: Project, text: string): void {
  ensureMemory(p);
  const t = text.trim();
  writeFileSync(projectInstructionsPath(p), t ? `${t}\n` : '');
}

const INDEX_HEADER = `# Shared memory index\n\nOne line per memory file in this folder: \`- [Title](file.md) — hook\`.\n\n`;

export function ensureMemory(p: Project): string {
  const dir = memoryDir(p);
  mkdirSync(dir, { recursive: true });
  const index = join(dir, 'MEMORY.md');
  if (!existsSync(index)) writeFileSync(index, INDEX_HEADER);
  return dir;
}

function readText(file: string, max = Infinity): string {
  try {
    const t = readFileSync(file, 'utf8');
    return t.length > max ? `${t.slice(0, max)}\n…(cut)` : t;
  } catch {
    return '';
  }
}

export function getMemoryView(p: Project): MemoryView {
  const dir = ensureMemory(p);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== PROJECT_INSTRUCTIONS)
    .map((name) => {
      const s = statSync(join(dir, name));
      return { name, size: s.size, mtime: s.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return {
    dir,
    index: readText(join(dir, 'MEMORY.md')),
    files,
    globalInstructionsPath: globalInstructionsPath(),
    globalInstructions: readText(globalInstructionsPath()),
    projectInstructionsPath: projectInstructionsPath(p),
    projectInstructions: readText(projectInstructionsPath(p)),
  };
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', antigravity: 'Antigravity', codex: 'Codex' };
const EDIT_TOOL_KINDS = new Set(['edit', 'delete', 'move']);

function fmtStamp(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '';
  }
}

/** Extracts YAML frontmatter `description` and `type` from a shared memory `.md` file when present. */
function parseFrontmatter(raw: string): { description?: string; type?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const block = m[1];
  const descMatch = /^description:\s*(.+)$/m.exec(block);
  const typeMatch = /^\s*type:\s*([a-zA-Z0-9_-]+)\s*$/m.exec(block);
  const rawDesc = descMatch?.[1]?.trim();
  let description = rawDesc;
  if (rawDesc && ((rawDesc.startsWith('"') && rawDesc.endsWith('"')) || (rawDesc.startsWith("'") && rawDesc.endsWith("'")))) {
    try {
      description = String(JSON.parse(rawDesc));
    } catch {
      description = rawDesc.slice(1, -1);
    }
  }
  return { description, type: typeMatch?.[1]?.trim() };
}

/**
 * Builds an Antigravity-style Knowledge Item summary block from `<memDir>/MEMORY.md` and all `.md` files
 * on disk, resolving every memory item to its exact absolute file path + last-updated timestamp so any
 * agent (Claude Code, Codex, Antigravity, registry agents) can review summaries first and read relevant
 * artifacts immediately — even if an agent created a `.md` file and forgot to add a pointer to `MEMORY.md`.
 */
export function buildSharedMemoryCatalog(dir: string, opts: { indexInContext?: boolean } = {}): string {
  const indexRaw = readText(join(dir, 'MEMORY.md'), 10_000).trim();
  const indexedHooks = new Map<string, { title: string; hook: string }>();
  for (const line of indexRaw.split(/\r?\n/)) {
    const m = /^-\s*\[([^\]]+)\]\(([^)]+\.md)\)\s*(?:[—–-]\s*(.+))?$/.exec(line.trim());
    if (m) {
      indexedHooks.set(basename(m[2].trim()), { title: m[1].trim(), hook: (m[3] ?? '').trim() });
    }
  }

  let diskFiles: string[] = [];
  try {
    diskFiles = readdirSync(dir).filter(
      (f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== PROJECT_INSTRUCTIONS && f !== 'BUGS.md',
    );
  } catch {
    diskFiles = [];
  }

  // Keep MEMORY.md order first, followed by any unindexed .md files sorted newest-first.
  const ordered = [
    ...[...indexedHooks.keys()].filter((f) => diskFiles.includes(f)),
    ...diskFiles
      .filter((f) => !indexedHooks.has(f))
      .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs),
  ];

  const lines: string[] = [];
  // The agent already has MEMORY.md itself (Claude auto-memory): only the path rule and the files the index misses.
  if (opts.indexInContext) lines.push(`- The \`MEMORY.md\` index is in your context already (as auto-memory); each entry's artifact path is \`${dir}/<file>.md\`.`);
  for (const file of opts.indexInContext ? ordered.filter((f) => !indexedHooks.has(f)) : ordered) {
    const fullPath = join(dir, file);
    const head = readText(fullPath, 900);
    const fm = parseFrontmatter(head);
    const indexed = indexedHooks.get(file);
    const title = indexed?.title ?? file.replace(/\.md$/i, '');
    const summary = indexed?.hook || fm.description || 'Project memory note';
    const tag = fm.type ? ` [${fm.type}]` : '';
    let updated = '';
    try {
      updated = ` (updated ${fmtStamp(statSync(fullPath).mtimeMs)} UTC)`;
    } catch {
      /* ignore stat race */
    }
    lines.push(`- **${title}**${tag}${updated}\n  Summary: ${summary}\n  Artifact path: \`${fullPath}\``);
  }

  const bugsPath = join(dir, 'BUGS.md');
  if (existsSync(bugsPath)) {
    const bugsText = readText(bugsPath, 64_000);
    const headings = [...bugsText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    const latest = headings[0] ? `; latest: "${headings[0]}"` : '';
    lines.push(
      `- **Solved Bug Log (\`BUGS.md\`)** — ${headings.length} recorded fix${headings.length === 1 ? '' : 'es'}${latest}\n  Artifact path: \`${bugsPath}\` *(not preloaded; grep first when debugging any error or regression)*`,
    );
  }

  if (!lines.length) {
    return indexRaw || '(empty — create topic .md files + MEMORY.md entries as soon as durable project facts are learned)';
  }
  return lines.join('\n');
}

/**
 * Whether Claude Code loads the shared MEMORY.md itself (its auto-memory, pointed at the shared folder by
 * `autoMemoryDirectory`, see claudeSessionMeta in guide.ts). Off when the user turned `autoMemoryEnabled` off in
 * Claude's user or project settings; then the full catalog goes in the preamble instead.
 */
export function claudeLoadsMemoryIndex(p: Project): boolean {
  // Claude's precedence: local project settings, then project, then user; the first that sets it decides.
  for (const f of [join(p.path, '.claude', 'settings.local.json'), join(p.path, '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.json')]) {
    try {
      const on = JSON.parse(readFileSync(f, 'utf8'))?.autoMemoryEnabled;
      if (typeof on === 'boolean') return on;
    } catch {
      /* missing or unreadable: no opinion */
    }
  }
  return true;
}

/**
 * Lists the most recent top-level sessions in this project across all agents (Claude Code, Codex, Antigravity…)
 * with their session IDs, agent names, timestamps, and transcript paths — mirroring Antigravity's conversation
 * summary index so any agent can trace cross-chat handoffs without relying on agent-private history.
 */
function buildRecentSessionsSummary(p: Project, currentThreadId: string, maxSessions = 8): string {
  if (p.id === GENERAL_PROJECT_ID) return '';
  const projectId = baseProjectId(p.id);
  const metas = listThreads(projectId).filter(
    (t) => t.id !== currentThreadId && !t.nativeSubagent && !t.spawnedBy && !t.secondOpinion && t.title !== 'New chat',
  );
  if (!metas.length) return '';
  return metas
    .slice(0, maxSessions)
    .map((t) => {
      const who = AGENT_NAMES[t.agentId] ?? t.agentId;
      const txPath = join(sharedRoot(), 'threads', projectId, `${t.id}.json`);
      return `- ${fmtStamp(t.updatedAt)} UTC · [${who}] "${t.title}" — session \`${t.id}\` (\`${txPath}\`)`;
    })
    .join('\n');
}

/**
 * Plain-text transcript of a thread for mid-chat agent switches and forks.
 * When the full conversation exceeds `maxChars`, keeps the original user goal at the top,
 * summarizes omitted turns and edited files in the middle, and keeps the newest whole turns at the end.
 */
export function transcript(thread: Thread, maxChars: number): string {
  const entries: { text: string; item: Thread['items'][number] }[] = [];
  for (const it of thread.items) {
    const id = it.kind === 'switch' ? it.to : it.kind === 'max-deliberation' ? it.solverAgentId : it.agentId;
    const who = AGENT_NAMES[id] ?? id;
    if (it.kind === 'max-deliberation') {
      const critic = AGENT_NAMES[it.criticAgentId] ?? it.criticAgentId;
      entries.push({
        text: `--- Max Effort deliberation (${who} ⇄ ${critic}, ${it.rounds.length} pass(es), ${it.converged ? 'converged' : it.status}) ---`,
        item: it,
      });
    } else if (it.kind === 'user') {
      const att = it.attachments?.length ? ` [attached: ${it.attachments.map((a) => a.path).join(', ')}]` : '';
      const cp =
        it.checkpoint?.undone
          ? ' [turn changes undone]'
          : it.checkpoint?.files
            ? ` [turn changed ${it.checkpoint.files} file(s): +${it.checkpoint.added ?? 0} -${it.checkpoint.removed ?? 0}]`
            : '';
      entries.push({ text: `USER: ${it.text}${att}${cp}`, item: it });
    } else if (it.kind === 'agent') {
      entries.push({ text: `${who}: ${it.text}`, item: it });
    } else if (it.kind === 'tool') {
      const text = `${who} [tool ${it.status}]: ${it.title}${it.locations.length ? ` (${it.locations.join(', ')})` : ''}`;
      // The same tool line many times in a row (an agent stuck in a loop): one line with a count.
      const prev = entries[entries.length - 1];
      if (prev?.item.kind === 'tool' && (prev.text === text || prev.text.startsWith(`${text} ×`))) {
        const n = (Number(prev.text.slice(text.length + 2)) || 1) + 1;
        prev.text = `${text} ×${n}`;
      } else entries.push({ text, item: it });
    } else if (it.kind === 'error') {
      entries.push({ text: `${who} [error]: ${it.text}`, item: it });
    } else if (it.kind === 'switch') {
      entries.push({ text: `--- switched from ${AGENT_NAMES[it.from] ?? it.from} to ${AGENT_NAMES[it.to] ?? it.to} ---`, item: it });
    } else if (it.kind === 'context-reset') {
      entries.push({ text: `--- fresh context started (${AGENT_NAMES[it.agentId] ?? it.agentId}) ---`, item: it });
    }
  }
  const full = entries.map((e) => e.text).join('\n\n');
  if (full.length <= maxChars) return full;

  const firstUserIdx = entries.findIndex((e) => e.item.kind === 'user');
  const headCap = Math.min(2400, Math.floor(maxChars * 0.15));
  const headRaw = firstUserIdx >= 0 ? entries[firstUserIdx].text : '';
  const head = headRaw.length > headCap ? `${headRaw.slice(0, headCap)}…` : headRaw;
  const minTailIdx = firstUserIdx >= 0 ? firstUserIdx + 1 : 0;

  const summaryReserve = 600;
  const tailBudget = Math.max(800, maxChars - (head ? head.length + 2 : 0) - summaryReserve);
  let tailStart = entries.length;
  let used = 0;
  for (let i = entries.length - 1; i >= minTailIdx; i--) {
    const add = entries[i].text.length + (used > 0 ? 2 : 0);
    if (used + add > tailBudget) break;
    used += add;
    tailStart = i;
  }

  let tailText: string;
  if (tailStart === entries.length && entries.length > minTailIdx) {
    const newest = entries[entries.length - 1].text;
    tailStart = entries.length - 1;
    tailText = `…${newest.slice(newest.length - Math.max(200, tailBudget - 10))}`;
  } else {
    tailText = entries.slice(tailStart).map((e) => e.text).join('\n\n');
  }

  const omitted = entries.slice(minTailIdx, tailStart);
  const omittedTurns = omitted.filter((e) => e.item.kind === 'user').length;
  const editedFiles = [
    ...new Set(
      omitted.flatMap((e) => {
        if (e.item.kind !== 'tool') return [];
        const diffs = e.item.content.filter((c) => c.type === 'diff' && c.path).map((c) => c.path!);
        return EDIT_TOOL_KINDS.has(e.item.toolKind ?? '') || diffs.length ? [...e.item.locations, ...diffs] : [];
      }),
    ),
  ];
  const filesNote = editedFiles.length ? `; files edited earlier: ${editedFiles.slice(0, 15).join(', ')}${editedFiles.length > 15 ? ` (+${editedFiles.length - 15} more)` : ''}` : '';
  const turnsNote = omittedTurns > 0 ? ` (${omittedTurns} user turn${omittedTurns === 1 ? '' : 's'})` : '';
  const txPath = join(sharedRoot(), 'threads', thread.projectId, `${thread.id}.json`);
  const bridge = `[…${omitted.length} earlier item${omitted.length === 1 ? '' : 's'}${turnsNote} omitted${filesNote} — full transcript: ${txPath}…]`;

  const combined = [head, bridge, tailText].filter(Boolean).join('\n\n');
  return combined.length <= maxChars ? combined : combined.slice(0, maxChars);
}

/**
 * Context block sent with the first prompt of every new agent session: the shared instructions, the user's
 * profile, the project's Shared Memory summaries (with exact artifact paths), recent cross-agent sessions,
 * and, when the chat was started by another agent, the conversation so far.
 */
export function buildPreamble(p: Project, thread: Thread, agentId: string, includeHistory: boolean, guide?: string): string {
  const dir = ensureMemory(p);
  const global = readText(globalInstructionsPath(), 12_000).trim();
  const catalog = buildSharedMemoryCatalog(dir, { indexInContext: agentId === 'claude' && claudeLoadsMemoryIndex(p) });
  const recentSessions = buildRecentSessionsSummary(p, thread.id);
  const parts: string[] = [];
  if (guide) parts.push(guide);
  else parts.push(`You are running inside Olympus Coder. Your system prompt has the operating guide: this session, the mandatory shared-memory rules, and how to work.`);
  if (global) parts.push(`## Shared instructions (${globalInstructionsPath()})\n\n${global}`);
  const prof = getSettings().profile;
  if (prof.shareWithAgents) {
    const lines = [
      ['Name', prof.name],
      ['Email', prof.email],
      ['Role', prof.role],
      ['Location', prof.location],
      ['GitHub', prof.github],
      ['Website', prof.website],
      ['Languages they speak / prefer', prof.languages],
      ['About', prof.about],
    ].filter(([, v]) => v?.trim());
    if (lines.length) parts.push(`## About the user (from their profile)\n\n${lines.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
    const isDirectUserChat = !thread.spawnedBy && !thread.secondOpinion;
    const learned = isDirectUserChat ? notesForAgents() : '';
    if (learned)
      parts.push(
        `## What agents have learned about the user (adapt to it: language, depth, examples, pace)\n\n${learned}\n\nThese came from earlier sessions and may be incomplete; what the user says now wins.`,
      );
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    parts.push(`## Local time\n\n${new Date().toLocaleString('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' })} (${tz})`);
  } catch {
    /* no time zone data */
  }
  parts.push(
    `## Shared project memory — MANDATORY FIRST STEP: review summaries & read relevant artifact paths before research (${join(dir, 'MEMORY.md')})\n\n${catalog}`,
  );
  if (recentSessions) {
    parts.push(
      `## Recent sessions in this project across all agents (read transcript JSON only when relevant)\n\n${recentSessions}`,
    );
  }
  if (includeHistory) {
    if (isFreshCarryoverPending(thread.items)) {
      const compact = transcript(thread, DEFAULT_CARRYOVER_TRANSCRIPT_CHARS);
      const lastReset = [...thread.items].reverse().find((i): i is Extract<Thread['items'][number], { kind: 'context-reset' }> => i.kind === 'context-reset');
      const txPath = join(sharedRoot(), 'threads', baseProjectId(p.id), `${thread.id}.json`);
      parts.push(
        buildFreshCarryoverSection({
          thread,
          compactTranscript: compact,
          transcriptPath: txPath,
          previousUsed: lastReset?.previousUsed,
        }),
      );
    } else {
      const t = transcript(thread, 24_000);
      if (t) parts.push(`## Conversation so far in this chat (earlier turns may have been answered by a different agent)\n\n${t}`);
    }
  }
  return `<olympus-context agent="${agentId}">\n${parts.join('\n\n')}\n</olympus-context>`;
}

// ---------- editing (Settings → Shared memory) ----------

function memFile(p: Project, name: string): string {
  const n = basename(name);
  if (!n.endsWith('.md') || n !== name) throw new Error('Not a memory file name.');
  return join(ensureMemory(p), n);
}

export function readMemoryFile(p: Project, name: string): string {
  return readFileSync(memFile(p, name), 'utf8');
}

export function writeMemoryFile(p: Project, name: string, text: string): void {
  writeFileSync(memFile(p, name), text.endsWith('\n') ? text : `${text}\n`);
}

export async function deleteMemoryFile(p: Project, name: string): Promise<void> {
  if (name === 'MEMORY.md') throw new Error('MEMORY.md is the index; edit it instead.');
  const f = memFile(p, name);
  if (existsSync(f)) await shell.trashItem(f);
  const index = join(memoryDir(p), 'MEMORY.md');
  const lines = readText(index).split('\n');
  writeFileSync(index, lines.filter((l) => !l.includes(`(${name})`)).join('\n'));
}

export function createMemory(p: Project, m: { title: string; type: 'user' | 'feedback' | 'project' | 'reference'; description: string; body: string }): string {
  const title = m.title.trim();
  const description = m.description.replace(/\s+/g, ' ').trim();
  if (!title || !description) throw new Error('A title and a one-line description are required.');
  const slugName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'memory';
  let name = `${slugName}.md`;
  for (let i = 2; existsSync(join(ensureMemory(p), name)); i++) name = `${slugName}-${i}.md`;
  writeFileSync(join(memoryDir(p), name), `---\nname: ${slugName}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${m.type}\n---\n\n${m.body.trim()}\n`);
  const index = join(memoryDir(p), 'MEMORY.md');
  const cur = readText(index);
  writeFileSync(index, `${cur.replace(/\n*$/, '\n')}- [${title}](${name}) — ${description}\n`);
  return name;
}

export function writeGlobalInstructions(text: string): void {
  mkdirSync(sharedRoot(), { recursive: true });
  writeFileSync(globalInstructionsPath(), text.endsWith('\n') ? text : `${text}\n`);
}
