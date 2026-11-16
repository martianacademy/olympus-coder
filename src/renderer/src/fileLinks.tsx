import { createContext, memo, useContext } from 'react';

/**
 * Opening a file mentioned in the chat (a Markdown link, a `path:line` in code, a tool's file, an attachment)
 * in the side panel. App provides the handler; anything under it can call `useOpenFile()`.
 */
export const OpenFileContext = createContext<(ref: string) => void>(() => {});
export const useOpenFile = () => useContext(OpenFileContext);

const EXT =
  'js|mjs|cjs|jsx|ts|tsx|mts|cts|json|jsonc|md|mdx|markdown|txt|css|scss|sass|less|html|htm|xml|svg|yml|yaml|toml|ini|cfg|conf|env|lock|log|csv|tsv|' +
  'py|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|sql|graphql|gql|proto|vue|svelte|astro|lua|dart|ex|exs|erl|' +
  'scala|clj|r|jl|pl|tf|hcl|gradle|plist|pbxproj|xcconfig|dockerfile|makefile|png|jpg|jpeg|gif|webp|bmp|ico|avif|pdf|ipynb|patch|diff';
const PATH_RE = new RegExp(`^(~|\\.{1,2})?/?([\\w@.+-]+/)*[\\w@.+-]*\\.(${EXT})(:\\d+(:\\d+)?|#L\\d+(-L?\\d+)?)?$`, 'i');
const BARE = /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG|AGENTS|CLAUDE|GEMINI)(\.\w+)?$/;

/** Text in inline code that reads as a file path: has a known extension (or is a well-known file name), no spaces. */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 300 || /\s/.test(t)) return false;
  if (/^file:\/\//i.test(t)) return true;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return false; // other schemes and things like node:assert (but not file.ts:12)
  return PATH_RE.test(t) || BARE.test(t);
}

/** Links that leave the app (web, mail) versus links to files. */
export const isExternalUrl = (href: string) => /^(https?:|mailto:)/i.test(href);

/** Folder that relative links resolve against (set by the file preview for links inside a file). */
export const RefBaseContext = createContext<string | undefined>(undefined);

/** A link or image path, made absolute against `base` when it is relative. */
export function withBase(ref: string, base?: string): string {
  if (!base || /^(\/|~|[a-z][a-z0-9+.-]*:(?!\d))/i.test(ref)) return ref;
  return `${base.replace(/\/$/, '')}/${ref.replace(/^\.\//, '')}`;
}

/** Runs a shell command in a new terminal tab of the workbench (null where there is no workbench, e.g. Chat mode). */
export const RunCommandContext = createContext<((command: string) => void) | null>(null);

const PYTHON_FILE_RE = /File "([^"<>]+)", line (\d+)/g;
const GENERAL_FILE_RE =
  /(?<![\w/.:-])((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;

/**
 * File references in one line of terminal text: `src/a.ts:12:5`, `./x.py:3`, `/abs/f.go:9`, `a.ts(12,5)`,
 * Python's `File "x.py", line 12`. Only paths with a line number, or with a folder in them, count.
 */
export function fileRefs(text: string): { index: number; length: number; ref: string }[] {
  if (!text) return [];
  const hasPy = text.includes('File "');
  const hasDot = text.includes('.');
  if (!hasPy && !hasDot) return [];

  const out: { index: number; length: number; ref: string }[] = [];
  if (hasPy) {
    for (const m of text.matchAll(PYTHON_FILE_RE)) {
      out.push({ index: (m.index ?? 0) + 6, length: m[1].length, ref: `${m[1]}:${m[2]}` });
    }
  }
  if (hasDot) {
    for (const m of text.matchAll(GENERAL_FILE_RE)) {
      const path = m[1];
      const ln = m[2] ?? m[4];
      if (!ln && !path.includes('/')) continue;
      if (/^\d+(\.\d+)+$/.test(path) || /^v?\d/.test(path.split('/').pop() ?? '')) continue; // versions, not files
      const idx = m.index ?? 0;
      if (out.some((o) => idx < o.index + o.length && idx + m[0].length > o.index)) continue;
      out.push({ index: idx, length: m[0].length, ref: ln ? `${path}:${ln}` : path });
    }
  }
  return out;
}

/**
 * Plain text (tool output, logs, stack traces) with its file references clickable: each opens at its line.
 * Coalesces plain text spans so multi-thousand-line logs mount a handful of DOM text nodes instead of N spans.
 */
export const LinkedText = memo(function LinkedText({ text }: { text: string }) {
  const open = useOpenFile();
  const base = useContext(RefBaseContext);
  if (!text || (!text.includes('.') && !text.includes('File "'))) return <>{text}</>;

  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let plainBuf = '';
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const refs = fileRefs(line);
    if (!refs.length) {
      plainBuf += li < lines.length - 1 ? `${line}\n` : line;
      continue;
    }
    let at = 0;
    for (const r of refs) {
      if (r.index > at) plainBuf += line.slice(at, r.index);
      if (plainBuf) {
        nodes.push(plainBuf);
        plainBuf = '';
      }
      const refStr = r.ref;
      nodes.push(
        <span key={`${li}:${r.index}`} className="file-ref inline" title={`Open ${refStr}`} onClick={() => open(withBase(refStr, base))}>
          {line.slice(r.index, r.index + r.length)}
        </span>,
      );
      at = r.index + r.length;
    }
    if (at < line.length) plainBuf += line.slice(at);
    if (li < lines.length - 1) plainBuf += '\n';
  }
  if (plainBuf) nodes.push(plainBuf);
  return <>{nodes}</>;
});
