import { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { Settings, UpdateCheck, UpdateMode } from '@shared/types';
import { api, onEvent } from '../../api';
import { isRemoteBrowser } from '../../responsive';

const MODES: { id: UpdateMode; label: string; line: string }[] = [
  { id: 'notify', label: 'Notify me', line: 'Once a day Olympus asks GitHub for the latest release and shows a notice when one is out. Nothing is downloaded.' },
  { id: 'auto', label: 'Automatic', line: 'New versions download in the background and are checked against their checksums. They install when you restart Olympus.' },
  { id: 'off', label: 'Off', line: 'Olympus never asks GitHub about new versions.' },
];

/** Settings → General → Updates: how new versions arrive (src/main/updates.ts), and "Check now". */
export function UpdateSettings(props: { settings: Settings; platform: string; update: (patch: Partial<Settings>) => Promise<void> }) {
  const mode = props.settings.updateMode ?? 'notify';
  const [last, setLast] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.lastUpdateCheck().then(setLast, () => {});
    return onEvent((channel, payload) => channel === 'update:checked' && setLast(payload));
  }, []);
  const remote = isRemoteBrowser();
  const switchRow = (on: boolean, flip: () => void, label: string, id: string) => (
    <div className="row">
      <button className={`switch ${on ? 'on' : ''}`} onClick={flip} data-testid={id} />
      <label>{label}</label>
    </div>
  );
  return (
    <div className="field" data-testid="update-settings">
      <label>Updates</label>
      {remote ? (
        <span className="small muted">Updates are managed on your Mac ({MODES.find((m) => m.id === mode)?.label}).</span>
      ) : (
        <>
          <div className="seg" role="radiogroup" aria-label="How updates arrive">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'active' : ''} onClick={() => void props.update({ updateMode: m.id })} data-testid={`update-mode-${m.id}`}>
                {m.label}
              </button>
            ))}
          </div>
          <span className="small muted">{MODES.find((m) => m.id === mode)?.line}</span>
          {mode === 'auto' && (
            <>
              {switchRow(props.settings.updateInstallOnQuit !== false, () => void props.update({ updateInstallOnQuit: props.settings.updateInstallOnQuit === false }), 'Install when I quit', 'update-install-on-quit')}
              {props.platform === 'darwin' && (
                <>
                  {switchRow(!!props.settings.updateWifiOnly, () => void props.update({ updateWifiOnly: !props.settings.updateWifiOnly }), 'Only download on Wi-Fi', 'update-wifi-only')}
                  {props.settings.updateWifiOnly && <span className="small muted">A phone hotspot joined over Wi-Fi also counts as Wi-Fi.</span>}
                </>
              )}
            </>
          )}
          {mode !== 'off' && (
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api
                    .checkUpdates()
                    .then(setLast, () => {})
                    .finally(() => setBusy(false));
                }}
                data-testid="update-check-now"
              >
                {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Check now
              </button>
              {last && (
                <span className="small muted" data-testid="update-last-check">
                  {new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {last.text}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
