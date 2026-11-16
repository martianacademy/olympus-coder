import { useContext, useMemo } from 'react';
import type { ToolContentView } from '@shared/types';
import { HighlightedCode, HlTokens, useHighlightedLines, type HlLine } from '../codeHighlight';
import { hasNumGutter, langFromPath, looksLikeJson } from '../codeLang';
import { LinkedText, RefBaseContext, useOpenFile, withBase } from '../fileLinks';
import type { ParsedToolStep, ToolItem } from '../toolStep';
import { compactPath, readLineSpan, toolQueryOf } from '../workStepSummary';
import { InlineFilePreviews, isRichPreviewPath } from './InlineFilePreviews';
import { fileNameOf, shortDirOf, StepBox, StepBoxSection } from './StepBox';
import type { StepKind } from './stepIcons';

const MAX_RENDER_CHARS = 16_000;
const MAX_DIFF_LINES = 600;

/** Caps very long text so a box never renders megabytes into the DOM; Copy still copies the full text. */
function clip(text: string): string {
  return text.length > MAX_RENDER_CHARS
    ? `${text.slice(0, MAX_RENDER_CHARS)}\n… (${text.length - MAX_RENDER_CHARS} more characters — use Copy for the full text)`
    : text;
}

const splitLines = (text: string | null | undefined): string[] => (text ? text.replace(/\n$/, '').split('\n') : []);

interface DiffPair {
  path?: string;
  oldText: string;
  newText: string;
}

/** Edit pairs recorded only in a tool's JSON input (agents that send no ACP diff content). */
function diffsFromInput(input: string): DiffPair[] {
  if (!input.trim().startsWith('{')) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return []; // Truncated or non-JSON input: there is nothing structured to show as a diff.
  }
  const str = (o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
    return '';
  };
  const pairs: DiffPair[] = [];
  const one = (o: Record<string, unknown>) => {
    const oldText = str(o, ['old_string', 'oldText', 'old_str', 'TargetContent']);
    const newText = str(o, ['new_string', 'newText', 'new_str', 'ReplacementContent']);
    if (oldText || newText) pairs.push({ oldText, newText });
  };
  one(obj);
  for (const key of ['edits', 'ReplacementChunks', 'chunks']) {
    const list = obj[key];
    if (Array.isArray(list)) for (const e of list) if (e && typeof e === 'object') one(e as Record<string, unknown>);
  }
  if (!pairs.length) {
    const content = str(obj, ['content', 'CodeContent', 'file_text']);
    if (content) pairs.push({ oldText: '', newText: content });
  }
  return pairs;
}

/** Changed region above which lines are no longer LCS-aligned (old × new lines), to keep rendering cheap. */
const MAX_LCS_CELLS = 40_000;
/** Unchanged lines kept around each change; longer unchanged runs fold into one "unchanged lines" row. */
const DIFF_CONTEXT = 3;

type DiffOp = { t: 'ctx' | 'del' | 'add'; text: string };
type DiffRow = DiffOp | { t: 'gap'; n: number };

interface LineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** The whole diff as text (`+`/`-`/two-space prefixes, nothing folded), for Copy. */
  text: string;
}

/** Aligns the changed middle of an edit: an LCS for small regions, else all removed lines then all added ones. */
function alignChanged(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (!n || !m || n * m > MAX_LCS_CELLS) {
    return [...a.map((text): DiffOp => ({ t: 'del', text })), ...b.map((text): DiffOp => ({ t: 'add', text }))];
  }
  // lcs[i * w + j] = length of the longest common subsequence of a[i..] and b[j..].
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ t: 'del', text: a[i++] });
    } else {
      out.push({ t: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ t: 'del', text: a[i++] });
  while (j < m) out.push({ t: 'add', text: b[j++] });
  return out;
}

/** Folds unchanged runs longer than the context window into a single `gap` row. */
function foldContext(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t !== 'ctx') {
      rows.push(ops[i++]);
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].t === 'ctx') j++;
    const run = ops.slice(i, j);
    const head = i === 0 ? 0 : DIFF_CONTEXT;
    const tail = j === ops.length ? 0 : DIFF_CONTEXT;
    const hidden = run.length - head - tail;
    if (hidden > 1) rows.push(...run.slice(0, head), { t: 'gap', n: hidden }, ...run.slice(run.length - tail));
    else rows.push(...run);
    i = j;
  }
  return rows;
}

