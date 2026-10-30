/* Service worker SiAbsen GURU.
   Tujuan: membuat aplikasi bisa diinstal. Data absensi (Firebase/Firestore, Google Drive, GPS) TIDAK pernah
   disimpan atau dicegat di sini: hanya berkas milik situs sendiri yang di-cache sebagai cadangan.
   Halaman memakai strategi "jaringan dulu", jadi pembaruan aplikasi langsung diterima guru. */
const CACHE = 'siabsen-shell-v2';
const CDN_CACHE = 'siabsen-cdn-v1';
// Hanya pustaka statis ber-versi/tampilan. Firestore, Auth, Google Drive, dan peta TIDAK pernah disimpan.
const CDN_HOSTS = ['cdn.tailwindcss.com','cdnjs.cloudflare.com','unpkg.com','cdn.jsdelivr.net','www.gstatic.com','fonts.googleapis.com','fonts.gstatic.com'];
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Pustaka CDN: sajikan dari cache bila ada, perbarui di latar belakang.
    if (!CDN_HOSTS.includes(url.hostname) || (url.hostname === 'www.gstatic.com' && !url.pathname.startsWith('/firebasejs/'))) return;
    e.respondWith(caches.open(CDN_CACHE).then(cache => cache.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {}); return res; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./') : undefined)))
  );
});

// Klik pada notifikasi pengingat: fokus ke jendela aplikasi yang sudah terbuka, atau buka baru.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  }));
});
