import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { DeskEvents, Thread } from '@shared/types';
import { allAgents, sendPrompt } from './agents';
import { ToolError } from './orchestratorAgents';
import { addProject, createThread, listProjectsWithMissing, sharedRoot, threadMeta } from './store';

/**
 * `create_project` on the `olympus` MCP server: a main session adds a folder as an Olympus project (it shows in the
 * sidebar at once through `projects:changed`, emitted by the store's write hook) and can open a first chat in it.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

export const PROJECT_TOOLS = ['create_project'];
const ALLOWED = ['path', 'name', 'create_folder', 'prompt', 'agent'];

/** Same gate as the agent and schedule tools: main sessions and user forks, never workers or second opinions. */
export function canManageProjects(t: Pick<Thread, 'spawnedBy' | 'secondOpinion'>): boolean {
  return !t.spawnedBy && !t.secondOpinion;
}

export function projectToolDefs() {
  // Kept small on purpose: agy silently disables MCP tools with large declarations (see toolsFor in orchestrator.ts).
  return [
    {
      name: 'create_project',
      title: 'Create project',
      description: 'Add a folder as an Olympus project; with prompt, open a chat in it (default agent: claude).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute.' },
          name: { type: 'string' },
          create_folder: { type: 'boolean', description: 'mkdir -p it.' },
          prompt: { type: 'string' },
          agent: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

function str(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${what}" must be a string.`);
  const s = v.trim();
  if (s.length > max) throw new ToolError(`"${what}" is too long (max ${max} characters).`);
  return s || undefined;
}

export async function handleProjectTool(thread: Thread, toolName: string, args: any, emit: Emit): Promise<string | undefined> {
  if (!PROJECT_TOOLS.includes(toolName)) return undefined;
  if (!canManageProjects(thread)) throw new ToolError('Sub-sessions and second opinions cannot create projects.');
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new ToolError('Arguments must be an object.');
  const extra = Object.keys(args ?? {}).filter((k) => !ALLOWED.includes(k));
  if (extra.length) throw new ToolError(`Unknown argument${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}. Allowed: ${ALLOWED.join(', ')}.`);

  const raw = str(args?.path, 'path', 1024);
  if (!raw) throw new ToolError('"path" is required.');
  if (!isAbsolute(raw)) throw new ToolError(`"path" must be absolute (got "${raw}").`);
  const name = str(args?.name, 'name', 120);
  const prompt = str(args?.prompt, 'prompt', 100_000);
  const agentId = str(args?.agent, 'agent', 80) ?? 'claude';
  if (args?.create_folder !== undefined && typeof args.create_folder !== 'boolean') throw new ToolError('"create_folder" must be true or false.');
  if (prompt && !allAgents().some((a) => a.id === agentId)) {
    throw new ToolError(`Unknown agent "${agentId}". Known: ${allAgents().map((a) => a.id).join(', ')}.`);
  }

  const path = resolve(raw);
  const root = real(sharedRoot());
  if (inside(path, resolve(sharedRoot())) || inside(real(path), root)) {
    throw new ToolError(`"${path}" is inside the Olympus shared folder (${sharedRoot()}); pick a folder outside it.`);
  }
  let st = statSync(path, { throwIfNoEntry: false });
  if (!st) {
    if (args?.create_folder !== true) throw new ToolError(`No folder at "${path}". Pass create_folder: true to create it.`);
    mkdirSync(path, { recursive: true });
    st = statSync(path);
  }
  if (!st.isDirectory()) throw new ToolError(`"${path}" is not a folder.`);

  // Match by the real folder: old paths can be symlinks to moved projects (e.g. ~/Documents/olympus-coder-cli),
  // and a symlinked path must return the existing project, not add a second one.
  const canonical = real(path);
  const existed = listProjectsWithMissing().find((p) => p.path === path || p.path === canonical || real(p.path) === canonical);
  // A new project is written by the store, whose hook emits `projects:changed` now, before any chat event below.
  const project = existed ?? addProject(path, name);
  const out: { projectId: string; name: string; path: string; existed: boolean; chatId?: string } = {
    projectId: project.id,
    name: project.name,
    path: project.path,
    existed: Boolean(existed),
  };
  if (prompt) {
    const chat = createThread(project.id, agentId);
    emit('thread:meta', threadMeta(chat));
    void sendPrompt(chat.id, prompt).catch((e) => console.warn(`[create_project] first prompt failed: ${e?.message ?? e}`));
    out.chatId = chat.id;
  }
  return JSON.stringify(out);
}
