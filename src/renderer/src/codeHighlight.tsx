import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Parser } from '@lezer/common';
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight';
import { MAX_HIGHLIGHT_CHARS, splitGutters, type GutterStyle } from './codeLang';
import './codeHighlight.css';

/**
 * Static (non-editor) syntax highlighting for code in chat: BASH / RESULT boxes, file read / edit boxes, diffs and
 * Markdown fences. Grammars load lazily from `@codemirror/language-data`; colours are `--hl-*` CSS variables set from
 * the editor's syntax theme (`syntaxPalettes.ts`). Text is shown plain until its grammar has loaded, with the same
 * layout, so nothing shifts when colours arrive.
 */

/** Lezer tag → CSS class. Identifiers and punctuation keep the normal text colour on purpose (calmer). */
const HIGHLIGHTER = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier, t.self], class: 'hl-k' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName, t.standard(t.variableName)], class: 'hl-f' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.url], class: 'hl-s' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], class: 'hl-n' },
  { tag: [t.typeName, t.className, t.namespace, t.macroName, t.standard(t.typeName)], class: 'hl-t' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'hl-c' },
  { tag: [t.propertyName, t.definition(t.propertyName), t.special(t.variableName)], class: 'hl-p' },
  { tag: [t.tagName], class: 'hl-g' },
  { tag: [t.attributeName], class: 'hl-a' },
  { tag: [t.inserted], class: 'hl-ins' },
  { tag: [t.deleted], class: 'hl-del' },
  { tag: [t.meta, t.processingInstruction, t.annotation], class: 'hl-m' },
  { tag: [t.heading], class: 'hl-h' },
  { tag: [t.strong], class: 'hl-b' },
  { tag: [t.emphasis], class: 'hl-i' },
  { tag: [t.link], class: 'hl-l' },
]);

// ---------------------------------------------------------------------------------------------------------------
// Grammar loading

const parsers = new Map<string, Parser | null>();
const loading = new Map<string, Promise<Parser | null>>();
const loadListeners = new Set<() => void>();

type LangRegistry = {
  match: (lang: string) => { load: () => Promise<{ language: { parser: Parser } }> } | null;
};
let registryPromise: Promise<LangRegistry> | null = null;

/** Lazily loads `@codemirror/language` + `@codemirror/language-data` on the first highlighted code block. */
function getRegistry(): Promise<LangRegistry> {
  if (!registryPromise) {
    registryPromise = Promise.all([import('@codemirror/language'), import('@codemirror/language-data')]).then(
      ([{ LanguageDescription }, { languages }]) => ({
        match: (lang: string) => LanguageDescription.matchLanguageName(languages, lang, false),
      }),
    );
  }
  return registryPromise;
}

/** Starts loading the grammar for `lang` (a language-data name/alias); listeners re-render when it arrives. */
function loadParser(lang: string): void {
  if (parsers.has(lang) || loading.has(lang)) return;
  const p = getRegistry()
    .then((reg) => {
      const desc = reg.match(lang);
      return desc ? desc.load().then((support) => support.language.parser) : null;
    })
    .catch((err: unknown) => {
      console.warn(`[codeHighlight] could not load the ${lang} grammar`, err);
      return null;
    })
    .then((parser) => {
      parsers.set(lang, parser);
      loading.delete(lang);
      loadListeners.forEach((fn) => fn());
      return parser;
    });
  loading.set(lang, p);
}

/** The loaded parser for `lang`, or null while loading / when there is no grammar. */
function useParser(lang: string | null): Parser | null {
  const [, bump] = useState(0);
  const parser = lang ? (parsers.get(lang) ?? null) : null;
  useEffect(() => {
    if (!lang || parsers.has(lang)) return;
    const fn = () => {
      if (parsers.has(lang)) bump((n) => n + 1);
    };
    loadListeners.add(fn);
    loadParser(lang);
    return () => {
      loadListeners.delete(fn);
    };
  }, [lang]);
  return parser;
}

// ---------------------------------------------------------------------------------------------------------------
// Highlighting (memoized by language + text)

export interface HlToken {
  text: string;
  cls: string;
}
export type HlLine = HlToken[];

const CACHE_LIMIT = 240;
const cache = new Map<string, HlLine[]>();

/** Highlights one document into lines of tokens. */
function highlightDoc(parser: Parser, code: string): HlLine[] {
  const lines: HlLine[] = [[]];
  const tree = parser.parse(code);
  highlightCode(
    code,
    tree,
    HIGHLIGHTER,
    (text, cls) => lines[lines.length - 1].push({ text, cls }),
    () => lines.push([]),
  );
  return lines;
}

