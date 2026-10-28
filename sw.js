/* Service worker SiAbsen GURU.
   Tujuan: membuat aplikasi bisa diinstal. Data absensi (Firebase/Firestore, Google Drive, GPS) TIDAK pernah
   disimpan atau dicegat di sini: hanya berkas milik situs sendiri yang di-cache sebagai cadangan.
   Halaman memakai strategi "jaringan dulu", jadi pembaruan aplikasi langsung diterima guru. */
const CACHE = 'siabsen-shell-v1';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // semua layanan luar (Firebase, Drive, CDN) lewat jaringan biasa
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./') : undefined)))
  );
});
