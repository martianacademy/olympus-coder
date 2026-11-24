/**
 * Unit tests for one-time built-in connector seeding and Chrome DevTools 3-mode presets
 * (`src/shared/defaultConnectors.ts`).
 */
import assert from 'node:assert/strict';
import {
  chromeConnectorArgs,
  defaultChromeDevtoolsConnector,
  detectChromeConnectorMode,
  seedDefaultConnectors,
} from '../src/shared/defaultConnectors.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const ROOT = '/tmp/olympus-home';

test('fresh settings seed Chrome DevTools in dedicated persistent Agent Chrome profile mode', () => {
  const res = seedDefaultConnectors({}, ROOT);
  assert.equal(res.changed, true);
  assert.equal(res.connectors.length, 1);
  assert.equal(res.connectors[0].id, 'chrome-devtools');
  assert.equal(res.connectors[0].enabled, true);
  assert.equal(res.connectors[0].agents, 'all');
  assert.equal(detectChromeConnectorMode(res.connectors[0].args), 'agent-profile');
  assert.ok(res.connectors[0].args.includes(`${ROOT}/chrome-profile`));
  assert.ok(res.seededConnectors.includes('chrome-devtools'));
});

test('chromeConnectorArgs and detectChromeConnectorMode round-trip all 3 modes cleanly', () => {
  for (const mode of ['agent-profile', 'headless', 'real-chrome']) {
    const args = chromeConnectorArgs(mode, ROOT);
    assert.equal(detectChromeConnectorMode(args), mode);
  }
  assert.ok(chromeConnectorArgs('headless', ROOT).includes('--headless'));
  assert.ok(chromeConnectorArgs('real-chrome', ROOT).includes('--autoConnect'));
});

test('removing Chrome DevTools after seeding never re-adds it on subsequent startups', () => {
  const res = seedDefaultConnectors({ connectors: [], seededConnectors: ['chrome-devtools'] }, ROOT);
  assert.equal(res.changed, false);
  assert.equal(res.connectors.length, 0);
});

test('existing user Chrome DevTools connector with custom args is preserved untouched', () => {
  const custom = { ...defaultChromeDevtoolsConnector(ROOT), args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'] };
  const res = seedDefaultConnectors({ connectors: [custom] }, ROOT);
  assert.equal(res.changed, true);
  assert.equal(res.connectors.length, 1);
  assert.equal(detectChromeConnectorMode(res.connectors[0].args), 'real-chrome');
});

console.log(`\n${passed} passed, 0 failed`);
