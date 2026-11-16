/**
 * ACP form elicitations (`elicitation/create`, mode "form"): the JSON-schema subset the spec allows, read into a
 * flat list of fields. Shared by the main process (it checks and cleans an answer before it goes to the agent)
 * and the renderer's question card (it draws the fields and checks them as the user types).
 *
 * Supported property types: string (free text with format / length / pattern, or a single choice through `enum`
 * or titled `oneOf`), number, integer, boolean, and array of string options (multi-select through `items.enum`
 * or titled `items.anyOf`). Anything else is "unsupported": the main process answers such a request with an
 * error, as the spec asks of a client that cannot render the form.
 */

export type ElicitValue = string | number | boolean | string[];
export type ElicitContent = Record<string, ElicitValue>;

/** The requested schema as the agent sent it (kept on the thread item, so the card can be drawn again later). */
export interface ElicitSchema {
  type?: string;
  title?: string | null;
  description?: string | null;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[] | null;
}

export interface ElicitOption {
  value: string;
  title: string;
  description?: string;
}

interface FieldBase {
  key: string;
  title?: string;
  description?: string;
  required: boolean;
}

export type ElicitField =
  | (FieldBase & { kind: 'text'; format?: string; minLength?: number; maxLength?: number; pattern?: string; default?: string })
  | (FieldBase & { kind: 'choice'; options: ElicitOption[]; default?: string })
  | (FieldBase & { kind: 'multi'; options: ElicitOption[]; minItems?: number; maxItems?: number; default?: string[] })
  | (FieldBase & { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; default?: number })
  | (FieldBase & { kind: 'boolean'; default?: boolean });

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function options(list: unknown, plain: unknown): ElicitOption[] | undefined {
  if (Array.isArray(list)) {
    const out = list
      .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object' && typeof (o as any).const === 'string')
      .map((o) => ({ value: o.const as string, title: str(o.title) ?? (o.const as string), description: str(o.description) }));
    if (out.length) return out;
  }
  if (Array.isArray(plain)) {
    const out = plain.filter((v): v is string => typeof v === 'string').map((v) => ({ value: v, title: v }));
    if (out.length) return out;
  }
  return undefined;
}

/** Reads a requested schema into fields, in the agent's order. `unsupported` lists the keys this client cannot draw. */
export function parseElicitSchema(schema: ElicitSchema | null | undefined): { fields: ElicitField[]; unsupported: string[] } {
  const fields: ElicitField[] = [];
  const unsupported: string[] = [];
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema!.required : []);
  for (const [key, raw] of Object.entries(props)) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
    const base: FieldBase = { key, title: str(p.title), description: str(p.description), required: required.has(key) };
    if (p.type === 'string') {
      const opts = options(p.oneOf, p.enum);
      if (opts) fields.push({ ...base, kind: 'choice', options: opts, default: opts.some((o) => o.value === p.default) ? p.default : undefined });
      else
        fields.push({
          ...base,
          kind: 'text',
          format: str(p.format),
          minLength: num(p.minLength),
          maxLength: num(p.maxLength),
          pattern: str(p.pattern),
          default: typeof p.default === 'string' ? p.default : undefined,
        });
    } else if (p.type === 'number' || p.type === 'integer') {
      fields.push({ ...base, kind: 'number', integer: p.type === 'integer', minimum: num(p.minimum), maximum: num(p.maximum), default: num(p.default) });
    } else if (p.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean', default: typeof p.default === 'boolean' ? p.default : undefined });
    } else if (p.type === 'array' && p.items && typeof p.items === 'object') {
      const opts = options(p.items.anyOf, p.items.enum);
      if (!opts) {
        unsupported.push(key);
        continue;
      }
      const values = new Set(opts.map((o) => o.value));
      const def = Array.isArray(p.default) ? p.default.filter((v: unknown): v is string => typeof v === 'string' && values.has(v)) : undefined;
      fields.push({ ...base, kind: 'multi', options: opts, minItems: num(p.minItems), maxItems: num(p.maxItems), default: def?.length ? def : undefined });
    } else unsupported.push(key);
  }
  return { fields, unsupported };
}

/**
 * Claude Code's AskUserQuestion arrives as fields `question_<n>` (a single or multi choice) each followed by an
 * optional free-text `question_<n>_custom` ("Other"). Returns the questions in order when the whole form has
 * that shape, so the card can show it as plain questions with option chips instead of a form.
 */
export function askQuestions(fields: ElicitField[]): { choice: Extract<ElicitField, { kind: 'choice' | 'multi' }>; other?: Extract<ElicitField, { kind: 'text' }> }[] | null {
  if (!fields.length) return null;
  const out: NonNullable<ReturnType<typeof askQuestions>> = [];
  for (const f of fields) {
    if (/^question_\d+$/.test(f.key) && (f.kind === 'choice' || f.kind === 'multi')) out.push({ choice: f });
    else if (/^question_\d+_custom$/.test(f.key) && f.kind === 'text') {
      const q = out.find((x) => `${x.choice.key}_custom` === f.key);
      if (!q) return null;
      q.other = f;
    } else return null;
  }
  return out.length ? out : null;
}

