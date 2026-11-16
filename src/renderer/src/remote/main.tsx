// The bridge must run first: it gives the remote browser the same `window.desk` surface as the desktop window.
import './bridge';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xterm/xterm/css/xterm.css';
import 'katex/dist/katex.min.css';
import '../styles.css';
import '../design.css';
import '../composerCards.css';
import '../taskSubagents.css';
import '../workGroup.css';
import '../mediaAndConsole.css';
import '../responsive.css';
import './remote.css';
import { RemoteApp } from './RemoteApp';
import { installTooltips } from '../tooltip';
import { ErrorBoundary } from '../components/ErrorBoundary';

document.documentElement.classList.add('remote');
installTooltips();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="Olympus">
    <RemoteApp />
  </ErrorBoundary>,
);

// "Add to Home Screen" needs a service worker on Android; it only passes requests through.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/remote-sw.js').catch(() => {});
