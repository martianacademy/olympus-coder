/**
 * Pure-Node shim for `'electron'` used ONLY by the headless server build (`out/server/index.mjs`,
 * built via `npm run build:server`). Never bundled into the Electron desktop app.
 *
 * Implements the small surface `src/main/*` actually reads:
 * - `app`: `userData` (`OLYMPUS_SERVER_DATA` or `~/.olympus/server`), `appData`, `getAppPath()`,
 *   `getVersion()`, `whenReady()`, lifecycle events (`before-quit`/`will-quit`), and `quit()`.
 * - `safeStorage`: real AES-256-GCM authenticated encryption backed by a 32-byte `0600` keyfile
 *   at `<userData>/master.key` so API keys remain encrypted at rest on headless Linux VPS hosts.
 * - `shell`: `trashItem` removes files cleanly; desktop GUI openers (`openPath`/`openExternal`) no-op.
 * - Desktop-only symbols (`BrowserWindow`, `dialog`, `ipcMain`, `Menu`, `nativeTheme`, `powerMonitor`,
 *   `systemPreferences`, `clipboard`, `nativeImage`, `session`): safe no-op stubs.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../..'), resolve(here, '..'), process.cwd()]) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return process.cwd();
}

const PKG_ROOT = resolvePackageRoot();
const PKG_VERSION = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return raw.version || '0.3.1';
  } catch {
    return '0.3.1';
  }
})();

let appName = 'Olympus Coder';
let userDataPath =
  process.env.OLYMPUS_SERVER_DATA?.trim() ||
  join(process.env.OLYMPUS_HOME?.trim() || join(homedir(), '.olympus'), 'server');
const appDataPath = process.env.OLYMPUS_HOME?.trim() || join(homedir(), '.olympus');

const appEmitter = new EventEmitter();
let quitting = false;

export const app = {
  isPackaged: true,
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  getName: () => appName,
  setName: (n: string) => {
    appName = n;
  },
  getVersion: () => PKG_VERSION,
  getAppPath: () => PKG_ROOT,
  getPath: (name: string) => {
    if (name === 'userData') {
      mkdirSync(userDataPath, { recursive: true });
      return userDataPath;
    }
    if (name === 'appData') {
      mkdirSync(appDataPath, { recursive: true });
      return appDataPath;
    }
    if (name === 'home') return homedir();
    return userDataPath;
  },
  setPath: (name: string, p: string) => {
    if (name === 'userData') {
      userDataPath = p;
      mkdirSync(userDataPath, { recursive: true });
    }
  },
  commandLine: {
    // Always treat userData as explicitly configured in headless mode so desktop migration doesn't override it.
    hasSwitch: (sw: string) => sw === 'user-data-dir',
    getSwitchValue: () => userDataPath,
  },
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},
  setActivationPolicy: () => {},
  dock: undefined as undefined | { setIcon: (p: string) => void; hide: () => void },
  on: (ev: string, fn: (...args: any[]) => void) => {
    appEmitter.on(ev, fn);
    return app;
  },
  once: (ev: string, fn: (...args: any[]) => void) => {
    appEmitter.once(ev, fn);
    return app;
  },
  off: (ev: string, fn: (...args: any[]) => void) => {
    appEmitter.off(ev, fn);
    return app;
  },
  relaunch: () => {},
  quit: () => {
    if (quitting) return;
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };
    appEmitter.emit('before-quit', event);
    if (prevented) return;
    quitting = true;
    appEmitter.emit('will-quit', event);
    process.exit(0);
  },
};

// ---- AES-256-GCM local secret encryption backed by a 0600 master keyfile ----

let cachedMasterKey: Buffer | null = null;
function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const dir = app.getPath('userData');
  const keyFile = join(dir, 'master.key');
  if (existsSync(keyFile)) {
    const raw = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (raw.length === 32) {
      cachedMasterKey = raw;
      return raw;
    }
  }
  const fresh = randomBytes(32);
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile, fresh.toString('base64') + '\n', { mode: 0o600 });
  cachedMasterKey = fresh;
  return fresh;
}

export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'olympus_headless_aes256gcm',
  encryptString: (plain: string): Buffer => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]);
  },
  decryptString: (buf: Buffer): string => {
    if (buf.length < 29) throw new Error('Invalid encrypted secret payload');
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString('utf8');
  },
};

export const shell = {
  trashItem: async (targetPath: string) => {
    rmSync(targetPath, { recursive: true, force: true });
  },
  openPath: async () => '',
  openExternal: async () => {},
  showItemInFolder: () => {},
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
  showMessageBoxSync: () => 0,
};

export class BrowserWindow {
  static getAllWindows = () => [] as BrowserWindow[];
  static fromWebContents = () => null;
  webContents = { isDestroyed: () => true, send: () => {}, getType: () => 'window' };
  isDestroyed = () => true;
  isMinimized = () => false;
  isVisible = () => false;
  close = () => {};
  show = () => {};
  restore = () => {};
  focus = () => {};
  on = () => this;
}

export const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: () => {},
};

export const nativeTheme = {
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: true,
};

export const powerMonitor = {
  on: () => {},
  off: () => {},
  getSystemIdleTime: () => 0,
  getCurrentThermalState: () => 'nominal',
};

export const systemPreferences = {
  canPromptTouchID: () => false,
  promptTouchID: async () => {
    throw new Error('Touch ID is unavailable on headless server.');
  },
  getMediaAccessStatus: () => 'denied',
  askForMediaAccess: async () => false,
};

export const clipboard = {
  writeText: () => {},
  readText: () => '',
  write: () => {},
  readBuffer: () => Buffer.alloc(0),
};

export const ClipboardItem = class {};

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }),
  createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }),
};

export const session = {
  defaultSession: {
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  },
};

export default {
  app,
  safeStorage,
  shell,
  ipcMain,
  dialog,
  BrowserWindow,
  Menu,
  nativeTheme,
  powerMonitor,
  systemPreferences,
  clipboard,
  ClipboardItem,
  nativeImage,
  session,
};
