import { app } from 'electron';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { RemoteDevice, RemoteStatus } from '@shared/types';
import { checkPassword, isLockEnabled, onLockChange } from './lock';
import { getSettings, updateSettings } from './store';
import { EVENTS, addDevice, deleteDevice, deviceByToken, listDevices, onDeviceRemoved, remoteCall, remoteSnapshot, setHandlers } from './remotecore';
import { relayBroadcast, relayStatus, resetRelayLink, restartRelay, startRelay, stopRelay } from './relay';
import { RemoteStream } from './remoteStream';
import { cachedTailscaleInfo, detectLanInfo, macosFirewallStatus, promptAllowInFirewall, refreshTailscaleInfo, runTailscaleServe } from './remoteNet';

/**
 * Local / LAN / Tailscale HTTP + SSE server for the unified responsive Olympus app.
 *
 * - By default listens on `127.0.0.1:port` (for local testing or Tailscale Serve HTTPS).
 * - When `settings.remote.lan` is enabled, listens dual-stack on `[::]:port` (`ipv6Only: false`, falling back to
 *   `0.0.0.0:port`) so iPhones/Android phones on the same Wi-Fi or iPhone Personal Hotspot can connect over IPv4,
 *   IPv6, or `<MacName>.local` Bonjour mDNS without external setup.
 * - Pairing uses a 6-digit one-time code (auto-embedded in the LAN QR `#pair=` fragment) AND, whenever an Olympus
 *   app password is set, the Olympus app password.
 */

export { detectLanInfo } from './remoteNet';

type Handlers = Record<string, (...args: any[]) => unknown>;

let isLocked: () => boolean = () => false;
let server: Server | undefined;
let boundLan = false;
/** Open event streams: the phone's device id, the connection id it names in `/api/view`, and its event filter. */
interface Client {
  devId: string;
  conn: string;
  stream: RemoteStream;
}
const clients = new Map<ServerResponse, Client>();
/** Paired devices that entered the app password since the Mac last locked. */
const unlockedSessions = new Set<string>();
let pairing: { code: string; expiresAt: number; attempts: number } | undefined;

onLockChange((s) => {
  if (s.locked) unlockedSessions.clear();
  for (const [res, { devId }] of clients.entries()) {
    const lockedForDevice = s.locked && !unlockedSessions.has(devId);
    res.write(`data: ${JSON.stringify(['lock:state', { ...s, locked: lockedForDevice }])}\n\n`);
  }
});

onDeviceRemoved((id) => {
  if (id === null) unlockedSessions.clear();
  else unlockedSessions.delete(id);
  for (const [res, { devId, stream }] of clients.entries()) {
    if (id === null || devId === id) {
      stream.dispose();
      res.end();
      clients.delete(res);
    }
  }
});

function deviceFor(req: IncomingMessage, url: URL): RemoteDevice | undefined {
  return deviceByToken((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '');
}

const isDeviceLocked = (deviceId: string) => isLocked() && !unlockedSessions.has(deviceId);

const json = (res: ServerResponse, code: number, body: unknown, headOnly = false) => {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  });
  res.end(headOnly ? undefined : payload);
};

// Phones on Wi-Fi: big answers (the app's scripts, a whole chat) are sent gzip'd. Measured 2026-11-16 at ~5 Mbit/s:
// the page took 8 s to load uncompressed (one 3.6 MB script).
const gz = promisify(gzip);
const acceptsGzip = (req: IncomingMessage) => /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

/** JSON, gzip'd (off the main thread) when it is big and the phone accepts it. */
async function bigJson(req: IncomingMessage, res: ServerResponse, code: number, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const zip = raw.byteLength > 8 * 1024 && acceptsGzip(req);
  const payload = zip ? await gz(raw, { level: 4 }) : raw;
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...(zip ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, max = 25 * 1024 * 1024): Promise<any> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new Error('Request payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        fail(e);
      }
    });
    req.on('error', fail);
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const rendererDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '../renderer');

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.ttf']);
/** gzip'd static files, by path + size + mtime (the built files never change while the app runs). */
const gzCache = new Map<string, Promise<Buffer>>();

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, headOnly: boolean) {
  const rel = pathname === '/' || pathname === '/index.html' ? 'remote.html' : decodeURIComponent(pathname.slice(1));
  if (!/^(remote\.html|assets\/[\w.@+$~-]+|remote-sw\.js|remote\.webmanifest|remote-icon-\d+\.png|fonts\/[\w.@+$~-]+)$/.test(rel)) {
    return json(res, 404, { error: 'Not found' }, headOnly);
  }
  const root = rendererDir();
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'Not found' }, headOnly);
  const st = statSync(file);
  const zip = COMPRESSIBLE.has(extname(file)) && st.size > 1024 && acceptsGzip(req);
  let buf: Buffer;
  if (zip) {
    const key = `${file}:${st.size}:${st.mtimeMs}`;
    let z = gzCache.get(key);
    if (!z) {
      z = gz(readFileSync(file), { level: 6 });
      gzCache.set(key, z);
      z.catch(() => gzCache.delete(key));
    }
    buf = await z;
  } else buf = readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': String(buf.byteLength),
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    ...(zip ? { 'content-encoding': 'gzip' } : {}),
    ...(COMPRESSIBLE.has(extname(file)) ? { vary: 'accept-encoding' } : {}),
  });
  res.end(headOnly ? undefined : buf);
}

