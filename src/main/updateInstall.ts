import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * The parts of "install updates automatically" that touch files and processes (no Electron here, so they can be
 * unit-tested): pick the asset to install, read SHA256SUMS.txt, download with resume, tell whether the Mac is on
 * Wi-Fi, unpack and check a new macOS bundle, and write + start the small helper that swaps the app after it quits.
 */

export interface Asset {
  name?: string;
  browser_download_url?: string;
}

/** Run a program and give back its stdout (rejects on a non-zero exit). */
export type Run = (file: string, args: string[]) => Promise<string>;
export const run: Run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${basename(file)} ${args[0] ?? ''}: ${(stderr || err.message).toString().trim()}`)) : resolve(stdout.toString()),
    ),
  );

const ARM = /arm64|aarch64/i;
const usable = (a: Asset) => !!(a.name && a.browser_download_url);
const byArch = (files: Asset[], arch: string) => files.find((a) => ARM.test(a.name!) === (arch === 'arm64'));

/**
 * The file auto-update downloads for this platform: on macOS the app zip (`…-arm64-mac.zip` / `…-mac.zip`), else
 * the DMG; Windows the NSIS `.exe`; Linux the `.AppImage`. Undefined when the release has none for this CPU.
 */
export function pickInstallAsset(assets: Asset[] | undefined, platform: NodeJS.Platform, arch: string): Asset | undefined {
  const files = (assets ?? []).filter(usable);
  const ends = (ext: string) => files.filter((a) => a.name!.toLowerCase().endsWith(ext));
  if (platform === 'darwin') return byArch(ends('-mac.zip'), arch) ?? byArch(ends('.dmg'), arch);
  if (platform === 'win32') return byArch(ends('.exe'), arch);
  if (platform === 'linux') return byArch(ends('.appimage'), arch);
  return undefined;
}

/** `SHA256SUMS.txt` lines (`<hex>  <name>` or `<hex> *<name>`) → name → lower-case hex. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/**
 * Download `url` to `dest`, writing into `dest.part` first so a cut connection resumes where it stopped
 * (HTTP Range; a server that answers 200 instead of 206 starts over). Renames to `dest` only when complete.
 */
export async function download(
  url: string,
  dest: string,
  opts: { fetch: typeof fetch; signal?: AbortSignal; onProgress?: (received: number, total: number) => void },
): Promise<void> {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await opts.fetch(url, {
    headers: { 'User-Agent': 'Olympus-Coder-updater', ...(have ? { Range: `bytes=${have}-` } : {}) },
    signal: opts.signal,
    redirect: 'follow',
  });
  if (res.status === 416 && have) {
    // Range past the end: the part file is already whole (or junk). Start over to be safe.
    rmSync(part, { force: true });
    return download(url, dest, opts);
  }
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const resumed = res.status === 206 && have > 0;
  const start = resumed ? have : 0;
  const length = Number(res.headers.get('content-length')) || 0;
  const total = length ? start + length : 0;
  let received = start;
  let last = 0;
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - last > 250) {
      last = now;
      opts.onProgress?.(received, total);
    }
  });
  await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal: opts.signal });
  if (total && received !== total) throw new Error('Download ended early.');
  opts.onProgress?.(received, total || received);
  renameSync(part, dest);
}

// ------------------------------------------------------------------ Wi-Fi (macOS)

const TUNNEL = /^(utun|ipsec|ppp|gif|stf)/;

/**
 * Whether the Mac reaches the internet over Wi-Fi: the interface of the default route is the "Wi-Fi" hardware
 * port (`networksetup -listallhardwareports`). Through a VPN tunnel: Wi-Fi when the Wi-Fi port has an address.
 * The network name (`networksetup -getairportnetwork`) is not used: recent macOS hides it without Location access.
 * Undefined when it cannot tell (not macOS, or the commands failed). A phone hotspot over Wi-Fi counts as Wi-Fi.
 */
export async function onWifi(platform: NodeJS.Platform, exec: Run = run): Promise<boolean | undefined> {
  if (platform !== 'darwin') return undefined;
  try {
    const ports = await exec('/usr/sbin/networksetup', ['-listallhardwareports']);
    const wifi = /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\n\s*Device:\s*(\S+)/i.exec(ports)?.[1];
    if (!wifi) return false; // no Wi-Fi hardware at all
    const route = await exec('/sbin/route', ['-n', 'get', 'default']).catch(() => '');
    const iface = /interface:\s*(\S+)/.exec(route)?.[1];
    if (!iface) return false; // offline
    if (iface === wifi) return true;
    if (!TUNNEL.test(iface)) return false;
    const ip = await exec('/usr/sbin/ipconfig', ['getifaddr', wifi]).catch(() => '');
    return /\d+\.\d+\.\d+\.\d+/.test(ip);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ macOS: unpack and check the new app

/** The `.app` bundle path for a running executable (`…/X.app/Contents/MacOS/X` → `…/X.app`), else undefined. */
export function bundleOf(execPath: string): string | undefined {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m?.[1];
}

const firstApp = (dir: string) => readdirSync(dir).find((n) => n.endsWith('.app'));

/** The app's version from `Contents/Resources/app/package.json`, or `Info.plist` when the app is in an asar. */
export async function bundleVersion(app: string, exec: Run = run): Promise<string | undefined> {
  try {
    return JSON.parse(readFileSync(join(app, 'Contents/Resources/app/package.json'), 'utf8')).version;
  } catch {
    const v = await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents/Info.plist')]).catch(() => '');
    return v.trim() || undefined;
  }
}

/**
 * Unpack a downloaded macOS update (`.zip` with `ditto`, `.dmg` mounted read-only and copied out) into `stageDir`
 * and check it: `codesign --verify --deep --strict`, the version in its package.json, no quarantine flag.
 * Returns the new `.app` path; throws with a plain reason when something is wrong (and removes `stageDir`).
 */
export async function stageMacApp(file: string, stageDir: string, expected: string, exec: Run = run): Promise<string> {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  try {
    if (file.toLowerCase().endsWith('.zip')) {
      await exec('/usr/bin/ditto', ['-x', '-k', file, stageDir]);
    } else {
      const mount = `${stageDir}.mnt`;
      mkdirSync(mount, { recursive: true });
      await exec('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, file]);
      try {
        const name = firstApp(mount);
        if (!name) throw new Error('The disk image has no app in it.');
        await exec('/usr/bin/ditto', [join(mount, name), join(stageDir, name)]);
      } finally {
        await exec('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => '');
        rmSync(mount, { recursive: true, force: true });
      }
    }
    const name = firstApp(stageDir);
    if (!name) throw new Error('The download has no app in it.');
    const app = join(stageDir, name);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).catch((e) => {
      throw new Error(`The new app's signature does not check out (${e.message}).`);
    });
    const version = await bundleVersion(app, exec);
    if (version !== expected) throw new Error(`The new app says it is version ${version ?? 'unknown'}, not ${expected}.`);
    // Files Node writes carry no quarantine flag, but an archive can bring one along: remove it if present.
    const attrs = await exec('/usr/bin/xattr', ['-l', app]).catch(() => '');
    if (attrs.includes('com.apple.quarantine')) await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]);
    return app;
  } catch (e) {
    rmSync(stageDir, { recursive: true, force: true });
    throw e;
  }
}

