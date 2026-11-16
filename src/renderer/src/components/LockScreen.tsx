import { useEffect, useRef, useState } from 'react';
import { Fingerprint, Lock } from 'lucide-react';
import type { LockState } from '@shared/types';
import { api } from '../api';

export function LockScreen({ lock, onUnlocked }: { lock: LockState; onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(lock.retryAfterMs);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (lock.options.touchId && lock.touchIdAvailable) void touch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1000)), 1000);
    return () => clearInterval(t);
  }, [wait > 0]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    const r = await api.unlock(pw);
    setBusy(false);
    setPw('');
    if (r.ok) onUnlocked();
    else {
      setError(r.error ?? 'Wrong password');
      setWait(r.state.retryAfterMs);
      input.current?.focus();
    }
  }

  async function touch() {
    const r = await api.unlockTouchId();
    if (r.ok) onUnlocked();
    else if (r.error) setError(r.error);
  }

  return (
    <div className="fullscreen">
      <div className="drag" />
      <form className="lock-box" onSubmit={submit}>
        <div className="lock-icon">
          <Lock size={30} />
        </div>
        <h2 style={{ margin: 0 }}>Olympus Coder is locked</h2>
        <p className="muted" style={{ margin: 0 }}>
          Enter your password to see projects and chats.
        </p>
        <input
          ref={input}
          className="input"
          type="password"
          placeholder="Password"
          value={pw}
          disabled={wait > 0}
          onChange={(e) => setPw(e.target.value)}
          data-testid="lock-password"
        />
        {error && <div className="error-text">{error}</div>}
        {wait > 0 && <div className="muted small">Try again in {Math.ceil(wait / 1000)}s</div>}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || wait > 0}>
          Unlock
        </button>
        {lock.options.touchId && lock.touchIdAvailable && (
          <button type="button" className="btn" onClick={touch}>
            <Fingerprint size={16} /> Touch ID
          </button>
        )}
      </form>
    </div>
  );
}
