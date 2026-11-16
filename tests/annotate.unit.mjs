// Unit tests: image / video markup model — legend text, bake geometry (pointer → image pixels → drawing calls at any
// display scale), contact-sheet frame times and layout. File: src/renderer/src/annotate/marks.ts.
// Run: node tests/annotate.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const M = await import(pathToFileURL(`${APP}/src/renderer/src/annotate/marks.ts`).href);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

/** A 2D context that records every call with its arguments and the style state at stroke/fill time. */
function recorder() {
  const calls = [];
  const state = { strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, font: '', textAlign: 'start', textBaseline: 'alphabetic' };
  const stack = [];
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => {
        if (k === 'save') stack.push({ ...state });
        if (k === 'restore') Object.assign(state, stack.pop());
        calls.push({ op: k, args, lineWidth: state.lineWidth, alpha: state.globalAlpha, stroke: state.strokeStyle, fill: state.fillStyle, font: state.font });
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx, calls };
}

const RED = '#ef4444';

// ---------- legend ----------

test('legend: circle with a note next to it, arrow, pin with text, standalone text — in drawing order', () => {
  const W = 1200;
  const H = 800;
  const marks = [
    { kind: 'ellipse', color: RED, width: 1, points: [[820, 60], [1010, 220]] },
    { kind: 'text', color: RED, width: 1, points: [[830, 230]], text: 'make this smaller' },
    { kind: 'arrow', color: '#3b82f6', width: 1, points: [[400, 500], [900, 140]] },
    { kind: 'pin', color: RED, width: 1, points: [[300, 200]], n: 1 },
    { kind: 'text', color: RED, width: 1, points: [[320, 190]], text: 'logo\nhere' },
    { kind: 'text', color: '#111111', width: 0, points: [[600, 700]], text: 'footer "too" tall' },
  ];
  const legend = M.buildLegend(marks, { source: 'shot.png', width: W, height: H });
  const lines = legend.split('\n');
  assert.equal(lines[0], 'Marked by the user on shot.png (1200×800 px; coordinates are pixels from the top left):');
  assert.equal(lines[1], '1. Red circle around x 820–1010, y 60–220 (top right) — text: "make this smaller"');
  assert.equal(lines[2], '2. Blue arrow pointing to x 900, y 140 (top right), drawn from x 400, y 500 (center)');
  assert.equal(lines[3], '3. Pin ① at x 300, y 200 (top left) — text: "logo / here"');
  assert.equal(lines[4], '4. Text at x 600, y 700 (bottom center): "footer ”too” tall"');
  assert.equal(lines.length, 5);
});

test('legend: every kind is named; no marks → says so; extra sentence after the source', () => {
  const kinds = [
    ['rect', [[10, 10], [50, 40]], 'rectangle around'],
    ['pen', [[10, 10], [20, 30], [40, 35]], 'freehand line over'],
    ['highlighter', [[10, 10], [90, 12]], 'highlight over'],
    ['shape', [[10, 10], [60, 10], [40, 60]], 'outlined area'],
  ];
  for (const [kind, points, phrase] of kinds) {
    const l = M.buildLegend([{ kind, color: '#22c55e', width: 0, points }], { source: 'a.png', width: 100, height: 100 });
    assert.match(l, new RegExp(`1\\. Green ${phrase}`), kind);
  }
  assert.equal(M.buildLegend([], { source: 'a.png', width: 10, height: 10 }), 'Marked by the user on a.png (10×10 px; coordinates are pixels from the top left). No marks were drawn.');
  const ex = M.buildLegend([{ kind: 'pin', color: RED, width: 0, points: [[5, 5]], n: 2 }], { source: 'clip.mp4, 00:05.0–00:30.0', width: 1280, height: 720, extra: 'Contact sheet of 4 frames.' });
  assert.equal(M.buildLegend([], { source: 'a.png', width: 10, height: 10, extra: 'Frame at 00:01.0' }), 'Marked by the user on a.png (10×10 px; coordinates are pixels from the top left). Frame at 00:01.0. No marks were drawn.');
  assert.match(ex, /^Marked by the user on clip\.mp4, 00:05\.0–00:30\.0 \(1280×720 px; coordinates are pixels from the top left\)\. Contact sheet of 4 frames:\n1\. Pin ② at x 5, y 5 \(top left\)$/);
});

