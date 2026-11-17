import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import type { WhisperModelInfo } from '@shared/voice';

/**
 * Finds whisper.cpp already installed on this machine: the `whisper-server` / `whisper-cli` binaries and ggml model
 * files. Detection only: nothing is ever downloaded. Every input (home, PATH, platform) is passed in so the unit test
 * can point it at fake folders.
 */
export interface DetectCtx {
  home: string;
  platform: NodeJS.Platform;
  /** The PATH value to search (the app loads the login shell's PATH at start). */
  pathEnv: string;
  /** Windows: %LOCALAPPDATA%. */
  localAppData?: string;
}

/** Folders that commonly hold whisper.cpp binaries besides PATH (Finder-launched apps get a short PATH). */
export function binaryDirs(ctx: DetectCtx): string[] {
  const fromPath = ctx.pathEnv.split(ctx.platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const extra =
    ctx.platform === 'win32'
      ? [join(ctx.home, 'whisper.cpp', 'build', 'bin', 'Release'), join(ctx.home, 'whisper.cpp', 'build', 'bin')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(ctx.home, '.local', 'bin'), join(ctx.home, 'whisper.cpp', 'build', 'bin')];
  return [...new Set([...fromPath, ...extra])];
}

/** First `name` (plus `.exe` on Windows) found in the binary folders. */
export function findBinary(name: string, ctx: DetectCtx): string | undefined {
  const file = ctx.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of binaryDirs(ctx)) {
    const p = join(dir, file);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/**
 * Where tools that use whisper.cpp keep ggml models:
 * - `~/.cache/whisper-cpp`, `~/.cache/whisper.cpp`: whisper.cpp's own download script / common choice;
 * - `~/.cache/hyperframes/whisper/models`: HyperFrames;
 * - `~/whisper.cpp/models`: a source checkout's `models/download-ggml-model.sh`;
 * - `~/.local/share/pywhispercpp/models`: pywhispercpp;
 * - MacWhisper's Application Support folder (direct and sandboxed builds);
 * - Homebrew `share/whisper-cpp` (only test models there today; those are filtered out).
 */
export function modelDirs(ctx: DetectCtx): string[] {
  const h = ctx.home;
  const dirs = [
    join(h, '.cache', 'whisper-cpp'),
    join(h, '.cache', 'whisper.cpp'),
    join(h, '.cache', 'hyperframes', 'whisper', 'models'),
    join(h, 'whisper.cpp', 'models'),
    join(h, '.local', 'share', 'pywhispercpp', 'models'),
  ];
  if (ctx.platform === 'darwin') {
    dirs.push(
      join(h, 'Library', 'Application Support', 'MacWhisper', 'models'),
      join(h, 'Library', 'Containers', 'com.goodsnooze.MacWhisper', 'Data', 'Library', 'Application Support', 'MacWhisper', 'models'),
      '/opt/homebrew/share/whisper-cpp',
      '/usr/local/share/whisper-cpp',
    );
  }
  if (ctx.platform === 'win32' && ctx.localAppData) dirs.push(join(ctx.localAppData, 'whisper.cpp', 'models'));
  return dirs;
}

/** Real speech models only: `ggml-*.bin`, not the tiny test models or VAD models, at least 10 MB. */
export function isSpeechModel(file: string, bytes: number): boolean {
  const n = basename(file).toLowerCase();
  if (!/^ggml-.*\.bin$/.test(n)) return false;
  if (n.startsWith('for-tests') || n.includes('silero') || n.includes('vad')) return false;
  return bytes >= 10 * 1024 * 1024;
}

/** Rough accuracy rank from the file name: large-v3-turbo / large-v3 first, tiny last; multilingual before `.en`. */
export function modelRank(name: string): number {
  const n = name.toLowerCase();
  const size = n.includes('large-v3-turbo') ? 90 : n.includes('large-v3') ? 100 : n.includes('large') ? 80 : n.includes('medium') ? 60 : n.includes('small') ? 40 : n.includes('base') ? 20 : n.includes('tiny') ? 10 : 30;
  return size - (/\.en[.-]/.test(n) ? 5 : 0) - (/-q\d/.test(n) ? 2 : 0);
}

export function detectModels(ctx: DetectCtx, extraFiles: string[] = []): WhisperModelInfo[] {
  const out: WhisperModelInfo[] = [];
  const seen = new Set<string>();
  const add = (path: string, source: WhisperModelInfo['source']) => {
    if (seen.has(path)) return;
    try {
      const st = statSync(path);
      if (!st.isFile()) return;
      if (source === 'detected' && !isSpeechModel(path, st.size)) return;
      seen.add(path);
      out.push({ path, name: basename(path).replace(/^ggml-/, '').replace(/\.bin$/, ''), bytes: st.size, source });
    } catch {
      /* gone */
    }
  };
  for (const dir of modelDirs(ctx)) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) add(join(dir, n), 'detected');
  }
  for (const f of extraFiles) add(f, 'added');
  return out.sort((a, b) => modelRank(b.name) - modelRank(a.name) || a.name.localeCompare(b.name));
}

export function detectWhisper(ctx: DetectCtx, extraFiles: string[] = []) {
  return { server: findBinary('whisper-server', ctx), cli: findBinary('whisper-cli', ctx), models: detectModels(ctx, extraFiles) };
}
