import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One-time move of the shared folder from the old default ~/.agents to ~/.olympus.
 *
 * ~/.agents is also the folder of the third-party `npx skills` tool (its `.skill-lock.json` and the skills it
 * installs), so only Olympus's own items are copied, and ~/.agents itself is never changed: old absolute paths
 * keep working. Copies go to a staging folder inside ~/.olympus first (APFS clones on macOS, so the agent
 * binaries cost no time or space); paths are rewritten there; only when every copy succeeded are the items
 * moved into place, without overwriting anything ~/.olympus already has. A failure removes the staging folder
 * and keeps the old root, so the next launch tries again from scratch.
 *
 * No Electron imports: the unit tests run this on a scratch HOME.
 */

export const LEGACY_DIR = '.agents';
export const OLYMPUS_DIR = '.olympus';
export const MIGRATION_MARKER = '.migrated-from-agents.json';
const STAGING = '.migrating-from-agents';

/** Files and folders in ~/.agents that belong to Olympus Coder. */
export const OWN_ITEMS = ['projects.json', 'threads', 'memory', 'attachments', 'usage', 'user', 'agents', 'workspace', 'skills', 'registry-cache.json'];

export const legacySharedRoot = (home: string) => join(home, LEGACY_DIR);

/** The default shared folder: OLYMPUS_HOME, then the older AGENTDESK_SHARED_ROOT, then ~/.olympus. */
export function defaultSharedRoot(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.OLYMPUS_HOME || env.AGENTDESK_SHARED_ROOT || join(home, OLYMPUS_DIR);
}

export interface MigrationResult {
  ran: boolean;
  /** Why nothing happened: 'override' | 'not-legacy' | 'done-before' | 'no-legacy-folder'. */
  skipped?: string;
  from?: string;
  to?: string;
  copied: string[];
  /** Items left alone because ~/.olympus already had them (their missing files were still added). */
  merged: string[];
  /** `npx skills` skills not copied (listed in ~/.agents/.skill-lock.json). */
  thirdPartySkills: string[];
  threadFilesRewritten: number;
  customAgentsRewritten: number;
  error?: string;
}

interface CustomAgentLike {
  command?: string;
  args?: string[];
}

export interface MigrationInput<A extends CustomAgentLike> {
  home: string;
  env?: NodeJS.ProcessEnv;
  /** The saved settings.json values (not merged with defaults). */
  saved: { sharedRoot?: string; customAgents?: A[] };
  /** Saves the new root (and rewritten custom agents); called before the marker is written. */
  save: (patch: { sharedRoot: string; customAgents?: A[] }) => void;
  log?: (line: string) => void;
  /** Tests: fail on this item to check that a partial copy keeps the old root. */
  failOn?: string;
}

const trimSlash = (p: string) => p.replace(/\/+$/, '');
/** A path as it appears inside a JSON string. */
const jsonEsc = (p: string) => JSON.stringify(p).slice(1, -1);

/** Copies a file or folder tree (symlinks stay symlinks). APFS clone on macOS; plain copy elsewhere or on error. */
function cloneTree(from: string, to: string) {
  if (process.platform === 'darwin') {
    try {
      execFileSync('/bin/cp', ['-cR', from, to], { stdio: 'pipe' });
      return;
    } catch {
      rmSync(to, { recursive: true, force: true });
    }
  }
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
}

/** Moves `from` into `to` without overwriting: missing entries are renamed in, existing ones are kept. */
function mergeInto(from: string, to: string) {
  if (!existsSync(to) && !isLink(to)) {
    renameSync(from, to);
    return;
  }
  const st = lstatSync(from);
  if (!st.isDirectory() || !lstatSync(to).isDirectory()) return; // both exist and are not two folders: keep theirs
  for (const name of readdirSync(from)) mergeInto(join(from, name), join(to, name));
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

function npxSkillNames(legacy: string): Set<string> {
  try {
    const lock = JSON.parse(readFileSync(join(legacy, '.skill-lock.json'), 'utf8'));
    return new Set(Object.keys(lock?.skills ?? {}));
  } catch {
    return new Set();
  }
}

/** Rewrites `<old>/attachments/` to `<new>/attachments/` in every chat file under `dir`. */
function rewriteThreads(dir: string, oldRoot: string, newRoot: string): number {
  if (!existsSync(dir)) return 0;
  const from = jsonEsc(join(oldRoot, 'attachments') + '/');
  const to = jsonEsc(join(newRoot, 'attachments') + '/');
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.json')) {
        const text = readFileSync(p, 'utf8');
        if (!text.includes(from)) continue;
        // A fresh file (not a write into the clone's shared blocks): the original in ~/.agents stays as it was.
        const tmp = `${p}.rewrite.tmp`;
        writeFileSync(tmp, text.split(from).join(to), { mode: 0o600 });
        renameSync(tmp, p);
        n++;
      }
    }
  };
  walk(dir);
  return n;
}

