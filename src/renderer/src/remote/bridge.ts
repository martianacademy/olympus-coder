/**
 * The phone app talks to the Mac over the network instead of Electron IPC. This file gives it the same
 * `window.desk` the desktop window has (invoke a method, listen to events), so the desktop's own chat,
 * approvals and tasks components run unchanged on the phone. It must be imported before anything that uses
 * `window.desk`.
 *
 * Two ways in:
 * - Relay (the page comes from the Cloudflare relay; it has <meta name="olympus-relay">): a WebSocket to the
 *   relay, every message end-to-end encrypted with the key from the QR link's #fragment, password login.
 * - Local (the page comes from the Mac itself, e.g. over Tailscale): plain HTTPS + a paired-device token.
 */

import { applyItemPatch, type ItemPatch } from '@shared/itemPatch';

export const isRelay = typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="olympus-relay"]'));

/**
 * online · offline (no network / reconnecting) · locked · unpaired (local mode) ·
 * scan (relay: no QR link yet) · macoff (relay is up, the Mac is not) · password · nopassword (Mac has none set).
 */
export type Conn = 'online' | 'offline' | 'locked' | 'unpaired' | 'scan' | 'macoff' | 'password' | 'nopassword';
let conn: Conn = 'offline';
const connListeners = new Set<(c: Conn) => void>();
const setConn = (c: Conn) => {
  if (conn === c) return;
  conn = c;
  connListeners.forEach((l) => l(c));
};
export const onConn = (fn: (c: Conn) => void) => {
  connListeners.add(fn);
  fn(conn);
  return () => connListeners.delete(fn);
};

type Listener = (channel: string, payload: any) => void;
const listeners = new Set<Listener>();
const emitLocal = (ch: string, p: any) => listeners.forEach((l) => l(ch, p));

// ======================================================================================
// What this phone shows, and streaming patches (see src/main/remoteStream.ts)
// ======================================================================================

/** The last full copy of every chat item this connection got, so `thread:patch` can be applied (oldest first). */
const items = new Map<string, any>();
const MAX_ITEMS = 4000;
const watched = { thread: new Map<string, number>(), pty: new Map<string, number>() };
/** Items a patch arrived for without a copy here: the Mac sends them in full next time. */
let resync = new Set<string>();
/** ...and until that full copy comes, their patches are skipped (they belong to a copy we don't have). */
const awaitingFull = new Set<string>();
let viewTimer: number | undefined;
let sendViewNow: (v: Record<string, unknown>) => void = () => {};

function viewBody() {
  const body = { threads: [...watched.thread.keys()], ptys: [...watched.pty.keys()], patch: true, resync: [...resync] };
  resync = new Set();
  return body;
}
const pushView = () => {
  clearTimeout(viewTimer);
  viewTimer = window.setTimeout(() => sendViewNow(viewBody()), 0);
};

/** A new connection: the Mac starts over (full items, everything until it gets our view). */
function resetStream() {
  items.clear();
  resync = new Set();
  awaitingFull.clear();
  pushView();
}

function deliver(ch: string, p: any) {
  if (ch === 'thread:item' && p?.item?.id) {
    const k = `${p.threadId}\n${p.item.id}`;
    awaitingFull.delete(k);
    items.delete(k);
    items.set(k, p.item);
    if (items.size > MAX_ITEMS) items.delete(items.keys().next().value as string);
  } else if (ch === 'thread:patch') {
    const k = `${p.threadId}\n${p.id}`;
    if (awaitingFull.has(k)) return;
    const base = items.get(k);
    if (!base) {
      // No copy to patch: ask the Mac for the full item, and show the saved one meanwhile (not as a patch base).
      awaitingFull.add(k);
      resync.add(k);
      pushView();
      void (window as any).desk
        .invoke('tasks.thread', p.threadId)
        .then((t: any) => {
          const it = t?.items?.find((x: any) => x.id === p.id);
          if (it && awaitingFull.has(k)) emitLocal('thread:item', { threadId: p.threadId, item: it });
        })
        .catch(() => {});
      return;
    }
    return deliver('thread:item', { threadId: p.threadId, item: applyItemPatch(base, p.p as ItemPatch) });
  }
  emitLocal(ch, p);
}

