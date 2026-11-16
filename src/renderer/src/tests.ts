/**
 * Test results read from terminal output: how many passed / failed, which ones failed, and a command that
 * reruns only the failed ones where the test runner allows it. Knows pytest, Jest, Vitest, Go, Cargo, Mocha
 * and node:test. Returns null when the output has no test summary.
 */

export interface TestFailure {
  name: string;
  /** `path:line` when the output says where. */
  ref?: string;
}

export interface TestResult {
  runner: 'pytest' | 'jest' | 'vitest' | 'go' | 'cargo' | 'mocha' | 'node';
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  /** A command that runs only the failed tests, when the runner allows it. */
  rerunFailed?: string;
}

const num = (s: string | undefined) => (s ? Number(s) : 0);
const uniq = <T,>(a: T[]) => [...new Set(a)];
const quote = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function parseTestOutput(raw: string): TestResult | null {
  const text = raw.replace(/\r/g, '');

  // pytest: "===== 2 failed, 10 passed, 1 skipped in 0.52s ====="
  const py = [...text.matchAll(/^=+ (.*?\b(?:passed|failed|error|errors)\b.*?) in [\d.]+s(?: \([^)]*\))? =+$/gm)].pop();
  if (py) {
    const s = py[1];
    const failures = uniq([...text.matchAll(/^(?:FAILED|ERROR) (\S+?)(?: - .*)?$/gm)].map((m) => m[1])).map((id) => ({ name: id, ref: id.split('::')[0] }));
    const failed = num(/(\d+) failed/.exec(s)?.[1]) + num(/(\d+) errors?/.exec(s)?.[1]);
    return {
      runner: 'pytest',
      passed: num(/(\d+) passed/.exec(s)?.[1]),
      failed,
      skipped: num(/(\d+) skipped/.exec(s)?.[1]),
      failures,
      rerunFailed: failed ? (failures.length ? `python -m pytest ${failures.map((f) => quote(f.name)).join(' ')}` : 'python -m pytest --lf') : undefined,
    };
  }

  // Vitest: " Tests  2 failed | 10 passed (12)"
  const vi = [...text.matchAll(/^\s*Tests\s+(.*\(\d+\))\s*$/gm)].pop();
  if (vi && /(passed|failed)/.test(vi[1])) {
    const s = vi[1];
    const files = uniq([...text.matchAll(/^\s*(?:FAIL|×|❯)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/gm)].map((m) => m[1]));
    const names = uniq([...text.matchAll(/^\s*(?:FAIL|×)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?) > (.+?)\s*$/gm)].map((m) => `${m[1]} > ${m[2]}`));
    const failed = num(/(\d+) failed/.exec(s)?.[1]);
    return {
      runner: 'vitest',
      passed: num(/(\d+) passed/.exec(s)?.[1]),
      failed,
      skipped: num(/(\d+) skipped/.exec(s)?.[1]),
      failures: (names.length ? names : files).map((n) => ({ name: n, ref: n.split(' > ')[0] })),
      rerunFailed: failed && files.length ? `npx vitest run ${files.map(quote).join(' ')}` : undefined,
    };
  }

  // Jest: "Tests:       2 failed, 10 passed, 12 total"
  const je = [...text.matchAll(/^Tests:\s+(.*\d+ total)\s*$/gm)].pop();
  if (je) {
    const s = je[1];
    const files = uniq([...text.matchAll(/^\s*FAIL\s+(\S+)/gm)].map((m) => m[1]));
    const names = uniq([...text.matchAll(/^\s*● (.+?)\s*$/gm)].map((m) => m[1]).filter((n) => !/^Test suite failed/.test(n)));
    const failed = num(/(\d+) failed/.exec(s)?.[1]);
    return {
      runner: 'jest',
      passed: num(/(\d+) passed/.exec(s)?.[1]),
      failed,
      skipped: num(/(\d+) skipped/.exec(s)?.[1]) + num(/(\d+) todo/.exec(s)?.[1]),
      failures: names.length ? names.map((n) => ({ name: n })) : files.map((f) => ({ name: f, ref: f })),
      rerunFailed: failed && files.length ? `npx jest ${files.map(quote).join(' ')}` : undefined,
    };
  }

  // Cargo: "test result: FAILED. 10 passed; 2 failed; 0 ignored; …"
  const cargo = [...text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  if (cargo.length) {
    const passed = cargo.reduce((a, m) => a + num(m[1]), 0);
    const failed = cargo.reduce((a, m) => a + num(m[2]), 0);
    const names = uniq([...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((m) => m[1]));
    const refs = new Map([...text.matchAll(/thread '([^']+)' panicked at (\S+?:\d+)(?::\d+)?/g)].map((m) => [m[1], m[2]]));
    return {
      runner: 'cargo',
      passed,
      failed,
      skipped: cargo.reduce((a, m) => a + num(m[3]), 0),
      failures: names.map((n) => ({ name: n, ref: refs.get(n) })),
      rerunFailed: failed && names.length ? `cargo test -- ${names.map(quote).join(' ')}` : undefined,
    };
  }

  // Go: "--- FAIL: TestX (0.00s)", "ok  pkg 0.1s", "FAIL pkg 0.1s"
  const goFails = uniq([...text.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]));
  const goPass = [...text.matchAll(/^\s*--- PASS: /gm)].length;
  const goPkgs = [...text.matchAll(/^(ok|FAIL)\s+\S+\s+[\d.]+s/gm)];
  if (goFails.length || goPkgs.length) {
    const refs = [...text.matchAll(/^\s+(\S+_test\.go:\d+):/gm)].map((m) => m[1]);
    const top = goFails.filter((n) => !n.includes('/'));
    return {
      runner: 'go',
      passed: goPass,
      failed: goFails.length,
      skipped: [...text.matchAll(/^\s*--- SKIP: /gm)].length,
      failures: goFails.map((n, i) => ({ name: n, ref: refs[i] })),
      rerunFailed: top.length ? `go test -run '^(${top.join('|')})$' ./...` : undefined,
    };
  }

  // Mocha: "10 passing (20ms)", "2 failing"
  const mp = [...text.matchAll(/^\s*(\d+) passing\b/gm)].pop();
  if (mp) {
    const failed = num([...text.matchAll(/^\s*(\d+) failing\b/gm)].pop()?.[1]);
    // Each failure is listed twice (inline, then with details): keep the first line per number.
    const byNum = new Map<string, string>();
    for (const m of text.matchAll(/^\s*(\d+)\) (.+?):?\s*$/gm)) if (!byNum.has(m[1])) byNum.set(m[1], m[2]);
    const names = [...byNum.values()];
    return { runner: 'mocha', passed: num(mp[1]), failed, skipped: num([...text.matchAll(/^\s*(\d+) pending\b/gm)].pop()?.[1]), failures: names.map((n) => ({ name: n })) };
  }

  // node:test (TAP-ish): "# pass 10", "# fail 2"
  const np = [...text.matchAll(/^ℹ? ?#? ?pass (\d+)$/gm)].pop();
  const nf = [...text.matchAll(/^ℹ? ?#? ?fail (\d+)$/gm)].pop();
  if (np && nf) {
    const names = uniq([...text.matchAll(/^\s*(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)].map((m) => m[1]).filter((n) => !n.endsWith(':')));
    // "test at file.js:4:1" comes right before a failed test's name in the summary.
    const refs = new Map([...text.matchAll(/^test at (\S+?:\d+)(?::\d+)?\n\s*✖ (.+?)(?: \([\d.]+ms\))?$/gm)].map((m) => [m[2], m[1]]));
    const failed = num(nf[1]);
    const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      runner: 'node',
      passed: num(np[1]),
      failed,
      skipped: num([...text.matchAll(/^ℹ? ?#? ?skipped (\d+)$/gm)].pop()?.[1]),
      failures: names.map((n) => ({ name: n, ref: refs.get(n) })),
      rerunFailed: failed && names.length ? `node --test --test-name-pattern=${quote(`^(${names.map(esc).join('|')})$`)}` : undefined,
    };
  }
  return null;
}
