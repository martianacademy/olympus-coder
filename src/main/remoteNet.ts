import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { RemoteStatus } from '@shared/types';

/**
 * Network interface discovery, macOS Application Firewall (`socketfilterfw`) inspection/registration,
 * and opt-in Tailscale Serve helpers for `src/main/remote.ts`.
 */

const VIRTUAL_IFACE = /^(lo|utun|tun|tap|ppp|wg|ipsec|gif|stf|awdl|llw|anpi|ap\d|vboxnet|vmnet|docker|br-|veth)/i;
let bonjourCache: string | undefined;

export const execBin = (bin: string, args: string[], timeout = 8000) =>
  new Promise<{ ok: boolean; out: string; err: string }>((ok) =>
    execFile(bin, args, { timeout, windowsHide: true }, (e, out, err) => ok({ ok: !e, out: String(out ?? ''), err: String(err || (e?.message ?? '')) })),
  );

function localBonjourHost(): string {
  if (bonjourCache !== undefined) return bonjourCache;
  let raw = '';
  if (process.platform === 'darwin') {
    try {
      raw = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 1500 }).trim();
    } catch {
      raw = '';
    }
  }
  if (!raw) raw = hostname().replace(/\.local\.?$/i, '').trim();
  bonjourCache = /^[a-z0-9-]+$/i.test(raw) ? `${raw.toLowerCase()}.local` : '';
  return bonjourCache;
}

/**
 * Real LAN / Wi-Fi / Hotspot URLs on this machine, excluding VPN point-to-point tunnels (`utun*`, `/32`, zero MAC)
 * so Cloudflare WARP / WireGuard virtual IPs (such as `172.16.0.2`) never mask the real `en0` Wi-Fi/Hotspot IP.
 */
export function detectLanInfo(
  port: number,
  nets: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  mdnsHost = localBonjourHost(),
): { urls: string[]; hotspotDetected: boolean } {
  const candidates: { ip: string; iface: string }[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal || !info.address) continue;
      if (info.netmask === '255.255.255.255' || info.mac === '00:00:00:00:00:00') continue;
      if (info.address.startsWith('169.254.')) continue;
      candidates.push({ ip: info.address, iface: name });
    }
  }
  const ifaceRank = (n: string) => (/^en[01]$/i.test(n) ? 0 : /^(en\d+|eth\d+|wlan\d+|wi-?fi)/i.test(n) ? 1 : 2);
  const ipRank = (ip: string) => (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1);
  candidates.sort((a, b) => ifaceRank(a.iface) - ifaceRank(b.iface) || ipRank(a.ip) - ipRank(b.ip) || a.ip.localeCompare(b.ip));

  const ips = [...new Set(candidates.map((c) => c.ip))];
  const urls = ips.map((ip) => `http://${ip}:${port}`);
  if (ips.length && mdnsHost) {
    const mdnsUrl = `http://${mdnsHost}:${port}`;
    if (!urls.includes(mdnsUrl)) urls.splice(1, 0, mdnsUrl);
  }
  return {
    urls,
    hotspotDetected: ips.some((ip) => ip.startsWith('172.20.10.')),
  };
}

// ---- macOS Application Firewall (`socketfilterfw`) ----

const SOCKET_FILTER_FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';
let fwCache: { at: number; info: RemoteStatus['firewall'] } | undefined;

function currentAppBundlePath(): string {
  const exe = process.execPath;
  const idx = exe.indexOf('.app/Contents/MacOS/');
  return idx > 0 ? exe.slice(0, idx + 4) : exe;
}

