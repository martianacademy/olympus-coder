/** Puts text into the open chat's message box (without sending it), so the user can read, edit and send it. */
export function composeInChat(text: string) {
  window.dispatchEvent(new CustomEvent('olympus:compose', { detail: { text } }));
}

/** ANSI colour and cursor codes out of terminal text. */
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g, '');

/** Output that usually means a command failed: stack traces, compiler errors, failed tests, missing commands. */
export const ERROR_LINE =
  /Traceback \(most recent call last\)|^\s*(\w+\.)*\w*(Error|Exception)\b[:\s]|\berror(\[E\d+\])?:|\berror TS\d+|npm ERR!|ERR_PNPM|ERR!|\bFAILED\b|\bFAIL\b |✗|✖|panicked at|Unhandled(Promise)?Rejection|command not found|No such file or directory|Segmentation fault|^fatal: |exited with code [1-9]/m;

/** The port in an "address already in use" error (Node, Python, Go, Vite, Next, Flask …), or null. */
export function portInUse(text: string): number | null {
  const t = text.slice(-20000);
  const pats = [
    /EADDRINUSE[^\n]*?:(\d{2,5})\b/,
    /address already in use[^\n]*?(?::|port )(\d{2,5})\b/i,
    /(?::|port )(\d{2,5})[^\n]{0,40}address already in use/i,
    /port (\d{2,5}) is (?:already )?in use/i,
    /listen tcp [^\s]*:(\d{2,5}): bind: address already in use/i,
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n < 65536) return n;
    }
  }
  return null;
}
