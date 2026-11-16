import { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw, X } from 'lucide-react';
import type { UpdateInfo } from '@shared/types';
import { api, onEvent } from '../api';
import { isRemoteBrowser } from '../responsive';

/**
 * Tells the user when this window and the app behind it are different versions, which happens when a new
 * version is installed while Olympus keeps running (e.g. after "Keep running" on quit, only the window is
 * reopened): new parts of the window then don't work. Offers a restart into the installed version.
 * Otherwise, when GitHub has a newer release (src/main/updates.ts), links to it; nothing is downloaded by the app.
 */
export function UpdateBanner() {
  const [state, setState] = useState<'ok' | 'updated' | 'mismatch'>('ok');
  const [hidden, setHidden] = useState(false);
  const [release, setRelease] = useState<UpdateInfo | null>(null);
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
  useEffect(() => {
    void api.currentUpdate().then(setRelease, () => {});
    return onEvent((channel, payload) => channel === 'update:available' && setRelease(payload));
  }, []);

  if (state !== 'ok' && !hidden)
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
  if (!release) return null;
  // On a phone the links open there (the Mac's browser is not in front of the user).
  const open = (url: string) => (isRemoteBrowser() ? window.open(url, '_blank', 'noopener,noreferrer') : void api.openExternal(url));
  return (
    <div className="update-banner" role="status" data-testid="release-banner">
      <ArrowDownToLine size={14} />
      <span className="grow">Olympus Coder {release.version} is available</span>
      <button className="btn small ghost" onClick={() => open(release.pageUrl)} data-testid="release-notes">
        What's new
      </button>
      <button className="btn small primary" onClick={() => open(release.downloadUrl)} data-testid="release-download">
        Download
      </button>
      <button
        className="btn ghost icon"
        title="Skip this version"
        aria-label="Skip this version"
        onClick={() => {
          setRelease(null);
          void api.skipUpdate(release.version);
        }}
        data-testid="release-skip"
      >
        <X size={13} />
      </button>
    </div>
  );
}