export async function macosFirewallStatus(): Promise<RemoteStatus['firewall']> {
  if (process.platform !== 'darwin' || !existsSync(SOCKET_FILTER_FW)) return undefined;
  if (fwCache && Date.now() - fwCache.at < 8000) return fwCache.info;
  const appPath = currentAppBundlePath();
  const st = await execBin(SOCKET_FILTER_FW, ['--getglobalstate'], 3000);
  const stateMatch = /State\s*=\s*(\d+)/i.exec(st.out);
  const stateNum = stateMatch ? Number(stateMatch[1]) : 0;
  if (stateNum === 0) {
    const info = { active: false, allowed: true, appPath };
    fwCache = { at: Date.now(), info };
    return info;
  }
  if (stateNum >= 2) {
    const info = { active: true, allowed: false, appPath };
    fwCache = { at: Date.now(), info };
    return info;
  }
  const list = await execBin(SOCKET_FILTER_FW, ['--listapps'], 4000);
  const lines = list.out.split(/\r?\n/);
  let explicit: 'allow' | 'block' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes(appPath) || l.includes(process.execPath)) {
      const next = `${l} ${lines[i + 1] ?? ''}`;
      if (/Allow incoming connections/i.test(next)) explicit = 'allow';
      else if (/Block incoming connections/i.test(next)) explicit = 'block';
      break;
    }
  }
  let allowed = explicit === 'allow';
  if (explicit === null) {
    // Apple-notarized / Developer ID apps pass automatically when allowsigned is on; ad-hoc signed builds do not.
    const cs = await execBin('/usr/bin/codesign', ['-dv', appPath], 3000);
    const sigInfo = `${cs.out}\n${cs.err}`;
    const hasDeveloperTeam = /TeamIdentifier=(?!not set)\S+/.test(sigInfo) && !/Signature=adhoc/i.test(sigInfo);
    allowed = hasDeveloperTeam;
  }
  const info = { active: true, allowed, appPath };
  fwCache = { at: Date.now(), info };
  return info;
}

/** Prompts the user on macOS (Touch ID / admin password) to allow incoming LAN connections for Olympus Coder. */
export async function promptAllowInFirewall(): Promise<void> {
  if (process.platform !== 'darwin' || !existsSync(SOCKET_FILTER_FW)) return;
  const appPath = currentAppBundlePath();
  const exePath = process.execPath;
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const shellCmd =
    `${SOCKET_FILTER_FW} --add ${q(appPath)} --unblockapp ${q(appPath)}` +
    (exePath !== appPath ? ` && ${SOCKET_FILTER_FW} --add ${q(exePath)} --unblockapp ${q(exePath)}` : '');
  const osaScript = `do shell script ${JSON.stringify(shellCmd)} with administrator privileges`;
  const r = await execBin('/usr/bin/osascript', ['-e', osaScript], 60_000);
  if (!r.ok && !/User canceled/i.test(r.err)) {
    throw new Error(r.err.trim() || 'Could not update macOS Firewall.');
  }
  fwCache = undefined;
}

// ---- Tailscale (opt-in only; never auto-polled) ----

const TAILSCALE = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'tailscale',
];
const tailscaleBin = () => TAILSCALE.find((p) => (p === 'tailscale' ? false : existsSync(p))) ?? 'tailscale';

let tsCache: { at: number; port: number; info: RemoteStatus['tailscale'] } | undefined;

export const cachedTailscaleInfo = (port: number) => (tsCache?.port === port ? tsCache.info : undefined);

export async function refreshTailscaleInfo(port: number): Promise<RemoteStatus['tailscale']> {
  const bin = tailscaleBin();
  const serveCommand = `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;
  const st = await execBin(bin, ['status', '--json']);
  let info: RemoteStatus['tailscale'];
  if (!st.ok && /ENOENT|not found/i.test(st.err)) {
    info = { installed: false, running: false, serving: false, serveCommand };
  } else {
    let status: any = {};
    try {
      status = JSON.parse(st.out);
      const dnsName = String(status?.Self?.DNSName ?? '').replace(/\.$/, '') || undefined;
      const running = status?.BackendState === 'Running';
      const sv = await execBin(bin, ['serve', 'status', '--json']);
      const serving = sv.ok && new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(sv.out);
      info = { installed: true, running, dnsName, serving, url: dnsName ? `https://${dnsName}` : undefined, serveCommand };
    } catch {
      info = { installed: true, running: false, serving: false, serveCommand, error: st.err.trim().split('\n')[0] || undefined };
    }
  }
  tsCache = { at: Date.now(), port, info };
  return info;
}

export async function runTailscaleServe(port: number): Promise<void> {
  const r = await execBin(tailscaleBin(), ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
  if (!r.ok) throw new Error(r.err.trim() || 'Tailscale Serve failed.');
  await refreshTailscaleInfo(port);
}