/** The value a field starts with in the card: its default, or empty. */
export function initialValue(f: ElicitField): ElicitValue | undefined {
  if (f.kind === 'multi') return f.default ?? [];
  if (f.kind === 'boolean') return f.default ?? false;
  return f.default;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Problems with one field's value, in words for the user; undefined when it is fine. */
export function fieldError(f: ElicitField, v: unknown): string | undefined {
  if (isEmpty(v)) return f.required && f.kind !== 'boolean' ? 'Required' : undefined;
  switch (f.kind) {
    case 'text': {
      if (typeof v !== 'string') return 'Enter text';
      if (f.minLength !== undefined && v.length < f.minLength) return `Use at least ${f.minLength} characters`;
      if (f.maxLength !== undefined && v.length > f.maxLength) return `Use at most ${f.maxLength} characters`;
      if (f.pattern) {
        try {
          if (!new RegExp(f.pattern, 'u').test(v)) return 'This does not match the expected format';
        } catch {
          /* a pattern this engine cannot read is not the user's problem */
        }
      }
      if (f.format === 'email' && !EMAIL.test(v)) return 'Enter an email address';
      if (f.format === 'uri') {
        try {
          new URL(v);
        } catch {
          return 'Enter a full link, like https://example.com';
        }
      }
      if (f.format === 'date' && (!DATE.test(v) || Number.isNaN(Date.parse(v)))) return 'Enter a date';
      if (f.format === 'date-time' && Number.isNaN(Date.parse(v))) return 'Enter a date and time';
      return undefined;
    }
    case 'choice':
      return typeof v === 'string' && f.options.some((o) => o.value === v) ? undefined : 'Pick one of the options';
    case 'multi': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !f.options.some((o) => o.value === x))) return 'Pick from the options';
      if (f.minItems !== undefined && v.length < f.minItems) return `Pick at least ${f.minItems}`;
      if (f.maxItems !== undefined && v.length > f.maxItems) return `Pick at most ${f.maxItems}`;
      return undefined;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return 'Enter a number';
      if (f.integer && !Number.isInteger(n)) return 'Enter a whole number';
      if (f.minimum !== undefined && n < f.minimum) return `Must be ${f.minimum} or more`;
      if (f.maximum !== undefined && n > f.maximum) return `Must be ${f.maximum} or less`;
      return undefined;
    }
    case 'boolean':
      return typeof v === 'boolean' ? undefined : 'Choose yes or no';
  }
}

/**
 * The answer to send: only the form's own fields, each with the right JSON type, empty optional fields left out.
 * Throws with a readable message when a field is not valid (the card shows it; nothing reaches the agent).
 */
export function cleanContent(schema: ElicitSchema | null | undefined, raw: Record<string, unknown> | null | undefined): ElicitContent {
  const { fields } = parseElicitSchema(schema);
  const out: ElicitContent = {};
  for (const f of fields) {
    let v: unknown = raw?.[f.key];
    if (typeof v === 'string' && f.kind !== 'text') v = v.trim();
    if (f.kind === 'number' && typeof v === 'string' && v !== '') v = Number(v);
    const err = fieldError(f, v);
    if (err) throw new Error(`${f.title ?? f.description ?? f.key}: ${err}`);
    if (isEmpty(v)) continue;
    if (f.kind === 'text' && typeof v === 'string' && f.format !== 'date-time') out[f.key] = v;
    else if (f.kind === 'text' && typeof v === 'string') out[f.key] = new Date(v).toISOString();
    else out[f.key] = v as ElicitValue;
  }
  return out;
}

/** A sent answer as label → shown value pairs (option titles instead of their wire values), for the answered card. */
export function describeAnswer(schema: ElicitSchema | null | undefined, content: ElicitContent | undefined, message?: string): { label: string; value: string }[] {
  if (!content) return [];
  const { fields } = parseElicitSchema(schema);
  const ask = askQuestions(fields);
  const titleOf = (f: ElicitField, v: string) => (f.kind === 'choice' || f.kind === 'multi' ? (f.options.find((o) => o.value === v)?.title ?? v) : v);
  if (ask) {
    return ask
      .map((q) => {
        const picked = content[q.choice.key];
        const picks = (Array.isArray(picked) ? picked : picked === undefined ? [] : [String(picked)]).map((v) => titleOf(q.choice, v));
        const other = q.other ? content[q.other.key] : undefined;
        if (typeof other === 'string' && other.trim()) picks.push(picks.length && q.choice.kind === 'choice' ? `(note: ${other.trim()})` : other.trim());
        // With several questions each field carries its question text; a single one is asked by the message.
        const label = q.choice.description ?? (ask.length === 1 ? message : undefined) ?? q.choice.title ?? 'Answer';
        return { label, value: picks.join(', ') };
      })
      .filter((x) => x.value);
  }
  return fields
    .filter((f) => content[f.key] !== undefined)
    .map((f) => {
      const v = content[f.key];
      const value = Array.isArray(v) ? v.map((x) => titleOf(f, x)).join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : titleOf(f, String(v));
      return { label: f.title ?? f.description ?? f.key, value };
    });
}
