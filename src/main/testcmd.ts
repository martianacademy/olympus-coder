import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The command that runs a project's tests, guessed from its files: package.json's "test" script (with the
 * package manager its lock file names), pytest, Go, Cargo, or a Makefile "test" target. Null when there is
 * no clear one, so the Run tests button only appears where it would work.
 */
export function detectTestCommand(dir: string): string | null {
  const has = (f: string) => existsSync(join(dir, f));
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  if (has('package.json')) {
    try {
      const test = JSON.parse(read('package.json'))?.scripts?.test as string | undefined;
      if (test && !/no test specified/.test(test)) {
        if (has('pnpm-lock.yaml')) return 'pnpm test';
        if (has('yarn.lock')) return 'yarn test';
        if (has('bun.lockb') || has('bun.lock')) return 'bun run test';
        return 'npm test';
      }
    } catch {
      /* broken package.json: try the others */
    }
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  const py =
    has('pytest.ini') ||
    has('conftest.py') ||
    /\[tool\.pytest/.test(read('pyproject.toml')) ||
    /\[tool:pytest\]/.test(read('setup.cfg')) ||
    ['tests', 'test'].some((d) => {
      try {
        return readdirSync(join(dir, d)).some((f) => /^test_.*\.py$|_test\.py$/.test(f));
      } catch {
        return false;
      }
    });
  if (py) return 'python -m pytest';
  if (/^test:/m.test(read('Makefile'))) return 'make test';
  return null;
}
