import type { CatalogEntry, CatalogMethod, ConfirmRequest, DeskEvents, Thread } from '@shared/types';
import { allAgents, chatsUsingAgent, checkAgent } from './agents';
import { addFromCatalog, listCatalog, planCatalogAdd } from './catalog';
import { addCustomAgent, announceAgents, probeAcp, removeCustomAgent } from './customAgents';
import { confirmInThread } from './elicitation';
import { ToolError } from './orchestratorAgents';
import { findThread } from './store';

/**
 * Agent manager tools on the `olympus` MCP server: an agent can find, add and remove CLI coding agents, but every
 * change waits for the user's OK on a confirm card Olympus itself shows in the calling chat (never auto-approved).
 * Login stays with the user (Settings → Agents & login); no tool takes API keys.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

export const AGENT_TOOLS = ['search_agent_registry', 'add_agent', 'add_custom_agent', 'remove_agent'];
const METHODS: CatalogMethod[] = ['local', 'npx', 'uvx', 'binary'];
/** Preferred method when the agent gives none: no download first. */
const DEFAULT_ORDER: CatalogMethod[] = ['local', 'npx', 'uvx', 'binary'];
const DECLINED = 'The user declined.';
const LOGIN_HINT = 'The user must log in via Settings → Agents & login (never ask for API keys in chat).';

/** Main and user-forked sessions may add and remove agents; workers and read-only second opinions may not. */
export function canManageAgents(t: Pick<Thread, 'spawnedBy' | 'secondOpinion'>): boolean {
  return !t.spawnedBy && !t.secondOpinion;
}

