import { useEffect, useState } from 'react';
import { Flame, Pause, Square, X } from 'lucide-react';
import type { DeskEvents } from '@shared/types';
import { api, onEvent } from '../api';

type Alert = DeskEvents['heat:alert'];

/**
 * A small toast in the corner when a program keeps the CPU busy for about a minute or the Mac gets hot,
 * with Pause and Stop for the heaviest program. One at a time; it stays until acted on or dismissed.
 */
export function HeatToast() {
  const [alert, setAlert] = useState<Alert | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => onEvent((ch, p) => ch === 'heat:alert' && (setAlert(p), setError(''))), []);
  if (!alert) return null;
  const t = alert.task;
  const act = async (action: 'pause' | 'stop') => {
    if (!t) return;
    setBusy(true);
    try {
      await api.procControl(t.id, action);
      setAlert(null);
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };
  const name = t ? t.title.split('\n')[0].slice(0, 60) : '';
  return (
    <div className={`heat-toast ${alert.reason}`} role="alert">
      <Flame size={16} className="heat-icon" />
      <div className="heat-body">
        <b>{alert.reason === 'thermal' ? `Your Mac is running hot (${alert.thermal})` : 'A program is working the CPU hard'}</b>
        {t ? (
          <span className="small muted">
            <span className="mono">{name}</span> · CPU {Math.round(t.cpu)}%{t.memMB ? ` · ${t.memMB >= 1024 ? `${(t.memMB / 1024).toFixed(1)} GB` : `${t.memMB} MB`}` : ''}
          </span>
        ) : (
          <span className="small muted">None of the programs Olympus started is busy.</span>
        )}
        {error && <span className="small error-text">{error}</span>}
      </div>
      {t && (
        <div className="heat-actions">
          {t.canPause && (
            <button className="btn small" disabled={busy} onClick={() => void act('pause')} title="Pause it now; resume it from the Tasks tab">
              <Pause size={12} /> Pause
            </button>
          )}
          <button className="btn small danger" disabled={busy} onClick={() => void act('stop')}>
            <Square size={11} /> Stop
          </button>
        </div>
      )}
      <button className="btn ghost icon" title="Dismiss" onClick={() => setAlert(null)}>
        <X size={13} />
      </button>
    </div>
  );
}