/** Custom agents whose command or args point into the old root get the same path under the new one. */
export function rewriteAgentPaths<A extends CustomAgentLike>(agents: A[], oldRoot: string, newRoot: string): { agents: A[]; changed: number } {
  const prefix = trimSlash(oldRoot) + '/';
  const fix = (s: string) => (s.startsWith(prefix) ? trimSlash(newRoot) + '/' + s.slice(prefix.length) : s);
  let changed = 0;
  const out = agents.map((a) => {
    const command = typeof a.command === 'string' ? fix(a.command) : a.command;
    const args = Array.isArray(a.args) ? a.args.map((x) => (typeof x === 'string' ? fix(x) : x)) : a.args;
    if (command === a.command && JSON.stringify(args) === JSON.stringify(a.args)) return a;
    changed++;
    return { ...a, command, args };
  });
  return { agents: out, changed };
}

export function migrateLegacySharedRoot<A extends CustomAgentLike>(input: MigrationInput<A>): MigrationResult {
  const env = input.env ?? process.env;
  const log = input.log ?? ((l: string) => console.log(`[migrate] ${l}`));
  const result: MigrationResult = { ran: false, copied: [], merged: [], thirdPartySkills: [], threadFilesRewritten: 0, customAgentsRewritten: 0 };
  if (env.OLYMPUS_HOME || env.AGENTDESK_SHARED_ROOT) return { ...result, skipped: 'override' };
  const legacy = legacySharedRoot(input.home);
  const target = join(input.home, OLYMPUS_DIR);
  if (!input.saved.sharedRoot || trimSlash(input.saved.sharedRoot) !== legacy) return { ...result, skipped: 'not-legacy' };
  if (existsSync(join(target, MIGRATION_MARKER))) return { ...result, skipped: 'done-before' };
  if (!existsSync(legacy)) return { ...result, skipped: 'no-legacy-folder' };

  result.from = legacy;
  result.to = target;
  const staging = join(target, STAGING);
  /** Items this run created in ~/.olympus (removed again if a later step fails). */
  const placed: string[] = [];
  try {
    // A staging folder left by a crash is stale: start over from the current ~/.agents.
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const npx = npxSkillNames(legacy);
    for (const item of OWN_ITEMS) {
      const from = join(legacy, item);
      if (!existsSync(from)) continue;
      if (input.failOn === item) throw new Error(`test failure on ${item}`);
      if (item === 'skills') {
        // Only Olympus's own skills: never `.skill-lock.json`, dot files, or what `npx skills` installed.
        mkdirSync(join(staging, 'skills'));
        for (const name of readdirSync(from)) {
          if (name.startsWith('.')) continue;
          if (npx.has(name)) {
            result.thirdPartySkills.push(name);
            continue;
          }
          cloneTree(join(from, name), join(staging, 'skills', name));
        }
      } else cloneTree(from, join(staging, item));
      result.copied.push(item);
    }
    result.threadFilesRewritten = rewriteThreads(join(staging, 'threads'), legacy, target);
    // Everything copied: move into place without overwriting what ~/.olympus already has.
    for (const item of result.copied) {
      const to = join(target, item);
      if (existsSync(to) || isLink(to)) result.merged.push(item);
      else placed.push(to);
      mergeInto(join(staging, item), to);
    }
    rmSync(staging, { recursive: true, force: true });

    const rewritten = rewriteAgentPaths(input.saved.customAgents ?? [], legacy, target);
    result.customAgentsRewritten = rewritten.changed;
    input.save({ sharedRoot: target, ...(rewritten.changed ? { customAgents: rewritten.agents } : {}) });
    result.ran = true;
  } catch (e: any) {
    rmSync(staging, { recursive: true, force: true });
    for (const p of placed) rmSync(p, { recursive: true, force: true });
    result.error = String(e?.message ?? e);
    log(`moving the shared folder to ${target} failed, staying on ${legacy} (will retry next launch): ${result.error}`);
    return result;
  }
  // The switch is saved; the marker only stops a second run.
  try {
    writeFileSync(
      join(target, MIGRATION_MARKER),
      JSON.stringify({ at: new Date().toISOString(), from: legacy, to: target, copied: result.copied, merged: result.merged, thirdPartySkillsLeft: result.thirdPartySkills.length, threadFilesRewritten: result.threadFilesRewritten, customAgentsRewritten: result.customAgentsRewritten }, null, 2),
    );
  } catch (e: any) {
    log(`could not write ${MIGRATION_MARKER}: ${e?.message ?? e}`);
  }
  log(`moved the shared folder ${legacy} → ${target}: copied ${result.copied.join(', ') || 'nothing'}${result.merged.length ? ` (kept existing: ${result.merged.join(', ')})` : ''}; left ${result.thirdPartySkills.length} npx-skills skills; rewrote ${result.threadFilesRewritten} chat files and ${result.customAgentsRewritten} custom agents. ${legacy} is unchanged.`);
  return result;
}
