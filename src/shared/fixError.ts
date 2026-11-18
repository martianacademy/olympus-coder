/**
 * Pure diagnostic prompt builder for Olympus Coder's 1-click "Fix this error" action.
 * Combines the failure context (command, terminal, web preview, or chat error), cleaned output/stack trace,
 * optional uncommitted git diff summary, and optional page screenshot note without exceeding context limits.
 */

export interface FixErrorInput {
  source: 'command' | 'terminal' | 'tests' | 'web-console' | 'web-load' | 'chat-error';
  title: string;
  command?: string;
  exitCode?: number;
  output: string;
  /** Optional formatted list of failed test names (`- testName (file:line)`). */
  failedItems?: string[];
  /** Optional uncommitted `git status` + compact `git diff` summary for the project. */
  gitSummary?: string;
  /** True when a PNG screenshot of the web preview was attached alongside the prompt. */
  hasScreenshot?: boolean;
}

const MAX_OUTPUT_CHARS = 5000;
const MAX_DIFF_CHARS = 3500;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;

function cleanTail(raw: string, maxChars: number): string {
  const clean = raw.replace(ANSI_RE, '').trim();
  if (clean.length <= maxChars) return clean;
  return `… (${clean.length - maxChars} earlier characters omitted)\n${clean.slice(-maxChars)}`;
}

/** Builds a clear, structured prompt asking the coding agent to diagnose and fix the failure. */
export function buildFixErrorPrompt(input: FixErrorInput): string {
  const parts: string[] = [];
  const codeTag = input.exitCode !== undefined ? ` (exit ${input.exitCode})` : '';

  switch (input.source) {
    case 'command':
      parts.push(`This command failed${codeTag}. Diagnose the root cause and fix it:${input.command ? `\n\`$ ${input.command.trim()}\`` : ''}`);
      break;
    case 'terminal':
      parts.push(`This failed in terminal "${input.title}"${codeTag}. Find the cause and fix it.`);
      break;
    case 'tests':
      parts.push(`${input.title}. Find the root cause, fix it, and re-run the tests.`);
      break;
    case 'web-console':
      parts.push(`The page at ${input.title} logged console errors/warnings. Diagnose the root cause and fix them.`);
      break;
    case 'web-load':
      parts.push(`The local dev page at ${input.title} failed to load. Check why the server or route failed and fix it.`);
      break;
    case 'chat-error':
      parts.push(`Fix this error:`);
      break;
  }

  if (input.hasScreenshot) {
    parts.push(`A screenshot of the current page is attached.`);
  }

  if (input.failedItems?.length) {
    parts.push(input.failedItems.slice(0, 20).join('\n'));
  }

  const out = cleanTail(input.output, MAX_OUTPUT_CHARS);
  if (out) {
    parts.push(`\`\`\`text\n${out}\n\`\`\``);
  }

  const diff = (input.gitSummary ?? '').trim();
  if (diff) {
    const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
    parts.push(`Uncommitted git changes in this project:\n\`\`\`diff\n${clipped}\n\`\`\``);
  }

  return parts.join('\n\n');
}
