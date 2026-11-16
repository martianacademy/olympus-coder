import { memo, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy, Play } from 'lucide-react';
import { api } from '../api';
import { isExternalUrl, LinkedText, looksLikePath, RefBaseContext, RunCommandContext, useOpenFile, withBase } from '../fileLinks';
import { copyText } from '../clipboard';
import { HighlightedCode } from '../codeHighlight';
import { langFromFence } from '../codeLang';

/** Web links open in the browser; every other link (a file path, file://, path:line) opens in the side panel. */
function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const open = useOpenFile();
  const base = useContext(RefBaseContext);
  const file = Boolean(href) && !isExternalUrl(href!) && !href!.startsWith('#');
  return (
    <a
      href={href}
      className={file ? 'file-link' : undefined}
      title={file ? `Open ${href} in the side panel` : href}
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        if (isExternalUrl(href)) void api.openExternal(href);
        else if (file) open(withBase(href, base));
      }}
    >
      {children}
    </a>
  );
}

/** Inline code that names a file (`src/app.ts:42`) is clickable too. */
function MdCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const open = useOpenFile();
  const base = useContext(RefBaseContext);
  const text =
    typeof children === 'string'
      ? children
      : Array.isArray(children) && children.every((c) => typeof c === 'string')
        ? children.join('')
        : null;
  if (!className && text && !text.includes('\n') && looksLikePath(text)) {
    return (
      <code className="file-ref" title={`Open ${text} in the side panel`} onClick={() => open(withBase(text, base))}>
        {children}
      </code>
    );
  }
  return <code className={className}>{children}</code>;
}

/** Images: web and data URLs as they are; local paths are read through the app. */
function MdImage({ src, alt }: { src?: string; alt?: string }) {
  const open = useOpenFile();
  const base = useContext(RefBaseContext);
  const [url, setUrl] = useState<string | undefined>(src && /^(https?:|data:)/i.test(src) ? src : undefined);
  useEffect(() => {
    if (!src || /^(https?:|data:)/i.test(src)) return;
    let alive = true;
    void api.preview(withBase(src, base)).then((p) => alive && (p.dataUrl || p.thumbUrl) && setUrl(p.kind === 'image' ? p.dataUrl : p.thumbUrl));
    return () => {
      alive = false;
    };
  }, [src, base]);
  const clickable = Boolean(src && !/^(https?:|data:)/i.test(src));
  return url ? (
    <img
      src={url}
      alt={alt ?? ''}
      className={`md-img ${clickable ? 'is-clickable' : ''}`}
      title={clickable ? 'Click to open preview' : alt}
      onClick={clickable ? () => open(withBase(src!, base)) : undefined}
    />
  ) : (
    <span className="muted small">[image: {alt || src}]</span>
  );
}

/**
 * Agents write math in several ways; remark-math only treats a `$$` block on its own lines as display math.
 * A line that is just `$$…$$` becomes a display block, and `\[…\]` / `\(…\)` become `$$…$$` / `$…$`.
 * Fenced code is left alone here (CodeBlock highlights it by its fence language).
 */
export function normalizeMath(md: string): string {
  if (!/\$\$|\\\[|\\\(/.test(md)) return md;
  return md
    .split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)
            .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_m, body: string) => `$$\n${body.trim()}\n$$`),
    )
    .join('');
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'fish', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat']);
const PLAIN_LANGS = new Set(['text', 'txt', 'plaintext', 'log', 'logs', 'output', 'console', 'stacktrace', 'traceback', 'error']);

/** Fenced code: a header with the language, Copy, and for shell code a Run button that runs it in the right panel. */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [ran, setRan] = useState(false);
  const run = useContext(RunCommandContext);
  const ref = useRef<HTMLPreElement>(null);
  const child: any = Array.isArray(children) ? children[0] : children;
  const lang = /language-([\w+#.-]+)/.exec(child?.props?.className ?? '')?.[1] ?? 'text';
  const canRun = Boolean(run) && SHELL_LANGS.has(lang.toLowerCase());
  const raw = child?.props?.children;
  const plain = PLAIN_LANGS.has(lang.toLowerCase()) && typeof raw === 'string' ? raw.replace(/\n$/, '') : null;
  const hlLang = plain === null && typeof raw === 'string' ? langFromFence(lang) : null;
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang}</span>
        <span className="spacer" />
        {canRun && (
          <button
            className="btn ghost codeblock-run"
            title="Run this in a new terminal in the right panel"
            onClick={() => {
              const cmd = (ref.current?.innerText ?? '').trim();
              if (!cmd) return;
              run!(cmd);
              setRan(true);
              setTimeout(() => setRan(false), 1500);
            }}
          >
            {ran ? <Check size={12} /> : <Play size={12} />} {ran ? 'Started' : 'Run'}
          </button>
        )}
        <button
          className="btn ghost"
          onClick={() => {
            void copyText(ref.current?.innerText ?? '').then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref}>
        {plain !== null ? (
          <code className={child?.props?.className}>
            <LinkedText text={plain} />
          </code>
        ) : hlLang ? (
          <code className={child?.props?.className}>
            <HighlightedCode text={(raw as string).replace(/\n$/, '')} lang={hlLang} />
          </code>
        ) : (
          children
        )}
      </pre>
    </div>
  );
}

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBreaks];
const REHYPE_PLUGINS: any[] = [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]];
const MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <MdLink href={href}>{children}</MdLink>,
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => <MdCode className={className}>{children}</MdCode>,
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => <MdImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
};
const URL_TRANSFORM = (url: string) => (/^\s*(javascript|vbscript):/i.test(url) ? '' : url);

/** Memoized GFM + KaTeX Markdown renderer with stable plugin/component references. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      urlTransform={URL_TRANSFORM}
      components={MD_COMPONENTS}
    >
      {normalizeMath(text)}
    </ReactMarkdown>
  );
});
