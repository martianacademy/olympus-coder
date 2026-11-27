import { app } from 'electron';
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeskEvents, Settings, UpdateCheck, UpdateInfo } from '@shared/types';
import { getSettings, sharedRoot, updateSettings } from './store';
import { bundleOf, download, onWifi, parseSums, pickInstallAsset, sha256File, stageMacApp, startHelper } from './updateInstall';

/**
 * New versions, in the mode the user chose (Settings → General → Updates):
 * - 'notify': looks at the latest GitHub release at startup (after ~30 s) and once a day and tells the window (and
 *   phones) when it is newer; the notice links to the release page and the installer.
 * - 'auto': also downloads the update in the background into <shared>/updates/<version>/, checks it against the
 *   release's SHA256SUMS.txt (macOS: unpacks it and checks the signature and version too) and offers
 *   "Restart to update". The swap happens after the app quits, in a detached helper (updateInstall.ts). Nothing is
 *   installed unless the user presses Restart, or quits with "Install when I quit" on.
 * - 'off': never asks GitHub.
 * A copy installed from the Microsoft Store (`process.windowsStore`) never asks GitHub, downloads or installs
 * anything: the Store updates it, and the GitHub installer would replace it with a second, unpackaged copy.
 */

const REPO = 'martianacademy/olympus-coder';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 24 * 60 * 60 * 1000;
/** The one line Settings shows in a Microsoft Store copy. */
export const STORE_UPDATE_TEXT = 'This copy updates through the Microsoft Store.';

export interface Release {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** "v1.2.3" / "1.2.3" → [1, 2, 3, pre]; undefined when it is not a version. `pre` is set for "1.2.3-beta.1". */
function parse(v: string): [number, number, number, string] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''] : undefined;
}

/** Semver order of two versions: < 0 when a is older, 0 when equal (or unreadable), > 0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  // A release is newer than its own pre-releases (1.0.0 > 1.0.0-beta).
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

const ARM = /arm64|aarch64/i;
const EXT: Partial<Record<NodeJS.Platform, string>> = { darwin: '.dmg', win32: '.exe', linux: '.appimage' };

/** The installer for this platform and CPU among a release's assets (mac .dmg, Windows .exe, Linux .AppImage). */
export function pickAsset(assets: Release['assets'], platform: NodeJS.Platform, arch: string): string | undefined {
  const ext = EXT[platform];
  if (!ext) return undefined;
  const files = (assets ?? []).filter((a) => a.name && a.browser_download_url && a.name.toLowerCase().endsWith(ext));
  const wantArm = arch === 'arm64';
  return files.find((a) => ARM.test(a.name!) === wantArm)?.browser_download_url;
}

export interface CheckDeps {
  current: string;
  platform: NodeJS.Platform;
  arch: string;
  settings: Pick<Settings, 'updateMode' | 'skippedUpdate'>;
  fetch: typeof fetch;
  url?: string;
  /** Installed from the Microsoft Store (`process.windowsStore`): the Store updates it, so GitHub is never asked. */
  store?: boolean;
}

export interface CheckResult {
  /** The newer release to tell the user about, or null. */
  info: UpdateInfo | null;
  release?: Release;
  /** One line for Settings ("Up to date", "Could not reach GitHub"…). */
  text: string;
  /** Set when something else updates this copy (the Microsoft Store): Settings hides the update modes. */
  managed?: UpdateCheck['managed'];
}

/** Ask GitHub for the latest release (nothing at all when updates are off) and say what it means for this app. */
export async function checkRelease(d: CheckDeps): Promise<CheckResult> {
  if (d.store) return { info: null, text: STORE_UPDATE_TEXT, managed: 'store' };
  if (d.settings.updateMode === 'off') return { info: null, text: 'Updates are off.' };
  let r: Release;
  try {
    const res = await d.fetch(d.url ?? RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Olympus-Coder-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
    // 403 (rate limit), 404 (no release yet), 5xx: try again next time, quietly.
    if (!res.ok) return { info: null, text: `Could not check: GitHub answered ${res.status}.` };
    r = (await res.json()) as Release;
  } catch {
    return { info: null, text: 'Could not reach GitHub.' }; // offline, timeout, bad JSON
  }
  const upToDate = { info: null, text: `Up to date (${d.current}).` };
  if (!r || r.draft || r.prerelease || !r.tag_name || !parse(r.tag_name) || parse(r.tag_name)![3]) return upToDate;
  const version = r.tag_name.replace(/^v/, '');
  if (compareVersions(version, d.current) <= 0) return upToDate;
  if (d.settings.skippedUpdate && compareVersions(version, d.settings.skippedUpdate) === 0) return { info: null, text: `${version} is out; you chose to skip it.` };
  const pageUrl = r.html_url && /^https:\/\//.test(r.html_url) ? r.html_url : `https://github.com/${REPO}/releases/latest`;
  return { info: { version, pageUrl, downloadUrl: pickAsset(r.assets, d.platform, d.arch) ?? pageUrl }, release: r, text: `Olympus Coder ${version} is available.` };
}

/** The newer release to tell the user about, or null (none, skipped, updates off, or GitHub not reachable). */
export const findUpdate = async (d: CheckDeps) => (await checkRelease(d)).info;

/** Wait to download until the Mac is on Wi-Fi? Only when asked; "cannot tell" also waits. */
export const waitForWifi = (wifiOnly: boolean | undefined, wifi: boolean | undefined) => !!wifiOnly && wifi !== true;

// ------------------------------------------------------------------ the app's checker

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};
/** What the banner shows. */
let latest: UpdateInfo | null = null;
let lastCheck: UpdateCheck | undefined;
let timer: NodeJS.Timeout | undefined;
/** The download running now. */
let job: { version: string; abort: AbortController } | undefined;
/** A downloaded, checked update: the new .app (macOS), installer (Windows) or AppImage (Linux). */
let ready: { version: string; next: string } | undefined;
/** A version not to download by itself again (cancelled or failed) until "Check now". */
let noAuto: string | undefined;
/** Set when the app quits to install: from Restart (relaunch) or set by `onAppWillQuit`. */
let installOnExit: { relaunch: boolean } | undefined;

