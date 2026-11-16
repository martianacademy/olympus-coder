import { app, powerMonitor, systemPreferences } from 'electron';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LockOptions, LockState } from '@shared/types';
import { writeJson } from './store';

/**
 * App lock: a password (scrypt hash, never stored in plain text) that hides every project, chat and
 * agent until it is entered. While locked, the main process refuses every IPC call except unlock.
 */

interface LockFile {
  salt?: string;
  hash?: string;
  options: LockOptions;
  failures: number;
  lockedUntil: number;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_OPTIONS: LockOptions = { autoLockMinutes: 5, lockOnSleep: true, touchId: false };

const lockFile = () => join(app.getPath('userData'), 'lock.json');

let data: LockFile | null = null;
let locked = false;
const listeners = new Set<(s: LockState) => void>();

function load(): LockFile {
  if (!data) {
    try {
      const saved = JSON.parse(readFileSync(lockFile(), 'utf8')) as Partial<LockFile>;
      data = { failures: 0, lockedUntil: 0, ...saved, options: { ...DEFAULT_OPTIONS, ...(saved.options ?? {}) } };
    } catch {
      data = { options: { ...DEFAULT_OPTIONS }, failures: 0, lockedUntil: 0 };
    }
  }
  return data;
}

function save() {
  writeJson(lockFile(), load());
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 64, SCRYPT);
}

function verify(password: string): boolean {
  const d = load();
  if (!d.salt || !d.hash) return true;
  const expected = Buffer.from(d.hash, 'base64');
  const got = hashPassword(password, Buffer.from(d.salt, 'base64'));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export const isLockEnabled = () => Boolean(load().hash);
export const isLocked = () => locked;

export function touchIdAvailable(): boolean {
  try {
    return process.platform === 'darwin' && systemPreferences.canPromptTouchID();
  } catch {
    return false;
  }
}

export function lockState(): LockState {
  const d = load();
  return {
    enabled: isLockEnabled(),
    locked,
    touchIdAvailable: touchIdAvailable(),
    options: d.options,
    retryAfterMs: Math.max(0, d.lockedUntil - Date.now()),
  };
}

function emit() {
  const s = lockState();
  for (const l of listeners) l(s);
}

export function onLockChange(fn: (s: LockState) => void) {
  listeners.add(fn);
}

export function lockNow(): LockState {
  if (isLockEnabled()) {
    locked = true;
    emit();
  }
  return lockState();
}

export function unlockWithPassword(password: string): { ok: boolean; error?: string; state: LockState } {
  const d = load();
  const wait = d.lockedUntil - Date.now();
  if (wait > 0) return { ok: false, error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)}s.`, state: lockState() };
  if (verify(password)) {
    d.failures = 0;
    d.lockedUntil = 0;
    save();
    locked = false;
    emit();
    return { ok: true, state: lockState() };
  }
  d.failures += 1;
  // After 5 wrong tries, wait 30s, then 60s, 120s ... (max 15 min). Saved to disk, so restarting doesn't reset it.
  if (d.failures >= 5) d.lockedUntil = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (d.failures - 5));
  save();
  return { ok: false, error: 'Incorrect password.', state: lockState() };
}

/**
 * Checks the password without unlocking this window (the phone uses it). Wrong tries count toward the same
 * back-off as the lock screen, so guessing from a phone is just as slow.
 */
export function checkPassword(password: string): { ok: boolean; error?: string } {
  const d = load();
  if (!d.hash) return { ok: false, error: 'No app password is set on the Mac.' };
  const wait = d.lockedUntil - Date.now();
  if (wait > 0) return { ok: false, error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 1000)}s.` };
  if (verify(password)) {
    if (d.failures) {
      d.failures = 0;
      d.lockedUntil = 0;
      save();
    }
    return { ok: true };
  }
  d.failures += 1;
  if (d.failures >= 5) d.lockedUntil = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (d.failures - 5));
  save();
  return { ok: false, error: 'Incorrect password.' };
}

export async function unlockWithTouchId(): Promise<{ ok: boolean; error?: string; state: LockState }> {
  const d = load();
  if (!d.options.touchId || !touchIdAvailable()) return { ok: false, error: 'Touch ID is not turned on.', state: lockState() };
  try {
    await systemPreferences.promptTouchID('unlock Olympus Coder');
    locked = false;
    d.failures = 0;
    save();
    emit();
    return { ok: true, state: lockState() };
  } catch {
    return { ok: false, error: 'Touch ID was cancelled.', state: lockState() };
  }
}

export function setPassword(current: string | null, next: string): { ok: boolean; error?: string; state: LockState } {
  if (isLockEnabled() && !verify(current ?? '')) return { ok: false, error: 'Current password is incorrect.', state: lockState() };
  if (next.length < 4) return { ok: false, error: 'Password must be at least 4 characters.', state: lockState() };
  const salt = randomBytes(16);
  const d = load();
  d.salt = salt.toString('base64');
  d.hash = hashPassword(next, salt).toString('base64');
  d.failures = 0;
  d.lockedUntil = 0;
  save();
  emit();
  return { ok: true, state: lockState() };
}

export function removePassword(current: string): { ok: boolean; error?: string; state: LockState } {
  if (!verify(current)) return { ok: false, error: 'Incorrect password.', state: lockState() };
  const d = load();
  delete d.salt;
  delete d.hash;
  d.options.touchId = false;
  save();
  locked = false;
  emit();
  return { ok: true, state: lockState() };
}

export function setLockOptions(patch: Partial<LockOptions>): LockState {
  const d = load();
  d.options = { ...d.options, ...patch };
  if (d.options.touchId && !touchIdAvailable()) d.options.touchId = false;
  save();
  emit();
  return lockState();
}

/** Lock at start-up (if a password is set), on sleep / screen lock, and after the idle timeout. */
export function startLockWatchers(): void {
  if (isLockEnabled()) locked = true;
  const onSleep = () => {
    if (load().options.lockOnSleep) lockNow();
  };
  powerMonitor.on('lock-screen', onSleep);
  powerMonitor.on('suspend', onSleep);
  setInterval(() => {
    const mins = load().options.autoLockMinutes;
    if (!mins || locked || !isLockEnabled()) return;
    if (powerMonitor.getSystemIdleTime() >= mins * 60) lockNow();
  }, 10_000);
}
