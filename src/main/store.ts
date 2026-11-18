import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type { Project, SearchHit, Settings, Thread, ThreadItem, ThreadMeta, UserProfile } from '@shared/types';
import { DEFAULT_THEME, migrateThemeColors } from '@shared/themes';
import { chatMediaDir, removeChatMedia } from './acpContent';
import { defaultSharedRoot, migrateLegacySharedRoot } from './sharedMigration';
import { relocateOnDisk } from './relocate';

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash never leaves half a JSON file. */
export function writeJson(file: string, data: unknown, pretty = true): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

const userDir = () => app.getPath('userData');
const settingsFile = () => join(userDir(), 'settings.json');
const secretsFile = () => join(userDir(), 'secrets.json');

export const DEFAULT_PROFILE: UserProfile = {
  name: '',
  email: '',
  role: '',
  location: '',
  github: '',
  website: '',
  languages: '',
  about: '',
  avatarColor: '#d97757',
  avatar: '',
  shareWithAgents: true,
};

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  uiMode: 'code',
  profile: DEFAULT_PROFILE,
  // ~/.olympus, or OLYMPUS_HOME / the older AGENTDESK_SHARED_ROOT (tests use a throwaway folder).
  sharedRoot: defaultSharedRoot(homedir()),
  defaultAgent: 'claude',
  injectSharedContext: true,
  theme: DEFAULT_THEME,
  customAgents: [],
  orchestrator: { enabled: true, maxParallel: 3, maxPerSession: 8 },
  connectors: [],
  toolRules: [],
  seenTools: [],
  disabledSkills: [],
  agentDefaults: {},
  remote: { enabled: false, port: 47816 },
  notifyAgentsWhenWorkEnds: false,
  notifyParentOnSubsessionEnd: true,
  updateMode: 'notify',
  updateWifiOnly: false,
  updateInstallOnQuit: true,
};

/** Settings saved before `updateMode` existed: "Check for updates" off becomes 'off'. Returns true when changed. */
export function migrateUpdateMode(saved: Partial<Settings>): boolean {
  if (!('checkForUpdates' in saved)) return false;
  if (!saved.updateMode) saved.updateMode = saved.checkForUpdates === false ? 'off' : 'notify';
  delete saved.checkForUpdates;
  return true;
}

let settings: Settings | null = null;

export function getSettings(): Settings {
  if (!settings) {
    const saved = readJson<Partial<Settings>>(settingsFile(), {});
    // Once: the shared folder moves from the old default ~/.agents to ~/.olympus (sharedMigration.ts).
    migrateLegacySharedRoot({
      home: homedir(),
      saved,
      save: (patch) => {
        Object.assign(saved, patch);
        writeJson(settingsFile(), saved);
      },
    });
    if (migrateUpdateMode(saved)) writeJson(settingsFile(), saved);
    // Once: global custom colors become dark-mode custom colors (light must never inherit a color set in dark).
    const migratedTheme = migrateThemeColors({ ...DEFAULT_THEME, ...(saved.theme ?? {}) });
    settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      theme: migratedTheme.theme,
      profile: { ...DEFAULT_PROFILE, ...(saved.profile ?? {}) },
      orchestrator: { ...DEFAULT_SETTINGS.orchestrator, ...(saved.orchestrator ?? {}) },
    };
    if (migratedTheme.changed) writeJson(settingsFile(), settings);
    // Design v2: move people still on the old default fonts to the bundled Inter / JetBrains Mono, once.
    if ((settings.designVersion ?? 0) < 2) {
      if (settings.theme.uiFont === 'system') settings.theme.uiFont = 'inter';
      if (settings.theme.codeFont === 'SF Mono') settings.theme.codeFont = 'JetBrains Mono';
      settings.designVersion = 2;
      if (existsSync(settingsFile())) writeJson(settingsFile(), settings);
    }
  }
  return settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings = { ...getSettings(), ...patch };
  writeJson(settingsFile(), settings);
  return settings;
}

// ---------- secrets (API keys), encrypted with the OS keychain via safeStorage ----------

export function getSecret(key: string): string | undefined {
  const all = readJson<Record<string, string>>(secretsFile(), {});
  const enc = all[key];
  if (!enc) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return undefined;
  }
}

/** True when API keys can be encrypted by the OS (Keychain, DPAPI, GNOME Keyring / KWallet). */
export function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // Linux without a keyring falls back to a fixed key, which is not real protection.
  if (process.platform === 'linux' && (safeStorage as any).getSelectedStorageBackend?.() === 'basic_text') return false;
  return true;
}

