/**
 * Image markup model shared by the annotation editor (`components/Annotator.tsx`), the PNG bake and the video
 * contact sheet. Pure: no React and no DOM beyond the 2D canvas drawing calls, so `tests/annotate.unit.mjs` runs it
 * in Node with a recording context.
 *
 * Marks are stored in IMAGE pixels (the original's natural size), never in screen pixels: the editor maps pointer
 * positions through `toImagePoint`, the screen draws them with a scale transform, and the bake draws them 1:1 on a
 * canvas the size of the original. Stroke widths, text and pins scale with the image (`unitFor`), so a mark looks
 * the same on screen and in the baked PNG at any display scale.
 */

export type Pt = [number, number];
export type ToolId = 'pen' | 'highlighter' | 'rect' | 'ellipse' | 'arrow' | 'shape' | 'text' | 'pin';
/** 0 = thin, 1 = medium, 2 = thick. */
export type WidthId = 0 | 1 | 2;

export interface Mark {
  kind: ToolId;
  color: string;
  width: WidthId;
  /** pen / highlighter / shape: the path; rect / ellipse / arrow: [start, end]; text / pin: [anchor]. */
  points: Pt[];
  /** Text marks: what the user typed. */
  text?: string;
  /** Pins: the number drawn in the pin (1, 2, 3 … in the order they were placed). */
  n?: number;
}

export const COLORS: { hex: string; name: string }[] = [
  { hex: '#ef4444', name: 'red' },
  { hex: '#f97316', name: 'orange' },
  { hex: '#facc15', name: 'yellow' },
  { hex: '#22c55e', name: 'green' },
  { hex: '#3b82f6', name: 'blue' },
  { hex: '#a855f7', name: 'purple' },
  { hex: '#ffffff', name: 'white' },
  { hex: '#111111', name: 'black' },
];

export const colorName = (hex: string) => COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
/** Light colours get dark ink for pin numbers and a dark halo for text. */
const isLight = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
};

/** One mark unit in image pixels: 1 px up to a 1000 px image, then growing with the longer side. */
export const unitFor = (w: number, h: number) => Math.max(1, Math.max(w, h) / 1000);
export const STROKE = [3, 6, 12] as const;
export const FONT = [22, 32, 48] as const;
export const PIN = [14, 18, 24] as const;

export const strokeWidth = (m: Pick<Mark, 'kind' | 'width'>, unit: number) => STROKE[m.width] * unit * (m.kind === 'highlighter' ? 3.5 : 1);
export const fontSize = (width: WidthId, unit: number) => FONT[width] * unit;
export const pinRadius = (width: WidthId, unit: number) => PIN[width] * unit;
export const TEXT_FONT = '600 {px}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const fontFor = (px: number) => TEXT_FONT.replace('{px}', String(Math.round(px * 100) / 100));

export const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
export const circled = (n: number) => CIRCLED[n] ?? `(${n})`;

/**
 * A pointer position (CSS px, e.g. `PointerEvent.clientX/Y`) → image pixels, for an image drawn into `rect` (its
 * on-screen box, any scale). Clamped to the image.
 */
export function toImagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, natW: number, natH: number): Pt {
  const x = ((clientX - rect.left) / rect.width) * natW;
  const y = ((clientY - rect.top) / rect.height) * natH;
  const r = (v: number) => Math.round(v * 10) / 10;
  return [r(Math.min(natW, Math.max(0, x))), r(Math.min(natH, Math.max(0, y)))];
}

/** Image pixels → CSS px inside the on-screen box (for placing the text field over the image). */
export function toScreenPoint(p: Pt, rect: { width: number; height: number }, natW: number, natH: number): Pt {
  return [(p[0] / natW) * rect.width, (p[1] / natH) * rect.height];
}

/** The largest box of the image's aspect that fits `maxW × maxH`, never upscaled past `maxScale`. */
export function fitSize(natW: number, natH: number, maxW: number, maxH: number, maxScale = 2): { w: number; h: number; scale: number } {
  const scale = Math.max(0.01, Math.min(maxW / natW, maxH / natH, maxScale));
  return { w: Math.round(natW * scale), h: Math.round(natH * scale), scale };
}