export function agentToolDefs() {
  // Kept small on purpose: agy silently disables MCP tools with large declarations (see toolsFor in orchestrator.ts).
  return [
    {
      name: 'search_agent_registry',
      title: 'Search agent registry',
      description: 'Search the ACP registry for CLI coding agents that can be added, with install methods for this computer.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to match; omit for all.' } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: 'add_agent',
      title: 'Add agent',
      description: 'Add a registry agent. The user approves in the chat first.',
      inputSchema: {
        type: 'object',
        properties: { registry_id: { type: 'string' }, method: { type: 'string', enum: METHODS } },
        required: ['registry_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'add_custom_agent',
      title: 'Add custom agent',
      description: 'Add an ACP agent by command line. The user approves first; it is saved only if it answers ACP initialize.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
        required: ['name', 'command'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'remove_agent',
      title: 'Remove agent',
      description: 'Remove an added (not built-in) agent. The user approves first.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

/** One agent change at a time (a second call while a card waits or an install runs gets a clear error). */
let busy: string | undefined;

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const commandLine = (command: string, args: string[]) => [command, ...args].map(quote).join(' ');

function onlyArgs(args: any, allowed: string[]) {
  if (args !== undefined && (typeof args !== 'object' || Array.isArray(args) || args === null)) throw new ToolError('Arguments must be an object.');
  const extra = Object.keys(args ?? {}).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ToolError(`Unknown argument${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}. Allowed: ${allowed.join(', ')}. API keys are never passed here; ${LOGIN_HINT}`);
}

function text(v: unknown, what: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`"${what}" is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new ToolError(`"${what}" must be a string.`);
  const s = v.trim();
  if (required && !s) throw new ToolError(`"${what}" is required.`);
  if (s.length > max) throw new ToolError(`"${what}" is too long (max ${max} characters).`);
  return s;
}

const requester = (t: Thread) => allAgents().find((a) => a.id === t.agentId)?.name ?? 'The agent';

/** Waits for the user's answer on a confirm card; an MCP request the agent dropped withdraws the card. */
async function ask(t: Thread, req: ConfirmRequest, closed?: () => boolean): Promise<boolean> {
  const ac = new AbortController();
  const poll = closed ? setInterval(() => closed() && ac.abort(), 1000) : undefined;
  try {
    return await confirmInThread(t.id, req, ac.signal);
  } finally {
    if (poll) clearInterval(poll);
  }
}

function usable(e: CatalogEntry): CatalogMethod[] {
  return e.methods.filter((m) => !e.blocked[m]);
}

function describeEntry(e: CatalogEntry): string {
  const methods = usable(e);
  const blocked = Object.entries(e.blocked).map(([m, why]) => `${m}: ${why}`);
  const desc = e.description.replace(/\s+/g, ' ').slice(0, 110);
  return `- **${e.name}** (id: \`${e.id}\`)${e.added ? ' · already added' : ''} — ${desc || 'no description'}\n  methods: ${methods.join(', ') || 'none usable'}${blocked.length ? ` (unavailable: ${blocked.join('; ')})` : ''}`;
}

/** Waits for the new agent's first start; long npx first runs get a clear "still starting" instead of a hang. */
async function readiness(id: string, name: string): Promise<string> {
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 90_000).unref?.());
  const st = await Promise.race([checkAgent(id), timeout]);
  if (st === 'timeout') return `${name} is still starting. Check it later with list_agents.`;
  if (st.state === 'ready') return `Status: ready. It shows in Settings → Agents and list_agents.`;
  if (st.state === 'needs-login') return `Status: needs login. ${LOGIN_HINT}`;
  return `Status: ${st.state}${st.detail ? ` — ${st.detail}` : ''}. It stays in Settings → Agents; remove it with remove_agent if it is not wanted.`;
}

export async function handleAgentTool(thread: Thread, toolName: string, args: any, emit: Emit, closed?: () => boolean): Promise<string | undefined> {
  if (!AGENT_TOOLS.includes(toolName)) return undefined;
  if (!canManageAgents(thread)) throw new ToolError('Sub-sessions and second opinions cannot add or remove agents.');

  if (toolName === 'search_agent_registry') {
    onlyArgs(args, ['query']);
    const q = text(args?.query, 'query', 120, false).toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const all = (await listCatalog()).filter((e) => !e.builtin);
    const hits = all.filter((e) => words.every((w) => `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(w)));
    if (!hits.length) return `No registry agents match "${q}". ${all.length} agents are in the registry; try a shorter query.`;
    const shown = hits.slice(0, 25);
    return `Registry agents (${hits.length}${hits.length > shown.length ? `, first ${shown.length} shown — pass a query to narrow` : ''}):\n\n${shown.map(describeEntry).join('\n')}\n\nAdd one with add_agent {"registry_id": "<id>"}.`;
  }

  if (toolName === 'add_agent') onlyArgs(args, ['registry_id', 'method']);
  else if (toolName === 'add_custom_agent') onlyArgs(args, ['name', 'command', 'args']);
  else onlyArgs(args, ['id']);
  if (busy) throw new ToolError(`Another agent change is in progress (${busy}). Try again when it is done.`);

  if (toolName === 'add_agent') {
    const id = text(args?.registry_id, 'registry_id', 120);
    const wanted = args?.method === undefined || args?.method === null || args?.method === '' ? undefined : String(args.method);
    if (wanted && !METHODS.includes(wanted as CatalogMethod)) throw new ToolError(`Invalid method "${wanted}". Use one of: ${METHODS.join(', ')}.`);
    busy = `adding ${id}`;
    try {
      const entry = (await listCatalog()).find((e) => e.id === id);
      if (!entry) throw new ToolError(`No registry agent with id "${id}". Find ids with search_agent_registry.`);
      if (entry.builtin) throw new ToolError(`${entry.name} is built into Olympus Coder already.`);
      if (entry.added) throw new ToolError(`${entry.name} is already added. Remove it with remove_agent first to add it again.`);
      const ok = usable(entry);
      const method = (wanted as CatalogMethod | undefined) ?? DEFAULT_ORDER.find((m) => ok.includes(m));
      if (!method) throw new ToolError(`${entry.name} cannot be added on this computer: ${Object.values(entry.blocked).join('; ') || 'no install method for this platform'}.`);
      if (!entry.methods.includes(method)) throw new ToolError(`${entry.name} has no "${method}" method here. Available: ${entry.methods.join(', ')}.`);
      if (entry.blocked[method]) throw new ToolError(`The "${method}" method is not available: ${entry.blocked[method]}.`);
      let plan;
      try {
        plan = await planCatalogAdd(id, method);
      } catch (e: any) {
        throw new ToolError(e?.message ?? String(e));
      }
      const rows: ConfirmRequest['rows'] = [
        { label: 'Agent', value: `${plan.name}${plan.version ? ` ${plan.version}` : ''}` },
        { label: 'Source', value: `ACP registry · ${id} · ${method}` },
      ];
      if (plan.download) rows.push({ label: 'Download', value: `${plan.download.url}${plan.download.sha256 ? ' (sha256 checked)' : ' (no checksum in the registry)'}`, code: true });
      rows.push({ label: 'Command', value: commandLine(plan.command, plan.args), code: true });
      const yes = await ask(thread, { title: `${requester(thread)} wants to add ${plan.name}`, rows, action: 'Add agent' }, closed);
      if (!yes) return DECLINED;
      let newId: string;
      try {
        newId = await addFromCatalog(id, method, emit);
      } catch (e: any) {
        throw new ToolError(`Adding ${plan.name} failed: ${e?.message ?? String(e)}`);
      } finally {
        announceAgents(emit);
      }
      return `Added ${plan.name} (agent id \`${newId}\`, ${method}). ${await readiness(newId, plan.name)}`;
    } finally {
      busy = undefined;
    }
  }

  if (toolName === 'add_custom_agent') {
    const name = text(args?.name, 'name', 60);
    const command = text(args?.command, 'command', 500);
    const raw = args?.args ?? [];
    if (!Array.isArray(raw) || raw.some((a: unknown) => typeof a !== 'string')) throw new ToolError('"args" must be an array of strings.');
    const argv = raw as string[];
    if (argv.length > 40 || argv.some((a) => a.length > 500)) throw new ToolError('"args" is too long.');
    busy = `adding ${name}`;
    try {
      const line = commandLine(command, argv);
      const yes = await ask(
        thread,
        {
          title: `${requester(thread)} wants to add ${name}`,
          rows: [
            { label: 'Agent', value: name },
            { label: 'Source', value: 'Custom command' },
            { label: 'Command', value: line, code: true },
          ],
          action: 'Add agent',
        },
        closed,
      );
      if (!yes) return DECLINED;
      let info: string;
      try {
        info = await probeAcp(command, argv);
      } catch (e: any) {
        throw new ToolError(`Not saved: ${line} did not work as an ACP agent. ${e?.message ?? String(e)}`);
      }
      const def = addCustomAgent({ name, command, args: argv, color: '', logo: '' }, emit);
      return `Added ${name} (agent id \`${def.id}\`; answered initialize as ${info}). ${await readiness(def.id, name)}`;
    } finally {
      busy = undefined;
    }
  }

  // remove_agent
  const id = text(args?.id, 'id', 120);
  const def = allAgents().find((a) => a.id === id);
  if (!def) throw new ToolError(`No agent with id "${id}". Added agents: ${allAgents().filter((a) => !a.builtin).map((a) => a.id).join(', ') || 'none'}.`);
  if (def.builtin) throw new ToolError(`${def.name} is built into Olympus Coder and cannot be removed.`);
  const using = chatsUsingAgent(id);
  if (using.length) {
    const titles = using.map((x) => findThread(x)?.title ?? x).slice(0, 5);
    throw new ToolError(`${def.name} is in use by ${using.length} running chat${using.length > 1 ? 's' : ''} (${titles.join(', ')}). Wait for ${using.length > 1 ? 'them' : 'it'} to finish first.`);
  }
  busy = `removing ${id}`;
  try {
    const yes = await ask(
      thread,
      {
        title: `${requester(thread)} wants to remove ${def.name}`,
        rows: [
          { label: 'Agent', value: `${def.name} (${def.id})` },
          { label: 'Command', value: commandLine(def.command, def.args), code: true },
        ],
        action: 'Remove agent',
        danger: true,
      },
      closed,
    );
    if (!yes) return DECLINED;
    if (chatsUsingAgent(id).length) throw new ToolError(`${def.name} started running in a chat meanwhile; not removed.`);
    removeCustomAgent(id, emit);
    return `Removed ${def.name} (${id}). Chats that used it keep their history.`;
  } finally {
    busy = undefined;
  }
}
