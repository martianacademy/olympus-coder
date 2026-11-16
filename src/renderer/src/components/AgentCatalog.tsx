import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Loader2, Package, Search, SquareTerminal, X } from 'lucide-react';
import type { AgentDef, CatalogEntry, CatalogMethod } from '@shared/types';
import { api, onEvent } from '../api';
import { AgentLogo } from '../logos';
import { Terminal } from './Terminal';
import { copyText } from '../clipboard';

const METHOD_LABEL: Record<CatalogMethod, string> = {
  local: 'Use installed CLI',
  binary: 'Download',
  npx: 'Run with npx',
  uvx: 'Run with uvx',
};
const METHOD_HINT: Record<CatalogMethod, string> = {
  local: 'Uses the copy already installed on this computer.',
  binary: 'Downloads the agent from its official release, checks it against the registry, and keeps it in ~/.olympus/agents.',
  npx: 'Runs the npm package with npx — nothing is installed globally. The first run downloads it.',
  uvx: 'Runs the Python package with uvx. The first run downloads it.',
};

const asDef = (e: CatalogEntry): AgentDef => ({
  id: e.id,
  name: e.name,
  badge: e.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase(),
  color: '#8b5cf6',
  description: e.description,
  builtin: e.builtin,
  command: e.localPath ?? '',
  args: [],
});

function Row({ e, error, children }: { e: CatalogEntry; error?: string; children: React.ReactNode }) {
  return (
    <div className="catalog-row">
      <AgentLogo def={asDef(e)} size={30} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <b className="ellipsis">{e.name}</b>
          {e.localVersion && <span className="chip small">{e.localVersion}</span>}
        </div>
        <div className="small muted ellipsis" title={e.description}>
          {e.description}
        </div>
        {error && <div className="error-text small">{error}</div>}
      </div>
      {children}
    </div>
  );
}

/** Well-known coding agents first; the rest of the registry follows alphabetically. */
const POPULAR = ['gemini', 'github-copilot-cli', 'cursor', 'opencode', 'qwen-code', 'goose', 'cline', 'kilo', 'amp-acp', 'factory-droid', 'auggie', 'mistral-vibe', 'kimi-code', 'grok-build', 'junie', 'kiro', 'devin'];
const popularity = (id: string) => (POPULAR.includes(id) ? POPULAR.indexOf(id) : POPULAR.length);

const bestMethod = (e: CatalogEntry): CatalogMethod | undefined => e.methods.find((m) => !e.blocked[m]);

/**
 * Agents on this computer and in the ACP registry. Onboarding passes `autoAdd`, which adds every agent whose
 * CLI is already installed; anything missing can be installed or added with one click.
 */
