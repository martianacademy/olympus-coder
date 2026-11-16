import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, QrCode, RotateCcw, ShieldAlert, Smartphone, Trash2, Wifi, XCircle } from 'lucide-react';
import type { LockState, RemoteStatus } from '@shared/types';
import { api } from '../../api';
import { PasswordForm, type SettingsTab } from '../Settings';
import { copyText as writeClipboardText } from '../../clipboard';

const clean = (e: unknown) => String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const isRemote = () => typeof window !== 'undefined' && Boolean((window as any).__olympusRemote);
const ago = (ts?: number) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};

/**
 * Settings → Phone: serves the unified responsive Olympus workspace (chats, code editor, git, terminals, tasks)
 * over the end-to-end encrypted Cloudflare Relay, direct local Wi-Fi port, or Tailscale Serve.
 */
export function PhoneSettings({ lock, onLock }: { onTab: (t: SettingsTab) => void; lock: LockState; onLock: (l: LockState) => void }) {
  const remoteClient = isRemote();
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const load = () => void api.remoteStatus().then(setSt).catch((e) => setError(clean(e)));
  useEffect(load, []);

  const [qr, setQr] = useState<{ link: string; img: string } | null>(null);
  const [lanQr, setLanQr] = useState<{ url: string; img: string } | null>(null);
  useEffect(() => {
    if (!qr) return;
    const t = setTimeout(() => setQr(null), 180_000);
    return () => clearTimeout(t);
  }, [qr]);

  const showQr = async () => {
    setError('');
    try {
      const link = await api.remoteLink();
      if (!link) throw new Error('No relay address is set.');
      setQr({ link, img: await QRCode.toDataURL(link, { margin: 1, width: 232, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }) });
    } catch (e) {
      setError(clean(e));
    }
  };

  const buildLanQr = async (baseUrl: string, code: string) => {
    const link = `${baseUrl.replace(/\/+$/, '')}/#pair=${code}`;
    setLanQr({ url: baseUrl, img: await QRCode.toDataURL(link, { margin: 1, width: 184, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }) });
  };

  const showLanQr = async (url: string) => {
    setError('');
    try {
      let cur = st;
      if (!cur?.pairing || Date.now() >= cur.pairing.expiresAt - 5000) {
        cur = await api.remotePair();
        setSt(cur);
      }
      if (cur?.pairing?.code) await buildLanQr(url, cur.pairing.code);
    } catch (e) {
      setError(clean(e));
    }
  };

  useEffect(() => {
    if (lanQr && st?.pairing?.code && Date.now() < st.pairing.expiresAt) {
      void buildLanQr(lanQr.url, st.pairing.code);
    }
  }, [st?.pairing?.code]);

  const copyText = (key: string, value: string) => {
    void writeClipboardText(value).then((ok) => {
      if (!ok) return;
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? '' : c)), 1400);
    });
  };

  const [relayInput, setRelayInput] = useState<string | null>(null);
  useEffect(() => {
    if (!st?.enabled || remoteClient) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [st?.enabled, remoteClient]);

  const [, tick] = useState(0);
  useEffect(() => {
    if (!st?.pairing || remoteClient) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() > st.pairing!.expiresAt || Date.now() % 5000 < 1000) load();
    }, 1000);
    return () => clearInterval(t);
  }, [st?.pairing?.code, remoteClient]);

  const act = async (name: string, fn: () => Promise<RemoteStatus>) => {
    setBusy(name);
    setError('');
    try {
      setSt(await fn());
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy('');
    }
  };

  if (remoteClient) {
    return (
      <>
        <h3>Phone</h3>
        <p className="muted small">
          You are currently connected from a remote browser. Phone pairing, Wi-Fi hosting, and link revocation are managed directly in Olympus Coder on your Mac.
        </p>
        {st && (
          <div className="phone-card">
            <Smartphone size={18} />
            <div className="grow">
              <b>Connected to your Mac</b>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                Port {st.port} · {st.devices.length} paired device{st.devices.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>
        )}
      </>
    );
  }

  if (!st) return <div className="muted small">{error || 'Loading…'}</div>;
  const ts = st.tailscale;
  const left = st.pairing ? Math.max(0, Math.round((st.pairing.expiresAt - Date.now()) / 1000)) : 0;
  const relay = st.relay;

  return (
    <>
      <h3>Phone</h3>
      <p className="muted small" style={{ marginTop: -6 }}>
        Open the full responsive Olympus Coder workspace — chats, files, code editor, git, terminals, and Tasks — on your phone or tablet. Protected by pairing and your
        Olympus app password.
      </p>

      <div className="field">
        <label className="row" style={{ gap: 10 }}>
          <input type="checkbox" checked={st.enabled} disabled={busy === 'enable'} onChange={(e) => void act('enable', () => api.remoteEnable(e.target.checked))} />
          Phone access is {st.enabled ? 'on' : 'off'}
        </label>
      </div>

      {st.enabled && !relay.passwordSet && (
        <div className="phone-card warn">
          <KeyRound size={18} />
          <div className="grow">
            <b>First, choose an Olympus password</b>
            <p className="small muted">
              Your phone asks for your Olympus app password before unlocking full workspace, file-edit, and terminal access. It also protects this app on your Mac
              (Settings → App password).
            </p>
            <PasswordForm
              lock={lock}
              onLock={onLock}
              onDone={() => {
                load();
                void showQr();
              }}
            />
          </div>
        </div>
      )}

      {st.enabled && relay.passwordSet && (
        <div className="phone-card">
          <div className="phone-qr">
            {qr ? (
              <img src={qr.img} alt="QR code for the phone" width={232} height={232} />
            ) : (
              <button className="phone-qr-hidden" onClick={() => void showQr()} disabled={!relay.url}>
                <QrCode size={30} />
                <span>Show QR code</span>
              </button>
            )}
          </div>
          <div className="grow phone-howto">
            <b>Anywhere (End-to-End Encrypted Relay)</b>
            <ol>
              <li>Scan the code with your phone's camera.</li>
              <li>Type your Olympus app password.</li>
              <li>
                Optional: <i>Add to Home Screen</i> (Safari Share menu or Chrome ⋮ menu) for full-screen app mode.
              </li>
            </ol>
            <div className={`phone-relay-state ${relay.state}`}>
              <span className="dot" />
              {relay.state === 'online'
                ? relay.phones
                  ? `Ready · ${relay.phones} phone${relay.phones > 1 ? 's' : ''} connected now`
                  : 'Ready for your phone'
                : relay.state === 'connecting'
                  ? 'Connecting to the relay…'
                  : relay.error || 'Not connected'}
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {qr && (
                <button className="btn small" onClick={() => copyText('relay', qr.link)}>
                  <Copy size={12} /> {copied === 'relay' ? 'Copied' : 'Copy link'}
                </button>
              )}
              <button
                className="btn small ghost"
                disabled={!!busy}
                title="Makes a new QR code; phones using the old one have to scan again"
                onClick={() => {
                  if (!confirm('Make a new phone link? Every phone connected through the QR code is signed out and has to scan the new code.')) return;
                  setQr(null);
                  void act('reset', () => api.remoteResetLink());
                }}
              >
                <RotateCcw size={12} /> New link
              </button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Every message is AES-256-GCM encrypted between this Mac and your phone; the relay cannot read your code or chats.
            </p>
          </div>
        </div>
      )}

      {st.enabled && (
        <div className="phone-card" style={{ flexDirection: 'column', gap: 10 }}>
          <div className="row" style={{ width: '100%', gap: 10 }}>
            <Wifi size={17} style={{ color: 'var(--accent)', flex: 'none' }} />
            <div className="grow">
              <b>Same Wi-Fi / Local Port ({st.port})</b>
              <div className="small muted">Serve this exact responsive app directly from your Mac on your local network — zero relay latency.</div>
            </div>
            <button
              className={`switch ${st.lan ? 'on' : ''}`}
              disabled={busy === 'lan'}
              onClick={() => {
                setLanQr(null);
                void act('lan', () => api.remoteSetLan(!st.lan));
              }}
              aria-label="Host on local Wi-Fi"
              data-testid="remote-lan-toggle"
            />
          </div>

          {st.lan && (
            <div className="col" style={{ width: '100%', gap: 8, paddingTop: 4 }}>
              {st.firewall?.active && !st.firewall.allowed && (
                <div className="phone-card warn" style={{ margin: 0, padding: '10px 12px' }} data-testid="lan-firewall-warn">
                  <ShieldAlert size={17} style={{ flex: 'none' }} />
                  <div className="grow">
                    <b>Allow Olympus Coder in macOS Firewall</b>
                    <div className="small muted" style={{ marginTop: 2 }}>
                      macOS Firewall is on and blocks incoming Wi-Fi connections until this app is permitted.
                    </div>
                  </div>
                  <button
                    className="btn small primary"
                    disabled={busy === 'fw'}
                    onClick={() => void act('fw', () => api.remoteAllowFirewall())}
                    data-testid="remote-allow-firewall-btn"
                  >
                    {busy === 'fw' ? 'Waiting…' : 'Allow in Firewall'}
                  </button>
                </div>
              )}
              {st.lanUrls.length ? (
                st.lanUrls.map((u, idx) => (
                  <div key={u} className="device-row" style={{ margin: 0 }}>
                    <span className="mono small grow ellipsis">
                      {u}
                      {idx === 0 && u.includes('//172.20.10.') ? ' (Hotspot IP)' : u.endsWith(`.local:${st.port}`) ? ' (Bonjour)' : ''}
                    </span>
                    <button className="btn small ghost" onClick={() => copyText(u, st.pairing && left > 0 ? `${u}/#pair=${st.pairing.code}` : u)}>
                      <Copy size={12} /> {copied === u ? 'Copied' : 'Copy'}
                    </button>
                    <button className="btn small ghost" onClick={() => void showLanQr(u)}>
                      <QrCode size={12} /> QR
                    </button>
                  </div>
                ))
              ) : (
                <div className="small muted">Connect this Mac to Wi-Fi or Ethernet to get a LAN address.</div>
              )}
              {st.hotspotDetected && (
                <div className="small muted" style={{ lineHeight: 1.45 }}>
                  Connected via iPhone Personal Hotspot: if Safari on the hotspot iPhone stalls on the IP, open the <span className="mono">.local</span> address above
                  (pause any VPN / Private Relay on the iPhone), or use the <b>Anywhere</b> QR code above.
                </div>
              )}
              {lanQr && (
                <div className="row" style={{ gap: 12, alignItems: 'center', padding: '6px 0' }}>
                  <img src={lanQr.img} alt={lanQr.url} width={148} height={148} style={{ borderRadius: 8, background: '#fff' }} />
                  <div className="small muted">
                    Scan with your iPhone Camera to open <span className="mono">{lanQr.url}</span> with the 6-digit code pre-filled
                    {relay.passwordSet ? ', then enter your Olympus app password.' : '.'}
                  </div>
                </div>
              )}
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn small primary" disabled={!!busy} onClick={() => void act('pair', () => api.remotePair())} data-testid="remote-pair-btn">
                  <Smartphone size={12} /> {st.pairing && left > 0 ? 'New 6-digit code' : 'Pair a phone'}
                </button>
                {st.pairing && left > 0 && (
                  <span className="mono" style={{ fontWeight: 700, fontSize: '1.15em', letterSpacing: '.1em', color: 'var(--accent)' }} data-testid="remote-pair-code">
                    {st.pairing.code.replace(/(\d{3})(\d{3})/, '$1 $2')}
                    <span className="small muted" style={{ fontWeight: 400, letterSpacing: 0, marginLeft: 8 }}>
                      ({Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')})
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {st.enabled && (
        <>
          <div className="field" style={{ marginTop: 14 }}>
            <label>Paired devices</label>
            {st.devices.length ? (
              st.devices.map((d) => (
                <div key={d.id} className="device-row">
                  <Smartphone size={14} className="muted" />
                  <span className="grow">{d.name}</span>
                  <span className="small muted">
                    {d.via === 'local' ? 'Wi-Fi / Tailscale · ' : 'Relay · '}last used {ago(d.lastSeen)}
                  </span>
                  <button className="btn ghost small danger" title="This phone can no longer connect" onClick={() => void act('rm', () => api.remoteRemoveDevice(d.id))}>
                    <Trash2 size={12} /> Remove
                  </button>
                </div>
              ))
            ) : (
              <div className="small muted">None yet.</div>
            )}
          </div>

          <details className="phone-more">
            <summary>Advanced (Tailscale HTTPS, localhost test & custom relay)</summary>
            <p className="small" style={{ fontWeight: 600, margin: '6px 0 0' }}>
              Tailscale Serve (private HTTPS from anywhere without relay)
            </p>
            {!ts ? (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '6px 0 10px' }}>
                <button className="btn small" disabled={!!busy} onClick={() => void act('ts', () => api.remoteCheckTailscale())}>
                  {busy === 'ts' ? <Loader2 size={12} className="spin" /> : null} Check Tailscale on this Mac
                </button>
                <span className="small muted">Opens Tailscale if installed.</span>
              </div>
            ) : (
              <>
                <div className="phone-step">
                  <div className="phone-step-n">1</div>
                  <div className="grow">
                    <b>Tailscale on this Mac and your phone</b>
                    {!ts.installed ? (
                      <p className="small muted">
                        Install Tailscale on both devices.{' '}
                        <button className="link-btn" onClick={() => void api.openExternal('https://tailscale.com/download')}>
                          Download Tailscale <ExternalLink size={11} />
                        </button>
                      </p>
                    ) : !ts.running ? (
                      <p className="small muted">Tailscale is installed but not connected.</p>
                    ) : (
                      <p className="small ok-row">
                        <CheckCircle2 size={13} /> Connected as <span className="mono">{ts.dnsName}</span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="phone-step">
                  <div className="phone-step-n">2</div>
                  <div className="grow">
                    <b>Private HTTPS address</b>
                    {ts.serving && ts.url ? (
                      <div className="row" style={{ gap: 8, marginTop: 4 }}>
                        <span className="mono small">{ts.url}</span>
                        <button className="btn small" onClick={() => copyText('ts', ts.url!)}>
                          <Copy size={12} /> {copied === 'ts' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    ) : (
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                        <button className="btn small primary" disabled={!ts.installed || !ts.running || !!busy} onClick={() => void act('serve', () => api.remoteTailscaleServe())}>
                          {busy === 'serve' ? <Loader2 size={12} className="spin" /> : null} Set up Tailscale Serve
                        </button>
                        <span className="small muted">
                          or run <span className="mono">{ts.serveCommand}</span>
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {!st.lan && (
              <div className="phone-step">
                <div className="phone-step-n">3</div>
                <div className="grow">
                  <b>Pair with 6-digit code</b>
                  {st.pairing && left > 0 && (
                    <div className="pair-code">
                      <span className="mono">{st.pairing.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</span>
                      <span className="small muted">
                        {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
                      </span>
                    </div>
                  )}
                  <button className="btn small" disabled={!!busy} onClick={() => void act('pair', () => api.remotePair())}>
                    <Smartphone size={12} /> {st.pairing && left > 0 ? 'New code' : 'Pair a phone'}
                  </button>
                </div>
              </div>
            )}

            <p className="small muted">
              Test unified browser mode on this Mac:{' '}
              <button className="link-btn" onClick={() => void api.openExternal(st.localUrl)}>
                {st.localUrl}
              </button>
            </p>

            <p className="small" style={{ fontWeight: 600, margin: '14px 0 4px' }}>
              Relay address
            </p>
            <div className="row" style={{ gap: 6 }}>
              <input className="grow mono input" placeholder={relay.defaultUrl || 'https://…'} value={relayInput ?? relay.url} onChange={(e) => setRelayInput(e.target.value)} />
              <button
                className="btn small"
                disabled={relayInput === null || !!busy}
                onClick={() => {
                  setQr(null);
                  void act('relay', () => api.remoteSetRelayUrl(relayInput ?? '')).then(() => setRelayInput(null));
                }}
              >
                Save
              </button>
            </div>
          </details>
        </>
      )}
      {error && (
        <p className="small error-text">
          <XCircle size={12} /> {error}
        </p>
      )}
    </>
  );
}
