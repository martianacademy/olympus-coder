/**
 * Markdown math clean-up before remark-math sees the text.
 *
 * 1. Agents write math in several ways; remark-math only treats a `$$` block on its own lines as display math.
 *    A line that is just `$$…$$` becomes a display block, and `\[…\]` / `\(…\)` become `$$…$$` / `$…$`.
 * 2. Money is not math. remark-math pairs any two single `$` on a line, so "8 GB, $0.05/hr) … ($0.09/hr)" turned
 *    the words between the prices into italic KaTeX. We use Pandoc's rule for inline math: the opening `$` must be
 *    followed by a non-space, the closing `$` (the next one, as remark-math pairs neighbours) must follow a
 *    non-space and must not be followed by a digit. A `$` that does not form such a pair is escaped (`\$`) so it
 *    shows as a plain dollar sign.
 *
 * Fenced code (also indented or still open while streaming), inline code and `$$…$$` blocks are left alone.
 */

/** A fenced code block, closed or (while streaming) open until the end of the text. */
const FENCE = /(^[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$|[\s\S]*$))/m;
/** Display math and inline code spans: nothing inside them is touched. */
const PROTECTED = /\$\$[\s\S]*?\$\$|(`+)[\s\S]*?\1/g;

export function normalizeMath(md: string): string {
  if (!md.includes('$') && !/\\\[|\\\(/.test(md)) return md;
  return md
    .split(FENCE)
    .map((part, i) => (i % 2 === 1 ? part : normalizeProse(part)))
    .join('');
}

function normalizeProse(text: string): string {
  let s = text;
  if (/\$\$|\\\[|\\\(/.test(s)) {
    s = s
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)
      .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, body: string) => `$$\n${body.trim()}\n$$`);
  }
  return s.includes('$') ? escapeMoney(s) : s;
}

/** Escapes every single `$` that cannot be one end of an inline-math pair (outside code and `$$` blocks). */
export function escapeMoney(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    out += escapeLines(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapeLines(text.slice(last));
}

function escapeLines(text: string): string {
  return text.includes('$') ? text.split('\n').map(escapeLine).join('\n') : text;
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

function isEscaped(line: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

function escapeLine(line: string): string {
  const dollars: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '$') continue;
    if (line[i + 1] === '$') {
      i++; // `$$` is not ours to judge
      continue;
    }
    if (!isEscaped(line, i)) dollars.push(i);
  }
  // A lone `$` never becomes math, so it is left exactly as written.
  if (dollars.length < 2) return line;

  // remark-math always pairs a `$` with the very next one, so only that one can close it.
  const escape = new Set<number>();
  let k = 0;
  while (k < dollars.length) {
    const open = dollars[k];
    const close = dollars[k + 1];
    if (close !== undefined && !isSpace(line[open + 1]) && !isSpace(line[close - 1]) && !isDigit(line[close + 1])) {
      k += 2;
    } else {
      escape.add(open);
      k++;
    }
  }
  if (escape.size === 0) return line;
  let out = '';
  for (let i = 0; i < line.length; i++) out += escape.has(i) ? '\\$' : line[i];
  return out;
}
