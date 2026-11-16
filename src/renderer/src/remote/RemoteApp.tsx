import { useEffect, useState } from 'react';
import { KeyRound, Lock, QrCode, Smartphone, WifiOff } from 'lucide-react';
import { applyTheme } from '../theme';
import { DEFAULT_THEME } from '@shared/themes';
import App from '../App';
import {
  type Conn,
  connectEvents,
  connectRelay,
  forgetMac,
  getToken,
  isLocalPasswordSet,
  isRelay,
  localAuthInfo,
  login,
  onConn,
  pair,
  passwordReason,
  setToken,
  unlockLocal,
} from './bridge';

const defaultPhoneName = () => (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone');

/**
 * Unified remote entry: handles lightweight authentication / pairing for both the E2EE Cloudflare Relay
 * and the Mac's direct local/Wi-Fi/Tailscale HTTP server, then mounts the exact same responsive `<App />`
 * used on desktop — zero duplicate chat, project, or workbench UI.
 */
export function RemoteApp() {
  return isRelay ? <RelayGate /> : <LocalGate />;
}

function RelayGate() {
  const [conn, setConnState] = useState<Conn>('offline');
  const [everOnline, setEverOnline] = useState(false);

  useEffect(() => {
    const off = onConn((c) => {
      setConnState(c);
      if (c === 'online') setEverOnline(true);
      if (c === 'scan') setEverOnline(false);
    });
    connectRelay();
    return () => {
      off();
    };
  }, []);

  if (conn === 'scan') return <ScanScreen />;
  if (conn === 'password' || conn === 'nopassword') return <RelayPasswordScreen noPassword={conn === 'nopassword'} />;
  if (!everOnline) return <WaitScreen conn={conn} />;
  return (
    <div className="remote-host">
      {conn !== 'online' && (
        <div className="r-conn-banner" role="status">
          {conn === 'macoff' ? 'Your Mac is offline — waiting for Olympus Coder…' : 'Reconnecting to your Mac…'}
        </div>
      )}
      <App />
    </div>
  );
}

function LocalGate() {
  const [paired, setPaired] = useState(Boolean(getToken()));
  const [conn, setConnState] = useState<Conn>('offline');
  const [everOnline, setEverOnline] = useState(false);

  useEffect(() => {
    const off = onConn((c) => {
      setConnState(c);
      if (c === 'online') setEverOnline(true);
    });
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (paired) connectEvents();
  }, [paired]);

  useEffect(() => {
    if (conn === 'unpaired') {
      setToken('');
      setPaired(false);
      setEverOnline(false);
    }
  }, [conn]);

  if (!paired) return <PairScreen onPaired={() => setPaired(true)} />;
  if (conn === 'locked') return <LocalUnlockScreen onUnlocked={() => connectEvents()} />;
  if (!everOnline && conn === 'offline') {
    return (
      <BrandScreen>
        <p className="muted">Connecting to your Mac…</p>
      </BrandScreen>
    );
  }
  return (
    <div className="remote-host">
      {conn === 'offline' && (
        <div className="r-conn-banner" role="status">
          Reconnecting to your Mac…
        </div>
      )}
      <App />
    </div>
  );
}

function BrandScreen({ children }: { children: React.ReactNode }) {
  useEffect(() => applyTheme(DEFAULT_THEME), []);
  return <div className="r-pair">{children}</div>;
}

function ScanScreen() {
  return (
    <BrandScreen>
      <QrCode size={34} className="r-pair-icon" />
      <h1>Connect to your Mac</h1>
      <p className="muted">
        On your Mac, open Olympus Coder → Settings → <b>Phone</b> and scan the QR code with this phone's camera.
      </p>
    </BrandScreen>
  );
}

function WaitScreen({ conn }: { conn: Conn }) {
  return (
    <BrandScreen>
      {conn === 'macoff' ? (
        <>
          <WifiOff size={34} className="r-pair-icon" />
          <h1>Your Mac is offline</h1>
          <p className="muted">Open Olympus Coder on your Mac (with Phone turned on in Settings). This page connects automatically.</p>
          <p className="muted small">Created a new link on the Mac? Scan its new QR code.</p>
        </>
      ) : (
        <p className="muted">Connecting to your Mac…</p>
      )}
      <button className="link-btn small" onClick={forgetMac}>
        Use a different Mac
      </button>
    </BrandScreen>
  );
}

function RelayPasswordScreen({ noPassword }: { noPassword: boolean }) {
  const locked = passwordReason() === 'locked';
  const [password, setPassword] = useState('');
  const [name, setName] = useState(defaultPhoneName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await login(password, name.trim() || 'Phone');
      setPassword('');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (noPassword) {
    return (
      <BrandScreen>
        <KeyRound size={34} className="r-pair-icon" />
        <h1>Set a password on your Mac</h1>
        <p className="muted">
          For your safety, full workspace access requires an Olympus app password. On your Mac, open Settings → <b>App password</b> and set one, then return here.
        </p>
      </BrandScreen>
    );
  }

  return (
    <BrandScreen>
      {locked ? <Lock size={34} className="r-pair-icon" /> : <KeyRound size={34} className="r-pair-icon" />}
      <h1>{locked ? 'Your Mac is locked' : 'Enter your password'}</h1>
      <p className="muted">
        {locked ? 'Type your Olympus app password to continue on this phone. Your Mac stays locked.' : 'Enter the Olympus Coder app password from your Mac.'}
      </p>
      <form
        className="r-form-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void go();
        }}
      >
        <input className="r-input" type="password" autoComplete="current-password" placeholder="App password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {!locked && (
          <label className="small muted">
            Name for this phone
            <input className="r-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <button className="btn primary r-big" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
      {error && <p className="error-text small">{error}</p>}
      <button className="link-btn small" onClick={forgetMac}>
        Use a different Mac
      </button>
    </BrandScreen>
  );
}

