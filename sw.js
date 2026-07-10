/* HomeDashboard service worker — app shell + runtime CDN cache. */
const SHELL_VERSION = 'v14';
const SHELL_CACHE = `home-dashboard-shell-${SHELL_VERSION}`;
const RUNTIME_CACHE = `home-dashboard-runtime-${SHELL_VERSION}`;

const SHELL_ASSETS = [
  './',
  'index.html',
  'bus.html',
  'search.html',
  'manifest.json',
  'config.json',
  'build-info.json',
  'css/style.css',
  'js/app.js',
  'js/bus.js',
  'js/location.js',
  'js/transit-api.js',
  'js/utils.js',
  'js/weather.js',
  'js/pull-to-refresh.js',
  'js/route-search.js',
  'js/route-search-api.js',
  'js/route-fare-db.js',
  'js/register-sw.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/layers.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png',
];

const CDN_HOSTS = new Set(['unpkg.com']);
const ROUTE_API_HOSTS = new Set([
  'data.etabus.gov.hk',
  'rt.data.gov.hk',
  'data.etagmb.gov.hk',
  'data.hkbus.app',
]);

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function cacheAddAllSafe(cache, urls) {
  await Promise.allSettled(urls.map((url) => cache.add(url)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await cacheAddAllSafe(shell, SHELL_ASSETS.map(scopeUrl));

    const runtime = await caches.open(RUNTIME_CACHE);
    await cacheAddAllSafe(runtime, CDN_ASSETS);

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => {
          if (key === SHELL_CACHE || key === RUNTIME_CACHE) return false;
          return key.startsWith('home-dashboard-shell-') || key.startsWith('home-dashboard-runtime-');
        })
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    refresh.catch(() => {});
    return cached;
  }

  const response = await refresh;
  if (response) return response;
  return Response.error();
}

async function networkFirstBuildInfo(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    return Response.error();
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match(scopeUrl('bus.html'), { ignoreSearch: true })) ||
      (await cache.match(scopeUrl('index.html'))) ||
      (await cache.match(scopeUrl('./')));
    if (cached) return cached;
    return new Response('オフラインです。ネットワーク接続を確認してください。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

function isCdnAsset(url) {
  return CDN_HOSTS.has(url.hostname);
}

function isRouteApi(url) {
  return ROUTE_API_HOSTS.has(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (isCdnAsset(url)) {
      event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    } else if (isRouteApi(url)) {
      event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    }
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.pathname.endsWith('/build-info.json')) {
    event.respondWith(networkFirstBuildInfo(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});
