/**
 * Cached React hook exposing enabled Olympus shared skills (`~/.olympus/skills/` + `~/.agents/skills/`)
 * as composer `/` slash items, kept live via the main process's `skills:changed` event.
 *
 * User-owned shared skills (`!readOnly`, e.g. `/math`, `/quantum`, `/physics`, `/security`, `/research`, `/coder`)
 * sort ahead of read-only third-party `~/.agents/skills/` entries when typing bare `/`, while exact/prefix
 * typing always ranks the matching skill straight to the top.
 */
import { useEffect, useMemo, useState } from 'react';
import type { SkillView } from '@shared/types';
import { api, onEvent } from './api';
import type { SlashCommand } from './components/SlashMenu';

let cached: SkillView[] | null = null;
let inflight: Promise<SkillView[]> | null = null;
const listeners = new Set<(list: SkillView[]) => void>();
let subscribed = false;

function broadcast(list: SkillView[]) {
  cached = list;
  for (const fn of listeners) fn(list);
}

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  onEvent((ch, payload) => {
    if (ch === 'skills:changed' && Array.isArray(payload)) {
      broadcast(payload as SkillView[]);
    }
  });
}

function loadSkills(): Promise<SkillView[]> {
  if (inflight) return inflight;
  inflight = api
    .skills()
    .then((list) => {
      broadcast(list);
      return list;
    })
    .catch(() => cached ?? [])
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Converts enabled Olympus skills into composer `/` entries, prioritizing user shared skills first. */
export function toSkillSlashCommands(skills: SkillView[]): SlashCommand[] {
  return skills
    .filter((s) => s.enabled)
    .slice()
    .sort((a, b) => Number(Boolean(a.readOnly)) - Number(Boolean(b.readOnly)) || a.id.localeCompare(b.id))
    .map((s) => ({
      name: s.id,
      description: s.description,
      inputHint: '<instructions>',
      kind: 'skill',
    }));
}

/** Merges native agent ACP commands with Olympus skill slash entries (native commands keep precedence on collision). */
export function mergeSlashCommands(agentCommands: SlashCommand[], skillCommands: SlashCommand[]): SlashCommand[] {
  if (!skillCommands.length) return agentCommands;
  if (!agentCommands.length) return skillCommands;
  const native = new Set(agentCommands.map((c) => c.name.replace(/^\//, '').toLowerCase()));
  const filteredSkills = skillCommands.filter((s) => !native.has(s.name.replace(/^\//, '').toLowerCase()));
  // Show user skills right alongside native commands (user skills first when listing `/` so domain playbooks are instant).
  return [...filteredSkills, ...agentCommands];
}

/** Live list of enabled Olympus skills formatted as `SlashCommand[]` for composer `/` autocomplete. */
export function useSkillCommands(): SlashCommand[] {
  const [skills, setSkills] = useState<SkillView[]>(() => cached ?? []);

  useEffect(() => {
    ensureSubscribed();
    listeners.add(setSkills);
    if (!cached) void loadSkills();
    return () => {
      listeners.delete(setSkills);
    };
  }, []);

  return useMemo(() => toSkillSlashCommands(skills), [skills]);
}
