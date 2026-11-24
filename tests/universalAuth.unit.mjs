// Unit tests: universal ACP auth handling across all agents (`src/main/acpAuth.ts`, `src/main/acpAuthCatalog.ts`):
// - `_meta['terminal-auth']` (Zed/ACP registry convention) without `Run \`...\`` descriptions
// - `type: 'terminal'` subcommand vs flag `replaceAgentArgs` (`oly` `['login']` vs `agy acp` `['--login']`)
// - Obsolete `--experimental-*` CLI flag detection (`findRejectedExperimentalArg`, e.g. Qwen Code 1.0)
// - Extra multi-account switch & logout terminal methods (`github-copilot-cli`, `opencode`, `kilo`)
// Run: node tests/universalAuth.unit.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));

// Load via electron-vite compiled or Node TS loader? Note: acpAuth.ts uses extensionless `./acpAuthCatalog`
// so register a tiny resolve hook for extensionless local `.ts` imports just like other main-process unit tests.
import { register } from 'node:module';
register(
  `data:text/javascript,${encodeURIComponent(`
    import { existsSync } from 'node:fs';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('./') && !specifier.endsWith('.ts') && !specifier.endsWith('.js') && context.parentURL) {
        const tsPath = fileURLToPath(new URL(specifier + '.ts', context.parentURL));
        if (existsSync(tsPath)) return { url: pathToFileURL(tsPath).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `)}`,
);

const { authMethodDetail, cliLogoutArgsFor, cliSwitchArgsFor, effectiveAuthMethods, findRejectedExperimentalArg } = await import(
  `${APP}/src/main/acpAuth.ts`
);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e?.stack ?? e}`);
  }
}

test('_meta["terminal-auth"] promotes to flow="terminal" even without Run `...` in description', () => {
  const m = authMethodDetail('gemini', {
    id: 'google-login',
    name: 'Sign in with Google',
    description: 'Authenticate in your browser',
    _meta: {
      'terminal-auth': {
        command: '/usr/local/bin/gemini',
        args: ['auth', 'login'],
        env: { NO_COLOR: '1' },
      },
    },
  });
  assert.equal(m.flow, 'terminal');
  assert.equal(m.terminalCommand, '/usr/local/bin/gemini');
  assert.deepEqual(m.terminalArgs, ['auth', 'login']);
  assert.deepEqual(m.terminalEnv, { NO_COLOR: '1' });
  assert.equal(m.replaceAgentArgs, true);
});

test('type="terminal" sets replaceAgentArgs for subcommands (login/auth) and keeps flags (--login/--cli) appended', () => {
  const oly = authMethodDetail('olympus', { id: 'wizard', type: 'terminal', name: 'Wizard', args: ['login'] });
  assert.equal(oly.flow, 'terminal');
  assert.equal(oly.replaceAgentArgs, true);

  const agy = authMethodDetail('antigravity', { id: 'term', type: 'terminal', name: 'Terminal', args: ['--login'] });
  assert.equal(agy.flow, 'terminal');
  assert.equal(agy.replaceAgentArgs, undefined);

  const claude = authMethodDetail('claude', { id: 'sub', type: 'terminal', name: 'Sub', args: ['--cli', 'auth', 'login'] });
  assert.equal(claude.flow, 'terminal');
  assert.equal(claude.replaceAgentArgs, undefined);
});

test('findRejectedExperimentalArg identifies obsolete --experimental-* flags without stripping --experimental-acp', () => {
  assert.equal(
    findRejectedExperimentalArg(['--acp', '--experimental-skills'], "error: unknown option '--experimental-skills'"),
    '--experimental-skills',
  );
  assert.equal(
    findRejectedExperimentalArg(['--experimental-acp', '--experimental-foo=1'], 'unrecognized flag: --experimental-foo'),
    '--experimental-foo=1',
  );
  // Never strip core ACP server flag `--experimental-acp`
  assert.equal(
    findRejectedExperimentalArg(['--experimental-acp'], "error: unknown option '--experimental-acp'"),
    null,
  );
  assert.equal(findRejectedExperimentalArg(['--acp'], 'Connection reset by peer'), null);
});

test('Copilot exposes device-code login, while OpenCode and Kilo expose footer switch/logout CLI actions without duplicating login rows', () => {
  const copilot = effectiveAuthMethods(
    'github-copilot-cli',
    [{ id: 'copilot-login', name: 'Log in with Copilot CLI', description: 'Run `copilot login` in the terminal' }],
    { builtin: false, registryId: 'github-copilot-cli', command: 'npx' },
  );
  assert.ok(copilot.some((m) => m.id === 'copilot-login' && m.flow === 'terminal'));
  assert.ok(copilot.some((m) => m.id === '__olympus_copilot_device_code' && m.flow === 'terminal'));

  const opencodeMeta = { builtin: false, registryId: 'opencode', command: 'opencode' };
  const opencode = effectiveAuthMethods(
    'opencode',
    [{ id: 'opencode-login', name: 'Login with opencode', description: 'Run `opencode auth login` in the terminal' }],
    opencodeMeta,
  );
  assert.equal(opencode.filter((m) => m.flow === 'terminal').length, 1);
  assert.deepEqual(cliSwitchArgsFor('opencode', opencodeMeta), ['auth', 'switch']);
  assert.deepEqual(cliLogoutArgsFor('opencode', opencodeMeta), ['auth', 'logout']);

  const kiloMeta = { builtin: false, registryId: 'kilo', command: 'kilo' };
  const kilo = effectiveAuthMethods(
    'kilo',
    [{ id: 'kilo-login', name: 'Login with Kilo', description: 'Run `kilo auth login` in the terminal' }],
    kiloMeta,
  );
  assert.equal(kilo.filter((m) => m.flow === 'terminal').length, 1);
  assert.deepEqual(cliLogoutArgsFor('kilo', kiloMeta), ['auth', 'logout']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
