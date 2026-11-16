// Unit tests: language detection for highlighted chat code (src/renderer/src/codeLang.ts).
// Run: node tests/codeHighlight.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const L = await import(`${APP}/src/renderer/src/codeLang.ts`);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}

const TS = 'export function a(x: number) {\n  return x + 1; // add\n}';
const det = (cmd, out = TS) => L.detectResultLang(cmd, out);
const langOf = (cmd, out) => det(cmd, out)?.lang ?? null;

console.log('detectResultLang — file printing commands');
test('sed -n range on a .ts file', () => assert.deepEqual(det('sed -n 380,420p src/main/agents.ts'), { lang: 'typescript', gutters: [], perLine: false }));
test("sed -n with quoted script and -e", () => assert.equal(langOf("sed -n -e '1,40p' app.py", 'def x():\n  pass'), 'python'));
test('sed -i is never a print', () => assert.equal(langOf("sed -i '' 's/a/b/' app.ts"), null));
test('sed substitution without -n stays plain', () => assert.equal(langOf("sed 's/a/b/' app.ts"), null));
test('cat one file', () => assert.equal(langOf('cat src/lib.rs', 'fn main() {}'), 'rust'));
test('cat -n adds a num gutter', () => assert.deepEqual(det('cat -n a.ts', '     1\texport const a = 1;'), { lang: 'typescript', gutters: ['num'], perLine: false }));
test('cat two files of the same language', () => assert.equal(langOf('cat a.ts b.ts'), null)); // one file only per statement
test('cat two statements, same language, echo separator', () => assert.equal(langOf('cat a.ts; echo ---; cat b.ts'), 'typescript'));
test('two statements with different languages stay plain', () => assert.equal(langOf('cat a.ts && cat b.py'), null));
test('head -n 40 file.py', () => assert.equal(langOf('head -n 40 tools/run.py', 'import os'), 'python'));
test('head -40 file.go', () => assert.equal(langOf('head -40 main.go', 'package main'), 'go'));
test('tail -n +10 file.json', () => assert.equal(langOf('tail -n +10 package.json', '  "a": 1\n}'), 'json'));
test('tail -f stays plain', () => assert.equal(langOf('tail -f server.ts'), null));
test('bat --plain', () => assert.equal(langOf('bat --plain src/x.tsx', 'const A = () => <div/>;'), 'tsx'));
test('nl gives a num gutter', () => assert.deepEqual(det('nl -ba src/a.ts', '     1\tconst a = 1;'), { lang: 'typescript', gutters: ['num'], perLine: false }));
test('cat file | nl', () => assert.deepEqual(det('cat a.ts | nl'), { lang: 'typescript', gutters: ['num'], perLine: false }));
test('cat -n file | sed -n range', () => assert.deepEqual(det("cat -n a.ts | sed -n '10,20p'"), { lang: 'typescript', gutters: ['num'], perLine: false }));
test('cat file | head -50', () => assert.equal(langOf('cat a.ts | head -50'), 'typescript'));
test('cat file | grep x stays plain', () => assert.equal(langOf('cat a.ts | grep foo'), null));
test('cd dir && sed -n …', () => assert.equal(langOf('cd /repo && sed -n 1,20p src/a.ts'), 'typescript'));
test('stderr redirect is ignored', () => assert.equal(langOf('cat a.ts 2>/dev/null'), 'typescript'));
test('stdout redirected to a file prints nothing', () => assert.equal(langOf('cat a.ts > b.ts'), null));
test('git show HEAD:file', () => assert.equal(langOf('git show HEAD:src/main/index.ts'), 'typescript'));
test('git --no-pager show rev:file.py', () => assert.equal(langOf('git --no-pager show abc123:app.py', 'x = 1'), 'python'));
test('unknown extension stays plain (.log)', () => assert.equal(langOf('cat server.log', '[INFO] started'), null));
test('.txt stays plain', () => assert.equal(langOf('head notes.txt', 'hello'), null));
test('glob argument stays plain', () => assert.equal(langOf('cat src/*.ts'), null));
test('Dockerfile by name', () => assert.equal(langOf('cat Dockerfile', 'FROM node:22'), 'dockerfile'));
test('heredoc / python -c stay plain', () => {
  assert.equal(langOf("python3 - <<'EOF'\nprint(1)\nEOF"), null);
  assert.equal(langOf('python3 -c "print(1)"', '1'), null);
});

console.log('detectResultLang — grep');
test('grep -n on exactly one file → grep gutter, per line', () =>
  assert.deepEqual(det('grep -n "foo\\|bar" src/main/agents.ts', '12:const foo = 1;\n40:  bar();'), { lang: 'typescript', gutters: ['grep'], perLine: false }));
test('grep -n file | head -30', () => assert.deepEqual(det('grep -n foo a.ts | head -30', '1:a'), { lang: 'typescript', gutters: ['grep'], perLine: false }));
test('screenshot command: grep -n … | head + sed -n on the same file', () =>
  assert.deepEqual(det('grep -n "limitsService\\|probeSessions" src/main/agents.ts | head -30\nsed -n 380,420p src/main/agents.ts'), {
    lang: 'typescript',
    gutters: ['grep'],
    perLine: false,
  }));
