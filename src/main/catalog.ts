import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentDef, CatalogEntry, CatalogMethod, DeskEvents } from '@shared/types';
import snapshot from './registry-snapshot.json';
import { agentEnv, spawnable, which } from './env';
import { getSettings, sharedRoot, updateSettings, writeJson } from './store';

/**
 * Agent catalog for onboarding and Settings, built from the official ACP registry
 * (https://agentclientprotocol.com/get-started/registry). It finds agents whose CLI is already installed, and
 * adds others in one click: npx / uvx packages run without installing, binaries are downloaded, checked against
 * the registry's sha256, and unpacked into <sharedRoot>/agents/<id>/<version>/.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const CACHE_MS = 24 * 60 * 60 * 1000;

interface RegistryAgent {
  id: string;
  name: string;
  version?: string;
  description?: string;
  website?: string;
  repository?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string; args?: string[]; sha256?: string; env?: Record<string, string> }>;
  };
}

/** Built-in agents have their own adapters in the app; the registry copies of them are skipped. */
const BUILTIN_REGISTRY_IDS: Record<string, string> = { 'claude-acp': 'claude', 'codex-acp': 'codex', 'antigravity-acp': 'antigravity' };

/** Name of each agent's own CLI, so an installed copy can be found and used directly. */
const LOCAL_BIN: Record<string, string> = {
  gemini: 'gemini',
  'qwen-code': 'qwen',
  opencode: 'opencode',
  'opencode-v2': 'opencode',
  goose: 'goose',
  cline: 'cline',
  'github-copilot-cli': 'copilot',
  kilo: 'kilo',
  auggie: 'auggie',
  cursor: 'cursor-agent',
  'factory-droid': 'droid',
  'grok-build': 'grok',
  kimi: 'kimi',
  'kimi-code': 'kimi',
  'mistral-vibe': 'vibe-acp',
  kiro: 'kiro-cli',
  devin: 'devin',
  vtcode: 'vtcode',
  'crow-cli': 'crow-cli',
  harn: 'harn',
  stakpak: 'stakpak',
  qoder: 'qodercli',
  dirac: 'dirac',
  bob: 'bob',
  autohand: 'autohand',
  'amp-acp': 'amp-acp',
  poolside: 'pool',
  sigit: 'sigit',
  junie: 'junie',
  kimchi: 'kimchi',
};

/** CLIs behind the built-in agents, with how to install them. */
const BUILTIN_CLI: Record<string, { bin: string; install?: string; docs: string }> = {
  olympus: { bin: 'olympus', docs: 'https://openrouter.ai' },
  claude: { bin: 'claude', install: 'npm install -g @anthropic-ai/claude-code', docs: 'https://docs.claude.com/en/docs/claude-code' },
  codex: { bin: 'codex', install: 'npm install -g @openai/codex', docs: 'https://developers.openai.com/codex/cli' },
  antigravity: { bin: 'agy', docs: 'https://antigravity.google/docs/cli' },
};

const platformKey = () => {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `${os}-${arch}`;
};

const cacheFile = () => join(sharedRoot(), 'registry-cache.json');

let registry: RegistryAgent[] | null = null;
let registryAt = 0;

async function loadRegistry(): Promise<RegistryAgent[]> {
  if (registry && Date.now() - registryAt < CACHE_MS) return registry;
  try {
    const cached = JSON.parse(readFileSync(cacheFile(), 'utf8')) as { at: number; agents: RegistryAgent[] };
    if (Date.now() - cached.at < CACHE_MS) {
      registry = cached.agents;
      registryAt = cached.at;
      return registry;
    }
  } catch {
    /* no cache yet */
  }
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const body: any = await res.json();
      if (Array.isArray(body?.agents)) {
        registry = body.agents as RegistryAgent[];
        registryAt = Date.now();
        writeJson(cacheFile(), { at: registryAt, agents: registry });
        return registry;
      }
    }
  } catch {
    /* offline: use the copy that ships with the app */
  }
  registry = (snapshot as any).agents as RegistryAgent[];
  registryAt = Date.now();
  return registry;
}

