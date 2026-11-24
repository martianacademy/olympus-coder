/**
 * Pure multi-row wrapped URL extraction for xterm.js link providers.
 * Long OAuth URLs (e.g. GitHub Copilot's 300+ char authorize URL inside a narrow LoginDialog terminal)
 * wrap across several buffer rows (`line.isWrapped === true`). Rejoining the logical line before matching
 * ensures clicking anywhere on a wrapped URL opens the complete, unbroken address.
 */

export interface BufferLineLike {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedRow {
  /** 1-based buffer row number (xterm link range `y`). */
  y: number;
  text: string;
}

export interface TerminalUrlLink {
  url: string;
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  /** 0-based `[start, end)` column span on the queried `targetY` row (for skipping overlapping `fileRefs`). */
  targetSpan: [number, number];
}

const URL_RE = /https?:\/\/[^\s'"<>]+/g;

/** Collects the contiguous wrapped logical line containing 0-based `rowIndex`, capped at `maxSpan` rows. */
export function collectWrappedRows(
  getLine: (index: number) => BufferLineLike | undefined,
  rowIndex: number,
  maxSpan = 24,
): WrappedRow[] {
  const cur = getLine(rowIndex);
  if (!cur) return [];

  let start = rowIndex;
  while (start > 0 && rowIndex - start < maxSpan && getLine(start)?.isWrapped) {
    start--;
  }

  let end = rowIndex;
  while (end - start + 1 < maxSpan && getLine(end + 1)?.isWrapped) {
    end++;
  }

  const rows: WrappedRow[] = [];
  for (let i = start; i <= end; i++) {
    const line = getLine(i);
    if (!line) break;
    // Keep trailing spaces on wrapped non-final rows so offsets align with xterm columns.
    rows.push({ y: i + 1, text: line.translateToString(i === end) });
  }
  return rows;
}

/** Extracts full URLs across a wrapped logical line and returns those intersecting 1-based `targetY`. */
export function extractWrappedUrls(rows: WrappedRow[], targetY: number): TerminalUrlLink[] {
  if (!rows.length) return [];

  // Record each row's [startOffset, endOffset) in the concatenated logical string.
  const segments: { y: number; start: number; end: number }[] = [];
  let full = '';
  for (const row of rows) {
    const start = full.length;
    full += row.text;
    segments.push({ y: row.y, start, end: full.length });
  }

  const posAt = (offset: number): { x: number; y: number } => {
    for (const seg of segments) {
      if (offset >= seg.start && offset < seg.end) {
        return { x: offset - seg.start + 1, y: seg.y };
      }
    }
    const last = segments[segments.length - 1];
    return { x: Math.max(1, last.end - last.start), y: last.y };
  };

  const targetSeg = segments.find((s) => s.y === targetY);
  if (!targetSeg) return [];

  const out: TerminalUrlLink[] = [];
  for (const m of full.matchAll(URL_RE)) {
    const raw = m[0];
    const url = raw.replace(/[.,;)]+$/, '');
    if (!url) continue;
    const matchStart = m.index ?? 0;
    const matchEnd = matchStart + url.length; // exclusive
    // Only return links that touch the queried row.
    if (matchEnd <= targetSeg.start || matchStart >= targetSeg.end) continue;

    const colStart = Math.max(0, matchStart - targetSeg.start);
    const colEnd = Math.min(targetSeg.end - targetSeg.start, matchEnd - targetSeg.start);
    out.push({
      url,
      range: {
        start: posAt(matchStart),
        end: posAt(matchEnd - 1),
      },
      targetSpan: [colStart, colEnd],
    });
  }
  return out;
}
