import { useEffect, useState } from 'react';
import { Globe, X } from 'lucide-react';
import { onEvent } from '../api';

/**
 * One quiet toast when an agent tries to use Chrome while the Olympus Chrome extension isn't connected
 * (main sends `browser:needed` at most once per 10 minutes). Set up opens Settings → Connectors, where the
 * extension card has the three install steps. It hides by itself once the extension connects.
 */
export function ChromeExtToast({ onSetUp }: { onSetUp: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(
    () =>
      onEvent((ch, p) => {
        if (ch === 'browser:needed') setShow(true);
        else if (ch === 'browser:status' && p?.connected) setShow(false);
      }),
    [],
  );
  if (!show) return null;
  return (
    <div className="heat-toast ext-toast" role="status" data-testid="chrome-ext-toast">
      <Globe size={16} className="ext-toast-icon" />
      <div className="heat-body">
        <b>An agent wants to use your Chrome</b>
        <span className="small muted">Install the Olympus Chrome extension once. It takes about a minute.</span>
      </div>
      <div className="heat-actions">
        <button
          className="btn small primary"
          onClick={() => {
            setShow(false);
            onSetUp();
          }}
        >
          Set up
        </button>
      </div>
      <button className="btn ghost icon" title="Dismiss" onClick={() => setShow(false)}>
        <X size={13} />
      </button>
    </div>
  );
}