// ------------------------------------------------------------------ the helper that swaps the app after it quits

/**
 * macOS helper (bash). Args: PID TARGET NEW BACKUP_DIR LOG RELAUNCH(1|0). Waits for the app to exit, moves the
 * running bundle to BACKUP_DIR (only the last one is kept), moves NEW into its place, checks the signature and
 * relaunches. Any failed step puts the old bundle back (and relaunches it when RELAUNCH=1).
 */
export const MAC_HELPER = `#!/bin/bash
# Olympus Coder update helper: replaces the app bundle after the app has quit.
PID="$1"; TARGET="$2"; NEW="$3"; BACKUP_DIR="$4"; LOG="$5"; RELAUNCH="$6"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
log "update: waiting for Olympus Coder (pid $PID) to quit; $NEW -> $TARGET"
n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 1200 ]; then log "the app did not quit within 10 minutes; nothing changed"; exit 1; fi
  sleep 0.5
done
BACKUP="$BACKUP_DIR/$(basename "$TARGET")"
relaunch() { if [ "$RELAUNCH" = "1" ]; then /usr/bin/open "$1" >> "$LOG" 2>&1 || log "could not relaunch $1"; fi; }
restore() {
  log "FAILED: $1; putting the previous version back"
  if [ -d "$BACKUP" ]; then rm -rf "$TARGET" && mv "$BACKUP" "$TARGET" && log "previous version restored"; fi
  relaunch "$TARGET"
  exit 1
}
[ -d "$NEW" ] || { log "FAILED: the new app is missing ($NEW)"; relaunch "$TARGET"; exit 1; }
mkdir -p "$BACKUP_DIR" && rm -rf "$BACKUP" || { log "FAILED: cannot prepare $BACKUP_DIR"; relaunch "$TARGET"; exit 1; }
mv "$TARGET" "$BACKUP" || { log "FAILED: cannot move the running app aside"; relaunch "$TARGET"; exit 1; }
log "previous version moved to $BACKUP"
mv "$NEW" "$TARGET" || restore "cannot move the new app into place"
/usr/bin/codesign --verify --deep --strict "$TARGET" >> "$LOG" 2>&1 || restore "codesign --verify failed on the installed app"
if /usr/bin/xattr -l "$TARGET" 2>/dev/null | grep -q com.apple.quarantine; then /usr/bin/xattr -dr com.apple.quarantine "$TARGET"; log "removed the quarantine flag"; fi
log "installed"
relaunch "$TARGET"
log "done"
`;

