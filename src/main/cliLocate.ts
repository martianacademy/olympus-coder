/**
 * Finds a coding CLI the user installed themselves (Claude Code, Codex) as a binary the ACP adapters can spawn.
 * Pure: the caller passes what `which()` found and the environment, so this is unit-testable on any OS.
 *
 * Windows needs care: adapters spawn the CLI directly, and a `.cmd`/`.ps1`/sh shim cannot be spawned that way.
 * npm's global shims sit next to `node_modules`, where the package's real `.exe` lives
 * (`@anthropic-ai/claude-code` declares `bin/claude.exe`).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CliSpec {
  bin: string;
  /** Folders a native installer uses, checked even before they reach PATH. */
  dirs?: string[];
  /** Path of the real executable inside the npm package, below `node_modules` (Windows npm installs). */
  npmExe?: string[];
}

/** Every place the CLI may be, best first (PATH hit, npm package behind a Windows shim, installer folders). */
export function cliCandidates(spec: CliSpec, found: string | null, platform: NodeJS.Platform, env: { APPDATA?: string } = {}): string[] {
  const exe = platform === 'win32' ? `${spec.bin}.exe` : spec.bin;
  const out: string[] = [];
  if (found) out.push(found);
  if (platform === 'win32' && spec.npmExe) {
    if (found) out.push(join(dirname(found), 'node_modules', ...spec.npmExe));
    if (env.APPDATA) out.push(join(env.APPDATA, 'npm', 'node_modules', ...spec.npmExe));
  }
  for (const d of spec.dirs ?? []) out.push(join(d, exe));
  return out;
}

/** The first candidate that exists and can be spawned directly (Windows: only a real `.exe`). */
export function pickCli(candidates: string[], platform: NodeJS.Platform, exists: (p: string) => boolean = existsSync): string | null {
  for (const p of candidates) {
    if (!p || !exists(p)) continue;
    if (platform === 'win32' && !/\.exe$/i.test(p)) continue;
    return p;
  }
  return null;
}
