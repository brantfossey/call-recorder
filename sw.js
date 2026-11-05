// Bump this name when a precached file is removed. Network responses refresh
// the cache while online; this list is the offline copy.
const CACHE = 'call-recorder-v1';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './media.js',
  './manifest.webmanifest',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok && fresh.type === 'basic') {
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      return (await cache.match('./index.html'))
        || (await cache.match('./'))
        || Promise.reject(error);
    }
    throw error;
  }
}
