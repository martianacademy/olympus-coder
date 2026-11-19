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

/**
 * Escapes every single `$` that cannot be one end of an inline-math pair (outside code and `$$` blocks).
 *
 * The text is read left to right the way remark does: whatever opens first wins. A code span that opens first keeps
 * its `$` as written; a `$` that opens first is closed by the next single `$` on its line even when that one comes
 * after or inside a code span (remark-math skips over backticks). So "($0.40 … `oly` … ($0 cost)" used to slip
 * through when the text was cut at the code span and each piece held one "lone" `$`.
 */
export function escapeMoney(text: string): string {
  const escape = new Set<number>();
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2; // an escaped character (`\$`, `\``) is plain text
      continue;
    }
    if (c === '`') {
      CODE.lastIndex = i;
      const m = CODE.exec(text);
      i = m ? CODE.lastIndex : i + runLength(text, i, '`');
      continue;
    }
    if (c !== '$') {
      i++;
      continue;
    }
    if (text[i + 1] === '$') {
      DISPLAY.lastIndex = i;
      i = DISPLAY.exec(text) ? DISPLAY.lastIndex : i + runLength(text, i, '$'); // `$$` is not ours to judge
      continue;
    }
    const close = nextDollar(text, i + 1);
    // A lone `$` never becomes math, so it is left exactly as written.
    if (close < 0) {
      i++;
      continue;
    }
    const isMath =
      !isSpace(text[i + 1]) && !isSpace(text[close - 1]) && !isDigit(text[close + 1]) && !text.slice(i, close).includes('`');
    if (isMath) i = close + 1;
    else {
      escape.add(i);
      i++;
    }
  }
  if (escape.size === 0) return text;
  let out = '';
  let last = 0;
  for (const at of [...escape].sort((a, b) => a - b)) {
    out += `${text.slice(last, at)}\\$`;
    last = at + 1;
  }
  return out + text.slice(last);
}

/** A code span: a run of backticks, then the same run (not longer) later on. */
const CODE = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/y;
/** A `$$…$$` block. */
const DISPLAY = /\$\$[\s\S]*?\$\$/y;

const runLength = (text: string, i: number, ch: string): number => {
  let n = 0;
  while (text[i + n] === ch) n++;
  return n;
};

/** Where remark-math would close a single `$` opened before `from`: the next unescaped single `$` on the line. */
function nextDollar(text: string, from: number): number {
  for (let j = from; j < text.length && text[j] !== '\n'; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '$') {
      if (text[j + 1] !== '$') return j;
      j += runLength(text, j, '$') - 1; // a `$$` run cannot close a single `$`
    }
  }
  return -1;
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
