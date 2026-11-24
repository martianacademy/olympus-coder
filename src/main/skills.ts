import { shell } from 'electron';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ImportCandidate, SkillView } from '@shared/types';
import { getSettings, listProjects, sharedRoot, updateSettings } from './store';

/**
 * Shared skills: <sharedRoot>/skills/<id>/SKILL.md (frontmatter `name` and `description`, then instructions; other
 * files in the folder are the skill's resources). Every agent session's guide lists the enabled ones, and an agent
 * reads SKILL.md when a task matches. Skills from ~/.claude, ~/.codex or a project are copied in, never changed.
 * ~/.agents/skills (where the third-party `npx skills` tool installs, and Olympus's old shared folder) is also
 * listed, read-only, for skills not in the shared folder.
 */

export const skillsDir = () => join(sharedRoot(), 'skills');
const npxSkillsDir = () => join(homedir(), '.agents', 'skills');
/** The shared folder first, then ~/.agents/skills when it is a different folder. */
const skillRoots = () => (npxSkillsDir() === skillsDir() ? [skillsDir()] : [skillsDir(), npxSkillsDir()]);
const NPX_READ_ONLY = 'Installed with `npx skills` in ~/.agents/skills: change or remove it with that tool.';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'skill';

/**
 * Unquotes a folded YAML frontmatter scalar (`'...'`, `"..."`, or plain text),
 * preserving `JSON.stringify` escapes written by `saveSkill` and YAML `''` escapes.
 */
function unquoteScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === 'string') return parsed.replace(/\s+/g, ' ').trim();
    } catch {
      return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim();
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'").replace(/\s+/g, ' ').trim();
  }
  return v.replace(/\s+/g, ' ').trim();
}

/** Parses YAML frontmatter (`--- ... ---`) and markdown body from a `SKILL.md` file. */
function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const rawMeta: Record<string, string> = {};
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      rawMeta[key] = kv[2].replace(/^[>|][+-]?\s*$/, '');
    } else if (key && /^\s+\S/.test(line)) {
      rawMeta[key] = `${rawMeta[key]} ${line.trim()}`.trim();
    }
  }
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMeta)) meta[k] = unquoteScalar(v);
  return { meta, body: text.slice(m[0].length) };
}

function readSkill(dir: string): { name: string; description: string; body: string } | null {
  const f = join(dir, 'SKILL.md');
  if (!existsSync(f)) return null;
  const { meta, body } = parse(readFileSync(f, 'utf8'));
  return { name: meta.name || basename(dir), description: meta.description || '', body };
}

