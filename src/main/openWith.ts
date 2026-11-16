import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shell } from 'electron';
import { spawnable, which } from './env';
import { inside } from './files';

/**
 * "Open with" for the file explorer: the code editors installed on this computer, and opening a project file or
 * folder in one of them (or in the system's default app / file manager). Paths always go through `inside()`, so
 * only files of the project can be opened.
 */

interface EditorSpec {
  id: string;
  name: string;
  /** macOS app bundle names, tried in /Applications and ~/Applications. */
  mac?: string[];
  /** Command-line launchers (Windows / Linux, and macOS when no app bundle is found). */
  cli: string[];
}

const EDITORS: EditorSpec[] = [
  { id: 'vscode', name: 'VS Code', mac: ['Visual Studio Code', 'Visual Studio Code - Insiders'], cli: ['code', 'code-insiders'] },
  { id: 'cursor', name: 'Cursor', mac: ['Cursor'], cli: ['cursor'] },
  { id: 'windsurf', name: 'Windsurf', mac: ['Windsurf'], cli: ['windsurf'] },
  { id: 'antigravity', name: 'Antigravity', mac: ['Antigravity'], cli: ['antigravity'] },
  { id: 'zed', name: 'Zed', mac: ['Zed'], cli: ['zed', 'zeditor'] },
  { id: 'sublime', name: 'Sublime Text', mac: ['Sublime Text'], cli: ['subl'] },
  { id: 'webstorm', name: 'WebStorm', mac: ['WebStorm'], cli: ['webstorm'] },
  { id: 'idea', name: 'IntelliJ IDEA', mac: ['IntelliJ IDEA', 'IntelliJ IDEA CE'], cli: ['idea'] },
  { id: 'xcode', name: 'Xcode', mac: ['Xcode'], cli: [] },
];

export interface EditorView {
  id: string;
  name: string;
}

type Launch = { app: string } | { cli: string };

function find(e: EditorSpec): Launch | null {
  if (process.platform === 'darwin') {
    for (const name of e.mac ?? []) {
      for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
        if (existsSync(join(dir, `${name}.app`))) return { app: name };
      }
    }
  }
  for (const bin of e.cli) {
    const p = which(bin);
    if (p) return { cli: p };
  }
  return null;
}

let cache: { at: number; list: { spec: EditorSpec; launch: Launch }[] } | null = null;

function installed() {
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = { at: Date.now(), list: EDITORS.flatMap((spec) => (find(spec) ? [{ spec, launch: find(spec)! }] : [])) };
  }
  return cache.list;
}

/** Code editors found on this computer, in a fixed order. */
export function listEditors(): EditorView[] {
  return installed().map(({ spec }) => ({ id: spec.id, name: spec.name }));
}

/** Opens a project file or folder in one of the installed editors. */
export function openInEditor(projectId: string, rel: string, editorId: string): Promise<void> {
  const target = inside(projectId, rel);
  const hit = installed().find((e) => e.spec.id === editorId);
  if (!hit) return Promise.reject(new Error('That editor was not found on this computer.'));
  if ('app' in hit.launch) {
    const app = hit.launch.app;
    return new Promise((res, rej) => execFile('/usr/bin/open', ['-a', app, target], (err) => (err ? rej(new Error(`Could not open ${hit.spec.name}: ${err.message}`)) : res())));
  }
  const run = spawnable(hit.launch.cli, [target]);
  const child = spawn(run.command, run.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return new Promise((res, rej) => {
    child.once('error', (err) => rej(new Error(`Could not open ${hit.spec.name}: ${err.message}`)));
    child.once('spawn', () => res());
  });
}

/** Opens a project file with the system's default app (a folder opens in Finder / Explorer / the file manager). */
export async function openDefault(projectId: string, rel: string): Promise<void> {
  const err = await shell.openPath(inside(projectId, rel));
  if (err) throw new Error(err);
}
