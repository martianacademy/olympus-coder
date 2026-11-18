/**
 * Pure unified-diff hunk parser for Turn Review (per-hunk revert and re-apply).
 * Splits a `git diff` for one file into its file header lines and self-contained single-hunk patches.
 */

export interface DiffHunk {
  index: number;
  header: string;
  lines: string[];
  added: number;
  removed: number;
  /** Valid standalone unified-diff patch for this single hunk (`headerLines` + `header` + `lines` + trailing `\n`). */
  patch: string;
}

export interface ParsedFileDiff {
  headerLines: string[];
  hunks: DiffHunk[];
}

export function parseDiffHunks(diffText: string): ParsedFileDiff {
  const normalized = diffText.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return { headerLines: [], hunks: [] };

  const rawLines = normalized.split('\n');
  // Drop trailing empty element caused by trailing newline so we re-append cleanly per hunk.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const headerLines: string[] = [];
  const rawHunks: { header: string; lines: string[] }[] = [];
  let current: { header: string; lines: string[] } | null = null;

  for (const line of rawLines) {
    if (line.startsWith('@@ ')) {
      current = { header: line, lines: [] };
      rawHunks.push(current);
      continue;
    }
    if (!current) {
      headerLines.push(line);
    } else {
      current.lines.push(line);
    }
  }

  const hunks: DiffHunk[] = rawHunks.map((h, index) => {
    let added = 0;
    let removed = 0;
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
    const patch = `${[...headerLines, h.header, ...h.lines].join('\n')}\n`;
    return { index, header: h.header, lines: h.lines, added, removed, patch };
  });

  return { headerLines, hunks };
}