/** Windows helper (.cmd). Args: PID INSTALLER LOG RELAUNCH(1|0). Waits for the app to exit, runs the NSIS installer silently. */
export const WIN_HELPER = `@echo off
rem Olympus Coder update helper: runs the new installer silently after the app has quit.
set PID=%~1
set INSTALLER=%~2
set LOG=%~3
set RELAUNCH=%~4
echo %date% %time% update: waiting for pid %PID% >> "%LOG%"
:wait
tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul && (timeout /t 1 /nobreak >nul & goto wait)
if "%RELAUNCH%"=="1" (
  "%INSTALLER%" /S --force-run >> "%LOG%" 2>&1
) else (
  "%INSTALLER%" /S >> "%LOG%" 2>&1
)
echo %date% %time% installer exited with %ERRORLEVEL% >> "%LOG%"
`;

/** Linux AppImage helper (sh). Args: PID TARGET NEW BACKUP_DIR LOG RELAUNCH(1|0). Replaces the AppImage file. */
export const LINUX_HELPER = `#!/bin/sh
# Olympus Coder update helper: replaces the AppImage after the app has quit.
PID="$1"; TARGET="$2"; NEW="$3"; BACKUP_DIR="$4"; LOG="$5"; RELAUNCH="$6"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
n=0
while kill -0 "$PID" 2>/dev/null; do n=$((n + 1)); [ "$n" -gt 1200 ] && { log "the app did not quit; nothing changed"; exit 1; }; sleep 0.5; done
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/$(basename "$TARGET")"
cp -f "$TARGET" "$BACKUP" || { log "FAILED: cannot back up $TARGET"; exit 1; }
cp -f "$NEW" "$TARGET.new" && chmod +x "$TARGET.new" && mv -f "$TARGET.new" "$TARGET" || { log "FAILED: cannot replace $TARGET"; rm -f "$TARGET.new"; exit 1; }
log "installed"
if [ "$RELAUNCH" = "1" ]; then setsid "$TARGET" >/dev/null 2>&1 & fi
log "done"
`;

export interface HelperPlan {
  platform: NodeJS.Platform;
  pid: number;
  /** macOS: the running .app; Linux: the AppImage file; Windows: unused. */
  target: string;
  /** macOS: the checked new .app; Linux: the new AppImage; Windows: the NSIS installer. */
  next: string;
  dir: string; // ~/.olympus/updates
  relaunch: boolean;
}

/** The helper file to write and the command that starts it detached (it must outlive the app). */
export function helperCommand(p: HelperPlan): { script: string; text: string; file: string; args: string[] } {
  const log = join(p.dir, 'install.log');
  const backups = join(p.dir, 'previous');
  const flag = p.relaunch ? '1' : '0';
  if (p.platform === 'win32') {
    const script = join(p.dir, 'install-update.cmd');
    return { script, text: WIN_HELPER.replace(/\n/g, '\r\n'), file: 'cmd.exe', args: ['/d', '/c', script, String(p.pid), p.next, log, flag] };
  }
  const mac = p.platform === 'darwin';
  const script = join(p.dir, mac ? 'install-update.sh' : 'install-update-linux.sh');
  const args = [script, String(p.pid), p.target, p.next, backups, log, flag];
  // macOS: perl's setsid gives the helper its own session, so quitting the app does not take it along.
  if (mac) return { script, text: MAC_HELPER, file: '/usr/bin/perl', args: ['-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV', '/bin/bash', ...args] };
  return { script, text: LINUX_HELPER, file: '/bin/sh', args };
}

/** Write the helper and start it detached; it waits for this process to exit before touching anything. */
export function startHelper(p: HelperPlan): void {
  const c = helperCommand(p);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(c.script, c.text, { mode: 0o755 });
  const child = spawn(c.file, c.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