/** Line diff of one edit: common leading/trailing lines are shared context, only the middle counts as changed. */
function lineDiff(oldText: string, newText: string): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: DiffOp[] = [
    ...a.slice(0, pre).map((text): DiffOp => ({ t: 'ctx', text })),
    ...alignChanged(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((text): DiffOp => ({ t: 'ctx', text })),
  ];
  const added = ops.filter((o) => o.t === 'add').length;
  const removed = ops.filter((o) => o.t === 'del').length;
  const prefix = { ctx: '  ', del: '- ', add: '+ ' } as const;
  return {
    rows: added || removed ? foldContext(ops) : [],
    added,
    removed,
    text: ops.map((o) => prefix[o.t] + o.text).join('\n'),
  };
}

/** Old-side / new-side line index of every diff row, so rows can pick their line from the highlighted texts. */
function rowSides(rows: DiffRow[]): number[] {
  const at: number[] = [];
  let a = 0;
  let b = 0;
  for (const r of rows) {
    if (r.t === 'gap') {
      at.push(-1);
      a += r.n;
      b += r.n;
    } else if (r.t === 'add') at.push(b++);
    else {
      at.push(a++);
      if (r.t === 'ctx') b++;
    }
  }
  return at;
}

function DiffLines({ rows, oldText, newText, lang }: { rows: DiffRow[]; oldText: string; newText: string; lang: string | null }) {
  const shown = rows.slice(0, MAX_DIFF_LINES);
  const hidden = rows.length - shown.length;
  // Both sides are highlighted as whole files so strings and comments spanning lines colour correctly.
  const oldLines = useHighlightedLines(oldText.replace(/\n$/, ''), lang, Boolean(oldText) && shown.length > 0);
  const newLines = useHighlightedLines(newText.replace(/\n$/, ''), lang, Boolean(newText) && shown.length > 0);
  const sides = useMemo(() => rowSides(rows), [rows]);
  const lineOf = (r: DiffOp, j: number): HlLine | undefined => (r.t === 'add' ? newLines : oldLines)?.[sides[j]];
  return (
    <pre className="step-box-pre step-box-diff">
      {shown.map((r, j) => {
        if (r.t === 'gap') {
          return (
            <div key={j} className="diff-gap">
              ⋯ {r.n} unchanged lines
            </div>
          );
        }
        const line = lineOf(r, j);
        return (
          <div key={j} className={`${r.t === 'del' ? 'diff-del' : r.t === 'add' ? 'diff-add' : 'diff-ctx'} ${line ? 'is-hl' : ''}`}>
            <span className="diff-sign">{r.t === 'del' ? '- ' : r.t === 'add' ? '+ ' : '  '}</span>
            {line ? <HlTokens line={line} /> : r.text}
          </div>
        );
      })}
      {!rows.length && <div className="step-box-note">No line changes.</div>}
      {hidden > 0 && <div className="step-box-note">… {hidden} more lines — use Copy or Open for the rest</div>}
    </pre>
  );
}

function DiffMeta({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="step-box-add">+{added}</span> <span className="step-box-del">−{removed}</span>
    </>
  );
}

function FileLinks({ paths }: { paths: string[] }) {
  const openFile = useOpenFile();
  const base = useContext(RefBaseContext);
  return (
    <div className="step-box-files">
      {paths.map((p) => (
        <button key={p} type="button" className="file-link step-box-file mono" onClick={() => openFile(withBase(p, base))}>
          {p}
        </button>
      ))}
    </div>
  );
}

function OutputPre({ text, prose, lang }: { text: string; prose?: boolean; lang?: string | null }) {
  // Prose (web pages, search results) is a div: `.tool-body pre` forces the code font size app-wide.
  if (prose) {
    return (
      <div className="step-box-pre is-prose">
        <LinkedText text={clip(text)} />
      </div>
    );
  }
  if (lang) return <CodePre text={text} lang={lang} />;
  return (
    <pre className="step-box-pre">
      <LinkedText text={clip(text)} />
    </pre>
  );
}

/** Source code (a file read, JSON input/output): highlighted, with read-tool line numbers as a dim gutter. */
function CodePre({ text, lang }: { text: string; lang: string }) {
  const shown = text.slice(0, MAX_RENDER_CHARS);
  const numbered = useMemo(() => hasNumGutter(shown), [shown]);
  return (
    <pre className="step-box-pre">
      <HighlightedCode text={shown} lang={lang} gutters={numbered ? NUM_GUTTERS : undefined} />
      {text.length > MAX_RENDER_CHARS && (
        <span className="hl-m">{`\n… (${text.length - MAX_RENDER_CHARS} more characters — use Copy for the full text)`}</span>
      )}
    </pre>
  );
}

