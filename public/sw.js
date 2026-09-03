// cmux-remote service worker.
// Shell `/` (index.html) is cache-first with background revalidate → instant boot (iOS kills backgrounded
// standalone apps, so every open is a cold relaunch; over a tunnel that meant seconds of blank).
// `/app.js` is NETWORK-FIRST so code changes land in a SINGLE reload — cache-first here made every deploy
// "one launch behind" (the query ?v= is ignored by cache matching), which looked like changes not taking.
// It falls back to cache only when offline. /api/* is never touched — grids/streams stay fully live.
// Shell entries are BARE PATHNAMES — never `?v=`. The fetch branch below strips every request to
// `url.pathname` and cache-matches by that, so a query-bearing precache key would leave nothing the
// pathname fallback could find and the first offline load would 503. The versioned tags live in
// index.html alone, and they still bust caches because this CACHE version bumps with them.
// v17: app.js changed after the v16 shell shipped. Bump both the cache generation and the service
// worker registration URL so installed clients replace any older cache-first worker immediately.
const CACHE = 'cmux-shell-v17';
const SHELL = ['/', '/app.js', '/radar.js', '/inbox.js'];

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

  // app.js + radar.js + inbox.js: network-first → the freshest code every reload; cache is only the
  // offline fallback. Cache-first here made every deploy "one launch behind". Precaching a script
  // WITHOUT listing it here leaves the copy sitting unused in Cache Storage — this branch is the only
  // thing that ever reads it.
  if (path === '/app.js' || path === '/radar.js' || path === '/inbox.js') {
    e.respondWith(
      fetch(new Request(path, { cache: 'no-store' }))
        .then((r) => putCache(path, r))
        .catch(() => caches.match(path).then((hit) => hit || new Response('offline', { status: 503 })))
    );
    return;
  }
  // /vendor/*: cache-first, populated ON DEMAND. These are the Files viewer's renderers
  // (marked / DOMPurify / highlight.js, ~200KB) and only the Files tab ever loads them — putting
  // them in SHELL would make every install pay for bytes a terminal-only session never uses.
  // They are immutable in practice; an upgrade lands via the CACHE version bump above.
  if (path.startsWith('/vendor/')) {
    e.respondWith(
      caches.match(path).then((hit) => hit
        || fetch(e.request).then((r) => putCache(path, r))
        .catch(() => new Response('offline', { status: 503 })))
    );
    return;
  }
  // shell '/': cache-first + background revalidate (instant boot; next launch picks up index.html changes).
  if (path !== '/') return;   // manifest, icons, sw.js itself, /api/*: straight to network
  const refresh = fetch(new Request('/', { cache: 'no-cache' })).then((r) => putCache('/', r)).catch(() => null);
  e.waitUntil(refresh.then(() => {}));
  e.respondWith(caches.match('/').then((hit) => hit || refresh.then((r) => r || new Response('offline', { status: 503 }))));
});