/** Marks a chat or terminal as on screen until the returned function is called (counted, so nesting works). */
function watch(kind: 'thread' | 'pty', id: string) {
  const m = watched[kind];
  m.set(id, (m.get(id) ?? 0) + 1);
  pushView();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (m.get(id) ?? 1) - 1;
    if (n > 0) m.set(id, n);
    else m.delete(id);
    pushView();
  };
}

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string) {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

// ======================================================================================
// Local mode (page served by the Mac)
// ======================================================================================

const TOKEN_KEY = 'olympus.remoteToken';
export const getToken = () => store.get(TOKEN_KEY);
export const setToken = (t: string) => store.set(TOKEN_KEY, t);

let es: EventSource | null = null;
let esConn = '';
let localPasswordSet = true;
export const isLocalPasswordSet = () => localPasswordSet;

export function connectEvents() {
  if (!getToken()) return setConn('unpaired');
  es?.close();
  es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
  es.addEventListener('hello', (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    if (typeof d.passwordSet === 'boolean') localPasswordSet = d.passwordSet;
    esConn = typeof d.conn === 'string' ? d.conn : '';
    resetStream();
    setConn(d.locked ? 'locked' : 'online');
  });
  es.onmessage = (e) => {
    try {
      const [ch, p] = JSON.parse(e.data);
      if (ch === 'lock:state') {
        setConn(p?.locked ? 'locked' : 'online');
        return;
      }
      deliver(ch, p);
    } catch {
      /* ignore a bad line */
    }
  };
  es.onerror = () => {
    setConn('offline');
    // EventSource retries by itself; a 401 (phone removed) shows as repeated errors: check once.
    void fetch('/api/me', { headers: { authorization: `Bearer ${getToken()}` } })
      .then((r) => r.status === 401 && (setConn('unpaired'), es?.close()))
      .catch(() => {});
  };
}

/** Tells the Mac what this phone shows (an older Mac answers 404: it then keeps sending everything). */
function sendViewLocal(body: Record<string, unknown>) {
  if (!esConn) return;
  void fetch('/api/view', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ conn: esConn, ...body }),
  }).catch(() => {});
}

async function invokeLocal(method: string, ...args: unknown[]): Promise<any> {
  const r = await fetch('/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ method, args }),
  }).catch(() => {
    setConn('offline');
    throw new Error("Can't reach your Mac. Is it on, with Olympus open?");
  });
  if (r.status === 401) {
    setConn('unpaired');
    throw new Error('This phone is not paired.');
  }
  if (r.status === 423) {
    const j423 = await r.json().catch(() => ({}));
    if (typeof j423.passwordSet === 'boolean') localPasswordSet = j423.passwordSet;
    setConn('locked');
    throw new Error('LOCKED');
  }
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (r.status === 403 || j.ok === false) throw new Error(j.error ?? 'Failed');
  if (conn !== 'online') setConn('online');
  return j.value;
}

export async function localAuthInfo(): Promise<{ passwordRequired: boolean }> {
  const r = await fetch('/api/auth-info').catch(() => null);
  if (!r || !r.ok) return { passwordRequired: false };
  return r.json().catch(() => ({ passwordRequired: false }));
}