const NUM_GUTTERS = ['num'] as const;

/** JSON text gets JSON colours; everything else stays plain. */
const jsonLang = (text: string): string | null => (text.length <= 150_000 && looksLikeJson(text) ? 'json' : null);

export interface StepBodyProps {
  item: ToolItem;
  parsed: ParsedToolStep;
  kind: StepKind;
  diffs: ToolContentView[];
  stepPaths: string[];
  running: boolean;
}

/** File read: the returned content in a file box (or a visual preview for images, video, PDF and Office files). */
function ReadBody({ item, parsed, stepPaths, running }: StepBodyProps) {
  const openFile = useOpenFile();
  const base = useContext(RefBaseContext);
  const rich = stepPaths.filter(isRichPreviewPath);
  const plain = stepPaths.filter((p) => !isRichPreviewPath(p));
  const span = readLineSpan(item);
  const textPaths = plain.length ? plain : rich.length ? [] : [''];
  return (
    <>
      {rich.length > 0 && <InlineFilePreviews paths={rich} onOpen={openFile} />}
      {textPaths.map((p, i) => (
        <StepBox
          key={p || i}
          kind="read"
          title={p ? fileNameOf(p) : parsed.headerTitle || 'File'}
          sub={p ? shortDirOf(p, base) : undefined}
          meta={span || undefined}
          filePath={p || undefined}
          copyText={i === 0 ? parsed.output : undefined}
        >
          {i === 0 && parsed.output ? (
            <OutputPre text={parsed.output} lang={langFromPath(p)} />
          ) : (
            <div className="step-box-note">
              {running ? 'Reading…' : 'The agent did not include the file content in its reply. Use Open to view it.'}
            </div>
          )}
        </StepBox>
      ))}
    </>
  );
}

/** One changed file of an edit step: its line diff, with `+added −removed` counted from the same hunk. */
function EditFileBox({ pair, kind, fallbackTitle }: { pair: DiffPair; kind: StepKind; fallbackTitle: string }) {
  const base = useContext(RefBaseContext);
  const { path, oldText, newText } = pair;
  const diff = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  return (
    <StepBox
      kind={kind}
      title={path ? fileNameOf(path) : fallbackTitle}
      sub={path ? shortDirOf(path, base) : undefined}
      meta={<DiffMeta added={diff.added} removed={diff.removed} />}
      filePath={path}
      copyText={newText || diff.text}
    >
      <DiffLines rows={diff.rows} oldText={oldText} newText={newText} lang={langFromPath(path)} />
    </StepBox>
  );
}

/** File edit / write / create: one box per changed file with its +/- diff. */
function EditBody({ item, parsed, kind, diffs, stepPaths }: StepBodyProps) {
  const openFile = useOpenFile();
  const pairs: DiffPair[] = diffs.length
    ? diffs.map((d) => ({ path: d.path ?? stepPaths[0], oldText: d.oldText ?? '', newText: d.newText ?? '' }))
    : diffsFromInput(parsed.input).map((d) => ({ ...d, path: stepPaths[0] }));
  const rich = stepPaths.filter(isRichPreviewPath);
  return (
    <>
      {pairs.length > 0 && rich.length > 0 && <InlineFilePreviews paths={rich} onOpen={openFile} />}
      {pairs.map((d, i) => (
        <EditFileBox key={`${d.path ?? ''}:${i}`} pair={d} kind={kind} fallbackTitle={parsed.headerTitle || 'File'} />
      ))}
      {pairs.length > 0 && parsed.output && (
        <StepBox kind={kind} title="Output" sub={parsed.toolLabel} copyText={parsed.output}>
          <OutputPre text={parsed.output} />
        </StepBox>
      )}
      {!pairs.length && (
        <GenericBody item={item} parsed={parsed} kind={kind} diffs={diffs} stepPaths={stepPaths} running={false} />
      )}
    </>
  );
}

