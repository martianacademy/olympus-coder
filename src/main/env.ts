import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * When the host's first `node` on PATH is missing, crashes (e.g. a broken Homebrew dylib link aborting with
 * SIGABRT), or is older than npm/npx requires (< 20.17), `npx`-based ACP agents fail immediately. Inside Electron
 * we create a tiny shim directory whose `node` invokes Electron's own built-in Node 24 (`ELECTRON_RUN_AS_NODE=1`)
 * and prepend it to PATH so `npx` and every `#!/usr/bin/env node` CLI agent work reliably.
 */
let nodeShimExe: string | null = null;

function isHealthyNode(nodeBin: string | null): boolean {
  if (!nodeBin) return false;
  try {
    const r = spawnSync(
      nodeBin,
      ['-e', 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=9)||(M===20&&m>=17)?0:1)'],
      { timeout: 3000, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
    );
    return r.status === 0 && !r.signal;
  } catch {
    return false;
  }
}

export function ensureHealthyNodeShim(): string | null {
  if (nodeShimExe && existsSync(nodeShimExe)) return nodeShimExe;
  if (isHealthyNode(which('node'))) return null;
  if (!process.versions.electron) return null;
  try {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    const dir = join(tmpdir(), `olympus-node-shim-${uid}`);
    mkdirSync(dir, { recursive: true });
    const preload = join(dir, 'preload.cjs');
    writeFileSync(preload, 'delete process.env.ELECTRON_RUN_AS_NODE;\n', { mode: 0o644 });
    if (process.platform === 'win32') {
      const cmd = join(dir, 'node.cmd');
      writeFileSync(cmd, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" --require "${preload}" %*\r\n`);
      nodeShimExe = cmd;
    } else {
      const sh = join(dir, 'node');
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      writeFileSync(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} --require ${q(preload)} "$@"\n`, { mode: 0o755 });
      chmodSync(sh, 0o755);
      nodeShimExe = sh;
    }
    const parts = (process.env.PATH || '').split(delimiter).filter((p) => p && p !== dir);
    process.env.PATH = [dir, ...parts].join(delimiter);
    return nodeShimExe;
  } catch {
    return null;
  }
}

/**
 * Apps started from Finder get a minimal PATH, so `agy`, `codex`, `node` (nvm) etc. are not found.
 * Read PATH from the user's login shell once at startup, then verify a working `node` is in front for `npx` agents.
 */
export function loadLoginShellPath(): void {
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    try {
      const r = spawnSync(shell, ['-ilc', 'printf "__AGENTDESK__%s__AGENTDESK__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 8000,
      });
      const m = /__AGENTDESK__(.*)__AGENTDESK__/s.exec(r.stdout || '');
      const fromShell = m?.[1]?.split(delimiter).filter(Boolean) ?? [];
      const current = (process.env.PATH || '').split(delimiter).filter(Boolean);
      const extra = [join(process.env.HOME || '', '.olympus/bin'), join(process.env.HOME || '', '.agents/bin'), join(process.env.HOME || '', '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
      process.env.PATH = [...new Set([...fromShell, ...current, ...extra])].join(delimiter);
    } catch {
      /* keep the current PATH */
    }
  } else {
    // A running Windows app never sees PATH changes made by installers after it started. Add the folders Claude
    // Code's native installer and npm's global shims use, so a CLI installed later is found by Settings → Check.
    const home = process.env.USERPROFILE || '';
    const extra = [join(home, '.local', 'bin'), process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '', join(home, '.olympus', 'bin')].filter(Boolean);
    const current = (process.env.PATH || '').split(delimiter).filter(Boolean);
    const seen = new Set(current.map((p) => p.toLowerCase()));
    process.env.PATH = [...current, ...extra.filter((p) => !seen.has(p.toLowerCase()))].join(delimiter);
  }
  ensureHealthyNodeShim();
}

/** Finds a program on PATH. On Windows also tries PATHEXT (.exe, .cmd, …), so `agy` finds `agy.exe` or `agy.cmd`. */
export function which(bin: string): string | null {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : null;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Windows can't start .cmd / .bat files directly (npm-installed CLIs are usually .cmd shims): run them
 * through cmd.exe. On POSIX, when the host `node` is broken and our Electron Node shim is active, run `npx` / `npm`
 * scripts directly through the shim so even hardcoded shebangs cannot hit a broken system `node`.
 */
export function spawnable(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  if (process.platform !== 'win32' && nodeShimExe && /(?:^|\/)(npx|npm)$/.test(command)) {
    const resolved = which(command) ?? command;
    if (existsSync(resolved)) return { command: nodeShimExe, args: [resolved, ...args] };
  }
  return { command, args };
}

/** The user's interactive shell for the terminal panel. */
export function userShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = which('pwsh') ?? which('powershell');
    return pwsh ? { command: pwsh, args: ['-NoLogo'] } : { command: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  return { command: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

/**
 * Environment for agent processes. Variables a host app (for example another Claude Code session that
 * launched this app during development) may have injected are removed, so each agent uses its own login.
 */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  ensureHealthyNodeShim();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^CLAUDE/.test(k) || k === 'ANTHROPIC_BASE_URL' || k === 'ELECTRON_RUN_AS_NODE') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
