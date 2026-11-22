/**
 * Display-only formatters for shell commands (`BASH` box) and stdout/stderr (`RESULT` box) in chat.
 *
 * Design invariants:
 * - Never mutate the stored `ThreadItem` or the raw command passed to `Run` / `Copy` on `BASH`.
 * - Quote-, escape-, subshell-, and heredoc-aware so embedded scripts (`python3 -c "..."`, `<<'EOF'`)
 *   are never split mid-string.
 * - Top-level splits (`cmd1 &&\ncmd2`, `cmd1\ncmd2`, `a |\n  b`) remain valid POSIX/Bash syntax if selected.
 */

// Matches ANSI CSI (`ESC [ ...`), OSC (`ESC ] ... BEL/ST`), and two-byte Fe escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

const HEREDOC_RE = /^<<(-?)[ \t]*(?:(['"])([A-Za-z0-9_.-]+)\2|\\?([A-Za-z0-9_.-]+))/;

const MAX_JSON_FORMAT_CHARS = 200_000;
const CHAIN_WRAP_THRESHOLD = 64;
const PIPE_WRAP_THRESHOLD = 88;

/**
 * Strips terminal ANSI escape codes and resolves `\r` carriage-return progress bar overwrites
 * so terminal output renders cleanly in a static box.
 */
export function cleanTerminalText(raw: string): string {
  if (!raw) return '';
  const withoutAnsi = raw.replace(/\r\n/g, '\n').replace(ANSI_ESCAPE_RE, '');
  if (!withoutAnsi.includes('\r')) return withoutAnsi;
  return withoutAnsi
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      // Keep the last non-empty overwrite segment (e.g. progress bars `0%\r100%`).
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].length > 0) return parts[i];
      }
      return '';
    })
    .join('\n');
}

/**
 * Formats a shell command for readable display inside the `BASH` step box:
 * - Splits top-level `;`, `&&`, and `||` chains onto separate lines when the command is compound/long.
 * - Wraps long top-level pipelines (` | `) onto indented continuation lines.
 * - Preserves quotes, escapes, `$(...)` / `(...)` / `{...}` groups, and `<<EOF` heredoc bodies verbatim.
 */
