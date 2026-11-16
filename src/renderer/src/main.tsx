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
import './responsive.css';
import App from './App';
import { installTooltips } from './tooltip';
import { ErrorBoundary } from './components/ErrorBoundary';

installTooltips();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="Olympus Coder">
    <App />
  </ErrorBoundary>,
);