/** Code search (grep / glob / find): the query, matched files as links, then the result lines. */
function SearchBody({ item, parsed }: StepBodyProps) {
  const { query, scope } = toolQueryOf(item);
  const title = query ? `"${query}"` : parsed.headerTitle || parsed.toolLabel;
  // ACP locations are per match (path + line) and arrive here as bare paths, so one file can repeat.
  const files = [...new Set(item.locations.map((p) => p.trim()).filter(Boolean))];
  const n = files.length;
  return (
    <StepBox
      kind="search"
      title={title}
      sub={scope ? `in ${compactPath(scope)}` : undefined}
      meta={n ? `${n} file${n === 1 ? '' : 's'}` : undefined}
      copyText={parsed.output || files.join('\n')}
    >
      {/* With lines, the step shows them as location chips (ToolRow) instead of bare file links. */}
      {n > 0 && !item.locationRefs?.length && <FileLinks paths={files} />}
      {parsed.output ? <OutputPre text={parsed.output} /> : n === 0 && <div className="step-box-note">No results returned yet.</div>}
    </StepBox>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return ''; // Not a URL (a search query): no host to show.
  }
}

/** Web fetch / web search: the URL or query, then the returned text. */
function WebBody({ item, parsed, running }: StepBodyProps) {
  const { query } = toolQueryOf(item);
  const subject = query || parsed.headerTitle || parsed.toolLabel;
  const host = /^https?:\/\//i.test(subject) ? hostOf(subject) : '';
  return (
    <StepBox kind="web" title={subject} sub={host || undefined} copyText={parsed.output} mono={false}>
      {parsed.output ? (
        <OutputPre text={parsed.output} prose />
      ) : (
        <div className="step-box-note">{running ? 'Waiting for the response…' : 'No text was returned.'}</div>
      )}
    </StepBox>
  );
}

/** Inputs that only carry the agent's own label (`{"toolSummary": "..."}`) are not worth a section. */
function meaningfulInput(input: string): boolean {
  if (!input.trim()) return false;
  if (!input.trim().startsWith('{')) return true;
  try {
    const obj = JSON.parse(input) as Record<string, unknown>;
    return Object.keys(obj).some((k) => !/^(toolsummary|waitmsbeforeasync)$/i.test(k));
  } catch {
    return true; // Truncated JSON is still worth showing as text.
  }
}

/** MCP / app tools / anything else: tool name, input JSON and output in one box. */
function GenericBody({ item, parsed, kind, stepPaths, running }: StepBodyProps) {
  const openFile = useOpenFile();
  const pathOnlyInput = stepPaths.length > 0 && /^\{\s*"path"\s*:\s*"[^"]+"\s*\}$/i.test(parsed.input);
  const showInput =
    Boolean(parsed.input) && !pathOnlyInput && (meaningfulInput(parsed.input) || (!parsed.output && !stepPaths.length));
  const sub = parsed.summary || parsed.headerTitle;
  const hasText = showInput || Boolean(parsed.output);
  return (
    <>
      {stepPaths.length > 0 && <InlineFilePreviews paths={stepPaths} onOpen={openFile} />}
      {(hasText || stepPaths.length > 0) && (
        <StepBox
          kind={kind}
          title={parsed.toolLabel || item.title}
          sub={sub && sub.toLowerCase() !== parsed.toolLabel.toLowerCase() && !stepPaths.includes(sub) ? sub : undefined}
          copyText={parsed.output || (showInput ? parsed.input : '')}
        >
          {stepPaths.length > 0 && (
            <StepBoxSection label="Files">
              <FileLinks paths={stepPaths} />
            </StepBoxSection>
          )}
          {showInput && (
            <StepBoxSection label="Input">
              <OutputPre text={parsed.input} lang={jsonLang(parsed.input)} />
            </StepBoxSection>
          )}
          {parsed.output && (
            <StepBoxSection label={running ? 'Live output' : 'Output'}>
              <OutputPre text={parsed.output} lang={running ? null : jsonLang(parsed.output)} />
            </StepBoxSection>
          )}
        </StepBox>
      )}
    </>
  );
}

/** Picks the content box layout for an expanded non-command step from its kind. */
export function StepBody(props: StepBodyProps) {
  switch (props.kind) {
    case 'read':
      return <ReadBody {...props} />;
    case 'edit':
    case 'create':
      return <EditBody {...props} />;
    case 'search':
      return <SearchBody {...props} />;
    case 'web':
      return <WebBody {...props} />;
    default:
      return <GenericBody {...props} />;
  }
}
