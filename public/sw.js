/* ORBLOOD service worker.
 *
 *   - /api/*, /ws, uploads and health checks are never touched (always
 *     live; no stale chat data, no cached tokens or TURN credentials).
 *   - The app shell (HTML / JS / CSS / manifest) is NETWORK-FIRST: online
 *     users always run the newest deploy, the cache is only an offline
 *     fallback. (Stale-while-revalidate used to keep old voice code alive
 *     for a whole extra load after every deploy.)
 *   - Fonts / icons / images are cache-first (they rarely change).
 *
 * deploy.sh rewrites CACHE_NAME on every deploy, which also purges old
 * caches on activate.
 */
const CACHE_NAME = 'orblood-shell-v8-20261015';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/js/app.js',
  '/manifest.webmanifest'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isLiveRequest(url) {
  return url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/ws')
      || url.pathname.startsWith('/uploads/')
      || url.pathname.endsWith('/healthz')
      || url.pathname === '/voice-debug.html'
      || url.pathname === '/clear-cache.html';
}

function isShell(req, url) {
  return req.mode === 'navigate'
      || /\.(html|js|css|webmanifest)$/i.test(url.pathname)
      || url.pathname === '/';
}

// Cache key without the ?v= build stamp, so the offline copy is found no
// matter which stamp the HTML referenced.
function keyFor(url) {
  return url.origin + url.pathname;
}

async function networkFirst(req, url) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok && res.type === 'basic') cache.put(keyFor(url), res.clone());
    return res;
  } catch (_) {
    const hit = await cache.match(keyFor(url), { ignoreSearch: true })
             || (req.mode === 'navigate' ? await cache.match('/index.html', { ignoreSearch: true }) : null);
    return hit || new Response('', { status: 504, statusText: 'offline' });
  }
}

async function cacheFirst(req, url) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (_) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Same-origin only; never mediate cross-origin fetches.
  if (url.origin !== self.location.origin) return;
  if (isLiveRequest(url)) return;
  event.respondWith(isShell(req, url) ? networkFirst(req, url) : cacheFirst(req, url));
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
