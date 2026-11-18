# BUGS.md

Known issues in Olympus Coder. Fixed items stay listed with the date they were fixed.

## Open

None currently tracked.

## Fixed

- 2026-11-18 — Single-instance guard: `src/main/index.ts` now acquires `app.requestSingleInstanceLock()` right after
  resolving `userData` (before starting services or `will-quit` hooks, so a duplicate copy exits without stopping the
  primary copy's warm `whisper-server` or staged updates) and focuses/reopens the main window on `second-instance`.

- 2026-11-17 — Phone, landscape video markup: the screen slid out of the viewport. The floating sheet now wraps the
  video and loading screens too, not just the image editor.
- 2026-11-17 — File tree names wrapped one character per line while hovered (a "never scroll sideways" rule). Rows are
  single-line with an ellipsis again; hover actions float over the row end.
- 2026-11-17 — Whisper pid file: two app instances sharing one userData interleaved writes, leaving a pid glued to
  another that the next run could not stop. Writes are now atomic (tmp + rename) and startup parses every pid in the
  file.