export async function pair(code: string, name: string, password?: string): Promise<void> {
  const r = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-olympus': '1' },
    body: JSON.stringify({ code, name, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(j.error ?? `Pairing failed (HTTP ${r.status})`);
  setToken(j.token);
}

export async function unlockLocal(password: string): Promise<void> {
  const r = await fetch('/api/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-olympus': '1', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Unlock failed (HTTP ${r.status})`);
  setConn('online');
}

// ======================================================================================
// Relay mode
// ======================================================================================

const RELAY_KEY = 'olympus.relay';
interface Creds {
  m: string;
  k: string;
  token?: string;
}
const te = new TextEncoder();
const td = new TextDecoder();
const b64u = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function aesKey(raw: Uint8Array) {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(key: CryptoKey, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('c') }, key, te.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}
async function unseal(key: CryptoKey, blob: string): Promise<string | null> {
  try {
    const b = unb64u(blob);
    return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: te.encode('h') }, key, b.subarray(12)));
  } catch {
    return null;
  }
}

function readCreds(): Creds | null {
  // A fresh QR link wins over what is saved (it may be a different Mac, or a new link).
  const h = new URLSearchParams(location.hash.slice(1));
  const m = h.get('m');
  const k = h.get('k');
  let saved: Creds | null = null;
  try {
    saved = JSON.parse(store.get(RELAY_KEY) || 'null');
  } catch {
    /* ignore */
  }
  if (m && k && /^[\w-]{20,64}$/.test(m) && unb64u(k).length === 32) {
    const c: Creds = { m, k, token: saved?.m === m && saved.k === k ? saved.token : undefined };
    store.set(RELAY_KEY, JSON.stringify(c));
    return c;
  }
  return saved?.m && saved.k ? saved : null;
}

let creds: Creds | null = null;
let sock: WebSocket | null = null;
let retry = 0;
let retryTimer: number | undefined;
let pingTimer: number | undefined;
/** Session: the secret we picked (handshake) and then the derived key. */
let hs: { sk: Uint8Array } | null = null;
let sess: { key: CryptoKey; inQ: number; outQ: number; parts?: { id: string; n: number; got: string[] } } | null = null;
let chain: Promise<void> = Promise.resolve();
let reason: 'new' | 'locked' = 'new';
let macName = '';
export const passwordReason = () => reason;
export const signedInAs = () => macName;

const waiters = new Set<() => void>();
const pending = new Map<string, { ok: (v: any) => void; fail: (e: Error) => void; timer: number }>();
let loginWaiter: { ok: (token?: string) => void; fail: (e: Error) => void } | null = null;

function failAll(msg: string) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.fail(new Error(msg));
  }
  pending.clear();
  loginWaiter?.fail(new Error(msg));
  loginWaiter = null;
}

function applyAccess(a: any) {
  if (a.auth === 'ok') {
    pushView();
    setConn('online');
    waiters.forEach((w) => w());
    waiters.clear();
  } else if (a.auth === 'nopassword') setConn('nopassword');
  else {
    reason = a.reason === 'locked' ? 'locked' : 'new';
    setConn('password');
  }
}

async function sendRelay(msg: Record<string, unknown>) {
  if (!sess || sock?.readyState !== WebSocket.OPEN) throw new Error("Can't reach your Mac right now.");
  const text = JSON.stringify(msg);
  const CHUNK = 256 * 1024;
  if (text.length <= CHUNK) return sock.send(await seal(sess.key, JSON.stringify({ q: ++sess.outQ, m: text })));
  const id = Math.random().toString(36).slice(2);
  const n = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < n; i++) sock.send(await seal(sess.key, JSON.stringify({ q: ++sess.outQ, part: { id, i, n }, m: text.slice(i * CHUNK, (i + 1) * CHUNK) })));
}

async function hello() {
  if (!creds || sock?.readyState !== WebSocket.OPEN) return;
  sess = null;
  hs = { sk: crypto.getRandomValues(new Uint8Array(32)) };
  sock.send(await seal(await aesKey(unb64u(creds.k)), JSON.stringify({ t: 'hello', v: 1, sk: b64u(hs.sk), token: creds.token })));
}

async function onBlob(blob: string) {
  if (hs && !sess) {
    const text = await unseal(await aesKey(hs.sk), blob);
    if (!text) return;
    const h = JSON.parse(text);
    if (h.t !== 'hello') return;
    const mac = await crypto.subtle.importKey('raw', hs.sk as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const raw = new Uint8Array(await crypto.subtle.sign('HMAC', mac, unb64u(h.n) as BufferSource));
    sess = { key: await aesKey(raw), inQ: 0, outQ: 0 };
    hs = null;
    macName = h.name ?? '';
    if (creds?.token && !h.tokenKnown) saveToken(undefined); // removed on the Mac
    items.clear();
    resync = new Set();
    awaitingFull.clear();
    applyAccess(h);
    return;
  }
  if (!sess) return;
  const text = await unseal(sess.key, blob);
  if (!text) return;
  const f = JSON.parse(text);
  if (!(f.q > sess.inQ)) return;
  sess.inQ = f.q;
  let m: any;
  if (f.part) {
    const { id, i, n } = f.part;
    if (!sess.parts || sess.parts.id !== id) sess.parts = { id, n, got: [] };
    sess.parts.got[i] = f.m;
    if (sess.parts.got.filter((x) => x !== undefined).length < sess.parts.n) return;
    m = JSON.parse(sess.parts.got.join(''));
    sess.parts = undefined;
  } else m = JSON.parse(f.m);

  if (m.t === 'res') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.access) applyAccess(m.access);
    if (m.ok) p.ok(m.value);
    else p.fail(new Error(m.error ?? 'Failed'));
  } else if (m.t === 'ev') deliver(m.ch, m.p);
  else if (m.t === 'access') applyAccess(m);
  else if (m.t === 'login') {
    if (m.ok) {
      if (m.token) saveToken(m.token);
      loginWaiter?.ok(m.token);
    } else loginWaiter?.fail(new Error(m.error ?? 'Sign-in failed'));
    loginWaiter = null;
  } else if (m.t === 'removed') {
    saveToken(undefined);
    reason = 'new';
    setConn('password');
  }
}

function saveToken(token: string | undefined) {
  if (!creds) return;
  creds = { ...creds, token };
  store.set(RELAY_KEY, JSON.stringify(creds));
}

function onControl(c: any) {
  if (c.t !== 'host') return;
  if (c.up) void hello();
  else {
    sess = null;
    hs = null;
    failAll('Your Mac went offline.');
    setConn('macoff');
  }
}

export function connectRelay() {
  clearTimeout(retryTimer);
  creds ??= readCreds();
  if (!creds) return setConn('scan');
  if (sock && sock.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${creds.m}?role=client`);
  sock = ws;
  ws.onopen = () => {
    retry = 0;
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
  };
  ws.onmessage = (e) => {
    const d = String(e.data);
    if (d === 'pong') return;
    chain = chain
      .then(() => {
        if (d.startsWith('{')) onControl(JSON.parse(d));
        else return onBlob(d);
      })
      .catch(() => {});
  };
  ws.onclose = () => {
    if (sock !== ws) return;
    sock = null;
    sess = null;
    hs = null;
    clearInterval(pingTimer);
    failAll('Connection lost.');
    if (conn !== 'scan') setConn('offline');
    retryTimer = window.setTimeout(connectRelay, Math.min(15_000, 800 * 2 ** retry++));
  };
}

/** Back from the background (phones freeze pages): reconnect straight away instead of waiting. */
if (isRelay)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!sock || sock.readyState > WebSocket.OPEN)) {
      retry = 0;
      connectRelay();
    }
  });

