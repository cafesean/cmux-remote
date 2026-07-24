// cmux-remote service worker.
// Shell `/` (index.html) is cache-first with background revalidate → instant boot (iOS kills backgrounded
// standalone apps, so every open is a cold relaunch; over a tunnel that meant seconds of blank).
// `/app.js` is NETWORK-FIRST so code changes land in a SINGLE reload — cache-first here made every deploy
// "one launch behind" (the query ?v= is ignored by cache matching), which looked like changes not taking.
// It falls back to cache only when offline. /api/* is never touched — grids/streams stay fully live.
const CACHE = 'cmux-shell-v3';
const SHELL = ['/', '/app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const putCache = (path, r) => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); } return r; };

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname === '/index.html' ? '/' : url.pathname;

  // app.js: network-first → the freshest code every reload; cache is only the offline fallback.
  if (path === '/app.js') {
    e.respondWith(
      fetch(new Request(path, { cache: 'no-store' }))
        .then((r) => putCache(path, r))
        .catch(() => caches.match(path).then((hit) => hit || new Response('offline', { status: 503 })))
    );
    return;
  }
  // shell '/': cache-first + background revalidate (instant boot; next launch picks up index.html changes).
  if (path !== '/') return;   // manifest, icons, sw.js itself, /api/*: straight to network
  const refresh = fetch(new Request('/', { cache: 'no-cache' })).then((r) => putCache('/', r)).catch(() => null);
  e.waitUntil(refresh.then(() => {}));
  e.respondWith(caches.match('/').then((hit) => hit || refresh.then((r) => r || new Response('offline', { status: 503 }))));
});