test('legend: a text far from everything stays its own entry; closest mark wins', () => {
  const marks = [
    { kind: 'rect', color: RED, width: 0, points: [[0, 0], [100, 100]] },
    { kind: 'rect', color: '#3b82f6', width: 0, points: [[900, 900], [1000, 1000]] },
    { kind: 'text', color: RED, width: 0, points: [[880, 880]], text: 'near blue' },
    { kind: 'text', color: RED, width: 0, points: [[500, 500]], text: 'alone' },
  ];
  const e = M.legendEntries(marks, 1000, 1000);
  assert.equal(e.length, 3);
  assert.match(e[1].text, /blue rectangle .* — text: "near blue"/);
  assert.match(e[2].text, /^text at x 500, y 500 \(center\): "alone"$/);
});

test('regionOf: nine regions', () => {
  assert.equal(M.regionOf(10, 10, 300, 300), 'top left');
  assert.equal(M.regionOf(150, 10, 300, 300), 'top center');
  assert.equal(M.regionOf(150, 150, 300, 300), 'center');
  assert.equal(M.regionOf(290, 150, 300, 300), 'middle right');
  assert.equal(M.regionOf(290, 290, 300, 300), 'bottom right');
});

test('pins number 1, 2, 3 in placing order; undoing one frees its number', () => {
  const marks = [];
  for (let i = 0; i < 3; i++) marks.push({ kind: 'pin', color: RED, width: 0, points: [[i, i]], n: M.nextPinNumber(marks) });
  assert.deepEqual(marks.map((m) => m.n), [1, 2, 3]);
  marks.pop();
  assert.equal(M.nextPinNumber(marks), 3);
  assert.equal(M.circled(3), '③');
});

// ---------- bake geometry ----------

test('bake geometry: the same pointer gesture lands on the same image pixels at any display scale', () => {
  const natW = 1600;
  const natH = 900;
  const target = [[400, 225], [1200, 675]]; // a rectangle in image pixels
  const baked = [];
  for (const scale of [0.25, 0.5, 0.8125, 1, 1.5, 2]) {
    const rect = { left: 37, top: 91, width: natW * scale, height: natH * scale };
    // Where the user's pointer is on screen for those image pixels (what CDP / a mouse sends).
    const pts = target.map(([x, y]) => M.toImagePoint(rect.left + x * scale, rect.top + y * scale, rect, natW, natH));
    assert.deepEqual(pts, target, `scale ${scale}`);
    const { ctx, calls } = recorder();
    M.drawMarks(ctx, [{ kind: 'rect', color: RED, width: 1, points: pts }], M.unitFor(natW, natH));
    const r = calls.find((c) => c.op === 'rect');
    const s = calls.find((c) => c.op === 'stroke');
    baked.push(JSON.stringify({ rect: r.args, lw: s.lineWidth }));
  }
  assert.equal(new Set(baked).size, 1, baked.join('\n'));
  const one = JSON.parse(baked[0]);
  assert.deepEqual(one.rect, [400, 225, 800, 450]);
  assert.equal(one.lw, 6 * 1.6); // medium stroke × unit (1600 px → 1.6)
});

test('bake geometry: pointer outside the image clamps to its edge; screen point inverts image point', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  assert.deepEqual(M.toImagePoint(-20, 140, rect, 800, 400), [0, 400]);
  assert.deepEqual(M.toScreenPoint([400, 200], rect, 800, 400), [100, 50]);
});

test('bake geometry: every tool draws at its image coordinates (pins, text, arrow head ends at the tip)', () => {
  const unit = M.unitFor(1000, 500);
  assert.equal(unit, 1);
  const { ctx, calls } = recorder();
  M.drawMarks(
    ctx,
    [
      { kind: 'ellipse', color: RED, width: 0, points: [[100, 100], [300, 200]] },
      { kind: 'arrow', color: RED, width: 2, points: [[10, 10], [510, 10]] },
      { kind: 'pin', color: '#facc15', width: 1, points: [[700, 300]], n: 4 },
      { kind: 'text', color: RED, width: 2, points: [[50, 400]], text: 'a\nb' },
      { kind: 'highlighter', color: '#facc15', width: 0, points: [[0, 0], [10, 0]] },
    ],
    unit,
  );
  const ell = calls.find((c) => c.op === 'ellipse');
  assert.deepEqual(ell.args.slice(0, 4), [200, 150, 100, 50]);
  const tip = calls.filter((c) => c.op === 'moveTo').find((c) => c.args[0] === 510);
  assert.ok(tip, 'arrow head starts at the tip');
  const arc = calls.find((c) => c.op === 'arc');
  assert.deepEqual(arc.args.slice(0, 3), [700, 300, 18]);
  const pinText = calls.find((c) => c.op === 'fillText' && c.args[0] === '4');
  assert.ok(pinText && pinText.fill === '#111111', 'yellow pin gets dark number');
  const texts = calls.filter((c) => c.op === 'fillText' && (c.args[0] === 'a' || c.args[0] === 'b'));
  assert.deepEqual(texts.map((c) => c.args.slice(1)), [[50, 400], [50, 400 + 48 * 1.22]]);
  assert.match(texts[0].font, /^600 48px /);
  const hl = calls.find((c) => c.op === 'stroke' && c.alpha === 0.35);
  assert.ok(hl && hl.lineWidth === 3 * 3.5, 'highlighter is semi-transparent and wide');
});

