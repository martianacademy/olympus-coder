import type { ReactNode } from 'react';
import { Brain, ChevronDown, ChevronRight, FileText, SquareTerminal } from 'lucide-react';
import { BrandWorkingMark } from '../Working';

/** Live sample of chat text, thinking and steps, drawn with the Appearance settings active right now. */
export function ReadingPreview() {
  return (
    <div className="appearance-preview" data-testid="reading-preview">
      <div className="small muted" style={{ marginBottom: 6 }}>
        Preview
      </div>
      <div className="msg-agent">
        <p>
          A reply reads like this, with <b>bold words</b> and <code>inline code</code>.
        </p>
      </div>
      <div className="thought msg-agent">Thinking looks like this — quieter, so the answer stands out.</div>
      <StepsPreview />
    </div>
  );
}

/** Static, non-interactive copy of a live and settled WorkGroup (same classes), so Steps size and right-edge fade show live. */
function StepsPreview() {
  const rows: { icon: ReactNode; verb: string; target: string; mono?: boolean }[] = [
    { icon: <Brain size={14} />, verb: 'Thought', target: 'Read the entry file first' },
    { icon: <FileText size={14} />, verb: 'Read', target: 'src/app.ts' },
    { icon: <SquareTerminal size={14} />, verb: 'Ran', target: 'npm test', mono: true },
  ];
  return (
    <div className="appearance-steps-preview" aria-hidden="true" data-testid="steps-preview">
      <div className="tool-group work-group is-live" data-testid="steps-preview-live">
        <div className="tool-group-head work-group-head">
          <BrandWorkingMark compact />
          <span className="wg-verb">Running</span>
          <span className="grow wg-target wg-live-detail mono">
            npx tsc --noEmit -p tsconfig.json &amp;&amp; npx electron-vite build --mode production &amp;&amp; node tests/stepImages.unit.mjs
          </span>
          <span className="wg-time">4s</span>
          <ChevronRight size={14} className="wg-chev" />
        </div>
      </div>
      <div className="tool-group work-group">
        <div className="tool-group-head work-group-head">
          <span className="grow wg-settled-title">
            <span className="wg-headline">Worked for 28s</span>
            <span className="wg-detail wg-part"> · 1 command, 1 file read</span>
          </span>
          <ChevronDown size={14} className="wg-chev" />
        </div>
        <div className="tool-group-body work-group-body">
          {rows.map((r) => (
            <div key={r.verb} className="wg-step wg-step-done">
              <span className="wg-step-icon">{r.icon}</span>
              <div className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-badge wg-verb">{r.verb}</span>
                  <span className={`grow ellipsis tool-row-title ${r.mono ? 'mono cmd-term-title' : 'human'}`}>{r.target}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