function version(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const c = spawnable(bin, ['--version']);
    execFile(c.command, c.args, { env: agentEnv(), timeout: 4000 }, (err, out) => resolve(err ? undefined : String(out).trim().split('\n')[0].slice(0, 60)));
  });
}

const binaryFor = (a: RegistryAgent) => a.distribution.binary?.[platformKey()];

/** Everything onboarding / Settings shows: built-ins first, then installed agents, then the rest of the registry. */
export async function listCatalog(): Promise<CatalogEntry[]> {
  const agents = await loadRegistry();
  const custom = getSettings().customAgents;
  const out: CatalogEntry[] = [];

  for (const [id, cli] of Object.entries(BUILTIN_CLI)) {
    const path = which(cli.bin);
    out.push({
      id,
      name: id === 'olympus' ? 'Olympus' : id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Antigravity',
      description:
        id === 'olympus'
          ? 'Olympus native multi-model coding agent (500+ models via OpenRouter, AI Gateway, or local Ollama)'
          : id === 'claude'
            ? 'Anthropic’s coding agent'
            : id === 'codex'
              ? 'OpenAI’s coding agent'
              : 'Google’s coding agent',
      builtin: true,
      added: true,
      localPath: path ?? (id === 'olympus' ? 'Built-in' : undefined),
      localVersion: path ? await version(path) : undefined,
      methods: [],
      installCommand: path ? undefined : cli.install,
      docs: cli.docs,
      blocked: !path && cli.install && !which('npm') ? { local: 'npm is not installed (install Node.js first)' } : {},
    });
  }

  const npx = which('npx');
  const uvx = which('uvx');
  for (const a of agents) {
    if (BUILTIN_REGISTRY_IDS[a.id]) continue;
    const localBin = LOCAL_BIN[a.id];
    const localPath = localBin ? which(localBin) : null;
    const methods: CatalogMethod[] = [];
    const blocked: CatalogEntry['blocked'] = {};
    if (localPath) methods.push('local');
    if (binaryFor(a)) methods.push('binary');
    if (a.distribution.npx) {
      methods.push('npx');
      if (!npx) blocked.npx = 'Needs Node.js (npx)';
    }
    if (a.distribution.uvx) {
      methods.push('uvx');
      if (!uvx) blocked.uvx = 'Needs uv (uvx)';
    }
    if (!methods.length) continue; // nothing runs on this platform
    out.push({
      id: a.id,
      name: a.name,
      description: a.description ?? '',
      website: a.website ?? a.repository,
      version: a.version,
      builtin: false,
      added: custom.some((c) => c.registryId === a.id),
      localPath: localPath ?? undefined,
      localVersion: localPath ? await version(localPath) : undefined,
      methods,
      blocked,
    });
  }
  return out;
}

async function download(id: string, url: string, sha256: string | undefined, emit: Emit): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0) || undefined;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (Date.now() - last > 150) {
      last = Date.now();
      emit('catalog:progress', { id, phase: 'download', received, total });
    }
  }
  const buf = Buffer.concat(chunks);
  emit('catalog:progress', { id, phase: 'verify', received, total });
  if (sha256) {
    const got = createHash('sha256').update(buf).digest('hex');
    if (got.toLowerCase() !== sha256.toLowerCase()) throw new Error('Downloaded file does not match the registry checksum — not installed.');
  }
  const file = join(tmpdir(), `olympus-${id}-${Date.now()}-${basename(new URL(url).pathname)}`);
  writeFileSync(file, buf);
  return file;
}