export function setSecret(key: string, value: string | null): void {
  const all = readJson<Record<string, string>>(secretsFile(), {});
  if (value && !secureStorageAvailable()) {
    throw new Error('No system keyring found (GNOME Keyring or KWallet), so the API key cannot be stored securely. Install and unlock a keyring, or use the agent’s own login instead.');
  }
  if (value) all[key] = safeStorage.encryptString(value).toString('base64');
  else delete all[key];
  writeJson(secretsFile(), all);
}

/** Owners (the part before `:`) of every saved secret named `${owner}:${varName}`, e.g. agents with OPENROUTER_API_KEY. */
export function secretOwners(varName: string): string[] {
  const all = readJson<Record<string, string>>(secretsFile(), {});
  const suffix = `:${varName}`;
  return Object.keys(all)
    .filter((k) => k.endsWith(suffix) && Boolean(all[k]))
    .map((k) => k.slice(0, -suffix.length));
}

/** Names of environment variables saved under `${agentId}:<VAR>` (values stay encrypted until `getSecret`). */
export function secretVarNamesForAgent(agentId: string): string[] {
  const prefix = `${agentId}:`;
  const all = readJson<Record<string, string>>(secretsFile(), {});
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix) && Boolean(all[k]))
    .map((k) => k.slice(prefix.length))
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

// ---------- shared root: projects, threads ----------

export const sharedRoot = () => getSettings().sharedRoot;
const projectsFile = () => join(sharedRoot(), 'projects.json');
const threadsDir = (projectId: string) => join(sharedRoot(), 'threads', projectId);

/** Told after every write of projects.json by the app (add, remove, reorder, relocate/rename): see projectWatch.ts. */
let projectsWritten: () => void = () => {};
export const onProjectsWritten = (fn: () => void) => (projectsWritten = fn);

export function listProjects(): Project[] {
  return readJson<Project[]>(projectsFile(), []).filter((p) => existsSync(p.path));
}

/** For the sidebar: every project, with `missing` set when its folder is gone (renamed or moved). */
export function listProjectsWithMissing(): Project[] {
  return readJson<Project[]>(projectsFile(), []).map((p) => (existsSync(p.path) ? p : { ...p, missing: true }));
}

/** A project by id even when its folder is missing (getProject only returns reachable ones). */
export function projectRecord(id: string): Project | undefined {
  return readJson<Project[]>(projectsFile(), []).find((p) => p.id === id);
}

/** Points a project at its renamed or moved folder; memory and Claude Code's sessions follow (relocate.ts). */
export function relocateProject(id: string, newPath: string): Project {
  const p = projectRecord(id);
  if (!p) throw new Error('Project not found.');
  const r = relocateOnDisk({ sharedRoot: sharedRoot(), home: homedir(), oldPath: p.path, newPath, projectId: id });
  console.log(`[relocate] ${p.path} → ${newPath}\n  ${r.steps.join('\n  ')}`);
  projectsWritten();
  return { ...p, ...r.project! };
}

/** Chat-mode conversations that are not about a project run in this folder. */
export const GENERAL_PROJECT_ID = 'general';
export function generalProject(): Project {
  const path = join(sharedRoot(), 'workspace');
  mkdirSync(path, { recursive: true });
  return { id: GENERAL_PROJECT_ID, name: 'General', path, createdAt: 0 };
}

/** Adds a project for `path`; a path that is already a project returns that project (never a duplicate). */
export function addProject(path: string, name?: string): Project {
  const all = readJson<Project[]>(projectsFile(), []);
  const existing = all.find((p) => p.path === path);
  if (existing) return existing;
  const project: Project = { id: randomUUID(), name: name?.trim() || basename(path), path, createdAt: Date.now() };
  writeJson(projectsFile(), [...all, project]);
  projectsWritten();
  return project;
}

/** Puts the projects in the order given (ids not listed keep their place at the end). */
export function reorderProjects(ids: string[]): void {
  const all = readJson<Project[]>(projectsFile(), []);
  const rank = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...all].sort((a, b) => (rank.get(a.id) ?? 1e9 + all.indexOf(a)) - (rank.get(b.id) ?? 1e9 + all.indexOf(b)));
  writeJson(projectsFile(), sorted);
  projectsWritten();
}

export function removeProject(id: string): void {
  writeJson(
    projectsFile(),
    readJson<Project[]>(projectsFile(), []).filter((p) => p.id !== id),
  );
  projectsWritten();
}

