// cmux-remote service worker — instant boot for the iOS Home-Screen app.
// Cache-first for the app shell (/ and /app.js): every launch boots from the SW cache with ZERO
// network round trips (iOS kills backgrounded standalone apps, so every open is a cold relaunch —
// over a tunnel that meant seconds of blank). A background revalidate refreshes the cache so the
// NEXT launch picks up deploys. /api/* is never touched — grids/streams stay fully live.
const CACHE = 'cmux-shell-v1';
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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname === '/index.html' ? '/' : url.pathname;
  if (!SHELL.includes(path)) return;   // /api/*, sw.js itself, manifest, icons: straight to network

  const refresh = fetch(new Request(path, { cache: 'no-cache' }))
    .then((r) => {
      if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); }
      return r;
    })
    .catch(() => null);
  e.waitUntil(refresh.then(() => {}));
  e.respondWith(
    caches.match(path).then((hit) => hit || refresh.then((r) => r || new Response('offline', { status: 503 })))
  );
});
