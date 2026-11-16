// Dev tool: drive the running app over the Chrome DevTools Protocol (start Electron with --remote-debugging-port=9333).
// node scripts/cdp.mjs shot out.png | node scripts/cdp.mjs eval "<js>"
import { writeFileSync } from 'node:fs';
const port = process.env.CDP_PORT || 9333;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('saved', arg);
} else if (cmd === 'size') {
  // node scripts/cdp.mjs size 900x700  (emulated viewport; "reset" clears it)
  if (arg === 'reset') await send('Emulation.clearDeviceMetricsOverride');
  else {
    const [width, height] = arg.split('x').map(Number);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
  }
  console.log('size', arg);
} else if (cmd === 'win') {
  // node scripts/cdp.mjs win 900x700  (resizes the real window through the browser endpoint)
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => bws.addEventListener('open', r, { once: true }));
  let bid = 0;
  const bpending = new Map();
  bws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && bpending.has(m.id)) bpending.get(m.id)(m); });
  const bsend = (method, params = {}) => new Promise((r) => { const i = ++bid; bpending.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
  const w = await bsend('Browser.getWindowForTarget', { targetId: page.id });
  const [width, height] = arg.split('x').map(Number);
  const r = await bsend('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { width, height, windowState: 'normal' } });
  console.log('win', arg, r.error ? JSON.stringify(r.error) : 'ok');
  bws.close();
} else if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
}
ws.close();