/** Highlighted lines for `code`; `perLine` parses each line on its own (grep matches are not one document). */
export function highlightLines(parser: Parser, lang: string, code: string, perLine = false): HlLine[] {
  const key = `${lang}\u0000${perLine ? 1 : 0}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let lines: HlLine[];
  try {
    lines = perLine ? code.split('\n').map((l) => (l ? highlightDoc(parser, l)[0] : [])) : highlightDoc(parser, code);
  } catch (err) {
    console.warn('[codeHighlight] highlighting failed; showing plain text', err);
    lines = code.split('\n').map((l) => [{ text: l, cls: '' }]);
  }
  cache.set(key, lines);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return lines;
}

/** Texts above this size wait until they stop changing (streaming) before they are highlighted again. */
const SETTLE_CHARS = 20_000;

/** `text` once it has not changed for a moment; small texts pass straight through. */
function useSettled(text: string): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (settled === text) return;
    if (text.length < SETTLE_CHARS) {
      setSettled(text);
      return;
    }
    const id = setTimeout(() => setSettled(text), 250);
    return () => clearTimeout(id);
  }, [text, settled]);
  return text.length < SETTLE_CHARS ? text : settled;
}

/** The tokens of one highlighted line (shared with the diff view). */
export function HlTokens({ line }: { line: HlLine | undefined }) {
  if (!line) return null;
  return (
    <>
      {line.map((tok, i) =>
        tok.cls ? (
          <span key={i} className={tok.cls}>
            {tok.text}
          </span>
        ) : (
          tok.text
        ),
      )}
    </>
  );
}

/**
 * Highlighted lines for a whole document with React-side memo + lazy grammar loading. Returns null until the grammar
 * is ready (or when highlighting is off), so callers render plain text meanwhile.
 */
export function useHighlightedLines(text: string, lang: string | null, enabled = true): HlLine[] | null {
  const on = Boolean(enabled && lang && text && text.length <= MAX_HIGHLIGHT_CHARS);
  const parser = useParser(on ? lang : null);
  const settled = useSettled(text);
  return useMemo(
    () => (on && parser && settled === text ? highlightLines(parser, lang!, text) : null),
    [on, parser, lang, text, settled],
  );
}

export interface HighlightedCodeProps {
  text: string;
  /** language-data name/alias; null renders `fallback` (or the text) unchanged. */
  lang: string | null;
  /** Leading line-number styles to split into a dim, non-selectable gutter. */
  gutters?: readonly GutterStyle[];
  /** Highlight each line separately (grep output). */
  perLine?: boolean;
  /** What to render when there is nothing to highlight (e.g. `<LinkedText>` for plain output). */
  fallback?: ReactNode;
}

/**
 * Highlighted code meant to sit inside an existing `<pre>`. Lines with a gutter render as rows whose number comes
 * from CSS `::before`, so selecting or copying the code never picks the numbers up.
 */
export const HighlightedCode = memo(function HighlightedCode({ text, lang, gutters, perLine = false, fallback }: HighlightedCodeProps) {
  const on = Boolean(lang && text && text.length <= MAX_HIGHLIGHT_CHARS);
  const parser = useParser(on ? lang : null);
  const settled = useSettled(text);
  const useGutter = Boolean(on && gutters && gutters.length);

  const split = useMemo(() => (useGutter ? splitGutters(text, gutters!) : null), [useGutter, text, gutters]);

  const lines = useMemo((): HlLine[] | null => {
    if (!on || !parser || settled !== text) return null;
    if (!split) return highlightLines(parser, lang!, text, perLine);
    // Contiguous code (cat -n, nl, reads) is one document; grep matches are highlighted line by line.
    const out: HlLine[] = new Array(split.length);
    let i = 0;
    while (i < split.length) {
      if (split[i].match || perLine) {
        out[i] = split[i].code === '--' && split[i].match ? [{ text: '--', cls: 'hl-sep' }] : (highlightLines(parser, lang!, split[i].code, true)[0] ?? []);
        i++;
        continue;
      }
      let j = i;
      while (j < split.length && !split[j].match) j++;
      const block = highlightLines(
        parser,
        lang!,
        split
          .slice(i, j)
          .map((l) => l.code)
          .join('\n'),
      );
      for (let k = i; k < j; k++) out[k] = block[k - i] ?? [];
      i = j;
    }
    return out;
  }, [on, parser, settled, text, split, lang, perLine]);

  if (!on) return <>{fallback ?? text}</>;

  if (split) {
    const width = split.reduce((w, l) => Math.max(w, l.gutter.length), 1);
    return (
      <span className="hl-code has-gutter" data-lang={lang ?? undefined} data-highlighted={lines ? 'true' : 'false'} style={{ '--hl-gw': `${width}ch` } as CSSProperties}>
        {split.map((l, i) => (
          <span key={i} className="hl-row">
            <span className="hl-gutter" data-n={l.gutter} aria-hidden="true" />
            <span className="hl-row-code">{lines ? <HlTokens line={lines[i]} /> : l.code}</span>
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="hl-code" data-lang={lang ?? undefined} data-highlighted={lines ? 'true' : 'false'}>
      {lines
        ? lines.map((line, i) => (
            <span key={i}>
              {i > 0 && '\n'}
              <HlTokens line={line} />
            </span>
          ))
        : text}
    </span>
  );
});
