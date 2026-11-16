import { app } from 'electron';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteDevice, RemoteStatus } from '@shared/types';
import { getSettings } from './store';
import { checkPassword, isLockEnabled, isLocked, onLockChange } from './lock';
import { RemoteStream } from './remoteStream';
import { EVENTS, addDevice, deleteDevice, deviceByToken, listDevices, onDeviceRemoved, remoteCall, remoteSnapshot } from './remotecore';

/**
 * The phone link through a relay (a small Cloudflare Worker): works from anywhere, nothing to install.
 *
 * This Mac keeps one WebSocket open to the relay in a "room" with a random id. A phone opens the QR link
 * https://<relay>/#m=<room>&k=<key>: the page comes from the relay, the key stays in the #fragment (browsers
 * never send it), and every message both ways is AES-256-GCM encrypted with it. The relay only passes blobs.
 *
 * Handshake: the phone sends a fresh random session secret, encrypted with the QR key. The Mac answers with a
 * random nonce; both then use HMAC(secret, nonce) as the session key, so old messages can't be replayed.
 * Messages carry an increasing counter. Before anything else works the phone must give the Olympus app
 * password (checked here with the same back-off as the lock screen); it then gets a device token, and can be
 * removed in Settings → Phone. While the Mac is locked a phone must type the password again.
 */

export const DEFAULT_RELAY = 'https://olympus-relay.olympus-relay.workers.dev';
const PROTOCOL = 1;
const CHUNK = 256 * 1024;

// ---- identity: room id, encryption key, the secret that proves this Mac owns the room ----

interface Identity {
  macId: string;
  key: string;
  secret: string;
}
const idFile = () => join(app.getPath('userData'), 'remote-relay.json');
let ident: Identity | undefined;
function newIdentity(): Identity {
  const id = { macId: randomBytes(18).toString('base64url'), key: randomBytes(32).toString('base64url'), secret: randomBytes(32).toString('base64url') };
  writeFileSync(idFile(), JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}
function identity(): Identity {
  if (!ident) {
    try {
      const j = JSON.parse(readFileSync(idFile(), 'utf8'));
      if (j.macId && j.key && j.secret) ident = j;
    } catch {
      /* first run */
    }
    ident ??= newIdentity();
  }
  return ident!;
}
const qrKey = () => Buffer.from(identity().key, 'base64url');

export const relayUrl = () => String((getSettings().remote as any)?.relayUrl || DEFAULT_RELAY).trim().replace(/\/+$/, '');

// ---- crypto ----

function seal(key: Buffer, dir: 'h' | 'c', text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(dir));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}
function unseal(key: Buffer, dir: 'h' | 'c', blob: string): string | null {
  try {
    const b = Buffer.from(blob, 'base64url');
    if (b.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAAD(Buffer.from(dir));
    d.setAuthTag(b.subarray(b.length - 16));
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---- phones connected through the relay ----

interface Sess {
  cid: string;
  key?: Buffer;
  inQ: number;
  outQ: number;
  device?: RemoteDevice;
  /** The password was typed on this connection (lets it work while the Mac window is locked). */
  pwOk: boolean;
  parts?: { id: string; n: number; got: string[] };
  /** Events for this phone, merged per item / terminal every 120 ms (see remoteStream.ts). */
  stream: RemoteStream;
}
const sessions = new Map<string, Sess>();

function newSess(cid: string): Sess {
  const s: Sess = { cid, inQ: 0, outQ: 0, pwOk: false, stream: undefined as unknown as RemoteStream };
  s.stream = new RemoteStream((batch) => {
    if (!s.key || access(s).auth !== 'ok' || ws?.readyState !== WebSocket.OPEN) return false;
    for (const [ch, p] of batch) send(s, { t: 'ev', ch, p });
    return true;
  }, 120);
  return s;
}
function dropSess(cid: string) {
  sessions.get(cid)?.stream.dispose();
  sessions.delete(cid);
}

type Access = { auth: 'ok' } | { auth: 'password'; reason: 'new' | 'locked' } | { auth: 'nopassword' };
function access(s: Sess): Access {
  if (!isLockEnabled()) return { auth: 'nopassword' };
  if (!s.device) return { auth: 'password', reason: 'new' };
  if (isLocked() && !s.pwOk) return { auth: 'password', reason: 'locked' };
  return { auth: 'ok' };
}

let ws: WebSocket | undefined;
let state: 'off' | 'connecting' | 'online' | 'error' = 'off';
let lastError = '';
let wanted = false;
let retry = 0;
let retryTimer: NodeJS.Timeout | undefined;
let pingTimer: NodeJS.Timeout | undefined;

function wire(cid: string, d: string) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'msg', cid, d }));
}

