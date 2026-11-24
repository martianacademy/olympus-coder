/**
 * Built-in default MCP connectors seeded once into user settings (Settings → Connectors)
 * plus 3-mode presets for the Chrome DevTools MCP connector:
 *  1. `agent-profile` (default): dedicated persistent visible Chrome profile (`<sharedRoot>/chrome-profile`)
 *     so you sign in once to chosen sites while keeping your personal Chrome 100% separate.
 *  2. `headless`: ephemeral isolated headless Chrome (`--headless --isolated`).
 *  3. `real-chrome`: attaches to your real Chrome via `--autoConnect` (`chrome://inspect/#remote-debugging`).
 */
import type { ConnectorDef } from './types';

export type ChromeConnectorMode = 'agent-profile' | 'headless' | 'real-chrome';

const BASE_FLAGS = [
  '-y',
  'chrome-devtools-mcp@latest',
  '--screenshotFormat',
  'webp',
  '--screenshotMaxWidth',
  '1280',
  '--no-category-performance',
  '--no-category-memory',
] as const;

/** Builds clean `chrome-devtools-mcp` CLI args for the selected browser mode. */
export function chromeConnectorArgs(mode: ChromeConnectorMode, sharedRootDir: string): string[] {
  const cleanRoot = sharedRootDir.replace(/\/+$/, '');
  if (mode === 'headless') {
    return [BASE_FLAGS[0], BASE_FLAGS[1], '--headless', '--isolated', '--viewport', '1280x800', ...BASE_FLAGS.slice(2)];
  }
  if (mode === 'real-chrome') {
    return [BASE_FLAGS[0], BASE_FLAGS[1], '--autoConnect', ...BASE_FLAGS.slice(2)];
  }
  return [
    BASE_FLAGS[0],
    BASE_FLAGS[1],
    '--userDataDir',
    `${cleanRoot}/chrome-profile`,
    '--viewport',
    '1280x800',
    ...BASE_FLAGS.slice(2),
  ];
}

/** Detects which built-in mode a `chrome-devtools` connector's args currently represent. */
export function detectChromeConnectorMode(args?: string[]): ChromeConnectorMode | 'custom' {
  const list = args ?? [];
  if (list.includes('--autoConnect')) return 'real-chrome';
  if (list.includes('--headless')) return 'headless';
  if (list.includes('--userDataDir')) return 'agent-profile';
  return 'custom';
}

export function defaultChromeDevtoolsConnector(sharedRootDir: string): ConnectorDef {
  return {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: chromeConnectorArgs('agent-profile', sharedRootDir),
    envKeys: [],
    agents: 'all',
    source: 'built-in',
  };
}

/**
 * Seeds any not-yet-seeded built-in connectors once without overwriting an existing user connector
 * of the same id/name or re-adding one the user previously removed.
 */
export function seedDefaultConnectors(
  saved: { connectors?: ConnectorDef[]; seededConnectors?: string[] },
  sharedRootDir: string,
): { connectors: ConnectorDef[]; seededConnectors: string[]; changed: boolean } {
  const connectors = Array.isArray(saved.connectors) ? [...saved.connectors] : [];
  const seeded = new Set(Array.isArray(saved.seededConnectors) ? saved.seededConnectors : []);
  let changed = false;

  const builtins = [defaultChromeDevtoolsConnector(sharedRootDir)];
  for (const def of builtins) {
    if (seeded.has(def.id)) continue;
    const exists = connectors.some((c) => c.id === def.id || c.name.toLowerCase() === def.name.toLowerCase());
    if (!exists) connectors.push({ ...def, args: def.args ? [...def.args] : undefined, envKeys: [...(def.envKeys ?? [])] });
    seeded.add(def.id);
    changed = true;
  }

  return { connectors, seededConnectors: [...seeded], changed };
}
