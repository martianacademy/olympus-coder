// The bridge must run first: it gives the remote browser the same `window.desk` surface as the desktop window.
import './bridge';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
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
import { fitHeight, type FitState } from './viewportFit';

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

// Opened from the home screen (iOS "Add to Home Screen", installed PWA): iOS reports the height short by the status
// bar there and leaves the keyboard to scroll the page; viewportFit.ts sizes the app to the screen above the
// keyboard instead. `navigator.standalone` exists only on iOS/iPadOS WebKit.
const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
const standalone = iosStandalone || matchMedia('(display-mode: standalone)').matches;
if (standalone) {
  const root = document.documentElement;
  root.classList.add('standalone');
  const vv = window.visualViewport;
  let state: FitState = { orientation: '', base: 0 };
  let applied = '';
  const fit = () => {
    if (!iosStandalone) return root.style.setProperty('--app-h', `${window.innerHeight}px`);
    if (vv && vv.scale > 1.01) return; // pinch-zoomed: keep the layout as it is
    const r = fitHeight({ visible: vv?.height ?? window.innerHeight, innerWidth: window.innerWidth, screenWidth: screen.width, screenHeight: screen.height }, state);
    state = r.state;
    const h = `${r.height}px`;
    if (h !== applied) root.style.setProperty('--app-h', (applied = h));
    root.classList.toggle('kb-open', r.keyboard);
    // iOS scrolled the whole page up to show the focused box; the app now fits above the keyboard, so undo that.
    if (window.scrollY || (vv?.offsetTop ?? 0)) window.scrollTo(0, 0);
  };
  fit();
  window.addEventListener('resize', fit);
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  window.addEventListener('orientationchange', () => setTimeout(fit, 250));

  // Tapping a box opens the keyboard, but iOS does not always send a resize for it: the app stayed full height
  // (composer under the keyboard) until the first keystroke scrolled the caret into view. So re-measure every
  // frame while the keyboard slides in or out after a box gains or loses focus.
  if (iosStandalone) {
    let until = 0;
    let frame = 0;
    const tick = () => {
      fit();
      frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const settle = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !(el.matches('input, textarea, select') || el.isContentEditable)) return;
      until = performance.now() + 1000;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="Olympus">
    <RemoteApp />
  </ErrorBoundary>,
);

// "Add to Home Screen" needs a service worker on Android; it only passes requests through.
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/remote-sw.js').catch(() => {});