async function onRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const isHead = req.method === 'HEAD';
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && !isHead) return json(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res, p, isHead);
    }
    if (p === '/api/auth-info' && (req.method === 'GET' || isHead)) {
      return json(res, 200, { passwordRequired: isLockEnabled() }, isHead);
    }
    if (p === '/api/pair' && req.method === 'POST') {
      if (req.headers['x-olympus'] !== '1') return json(res, 400, { error: 'Bad request' });
      const body = await readBody(req, 8192);
      if (!pairing || Date.now() > pairing.expiresAt) {
        return json(res, 410, { error: 'No pairing code is active. Open Settings → Phone on your Mac and press "Pair a phone".' });
      }
      if (++pairing.attempts > 5) {
        pairing = undefined;
        return json(res, 429, { error: 'Too many wrong codes. Start pairing again on your Mac.' });
      }
      if (String(body.code ?? '').trim() !== pairing.code) return json(res, 403, { error: 'That code is not right.' });
      if (isLockEnabled()) {
        const pw = checkPassword(String(body.password ?? ''));
        if (!pw.ok) return json(res, 403, { error: pw.error || 'Enter your Olympus app password.' });
      }
      pairing = undefined;
      const { token, device } = addDevice(String(body.name ?? 'Phone'), 'local');
      unlockedSessions.add(device.id);
      return json(res, 200, { token, deviceId: device.id });
    }

    const device = deviceFor(req, url);
    if (!device) return json(res, 401, { error: 'This phone is not paired (or was removed). Pair it again.' }, isHead);

    if (p === '/api/unlock' && req.method === 'POST') {
      if (req.headers['x-olympus'] !== '1') return json(res, 400, { error: 'Bad request' });
      const body = await readBody(req, 4096);
      if (!isLockEnabled()) {
        return json(res, 423, { error: 'Olympus Coder is locked on your Mac. Unlock it there first.' });
      }
      const pw = checkPassword(String(body.password ?? ''));
      if (!pw.ok) return json(res, 403, { error: pw.error || 'Incorrect password.' });
      unlockedSessions.add(device.id);
      for (const [c, { devId }] of clients.entries()) {
        if (devId === device.id) c.write(`data: ${JSON.stringify(['lock:state', { locked: false }])}\n\n`);
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const conn = randomBytes(9).toString('base64url');
      res.write(`event: hello\ndata: ${JSON.stringify({ locked: isDeviceLocked(device.id), passwordSet: isLockEnabled(), conn })}\n\n`);
      res.socket?.setNoDelay(true);
      const devId = device.id;
      // Merged per item / terminal, at most one write every 40 ms (the first one at once).
      const stream = new RemoteStream((batch) => {
        if (isDeviceLocked(devId) || res.destroyed) return false;
        let text = '';
        for (const [ch, p] of batch) text += `data: ${JSON.stringify([ch, p])}\n\n`;
        res.write(text);
        return true;
      }, 40);
      clients.set(res, { devId, conn, stream });
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        stream.dispose();
        clients.delete(res);
      });
      return;
    }

    if (p === '/api/view' && req.method === 'POST') {
      // What this phone shows (chats, terminals): see remoteStream.ts.
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON only' });
      const body = await readBody(req, 64 * 1024);
      const c = [...clients.values()].find((x) => x.conn === body.conn && x.devId === device.id);
      if (!c) return json(res, 404, { error: 'No such event stream' });
      c.stream.setView(body);
      return json(res, 200, { ok: true });
    }

    if (isDeviceLocked(device.id)) {
      return json(res, 423, { error: 'Olympus Coder is locked. Enter your app password to continue.', passwordSet: isLockEnabled() }, isHead);
    }
    if (p === '/api/me') return json(res, 200, { device: { id: device.id, name: device.name }, version: app.getVersion() }, isHead);
    if (p === '/api/state') return json(res, 200, remoteSnapshot(), isHead);
    if (p === '/api/call' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON only' });
      const body = await readBody(req);
      const r = await remoteCall(String(body.method ?? ''), body.args);
      if (r.forbidden) return json(res, 403, { error: r.error });
      return await bigJson(req, res, 200, r);
    }
    return json(res, 404, { error: 'Not found' }, isHead);
  } catch (e: any) {
    return json(res, 500, { error: e?.message ?? String(e) }, isHead);
  }
}

