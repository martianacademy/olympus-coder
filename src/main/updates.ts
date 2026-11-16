import { app } from 'electron';
import type { DeskEvents, Settings, UpdateInfo } from '@shared/types';
import { getSettings, updateSettings } from './store';

/**
 * "A new version is available": looks at the latest GitHub release at startup (after ~30 s) and once a day, and
 * tells the window (and phones) when it is newer than this app. Nothing is downloaded or installed: the notice
 * links to the release page and to the installer for this platform, opened in the browser.
 */

const REPO = 'martianacademy/olympus-coder';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 24 * 60 * 60 * 1000;

interface Release {
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
  settings: Pick<Settings, 'checkForUpdates' | 'skippedUpdate'>;
  fetch: typeof fetch;
  url?: string;
}

/** The newer release to tell the user about, or null (none, skipped, checking off, or GitHub not reachable). */
export async function findUpdate(d: CheckDeps): Promise<UpdateInfo | null> {
  if (d.settings.checkForUpdates === false) return null;
  let r: Release;
  try {
    const res = await d.fetch(d.url ?? RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Olympus-Coder-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
    // 403 (rate limit), 404 (no release yet), 5xx: try again next time, quietly.
    if (!res.ok) return null;
    r = (await res.json()) as Release;
  } catch {
    return null; // offline, timeout, bad JSON
  }
  if (!r || r.draft || r.prerelease || !r.tag_name || !parse(r.tag_name) || parse(r.tag_name)![3]) return null;
  const version = r.tag_name.replace(/^v/, '');
  if (compareVersions(version, d.current) <= 0) return null;
  if (d.settings.skippedUpdate && compareVersions(version, d.settings.skippedUpdate) === 0) return null;
  const pageUrl = r.html_url && /^https:\/\//.test(r.html_url) ? r.html_url : `https://github.com/${REPO}/releases/latest`;
  return { version, pageUrl, downloadUrl: pickAsset(r.assets, d.platform, d.arch) ?? pageUrl };
}

// ------------------------------------------------------------------ the app's checker

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};
let latest: UpdateInfo | null = null;
let timer: NodeJS.Timeout | undefined;

async function check() {
  // Test-only: a local fake releases server (the E2E sets it; normal runs use GitHub).
  const found = await findUpdate({ current: app.getVersion(), platform: process.platform, arch: process.arch, settings: getSettings(), fetch, url: process.env.OLYMPUS_UPDATE_URL });
  if (JSON.stringify(found) === JSON.stringify(latest)) return;
  latest = found;
  emit('update:available', latest);
}

export function startUpdateChecker(fn: Emit) {
  emit = fn;
  const first = Number(process.env.OLYMPUS_UPDATE_DELAY_MS) || FIRST_CHECK_MS;
  timer = setTimeout(function tick() {
    void check();
    timer = setTimeout(tick, EVERY_MS);
  }, first);
  timer.unref?.();
}

/** What the window shows now (a reload, or a phone that just connected). */
export const currentUpdate = () => (getSettings().checkForUpdates === false ? null : latest);

/** "Not now" on the notice: this version is not shown again; a later one is. */
export function skipUpdate(version: string) {
  updateSettings({ skippedUpdate: version });
  if (latest?.version === version) {
    latest = null;
    emit('update:available', null);
  }
}

/** Settings → General → "Check for updates" changed: check now when turned on, hide the notice when off. */
export function updateSettingChanged() {
  if (getSettings().checkForUpdates === false) {
    if (latest) emit('update:available', (latest = null));
  } else void check();
}
