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
// v18: p17 sidebar — a new script and new shell markup. Bump both the cache generation and the
// service worker registration URL so installed clients replace any older worker immediately.
// v19: p18 capability gating in app.js (browser entry points hidden on tmux machines).
// v20: stuck drag / composer-focus state no longer freezes layout and pane drag for the page's life.
// v21: the composer wraps in a narrow pane (index.html CSS only).
// v22: Fit width / Fixed size font mode toggle in the settings popover (new index.html markup).
// v23: pane history retries until answered, parks rows while scrolled up; cmux-version note on "live".
// v24: p20 — radar/inbox/refresh off the toolbar; push + notificationclick handlers (phone alerts).
// v25: p21 — always-on key bar (status + quick keys) above the input; ⌨ toggle removed.
// v26: p22 — quick keys show only while the text box has focus.
// v27: p25 — in-app chime toggle in ⚙; push alerts explicitly not silent.
// v28: p26 — push receipts (/__lastpush) + ⚙ Send test; p27 Chrome remote-debugging prompt banner.
const CACHE = 'cmux-shell-v36';
const SHELL = ['/', '/app.js', '/sidebar.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'cmux-push-log').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const putCache = (path, r) => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); } return r; };

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname === '/index.html' ? '/' : url.pathname;

  // app.js + sidebar.js: network-first → the freshest code every reload; cache is only the
  // offline fallback. Cache-first here made every deploy "one launch behind". Precaching a script
  // WITHOUT listing it here leaves the copy sitting unused in Cache Storage — this branch is the only
  // thing that ever reads it.
  if (path === '/app.js' || path === '/sidebar.js') {
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

// ---- p20 phone alerts ---------------------------------------------------------------------
// The server sends {title, body, tag, machine, surface}. iOS revokes a subscription whose pushes
// do not show a notification, so every push shows one — even while the app is open.
// p26: every push is recorded on the device (Cache Storage, /__lastpush) BEFORE it is shown, and the
// show result too, so ⚙ can say whether this phone received the last alert and whether iOS displayed
// it — the only way to tell "never arrived" from "arrived but muted" without a Mac in hand.
const recordPush = (rec) => caches.open('cmux-push-log')
  .then((c) => c.put('/__lastpush', new Response(JSON.stringify(rec), { headers: { 'content-type': 'application/json' } })))
  .catch(() => {});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const rec = { at: Date.now(), title: d.title || '', shown: null, error: null };
  e.waitUntil(recordPush(rec).then(() => self.registration.showNotification(d.title || 'cmux-remote', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    silent: false,   // p25: every alert sounds (done and needs-you); iOS plays its default sound
    icon: '/icon-180.png',
    badge: '/icon-180.png',
    data: { machine: d.machine || null, surface: d.surface || null },
  })).then(() => { rec.shown = true; }, (err) => { rec.shown = false; rec.error = String((err && err.message) || err); })
    .then(() => recordPush(rec))
    .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .then((wins) => { for (const w of wins) w.postMessage({ type: 'cmux-push', rec }); }));
});

// Tap → open (or focus) the app on that pane. An open window gets a message; a cold start gets
// the target in the hash, which app.js reads once the tree has loaded.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const t = (e.notification && e.notification.data) || {};
  const hash = t.machine && t.surface ? '#jump=' + encodeURIComponent(t.machine + '|' + t.surface) : '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins[0];
    if (w) {
      if (hash) w.postMessage({ type: 'cmux-jump', machine: t.machine, surface: t.surface });
      return w.focus();
    }
    return self.clients.openWindow('/' + hash);
  }));
});
