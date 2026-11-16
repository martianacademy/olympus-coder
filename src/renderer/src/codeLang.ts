/**
 * Language detection for read-only code shown in chat (no imports, so node unit tests can load it directly):
 * - `langFromPath()` / `langFromFence()` map a file name or a Markdown fence tag to a `@codemirror/language-data`
 *   name or alias.
 * - `detectResultLang()` decides whether a command's RESULT is source code: from the command when it only prints
 *   one kind of file (`sed -n`, `cat`, `head`, `tail`, `bat`, `nl`, `cat -n`, `git show REV:file`, `grep` on a single
 *   file, …), or from the content (JSON / JSONL, unified diff). Anything unsure returns null so logs and test
 *   output stay plain text.
 * - `splitGutters()` separates the leading line numbers that `grep -n`, `cat -n`, `nl` and file reads add.
 */

/** Extension (lower case) → language-data name/alias. Only real source formats; logs, `.txt`, `.csv` stay plain. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'json', json5: 'json', map: 'json', jsonl: 'json', ndjson: 'json', webmanifest: 'json',
  py: 'python', pyi: 'python', pyw: 'python',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift', dart: 'dart',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', m: 'objective-c', mm: 'objective-c++',
  cs: 'csharp', rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', jl: 'julia',
  hs: 'haskell', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', cljs: 'clojurescript', ml: 'ocaml', fs: 'fsharp',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell', ps1: 'powershell',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  html: 'html', htm: 'html', svelte: 'html', vue: 'vue', xml: 'xml', svg: 'xml', plist: 'xml', xsd: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', properties: 'properties',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', diff: 'diff', patch: 'diff',
  groovy: 'groovy', gradle: 'groovy', cmake: 'cmake', tf: 'ruby',
};

/** Whole file names that carry a language without an extension. */
const NAME_LANG: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'shell', gemfile: 'ruby', rakefile: 'ruby',
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell', '.zprofile': 'shell',
  '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini',
};