export const updatesDir = () => join(sharedRoot(), 'updates');
const mode = () => getSettings().updateMode ?? 'notify';
/** Running from the Microsoft Store package (Electron sets this for apps installed under WindowsApps). */
const fromStore = () => process.platform === 'win32' && process.windowsStore === true;
/** What Settings shows in a Store copy, even before the first check ran. */
const storeCheck = (): UpdateCheck => ({ at: Date.now(), text: STORE_UPDATE_TEXT, managed: 'store' });

function show(next: UpdateInfo | null) {
  if (JSON.stringify(next) === JSON.stringify(latest)) return;
  latest = next;
  emit('update:available', latest);
}

/** The app to replace: the running bundle (macOS), the AppImage (Linux); Windows runs the installer. Test: OLYMPUS_UPDATE_TARGET. */
function installTarget(): string | undefined {
  if (fromStore()) return undefined; // the Store owns this copy: never run the GitHub installer over it
  if (process.env.OLYMPUS_UPDATE_TARGET) return process.env.OLYMPUS_UPDATE_TARGET;
  if (!app.isPackaged) return undefined; // a dev run is Electron.app in node_modules: never replace that
  if (process.platform === 'darwin') return bundleOf(process.execPath);
  if (process.platform === 'win32') return process.execPath;
  if (process.platform === 'linux') return process.env.APPIMAGE;
  return undefined;
}

async function check(manual = false): Promise<UpdateCheck> {
  if (manual) noAuto = undefined;
  const s = getSettings();
  // Test-only: a local fake releases server (the E2E sets it; normal runs use GitHub).
  const r = await checkRelease({ current: app.getVersion(), platform: process.platform, arch: process.arch, settings: { ...s, updateMode: mode() }, fetch, url: process.env.OLYMPUS_UPDATE_URL, store: fromStore() });
  lastCheck = { at: Date.now(), text: r.text, ...(r.managed ? { managed: r.managed } : {}) };
  if (!r.info) {
    if (!job && !ready) show(null);
  } else if (ready?.version === r.info.version) show({ ...r.info, state: 'ready' });
  else if (job?.version !== r.info.version) {
    show(r.info);
    if (mode() === 'auto' && r.release) await autoDownload(r.info, r.release);
  }
  if (mode() === 'auto' && latest?.state === 'ready') lastCheck.text = `Olympus Coder ${latest.version} is downloaded and ready to install.`;
  emit('update:checked', lastCheck);
  return lastCheck;
}

/** Auto mode stopped for this version: keep the plain notice and say why. */
function stop(info: UpdateInfo, problem: string) {
  noAuto = info.version;
  show({ ...info, problem });
}

