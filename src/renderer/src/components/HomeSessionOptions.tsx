import { useEffect, useState } from 'react';
import type { ConfigOptionView } from '@shared/types';
import { acpSessionsApi } from '../acpSessionsApi';
import { ConfigPill } from './ConfigPills';
import '../acpSessions.css';

/**
 * The new-chat home screen's model / mode / setting pills, before a session exists. Values come from the agent's
 * `session/options` (or the options last seen for it); a change becomes the agent's default for new chats.
 * Renders nothing until there is something to show.
 */
export function HomeSessionOptions(props: { projectId: string; agentId: string }) {
  const [options, setOptions] = useState<ConfigOptionView[]>([]);

  useEffect(() => {
    let live = true;
    setOptions([]);
    acpSessionsApi
      .homeOptions(props.projectId, props.agentId)
      .then((r) => live && setOptions(r.configOptions))
      .catch(() => live && setOptions([]));
    return () => {
      live = false;
    };
  }, [props.projectId, props.agentId]);

  if (!options.length) return null;

  function change(o: ConfigOptionView, value: string) {
    setOptions((all) => all.map((x) => (x.id === o.id ? { ...x, currentValue: value } : x)));
    void acpSessionsApi.setHomeOption(props.agentId, o.id, value).catch(() => {});
  }

  return (
    <div className="acps-home-options" data-testid="home-session-options">
      {options.map((o) => (
        <ConfigPill key={o.id} option={o} title={o.description ? `${o.name} — ${o.description}` : `${o.name} for new chats`} onChange={(v) => change(o, v)} />
      ))}
    </div>
  );
}