/** Language-data name for a file path, or null for unknown / plain-text files. */
export function langFromPath(path: string | undefined | null): string | null {
  if (!path) return null;
  const clean = path.trim().replace(/^file:\/\//i, '').replace(/(?::\d+(?::\d+)?|#L?\d+(?:-L?\d+)?)$/i, '');
  const name = (clean.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (!name) return null;
  if (NAME_LANG[name]) return NAME_LANG[name];
  if (/^dockerfile\./.test(name)) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 && !name.startsWith('.')) return null;
  const ext = name.slice(dot + 1);
  return EXT_LANG[ext] ?? null;
}

/** Fence tags that mean "plain text": logs, program output, stack traces. */
const PLAIN_FENCES = new Set([
  '', 'text', 'txt', 'plain', 'plaintext', 'log', 'logs', 'output', 'out', 'stdout', 'stderr', 'console', 'terminal',
  'stacktrace', 'traceback', 'error', 'errors', 'none', 'ansi',
]);

/** Fence aliases that language-data does not know by these names. */
const FENCE_ALIAS: Record<string, string> = {
  bash: 'shell', sh: 'shell', zsh: 'shell', shell: 'shell', shellscript: 'shell', fish: 'shell',
  ps: 'powershell', pwsh: 'powershell', ps1: 'powershell',
  js: 'javascript', javascript: 'javascript', node: 'javascript', ts: 'typescript', typescript: 'typescript',
  py: 'python', python3: 'python', rs: 'rust', golang: 'go', yml: 'yaml', md: 'markdown', jsonc: 'json', jsonl: 'json',
  ndjson: 'json', json5: 'json', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', kt: 'kotlin', rb: 'ruby', patch: 'diff',
  udiff: 'diff', dockerfile: 'dockerfile', docker: 'dockerfile', svelte: 'html', svg: 'xml', objc: 'objective-c', tf: 'ruby',
  hcl: 'ruby', make: 'shell', makefile: 'shell', env: 'shell', dotenv: 'shell', gql: 'graphql',
};

/** Language-data name for a Markdown fence tag (`ts`, `python`, `bash`), or null for plain text. */
export function langFromFence(tag: string | undefined | null): string | null {
  const t = (tag ?? '').trim().toLowerCase();
  if (PLAIN_FENCES.has(t)) return null;
  if (FENCE_ALIAS[t]) return FENCE_ALIAS[t];
  if (EXT_LANG[t]) return EXT_LANG[t];
  return /^[a-z][\w+#.-]*$/.test(t) ? t : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Line-number gutters

/** `grep -n` / `rg -n` (`380:` match, `381-` context line). */
const GREP_GUTTER = /^(\d+)([:-])/;
/** `cat -n` / `nl` / file reads (`   380\t`, `   380→`). */
const NUM_GUTTER = /^([ \t]*\d+)(\t|→)/;
/** A numbered empty line whose trailing tab was trimmed by the RESULT formatter (`     2`). */
const NUM_ONLY = /^[ \t]+\d+$/;

export type GutterStyle = 'grep' | 'num';

export interface GutterLine {
  /** Leading line number as shown (trimmed), or '' when the line has none. */
  gutter: string;
  /** The rest of the line, without the number and its separator. */
  code: string;
  /** True for lines from `grep -n` (independent matches, highlighted one by one). */
  match: boolean;
}

/** Splits leading line numbers off each line for the given gutter styles. */
export function splitGutters(text: string, styles: readonly GutterStyle[]): GutterLine[] {
  const grep = styles.includes('grep');
  const num = styles.includes('num');
  return text.split('\n').map((line): GutterLine => {
    if (num) {
      const m = NUM_GUTTER.exec(line);
      if (m) return { gutter: m[1].trim(), code: line.slice(m[0].length), match: false };
      if (NUM_ONLY.test(line)) return { gutter: line.trim(), code: '', match: false };
    }
    if (grep) {
      const m = GREP_GUTTER.exec(line);
      if (m) return { gutter: m[1], code: line.slice(m[0].length), match: true };
      if (line === '--') return { gutter: '', code: line, match: true };
    }
    return { gutter: '', code: line, match: false };
  });
}

/** True when most non-empty lines carry a `cat -n` / read-tool style number (Claude's Read output). */
export function hasNumGutter(text: string): boolean {
  const lines = text.split('\n', 400).filter((l) => l.trim());
  if (lines.length < 1) return false;
  const hits = lines.filter((l) => NUM_GUTTER.test(l) || NUM_ONLY.test(l)).length;
  return hits / lines.length >= 0.9;
}

// ---------------------------------------------------------------------------------------------------------------
// Shell command analysis

/** Splits a command into top-level statements, each a list of pipeline stages, each a list of unquoted words. */
function parseCommand(src: string): string[][][] | null {
  const statements: string[][][] = [];
  let stages: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let i = 0;
  const pushWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const pushStage = () => {
    pushWord();
    if (words.length) stages.push(words);
    words = [];
  };
  const pushStatement = () => {
    pushStage();
    if (stages.length) statements.push(stages);
    stages = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < src.length) word += src[++i];
      else word += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      i++;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word += src[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    // Subshells, command substitution, backticks, heredocs and process substitution: too dynamic to judge.
    if (c === '`' || c === '(' || c === ')' || (c === '$' && src[i + 1] === '(') || src.startsWith('<<', i) || src.startsWith('<(', i)) {
      return null;
    }
    if (c === ';' || c === '\n') {
      pushStatement();
      i++;
      continue;
    }
    if (c === '&' && src[i + 1] === '&') {
      pushStatement();
      i += 2;
      continue;
    }
    if (c === '|' && src[i + 1] === '|') {
      pushStatement();
      i += 2;
      continue;
    }
    if (c === '|') {
      pushStage();
      i++;
      continue;
    }
    if (c === '&' && !/[<>]/.test(src[i - 1] ?? '')) {
      pushStatement(); // Background job.
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++; // Comment to end of line.
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  if (quote) return null;
  pushStatement();
  return statements;
}

interface StageInfo {
  /** Words of the stage with env assignments and stderr redirections removed. */
  words: string[];
  /** stdout goes to a file: the stage prints nothing. */
  redirected: boolean;
}

function cleanStage(raw: string[]): StageInfo | null {
  const words: string[] = [];
  let redirected = false;
  let k = 0;
  while (k < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[k])) k++; // FOO=bar cmd
  for (; k < raw.length; k++) {
    const w = raw[k];
    if (/^\d?>&\d$/.test(w) || /^2>>?\S+$/.test(w) || w === '2>/dev/null') continue;
    if (w === '2>' || w === '2>>') {
      k++;
      continue;
    }
    if (/^(?:1|&)?>>?$/.test(w)) {
      redirected = true;
      k++;
      continue;
    }
    if (/^(?:1|&)?>>?\S/.test(w)) {
      redirected = true;
      continue;
    }
    if (w === '<') {
      // `cmd < file` reads the file like an argument.
      if (raw[k + 1]) words.push(raw[++k]);
      continue;
    }
    if (/^<\S/.test(w)) {
      words.push(w.slice(1));
      continue;
    }
    words.push(w);
  }
  return words.length ? { words, redirected } : null;
}

interface FilePrint {
  lang: string;
  gutter?: GutterStyle;
  /** Output lines are unrelated matches (grep): highlight each line on its own. */
  perLine?: boolean;
}

type StageVerdict = FilePrint | 'neutral' | 'diff' | 'content' | null;

const NEUTRAL_CMDS = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'true', ':', 'source', '.', 'shopt', 'clear']);

/** Exactly one file argument that maps to a language. */
function oneFile(args: string[]): string | null {
  const files = args.filter((a) => a !== '-' && a !== '--');
  if (files.length !== 1) return null;
  if (/[*?[\]{}]/.test(files[0])) return null; // A glob can expand to several files.
  return langFromPath(files[0]);
}

function catLike(args: string[], numFlags: RegExp, okFlags: RegExp): FilePrint | null {
  let gutter: GutterStyle | undefined;
  const files: string[] = [];
  for (const a of args) {
    if (a.startsWith('-') && a.length > 1) {
      if (numFlags.test(a)) gutter = 'num';
      else if (!okFlags.test(a)) return null;
    } else files.push(a);
  }
  const lang = oneFile(files);
  return lang ? { lang, gutter } : null;
}

function headTail(args: string[], cmd: string): FilePrint | null {
  const files: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-n') {
      k++;
      continue;
    }
    if (/^-n[+-]?\d+$/.test(a) || /^-\d+$/.test(a) || /^--lines=[+-]?\d+$/.test(a) || a === '-q') continue;
    if (cmd === 'tail' && /^-[fF]/.test(a)) return null;
    if (a.startsWith('-') && a.length > 1) return null;
    files.push(a);
  }
  const lang = oneFile(files);
  return lang ? { lang } : null;
}