export function AgentCatalog({ autoAdd, onChanged }: { autoAdd?: boolean; onChanged?: () => void }) {
  const [items, setItems] = useState<CatalogEntry[] | null>(null);
  const [autoAdded, setAutoAdded] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState<{ id: string; name: string; ptyId: string; done?: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    if (autoAdd) {
      const r = await api.autoAddInstalled().catch(() => null);
      if (r?.names.length) {
        setAutoAdded(r.names);
        onChanged?.();
      }
    }
    setItems(await api.catalog());
  };
  useEffect(() => {
    void load();
    return onEvent((ch, p) => {
      // An agent's add_agent / remove_agent tool changed the list: show it as added / not added.
      if (ch === 'agents:changed') void api.catalog().then(setItems);
      if (ch !== 'catalog:progress') return;
      if (p.phase === 'download') setBusy((b) => ({ ...b, [p.id]: p.total ? `Downloading ${Math.round(((p.received ?? 0) / p.total) * 100)}%` : `Downloading ${((p.received ?? 0) / 1e6).toFixed(1)} MB` }));
      if (p.phase === 'verify') setBusy((b) => ({ ...b, [p.id]: 'Verifying…' }));
      if (p.phase === 'extract') setBusy((b) => ({ ...b, [p.id]: 'Unpacking…' }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(e: CatalogEntry, method: CatalogMethod) {
    setErrors((x) => ({ ...x, [e.id]: '' }));
    setBusy((b) => ({ ...b, [e.id]: method === 'binary' ? 'Downloading…' : 'Adding…' }));
    try {
      await api.addFromCatalog(e.id, method);
      onChanged?.();
      setItems(await api.catalog());
    } catch (err: any) {
      setErrors((x) => ({ ...x, [e.id]: String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }));
    }
    setBusy((b) => {
      const n = { ...b };
      delete n[e.id];
      return n;
    });
  }

  async function install(e: CatalogEntry) {
    try {
      const ptyId = await api.installBuiltin(e.id);
      setInstalling({ id: e.id, name: e.name, ptyId });
    } catch (err: any) {
      setErrors((x) => ({ ...x, [e.id]: String(err?.message ?? err) }));
    }
  }

  const local = useMemo(() => (items ?? []).filter((e) => (e.builtin ? !e.localPath : e.localPath || e.added)), [items]);
  const more = useMemo(
    () =>
      (items ?? [])
        .filter((e) => !e.builtin && !e.localPath && !e.added)
        .filter((e) => !q.trim() || `${e.name} ${e.description}`.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => popularity(a.id) - popularity(b.id) || a.name.localeCompare(b.name)),
    [items, q],
  );

  if (!items)
    return (
      <div className="row muted small">
        <Loader2 size={14} className="spin" /> Looking for coding agents on this computer…
      </div>
    );

  return (
    <div className="catalog">
      {autoAdded.length > 0 && (
        <div className="ok-box small" style={{ cursor: 'default' }}>
          Found and added: {autoAdded.join(', ')}. You can remove any of them in Settings → Agents.
        </div>
      )}

      {local.length > 0 && <div className="catalog-title">On this computer</div>}
      {local.map((e) => (
        <Row key={e.id} e={e} error={errors[e.id]}>
          {e.added && (e.localPath || !e.builtin) ? (
            <span className="chip ok-chip">
              <Check size={12} /> {e.builtin ? 'Installed' : 'Added'}
            </span>
          ) : e.builtin && !e.localPath ? (
            <span className="row" style={{ gap: 6 }}>
              {e.installCommand && (
                <button
                  className="btn small ghost"
                  title={`Copy: ${e.installCommand}`}
                  onClick={() => {
                    void copyText(e.installCommand!).then((ok) => {
                      if (!ok) return;
                      setCopied(e.id);
                      setTimeout(() => setCopied(null), 1200);
                    });
                  }}
                >
                  {copied === e.id ? <Check size={13} /> : <Copy size={13} />}
                </button>
              )}
              {e.docs && (
                <button className="btn small ghost" title="Install guide" onClick={() => void api.openExternal(e.docs!)}>
                  <ExternalLink size={13} />
                </button>
              )}
              {e.installCommand ? (
                <button className="btn small primary" disabled={Boolean(e.blocked.local)} title={e.blocked.local ?? `Runs: ${e.installCommand}`} onClick={() => void install(e)}>
                  <SquareTerminal size={13} /> Install
                </button>
              ) : (
                <span className="chip">Not installed</span>
              )}
            </span>
          ) : (
            <button className="btn small primary" onClick={() => void add(e, 'local')} disabled={Boolean(busy[e.id])}>
              {busy[e.id] ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Add
            </button>
          )}
        </Row>
      ))}

      <div className="catalog-title row">
        <span>More agents</span>
        <span className="small muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          from the official ACP registry
        </span>
      </div>
      <label className="switch-search" style={{ margin: '0 0 6px' }}>
        <Search size={14} />
        <input placeholder={`Search ${more.length} agents`} value={q} onChange={(ev) => setQ(ev.target.value)} />
      </label>
      <div className="catalog-more">
        {more.map((e) => {
          const m = bestMethod(e);
          return (
            <Row key={e.id} e={e} error={errors[e.id]}>
              {busy[e.id] ? (
                <span className="small muted row" style={{ gap: 6, whiteSpace: 'nowrap' }}>
                  <Loader2 size={13} className="spin" /> {busy[e.id]}
                </span>
              ) : m ? (
                <span className="row" style={{ gap: 6 }}>
                  {e.methods.filter((x) => x !== m && !e.blocked[x]).length > 0 && (
                    <select className="mini-method" title="How to add it" defaultValue={m} id={`m-${e.id}`}>
                      {e.methods
                        .filter((x) => !e.blocked[x])
                        .map((x) => (
                          <option key={x} value={x} title={METHOD_HINT[x]}>
                            {METHOD_LABEL[x]}
                          </option>
                        ))}
                    </select>
                  )}
                  <button
                    className="btn small"
                    title={METHOD_HINT[m]}
                    onClick={() => {
                      const sel = document.getElementById(`m-${e.id}`) as HTMLSelectElement | null;
                      void add(e, (sel?.value as CatalogMethod) || m);
                    }}
                  >
                    {m === 'binary' ? <Download size={13} /> : <Package size={13} />} Add
                  </button>
                </span>
              ) : (
                <span className="small muted" title={Object.values(e.blocked).join(' · ')}>
                  {Object.values(e.blocked)[0]}
                </span>
              )}
            </Row>
          );
        })}
        {!more.length && <div className="small muted" style={{ padding: 8 }}>No agents match.</div>}
      </div>

      {installing && (
        <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && installing.done !== undefined && setInstalling(null)}>
          <div className="modal narrow">
            <div className="modal-head row">
              <SquareTerminal size={16} /> Installing {installing.name}
              <div className="spacer" />
              <button
                className="btn ghost icon"
                onClick={async () => {
                  if (installing.done === undefined) await api.ptyKill(installing.ptyId);
                  setInstalling(null);
                  setItems(await api.catalog());
                  onChanged?.();
                }}
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body col">
              <Terminal
                ptyId={installing.ptyId}
                onExit={(code) => {
                  setInstalling((i) => (i ? { ...i, done: code } : i));
                  void api.catalog().then(setItems);
                  onChanged?.();
                }}
              />
              {installing.done === undefined ? (
                <span className="small muted">Installing… you can answer any prompts in the terminal above.</span>
              ) : installing.done === 0 ? (
                <span className="small" style={{ color: 'var(--success)' }}>
                  Installed. {installing.name} is ready — log in from Settings → Agents if it asks.
                </span>
              ) : (
                <span className="error-text">Install failed (exit code {installing.done}). See the output above.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