function whenReady(ms = 20_000): Promise<void> {
  if (conn === 'online' && sess) return Promise.resolve();
  return new Promise((ok, fail) => {
    const t = window.setTimeout(() => {
      waiters.delete(done);
      fail(new Error(conn === 'macoff' ? 'Your Mac is offline.' : "Can't reach your Mac right now."));
    }, ms);
    const done = () => {
      clearTimeout(t);
      ok();
    };
    waiters.add(done);
  });
}

let nextId = 1;
async function request(msg: Record<string, unknown>): Promise<any> {
  await whenReady();
  const id = String(nextId++);
  return new Promise((ok, fail) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      fail(new Error('Your Mac did not answer in time.'));
    }, 120_000);
    pending.set(id, { ok, fail, timer });
    sendRelay({ ...msg, id }).catch((e) => {
      pending.delete(id);
      clearTimeout(timer);
      fail(e);
    });
  });
}

/** Signs in with the Olympus app password (first time on this phone, or while the Mac is locked). */
export function login(password: string, name: string): Promise<void> {
  return new Promise((ok, fail) => {
    if (!sess) return fail(new Error("Can't reach your Mac right now."));
    loginWaiter = { ok: () => ok(), fail };
    sendRelay({ t: 'login', password, name }).catch((e) => {
      loginWaiter = null;
      fail(e);
    });
  });
}

/** "Use a different Mac": removes this phone from the Mac's list and forgets the link here. */
export function forgetMac() {
  if (sess) void sendRelay({ t: 'forget' }).catch(() => {});
  store.set(RELAY_KEY, '');
  creds = null;
  setTimeout(() => {
    const ws = sock;
    sock = null;
    ws?.close();
    history.replaceState(null, '', location.pathname);
    setConn('scan');
  }, 150);
}

// iOS keeps a home-screen app's storage apart from Safari's, so "Add to Home Screen" must keep the link
// (with its #key) as the start address; a manifest would replace it with a bare "/".
if (isRelay && /iPhone|iPad|iPod/.test(navigator.userAgent)) document.querySelector('link[rel="manifest"]')?.remove();

// ======================================================================================

sendViewNow = isRelay
  ? (body) => {
      if (sess && conn === 'online') void sendRelay({ t: 'view', ...body }).catch(() => {});
    }
  : sendViewLocal;

(window as any).desk = {
  invoke: isRelay ? (method: string, ...args: unknown[]) => request({ t: 'call', method, args }) : invokeLocal,
  on: (fn: Listener) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  pathForFile: () => '',
  watch,
};
(window as any).__olympusRemote = true;
(window as any).__OLYMPUS_REMOTE__ = true;

export async function remoteState(): Promise<{ theme: any; profileName: string; defaultAgent?: string; version: string }> {
  if (isRelay) return request({ t: 'state' });
  const r = await fetch('/api/state', { headers: { authorization: `Bearer ${getToken()}` } });
  if (r.status === 401) throw Object.assign(new Error('unpaired'), { unpaired: true });
  if (r.status === 423) throw Object.assign(new Error('LOCKED'), { locked: true });
  return r.json();
}