/** Minimal 2D context surface used by `drawMarks` (a real `CanvasRenderingContext2D` satisfies it). */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'rect'
  | 'ellipse'
  | 'arc'
  | 'stroke'
  | 'fill'
  | 'fillText'
  | 'strokeText'
> & {
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

function path(ctx: Ctx, pts: Pt[], close = false) {
  ctx.beginPath();
  if (!pts.length) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
  // Smooth freehand input: quadratic curves through the midpoints.
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  if (close) ctx.closePath();
}

/** Draws one mark in image pixels (`unit` from `unitFor(imageW, imageH)`). */
export function drawMark(ctx: Ctx, m: Mark, unit: number) {
  const sw = strokeWidth(m, unit);
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = sw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const [a, b] = [m.points[0], m.points[m.points.length - 1]];
  switch (m.kind) {
    case 'pen':
      path(ctx, m.points);
      ctx.stroke();
      break;
    case 'highlighter':
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'square';
      path(ctx, m.points);
      ctx.stroke();
      break;
    case 'shape':
      path(ctx, m.points, true);
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
      break;
    case 'rect': {
      if (!a || !b) break;
      ctx.beginPath();
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      if (!a || !b) break;
      ctx.beginPath();
      ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(0.5, Math.abs(b[0] - a[0]) / 2), Math.max(0.5, Math.abs(b[1] - a[1]) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arrow': {
      if (!a || !b) break;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const head = Math.min(Math.max(sw * 3.2, 12 * unit), len * 0.6 || sw * 3.2);
      // The shaft stops inside the head so its round cap does not poke through the tip.
      const sx = b[0] - Math.cos(ang) * head * 0.6;
      const sy = b[1] - Math.sin(ang) * head * 0.6;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - Math.cos(ang - 0.45) * head, b[1] - Math.sin(ang - 0.45) * head);
      ctx.lineTo(b[0] - Math.cos(ang + 0.45) * head, b[1] - Math.sin(ang + 0.45) * head);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'text': {
      if (!a || !m.text) break;
      const px = fontSize(m.width, unit);
      ctx.font = fontFor(px);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, px * 0.2);
      ctx.strokeStyle = isLight(m.color) ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
      m.text.split('\n').forEach((line, i) => {
        const y = a[1] + i * px * 1.22;
        ctx.strokeText(line, a[0], y);
        ctx.fillText(line, a[0], y);
      });
      break;
    }
    case 'pin': {
      if (!a) break;
      const r = pinRadius(m.width, unit);
      ctx.beginPath();
      ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.16);
      ctx.strokeStyle = isLight(m.color) ? 'rgba(0,0,0,0.7)' : '#ffffff';
      ctx.stroke();
      ctx.fillStyle = isLight(m.color) ? '#111111' : '#ffffff';
      ctx.font = fontFor(r * 1.1);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.n ?? 1), a[0], a[1] + r * 0.06);
      break;
    }
  }
  ctx.restore();
}

export function drawMarks(ctx: Ctx, marks: readonly Mark[], unit: number) {
  for (const m of marks) drawMark(ctx, m, unit);
}

/** The number for the next pin: one more than the pins already placed. */
export const nextPinNumber = (marks: readonly Mark[]) => marks.filter((m) => m.kind === 'pin').length + 1;

/** Whether a mark has enough extent to keep (a click without a drag is dropped for shapes). */
export function isMeaningful(m: Mark, unit: number): boolean {
  if (m.kind === 'text') return Boolean(m.text?.trim());
  if (m.kind === 'pin') return m.points.length > 0;
  const { x0, y0, x1, y1 } = bbox(m);
  return Math.max(x1 - x0, y1 - y0) >= 3 * unit;
}

// ---------- legend ----------