function send(s: Sess, msg: Record<string, unknown>) {
  if (!s.key) return;
  const text = JSON.stringify(msg);
  if (text.length <= CHUNK) return wire(s.cid, seal(s.key, 'h', JSON.stringify({ q: ++s.outQ, m: text })));
  const id = randomBytes(6).toString('hex');
  const n = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < n; i++) wire(s.cid, seal(s.key, 'h', JSON.stringify({ q: ++s.outQ, part: { id, i, n }, m: text.slice(i * CHUNK, (i + 1) * CHUNK) })));
}

const sendAccess = (s: Sess) => send(s, { t: 'access', ...access(s), name: s.device?.name });

async function onClientMessage(s: Sess, blob: string) {
  // 1. Handshake, encrypted with the QR key.
  if (!s.key) {
    const text = unseal(qrKey(), 'c', blob);
    if (!text) return kick(s.cid);
    let h: any;
    try {
      h = JSON.parse(text);
    } catch {
      return kick(s.cid);
    }
    const sk = Buffer.from(String(h.sk ?? ''), 'base64url');
    if (h.t !== 'hello' || sk.length !== 32) return kick(s.cid);
    const nonce = randomBytes(16);
    s.device = h.token ? deviceByToken(String(h.token)) : undefined;
    // Answer with the old (phone-chosen) key; from now on both sides use the derived one.
    wire(s.cid, seal(sk, 'h', JSON.stringify({ t: 'hello', v: PROTOCOL, n: nonce.toString('base64url'), tokenKnown: Boolean(s.device), ...access(s), name: s.device?.name })));
    s.key = createHmac('sha256', sk).update(nonce).digest();
    return;
  }
  // 2. Everything after it.
  const text = unseal(s.key, 'c', blob);
  if (!text) return;
  let f: any;
  try {
    f = JSON.parse(text);
  } catch {
    return;
  }
  if (!(typeof f.q === 'number' && f.q > s.inQ)) return; // replayed or out of order
  s.inQ = f.q;
  let m: any;
  try {
    if (f.part) {
      const { id, i, n } = f.part;
      if (!s.parts || s.parts.id !== id) s.parts = { id, n: Math.min(Number(n) || 0, 128), got: [] };
      s.parts.got[i] = String(f.m);
      if (s.parts.got.filter((x) => x !== undefined).length < s.parts.n) return;
      m = JSON.parse(s.parts.got.join(''));
      s.parts = undefined;
    } else m = JSON.parse(f.m);
  } catch {
    return;
  }

  if (m.t === 'login') {
    const r = checkPassword(String(m.password ?? ''));
    if (!r.ok) return send(s, { t: 'login', ok: false, error: r.error });
    let token: string | undefined;
    if (!s.device) {
      const added = addDevice(String(m.name ?? 'Phone'), 'relay');
      token = added.token;
      s.device = added.device;
    }
    s.pwOk = true;
    send(s, { t: 'login', ok: true, token });
    return sendAccess(s);
  }
  if (m.t === 'forget') {
    if (s.device) deleteDevice(s.device.id);
    return;
  }
  if (m.t === 'view') {
    // What this phone shows (chats, terminals): see remoteStream.ts.
    if (access(s).auth === 'ok') s.stream.setView(m);
    return;
  }
  if (m.t === 'call' || m.t === 'state') {
    const a = access(s);
    if (a.auth !== 'ok') return send(s, { t: 'res', id: m.id, ok: false, error: a.auth === 'password' && a.reason === 'locked' ? 'LOCKED' : 'Not signed in', access: a });
    if (m.t === 'state') return send(s, { t: 'res', id: m.id, ok: true, value: remoteSnapshot() });
    const r = await remoteCall(String(m.method ?? ''), m.args);
    return send(s, { t: 'res', id: m.id, ...r });
  }
}

