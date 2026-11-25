/**
 * Secure loopback-only WebSocket bridge (`127.0.0.1:47819`) connecting the Olympus Chrome Extension
 * (`extensions/olympus-chrome/`) to Olympus Coder's shared `olympus` MCP server (`browserTools.ts`).
 *
 * Zero-pairing security invariants:
 * - Binds strictly to `127.0.0.1` (never reachable from LAN/internet).
 * - Pins the WebSocket `Origin` strictly to Olympus Coder's deterministic MV3 Chrome Extension ID
 *   (`chrome-extension://mblgbbfnfhiaphmdkigkkhadealbpkig`, derived from the public `"key"` in
 *   `extensions/olympus-chrome/manifest.json`). All web origins (`http://`, `https://`) and all
 *   other Chrome extensions are rejected with `403 Forbidden` — zero manual token copy-paste needed!
 * - Zero third-party dependencies (pure RFC 6455 upgrade + frame codec over `node:http` & `node:crypto`).
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserBridgeStatus, DeskEvents } from '@shared/types';
import { sharedRoot } from './store';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PORT = 47819;
const MAX_FRAME_BYTES = 12 * 1024 * 1024; // 12 MB ceiling (screenshots)

/** Deterministic MV3 Extension ID computed from the public SPKI key in `extensions/olympus-chrome/manifest.json`. */
export const OLYMPUS_EXTENSION_ID = 'mblgbbfnfhiaphmdkigkkhadealbpkig';
/** ID the Chrome Web Store assigned to "Olympus Coder Browser" (the Store build has no `key`, so its ID differs). */
export const OLYMPUS_STORE_EXTENSION_ID = 'pnnfodplajfpoicpheoalahclkfoopnl';
const ALLOWED_EXTENSION_IDS = new Set([OLYMPUS_EXTENSION_ID, OLYMPUS_STORE_EXTENSION_ID]);

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let emitFn: Emit = () => {};
let server: Server | undefined;
let boundPort = 0;
let extSocket: Duplex | undefined;
let extInfo: { extensionId?: string; version?: string; connectedAt?: number; paused?: boolean } = {};
let rpcSeq = 0;
const pending = new Map<number, PendingRpc>();

const shotsDir = () => join(sharedRoot(), 'browser-shots');

/** Encodes a single unmasked server→client RFC 6455 frame (opcode 0x1 text, 0x9 ping, 0xA pong, 0x8 close). */
function encodeWsFrame(payload: Buffer, opcode = 0x1): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendJson(socket: Duplex, obj: unknown) {
  if (socket.destroyed) return;
  socket.write(encodeWsFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
}

function rejectAllPending(reason: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

/** Resolves the unpacked Chrome Extension folder (`extensions/olympus-chrome`) in both dev and packaged builds. */
export function extensionFolderPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../extensions/olympus-chrome'),
    join(process.cwd(), 'extensions/olympus-chrome'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'manifest.json'))) return c;
  return candidates[0];
}

export function browserBridgeStatus(): BrowserBridgeStatus {
  return {
    running: Boolean(server && boundPort > 0),
    port: boundPort,
    connected: Boolean(extSocket && !extSocket.destroyed),
    paused: Boolean(extInfo.paused),
    extensionId: extInfo.extensionId ?? OLYMPUS_EXTENSION_ID,
    extensionVersion: extInfo.version,
    extensionPath: extensionFolderPath(),
  };
}

function pushStatus() {
  emitFn('browser:status', browserBridgeStatus());
}

function handleMessage(raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg?.type === 'hello') {
    extInfo = {
      ...extInfo,
      version: typeof msg.version === 'string' ? msg.version : undefined,
      paused: Boolean(msg.paused),
      connectedAt: Date.now(),
    };
    pushStatus();
    return;
  }
  if (msg?.type === 'state') {
    extInfo = { ...extInfo, paused: Boolean(msg.paused) };
    pushStatus();
    return;
  }
  if (typeof msg?.id === 'number' && pending.has(msg.id)) {
    const req = pending.get(msg.id)!;
    pending.delete(msg.id);
    clearTimeout(req.timer);
    if (msg.error) req.reject(new Error(String(msg.error)));
    else req.resolve(msg.result);
  }
}

