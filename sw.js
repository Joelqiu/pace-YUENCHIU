const CACHE = 'campus-move-v28';
const SCOPE = self.registration.scope;

// Cache the installable app shell and its local dependencies. External map
// tiles and /api/* requests remain network-only.
const ASSETS = [
  './',
  'index.html',
  'classroom.html',
  'database.html',
  'guide.html',
  'handout.html',
  'live.html',
  'review.html',
  'style.css',
  'document.css',
  'classroom.css',
  'live.css',
  'core.js',
  'app.js',
  'api-config.js',
  'api-client.js',
  'classroom.js',
  'cloud-upload.js',
  'cloud-live.js',
  'live.js',
  'review.js',
  'mode.js',
  'tiles.js',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'manifest.webmanifest',
  'assets/campus-run.webp',
  'assets/track-essentials.webp',
  'assets/classroom-hero.jpg',
  'assets/classroom-connection.jpg',
  'vendor/leaflet.js',
  'vendor/leaflet.css'
];

const ASSET_URLS = new Set(ASSETS.map(path => new URL(path, SCOPE).href));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll([...ASSET_URLS]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('campus-move-') && key !== CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const key = `${url.origin}${url.pathname}`;

  if (request.method !== 'GET' || url.origin !== self.location.origin || !ASSET_URLS.has(key)) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && !response.redirected) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