function kick(cid: string) {
  dropSess(cid);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'kick', cid }));
}

function onRelay(raw: string) {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'hello') {
    clearSessions();
    for (const cid of m.clients ?? []) sessions.set(cid, newSess(cid));
  } else if (m.t === 'open') {
    dropSess(m.cid);
    sessions.set(m.cid, newSess(m.cid));
  } else if (m.t === 'close') dropSess(m.cid);
  else if (m.t === 'msg' && typeof m.d === 'string') {
    let s = sessions.get(m.cid);
    if (!s) sessions.set(m.cid, (s = newSess(m.cid)));
    // One message at a time per phone, in order.
    const prev = (s as any).chain ?? Promise.resolve();
    (s as any).chain = prev.then(() => onClientMessage(s!, m.d)).catch(() => {});
  }
}

function connect() {
  clearTimeout(retryTimer);
  if (!wanted) return;
  const base = relayUrl();
  if (!base) {
    state = 'error';
    lastError = 'No relay address is set.';
    return;
  }
  const id = identity();
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${base.replace(/^http/i, 'ws')}/ws/${id.macId}?role=host&secret=${id.secret}`);
  } catch (e: any) {
    state = 'error';
    lastError = e?.message ?? String(e);
    return;
  }
  ws = sock;
  state = 'connecting';
  sock.onopen = () => {
    state = 'online';
    lastError = '';
    retry = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), 25_000);
  };
  sock.onmessage = (e) => {
    if (typeof e.data === 'string' && e.data !== 'pong') onRelay(e.data);
  };
  sock.onerror = () => {
    lastError = `Can't reach the relay at ${base}.`;
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = undefined;
    clearInterval(pingTimer);
    clearSessions();
    if (!wanted) return void (state = 'off');
    if (e.code === 4000) {
      state = 'error';
      lastError = 'Another copy of Olympus Coder on this Mac took over the phone link.';
      return;
    }
    state = 'connecting';
    retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  };
}

// ---- public ----

/** Sends an app event to every phone that may see it (merged per item / terminal every 120 ms). */
export function relayBroadcast(channel: string, payload: any) {
  if (!sessions.size || !EVENTS.has(channel)) return;
  for (const s of sessions.values()) {
    if (s.key && access(s).auth === 'ok') s.stream.push(channel, payload);
  }
}

function clearSessions() {
  for (const s of sessions.values()) s.stream.dispose();
  sessions.clear();
}

export function startRelay() {
  wanted = true;
  if (!ws) connect();
}

export function stopRelay() {
  wanted = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  clearSessions();
  ws?.close();
  ws = undefined;
  state = 'off';
}

export function restartRelay() {
  const was = wanted;
  stopRelay();
  if (was) startRelay();
}

/** A new room and key: every phone must scan the new QR code (and is removed from the list). */
export function resetRelayLink() {
  ident = newIdentity();
  for (const d of listDevices()) if (d.via === 'relay') deleteDevice(d.id);
  restartRelay();
}

export function relayLink(): string {
  const base = relayUrl();
  if (!base) return '';
  const id = identity();
  return `${base}/#m=${id.macId}&k=${id.key}`;
}

export function relayStatus(): RemoteStatus['relay'] {
  let phones = 0;
  for (const s of sessions.values()) if (s.key && access(s).auth === 'ok') phones++;
  return { url: relayUrl(), defaultUrl: DEFAULT_RELAY, state, error: lastError || undefined, phones, passwordSet: isLockEnabled() };
}

// Phones learn at once when the Mac locks (they then need the password) or when they are removed.
onLockChange(() => {
  for (const s of sessions.values()) if (s.key) sendAccess(s);
});
onDeviceRemoved((id) => {
  for (const s of sessions.values())
    if (s.device && (id === null || s.device.id === id)) {
      send(s, { t: 'removed' });
      s.device = undefined;
      s.pwOk = false;
    }
});
