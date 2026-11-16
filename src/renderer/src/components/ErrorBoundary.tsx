import { Component, type ReactNode } from 'react';

/**
 * A render error in one part of the UI shows a small "something went wrong" card with the error and a way out,
 * instead of unmounting the whole app into a blank window.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; onClose?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[olympus] ${this.props.label ?? 'UI'} crashed:`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash-card" role="alert">
        <b>{this.props.label ?? 'This view'} hit an error</b>
        <pre>{String(this.state.error.message || this.state.error)}</pre>
        <span className="small muted">If you just updated the app, restart it (in dev: stop and run npm run dev again) so the main process matches.</span>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn small primary" onClick={() => location.reload()}>
            Reload
          </button>
          {this.props.onClose && (
            <button className="btn small" onClick={() => (this.setState({ error: null }), this.props.onClose!())}>
              Close
            </button>
          )}
        </div>
      </div>
    );
  }
}
