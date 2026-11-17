import { execFile } from 'node:child_process';
import { BrowserWindow, Menu, type WebContents } from 'electron';
import type { DictationResult } from '@shared/types';

/**
 * Voice input through the operating system's own dictation: no downloads, models or bundled binaries.
 * The renderer focuses the composer textarea first; dictated text then arrives as native text input, which the
 * controlled React textarea picks up through its normal `input` event.
 *
 * - macOS: AppKit's `startDictation:` action sent to the first responder (the focused web contents) — the same
 *   action as Edit → Start Dictation… and the Dictation shortcut.
 * - Windows: synthesizes Win+H, which opens Windows Voice Typing on the focused text field (Windows 10 1803+ / 11).
 * - Linux: no system dictation to start; the renderer hides the button.
 *
 * Not reachable from the phone page: it is its own IPC channel, outside the `handlers` table the remote link uses.
 */

const log = (...a: unknown[]) => console.log('[dictation]', ...a);

/** macOS stores the System Settings → Keyboard → Dictation switch here; `null` when it can't be read. */
function macDictationEnabled(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('defaults', ['read', 'com.apple.assistant.support', 'Dictation Enabled'], { timeout: 2000 }, (err, out) => {
      if (err) return resolve(null);
      const v = out.trim();
      resolve(v === '1' ? true : v === '0' ? false : null);
    });
  });
}

// Win+H via user32 keybd_event (SendKeys cannot press the Windows key). Compiled by PowerShell's Add-Type at run time.
const WIN_H_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace OlympusDictation -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);'
$up = 2
[OlympusDictation.Keys]::keybd_event(0x5B, 0, 0, [System.UIntPtr]::Zero)
[OlympusDictation.Keys]::keybd_event(0x48, 0, 0, [System.UIntPtr]::Zero)
[OlympusDictation.Keys]::keybd_event(0x48, 0, $up, [System.UIntPtr]::Zero)
[OlympusDictation.Keys]::keybd_event(0x5B, 0, $up, [System.UIntPtr]::Zero)
`;

function pressWinH(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', WIN_H_SCRIPT],
      { timeout: 10_000, windowsHide: true },
      (err, _out, stderr) => (err ? reject(new Error(stderr?.trim() || err.message)) : resolve()),
    );
  });
}

/**
 * The click already made the window key; only refocus when it isn't. `webContents.focus()` on macOS activates the
 * app, so never call it on a non-focusable window (the hidden E2E window) — that would take the user's focus.
 */
function ensureFocused(sender: WebContents) {
  const win = BrowserWindow.fromWebContents(sender);
  if (win && win.isFocusable() && !win.isFocused()) sender.focus();
}

export async function startDictation(sender: WebContents): Promise<DictationResult> {
  try {
    if (process.platform === 'darwin') {
      // The composer textarea is already focused by the renderer; make sure its web contents is the first responder.
      ensureFocused(sender);
      Menu.sendActionToFirstResponder('startDictation:');
      const enabled = await macDictationEnabled();
      log('sent startDictation: to first responder', { enabled });
      return enabled === false
        ? { ok: true, method: 'mac-startDictation', hint: 'Dictation is off. Turn it on in System Settings → Keyboard → Dictation.' }
        : { ok: true, method: 'mac-startDictation' };
    }
    if (process.platform === 'win32') {
      ensureFocused(sender);
      await pressWinH();
      log('pressed Win+H');
      return { ok: true, method: 'win-voice-typing' };
    }
    return { ok: false, error: 'System dictation is not available on this platform.' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('failed', error);
    return { ok: false, error };
  }
}
