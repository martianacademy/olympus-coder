// Dev tool: ACP handshake with an agent and print its capabilities, auth methods and session info.
// Usage: node scripts/probe-acp.mjs <claude|codex|agy> [--session]
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const which = process.argv[2];
const cmds = {
  claude: ['node', ['node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js']],
  codex: ['node_modules/.bin/codex-acp', []],
  agy: ['agy', ['acp']],
};
const [cmd, args] = cmds[which];
const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.on('data', (d) => process.stderr.write(`[${which} stderr] ${d}`));
const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
const conn = client({ name: 'agentdesk-probe' })
  .onNotification(methods.client.session.update, (n) => console.log('update:', JSON.stringify(n.update).slice(0, 300)))
  .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }))
  .connect(stream);
const t = setTimeout(() => { console.log('TIMEOUT'); proc.kill(); process.exit(1); }, 60000);
try {
  const init = await conn.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
    clientInfo: { name: 'agentdesk', version: '0.1.0' },
  });
  console.log('INIT', JSON.stringify(init, null, 1));
  const ai = process.argv.indexOf('--auth');
  if (ai > 0) {
    const t0 = Date.now();
    const r = await conn.agent.request(methods.agent.authenticate, { methodId: process.argv[ai + 1] });
    console.log('AUTH', Date.now() - t0, 'ms', JSON.stringify(r));
  }
  if (process.argv.includes('--session')) {
    const s = await conn.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    console.log('SESSION', JSON.stringify(s, null, 1).slice(0, Number(process.env.PROBE_MAX || 4000)));
  }
} catch (e) {
  console.log('ERROR', e?.code, e?.message, JSON.stringify(e?.data ?? null));
}
clearTimeout(t); proc.kill(); process.exit(0);
