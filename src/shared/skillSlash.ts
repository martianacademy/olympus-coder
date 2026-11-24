/**
 * Pure composer `/skill <instructions>` parser and `<active_skill>` block resolver shared by
 * main-process prompt dispatch (`src/main/agents.ts`) and unit tests (zero Electron/Node imports).
 *
 * When matched against an enabled Olympus skill, the full `SKILL.md` playbook is injected into the
 * current turn without mutating earlier turns (preserving KV prompt cache across every ACP agent)
 * while never shadowing native agent ACP slash commands (e.g. `/compact`, `/cost`, `/model`).
 */
import type { SkillView } from './types';

const SLASH_PREFIX = /^\s*\/([a-zA-Z0-9._-]+)(?:[\t ]+([\s\S]*)|(?:\r?\n([\s\S]*))|)$/;
const MAX_SKILL_BODY_CHARS = 16_000;

export interface ParsedSlashPrompt {
  token: string;
  rest: string;
}

export interface ResolvedSkillSlash {
  skillId: string;
  skillName: string;
  skillPath: string;
  skillBlock: string;
  userText: string;
}

const bare = (name: string) => name.replace(/^\//, '').trim().toLowerCase();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Extracts a leading `/token` and trailing instructions from a user message, or null if not a slash message. */
export function parseSlashToken(text: string): ParsedSlashPrompt | null {
  const m = SLASH_PREFIX.exec(text);
  if (!m) return null;
  const rest = (m[2] ?? m[3] ?? '').trim();
  return { token: m[1].toLowerCase(), rest };
}

/**
 * Matches a leading `/<skill>` against enabled Olympus skills, yielding null whenever the token belongs
 * to one of the active agent's native ACP slash commands.
 */
export function resolveSkillSlash(
  text: string,
  agentCommands: readonly { name: string }[],
  deps: { listSkills: () => SkillView[]; getSkill: (id: string) => SkillView },
): ResolvedSkillSlash | null {
  const parsed = parseSlashToken(text);
  if (!parsed) return null;

  // Never hijack a native ACP slash command advertised by the current agent.
  if (agentCommands.some((c) => bare(c.name) === parsed.token)) return null;

  const hit = deps
    .listSkills()
    .find(
      (s) => s.enabled && (s.id.toLowerCase() === parsed.token || s.name.toLowerCase() === parsed.token || slug(s.name) === parsed.token),
    );
  if (!hit) return null;

  let full: SkillView;
  try {
    full = deps.getSkill(hit.id);
  } catch {
    return null;
  }

  const rawBody = (full.body ?? '').trim();
  if (!rawBody) return null;
  const body =
    rawBody.length > MAX_SKILL_BODY_CHARS
      ? `${rawBody.slice(0, MAX_SKILL_BODY_CHARS).trimEnd()}\n\n… [skill body truncated; read ${full.path} if more detail is needed]`
      : rawBody;

  const skillBlock = [
    `<active_skill name="${full.name}" id="${full.id}" path="${full.path}">`,
    `The user explicitly activated the \`/${full.id}\` skill for this turn. Strictly follow the methodology, invariants, and verification checks below while answering the user's request.`,
    '',
    body,
    '</active_skill>',
  ].join('\n');

  return {
    skillId: full.id,
    skillName: full.name,
    skillPath: full.path,
    skillBlock,
    userText: parsed.rest,
  };
}
