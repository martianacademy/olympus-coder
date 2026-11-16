import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A project folder was renamed or moved. Olympus keys a project's shared memory by the folder path
 * (<sharedRoot>/memory/<slug>) and Claude Code keys its own sessions the same way (~/.claude/projects/<slug>,
 * every character that is not a letter or digit becomes "-"). This points the project at its new folder and
 * keeps both working: the memory folder moves to the new slug with a symlink left at the old one, and Claude's
 * new slug becomes a symlink to the old folder so its earlier chats still resume. Chats, terminals, schedules and
 * checkpoints are keyed by the project id, so they follow on their own.
 *
 * Only node: imports, so scripts/relocate-project.mjs can run this while the app is closed.
 */

export const pathSlug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

export interface RelocateInput {
  sharedRoot: string;
  home: string;
  oldPath: string;
  newPath: string;
  /** Which project to update; by default the one whose path is `oldPath`. */
  projectId?: string;
  /** Only report what would happen. */
  dryRun?: boolean;
}

export interface RelocateResult {
  project?: { id: string; name: string; path: string };
  /** What happened, one line each. */
  steps: string[];
}

interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: number;
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const exists = (p: string) => existsSync(p) || isLink(p);

function writeJsonAtomic(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function relocateOnDisk(input: RelocateInput): RelocateResult {
  const oldPath = resolve(input.oldPath);
  const newPath = resolve(input.newPath);
  const dry = Boolean(input.dryRun);
  const steps: string[] = [];
  if (oldPath === newPath) throw new Error('The new folder is the same as the old one.');
  let isDir = false;
  try {
    isDir = statSync(newPath).isDirectory();
  } catch {
    /* missing */
  }
  if (!isDir) throw new Error(`Folder not found: ${newPath}`);

  // 1. projects.json
  const projectsFile = join(input.sharedRoot, 'projects.json');
  let all: ProjectRecord[] = [];
  try {
    all = JSON.parse(readFileSync(projectsFile, 'utf8'));
  } catch {
    all = [];
  }
  const p = input.projectId ? all.find((x) => x.id === input.projectId) : all.find((x) => resolve(x.path) === oldPath);
  if (input.projectId && !p) throw new Error('Project not found.');
  let project: RelocateResult['project'];
  if (p) {
    const other = all.find((x) => x.id !== p.id && resolve(x.path) === newPath);
    if (other) throw new Error(`"${other.name}" already uses that folder.`);
    const name = p.name === basename(oldPath) ? basename(newPath) : p.name;
    project = { id: p.id, name, path: newPath };
    if (!dry) writeJsonAtomic(projectsFile, all.map((x) => (x.id === p.id ? { ...x, name, path: newPath } : x)));
    steps.push(`projects.json: "${p.name}" → ${newPath}${name !== p.name ? ` (renamed "${name}")` : ''}`);
  } else steps.push('projects.json: no project with that folder (memory and Claude sessions still relinked)');

  // 2. Shared memory: move to the new slug, leave a symlink at the old one.
  const memRoot = join(input.sharedRoot, 'memory');
  const oldMem = join(memRoot, pathSlug(oldPath));
  const newMem = join(memRoot, pathSlug(newPath));
  if (!existsSync(oldMem) || isLink(oldMem)) steps.push(`memory: nothing to move at ${oldMem}`);
  else if (!exists(newMem)) {
    if (!dry) {
      renameSync(oldMem, newMem);
      symlinkSync(pathSlug(newPath), oldMem);
    }
    steps.push(`memory: moved ${oldMem} → ${newMem} (symlink left at the old name)`);
  } else {
    // Both exist: add the old folder's files the new one lacks; the old folder stays as it is.
    if (!dry) cpSync(oldMem, newMem, { recursive: true, force: false, errorOnExist: false });
    steps.push(`memory: ${newMem} already existed; copied in the files it lacked, ${oldMem} left in place`);
  }

  // 3. Claude Code's sessions: new slug → old folder.
  const claudeRoot = join(input.home, '.claude', 'projects');
  const oldClaude = join(claudeRoot, pathSlug(oldPath));
  const newClaude = join(claudeRoot, pathSlug(newPath));
  if (!existsSync(oldClaude)) steps.push('claude: no Claude Code sessions for the old folder');
  else if (!exists(newClaude)) {
    if (!dry) symlinkSync(pathSlug(oldPath), newClaude);
    steps.push(`claude: ${newClaude} → ${pathSlug(oldPath)} (symlink)`);
  } else if (isLink(newClaude)) steps.push(`claude: ${newClaude} is already a symlink, left as it is`);
  else {
    let n = 0;
    for (const e of readdirSync(oldClaude)) {
      if (exists(join(newClaude, e))) continue;
      if (!dry) symlinkSync(join(oldClaude, e), join(newClaude, e));
      n++;
    }
    steps.push(`claude: ${newClaude} already existed; linked ${n} older session file(s) into it`);
  }
  return { project, steps };
}
