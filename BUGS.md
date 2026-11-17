# BUGS.md

Known issues in Olympus Coder. Fixed items stay listed with the date they were fixed.

## Open

- **No single-instance guard.** The app never calls `app.requestSingleInstanceLock()`, so two copies can run with the
  same userData (automated tests avoid this with their own `--user-data-dir`). Seen 2026-11-17: two copies raced the
  whisper pid file (one pid glued to another: `6766855360`) and each kept a warm whisper-server. The pid file itself is
  now hardened (`pidsInFile` parses glued pids, writes are tmp+rename), but running two copies with one userData is
  still unsupported.

## Fixed

- 2026-11-17 — Phone, landscape video markup: the screen slid out of the viewport. The floating sheet now wraps the
  video and loading screens too, not just the image editor.
- 2026-11-17 — File tree names wrapped one character per line while hovered (a "never scroll sideways" rule). Rows are
  single-line with an ellipsis again; hover actions float over the row end.
- 2026-11-17 — Whisper pid file: two app instances sharing one userData interleaved writes, leaving a pid glued to
  another that the next run could not stop. Writes are now atomic (tmp + rename) and startup parses every pid in the
  file.
