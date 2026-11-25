/**
 * End-to-end unit test for the secure loopback Chrome Extension bridge (`src/main/browserBridge.ts`)
 * and all 5 `browser_*` MCP tools (`src/main/browserTools.ts`), plus MV3 extension manifest & syntax checks.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-browser-bridge-unit-'));
const UD = join(TMP, 'userData');
const SHARED = join(TMP, 'shared');
for (const d of [UD, SHARED]) mkdirSync(d, { recursive: true });
process.env.AGENTDESK_SHARED_ROOT = SHARED;
process.env.OLYMPUS_TEST_BROWSER_BRIDGE = '1';
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2 }));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url === 'mock:electron') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.3.6', isPackaged: false }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};`,
      };
    }
    return next(url, ctx);
  },
});

const B = await import(`${APP}/src/main/browserBridge.ts`);
const T = await import(`${APP}/src/main/browserTools.ts`);

function encodeMaskedText(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  let head;
  if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
  else {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([head, mask, masked]);
}

function rawWsUpgrade(port, origin) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    };
    if (origin !== undefined) headers.Origin = origin;
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/',
      headers,
    });
    req.on('response', (res) => resolve({ status: res.statusCode, socket: null }));
    req.on('upgrade', (res, socket) => {
      const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      assert.equal(res.headers['sec-websocket-accept'], expected);
      resolve({ status: 101, socket });
    });
    req.on('error', reject);
    req.end();
  });
}

function chromeExtensionIdFromKey(base64SpkiKey) {
  const digest = createHash('sha256').update(Buffer.from(base64SpkiKey, 'base64')).digest('hex').slice(0, 32);
  return [...digest].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('');
}

let pass = 0;
async function test(name, fn) {
  await fn();
  pass++;
  console.log(`PASS  ${name}`);
}

const status = await B.startBrowserBridge(() => {}, 0);
try {
  await test('bridge binds strictly to 127.0.0.1 with deterministic extension ID and zero token', () => {
    assert.equal(status.running, true);
    assert.ok(status.port > 0);
    assert.equal(status.extensionId, B.OLYMPUS_EXTENSION_ID);
    assert.equal('token' in status, false);
  });

  await test('rejects web origins, missing Origin, and unknown Chrome extensions (403)', async () => {
    assert.equal((await rawWsUpgrade(status.port, 'https://evil.example')).status, 403);
    assert.equal((await rawWsUpgrade(status.port, undefined)).status, 403);
    assert.equal((await rawWsUpgrade(status.port, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 403);
  });

  await test('pinned Olympus extension connects with zero token, runs all 5 browser_* tools, and honors Pause', async () => {
    const conn = await rawWsUpgrade(status.port, `chrome-extension://${B.OLYMPUS_EXTENSION_ID}`);
    assert.equal(conn.status, 101);
    const sock = conn.socket;
    sock.write(encodeMaskedText(JSON.stringify({ type: 'hello', version: '0.1.0', paused: false })));

    // Minimal server->client unmasked frame decoder for our fake extension
    let buf = Buffer.alloc(0);
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=';
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        if (buf.length < off + len) return;
        const msg = JSON.parse(buf.subarray(off, off + len).toString('utf8'));
        buf = buf.subarray(off + len);
        let result;
        if (msg.method === 'tabs') result = { tabs: [{ id: 7, title: 'Olympus', url: 'https://olympus.marsnext.in/', active: true, group: 'Olympus' }] };
        else if (msg.method === 'open') result = { id: 9, title: 'Opened', url: msg.params.url };
        else if (msg.method === 'read')
          result = {
            id: 7,
            title: 'Olympus',
            url: 'https://olympus.marsnext.in/',
            text: 'One workspace',
            elements: [{ ref: 1, tag: 'a', label: 'Download', href: '/dl' }],
            screenshotDataUrl: tinyPng,
            console: msg.params.console ? ['[error] ReferenceError: boom'] : undefined,
            network: msg.params.network ? ['500 GET https://olympus.marsnext.in/api/fail'] : undefined,
          };
        else if (msg.method === 'act') result = { ok: true, detail: `Act ${msg.params.action} ref ${msg.params.ref ?? 'none'}`, url: 'https://olympus.marsnext.in/' };
        else if (msg.method === 'close') result = { ok: true };
        sock.write(encodeMaskedText(JSON.stringify({ id: msg.id, result })));
      }
    });

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(B.browserBridgeStatus().connected, true);

    const tabsOut = await T.handleBrowserTool('browser_tabs', {}, false);
    assert.match(tabsOut, /\[7\].*\[Olympus\].*https:\/\/olympus\.marsnext\.in/);

    const openOut = await T.handleBrowserTool('browser_open', { url: 'https://olympus.marsnext.in/' }, false);
    assert.match(openOut, /Opened tab \[9\]/);

    await assert.rejects(() => T.handleBrowserTool('browser_open', { url: 'chrome://settings' }, false), /Blocked URL scheme/);

    const readOut = await T.handleBrowserTool('browser_read', { tabId: 7, screenshot: true, console: true, network: true }, false);
    assert.match(readOut, /\[1\] <a> Download/);
    assert.match(readOut, /ReferenceError: boom/);
    assert.match(readOut, /500 GET https:\/\/olympus\.marsnext\.in\/api\/fail/);
    const shotPath = readOut.match(/Screenshot:\s*(.+)/)?.[1]?.trim();
    assert.ok(shotPath && existsSync(shotPath), 'Screenshot file saved on disk');

    const actOut = await T.handleBrowserTool('browser_act', { action: 'click', tabId: 7, ref: 1 }, false);
    assert.match(actOut, /Act click ref 1/);
    const hoverOut = await T.handleBrowserTool('browser_act', { action: 'hover', tabId: 7, x: 120, y: 240 }, false);
    assert.match(hoverOut, /Act hover/);

    const closeOut = await T.handleBrowserTool('browser_close', { tabId: 9 }, false);
    assert.match(closeOut, /Closed Chrome tab \[9\]/);

    // Pause toggle from extension immediately blocks tool calls
    sock.write(encodeMaskedText(JSON.stringify({ type: 'state', paused: true })));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(B.browserBridgeStatus().paused, true);
    await assert.rejects(() => T.handleBrowserTool('browser_tabs', {}, false), /pressed Stop in Chrome/);
    sock.destroy();
  });

  await test('MV3 Chrome extension manifest.json key hashes to OLYMPUS_EXTENSION_ID and scripts parse cleanly', () => {
    const extDir = join(APP, 'extensions', 'olympus-chrome');
    const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(typeof manifest.key, 'string');
    assert.equal(chromeExtensionIdFromKey(manifest.key), B.OLYMPUS_EXTENSION_ID);
    assert.ok(manifest.permissions.includes('debugger'));
    assert.equal(manifest.action?.default_popup, undefined, 'clicking the toolbar icon opens nothing');
    assert.ok(existsSync(join(extDir, 'icon.png')));
    // Chrome Web Store readiness
    assert.equal(manifest.permissions.includes('activeTab'), false, 'no unused permissions');
    assert.ok(Number(manifest.minimum_chrome_version) >= 116, 'WebSocket keeps the MV3 worker alive from Chrome 116');
    assert.ok(manifest.description.length <= 132, 'Store description limit');
    for (const size of ['16', '32', '48', '128']) assert.ok(existsSync(join(extDir, manifest.icons[size])), `icon ${size}`);
    assert.equal(manifest.commands?.['stop-agent']?.suggested_key?.default, 'Alt+Shift+S');
    for (const file of ['background.js', 'overlay.js', 'cdp.js', 'pageHelpers.js']) {
      execFileSync(process.execPath, ['--check', join(extDir, file)]);
    }
  });

  await test('Store package: zip manifest has no "key" and every file the worker loads', () => {
    const out = execFileSync(process.execPath, [join(APP, 'scripts', 'package-chrome-extension.mjs')], { encoding: 'utf8' });
    const zip = out.match(/✓ (.+\.zip)/)?.[1];
    assert.ok(zip && existsSync(zip), out);
    const zipped = JSON.parse(execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' }));
    assert.equal(zipped.key, undefined);
    const list = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
    for (const f of ['background.js', 'cdp.js', 'overlay.js', 'pageHelpers.js', 'icon.png', 'icons/icon-128.png']) assert.ok(list.includes(f), f);
  });

  await test('no extension: agent gets setup steps, window gets one browser:needed per 10 min', async () => {
    B.stopBrowserBridge();
    const events = [];
    await B.startBrowserBridge((ch, payload) => events.push([ch, payload]), 0);
    await assert.rejects(() => T.handleBrowserTool('browser_tabs', {}, false), /not installed or not connected[\s\S]*Settings → Connectors/);
    await assert.rejects(() => T.handleBrowserTool('browser_open', { url: 'https://example.com' }, false), /not installed or not connected/);
    const needed = events.filter(([ch]) => ch === 'browser:needed');
    assert.equal(needed.length, 1);
    assert.equal(typeof needed[0][1].at, 'number');
  });
} finally {
  B.stopBrowserBridge();
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} passed, 0 failed`);
