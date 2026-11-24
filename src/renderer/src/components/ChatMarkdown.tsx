import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Play } from 'lucide-react';
import { api } from '../api';
import { isExternalUrl, LinkedText, looksLikePath, RefBaseContext, RunCommandContext, useOpenFile, withBase } from '../fileLinks';
import { copyText } from '../clipboard';
import { HighlightedCode } from '../codeHighlight';
import { langFromFence } from '../codeLang';
import { normalizeMath } from '@shared/markdownMath';
import { isViewerTarget, openViewer, viewerAttrs, viewerKindOf } from '../mediaViewerApi';
import { extractBlockMediaLinks, type HastNode } from '../markdownMedia';
import { MdMediaStrip } from './MdMediaPreview';

function openRefSmart(ref: string, from: Element | null, openInPanel: (r: string) => void) {
  if (isViewerTarget(ref)) openViewer({ ref, from, openInPanel });
  else openInPanel(ref);
}

/** Web links open in the browser; media/rich-doc links open in MediaViewer; code/line links open in the side panel. */
function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const open = useOpenFile();
  const base = useContext(RefBaseContext);
  const file = Boolean(href) && !isExternalUrl(href!) && !href!.startsWith('#');
  return (
    <a
      href={href}
      className={file ? 'file-link' : undefined}
      title={file ? `Open ${href}` : href}
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        if (isExternalUrl(href)) void api.openExternal(href);
        else if (file) openRefSmart(withBase(href, base), e.currentTarget, open);
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
      <code className="file-ref" title={`Open ${text}`} onClick={(e) => openRefSmart(withBase(text, base), e.currentTarget, open)}>
        {children}
      </code>
    );
  }
  return <code className={className}>{children}</code>;
}

/** Images: web and data URLs as they are; local paths are read through the app and open in MediaViewer. */
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
  const resolved = src ? withBase(src, base) : '';
  return url ? (
    <img
      src={url}
      alt={alt ?? ''}
      {...(clickable ? viewerAttrs(resolved, viewerKindOf(resolved), alt || undefined) : {})}
      className={`md-img ${clickable ? 'is-clickable' : ''}`}
      title={clickable ? 'Click to open preview' : alt}
      onClick={clickable ? (e) => openRefSmart(resolved, e.currentTarget, open) : undefined}
    />
  ) : (
    <span className="muted small">[image: {alt || src}]</span>
  );
}

/** Math syntax clean-up and money-vs-math `$` handling live in @shared/markdownMath (unit-tested). */
export { normalizeMath };

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

const REMARK_PLAIN: any[] = [remarkGfm, remarkBreaks];
const EMPTY_REHYPE: any[] = [];

type MathBundle = { remark: any[]; rehype: any[] };
let mathBundle: MathBundle | null = null;
let mathLoading: Promise<MathBundle | null> | null = null;
const mathListeners = new Set<() => void>();

/** Lazily loads remark-math, rehype-katex and KaTeX CSS on the first message that actually contains math. */
function loadMathBundle(): void {
  if (mathBundle || mathLoading) return;
  mathLoading = Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')])
    .then(([rm, rk]) => {
      mathBundle = {
        remark: [remarkGfm, rm.default, remarkBreaks],
        rehype: [[rk.default, { throwOnError: false, strict: false, output: 'html' }]],
      };
      mathListeners.forEach((fn) => fn());
      return mathBundle;
    })
    .catch((err: unknown) => {
      console.warn('[ChatMarkdown] could not load KaTeX math plugins', err);
      mathLoading = null;
      return null;
    });
}

/** True when normalized markdown contains a `$$` block or at least two unescaped `$` on a line. */
function hasMathSyntax(md: string): boolean {
  if (!md.includes('$')) return false;
  for (const line of md.split('\n')) {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') {
        i++;
        continue;
      }
      if (line[i] === '$' && ++count >= 2) return true;
    }
  }
  return false;
}

/** Paragraphs: standalone local media links upgrade to inline previews; prose paragraphs keep text + attach previews below. */
function MdParagraph({ node, children }: { node?: HastNode; children?: React.ReactNode }) {
  const { links, standalone } = extractBlockMediaLinks(node);
  if (!links.length) return <p>{children}</p>;
  if (standalone) return <MdMediaStrip links={links} standalone />;
  return (
    <>
      <p>{children}</p>
      <MdMediaStrip links={links} />
    </>
  );
}

/** Tight list items with local media links attach previews inside the item (loose lists use `<p>` and aren't duplicated). */
function MdListItem({ node, children, className }: { node?: HastNode; children?: React.ReactNode; className?: string }) {
  const { links } = extractBlockMediaLinks(node);
  if (!links.length) return <li className={className}>{children}</li>;
  return (
    <li className={className}>
      {children}
      <MdMediaStrip links={links} />
    </li>
  );
}

const MD_COMPONENTS = {
  p: ({ node, children }: { node?: HastNode; children?: React.ReactNode }) => <MdParagraph node={node}>{children}</MdParagraph>,
  li: ({ node, children, className }: { node?: HastNode; children?: React.ReactNode; className?: string }) => (
    <MdListItem node={node} className={className}>
      {children}
    </MdListItem>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <MdLink href={href}>{children}</MdLink>,
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => <MdCode className={className}>{children}</MdCode>,
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => <MdImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
};
const URL_TRANSFORM = (url: string) => (/^\s*(javascript|vbscript):/i.test(url) ? '' : url);

/** Memoized GFM + lazy KaTeX Markdown renderer with stable plugin/component references. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const normalized = useMemo(() => normalizeMath(text), [text]);
  const needsMath = useMemo(() => hasMathSyntax(normalized), [normalized]);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!needsMath || mathBundle) return;
    const onLoaded = () => bump((n) => n + 1);
    mathListeners.add(onLoaded);
    loadMathBundle();
    return () => {
      mathListeners.delete(onLoaded);
    };
  }, [needsMath]);

  const plugins = needsMath && mathBundle ? mathBundle : null;
  return (
    <ReactMarkdown
      remarkPlugins={plugins ? plugins.remark : REMARK_PLAIN}
      rehypePlugins={plugins ? plugins.rehype : EMPTY_REHYPE}
      urlTransform={URL_TRANSFORM}
      components={MD_COMPONENTS}
    >
      {normalized}
    </ReactMarkdown>
  );
});
