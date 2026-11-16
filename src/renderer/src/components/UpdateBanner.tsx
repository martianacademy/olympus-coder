import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/**
 * Tells the user when this window and the app behind it are different versions, which happens when a new
 * version is installed while Olympus keeps running (e.g. after "Keep running" on quit, only the window is
 * reopened): new parts of the window then don't work. Offers a restart into the installed version.
 */
export function UpdateBanner() {
  const [state, setState] = useState<'ok' | 'updated' | 'mismatch'>('ok');
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const check = () =>
      void window.desk
        .invoke('app.buildInfo')
        .then((b: { updated: boolean }) => setState(b.updated ? 'updated' : 'ok'))
        // An app too old to know this method is behind this window.
        .catch((e: any) => /Unknown method/.test(String(e?.message ?? e)) && setState('mismatch'));
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);
  if (state === 'ok' || hidden) return null;
  return (
    <div className="update-banner" role="status">
      <RefreshCw size={14} />
      <span className="grow">
        {state === 'updated'
          ? 'A new version of Olympus is installed. Restart to use it — running agents and terminals stop.'
          : 'Olympus kept running from an older version, so some parts of this window may not work. Quit Olympus fully (⌘Q → "Quit and stop them") and open it again.'}
      </span>
      {state === 'updated' && (
        <button className="btn small primary" onClick={() => void window.desk.invoke('app.restart')}>
          Restart
        </button>
      )}
      <button className="btn ghost icon" title="Later" onClick={() => setHidden(true)}>
        <X size={13} />
      </button>
    </div>
  );
}
