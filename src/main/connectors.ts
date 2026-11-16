import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorDef, ConnectorView, ImportCandidate } from '@shared/types';
import { agentEnv, spawnable, which } from './env';
import { bridgeEntry } from './orchestrator';
import { getSecret, getSettings, setSecret, updateSettings } from './store';

/**
 * Connectors: MCP servers configured once in Olympus Coder and handed to every agent session (ACP `mcpServers`),
 * next to the app's own `olympus` server. Env and header values are kept encrypted with the OS keychain.
 * Other tools' configs (~/.claude.json, ~/.codex/config.toml, ~/.gemini/settings.json) are only read, for import.
 */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
const secretKey = (id: string, kind: 'env' | 'hdr', name: string) => `mcp:${id}:${kind}:${name}`;

function view(d: ConnectorDef): ConnectorView {
  const env: Record<string, string> = {};
  for (const k of d.envKeys ?? []) env[k] = getSecret(secretKey(d.id, 'env', k)) ?? '';
  const headers: Record<string, string> = {};
  for (const k of d.headerKeys ?? []) headers[k] = getSecret(secretKey(d.id, 'hdr', k)) ?? '';
  return { ...d, env, headers };
}

export const listConnectors = (): ConnectorView[] => getSettings().connectors.map(view);

export type ConnectorInput = Omit<ConnectorView, 'id' | 'tools' | 'testedAt' | 'error'> & { id?: string };

export function saveConnector(input: ConnectorInput): ConnectorView[] {
  const name = input.name.trim();
  if (!name) throw new Error('Give the connector a name.');
  if (slug(name) === 'olympus') throw new Error('"olympus" is the app\'s own server; pick another name.');
  if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('A command is required (e.g. npx).');
  if (input.transport === 'http' && !/^https?:\/\//.test(input.url ?? '')) throw new Error('The URL must start with http:// or https://.');
  const all = getSettings().connectors;
  let id = input.id ?? slug(name);
  if (!input.id) while (all.some((c) => c.id === id)) id += '-2';
  const old = all.find((c) => c.id === id);
  // Secrets: write the new values, drop the ones whose key went away.
  for (const k of old?.envKeys ?? []) if (!(k in input.env)) setSecret(secretKey(id, 'env', k), null);
  for (const k of old?.headerKeys ?? []) if (!(k in input.headers)) setSecret(secretKey(id, 'hdr', k), null);
  for (const [k, v] of Object.entries(input.env)) setSecret(secretKey(id, 'env', k), v);
  for (const [k, v] of Object.entries(input.headers)) setSecret(secretKey(id, 'hdr', k), v);
  const def: ConnectorDef = {
    id,
    name,
    enabled: input.enabled,
    transport: input.transport,
    command: input.transport === 'stdio' ? input.command?.trim() : undefined,
    args: input.transport === 'stdio' ? (input.args ?? []).filter((a) => a !== '') : undefined,
    envKeys: Object.keys(input.env),
    url: input.transport === 'http' ? input.url?.trim() : undefined,
    headerKeys: Object.keys(input.headers),
    agents: input.agents,
    source: input.source ?? old?.source,
    tools: old?.tools,
    testedAt: old?.testedAt,
    error: old?.error,
  };
  updateSettings({ connectors: old ? all.map((c) => (c.id === id ? def : c)) : [...all, def] });
  return listConnectors();
}

export function removeConnector(id: string): ConnectorView[] {
  const d = getSettings().connectors.find((c) => c.id === id);
  for (const k of d?.envKeys ?? []) setSecret(secretKey(id, 'env', k), null);
  for (const k of d?.headerKeys ?? []) setSecret(secretKey(id, 'hdr', k), null);
  updateSettings({ connectors: getSettings().connectors.filter((c) => c.id !== id) });
  return listConnectors();
}

export function setConnectorEnabled(id: string, enabled: boolean): ConnectorView[] {
  updateSettings({ connectors: getSettings().connectors.map((c) => (c.id === id ? { ...c, enabled } : c)) });
  return listConnectors();
}

/** ACP `mcpServers` entries for one agent's session. */
export function acpServersFor(agentId: string, caps: any): any[] {
  const out: any[] = [];
  for (const d of getSettings().connectors) {
    if (!d.enabled || (d.agents !== 'all' && !d.agents.includes(agentId))) continue;
    const v = view(d);
    const name = slug(d.name);
    if (d.transport === 'stdio' && d.command) {
      out.push({ name, command: which(d.command) ?? d.command, args: d.args ?? [], env: Object.entries(v.env).map(([k, val]) => ({ name: k, value: val })) });
    } else if (d.transport === 'http' && d.url) {
      if (caps?.mcpCapabilities?.http) out.push({ type: 'http', name, url: d.url, headers: Object.entries(v.headers).map(([k, val]) => ({ name: k, value: val })) });
      else out.push(bridgeEntry(name, d.url, v.headers));
    }
  }
  return out;
}

// ------------------------------------------------------------------ test: initialize + tools/list

type Tools = { name: string; description?: string }[];
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'olympus-coder', version: '1' } };

