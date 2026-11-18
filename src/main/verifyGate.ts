import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, VerifyGateConfig, VerifyRunResult } from '@shared/types';
import { detectTestCommand } from './testcmd';

/**
 * Verify Gate (Auto Done-Check): runs a project's verification command (typecheck / test / build) automatically
 * after a coding turn modifies files. Passes silently with a calm notice; on failure, sends the real error back
 * to the agent up to `maxRetries` (default 2) so broken turns self-heal without ever looping infinitely.
 */

export const DEFAULT_VERIFY_RETRIES = 2;
const VERIFY_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4500;

/** Consecutive auto-verify retry count per chat (reset on pass or when the user sends a fresh human message). */
const retries = new Map<string, number>();

export function resetVerifyRetries(threadId: string) {
  retries.delete(threadId);
}

export function getVerifyRetries(threadId: string): number {
  return retries.get(threadId) ?? 0;
}

/** Auto-detects a fast, reliable verification command from the project folder (`typecheck` > `check` > `test`). */
export function detectVerifyCommand(dir: string): string | null {
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const scripts = JSON.parse(readFileSync(pkgPath, 'utf8'))?.scripts ?? {};
      const pm = existsSync(join(dir, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(dir, 'yarn.lock'))
          ? 'yarn'
          : existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))
            ? 'bun'
            : 'npm';
      const run = (s: string) => (pm === 'yarn' ? `yarn ${s}` : `${pm} run ${s}`);
      for (const s of ['typecheck', 'check', 'verify']) {
        if (typeof scripts[s] === 'string' && scripts[s].trim()) return run(s);
      }
    } catch {
      /* fall through to detectTestCommand */
    }
  }
  return detectTestCommand(dir);
}

/** Resolves the effective command to execute for `project` (explicit override or auto-detected). */
export function effectiveVerifyCommand(project: Pick<Project, 'path' | 'verifyGate'>): string | null {
  const custom = project.verifyGate?.command?.trim();
  if (custom) return custom;
  return detectVerifyCommand(project.path);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;

/** Executes `command` inside `cwd` using `shell` and returns structured pass/fail + truncated output. */
export function runVerifyCommand(
  cwd: string,
  command: string,
  opts: { shell?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<VerifyRunResult> {
  const sh = opts.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      sh,
      args,
      { cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? VERIFY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const combined = `${stdout ?? ''}${stdout && stderr ? '\n' : ''}${stderr ?? ''}`.replace(ANSI_RE, '').trim();
        const output =
          combined.length > MAX_OUTPUT_CHARS
            ? `… (${combined.length - MAX_OUTPUT_CHARS} earlier characters omitted)\n${combined.slice(-MAX_OUTPUT_CHARS)}`
            : combined;
        if (!err) {
          resolve({ ok: true, command, exitCode: 0, durationMs, output });
          return;
        }
        const rawCode = typeof (err as any).code === 'number' ? (err as any).code : (err as any).killed ? 124 : 1;
        resolve({ ok: false, command, exitCode: rawCode, durationMs, output: output || err.message });
      },
    );
  });
}

export interface PostTurnVerifyOutcome {
  action: 'skipped' | 'passed' | 'retry' | 'exhausted';
  result?: VerifyRunResult;
  attempt?: number;
  maxRetries?: number;
  prompt?: string;
}

/**
 * Evaluates and runs the Verify Gate after a turn changed `changedFilesCount` files.
 * Enforces loop-cap (`maxRetries`) so a failing test suite never triggers an unbounded agent loop.
 */
export async function evaluateTurnVerifyGate(params: {
  threadId: string;
  project: Pick<Project, 'path' | 'verifyGate'>;
  changedFilesCount: number;
  muted: boolean;
  isReadOnlyRole: boolean;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PostTurnVerifyOutcome> {
  const cfg: VerifyGateConfig | undefined = params.project.verifyGate;
  if (!cfg?.enabled || params.changedFilesCount <= 0 || params.muted || params.isReadOnlyRole) {
    return { action: 'skipped' };
  }
  const cmd = effectiveVerifyCommand(params.project);
  if (!cmd) return { action: 'skipped' };

  const maxRetries = Math.max(1, Math.min(5, cfg.maxRetries ?? DEFAULT_VERIFY_RETRIES));
  const result = await runVerifyCommand(params.project.path, cmd, { shell: params.shell, env: params.env });
  if (result.ok) {
    retries.delete(params.threadId);
    return { action: 'passed', result };
  }

  const used = retries.get(params.threadId) ?? 0;
  if (used >= maxRetries) {
    return { action: 'exhausted', result, attempt: used, maxRetries };
  }

  const attempt = used + 1;
  retries.set(params.threadId, attempt);
  const prompt = [
    `[Olympus Coder] Verify gate failed after your changes (\`$ ${cmd}\`, exit ${result.exitCode}, attempt ${attempt}/${maxRetries}). Fix the issue so the check passes:`,
    result.output ? `\`\`\`text\n${result.output}\n\`\`\`` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { action: 'retry', result, attempt, maxRetries, prompt };
}
