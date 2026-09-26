const CACHE_NAME = 'orange-contract-v35';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './styles.css?v=42',
  './script.js',
  './script.js?v=42',
  './credentials.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // allSettled: a single unreachable third-party asset must not abort the whole install
      return Promise.allSettled(ASSETS.map((asset) => cache.add(asset)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // 0. Only GET requests are cacheable — never intercept writes (POST/PATCH/DELETE)
  if (e.request.method !== 'GET') {
    return;
  }

  // 1. BYPASS caching completely for local development to prevent update/stale lag issues
  if (e.request.url.includes('localhost') || e.request.url.includes('127.0.0.1')) {
    return;
  }

  // 2. Bypass caching for Google APIs and Supabase endpoints
  if (e.request.url.includes('supabase.co') || 
      e.request.url.includes('googleapis.com') || 
      e.request.url.includes('accounts.google.com')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Revalidate own app files in the background; third-party bundles refresh on cache version bump
        if (new URL(e.request.url).origin === self.location.origin) {
          fetch(e.request).then((networkResponse) => {
            if (networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(e.request, networkResponse));
            }
          }).catch(() => {/* Ignore offline fetch errors */});
        }

        return cachedResponse;
      }
      return fetch(e.request);
    })
  );
});
