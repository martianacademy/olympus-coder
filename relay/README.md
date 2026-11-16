# Olympus phone relay

A small Cloudflare Worker that lets a phone reach Olympus Coder on a Mac from anywhere, with nothing to install.

- It serves the phone page (copied from the app's build) and passes WebSocket messages between one Mac and its phones.
- Each Mac has its own room (a Durable Object) with a random id. Only the Mac that opened a room (it holds a secret) can be its host.
- Every message is AES-256-GCM encrypted on the Mac and on the phone. The key is in the QR link's `#fragment`, which browsers never send to a server, so the relay can't read anything.
- The phone must also give the Olympus app password before it can do anything; the Mac checks it.

## Update / deploy

```bash
cd ..            # the app folder
npx electron-vite build
node relay/scripts/copy-page.mjs
cd relay
npx wrangler deploy
```

Run the page copy and deploy again whenever the phone app changes. Local testing: `npx wrangler dev --port 8787`, then set the
relay address in Settings → Phone → Relay address to `http://127.0.0.1:8787`.
