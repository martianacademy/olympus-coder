import { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw, X } from 'lucide-react';
import type { UpdateInfo } from '@shared/types';
import { api, onEvent } from '../api';
import { isRemoteBrowser } from '../responsive';

/**
 * Tells the user when this window and the app behind it are different versions, which happens when a new
 * version is installed while Olympus keeps running (e.g. after "Keep running" on quit, only the window is
 * reopened): new parts of the window then don't work. Offers a restart into the installed version.
 * Otherwise, when GitHub has a newer release (src/main/updates.ts): a notice with links, or in auto mode the download
 * progress and "ready — restart to update". A phone shows the notice only.
 */
export function UpdateBanner() {
  const [state, setState] = useState<'ok' | 'updated' | 'mismatch'>('ok');
  const [hidden, setHidden] = useState(false);
  const [release, setRelease] = useState<UpdateInfo | null>(null);
  /** "Later" on "ready": hidden for this window session. */
  const [laterFor, setLaterFor] = useState<string>();
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
  if (!release || laterFor === release.version) return null;
  const remote = isRemoteBrowser();
  // On a phone the links open there (the Mac's browser is not in front of the user).
  const open = (url: string) => (remote ? window.open(url, '_blank', 'noopener,noreferrer') : void api.openExternal(url));
  const pct = release.total ? Math.min(100, Math.round(((release.received ?? 0) / release.total) * 100)) : undefined;
  const text =
    release.state === 'ready'
      ? remote
        ? `Olympus Coder ${release.version} is ready to install on your Mac`
        : `Olympus Coder ${release.version} is ready — restart to update`
      : release.state === 'downloading'
        ? `${remote ? 'Your Mac is downloading' : 'Downloading'} Olympus Coder ${release.version}${pct !== undefined ? ` · ${pct}%` : '…'}`
        : `Olympus Coder ${release.version} is available`;
  const notes = (
    <button className="btn small ghost" onClick={() => open(release.pageUrl)} data-testid="release-notes">
      What's new
    </button>
  );
  return (
    <div className="update-banner" role="status" data-testid="release-banner" data-state={release.state ?? 'available'}>
      <ArrowDownToLine size={14} />
      <span className="grow">
        {text}
        {release.problem && !remote && (
          <span className="small muted" data-testid="release-problem">
            {' · '}
            {release.problem}
          </span>
        )}
      </span>
      {notes}
      {/* The phone shows the notice only: downloads and installs happen on the Mac. */}
      {!remote && release.state === 'downloading' && (
        <button className="btn small" onClick={() => void api.cancelUpdateDownload()} data-testid="release-cancel">
          Cancel
        </button>
      )}
      {!remote && release.state === 'ready' && (
        <>
          <button className="btn small primary" onClick={() => void api.installUpdate()} data-testid="release-restart">
            Restart
          </button>
          <button className="btn small ghost" onClick={() => setLaterFor(release.version)} data-testid="release-later">
            Later
          </button>
        </>
      )}
      {!remote && !release.state && (
        <button className="btn small primary" onClick={() => open(release.downloadUrl)} data-testid="release-download">
          Download
        </button>
      )}
      {release.state !== 'ready' && (
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
      )}
    </div>
  );
}