function attachSocket(socket: Duplex, extensionId: string) {
  if (extSocket && extSocket !== socket) {
    try {
      extSocket.write(encodeWsFrame(Buffer.alloc(0), 0x8));
      extSocket.destroy();
    } catch {
      /* ignore */
    }
  }
  extSocket = socket;
  extInfo = { extensionId, connectedAt: Date.now(), paused: false };
  pushStatus();

  let buf = Buffer.alloc(0);
  let fragChunks: Buffer[] = [];

  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = Boolean(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          socket.destroy();
          return;
        }
        payloadLen = Number(big);
        offset = 10;
      }
      if (payloadLen > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) return;
      const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
      const data = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + payloadLen));
      buf = buf.subarray(offset + maskLen + payloadLen);
      if (maskKey) {
        for (let i = 0; i < data.length; i++) data[i] ^= maskKey[i & 3];
      }
      if (opcode === 0x8) {
        try {
          socket.write(encodeWsFrame(Buffer.alloc(0), 0x8));
        } catch {}
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        if (!socket.destroyed) socket.write(encodeWsFrame(data, 0xA));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragChunks.push(data);
        if (fin) {
          const text = Buffer.concat(fragChunks).toString('utf8');
          fragChunks = [];
          handleMessage(text);
        }
      }
    }
  });

  const cleanup = () => {
    if (extSocket === socket) {
      extSocket = undefined;
      extInfo = {};
      rejectAllPending('Olympus Chrome Extension disconnected.');
      pushStatus();
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

function handleUpgrade(req: IncomingMessage, socket: Duplex) {
  const reject = (code: number, msg: string) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const origin = String(req.headers.origin ?? '');
  const extMatch = /^chrome-extension:\/\/([a-z]{32})$/i.exec(origin);
  const extId = extMatch?.[1]?.toLowerCase();
  if (!extId || !ALLOWED_EXTENSION_IDS.has(extId)) {
    return reject(403, 'Forbidden Extension Origin');
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') return reject(400, 'Missing WebSocket Key');
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );
  attachSocket(socket, extId);
}

/** Starts the `127.0.0.1` loopback bridge for the Olympus Chrome Extension. */
export async function startBrowserBridge(emit: Emit, preferredPort = DEFAULT_PORT): Promise<BrowserBridgeStatus> {
  emitFn = emit;
  if (server && boundPort > 0) return browserBridgeStatus();

  const srv = createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Olympus Browser Bridge expects a chrome-extension:// WebSocket connection.');
  });
  srv.on('upgrade', handleUpgrade);

  const listenOn = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onErr = (e: NodeJS.ErrnoException) => reject(e);
      srv.once('error', onErr);
      srv.listen(port, '127.0.0.1', () => {
        srv.off('error', onErr);
        const addr = srv.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });

  try {
    boundPort = await listenOn(preferredPort);
  } catch {
    boundPort = await listenOn(0);
  }
  server = srv;
  pushStatus();
  return browserBridgeStatus();
}

export function stopBrowserBridge(): void {
  rejectAllPending('Olympus Coder is shutting down.');
  if (extSocket) {
    try {
      extSocket.destroy();
    } catch {}
    extSocket = undefined;
  }
  if (server) {
    try {
      server.close();
    } catch {}
    server = undefined;
  }
  boundPort = 0;
  extInfo = {};
}

const NEEDED_TOAST_EVERY_MS = 10 * 60_000;
let lastNeededAt = 0;

/** Tells the window an agent wanted Chrome but the extension isn't connected (at most once per 10 minutes). */
function notifyExtensionNeeded() {
  const now = Date.now();
  if (now - lastNeededAt < NEEDED_TOAST_EVERY_MS) return;
  lastNeededAt = now;
  emitFn('browser:needed', { at: now });
}

/** Opens chrome://extensions in Google Chrome (a chrome:// URL can't go through shell.openExternal). Resolves false if Chrome couldn't be started. */
export function openChromeExtensionsPage(): Promise<boolean> {
  const url = 'chrome://extensions/';
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', ['-a', 'Google Chrome', url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', 'chrome', url]]
        : ['google-chrome', [url]];
  return new Promise((resolve) => execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err)));
}

/** Sends one RPC request to the connected Olympus Chrome Extension and awaits its response. */
export function callBrowserExtension<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  if (!extSocket || extSocket.destroyed) {
    notifyExtensionNeeded();
    return Promise.reject(
      new Error(
        `The Olympus Chrome Extension is not installed or not connected, so the browser can't be used right now. Tell the user: Olympus Coder → Settings → Connectors → "Olympus Chrome Extension" has a 1-minute setup (chrome://extensions → Developer mode → Load unpacked → ${extensionFolderPath()}); it connects by itself.`,
      ),
    );
  }
  if (extInfo.paused) {
    return Promise.reject(new Error('The user pressed Stop in Chrome. Stop using the browser and ask the user before continuing.'));
  }
  const id = ++rpcSeq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser extension timed out after ${Math.round(timeoutMs / 1000)}s on "${method}".`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sendJson(extSocket!, { id, method, params });
  });
}

/** Saves a base64 screenshot returned by the extension to `<sharedRoot>/browser-shots/` for inline chat preview. */
export function saveBrowserScreenshot(dataUrlOrBase64: string): string {
  const m = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrlOrBase64);
  const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
  const b64 = m ? m[2] : dataUrlOrBase64;
  mkdirSync(shotsDir(), { recursive: true });
  const file = join(shotsDir(), `chrome-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}