test('grep -n -A 3 (context) on one file', () => assert.equal(langOf('grep -n -A 3 foo a.ts', '1:a\n2-b'), 'typescript'));
test('grep without -n on one file → per line', () => assert.deepEqual(det('grep foo a.ts'), { lang: 'typescript', gutters: [], perLine: true }));
test('rg -n on one file', () => assert.equal(langOf('rg -n foo src/a.rs', '3:fn a() {}'), 'rust'));
test('multi-file grep stays plain', () => assert.equal(langOf('grep -n foo a.ts b.ts', 'a.ts:1:x'), null));
test('recursive grep stays plain', () => {
  assert.equal(langOf('grep -rn foo src', 'src/a.ts:1:x'), null);
  assert.equal(langOf('grep -n -r foo src/a.ts', 'src/a.ts:1:x'), null);
});
test('grep -l / -c stay plain', () => {
  assert.equal(langOf('grep -l foo a.ts', 'a.ts'), null);
  assert.equal(langOf('grep -c foo a.ts', '3'), null);
});
test('grep --include stays plain', () => assert.equal(langOf('grep -n --include=*.ts foo .', 'x'), null));

console.log('detectResultLang — content');
test('pretty JSON object', () => assert.equal(langOf('curl -s https://api.x/y', '{\n  "a": 1,\n  "b": [true, null]\n}'), 'json'));
test('JSONL (pretty-printed records)', () => assert.equal(langOf('cat events.log', '{\n  "a": 1\n}\n{\n  "a": 2\n}'), 'json'));
test('JSON from an unknown command', () => assert.equal(langOf('node script.js', '[1, 2, {"x": "y"}]'), 'json'));
test('bracketed log line is not JSON', () => assert.equal(langOf('node script.js', '[INFO] server started\n[WARN] slow'), null));
test('git diff → diff', () =>
  assert.equal(langOf('git diff', 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b'), 'diff'));
test('diff -u → diff', () => assert.equal(langOf('diff -u a.txt b.txt', '--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-a\n+b'), 'diff'));
test('git show <commit> → diff', () =>
  assert.equal(langOf('git show abc1234', 'commit abc1234def\nAuthor: A\n\n    msg\n\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'), 'diff'));
test('git log (no patch) stays plain', () => assert.equal(langOf('git log -3', 'commit abc1234def\nAuthor: A\n\n    msg'), null));
test('a diff buried in test output stays plain', () =>
  assert.equal(langOf('npm test', 'FAIL x.test.ts\n--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b'), null));

console.log('detectResultLang — logs and test output stay plain');
test('npm test output', () => assert.equal(langOf('npm test', 'PASS src/a.test.ts\n  ✓ works (3 ms)\nTests: 1 passed'), null));
test('build log', () => assert.equal(langOf('npx electron-vite build', 'vite v7 building for production...\n✓ 120 modules transformed.'), null));
test('ls output', () => assert.equal(langOf('ls -la', 'total 8\ndrwxr-xr-x  3 a b 96 .'), null));
test('cat file.ts && npm test mixes outputs → plain', () => assert.equal(langOf('cat a.ts && npm test'), null));
test('empty output', () => assert.equal(det('cat a.ts', ''), null));
test('huge output (> 150 KB) stays plain', () => assert.equal(det('cat a.ts', 'x'.repeat(150_001)), null));

console.log('langFromPath / langFromFence');
test('paths', () => {
  assert.equal(L.langFromPath('/a/b/c.ts'), 'typescript');
  assert.equal(L.langFromPath('src/App.tsx:42'), 'tsx');
  assert.equal(L.langFromPath('file:///x/y.py'), 'python');
  assert.equal(L.langFromPath('README.md'), 'markdown');
  assert.equal(L.langFromPath('notes.txt'), null);
  assert.equal(L.langFromPath('Makefile'), 'shell');
  assert.equal(L.langFromPath(''), null);
});
test('fences', () => {
  assert.equal(L.langFromFence('ts'), 'typescript');
  assert.equal(L.langFromFence('bash'), 'shell');
  assert.equal(L.langFromFence('json'), 'json');
  assert.equal(L.langFromFence('text'), null);
  assert.equal(L.langFromFence('console'), null);
  assert.equal(L.langFromFence('log'), null);
  assert.equal(L.langFromFence(''), null);
});

console.log('splitGutters / hasNumGutter');
test('grep gutter: matches, context lines and -- separators', () => {
  const g = L.splitGutters('12:const a = 1;\n13-const b = 2;\n--\n  try {', ['grep']);
  assert.deepEqual(g.map((l) => [l.gutter, l.code, l.match]), [
    ['12', 'const a = 1;', true],
    ['13', 'const b = 2;', true],
    ['', '--', true],
    ['', '  try {', false],
  ]);
});
test('num gutter: cat -n tab and read-tool arrow', () => {
  const g = L.splitGutters('     1\tconst a = 1;\n    10→  return;\n', ['num']);
  assert.deepEqual(g.map((l) => [l.gutter, l.code]), [
    ['1', 'const a = 1;'],
    ['10', '  return;'],
    ['', ''],
  ]);
});
test('num gutter: blank numbered line whose tab was trimmed', () =>
  assert.deepEqual(L.splitGutters('     1\timport os\n     2\n     3\tx = 1', ['num']).map((l) => [l.gutter, l.code]), [
    ['1', 'import os'],
    ['2', ''],
    ['3', 'x = 1'],
  ]));
test('code lines starting with numbers are not gutters without a style', () =>
  assert.deepEqual(L.splitGutters('404: x', []).map((l) => l.gutter), ['']));
test('hasNumGutter', () => {
  assert.equal(L.hasNumGutter('     1\ta\n     2\tb\n     3\tc'), true);
  assert.equal(L.hasNumGutter('const a = 1;\nconst b = 2;'), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
