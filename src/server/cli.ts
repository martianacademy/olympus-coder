/**
 * Headless Olympus Coder Server CLI (`olympus-server` / `node out/server/index.mjs`).
 *
 * Boots the exact same Olympus Coder backend (18+ ACP coding agents, shared `~/.olympus` memory,
 * CodeMirror files API, Git & Worktrees, shadow-git checkpoints, live PTY terminals, schedules,
 * sub-sessions, and E2EE Cloudflare Relay + LAN HTTP server) in pure Node.js — zero Electron,
 * zero GUI/X11, designed for headless Linux VPS / cloud servers and remote phone/browser access.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import QRCode from 'qrcode';

interface CliOptions {
  port: number;
  lan: boolean;
  relay: boolean;
  relayUrl?: string;
  password?: string;
  dataDir?: string;
  sharedDir?: string;
  project?: string;
  showQr: boolean;
  printSystemd: boolean;
  printLaunchd: boolean;
  help: boolean;
}

export function parseServeArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: Number(process.env.OLYMPUS_SERVER_PORT || 47816),
    lan: process.env.OLYMPUS_SERVER_LAN === '1',
    relay: process.env.OLYMPUS_SERVER_NO_RELAY !== '1',
    relayUrl: process.env.OLYMPUS_RELAY_URL?.trim() || undefined,
    password: process.env.OLYMPUS_SERVER_PASSWORD?.trim() || undefined,
    dataDir: process.env.OLYMPUS_SERVER_DATA?.trim() || undefined,
    sharedDir: process.env.OLYMPUS_HOME?.trim() || undefined,
    project: undefined,
    showQr: true,
    printSystemd: false,
    printLaunchd: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'serve') continue;
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--lan') opts.lan = true;
    else if (a === '--relay') opts.relay = true;
    else if (a === '--no-relay') opts.relay = false;
    else if (a === '--no-qr') opts.showQr = false;
    else if (a === '--print-systemd') opts.printSystemd = true;
    else if (a === '--print-launchd') opts.printLaunchd = true;
    else if ((a === '-p' || a === '--port') && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (a === '--relay-url' && argv[i + 1]) opts.relayUrl = argv[++i];
    else if (a === '--password' && argv[i + 1]) opts.password = argv[++i];
    else if (a === '--data' && argv[i + 1]) opts.dataDir = argv[++i];
    else if (a === '--shared' && argv[i + 1]) opts.sharedDir = argv[++i];
    else if (a === '--project' && argv[i + 1]) opts.project = argv[++i];
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid --port value: ${opts.port}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Olympus Coder — Headless Server (pure Node.js, zero GUI/Electron)

Usage:
  olympus-server [serve] [options]

Options:
  -p, --port <port>       Local HTTP port (default: 47816)
      --lan               Bind to all interfaces (0.0.0.0 / ::) for LAN / Wi-Fi pairing
      --relay             Connect to the E2EE Cloudflare Relay for phone/browser access (default)
      --no-relay          Local/LAN only — disable outbound E2EE Relay WebSocket
      --relay-url <url>   Use a self-hosted Olympus Relay Worker URL (https://...)
      --password <pass>   Set/update the Olympus app password (min 4 chars; also OLYMPUS_SERVER_PASSWORD)
      --project <dir>     Auto-register a project folder on startup (e.g. --project .)
      --data <dir>        Server state directory (default: ~/.olympus/server)
      --shared <dir>      Shared memory & threads directory (default: ~/.olympus)
      --no-qr             Do not render ASCII QR code in terminal output
      --print-systemd     Print a ready-to-use Linux systemd --user service unit and exit
      --print-launchd     Print a ready-to-use macOS launchd plist and exit
  -h, --help              Show this help message
`);
}

function renderSystemdUnit(opts: CliOptions): string {
  const execPath = process.execPath;
  const scriptPath = resolve(process.argv[1] || 'out/server/index.mjs');
  const flags = [
    `--port ${opts.port}`,
    opts.lan ? '--lan' : '',
    opts.relay ? '--relay' : '--no-relay',
    opts.relayUrl ? `--relay-url ${opts.relayUrl}` : '',
    '--no-qr',
  ]
    .filter(Boolean)
    .join(' ');
  return `[Unit]
Description=Olympus Coder Headless Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execPath} ${scriptPath} serve ${flags}
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}

[Install]
WantedBy=default.target
`;
}

function renderLaunchdPlist(opts: CliOptions): string {
  const execPath = process.execPath;
  const scriptPath = resolve(process.argv[1] || 'out/server/index.mjs');
  const args = [execPath, scriptPath, 'serve', '--port', String(opts.port), opts.relay ? '--relay' : '--no-relay', '--no-qr'];
  if (opts.lan) args.push('--lan');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.olympuscoder.server</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

async function promptHiddenPassword(promptText: string): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  try {
    process.stdout.write(promptText);
    muted = true;
    const ans = (await rl.question('')).trim();
    process.stdout.write('\n');
    return ans;
  } finally {
    muted = false;
    rl.close();
  }
}

async function main() {
  const opts = parseServeArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.printSystemd) {
    console.log(renderSystemdUnit(opts));
    return;
  }
  if (opts.printLaunchd) {
    console.log(renderLaunchdPlist(opts));
    return;
  }

  // Must be set BEFORE dynamically importing the shared main backend so electronShim & index.ts boot headless.
  process.env.OLYMPUS_HEADLESS = '1';
  if (opts.dataDir) process.env.OLYMPUS_SERVER_DATA = resolve(opts.dataDir);
  if (opts.sharedDir) process.env.OLYMPUS_HOME = resolve(opts.sharedDir);

  const [store, lock, remote, relay, mainMod] = await Promise.all([
    import('../main/store'),
    import('../main/lock'),
    import('../main/remote'),
    import('../main/relay'),
    import('../main/index'),
  ]);

  // 1. Ensure an Olympus app password exists (required for E2EE Relay phone access).
  let generatedPassword: string | undefined;
  if (opts.password) {
    if (opts.password.length < 4) throw new Error('Password must be at least 4 characters.');
    if (!lock.isLockEnabled()) {
      const r = lock.setPassword(null, opts.password);
      if (!r.ok) throw new Error(r.error || 'Could not set password.');
    }
  } else if (opts.relay && !lock.isLockEnabled()) {
    if (process.stdin.isTTY) {
      console.log('\nOlympus Server needs an app password to protect remote phone/browser access.');
      const chosen = await promptHiddenPassword('Create app password (min 4 chars, Enter to auto-generate): ');
      const pass = chosen.length >= 4 ? chosen : randomBytes(9).toString('base64url');
      if (chosen.length < 4) generatedPassword = pass;
      const r = lock.setPassword(null, pass);
      if (!r.ok) throw new Error(r.error || 'Could not set password.');
    } else {
      generatedPassword = randomBytes(9).toString('base64url');
      const r = lock.setPassword(null, generatedPassword);
      if (!r.ok) throw new Error(r.error || 'Could not set password.');
    }
  }

  // 2. Persist requested remote settings & optional startup project before remote server starts.
  const prevRemote = store.getSettings().remote;
  store.updateSettings({
    onboarded: true,
    remote: {
      ...prevRemote,
      enabled: true,
      port: opts.port,
      lan: opts.lan,
      ...(opts.relayUrl ? { relayUrl: opts.relayUrl.replace(/\/+$/, '') } : {}),
    } as any,
  });

  if (opts.project) {
    const absProj = resolve(opts.project);
    if (!existsSync(absProj)) mkdirSync(absProj, { recursive: true });
    const existing = store.listProjects().find((p) => p.path === absProj);
    if (!existing) store.addProject(absProj);
  }

  // 3. Boot the shared Olympus Coder backend (identical handlers to the desktop app, zero GUI).
  await mainMod.readyForHeadless?.();
  if (!opts.relay) relay.stopRelay();

  // Wait briefly for relay WebSocket handshake when relay mode is enabled.
  if (opts.relay) {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline && relay.relayStatus().state !== 'online') {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const pairStatus = await remote.startPairing();
  const status = await remote.remoteStatus();
  const phoneLink = opts.relay ? relay.relayLink() : undefined;

  console.log('\n⚡ Olympus Coder Headless Server is running\n');
  console.log(`  Local URL    : ${status.localUrl}`);
  if (status.lan && status.lanUrls.length) {
    console.log(`  LAN URL(s)   : ${status.lanUrls.join(', ')}`);
  }
  if (pairStatus.pairing?.code) {
    console.log(`  Pairing Code : ${pairStatus.pairing.code} (valid 5 min)`);
    console.log(`  Quick Pair   : ${status.localUrl}/#pair=${pairStatus.pairing.code}`);
  }
  if (phoneLink) {
    console.log(`  E2EE Relay   : ${phoneLink}`);
    console.log(`  Relay State  : ${status.relay?.state ?? 'connecting'}`);
  }
  if (generatedPassword) {
    console.log(`\n  Generated App Password (save this!): ${generatedPassword}`);
  }
  console.log(`  Shared Dir   : ${store.sharedRoot()}`);
  console.log(`  Home Dir     : ${homedir()}`);

  if (opts.showQr) {
    const qrTarget = phoneLink || (status.lanUrls[0] ? `${status.lanUrls[0]}/#pair=${pairStatus.pairing?.code ?? ''}` : `${status.localUrl}/#pair=${pairStatus.pairing?.code ?? ''}`);
    try {
      const ascii = await QRCode.toString(qrTarget, { type: 'terminal', small: true });
      console.log(`\n  Scan on your phone (${phoneLink ? 'E2EE Relay — works from anywhere' : 'Local / LAN'}):\n`);
      console.log(ascii);
    } catch {
      /* ignore QR rendering error on exotic terminals */
    }
  }
  console.log('  Press Ctrl+C to stop cleanly.\n');

  const shutdown = () => {
    console.log('\nStopping Olympus Coder Headless Server…');
    void import('electron').then(({ app }) => app.quit());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Olympus Server failed:', err?.message ?? err);
  process.exit(1);
});
