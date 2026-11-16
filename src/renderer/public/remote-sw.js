// Olympus phone app: a pass-through service worker (needed to install the app on Android; nothing is cached,
// so the phone always shows the Mac's live state).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