function extract(archive: string, dest: string): Promise<void> {
  const lower = archive.toLowerCase();
  let cmd: string;
  let args: string[];
  if (lower.endsWith('.zip')) {
    // bsdtar (macOS, Windows 10+) reads zip; Linux uses unzip.
    if (process.platform === 'linux') [cmd, args] = ['unzip', ['-q', '-o', archive, '-d', dest]];
    else [cmd, args] = ['tar', ['-xf', archive, '-C', dest]];
  } else if (/\.(tar\.gz|tgz)$/.test(lower)) [cmd, args] = ['tar', ['-xzf', archive, '-C', dest]];
  else if (/\.(tar\.bz2|tbz2?)$/.test(lower)) [cmd, args] = ['tar', ['-xjf', archive, '-C', dest]];
  else if (/\.(tar\.xz|txz)$/.test(lower)) [cmd, args] = ['tar', ['-xJf', archive, '-C', dest]];
  else return Promise.reject(new Error(`Unsupported archive type: ${basename(archive)}`));
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5 * 60_000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve())));
}

/** Adds a registry agent to the app. Returns the new agent's id. */
export async function addFromCatalog(id: string, method: CatalogMethod, emit: Emit): Promise<string> {
  const a = (await loadRegistry()).find((x) => x.id === id);
  if (!a) throw new Error('Agent not found in the registry.');
  let command: string;
  let args: string[];
  let env: Record<string, string> | undefined;
  if (method === 'local') {
    const path = LOCAL_BIN[id] && which(LOCAL_BIN[id]);
    if (!path) throw new Error('This agent’s CLI is not installed.');
    command = path;
    args = binaryFor(a)?.args ?? a.distribution.npx?.args ?? a.distribution.uvx?.args ?? [];
  } else if (method === 'npx') {
    const d = a.distribution.npx!;
    command = which('npx') ?? 'npx';
    args = ['-y', d.package, ...(d.args ?? [])];
    env = d.env;
  } else if (method === 'uvx') {
    const d = a.distribution.uvx!;
    command = which('uvx') ?? 'uvx';
    args = [d.package, ...(d.args ?? [])];
    env = d.env;
  } else {
    const b = binaryFor(a);
    if (!b) throw new Error('No download for this platform.');
    const dest = join(sharedRoot(), 'agents', id, a.version ?? 'latest');
    try {
      emit('catalog:progress', { id, phase: 'download', received: 0 });
      const file = await download(id, b.archive, b.sha256, emit);
      emit('catalog:progress', { id, phase: 'extract' });
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      await extract(file, dest);
      rmSync(file, { force: true });
    } catch (e: any) {
      emit('catalog:progress', { id, phase: 'error', error: e?.message ?? String(e) });
      throw e;
    }
    command = join(dest, b.cmd.replace(/^\.\//, ''));
    if (!existsSync(command)) throw new Error(`Downloaded, but ${b.cmd} was not found in the archive.`);
    if (process.platform !== 'win32') chmodSync(command, 0o755);
    args = b.args ?? [];
    env = b.env;
  }
  const s = getSettings();
  const existing = s.customAgents.find((c) => c.registryId === id);
  const def: AgentDef = {
    id: existing?.id ?? id,
    name: a.name,
    badge: a.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AG',
    color: '#8b5cf6',
    description: a.description ?? `${command} ${args.join(' ')}`,
    builtin: false,
    command,
    args,
    env,
    detectBinary: command,
    registryId: id,
  };
  updateSettings({ customAgents: [...s.customAgents.filter((c) => c.registryId !== id), def] });
  emit('catalog:progress', { id, phase: 'done' });
  return def.id;
}

/** Onboarding: add every agent whose CLI is already installed (and not added yet). Returns their names. */
export async function autoAddInstalled(emit: Emit): Promise<string[]> {
  const added: string[] = [];
  for (const e of await listCatalog()) {
    if (!e.builtin && !e.added && e.localPath) {
      try {
        await addFromCatalog(e.id, 'local', emit);
        added.push(e.name);
      } catch {
        /* skip one that fails */
      }
    }
  }
  return added;
}

/** The shell command that installs a built-in agent's CLI, for the in-app terminal. */
export function builtinInstallCommand(id: string): string | undefined {
  return BUILTIN_CLI[id]?.install;
}
