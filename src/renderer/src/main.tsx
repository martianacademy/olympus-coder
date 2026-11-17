import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xterm/xterm/css/xterm.css';
import 'katex/dist/katex.min.css';
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
import { PanelApp } from './components/PanelApp';
import { parsePanelQuery } from '@shared/panels';
import { installTooltips } from './tooltip';
import { ErrorBoundary } from './components/ErrorBoundary';

installTooltips();

// `?panel=<tool>`: a detached Workbench tool window (src/main/panels.ts) renders only that tool.
const panel = parsePanelQuery(location.search);

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label={panel ? `Olympus Coder · ${panel.tool}` : 'Olympus Coder'}>{panel ? <PanelApp tool={panel.tool} url={panel.url} /> : <App />}</ErrorBoundary>,
);