export function formatBashCommand(raw: string): string {
  const src = raw.replace(/\r\n/g, '\n').trim();
  if (!src) return '';

  const shouldWrapChains = src.length >= CHAIN_WRAP_THRESHOLD || src.includes('\n');
  const out: string[] = [];
  let lineLen = 0;

  let quote: "'" | '"' | '`' | null = null;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inComment = false;
  let pendingHeredocs: { end: string; stripTabs: boolean }[] = [];
  let inHeredocBody = false;

  const push = (s: string) => {
    out.push(s);
    const nl = s.lastIndexOf('\n');
    lineLen = nl >= 0 ? s.length - nl - 1 : lineLen + s.length;
  };

  const trimTrailingHorizontalSpace = () => {
    while (out.length > 0) {
      const last = out[out.length - 1];
      const trimmed = last.replace(/[ \t]+$/, '');
      if (trimmed === last) break;
      if (trimmed.length === 0) {
        out.pop();
      } else {
        out[out.length - 1] = trimmed;
        break;
      }
    }
  };

  let i = 0;
  while (i < src.length) {
    // Pass heredoc bodies through untouched line-by-line until every queued delimiter on that line closes.
    if (inHeredocBody) {
      const nlIdx = src.indexOf('\n', i);
      const rawLine = nlIdx >= 0 ? src.slice(i, nlIdx) : src.slice(i);
      const current = pendingHeredocs[0];
      const probe = current?.stripTabs ? rawLine.replace(/^\t+/, '') : rawLine;
      push(nlIdx >= 0 ? `${rawLine}\n` : rawLine);
      i = nlIdx >= 0 ? nlIdx + 1 : src.length;
      if (current && probe === current.end) {
        pendingHeredocs.shift();
        if (pendingHeredocs.length === 0) inHeredocBody = false;
      }
      continue;
    }

    const ch = src[i];
    const next = src[i + 1] ?? '';

    if (inComment) {
      push(ch);
      if (ch === '\n') {
        inComment = false;
        if (pendingHeredocs.length > 0) inHeredocBody = true;
      }
      i++;
      continue;
    }

    if (quote === "'") {
      push(ch);
      if (ch === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"' || quote === '`') {
      if (ch === '\\' && i + 1 < src.length) {
        push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      push(ch);
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    // Outside quotes: handle escapes first.
    if (ch === '\\' && i + 1 < src.length) {
      // Collapse explicit `\<newline><indent>` line continuations cleanly as-is.
      push(src.slice(i, i + 2));
      i += 2;
      continue;
    }

    // ANSI-C quoting `$'...'` supports backslash escapes inside single quotes.
    if (ch === '$' && next === "'") {
      push("$'");
      i += 2;
      while (i < src.length) {
        if (src[i] === '\\' && i + 1 < src.length) {
          push(src.slice(i, i + 2));
          i += 2;
          continue;
        }
        const c = src[i++];
        push(c);
        if (c === "'") break;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      push(ch);
      i++;
      continue;
    }

    if (ch === '#' && (i === 0 || /[ \t\n;&|()]/.test(src[i - 1]))) {
      inComment = true;
      push(ch);
      i++;
      continue;
    }

    if (ch === '\n') {
      trimTrailingHorizontalSpace();
      push('\n');
      if (pendingHeredocs.length > 0) inHeredocBody = true;
      i++;
      continue;
    }

    // Detect heredoc redirection (`<<EOF`, `<<'EOF'`, `<<-EOF`) so its body isn't parsed as shell operators.
    if (ch === '<' && next === '<' && src[i + 2] !== '<') {
      const m = HEREDOC_RE.exec(src.slice(i));
      if (m) {
        const delim = m[3] || m[4];
        if (delim) {
          pendingHeredocs.push({ end: delim, stripTabs: m[1] === '-' });
          push(m[0]);
          i += m[0].length;
          continue;
        }
      }
    }

    if (ch === '(') {
      parenDepth++;
      push(ch);
      i++;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      push(ch);
      i++;
      continue;
    }
    if (ch === '{' && (i === 0 || /[ \t\n;&|(]/.test(src[i - 1]))) {
      braceDepth++;
      push(ch);
      i++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      push(ch);
      i++;
      continue;
    }
    if (ch === '[' && next === '[') {
      bracketDepth++;
      push('[[');
      i += 2;
      continue;
    }
    if (ch === ']' && next === ']' && bracketDepth > 0) {
      bracketDepth--;
      push(']]');
      i += 2;
      continue;
    }

    const atTopLevel = parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && pendingHeredocs.length === 0;

    if (atTopLevel && shouldWrapChains) {
      // Top-level `;` followed by horizontal whitespace and another command (skip `;;` in `case`).
      if (ch === ';' && next !== ';' && (i === 0 || src[i - 1] !== ';')) {
        let j = i + 1;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
        if (j < src.length && src[j] !== '\n') {
          trimTrailingHorizontalSpace();
          push('\n');
          i = j;
          continue;
        }
      }

      // Top-level `&&` or `||` chain operator.
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        const op = ch + next;
        let j = i + 2;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
        if (j < src.length && src[j] !== '\n') {
          trimTrailingHorizontalSpace();
          push(` ${op}\n`);
          i = j;
          continue;
        }
      }

      // Long top-level pipeline (` | `), excluding `||` and `|&` without spaces.
      if (ch === '|' && next !== '|' && next !== '&' && lineLen >= PIPE_WRAP_THRESHOLD) {
        let j = i + 1;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
        if (j < src.length && src[j] !== '\n') {
          trimTrailingHorizontalSpace();
          push(' |\n  ');
          i = j;
          continue;
        }
      }
    }

    push(ch);
    i++;
  }

  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tryPrettyJsonBlock(candidate: string): string | null {
  const t = candidate.trim();
  if (t.length < 24 || t.length > MAX_JSON_FORMAT_CHARS) return null;
  const first = t[0];
  const last = t[t.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed) ? parsed.length < 2 : Object.keys(parsed).length < 2) return null;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

/**
 * Cleans and formats command stdout/stderr for display inside the `RESULT` box:
 * - Strips ANSI escape codes and resolves `\r` spinner/progress overwrites.
 * - Pretty-prints minified JSON payloads (either the whole output or individual long JSONL lines).
 * - Trims trailing horizontal whitespace and collapses excessive blank lines while preserving column indentation.
 */
export function formatCommandResult(raw: string): string {
  const cleaned = cleanTerminalText(raw).trimEnd();
  if (!cleaned.trim()) return '';

  // Whole-payload JSON object/array (e.g. curl API replies, JSON config dumps, jq -c).
  const wholeJson = tryPrettyJsonBlock(cleaned);
  if (wholeJson) return wholeJson;

  // Line-by-line pass: pretty-print embedded single-line JSON records while preserving normal text/tables.
  const lines = cleaned.split('\n');
  let formattedJsonLines = 0;
  const mapped = lines.map((line) => {
    const rtrimmed = line.replace(/[ \t]+$/, '');
    if (rtrimmed.length >= 36 && formattedJsonLines < 40) {
      const pretty = tryPrettyJsonBlock(rtrimmed);
      if (pretty) {
        formattedJsonLines++;
        return pretty;
      }
    }
    return rtrimmed;
  });

  return mapped
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * A command for a tooltip: its first line, at most `max` characters, and how many lines follow. A terminal
 * opened with a whole script (`python3 - <<'PY' …`) shows "cd … && python3 - <<'PY' … (+40 lines)", not the script.
 */
export function commandTip(command: string, max = 120): string {
  const lines = command.split('\n').filter((l) => l.trim());
  const first = (lines[0] ?? '').trim();
  const short = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return lines.length > 1 ? `${short} … (+${lines.length - 1} line${lines.length === 2 ? '' : 's'})` : short;
}
