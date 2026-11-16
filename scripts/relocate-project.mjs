#!/usr/bin/env node
// Points an Olympus Coder project at its renamed or moved folder while the app is closed: updates projects.json,
// moves the shared memory folder to the new path's slug (symlink left at the old one) and links Claude Code's
// ~/.claude/projects/<new slug> to the old one so earlier Claude chats still resume. Same code as the app's
// "Folder not found → Locate…" (src/main/relocate.ts).
//
// Move the folder first, then run:
//   node scripts/relocate-project.mjs <oldPath> <newPath> [--dry-run] [--shared-root <dir>] [--user-data <dir>]
// The shared root is --shared-root, else OLYMPUS_HOME / AGENTDESK_SHARED_ROOT, else `sharedRoot` from the app's
// settings.json (--user-data, default the app's userData folder), else ~/.olympus.
// Needs Node ≥ 23 (runs the TypeScript file directly).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { relocateOnDisk } = await import(join(APP, 'src/main/relocate.ts'));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const dryRun = args.includes('--dry-run');
if (dryRun) args.splice(args.indexOf('--dry-run'), 1);
const sharedFlag = flag('--shared-root');
const userData = flag('--user-data') ?? defaultUserData();
const [oldPath, newPath] = args;
if (!oldPath || !newPath) {
  console.error('Usage: node scripts/relocate-project.mjs <oldPath> <newPath> [--dry-run] [--shared-root <dir>] [--user-data <dir>]');
  process.exit(2);
}

function defaultUserData() {
  const name = 'Olympus Coder';
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), name);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name);
}

function sharedRoot() {
  if (sharedFlag) return sharedFlag;
  if (process.env.OLYMPUS_HOME || process.env.AGENTDESK_SHARED_ROOT) return process.env.OLYMPUS_HOME || process.env.AGENTDESK_SHARED_ROOT;
  const file = join(userData, 'settings.json');
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof s.sharedRoot === 'string' && s.sharedRoot) return s.sharedRoot;
    } catch {
      /* fall through */
    }
  }
  return join(homedir(), '.olympus');
}

const root = sharedRoot();
try {
  const r = relocateOnDisk({ sharedRoot: root, home: homedir(), oldPath, newPath, dryRun });
  console.log(`${dryRun ? '[dry run] ' : ''}shared root: ${root}`);
  for (const s of r.steps) console.log(`- ${s}`);
  process.exit(0);
} catch (e) {
  console.error(`relocate failed: ${e?.message ?? e}`);
  process.exit(1);
}
