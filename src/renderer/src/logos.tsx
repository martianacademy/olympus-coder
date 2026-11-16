import type { AgentDef } from '@shared/types';
// Official brand marks from LobeHub Icons (MIT), bundled so they work offline.
import claudecode from '@lobehub/icons-static-svg/icons/claudecode-color.svg?raw';
import antigravity from '@lobehub/icons-static-svg/icons/antigravity-color.svg?raw';
import codex from '@lobehub/icons-static-svg/icons/codex-color.svg?raw';
import geminicli from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg?raw';
import amp from '@lobehub/icons-static-svg/icons/amp-color.svg?raw';
import goose from '@lobehub/icons-static-svg/icons/goose.svg?raw';
import cline from '@lobehub/icons-static-svg/icons/cline.svg?raw';
import kilocode from '@lobehub/icons-static-svg/icons/kilocode.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw';
import junie from '@lobehub/icons-static-svg/icons/junie-color.svg?raw';
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?raw';
import windsurf from '@lobehub/icons-static-svg/icons/windsurf.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';

interface Logo {
  name: string;
  svg: string;
  /** Single-colour marks follow the theme's text colour; coloured marks keep their brand colours. */
  mono: boolean;
  /** Words in an agent's name or command that identify it. */
  match: RegExp;
}

const olympusSvg = '<svg viewBox="4 12 92 74" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill="#f97316" d="M 7 83 C 18.4 78.55 32.65 48.29 35.5 38.5 L 41.8 38.5 L 41.8 39.7 A 8.2 8.2 0 0 0 58.2 39.7 L 58.2 38.5 L 64.5 38.5 C 67.35 48.29 81.6 78.55 93 83 Z"/><circle fill="#fb923c" cx="50" cy="39.7" r="5.8"/><path stroke="#fdba74" stroke-width="5.5" stroke-linecap="round" d="M 25 27 C 25 21.5 25 21.5 33 21.5 L 42 21.5 C 48.5 21.5 50 16 50 16 C 50 16 51.5 21.5 58 21.5 L 67 21.5 C 75 21.5 75 21.5 75 27"/></svg>';

export const LOGOS: Record<string, Logo> = {
  olympus: { name: 'Olympus', svg: olympusSvg, mono: false, match: /\bolympus\b/i },
  claudecode: { name: 'Claude Code', svg: claudecode, mono: false, match: /claude/i },
  antigravity: { name: 'Antigravity', svg: antigravity, mono: false, match: /antigravity|\bagy\b/i },
  codex: { name: 'Codex', svg: codex, mono: false, match: /codex/i },
  geminicli: { name: 'Gemini CLI', svg: geminicli, mono: false, match: /gemini/i },
  opencode: { name: 'OpenCode', svg: opencode, mono: true, match: /opencode/i },
  qwen: { name: 'Qwen Code', svg: qwen, mono: false, match: /qwen/i },
  cursor: { name: 'Cursor', svg: cursor, mono: true, match: /cursor/i },
  amp: { name: 'Amp', svg: amp, mono: false, match: /\bamp\b/i },
  goose: { name: 'Goose', svg: goose, mono: true, match: /goose/i },
  cline: { name: 'Cline', svg: cline, mono: true, match: /cline/i },
  kilocode: { name: 'Kilo Code', svg: kilocode, mono: true, match: /kilo/i },
  kimi: { name: 'Kimi', svg: kimi, mono: false, match: /kimi|moonshot/i },
  junie: { name: 'Junie', svg: junie, mono: false, match: /junie/i },
  githubcopilot: { name: 'GitHub Copilot', svg: githubcopilot, mono: true, match: /copilot/i },
  windsurf: { name: 'Windsurf', svg: windsurf, mono: true, match: /windsurf/i },
  deepseek: { name: 'DeepSeek', svg: deepseek, mono: false, match: /deepseek/i },
  mistral: { name: 'Mistral', svg: mistral, mono: false, match: /mistral|vibe/i },
  grok: { name: 'Grok', svg: grok, mono: true, match: /grok|xai/i },
  ollama: { name: 'Ollama', svg: ollama, mono: true, match: /ollama/i },
  openai: { name: 'OpenAI', svg: openai, mono: true, match: /openai|\bgpt\b/i },
  gemini: { name: 'Gemini', svg: gemini, mono: false, match: /^$/ },
};