export function updateProjectVerifyGate(id: string, verifyGate: Project['verifyGate']): Project | undefined {
  if (id === GENERAL_PROJECT_ID) return undefined;
  const all = readJson<Project[]>(projectsFile(), []);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  const updated: Project = { ...all[idx], verifyGate };
  all[idx] = updated;
  writeJson(projectsFile(), all);
  projectsWritten();
  return updated;
}

export function getProject(id: string): Project | undefined {
  if (id === GENERAL_PROJECT_ID) return generalProject();
  return listProjects().find((p) => p.id === id);
}

/** Projects plus the General workspace, for everything that walks all chats. */
const allProjects = () => [...listProjects(), generalProject()];

const threadCache = new Map<string, Thread>();
const saveTimers = new Map<string, NodeJS.Timeout>();

function threadFile(t: Pick<ThreadMeta, 'projectId' | 'id'>) {
  return join(threadsDir(t.projectId), `${t.id}.json`);
}

export function listThreads(projectId: string): ThreadMeta[] {
  const dir = threadsDir(projectId);
  if (!existsSync(dir)) return [];
  const metas: ThreadMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const t = threadCache.get(id) ?? readJson<Thread | null>(join(dir, f), null);
    if (t) metas.push(threadMeta(t));
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every chat of a project with its items, for statistics: the live copy when open, else read from disk (not cached). */
export function projectThreads(projectId: string): Thread[] {
  const dir = threadsDir(projectId);
  if (!existsSync(dir)) return [];
  const out: Thread[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const t = threadCache.get(f.slice(0, -5)) ?? readJson<Thread | null>(join(dir, f), null);
    if (t) out.push(t);
  }
  return out;
}

export function threadMeta(t: Thread): ThreadMeta {
  const { items: _items, acpSessions: _s, ...meta } = t;
  return meta;
}

export function getThread(projectId: string, id: string): Thread | undefined {
  const cached = threadCache.get(id);
  if (cached) return cached;
  const t = readJson<Thread | null>(threadFile({ projectId, id }), null);
  if (t) {
    // Read from disk means it is not live in this run of the app: a tool still marked running, or a permission
    // still open, belonged to an agent process that ended when the app last closed.
    for (const item of t.items ?? []) {
      if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) item.status = 'interrupted';
      else if (item.kind === 'permission' && !item.resolved) item.resolved = 'Expired';
      else if (item.kind === 'elicitation' && !item.resolved) item.resolved = 'expired';
    }
    threadCache.set(id, t);
  }
  return t ?? undefined;
}

export function findThread(id: string): Thread | undefined {
  const cached = threadCache.get(id);
  if (cached) return cached;
  for (const p of allProjects()) {
    const t = getThread(p.id, id);
    if (t) return t;
  }
  return undefined;
}

export function createThread(projectId: string, agentId: string, extra: Partial<Thread> = {}): Thread {
  const now = Date.now();
  const t: Thread = { id: randomUUID(), projectId, title: 'New chat', agentId, createdAt: now, updatedAt: now, items: [], acpSessions: {}, ...extra };
  threadCache.set(t.id, t);
  saveThreadNow(t);
  return t;
}

/** How long a streaming chat waits before its file is written again (each write serializes the whole thread). */
const THREAD_SAVE_DEBOUNCE_MS = 1200;
/** Bumped by every write of a thread; an async write renames its temp file only if it is still the newest. */
const writeGen = new Map<string, number>();
/** Async writes of one thread run one after another, so renames land in order. */
const writeChain = new Map<string, Promise<void>>();

const bumpGen = (id: string) => {
  const g = (writeGen.get(id) ?? 0) + 1;
  writeGen.set(id, g);
  return g;
};

/**
 * Background save used while an agent streams: serializes once (synchronous; ~14 ms for an 11 MB chat), then
 * writes and renames via fs/promises so the multi-megabyte disk write no longer blocks the main process.
 */
