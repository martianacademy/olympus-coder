import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import './design.css';
import './composerCards.css';
import './taskSubagents.css';
import './workGroup.css';
import './mediaAndConsole.css';
import './appearance.css';
import './responsive.css';
import './panelWindow.css';
import App from './App';
import { parsePanelQuery } from '@shared/panels';
import { installTooltips } from './tooltip';
import { ErrorBoundary } from './components/ErrorBoundary';

const PanelApp = lazy(() => import('./components/PanelApp').then((m) => ({ default: m.PanelApp })));

installTooltips();

// `?panel=<tool>`: a detached Workbench tool window (src/main/panels.ts) renders only that tool.
const panel = parsePanelQuery(location.search);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label={panel ? `Olympus Coder · ${panel.tool}` : 'Olympus Coder'}>
    {panel ? (
      <Suspense fallback={null}>
        <PanelApp tool={panel.tool} url={panel.url} />
      </Suspense>
    ) : (
      <App />
    )}
  </ErrorBoundary>,
);