/** `sed -n 'A,Bp' file` (print a range), never `-i` or substitutions. */
function sedPrint(args: string[]): FilePrint | null {
  let quiet = false;
  let script: string | null = null;
  const files: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-n' || a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '-e') script = args[++k] ?? null;
    else if (a === '-E' || a === '-r') continue;
    else if (a.startsWith('-')) return null;
    else if (script === null) script = a;
    else files.push(a);
  }
  if (!quiet || !script || !/^[\d\s,$;p{}]+$/.test(script) || !script.includes('p')) return null;
  const lang = oneFile(files);
  return lang ? { lang } : null;
}

const GREP_LONG_OK = /^--(?:color|colour|line-number|ignore-case|fixed-strings|extended-regexp|perl-regexp|basic-regexp|no-filename|text|max-count|context|after-context|before-context|word-regexp|invert-match|no-heading|smart-case|case-sensitive)(?:=.*)?$/;

/** `grep` / `rg` / `ag` on exactly one source file, no recursion, file lists or counts. */
function grepOne(args: string[], cmd: string): FilePrint | null {
  let numbered = false;
  let pattern: string | null = null;
  const files: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      if (a === '--regexp' || a === '-e') {
        pattern = args[++k] ?? '';
        continue;
      }
      if (a.startsWith('--regexp=')) {
        pattern = a.slice(9);
        continue;
      }
      if (!GREP_LONG_OK.test(a)) return null;
      if (a === '--line-number') numbered = true;
      if (/^--(?:max-count|context|after-context|before-context)$/.test(a)) k++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const flags = a.slice(1);
      // r/R recurse, l/L/c/o/q/H change the output shape, f reads patterns from a file.
      if (/[rRlLcoqHfZ]/.test(flags.replace(/\d+$/, ''))) return null;
      if (cmd !== 'grep' && /[uS]/.test(flags)) continue;
      if (flags.includes('n')) numbered = true;
      const last = flags.replace(/\d+$/, '').slice(-1);
      if (/[ABCme]/.test(last) && !/\d$/.test(flags)) {
        const v = args[++k];
        if (last === 'e') pattern = v ?? '';
      }
      continue;
    }
    if (pattern === null) pattern = a;
    else files.push(a);
  }
  if (pattern === null) return null;
  const lang = oneFile(files);
  return lang ? { lang, gutter: numbered ? 'grep' : undefined, perLine: true } : null;
}

