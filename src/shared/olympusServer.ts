/**
 * The name a chat's own `olympus` MCP server is registered under.
 *
 * Most agents keep MCP servers per session, so every chat can use the plain name `olympus`. Antigravity
 * (`agy acp`) keeps ONE MCP registry for its whole process, keyed by server name: when a second chat registers
 * another `olympus`, agy renames it to `olympus_<hash>` and the plain name keeps pointing at whichever chat came
 * first. A session can only call servers it registered itself, so a model that follows "use the olympus server"
 * gets "tool spawn_subsession is not enabled for server olympus". For those agents each chat gets a stable name
 * of its own, derived from its id, which agy keeps as-is and which stays the same across app restarts (a resumed
 * session re-registered under the same name with a new URL uses the new URL).
 */

export const OLYMPUS_SERVER = 'olympus';

/** Agents whose MCP servers live in one registry per process, shared by all of its sessions. */
const SHARED_MCP_REGISTRY = new Set(['antigravity']);

export function sharesMcpRegistry(agentId: string): boolean {
  return SHARED_MCP_REGISTRY.has(agentId);
}

/** 8 hex chars for a chat id: its own first 8 hex digits (thread ids are UUIDs), else an FNV-1a hash. */
function chatCode(threadId: string): string {
  const hex = threadId.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{8}/.test(hex)) return hex.slice(0, 8);
  let h = 0x811c9dc5;
  for (let i = 0; i < threadId.length; i++) {
    h ^= threadId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Where each chat's server was last registered (main process), so the guide names the same server. */
const registered = new Map<string, string>();

/**
 * Picks the name for a new registration of a chat's server. In a shared registry the name must also be free in
 * that agent process: a chat that registers again in the same process (agent switched back, session restarted)
 * gets `olympus_<code>_0002`…, because its earlier session still holds `olympus_<code>` there.
 */
export function claimOlympusServerName(agentId: string, threadId: string, takenInProcess: Set<string>): string {
  if (!sharesMcpRegistry(agentId)) return OLYMPUS_SERVER;
  const base = `${OLYMPUS_SERVER}_${chatCode(threadId)}`;
  let name = base;
  for (let n = 2; takenInProcess.has(name); n++) name = `${base}_${n.toString(16).padStart(4, '0')}`;
  takenInProcess.add(name);
  registered.set(threadId, name);
  return name;
}

/** The name of a chat's own server: where it is registered now, else where it will be. */
export function olympusServerName(agentId: string, threadId: string): string {
  if (!sharesMcpRegistry(agentId)) return OLYMPUS_SERVER;
  return registered.get(threadId) ?? `${OLYMPUS_SERVER}_${chatCode(threadId)}`;
}