function readInitialPairCode(): string {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    const p = (h.get('pair') ?? '').replace(/\D/g, '').slice(0, 6);
    if (p) history.replaceState(null, '', location.pathname + location.search);
    return p;
  } catch {
    return '';
  }
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState(readInitialPairCode);
  const [password, setPassword] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [name, setName] = useState(defaultPhoneName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const goWith = async (pairCode: string, pw?: string) => {
    setBusy(true);
    setError('');
    try {
      await pair(pairCode, name.trim() || 'Phone', pw);
      onPaired();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void localAuthInfo().then((r) => {
      const reqPw = Boolean(r.passwordRequired);
      setNeedPw(reqPw);
      if (!reqPw && code.replace(/\D/g, '').length === 6) {
        void goWith(code.replace(/\D/g, ''));
      }
    });
  }, []);

  const go = () => goWith(code.replace(/\D/g, ''), needPw ? password : undefined);

  const digits = code.replace(/\D/g, '');
  return (
    <BrandScreen>
      <Smartphone size={34} className="r-pair-icon" />
      <h1>Connect to your Mac</h1>
      <p className="muted">
        On your Mac, open Olympus Coder → Settings → <b>Phone</b> and press <b>Pair a phone</b>. Enter the 6-digit code shown there.
      </p>
      <form
        className="r-form-col"
        style={{ alignItems: 'center' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (digits.length === 6 && (!needPw || password)) void go();
        }}
      >
        <input
          className="r-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="000 000"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          data-testid="pair-code-input"
        />
        {needPw && (
          <label className="small muted" style={{ alignSelf: 'stretch' }}>
            Olympus app password
            <input
              className="r-input"
              type="password"
              autoComplete="current-password"
              placeholder="App password"
              autoFocus={digits.length === 6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="pair-password-input"
            />
          </label>
        )}
        <label className="small muted" style={{ alignSelf: 'stretch' }}>
          Name for this device
          <input className="r-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn primary r-big" type="submit" disabled={busy || digits.length !== 6 || (needPw && !password)} data-testid="pair-submit-btn">
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      {error && <p className="error-text small">{error}</p>}
    </BrandScreen>
  );
}

function LocalUnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const hasPw = isLocalPasswordSet();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await unlockLocal(password);
      setPassword('');
      onUnlocked();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BrandScreen>
      <Lock size={34} className="r-pair-icon" />
      <h1>Your Mac is locked</h1>
      {hasPw ? (
        <>
          <p className="muted">Enter your Olympus app password to unlock this session. Your Mac window stays locked.</p>
          <form
            className="r-form-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) void go();
            }}
          >
            <input className="r-input" type="password" autoComplete="current-password" placeholder="App password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn primary r-big" type="submit" disabled={busy || !password}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>
          {error && <p className="error-text small">{error}</p>}
        </>
      ) : (
        <p className="muted">Unlock Olympus Coder on your Mac to continue.</p>
      )}
    </BrandScreen>
  );
}