function gitStage(args: string[]): StageVerdict {
  const rest = args.filter((a) => !/^(?:--no-pager|-P|--paginate)$/.test(a));
  const sub = rest[0];
  if (sub === 'show' || sub === 'cat-file') {
    const specs = rest.slice(1).filter((a) => !a.startsWith('-'));
    if (specs.length === 1 && specs[0].includes(':')) {
      const lang = langFromPath(specs[0].slice(specs[0].indexOf(':') + 1));
      return lang ? { lang } : null;
    }
    return sub === 'show' ? 'diff' : null;
  }
  if (sub === 'diff' || sub === 'log' || sub === 'stash') return 'diff';
  return null;
}

/** What the first stage of a pipeline prints. */
function firstStage(words: string[]): StageVerdict {
  const [cmd0, ...args] = words;
  const cmd = cmd0.replace(/^.*\//, '');
  if (NEUTRAL_CMDS.has(cmd)) return 'neutral';
  switch (cmd) {
    case 'cat':
    case 'less':
    case 'more':
      return catLike(args, /^-[nb]+$/, /^-[su]+$/);
    case 'bat':
    case 'batcat':
      return catLike(args, /^$/, /^(?:-[pP]+|--plain|--paging=\w+|--color=\w+|--style=plain|--decorations=\w+|-l\w*|--language=\w+)$/);
    case 'nl':
      return catLike(['-n', ...args], /^-n$/, /^-(?:b[atn]|ba)$/);
    case 'head':
    case 'tail':
      return headTail(args, cmd);
    case 'sed':
      return sedPrint(args);
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
    case 'ag':
      return grepOne(args, cmd);
    case 'git':
      return gitStage(args);
    case 'jq':
    case 'curl':
    case 'http':
    case 'gh':
      return 'content';
    case 'diff':
      return args.some((a) => /^-[a-zA-Z]*u/.test(a) || a === '--unified') ? 'diff' : null;
    default:
      return null;
  }
}

/** A later pipeline stage that only keeps some lines (`| head -40`) or numbers them (`| nl`, `| cat -n`). */
function filterStage(words: string[]): { gutter?: GutterStyle; perLine?: boolean } | null {
  const [cmd0, ...args] = words;
  const cmd = cmd0.replace(/^.*\//, '');
  const flagsOnly = args.every((a) => a.startsWith('-') || /^\d+$/.test(a));
  switch (cmd) {
    case 'head':
    case 'tail':
      return headTail([...args, 'x.ts'], cmd) ? {} : null;
    case 'cat':
    case 'less':
    case 'more':
      if (!flagsOnly) return null;
      return args.some((a) => /^-[nb]+$/.test(a)) ? { gutter: 'num' } : {};
    case 'nl':
      return flagsOnly ? { gutter: 'num' } : null;
    case 'sed':
      return sedPrint([...args, 'x.ts']) ? {} : null;
    default:
      return null;
  }
}

/** Highlighting plan for a RESULT box. */
export interface ResultLang {
  /** language-data name (`typescript`, `json`, `diff`, …). */
  lang: string;
  /** Gutter styles to split off before highlighting. */
  gutters: GutterStyle[];
  /** Highlight each line on its own (grep matches are not contiguous code). */
  perLine: boolean;
}

/** Hard cap: beyond this the RESULT stays plain text. */
export const MAX_HIGHLIGHT_CHARS = 150_000;

/** First line of a diff: `diff --git`, `diff -u`, `--- a/x` + `+++ b/x`, `Index:`, or a `git log -p` / `git show` commit. */
const DIFF_START_RE = /^(?:diff --git |diff -[a-zA-Z]*u|--- \S[^\n]*\n\+\+\+ \S|Index: \S|commit [0-9a-f]{7,40}\b)/;

/** True for unified diff text that starts like a diff and has at least one hunk header. */
export function looksLikeDiff(text: string): boolean {
  const t = text.replace(/^\s*\n/, '');
  if (!DIFF_START_RE.test(t.slice(0, 400))) return false;
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(t.slice(0, 200_000));
}

/** Splits text into top-level JSON values separated by whitespace; null when any part is not JSON. */
function jsonValues(text: string): number | null {
  let count = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const open = text[i];
    if (open !== '{' && open !== '[') return null;
    let depth = 0;
    let inStr = false;
    const start = i;
    for (; i < n; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    if (depth !== 0) return null;
    try {
      JSON.parse(text.slice(start, i));
    } catch {
      return null; // Not JSON after all (a bracketed log line, a shell array…).
    }
    count++;
  }
  return count || null;
}

/** True when the whole text is one or more JSON objects/arrays (pretty JSON, JSONL). */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || (t[0] !== '{' && t[0] !== '[')) return false;
  return jsonValues(t) !== null;
}

