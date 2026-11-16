import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LearnedNote } from '@shared/types';
import { getSettings, sharedRoot, writeJson } from './store';

/**
 * What agents learn about the user over time (how they talk, think and solve problems, interests, context),
 * so every new session can adapt to them. Agents add notes with the `remember_about_user` tool, only from
 * what the user says or does; the user sees each one in the chat and in their profile, can delete any, or
 * turn learning off. Kept in the shared folder (<shared>/user/learned.json), apart from the profile the user
 * edits, so the two never overwrite each other.
 */

export const NOTE_SECTIONS: Record<LearnedNote['section'], string> = {
  communication: 'How they communicate',
  thinking: 'How they think',
  problem_solving: 'How they approach problems',
  interests: 'Interests',
  context: 'Context (place, work, setup)',
  preferences: 'Preferences',
};
const PER_SECTION = 12;
const MAX_LEN = 240;

const file = () => join(sharedRoot(), 'user', 'learned.json');

export const learningOn = () => getSettings().profile?.learnAboutUser !== false;

export function listNotes(): LearnedNote[] {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return Array.isArray(j.notes) ? j.notes : [];
  } catch {
    return [];
  }
}

function save(notes: LearnedNote[]) {
  mkdirSync(join(sharedRoot(), 'user'), { recursive: true });
  writeJson(file(), { notes });
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Things that must never be stored: passwords, keys, tokens. */
const SECRET = /(password|passwd|passcode|api[ _-]?key|secret|access[ _-]?token|private key|-----BEGIN|\bsk-[A-Za-z0-9]{10,}|\b[A-Za-z0-9+/_-]{32,}\b)/i;

export function addNote(section: string, text: string, agentId: string): string {
  if (!learningOn()) return 'The user has turned off learning about them. Nothing was saved.';
  if (!(section in NOTE_SECTIONS)) throw new Error(`"section" must be one of: ${Object.keys(NOTE_SECTIONS).join(', ')}.`);
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('"note" is empty.');
  if (t.length > MAX_LEN) throw new Error(`Keep a note under ${MAX_LEN} characters.`);
  if (SECRET.test(t)) return 'Not saved: it looks like it contains a password, key or token. Never store secrets about the user.';
  const notes = listNotes();
  const n = norm(t);
  const same = notes.find((x) => x.section === section && (norm(x.text) === n || norm(x.text).includes(n) || n.includes(norm(x.text))));
  if (same) {
    // A fuller version replaces a shorter one; an older duplicate is just confirmed.
    if (t.length > same.text.length) same.text = t;
    same.ts = Date.now();
    save(notes);
    return `Already known; updated: "${same.text}"`;
  }
  const note: LearnedNote = { id: randomUUID(), section: section as LearnedNote['section'], text: t, ts: Date.now(), agentId };
  const next = [...notes, note];
  // Oldest notes in a full section make room.
  const inSection = next.filter((x) => x.section === section).sort((a, b) => a.ts - b.ts);
  const drop = new Set(inSection.slice(0, Math.max(0, inSection.length - PER_SECTION)).map((x) => x.id));
  save(next.filter((x) => !drop.has(x.id)));
  return `Saved to the user's profile (${NOTE_SECTIONS[note.section]}): "${t}". The user can see and delete it in their profile.`;
}

export function deleteNote(id: string): LearnedNote[] {
  const next = listNotes().filter((n) => n.id !== id);
  save(next);
  return next;
}

export function clearNotes(): LearnedNote[] {
  save([]);
  return [];
}

/** For the context every new session gets: the notes, grouped. */
export function notesForAgents(): string {
  if (!learningOn()) return '';
  const notes = listNotes();
  if (!notes.length) return '';
  const out: string[] = [];
  for (const [key, label] of Object.entries(NOTE_SECTIONS)) {
    const list = notes.filter((n) => n.section === key);
    if (list.length) out.push(`- ${label}: ${list.map((n) => n.text).join(' · ')}`);
  }
  return out.join('\n');
}
