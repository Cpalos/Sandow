// Sandow — Service Worker
const CACHE_NAME = 'sandow-v1';
const MARINE_CACHE = 'sandow-data-v1';

// Assets à mettre en cache pour le mode hors-ligne
const STATIC_ASSETS = [
  './',
  './index.html',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME && k !== MARINE_CACHE)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Cache météo marine (stale-while-revalidate)
  if (url.hostname.includes('open-meteo.com') || url.hostname.includes('marine-api')) {
    e.respondWith(
      caches.open(MARINE_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const fetched = fetch(e.request).then(res => {
            cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // App shell (cache-first)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