/**
 * Decides how to highlight a RESULT box from the raw command and its (already formatted) output.
 * Returns null — plain text — unless every printing statement agrees on one language, or the content is
 * unmistakably JSON or a unified diff.
 */
export function detectResultLang(command: string, output: string): ResultLang | null {
  if (!output.trim() || output.length > MAX_HIGHLIGHT_CHARS) return null;
  const statements = parseCommand(command.replace(/\r\n/g, '\n').trim());
  let fromCommand: ResultLang | null = null;
  let unsure = statements === null;
  let wantsContent = false;
  let printing = 0;
  for (const stages of statements ?? []) {
    const cleaned = stages.map(cleanStage);
    if (cleaned.some((s) => s === null)) {
      unsure = true;
      break;
    }
    const st = cleaned as StageInfo[];
    if (st[st.length - 1].redirected) continue; // `cat a.ts > b.ts` prints nothing.
    const head = st[0].words;
    const cmd = head[0].replace(/^.*\//, '');
    if ((cmd === 'echo' || cmd === 'printf') && st.length === 1) {
      // Separators like `echo ---` between file dumps: tolerated, but only when short.
      if (head.join(' ').length > 80) unsure = true;
      continue;
    }
    const v = firstStage(head);
    if (v === 'neutral') continue;
    if (v === null) {
      unsure = true;
      break;
    }
    printing++;
    if (v === 'content' || v === 'diff') {
      wantsContent = true;
      if (st.length > 1 && v === 'diff') unsure = true;
      continue;
    }
    let gutter = v.gutter;
    let perLine = Boolean(v.perLine);
    for (const later of st.slice(1)) {
      const f = filterStage(later.words);
      if (!f) {
        unsure = true;
        break;
      }
      if (f.gutter) {
        if (gutter) unsure = true;
        gutter = f.gutter;
      }
      perLine = perLine || Boolean(f.perLine);
    }
    if (unsure) break;
    if (!fromCommand) fromCommand = { lang: v.lang, gutters: [], perLine: false };
    else if (fromCommand.lang !== v.lang) {
      unsure = true;
      break;
    }
    if (gutter && !fromCommand.gutters.includes(gutter)) fromCommand.gutters.push(gutter);
    // grep lines without numbers cannot be told apart from other statements' lines: per-line everything.
    if (perLine && !gutter) fromCommand.perLine = true;
  }

  if (!unsure && fromCommand && !wantsContent) return fromCommand;
  if (!unsure && fromCommand && wantsContent) return null; // A file dump mixed with API / diff output.
  // Otherwise trust only unmistakable content: a unified diff from its first line, or pure JSON / JSONL.
  if (looksLikeDiff(output)) return { lang: 'diff', gutters: [], perLine: false };
  if (looksLikeJson(output)) return { lang: 'json', gutters: [], perLine: false };
  return null;
}
