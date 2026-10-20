/* Service worker: оболочка приложения работает офлайн, API и аудио не кэшируются. */
const VERSION = 'v4';
const SHELL = `xminyc-shell-${VERSION}`;
const ASSETS = ['/css/style.css', '/css/fonts.css', '/js/i18n.js', '/js/i18n-extra.js', '/js/app.js', '/js/features.js',
  '/vendor/Tone.js', '/vendor/lame.min.js', '/logo.png', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || req.headers.has('range')) return; // сеть напрямую

  if (req.mode === 'navigate') { // страницы: сеть, при отсутствии — кэшированная оболочка
    e.respondWith(fetch(req).then((r) => { caches.open(SHELL).then((c) => c.put('/', r.clone())); return r; })
      .catch(() => caches.match('/').then((r) => r || new Response('Нет соединения', { status: 503 }))));
    return;
  }
  // статика: сначала кэш, параллельно обновляем (stale-while-revalidate)
  e.respondWith(caches.match(req).then((cached) => {
    const net = fetch(req).then((r) => { if (r.ok) caches.open(SHELL).then((c) => c.put(req, r.clone())); return r; }).catch(() => cached);
    return cached || net;
  }));
});