export function bbox(m: Mark): { x0: number; y0: number; x1: number; y1: number } {
  const xs = m.points.map((p) => p[0]);
  const ys = m.points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** "top left", "center", "bottom right", … for a point in a `w × h` image. */
export function regionOf(x: number, y: number, w: number, h: number): string {
  const col = x < w / 3 ? 'left' : x > (2 * w) / 3 ? 'right' : 'center';
  const row = y < h / 3 ? 'top' : y > (2 * h) / 3 ? 'bottom' : 'middle';
  if (row === 'middle' && col === 'center') return 'center';
  if (row === 'middle') return `middle ${col}`;
  return `${row} ${col}`;
}

const R = (v: number) => Math.round(v);
const boxText = (b: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number) =>
  `x ${R(b.x0)}–${R(b.x1)}, y ${R(b.y0)}–${R(b.y1)} (${regionOf((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, w, h)})`;
const ptText = (p: Pt, w: number, h: number) => `x ${R(p[0])}, y ${R(p[1])} (${regionOf(p[0], p[1], w, h)})`;

function describeMark(m: Mark, w: number, h: number): string {
  const c = colorName(m.color);
  const b = bbox(m);
  switch (m.kind) {
    case 'rect':
      return `${c} rectangle around ${boxText(b, w, h)}`;
    case 'ellipse':
      return `${c} circle around ${boxText(b, w, h)}`;
    case 'arrow':
      return `${c} arrow pointing to ${ptText(m.points[m.points.length - 1], w, h)}, drawn from ${ptText(m.points[0], w, h)}`;
    case 'pen':
      return `${c} freehand line over ${boxText(b, w, h)}`;
    case 'highlighter':
      return `${c} highlight over ${boxText(b, w, h)}`;
    case 'shape':
      return `${c} outlined area ${boxText(b, w, h)}`;
    case 'pin':
      return `pin ${circled(m.n ?? 1)} at ${ptText(m.points[0], w, h)}`;
    case 'text':
      return `text at ${ptText(m.points[0], w, h)}`;
  }
}

/** Distance from a point to a box (0 inside). */
const distToBox = (p: Pt, b: { x0: number; y0: number; x1: number; y1: number }) =>
  Math.hypot(Math.max(b.x0 - p[0], 0, p[0] - b.x1), Math.max(b.y0 - p[1], 0, p[1] - b.y1));

function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Arrows are measured along their line (their box can cover half the image); other marks by their box. */
const distToMark = (p: Pt, m: Mark) =>
  m.kind === 'arrow' ? distToSegment(p, m.points[0], m.points[m.points.length - 1]) : distToBox(p, bbox(m));

export interface LegendEntry {
  /** Index of the main mark in `marks`. */
  index: number;
  text: string;
}

/**
 * One entry per mark, in drawing order. A typed text that sits on or next to another mark (within 12% of the
 * image diagonal; arrows measured along their line) is folded into that mark's entry as its note — the closest mark
 * drawn before it, else the closest drawn after it, pins first on a tie; other texts get their own entry.
 */
export function legendEntries(marks: readonly Mark[], w: number, h: number): LegendEntry[] {
  const near = 0.12 * Math.hypot(w, h);
  const notes = new Map<number, string[]>();
  const standalone = new Set<number>();
  /** Closest non-text mark among `idx` within reach (pins win a near tie). */
  const closest = (p: Pt, idx: number[]) => {
    let best = -1;
    let bestD = Infinity;
    for (const j of idx) {
      const d = distToMark(p, marks[j]) - (marks[j].kind === 'pin' ? 0.5 : 0);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return bestD <= near ? best : -1;
  };
  marks.forEach((m, i) => {
    if (m.kind !== 'text' || !m.text?.trim() || !m.points.length) return;
    const others = marks.map((_, j) => j).filter((j) => marks[j].kind !== 'text' && marks[j].points.length);
    // A note usually labels something already drawn: try earlier marks first, then later ones.
    let best = closest(m.points[0], others.filter((j) => j < i));
    if (best < 0) best = closest(m.points[0], others.filter((j) => j > i));
    if (best >= 0) notes.set(best, [...(notes.get(best) ?? []), m.text.trim()]);
    else standalone.add(i);
  });
  const out: LegendEntry[] = [];
  marks.forEach((m, i) => {
    if (m.kind === 'text') {
      if (standalone.has(i)) out.push({ index: i, text: `${describeMark(m, w, h)}: "${oneLine(m.text!)}"` });
      return;
    }
    const n = notes.get(i);
    out.push({ index: i, text: describeMark(m, w, h) + (n ? ` — text: ${n.map((t) => `"${oneLine(t)}"`).join(', ')}` : '') });
  });
  return out;
}

const oneLine = (s: string) => s.trim().replace(/\s*\n\s*/g, ' / ').replace(/"/g, '”');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The text the agent receives with a marked image, e.g.
 * `Marked by the user on shot.png (1200×800 px; coordinates are pixels from the top left):`
 * `1. Red circle around x 820–1010, y 60–220 (top right) — text: "make this smaller"`.
 * `source` names what was marked (the file, or `clip.mp4 at 00:12.4`); `extra` adds a sentence after it.
 */
export function buildLegend(marks: readonly Mark[], opts: { source: string; width: number; height: number; extra?: string }): string {
  const entries = legendEntries(marks, opts.width, opts.height);
  const head = `Marked by the user on ${opts.source} (${R(opts.width)}×${R(opts.height)} px; coordinates are pixels from the top left)`;
  const extra = opts.extra?.trim().replace(/[.:]+$/, '');
  if (!entries.length) return `${head}.${extra ? ` ${extra}.` : ''} No marks were drawn.`;
  return `${head}${extra ? `. ${extra}` : ''}:\n${entries.map((e, i) => `${i + 1}. ${cap(e.text)}`).join('\n')}`;
}

// ---------- video ----------

/** `12.43` → `00:12.4`; an hour or more → `1:02:03.4`. */
export function fmtTime(t: number): string {
  const tenths = Math.max(0, Math.round(t * 10));
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${h ? `${h}:${p2(m)}` : p2(m)}:${p2(s)}.${d}`;
}

/** How many frames a contact sheet for a range of `span` seconds shows: 4 up to 8 s, 5 up to 20 s, else 6. */
export const sheetFrameCount = (span: number) => (span <= 8 ? 4 : span <= 20 ? 5 : 6);

/**
 * Evenly spaced frame times from `start` to `end` inclusive (swapped if reversed), clamped inside the video so the
 * last one can still be decoded (`duration - 0.05`).
 */
export function frameTimes(start: number, end: number, duration: number, n = sheetFrameCount(Math.abs(end - start))): number[] {
  const lo = Math.max(0, Math.min(start, end));
  const last = Math.max(0, duration - 0.05);
  const hi = Math.min(Math.max(start, end), last);
  if (n <= 1 || hi <= lo) return [Math.min(lo, last)];
  return Array.from({ length: n }, (_, i) => Math.round((lo + ((hi - lo) * i) / (n - 1)) * 1000) / 1000);
}

export interface SheetLayout {
  cols: number;
  rows: number;
  /** Frame size in the sheet. */
  cellW: number;
  cellH: number;
  /** Strip under each frame for its timestamp. */
  labelH: number;
  gap: number;
  width: number;
  height: number;
  /** Top-left of each frame and the scale from video pixels to sheet pixels. */
  cells: { x: number; y: number; scale: number }[];
}

/** Grid for `n` frames of `frameW × frameH`: 2 columns up to 4 frames, else 3; each frame at most `maxCell` wide. */
export function sheetLayout(n: number, frameW: number, frameH: number, maxCell = 640): SheetLayout {
  const cols = n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const cellW = Math.round(Math.min(frameW, maxCell));
  const scale = cellW / frameW;
  const cellH = Math.round(frameH * scale);
  const labelH = Math.round(Math.max(28, cellW * 0.065));
  const gap = Math.round(Math.max(8, cellW * 0.02));
  const width = cols * cellW + (cols + 1) * gap;
  const height = rows * (cellH + labelH) + (rows + 1) * gap;
  const cells = Array.from({ length: n }, (_, i) => ({
    x: gap + (i % cols) * (cellW + gap),
    y: gap + Math.floor(i / cols) * (cellH + labelH + gap),
    scale,
  }));
  return { cols, rows, cellW, cellH, labelH, gap, width, height, cells };
}

/** File name for a marked copy: `shot.png` → `shot marked.png`; frames: `clip frame 00:12.4.png`. */
export function markedName(original: string, suffix = 'marked'): string {
  const stem = original.replace(/(?<=[^/\\])\.[^./\\]+$/, '') || 'image';
  return `${stem} ${suffix}.png`;
}
