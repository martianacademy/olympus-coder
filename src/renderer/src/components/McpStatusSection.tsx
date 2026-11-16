import { useState } from 'react';
import { MCP_PROBLEM_STATES, MCP_STATE_LABEL, type McpServerStatusView } from '@shared/acpConfig';
import { useMcpStatus } from '../acpConfigApi';
import '../acpConfig.css';

const STATE_TIP: Record<McpServerStatusView['state'], string> = {
  sent: 'The agent got this server and has not reported a problem with it.',
  ready: 'The agent is using this server.',
  failed: 'The agent reported that this server failed to start. Its tools are not available in this chat.',
  'needs-auth': 'This server needs you to sign in before its tools work.',
  cancelled: 'The agent cancelled starting this server.',
  skipped: 'The agent did not start this server (it has its own server with this name).',
  dropped: 'Olympus left this server out because the agent refused to start a session with it.',
  unsupported: 'This agent cannot use this kind of server.',
};

function Row({ s }: { s: McpServerStatusView }) {
  const name = s.source === 'olympus' ? 'Olympus tools' : s.name;
  const tip = `${s.source === 'olympus' ? `Olympus session tools (server "${s.name}")` : `Connector "${s.name}"`} · ${s.transport.toUpperCase()}\n${STATE_TIP[s.state]}${s.reason ? `\n${s.reason}` : ''}`;
  return (
    <div className="mcp-status-row" title={tip} data-testid="mcp-status-row" data-state={s.state}>
      <span className={`mcp-dot ${s.state}`} aria-hidden="true" />
      <span className="mcp-name">{name}</span>
      <span className="mcp-why">{s.reason ?? ''}</span>
      <span className="mcp-state">{MCP_STATE_LABEL[s.state]}</span>
    </div>
  );
}

/**
 * Workbench info panel: the MCP servers this chat's agent session got (Olympus tools + connectors), and what the
 * agent reported about them. Problems are listed first; healthy servers fold into one line after three.
 */
export function McpStatusSection({ threadId }: { threadId?: string }) {
  const status = useMcpStatus(threadId);
  const [all, setAll] = useState(false);
  if (!status?.servers.length) return null;
  const problems = status.servers.filter((s) => MCP_PROBLEM_STATES.includes(s.state));
  const fine = status.servers.filter((s) => !MCP_PROBLEM_STATES.includes(s.state));
  const shownFine = all || fine.length <= 3 ? fine : fine.slice(0, 3);
  return (
    <div className="info-section" data-testid="mcp-status">
      <div className="info-title">
        MCP servers
        {problems.length > 0 && <span className="small muted"> · {problems.length === 1 ? '1 not available' : `${problems.length} not available`}</span>}
      </div>
      {[...problems, ...shownFine].map((s) => (
        <Row key={s.name} s={s} />
      ))}
      {shownFine.length < fine.length && (
        <button className="btn ghost small muted" onClick={() => setAll(true)}>
          Show {fine.length - shownFine.length} more
        </button>
      )}
    </div>
  );
}
