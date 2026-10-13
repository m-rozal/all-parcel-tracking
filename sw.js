// Offline shell. Bump VERSION whenever app files change so phones pick up the new build.
const VERSION = 'parcels-v2.1.0';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'parser.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // never cache the database API

  // Network first so updates land quickly; cache as offline fallback.
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: url.origin === location.origin })
        .then((hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