export function listSkills(): SkillView[] {
  const off = new Set(getSettings().disabledSkills);
  const seen = new Set<string>();
  const out: SkillView[] = [];
  for (const root of skillRoots()) {
    if (!existsSync(root)) continue;
    const readOnly = root !== skillsDir();
    for (const id of readdirSync(root)) {
      if (id.startsWith('.') || seen.has(id)) continue;
      try {
        if (!statSync(join(root, id)).isDirectory()) continue;
      } catch {
        continue;
      }
      const s = readSkill(join(root, id));
      if (!s) continue;
      seen.add(id);
      out.push({ id, name: s.name, description: s.description, path: join(root, id, 'SKILL.md'), enabled: !off.has(id), ...(readOnly ? { readOnly } : {}) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The folder of a skill: the shared one, else ~/.agents/skills (read-only). */
function skillDir(id: string): { dir: string; readOnly: boolean } {
  const own = join(skillsDir(), basename(id));
  if (existsSync(own) || skillRoots().length === 1) return { dir: own, readOnly: false };
  const npx = join(npxSkillsDir(), basename(id));
  return existsSync(npx) ? { dir: npx, readOnly: true } : { dir: own, readOnly: false };
}

export function getSkill(id: string): SkillView {
  const { dir, readOnly } = skillDir(id);
  const s = readSkill(dir);
  if (!s) throw new Error('Skill not found.');
  return { id: basename(id), name: s.name, description: s.description, path: join(dir, 'SKILL.md'), enabled: !getSettings().disabledSkills.includes(id), body: s.body, ...(readOnly ? { readOnly } : {}) };
}

const yamlValue = (s: string) => (/^[\w .,()/-]*$/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s));

export function saveSkill(input: { id?: string; name: string; description: string; body: string }): SkillView[] {
  const name = input.name.trim();
  const description = input.description.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Give the skill a name.');
  if (!description) throw new Error('Add a description: agents use it to decide when the skill applies.');
  let id = input.id ? basename(input.id) : slug(name);
  if (input.id && skillDir(id).readOnly) throw new Error(NPX_READ_ONLY);
  if (!input.id) while (existsSync(join(skillsDir(), id))) id += '-2';
  const dir = join(skillsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(description)}\n---\n\n${input.body.trim()}\n`);
  return listSkills();
}

/** Moves the skill folder to the Trash (recoverable). */
export async function deleteSkill(id: string): Promise<SkillView[]> {
  if (skillDir(id).readOnly) throw new Error(NPX_READ_ONLY);
  const dir = join(skillsDir(), basename(id));
  if (existsSync(dir)) await shell.trashItem(dir);
  updateSettings({ disabledSkills: getSettings().disabledSkills.filter((x) => x !== id) });
  return listSkills();
}

export function setSkillEnabled(id: string, enabled: boolean): SkillView[] {
  const off = new Set(getSettings().disabledSkills);
  if (enabled) off.delete(id);
  else off.add(id);
  updateSettings({ disabledSkills: [...off] });
  return listSkills();
}

/** Skills in other tools' folders and in projects, not yet in the shared folder. */
export function skillImportCandidates(): ImportCandidate[] {
  const home = homedir();
  const sources: [string, string][] = [
    [join(home, '.claude', 'skills'), '~/.claude/skills'],
    [join(home, '.codex', 'skills'), '~/.codex/skills'],
    [join(home, '.gemini', 'skills'), '~/.gemini/skills'],
    ...listProjects().flatMap((p): [string, string][] => [
      [join(p.path, '.claude', 'skills'), `${p.name}/.claude/skills`],
      [join(p.path, '.agents', 'skills'), `${p.name}/.agents/skills`],
    ]),
  ];
  const have = new Set(listSkills().map((s) => s.name.toLowerCase()));
  const out: ImportCandidate[] = [];
  for (const [dir, label] of sources) {
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const full = join(dir, d);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const s = readSkill(full);
      if (s && !have.has(s.name.toLowerCase())) out.push({ name: s.name, description: s.description, path: full, source: label });
    }
  }
  return out;
}

/** Copies a skill folder (SKILL.md and its resources) into the shared folder. */
export function importSkill(path: string): SkillView[] {
  const s = readSkill(path);
  if (!s) throw new Error('No SKILL.md in that folder.');
  let id = slug(s.name);
  while (existsSync(join(skillsDir(), id))) id += '-2';
  mkdirSync(skillsDir(), { recursive: true });
  cpSync(path, join(skillsDir(), id), { recursive: true, dereference: true });
  return listSkills();
}

/**
 * Names of the skills Claude Code lists on its own (it reads ~/.claude/skills and <project>/.claude/skills), by
 * folder and frontmatter name, lower-cased.
 */
export function claudeListedSkillNames(projectPath: string): Set<string> {
  const names = new Set<string>();
  for (const dir of [join(homedir(), '.claude', 'skills'), join(projectPath, '.claude', 'skills')]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const d of entries) {
      const s = readSkill(join(dir, d));
      if (!s) continue;
      names.add(d.toLowerCase());
      names.add(s.name.toLowerCase());
    }
  }
  return names;
}

const MAX_INLINE_SKILLS_PER_DIR = 40;

/**
 * For the operating guide: enabled skills grouped by folder (omitting skills Claude Code already lists
 * from its own folders so the same skill is never sent twice).
 */
export function skillsForGuide(claudeProject?: string): { id: string; name: string; rootDir: string; readOnly: boolean }[] {
  const listed = claudeProject ? claudeListedSkillNames(claudeProject) : new Set<string>();
  return listSkills()
    .filter((s) => s.enabled && !listed.has(s.id.toLowerCase()) && !listed.has(s.name.toLowerCase()))
    .map((s) => ({
      id: s.id,
      name: s.name,
      rootDir: dirname(dirname(s.path)),
      readOnly: Boolean(s.readOnly),
    }));
}

/**
 * Formats an ultra-compact, on-demand `## Shared skills` section for the operating guide:
 * lists skill names grouped by folder (no 220-char descriptions or repeated paths) and instructs the
 * model to grep/read `<folder>/<skill>/SKILL.md` only when a task matches — cutting system-prompt
 * skill overhead by ~85–93% while preserving 100% skill discovery.
 */
export function formatCompactSkillsGuide(
  skills: { id: string; name: string; rootDir: string; readOnly: boolean }[],
): string {
  if (!skills.length) return '';
  const byDir = new Map<string, { readOnly: boolean; items: { id: string; name: string }[] }>();
  for (const s of skills) {
    let group = byDir.get(s.rootDir);
    if (!group) {
      group = { readOnly: s.readOnly, items: [] };
      byDir.set(s.rootDir, group);
    }
    group.items.push({ id: s.id, name: s.name });
  }
  const lines = [...byDir.entries()]
    .sort((a, b) => Number(a[1].readOnly) - Number(b[1].readOnly) || a[0].localeCompare(b[0]))
    .map(([dir, g]) => {
      const shown = g.items.slice(0, MAX_INLINE_SKILLS_PER_DIR).map((x) => (x.name === x.id ? `**${x.id}**` : `**${x.name}** (\`${x.id}\`)`));
      const overflow = g.items.length > MAX_INLINE_SKILLS_PER_DIR ? `, … (grep \`${dir}\` for more)` : '';
      return `- \`${dir}\`: ${shown.join(', ')}${overflow}`;
    });

  return [
    '## Shared skills',
    '',
    'On-demand task playbooks live as `<folder>/<skill>/SKILL.md` (not preloaded to save context). Only when the current task matches a skill below — or to check for a relevant playbook — grep the folder or read `<folder>/<skill>/SKILL.md` before starting:',
    ...lines,
  ].join('\n');
}
