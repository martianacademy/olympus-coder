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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, protocol: 1 });
    const m = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (m) {
      if (!ROOM_ID.test(m[1])) return new Response('Bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
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
      if (!owner) await this.ctx.storage.put('owner', h);
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
    const host = this.host();
    if (!host) return ws.send('{"t":"host","up":false}');
    host.send(JSON.stringify({ t: 'msg', cid, d: msg }));
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