export function remoteBroadcast(channel: string, payload: unknown) {
  relayBroadcast(channel, payload);
  if (!clients.size || !EVENTS.has(channel)) return;
  for (const { devId, stream } of clients.values()) {
    if (!isDeviceLocked(devId)) stream.push(channel, payload);
  }
}

function listenOnce(port: number, opts: { host: string; ipv6Only?: boolean }): Promise<Server> {
  return new Promise((ok, fail) => {
    const s = createServer((req, res) => void onRequest(req, res));
    s.once('error', fail);
    s.listen({ port, ...opts }, () => ok(s));
  });
}

async function start(): Promise<void> {
  const rem = getSettings().remote;
  const port = rem?.port ?? 47816;
  const wantLan = Boolean(rem?.lan);
  if (!wantLan) {
    server = await listenOnce(port, { host: '127.0.0.1' });
    boundLan = false;
    return;
  }
  try {
    server = await listenOnce(port, { host: '::', ipv6Only: false });
  } catch {
    server = await listenOnce(port, { host: '0.0.0.0' });
  }
  boundLan = true;
}

function stop(): Promise<void> {
  for (const [c, { stream }] of clients.entries()) {
    stream.dispose();
    c.end();
  }
  clients.clear();
  const s = server;
  server = undefined;
  boundLan = false;
  if (!s) return Promise.resolve();
  return new Promise((ok) => s.close(() => ok()));
}

function ensureActivePairing() {
  if (!pairing || Date.now() > pairing.expiresAt) {
    pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + 5 * 60_000, attempts: 0 };
  }
}

export async function initRemote(h: Handlers, locked: () => boolean) {
  setHandlers(h);
  isLocked = locked;
  const rem = getSettings().remote;
  if (rem?.enabled) {
    startRelay();
    if (rem.lan && !listDevices().some((d) => d.via === 'local')) ensureActivePairing();
    await start().catch(() => {});
  }
}

export async function setRemoteEnabled(on: boolean): Promise<RemoteStatus> {
  const prev = getSettings().remote;
  updateSettings({ remote: { ...prev, port: prev?.port ?? 47816, enabled: on } } as any);
  if (on) {
    startRelay();
    if (!server) await start().catch(() => {});
  } else {
    stopRelay();
    await stop();
  }
  return remoteStatus();
}

export async function setRemoteLan(on: boolean): Promise<RemoteStatus> {
  const prev = getSettings().remote;
  updateSettings({ remote: { ...prev, port: prev?.port ?? 47816, enabled: Boolean(prev?.enabled), lan: on } } as any);
  if (on) ensureActivePairing();
  if (prev?.enabled && (!server || boundLan !== on)) {
    await stop();
    await start().catch(() => {});
  }
  return remoteStatus();
}

export async function allowInFirewall(): Promise<RemoteStatus> {
  await promptAllowInFirewall();
  return remoteStatus();
}

export function setRelayUrl(url: string): Promise<RemoteStatus> {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean && !/^https:\/\/[^\s/]+$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(clean)) {
    throw new Error('Use an https:// address (only the host, no path).');
  }
  updateSettings({ remote: { ...getSettings().remote, relayUrl: clean } } as any);
  restartRelay();
  return remoteStatus();
}

export function resetPhoneLink(): Promise<RemoteStatus> {
  resetRelayLink();
  return remoteStatus();
}

export function startPairing(): RemoteStatus | Promise<RemoteStatus> {
  pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + 5 * 60_000, attempts: 0 };
  return remoteStatus();
}

export function removeDevice(id: string): Promise<RemoteStatus> {
  deleteDevice(id);
  return remoteStatus();
}

export async function checkTailscale(): Promise<RemoteStatus> {
  await refreshTailscaleInfo(getSettings().remote?.port ?? 47816);
  return remoteStatus();
}

export async function tailscaleServe(): Promise<RemoteStatus> {
  await runTailscaleServe(getSettings().remote?.port ?? 47816);
  return remoteStatus();
}

export async function remoteStatus(): Promise<RemoteStatus> {
  const rem = getSettings().remote;
  const port = rem?.port ?? 47816;
  const lan = Boolean(rem?.lan);
  const lanInfo = lan ? detectLanInfo(port) : { urls: [], hotspotDetected: false };
  const firewall = lan ? await macosFirewallStatus() : undefined;
  return {
    enabled: Boolean(rem?.enabled),
    running: Boolean(server),
    port,
    lan,
    lanUrls: lanInfo.urls,
    hotspotDetected: lanInfo.hotspotDetected,
    firewall,
    localUrl: `http://127.0.0.1:${port}`,
    tailscale: cachedTailscaleInfo(port),
    devices: listDevices(),
    relay: relayStatus(),
    pairing: pairing && Date.now() < pairing.expiresAt ? { code: pairing.code, expiresAt: pairing.expiresAt } : undefined,
  };
}

export const stopRemote = () => {
  stopRelay();
  void stop();
};