test('bake: marks scale with the image so they look the same on any size', () => {
  assert.equal(M.unitFor(400, 300), 1);
  assert.equal(M.unitFor(4000, 3000), 4);
  assert.equal(M.strokeWidth({ kind: 'pen', width: 2 }, 4), 48);
});

test('fitSize keeps the aspect and caps the upscale', () => {
  assert.deepEqual(M.fitSize(4000, 2000, 1000, 800), { w: 1000, h: 500, scale: 0.25 });
  assert.deepEqual(M.fitSize(100, 50, 1000, 800), { w: 200, h: 100, scale: 2 });
});

test('isMeaningful drops a click without a drag for shapes but keeps pins', () => {
  assert.equal(M.isMeaningful({ kind: 'rect', color: RED, width: 0, points: [[5, 5], [6, 6]] }, 1), false);
  assert.equal(M.isMeaningful({ kind: 'rect', color: RED, width: 0, points: [[5, 5], [26, 6]] }, 1), true);
  assert.equal(M.isMeaningful({ kind: 'pin', color: RED, width: 0, points: [[5, 5]], n: 1 }, 1), true);
  assert.equal(M.isMeaningful({ kind: 'text', color: RED, width: 0, points: [[5, 5]], text: '  ' }, 1), false);
});

// ---------- video ----------

test('fmtTime: mm:ss.d, hours when needed', () => {
  assert.equal(M.fmtTime(12.43), '00:12.4');
  assert.equal(M.fmtTime(0), '00:00.0');
  assert.equal(M.fmtTime(65.06), '01:05.1');
  assert.equal(M.fmtTime(3723.4), '1:02:03.4');
  assert.equal(M.fmtTime(59.96), '01:00.0');
});

test('contact sheet frame times: evenly spaced, inclusive, 4–6 frames by span', () => {
  assert.deepEqual(M.frameTimes(5, 30, 60), [5, 10, 15, 20, 25, 30]);
  assert.deepEqual(M.frameTimes(2, 8, 60), [2, 4, 6, 8]);
  assert.deepEqual(M.frameTimes(0, 20, 60), [0, 5, 10, 15, 20]);
  assert.equal(M.sheetFrameCount(8), 4);
  assert.equal(M.sheetFrameCount(8.1), 5);
  assert.equal(M.sheetFrameCount(21), 6);
});

test('contact sheet frame times: reversed range, clamped to the video end, zero span', () => {
  assert.deepEqual(M.frameTimes(30, 5, 60), [5, 10, 15, 20, 25, 30]);
  const t = M.frameTimes(0, 10, 6);
  assert.equal(t[0], 0);
  assert.equal(t[t.length - 1], 5.95);
  assert.ok(t.every((v, i) => i === 0 || v > t[i - 1]), 'strictly increasing');
  assert.deepEqual(M.frameTimes(3, 3, 10), [3]);
});

test('contact sheet layout: grid, label strips, frames scaled to fit', () => {
  const L = M.sheetLayout(6, 1280, 720);
  assert.equal(L.cols, 3);
  assert.equal(L.rows, 2);
  assert.equal(L.cellW, 640);
  assert.equal(L.cellH, 360);
  assert.equal(L.cells[0].scale, 0.5);
  assert.deepEqual([L.cells[4].x, L.cells[4].y], [L.gap * 2 + 640, L.gap * 2 + 360 + L.labelH]);
  assert.equal(L.width, 3 * 640 + 4 * L.gap);
  assert.equal(L.height, 2 * (360 + L.labelH) + 3 * L.gap);
  const S = M.sheetLayout(4, 320, 240);
  assert.equal(S.cols, 2);
  assert.equal(S.cellW, 320);
  assert.equal(S.cells[0].scale, 1);
  // A mark at video pixel (640, 360) lands at the cell origin + 320, 180 in a 6-frame sheet.
  const c = L.cells[5];
  assert.deepEqual([c.x + 640 * c.scale, c.y + 360 * c.scale], [L.gap * 3 + 1280 + 320, L.gap * 2 + 360 + L.labelH + 180]);
});

test('markedName', () => {
  assert.equal(M.markedName('shot.png'), 'shot marked.png');
  assert.equal(M.markedName('clip.mp4', 'frame 00:12.4'), 'clip frame 00:12.4.png');
  assert.equal(M.markedName('.env'), '.env marked.png');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
