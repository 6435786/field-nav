// field-nav service worker — offline shell + cached library code
// Bump CACHE_VERSION on every release that ships changes to the cached files.
const CACHE_VERSION = 'v56';
const SHELL_CACHE = `fieldnav-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `fieldnav-runtime-${CACHE_VERSION}`;

// Files served from our origin that the app needs to function offline.
const SHELL_FILES = [
  './',
  './index.html',
  './go.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
];

// Third-party libraries we want available offline (cached on first request).
// Match by hostname so query strings / version paths still hit cache.
const RUNTIME_HOSTS = [
  'cdnjs.cloudflare.com',          // proj4, qrcodejs, leaflet css/js
  'cdn.jsdelivr.net',               // jsQR
  'unpkg.com',                      // (just in case)
  'fonts.googleapis.com',           // Heebo CSS
  'fonts.gstatic.com',              // Heebo font files
  'www.gstatic.com',                // firebase-app/auth/firestore compat
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Strategy:
// - GET requests for our shell: cache-first (instant offline)
// - GET requests for known third-party libs: stale-while-revalidate
// - GET requests for map tiles: cache-first with size-bounded runtime cache
// - Everything else (Firestore, elevation API, geolocation): network-only,
//   so they fail gracefully when offline rather than serving stale data.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Map tiles — cache-first with rolling cache
  const isTile = /tile\.openstreetmap|server\.arcgisonline\.com|opentopomap|israelhiking\.osm\.org\.il/.test(url.host + url.pathname);
  if (isTile) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Same-origin shell — cache-first
  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Known third-party hosts — stale-while-revalidate
  if (RUNTIME_HOSTS.includes(url.host)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Default: just go to network (Firestore, elevation API, etc.)
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  // Targeted fallback: ONLY when the root path is navigated to with a query
  // string (e.g. Web Share Target landing at "./?share_text=..."), serve the
  // cached index.html shell. Don't apply this to /go.html?q=... or any other
  // path — those must either hit their own cached file or fall through to a
  // fresh network fetch.
  try {
    const url = new URL(req.url);
    const isRootPath = url.pathname === '/' || url.pathname.endsWith('/index.html');
    const isNav = (req.headers.get('Accept') || '').includes('text/html') || req.mode === 'navigate';
    if (isRootPath && isNav && url.search) {
      const shell = await cache.match('./index.html') || await cache.match('./');
      if (shell) return shell;
    }
  } catch (e) { /* URL parse failure — ignore, fall through to network */ }
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchAndCache = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetchAndCache;
}

// Allow the page to ask the SW to take over immediately after an update.
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
