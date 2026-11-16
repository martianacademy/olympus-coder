import { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import type { Settings } from '@shared/types';

const WEEK = 7 * 86_400_000;

/**
 * A single, quiet suggestion to set an app password: only when none is set, only after the user has really
 * used the app (a few chats), shown a little after start, and easy to put off for a week or for good.
 * Olympus asks for no account, so this password is what keeps the projects private on a shared laptop.
 */
export function SecurityNudge(props: {
  lockEnabled: boolean;
  touchId: boolean;
  chats: number;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onSetPassword: () => void;
}) {
  const n = props.settings.securityNudge ?? {};
  const due = !props.lockEnabled && props.settings.onboarded && !n.never && (n.snoozedUntil ?? 0) < Date.now() && props.chats >= 3;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!due) return;
    const t = setTimeout(() => setReady(true), 30_000);
    return () => clearTimeout(t);
  }, [due]);
  if (!due || !ready) return null;

  const later = () => props.onSettings({ securityNudge: { ...n, snoozedUntil: Date.now() + WEEK } });
  return (
    <div className="sec-nudge" role="dialog" aria-label="Set an app password">
      <div className="sec-nudge-icon">
        <ShieldCheck size={18} />
      </div>
      <div className="sec-nudge-body">
        <b>Keep your projects private on this Mac</b>
        <p>
          Olympus has no account and no server of its own: your chats, code and agent logins are stored only on this Mac. That also means nothing stops
          someone who opens this laptop from seeing them. An app password does{props.touchId ? ', and you can unlock with Touch ID' : ''}. Your phone uses
          the same password to connect.
        </p>
        <div className="sec-nudge-actions">
          <button
            className="btn small primary"
            onClick={() => {
              // If it is set, the card never comes back; if the user backs out, it waits a day.
              props.onSettings({ securityNudge: { ...n, snoozedUntil: Date.now() + 86_400_000 } });
              props.onSetPassword();
            }}
          >
            Set a password
          </button>
          <button className="btn small ghost" onClick={later}>
            Not now
          </button>
          <span className="grow" />
          <button className="link-btn small muted" onClick={() => props.onSettings({ securityNudge: { ...n, never: true } })}>
            Don't remind me
          </button>
        </div>
      </div>
      <button className="btn ghost icon sec-nudge-close" title="Not now" onClick={later}>
        <X size={13} />
      </button>
    </div>
  );
}