function testStdio(v: ConnectorView): Promise<Tools> {
  return new Promise((resolve, reject) => {
    const cmd = spawnable(which(v.command!) ?? v.command!, v.args ?? []);
    const proc = spawn(cmd.command, cmd.args, { env: agentEnv(v.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    let buf = '';
    const done = (err?: Error, tools?: Tools) => {
      clearTimeout(timer);
      proc.kill();
      if (err) reject(err);
      else resolve(tools!);
    };
    const timer = setTimeout(() => done(new Error(`No answer within 45 s.${stderr.length ? `\n${stderr.slice(-6).join('\n')}` : ''}`)), 45_000);
    const send = (m: any) => proc.stdin.write(`${JSON.stringify(m)}\n`);
    proc.on('error', (e) => done(new Error(`Could not start ${v.command}: ${e.message}`)));
    proc.on('exit', (code) => done(new Error(`The server exited (code ${code}).${stderr.length ? `\n${stderr.slice(-6).join('\n')}` : ''}`)));
    proc.stderr.on('data', (d: Buffer) => stderr.push(...d.toString().split('\n').filter(Boolean)));
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return done(new Error(m.error.message ?? 'initialize failed'));
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (m.id === 2) {
          if (m.error) return done(new Error(m.error.message ?? 'tools/list failed'));
          done(undefined, (m.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT });
  });
}

/** One Streamable-HTTP request: JSON or an SSE stream, returning the message with our id. */
async function httpRpc(url: string, headers: Record<string, string>, msg: any, session?: string): Promise<{ reply?: any; session?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...headers },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(30_000),
  });
  const sid = res.headers.get('mcp-session-id') ?? session;
  if (res.status === 202 || msg.id === undefined) return { session: sid };
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' — check the auth header' : ''}`);
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const m = JSON.parse(line.slice(5).trim());
        if (m.id === msg.id) return { reply: m, session: sid };
      } catch {
        /* not JSON */
      }
    }
    throw new Error('No reply in the event stream.');
  }
  return { reply: JSON.parse(text), session: sid };
}

async function testHttp(v: ConnectorView): Promise<Tools> {
  const init = await httpRpc(v.url!, v.headers, { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT });
  if (init.reply?.error) throw new Error(init.reply.error.message);
  await httpRpc(v.url!, v.headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session);
  const list = await httpRpc(v.url!, v.headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.session);
  if (list.reply?.error) throw new Error(list.reply.error.message);
  return (list.reply?.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description }));
}

export async function testConnector(id: string): Promise<ConnectorView[]> {
  const d = getSettings().connectors.find((c) => c.id === id);
  if (!d) throw new Error('Connector not found.');
  let patch: Partial<ConnectorDef>;
  try {
    const tools = d.transport === 'stdio' ? await testStdio(view(d)) : await testHttp(view(d));
    patch = { tools, error: undefined, testedAt: Date.now() };
  } catch (e: any) {
    patch = { error: e?.message ?? String(e), testedAt: Date.now() };
  }
  updateSettings({ connectors: getSettings().connectors.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  return listConnectors();
}

// ------------------------------------------------------------------ import from other tools (read-only)

/** Just enough TOML for `[mcp_servers.<name>]` tables: strings, numbers, booleans, string arrays, inline tables. */
function parseMcpToml(text: string): Record<string, any> {
  const servers: Record<string, any> = {};
  let target: Record<string, any> | null = null;
  const value = (raw: string): any => {
    const v = raw.trim();
    if (/^".*"$/.test(v)) return JSON.parse(v);
    if (/^'.*'$/.test(v)) return v.slice(1, -1);
    if (v.startsWith('[')) return [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]));
    if (v.startsWith('{')) {
      const o: Record<string, string> = {};
      for (const m of v.slice(1, -1).matchAll(/([\w.-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) o[m[1].replace(/"/g, '')] = value(m[2]);
      return o;
    }
    if (v === 'true' || v === 'false') return v === 'true';
    return Number.isNaN(Number(v)) ? v : Number(v);
  };
  for (const line of text.split('\n')) {
    const l = line.replace(/\s+#.*$/, '').trim();
    if (!l || l.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(l);
    if (sec) {
      const parts = sec[1].split('.').map((p) => p.replace(/"/g, ''));
      if (parts[0] !== 'mcp_servers' || parts.length < 2) target = null;
      else {
        servers[parts[1]] ??= {};
        target = parts.length === 2 ? servers[parts[1]] : (servers[parts[1]][parts[2]] ??= {});
      }
      continue;
    }
    const kv = /^([\w.-]+|"[^"]+")\s*=\s*(.+)$/.exec(l);
    if (kv && target) target[kv[1].replace(/"/g, '')] = value(kv[2]);
  }
  return servers;
}

function fromEntry(name: string, e: any, source: string): ImportCandidate | null {
  if (!e || typeof e !== 'object') return null;
  const url = e.url ?? e.httpUrl ?? e.serverUrl;
  if (e.command) {
    return {
      name,
      source,
      connector: { name, transport: 'stdio', command: String(e.command), args: (e.args ?? []).map(String), env: Object.fromEntries(Object.entries(e.env ?? {}).map(([k, v]) => [k, String(v)])), headers: {}, source },
    };
  }
  if (url) {
    const headers = Object.fromEntries(Object.entries(e.headers ?? e.http_headers ?? {}).map(([k, v]) => [k, String(v)]));
    return { name, source, connector: { name, transport: 'http', url: String(url), env: {}, headers, source } };
  }
  return null;
}

export function importCandidates(): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  const home = homedir();
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  try {
    const claude = JSON.parse(read(join(home, '.claude.json')) || '{}');
    for (const [n, e] of Object.entries(claude.mcpServers ?? {})) {
      const c = fromEntry(n, e, '~/.claude.json');
      if (c) out.push(c);
    }
  } catch {
    /* unreadable: skip */
  }
  try {
    for (const [n, e] of Object.entries(parseMcpToml(read(join(home, '.codex', 'config.toml'))))) {
      const c = fromEntry(n, e, '~/.codex/config.toml');
      if (c) out.push(c);
    }
  } catch {
    /* skip */
  }
  try {
    const gem = JSON.parse(read(join(home, '.gemini', 'settings.json')) || '{}');
    for (const [n, e] of Object.entries(gem.mcpServers ?? {})) {
      const c = fromEntry(n, e, '~/.gemini/settings.json');
      if (c) out.push(c);
    }
  } catch {
    /* skip */
  }
  const have = new Set(getSettings().connectors.map((c) => slug(c.name)));
  return out.filter((c) => !have.has(slug(c.name)));
}
