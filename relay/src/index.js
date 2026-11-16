import { DurableObject } from 'cloudflare:workers';

/**
 * Olympus phone relay.
 *
 * Each Mac gets a "room" (a Durable Object named by a random id that only the Mac and its QR code know).
 * The Mac joins as the host with a secret; phones join as clients. The relay only forwards opaque blobs:
 * everything is AES-256-GCM encrypted on the Mac and on the phone with a key that lives in the QR link's
 * #fragment, which browsers never send to a server. So the relay (and anyone with access to it) can't read
 * chats, and it can't reach anyone else's Mac.
 */

const ROOM_ID = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_CLIENTS = 20;
const MAX_MSG = 4 * 1024 * 1024;
// A phone sends a few messages a second at most (taps, scrolls, typing); a script flooding a room is cut off.
const CLIENT_WINDOW_MS = 10_000;
const CLIENT_MAX_MSGS = 300;

const clientIp = (req) => req.headers.get('CF-Connecting-IP') || 'local';

/** One hit on a Workers Rate Limiting binding; a missing binding (older config) never blocks. */
async function allowed(limiter, key) {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, protocol: 1 });
    const m = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (m) {
      if (!ROOM_ID.test(m[1])) return new Response('Bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      if (!(await allowed(env.CONNECT_LIMIT, clientIp(req)))) return new Response('Too many connections, try again in a minute', { status: 429 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  host() {
    return this.ctx.getWebSockets('host')[0];
  }
  clients() {
    return this.ctx.getWebSockets('c');
  }

  async fetch(req) {
    const url = new URL(req.url);
    const { 0: client, 1: server } = new WebSocketPair();
    if (url.searchParams.get('role') === 'host') {
      const secret = url.searchParams.get('secret') ?? '';
      if (secret.length < 32) return new Response('Bad secret', { status: 400 });
      // The first Mac to open a room owns it; after that only the same secret can be its host.
      const h = await sha256(secret);
      const owner = await this.ctx.storage.get('owner');
      if (owner && owner !== h) return new Response('Forbidden', { status: 403 });
      if (!owner) {
        // Claiming a new room is the costly part for the relay (stored forever), so it has its own, tighter limit.
        if (!(await allowed(this.env.NEW_ROOM_LIMIT, clientIp(req)))) return new Response('Too many new rooms, try again in a minute', { status: 429 });
        await this.ctx.storage.put('owner', h);
      }
      for (const old of this.ctx.getWebSockets('host')) old.close(4000, 'Replaced by a newer connection');
      this.ctx.acceptWebSocket(server, ['host']);
      server.send(JSON.stringify({ t: 'hello', clients: this.clients().map((c) => c.deserializeAttachment()?.cid).filter(Boolean) }));
      for (const c of this.clients()) c.send('{"t":"host","up":true}');
    } else {
      if (this.clients().length >= MAX_CLIENTS) return new Response('Too many connections', { status: 429 });
      const cid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      this.ctx.acceptWebSocket(server, ['c', `c:${cid}`]);
      server.serializeAttachment({ cid });
      const host = this.host();
      server.send(JSON.stringify({ t: 'host', up: Boolean(host) }));
      host?.send(JSON.stringify({ t: 'open', cid }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    if (this.ctx.getTags(ws).includes('host')) {
      let m;
      try {
        m = JSON.parse(msg);
      } catch {
        return;
      }
      const target = typeof m.cid === 'string' ? this.ctx.getWebSockets(`c:${m.cid}`)[0] : undefined;
      if (!target) return;
      if (m.t === 'msg' && typeof m.d === 'string') target.send(m.d);
      else if (m.t === 'kick') target.close(4001, 'Closed by your Mac');
      return;
    }
    const cid = ws.deserializeAttachment()?.cid;
    if (!this.withinRate(ws)) return ws.close(4008, 'Too many messages');
    const host = this.host();
    if (!host) return ws.send('{"t":"host","up":false}');
    host.send(JSON.stringify({ t: 'msg', cid, d: msg }));
  }

  /** Messages from one phone in the current 10 s window (in memory: a woken room starts counting again). */
  withinRate(ws) {
    const now = Date.now();
    this.rates ??= new WeakMap();
    let r = this.rates.get(ws);
    if (!r || now - r.start > CLIENT_WINDOW_MS) this.rates.set(ws, (r = { start: now, n: 0 }));
    return ++r.n <= CLIENT_MAX_MSGS;
  }

  webSocketClose(ws, code, reason) {
    this.gone(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  webSocketError(ws) {
    this.gone(ws);
  }

  gone(ws) {
    if (this.ctx.getTags(ws).includes('host')) {
      // Only if no newer host took over.
      if (!this.ctx.getWebSockets('host').some((h) => h !== ws)) for (const c of this.clients()) c.send('{"t":"host","up":false}');
    } else {
      const cid = ws.deserializeAttachment()?.cid;
      if (cid) this.host()?.send(JSON.stringify({ t: 'close', cid }));
    }
  }
}
