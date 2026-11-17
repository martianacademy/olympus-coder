import '../skeleton.css';

/**
 * Loading placeholders (see skeleton.css). Purely visual: no text, hidden from screen readers, with fixed widths
 * per row (no randomness) so they look the same on every render and in screenshots.
 */
const ROW_WIDTHS = [72, 58, 84, 46, 66, 78, 52, 62];

/** The sidebar's chat list before the first load. */
export function SidebarSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="sk-wrap sk-list" aria-hidden="true" data-testid="sk-sidebar">
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-row" key={i}>
          <span className="sk round" style={{ width: 8, height: 8 }} />
          <span className="sk" style={{ width: `${ROW_WIDTHS[i % ROW_WIDTHS.length]}%` }} />
        </div>
      ))}
    </div>
  );
}

/** A chat's messages while it opens. */
export function ChatSkeleton() {
  const turn = (user: number, lines: number[]) => (
    <div className="sk-turn">
      <span className="sk sk-user" style={{ width: `${user}%` }} />
      {lines.map((w, i) => (
        <span className="sk sk-line" key={i} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
  return (
    <div className="sk-wrap sk-chat" aria-hidden="true" data-testid="sk-chat">
      {turn(42, [92, 86, 64])}
      {turn(30, [88, 94, 78, 40])}
      {turn(36, [80, 56])}
    </div>
  );
}

/** A side panel (Files, Git, Tasks, Info) before its first data. */
export function PanelSkeleton({ rows = 7, head = true }: { rows?: number; head?: boolean }) {
  return (
    <div className="sk-wrap sk-panel" aria-hidden="true" data-testid="sk-panel">
      {head && <span className="sk sk-head" style={{ width: '38%' }} />}
      {Array.from({ length: rows }, (_, i) => (
        <div className="sk-row" key={i}>
          <span className="sk" style={{ width: 14, height: 14, borderRadius: 4 }} />
          <span className="sk" style={{ width: `${ROW_WIDTHS[(i + 3) % ROW_WIDTHS.length]}%` }} />
        </div>
      ))}
    </div>
  );
}
