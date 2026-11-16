import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { AgentDef, DeskEvents } from '@shared/types';
import { agentStatuses, allAgents, restartAgent } from './agents';
import { agentEnv, spawnable, which } from './env';
import { getSettings, updateSettings } from './store';

/**
 * Agents the user adds by command line, shared by Settings → Agents (IPC in index.ts) and the agents' own
 * add_custom_agent / remove_agent tools (agentTools.ts), so both paths save and remove the same way.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
export type CustomAgentInput = Pick<AgentDef, 'name' | 'command' | 'args' | 'env' | 'color' | 'logo'>;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';

/** Tells open windows (and phones) the agent list changed, as the Settings screen reloads it after its own calls. */
export function announceAgents(emit: Emit) {
  emit('agents:changed', agentStatuses());
}

export function addCustomAgent(def: CustomAgentInput, emit: Emit): AgentDef {
  let id = slug(def.name);
  while (allAgents().some((a) => a.id === id)) id += '-2';
  const full: AgentDef = {
    id,
    name: def.name,
    badge: def.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AG',
    color: def.color || '#8b5cf6',
    description: `${def.command} ${def.args.join(' ')}`,
    builtin: false,
    command: def.command,
    args: def.args,
    env: def.env,
    detectBinary: def.command,
    logo: def.logo || undefined,
  };
  updateSettings({ customAgents: [...getSettings().customAgents, full] });
  announceAgents(emit);
  return full;
}

export function removeCustomAgent(id: string, emit: Emit) {
  restartAgent(id);
  updateSettings({ customAgents: getSettings().customAgents.filter((a) => a.id !== id) });
  announceAgents(emit);
}

/**
 * Starts `command args` and sends one ACP `initialize`. Resolves with the agent's name/version when it answers,
 * rejects with the real reason (not found, exited with its stderr, JSON-RPC error, or no answer in `timeoutMs`).
 */
export function probeAcp(command: string, args: string[], env: Record<string, string> = {}, timeoutMs = 15_000): Promise<string> {
  const resolved = which(command);
  if (!resolved) return Promise.reject(new Error(`"${command}" was not found (check the path or your PATH).`));
  const spec = spawnable(resolved, args);
  return new Promise((resolve, reject) => {
    const proc = spawn(spec.command, spec.args, { env: agentEnv(env), cwd: homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      fn();
    };
    const tail = () => err.trim().split('\n').slice(-6).join('\n').slice(-800);
    const timer = setTimeout(
      () => finish(() => reject(new Error(`No answer to ACP initialize within ${Math.round(timeoutMs / 1000)} s.${tail() ? `\n${tail()}` : ''}`))),
      timeoutMs,
    );
    proc.on('error', (e) => finish(() => reject(new Error(`Could not start "${command}": ${e.message}`))));
    proc.on('exit', (code, signal) => finish(() => reject(new Error(`The command exited (${signal ?? `code ${code}`}) before answering ACP initialize.${tail() ? `\n${tail()}` : ''}`))));
    proc.stderr.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-8000)));
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      let nl: number;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id !== 0) continue;
        if (msg.error) return finish(() => reject(new Error(`ACP initialize failed: ${msg.error.message ?? JSON.stringify(msg.error)}`)));
        const info = msg.result?.agentInfo;
        return finish(() => resolve(info?.name ? `${info.name}${info.version ? ` ${info.version}` : ''}` : `protocol v${msg.result?.protocolVersion ?? '?'}`));
      }
    });
    proc.stdin.on('error', () => {
      /* the exit / error handlers report it */
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
  });
}