function saveThreadAsync(t: Thread): void {
  const file = threadFile(t);
  const gen = bumpGen(t.id);
  const data = JSON.stringify(t);
  const prev = writeChain.get(t.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (writeGen.get(t.id) !== gen) return; // a newer write (async or sync) superseded this one
    const tmp = `${file}.${process.pid}.${gen}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, data, { mode: 0o600 });
      if (writeGen.get(t.id) === gen) await rename(tmp, file);
      else await unlink(tmp).catch(() => undefined);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      console.error(`[store] saving thread ${t.id} failed:`, e);
    }
  });
  writeChain.set(t.id, next);
  void next.finally(() => {
    if (writeChain.get(t.id) === next) writeChain.delete(t.id);
  });
}

export function saveThread(t: Thread): void {
  t.updatedAt = Date.now();
  clearTimeout(saveTimers.get(t.id));
  saveTimers.set(
    t.id,
    setTimeout(() => {
      saveTimers.delete(t.id);
      saveThreadAsync(t);
    }, THREAD_SAVE_DEBOUNCE_MS),
  );
}

/** Synchronous save (quit, fork, rename): always wins over any async write still in flight. */
export function saveThreadNow(t: Thread): void {
  clearTimeout(saveTimers.get(t.id));
  saveTimers.delete(t.id);
  bumpGen(t.id);
  writeJson(threadFile(t), t, false);
}

export function flushThreads(): void {
  // Pending debounced saves, plus async writes still in flight (the process may exit before they rename).
  for (const id of new Set([...saveTimers.keys(), ...writeChain.keys()])) {
    const t = threadCache.get(id);
    if (t) saveThreadNow(t);
  }
}

/** Told about every chat deleted anywhere in the main process (sidebar, delete_subsession, cleanup), once each. */
let threadDeleted: (t: ThreadMeta) => void = () => {};
export const onThreadDeleted = (fn: (t: ThreadMeta) => void) => (threadDeleted = fn);

export function deleteThread(t: Thread): void {
  const existed = threadCache.has(t.id) || existsSync(threadFile(t));
  threadCache.delete(t.id);
  clearTimeout(saveTimers.get(t.id));
  saveTimers.delete(t.id);
  bumpGen(t.id); // a pending async write must not bring the file back
  rmSync(threadFile(t), { force: true });
  removeChatMedia(sharedRoot(), t.id);
  if (existed) threadDeleted(threadMeta(t));
}

/**
 * Sub-session: a new chat that starts with a copy of the parent's messages up to `uptoItemId` (or all of
 * them). Its first agent session gets that history in the shared-context preamble, so any agent can continue.
 */
export function forkThread(parent: Thread, uptoItemId?: string): Thread {
  const end = uptoItemId ? parent.items.findIndex((i) => i.id === uptoItemId) : parent.items.length - 1;
  const items: ThreadItem[] = structuredClone(parent.items.slice(0, end + 1)).filter(
    (i: ThreadItem) => !((i.kind === 'permission' || i.kind === 'elicitation') && !i.resolved),
  );
  const base = parent.title.replace(/^↳ /, '');
  const child = createThread(parent.projectId, parent.agentId, {
    title: `↳ ${base}`.slice(0, 70),
    parentId: parent.id,
    mode: parent.mode,
    items: items.map((i) => ({ ...i, id: randomUUID() })),
  });
  // The copy gets its own media (images, audio the agent sent), so deleting either chat keeps the other's.
  const from = chatMediaDir(sharedRoot(), parent.id);
  if (existsSync(from)) {
    const to = chatMediaDir(sharedRoot(), child.id);
    try {
      cpSync(from, to, { recursive: true });
      const esc = (p: string) => JSON.stringify(p).slice(1, -1);
      child.items = JSON.parse(JSON.stringify(child.items).split(esc(from + sep)).join(esc(to + sep)));
      saveThread(child);
    } catch {
      /* the copy keeps pointing at the parent's media */
    }
  }
  return child;
}

/** Full-text search over every chat's title and messages. */
export function searchThreads(query: string, limit = 60): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const p of allProjects()) {
    for (const meta of listThreads(p.id)) {
      if (meta.nativeSubagent) continue;
      const t = getThread(p.id, meta.id);
      if (!t) continue;
      let snippet = '';
      if (t.title.toLowerCase().includes(q)) snippet = t.title;
      for (const i of t.items) {
        if (snippet && snippet !== t.title) break;
        const text = i.kind === 'user' || i.kind === 'agent' ? i.text : i.kind === 'tool' ? i.title : '';
        const at = text.toLowerCase().indexOf(q);
        if (at >= 0) snippet = `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + q.length + 80).replace(/\s+/g, ' ')}`;
      }
      if (snippet) hits.push({ threadId: t.id, projectId: p.id, projectName: p.name, title: t.title, agentId: t.agentId, snippet, updatedAt: t.updatedAt });
    }
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** Every chat in every project (and General), newest first, for Chat mode's Recents and Pinned lists. */
export function listAllThreads(): ThreadMeta[] {
  return allProjects()
    .flatMap((p) => listThreads(p.id))
    .filter((t) => !t.nativeSubagent)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function updateThreadMeta(id: string, patch: Partial<Pick<Thread, 'title' | 'pinned'>>): ThreadMeta | undefined {
  const t = findThread(id);
  if (!t) return undefined;
  Object.assign(t, patch);
  saveThreadNow(t);
  return threadMeta(t);
}
