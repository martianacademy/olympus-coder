import { app } from 'electron';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState, RemoteDevice, Settings } from '@shared/types';
import { getSettings } from './store';

/**
 * Shared remote gateway for authenticated phone / tablet / browser sessions (both E2EE Cloudflare Relay and
 * local HTTP / LAN / Tailscale). Once a device is paired and unlocked with the Olympus app password, it runs
 * the exact same unified responsive `<App />` as the Mac window — including full code editing, file operations,
 * git, interactive PTY terminals, skills, memory, schedules, and settings — while blocking only host-local
 * OS window actions (Finder reveal, native file dialogs) and remote mutation of the app password or phone link.
 */

type Handlers = Record<string, (...args: any[]) => unknown>;

/**
 * Methods that either open a native OS window on the Mac (invisible to the phone) or change the Mac's own
 * lock password / remote pairing security configuration. Everything else in `handlers` works identically.
 */
export const DENIED = new Set([
  // Lock & app password management stay strictly on the Mac itself.
  'lock.unlock',
  'lock.touchId',
  'lock.lockNow',
  'lock.setPassword',
  'lock.remove',
  'lock.options',
  // Remote security link & device revocation stay strictly on the Mac itself.
  'remote.enable',
  'remote.lan',
  'remote.allowFirewall',
  'remote.pair',
  'remote.removeDevice',
  'remote.tailscaleServe',
  'remote.checkTailscale',
  'remote.link',
  'remote.setRelayUrl',
  'remote.resetLink',
  // Native macOS dialogs / Finder / external OS app launches have no UI on a remote device.
  'settings.pickSharedRoot',
  'attach.pick',
  'attach.open',
  // The Mac's own clipboard: a phone copies into its own clipboard instead.
  'clipboard.write',
  'clipboard.readMessage',
  'files.reveal',
  'projects.reveal',
  'memory.reveal',
  'memory.openGlobal',
  'shared.reveal',
  'skills.reveal',
  'preview.openDefault',
  'preview.reveal',
  'preview.saveAs',
  'system.openExternal',
  'app.restart',
]);

/**
 * All live `DeskEvents` needed by the unified `<App />`, `<Workbench />`, and `<Terminal />` over SSE / Relay.
 * Note: `lock:state` is intentionally handled out-of-band by `relay.ts` (`access`) and `remote.ts` so a phone
 * that unlocked its own session with the app password does not render the Mac's desktop `LockScreen`.
 */
export const EVENTS = new Set([
  'thread:item',
  'thread:meta',
  'session:state',
  'agent:status',
  'pty:data',
  'pty:exit',
  'terminal:opened',
  'terminal:changed',
  'heat:alert',
  'schedules:changed',
  'catalog:progress',
  'agents:changed',
  // ACP config slice (src/shared/acpConfig.ts AcpConfigEvents).
  'mcp:status',
  'auth:info',
  'auth:link',
  // Send-while-busy queue (src/shared/promptQueue.ts PromptQueueEvents).
  'queue:state',
]);

let handlers: Handlers = {};
export const setHandlers = (h: Handlers) => (handlers = h);

export async function remoteCall(method: string, args: unknown): Promise<{ ok: boolean; value?: unknown; error?: string; forbidden?: boolean }> {
  const list = Array.isArray(args) ? args : [];
  if (DENIED.has(method) || !handlers[method]) {
    return { ok: false, forbidden: true, error: `"${method}" can only be used directly on your Mac.` };
  }
  // `projects.add` without a path opens a native macOS folder picker on the host; require an explicit path remotely.
  if (method === 'projects.add' && (!list[0] || typeof list[0] !== 'string' || !list[0].trim())) {
    return { ok: false, forbidden: true, error: 'Enter a folder path on your Mac to add a project remotely.' };
  }
  if (method === 'projects.relocate' && (!list[1] || typeof list[1] !== 'string' || !list[1].trim())) {
    return { ok: false, forbidden: true, error: 'Locate the moved folder on your Mac.' };
  }
  try {
    if (method === 'app.state') {
      const raw = (await handlers['app.state']()) as AppState;
      // An authenticated remote session has already passed pairing + app password, so never block `<App />`
      // behind the Mac's local `LockScreen` or first-run desktop `Onboarding`.
      const value: AppState = {
        ...raw,
        lock: { ...raw.lock, locked: false },
        settings: { ...raw.settings, onboarded: true },
      };
      return { ok: true, value };
    }
    if (method === 'settings.update') {
      const patch = (list[0] && typeof list[0] === 'object' ? { ...(list[0] as Partial<Settings>) } : {}) as Partial<Settings>;
      // Prevent mutating `remote` security config via `settings.update`.
      delete patch.remote;
      const value = await handlers['settings.update'](patch);
      return { ok: true, value: value ?? null };
    }
    const value = await handlers[method](...list);
    return { ok: true, value: value ?? null };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Lightweight theme/version snapshot for pre-mount or quick status checks. */
export function remoteSnapshot() {
  const s = getSettings();
  return { theme: s.theme, profileName: s.profile?.name ?? '', defaultAgent: s.defaultAgent, version: app.getVersion() };
}

// ---- paired phones (tokens are stored only as SHA-256 hashes) ----

interface StoredDevice extends RemoteDevice {
  tokenHash: string;
}
const devicesFile = () => join(app.getPath('userData'), 'remote-devices.json');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

function loadDevices(): StoredDevice[] {
  try {
    return JSON.parse(readFileSync(devicesFile(), 'utf8')).devices ?? [];
  } catch {
    return [];
  }
}
const saveDevices = (d: StoredDevice[]) => writeFileSync(devicesFile(), JSON.stringify({ devices: d }, null, 2), { mode: 0o600 });

export const listDevices = (): RemoteDevice[] => loadDevices().map(({ tokenHash: _h, ...d }) => d);

export function deviceByToken(token: string): RemoteDevice | undefined {
  if (!token) return undefined;
  const h = Buffer.from(hash(token));
  const all = loadDevices();
  const d = all.find((x) => x.tokenHash.length === h.length && timingSafeEqual(Buffer.from(x.tokenHash), h));
  if (d && (!d.lastSeen || Date.now() - d.lastSeen > 60_000)) {
    d.lastSeen = Date.now();
    saveDevices(all);
  }
  if (!d) return undefined;
  const { tokenHash: _h, ...pub } = d;
  return pub;
}

/** Adds a phone and returns its long random token (only its hash is kept). */
export function addDevice(name: string, via: RemoteDevice['via']): { token: string; device: RemoteDevice } {
  const token = randomBytes(32).toString('base64url');
  const device: StoredDevice = {
    id: randomUUID(),
    name: name.slice(0, 60) || 'Phone',
    createdAt: Date.now(),
    lastSeen: Date.now(),
    via,
    tokenHash: hash(token),
  };
  saveDevices([...loadDevices(), device]);
  const { tokenHash: _h, ...pub } = device;
  return { token, device: pub };
}

const removedListeners = new Set<(id: string | null) => void>();
/** Called with a device id when it is removed, or null when every phone is. */
export const onDeviceRemoved = (fn: (id: string | null) => void) => removedListeners.add(fn);

export function deleteDevice(id: string) {
  saveDevices(loadDevices().filter((d) => d.id !== id));
  removedListeners.forEach((l) => l(id));
}

export function deleteAllDevices() {
  saveDevices([]);
  removedListeners.forEach((l) => l(null));
}