async function autoDownload(info: UpdateInfo, release: Release) {
  if (noAuto === info.version || job || fromStore()) return;
  const s = getSettings();
  const dir = join(updatesDir(), info.version);
  // Downloaded and checked in an earlier run.
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')) as { version: string; next: string };
    if (saved.version === info.version && existsSync(saved.next)) {
      ready = saved;
      return show({ ...info, state: 'ready' });
    }
  } catch {
    /* not downloaded yet */
  }
  const target = installTarget();
  if (!target) return stop(info, 'Olympus installs updates itself only when it runs as the installed app. Download this one yourself.');
  if (process.platform !== 'win32') {
    try {
      accessSync(dirname(target), constants.W_OK);
    } catch {
      return stop(info, `Olympus cannot write to ${dirname(target)}, so it cannot install the update itself. Download it instead.`);
    }
  }
  const asset = pickInstallAsset(release.assets, process.platform, process.arch);
  if (!asset) return stop(info, 'This release has no file Olympus can install on this computer. Download it yourself.');
  const sumsAsset = (release.assets ?? []).find((a) => /^sha256sums\.txt$/i.test(a.name ?? '') && a.browser_download_url);
  if (!sumsAsset) return stop(info, 'This release has no checksums (SHA256SUMS.txt), so Olympus will not install it by itself. Download it yourself.');
  if (waitForWifi(s.updateWifiOnly, await onWifi(process.platform))) {
    if (lastCheck) lastCheck.text = `Olympus Coder ${info.version} is available. Waiting for Wi-Fi to download it.`;
    return;
  }

  const abort = new AbortController();
  job = { version: info.version, abort };
  show({ ...info, state: 'downloading', received: 0, total: 0 });
  try {
    const res = await fetch(sumsAsset.browser_download_url!, { headers: { 'User-Agent': 'Olympus-Coder-updater' }, signal: abort.signal });
    if (!res.ok) throw new Error(`Could not read the release's checksums (HTTP ${res.status}).`);
    const want = parseSums(await res.text()).get(asset.name!);
    if (!want) throw new Error(`The release's checksums do not list ${asset.name}, so Olympus will not install it by itself. Download it yourself.`);
    const file = join(dir, asset.name!);
    if (!existsSync(file))
      await download(asset.browser_download_url!, file, {
        fetch,
        signal: abort.signal,
        onProgress: (received, total) => job?.version === info.version && show({ ...info, state: 'downloading', received, total }),
      });
    if ((await sha256File(file)) !== want) {
      rmSync(file, { force: true });
      throw new Error('The download did not match its checksum, so it was deleted. Download the update yourself, or press Check now to try again.');
    }
    const next = process.platform === 'darwin' ? await stageMacApp(file, join(dir, 'app'), info.version) : file;
    ready = { version: info.version, next };
    writeFileSync(join(dir, 'ready.json'), JSON.stringify(ready));
    show({ ...info, state: 'ready' });
  } catch (e: any) {
    if (abort.signal.aborted) show(mode() === 'off' ? null : info);
    else stop(info, String(e?.message ?? e));
  } finally {
    if (job?.abort === abort) job = undefined;
  }
}

/** Remove downloads (all, or only this version and older); the backup in previous/ and install.log stay. */
function cleanUp(all = false) {
  try {
    for (const name of readdirSync(updatesDir()))
      if (/^\d+\.\d+\.\d+/.test(name) && (all || compareVersions(name, app.getVersion()) <= 0)) rmSync(join(updatesDir(), name), { recursive: true, force: true });
  } catch {
    /* no updates folder yet */
  }
}

export function startUpdateChecker(fn: Emit) {
  emit = fn;
  cleanUp();
  if (fromStore()) {
    lastCheck = storeCheck(); // no timer: the Store updates this copy
    return;
  }
  const first = Number(process.env.OLYMPUS_UPDATE_DELAY_MS) || FIRST_CHECK_MS;
  timer = setTimeout(function tick() {
    void check();
    timer = setTimeout(tick, EVERY_MS);
  }, first);
  timer.unref?.();
}

/** What the window shows now (a reload, or a phone that just connected). */
export const currentUpdate = () => (mode() === 'off' || fromStore() ? null : latest);

/** Settings → "Check now": the result line. */
export const checkNow = () => check(true);
export const lastUpdateCheck = () => lastCheck ?? (fromStore() ? storeCheck() : null);

/** "Not now" on the notice: this version is not shown again; a later one is. */
export function skipUpdate(version: string) {
  updateSettings({ skippedUpdate: version });
  if (latest?.version === version) {
    if (job?.version === version) job.abort.abort();
    show(null);
  }
}

/** Cancel on the download progress: stop it (the part file stays for a later resume) and keep the plain notice. */
export function cancelDownload() {
  if (!job) return;
  noAuto = job.version;
  job.abort.abort();
}

/** Restart on "ready": quit, and the helper installs and relaunches once the app has exited. */
export function installAndRestart() {
  if (fromStore()) throw new Error(STORE_UPDATE_TEXT);
  if (!ready) throw new Error('No update is ready to install.');
  installOnExit = { relaunch: true };
  app.quit();
}

/** Called on `will-quit` (the quit is certain): start the install helper when Restart was pressed, or on a plain
 *  quit in auto mode with "Install when I quit" on. Returns true when the helper was started. */
export function onAppWillQuit(): boolean {
  if (!ready || fromStore()) return false;
  const s = getSettings();
  const plan = installOnExit ?? (mode() === 'auto' && s.updateInstallOnQuit !== false ? { relaunch: false } : undefined);
  if (!plan) return false;
  const target = installTarget() ?? '';
  startHelper({ platform: process.platform, pid: process.pid, target, next: ready.next, dir: updatesDir(), relaunch: plan.relaunch });
  ready = undefined;
  return true;
}

/** Settings → Updates changed. Off: stop and delete downloads, hide the notice. Notify: stop downloading. Then check. */
export function updateSettingChanged() {
  const m = mode();
  if (m !== 'auto') {
    job?.abort.abort();
    ready = undefined;
    if (m === 'off') {
      cleanUp(true);
      return show(null);
    }
    if (latest) show({ version: latest.version, pageUrl: latest.pageUrl, downloadUrl: latest.downloadUrl });
  }
  void check(true);
}
