import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { parseDiffHunks } = await import(`${APP}/src/shared/diffHunks.ts`);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL  ${name}\n`, e);
  }
}

test('parseDiffHunks splits multi-hunk unified diff into standalone valid patches that git apply --reverse accepts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'olympus-hunks-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: tmp });
    const linesBefore = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(tmp, 'sample.ts'), `${linesBefore.join('\n')}\n`);
    execFileSync('git', ['add', 'sample.ts'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'before'], { cwd: tmp });

    const linesAfter = [...linesBefore];
    linesAfter[1] = 'line 2 CHANGED A';
    linesAfter[18] = 'line 19 CHANGED B';
    writeFileSync(join(tmp, 'sample.ts'), `${linesAfter.join('\n')}\n`);

    const diff = execFileSync('git', ['diff', '--no-color', 'HEAD', '--', 'sample.ts'], { cwd: tmp, encoding: 'utf8' });
    const parsed = parseDiffHunks(diff);
    assert.equal(parsed.hunks.length, 2, 'two separate hunks parsed');
    assert.equal(parsed.hunks[0].added, 1);
    assert.equal(parsed.hunks[0].removed, 1);

    // Reverse-apply ONLY hunk 0 (keeping hunk 1 intact!)
    execFileSync('git', ['apply', '--reverse'], { cwd: tmp, input: parsed.hunks[0].patch });
    const mid = readFileSync(join(tmp, 'sample.ts'), 'utf8').trim().split('\n');
    assert.equal(mid[1], 'line 2', 'hunk 0 reverted cleanly');
    assert.equal(mid[18], 'line 19 CHANGED B', 'hunk 1 kept intact');

    // Re-apply hunk 0 forward!
    execFileSync('git', ['apply'], { cwd: tmp, input: parsed.hunks[0].patch });
    const restored = readFileSync(join(tmp, 'sample.ts'), 'utf8').trim().split('\n');
    assert.equal(restored[1], 'line 2 CHANGED A', 'hunk 0 re-applied cleanly');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseDiffHunks handles empty or header-only binary diffs safely', () => {
  assert.deepEqual(parseDiffHunks(''), { headerLines: [], hunks: [] });
  const bin = parseDiffHunks('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n');
  assert.equal(bin.hunks.length, 0);
  assert.equal(bin.headerLines.length, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
