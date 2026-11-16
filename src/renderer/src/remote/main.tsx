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
import '../appearance.css';
import '../responsive.css';
import './remote.css';
import { RemoteApp } from './RemoteApp';
import { installTooltips } from '../tooltip';
import { ErrorBoundary } from '../components/ErrorBoundary';

document.documentElement.classList.add('remote');
installTooltips();

// A newer version was deployed while this page stayed open (iOS keeps home-screen apps in memory): a part loaded
// on demand (a chat, a panel) is gone from the server. Reload once into the current version instead of a dead tap.
window.addEventListener('vite:preloadError', (e) => {
  const last = Number(sessionStorage.getItem('olympus.reloadedForUpdate') || 0);
  if (Date.now() - last < 30_000) return; // already reloaded just now: let the error show instead of looping
  e.preventDefault();
  sessionStorage.setItem('olympus.reloadedForUpdate', String(Date.now()));
  location.reload();
});

// Opened from the home screen (iOS "Add to Home Screen", installed PWA): iOS reports 100dvh short by the
// status bar's height there, which left an empty band under the composer. The window's own height is right.
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
if (standalone) {
  const root = document.documentElement;
  root.classList.add('standalone');
  const fit = () => root.style.setProperty('--app-h', `${window.innerHeight}px`);
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', () => setTimeout(fit, 250));
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="Olympus">
    <RemoteApp />
  </ErrorBoundary>,
);

// "Add to Home Screen" needs a service worker on Android; it only passes requests through.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/remote-sw.js').catch(() => {});