const BUILTIN: Record<string, string> = { olympus: 'olympus', claude: 'claudecode', antigravity: 'antigravity', codex: 'codex' };

/** Which logo an agent gets: its own choice, a built-in mapping, or a guess from its name and command. */
export function logoKeyFor(def: Pick<AgentDef, 'id' | 'name' | 'command' | 'args' | 'logo'>): string | undefined {
  if (def.logo && !def.logo.startsWith('data:')) return LOGOS[def.logo] ? def.logo : undefined;
  if (BUILTIN[def.id]) return BUILTIN[def.id];
  // Only the last part of each path counts, so a folder name such as `/Users/claude/…` can't pick the wrong logo.
  const tail = (s: string) => s.split(/[\\/]/).pop() ?? s;
  const hay = [def.name, ...[def.command, ...(def.args ?? [])].filter(Boolean).map(tail)].join(' ');
  return Object.entries(LOGOS).find(([, l]) => l.match.test(hay))?.[0];
}

const dataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const urlCache = new Map<string, string>();

/** The agent's logo in a rounded tile; falls back to the coloured letter badge. */
export function AgentLogo({ def, size = 22 }: { def: AgentDef; size?: number }) {
  const inner = Math.round(size * 0.72);
  if (def.logo?.startsWith('data:')) {
    return (
      <span className="agent-logo" style={{ width: size, height: size }} title={def.name}>
        <img src={def.logo} width={inner} height={inner} alt="" />
      </span>
    );
  }
  const key = logoKeyFor(def);
  const logo = key ? LOGOS[key] : undefined;
  if (!logo)
    return (
      <span className="badge" style={{ background: def.color, width: size, height: size, fontSize: size * 0.42 }} title={def.name}>
        {def.badge}
      </span>
    );
  if (logo.mono) {
    // Inline so `currentColor` picks up the theme colour.
    return <span className="agent-logo mono" style={{ width: size, height: size, fontSize: inner }} title={def.name} dangerouslySetInnerHTML={{ __html: logo.svg }} />;
  }
  if (!urlCache.has(key!)) urlCache.set(key!, dataUrl(logo.svg));
  return (
    <span className="agent-logo" style={{ width: size, height: size }} title={def.name}>
      <img src={urlCache.get(key!)} width={inner} height={inner} alt="" />
    </span>
  );
}

/** Pick an agent's logo: Auto (detected from name/command), any bundled brand mark, or an uploaded image. */
export function LogoPicker({ value, preview, onChange }: { value: string; preview: Pick<AgentDef, 'id' | 'name' | 'command' | 'args'>; onChange: (logo: string) => void }) {
  const detected = logoKeyFor({ ...preview, logo: '' });
  const tile = (key: string, label: string, node: React.ReactNode) => (
    <button type="button" key={key} className={`logo-choice ${value === key ? 'on' : ''}`} title={label} onClick={() => onChange(key)}>
      {node}
    </button>
  );
  const sample = (logo: string) => ({ ...preview, badge: (preview.name || '?').slice(0, 2).toUpperCase(), color: '#8b5cf6', description: '', builtin: false, logo }) as AgentDef;
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="small muted">
        Logo {detected && !value ? `— detected: ${LOGOS[detected].name}` : value && !value.startsWith('data:') ? `— ${LOGOS[value]?.name}` : ''}
      </span>
      <div className="logo-grid">
        {tile('', 'Auto (from name or command)', <span className="small">Auto</span>)}
        {Object.entries(LOGOS)
          .filter(([k]) => k !== 'gemini')
          .map(([k, l]) => tile(k, l.name, <AgentLogo def={sample(k)} size={26} />))}
        <label className={`logo-choice ${value.startsWith('data:') ? 'on' : ''}`} title="Upload your own image">
          {value.startsWith('data:') ? <AgentLogo def={sample(value)} size={26} /> : <span className="small">Upload</span>}
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const img = new Image();
              img.onload = () => {
                const c = document.createElement('canvas');
                c.width = c.height = 96;
                const ctx = c.getContext('2d')!;
                const s = Math.min(img.width, img.height);
                ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
                URL.revokeObjectURL(img.src);
                onChange(c.toDataURL('image/png'));
              };
              img.src = URL.createObjectURL(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
