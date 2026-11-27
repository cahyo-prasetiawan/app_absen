/* Service worker SiAbsen GURU.
   Tujuan: aplikasi dapat diinstal DAN tetap terbuka tanpa internet (tampilan aplikasi + pustaka CDN disimpan saat pertama
   kali dibuka online). Data absensi (Firestore, Google Drive, GPS) TIDAK dicegat di sini: data dikelola oleh cache
   Firestore di dalam aplikasi. Halaman memakai strategi "jaringan dulu" (batas 5 detik, lalu cache), sehingga pembaruan
   aplikasi langsung diterima guru saat online dan tetap terbuka saat sinyal buruk/offline. */
const CACHE = 'siabsen-shell-v4';
const CDN_CACHE = 'siabsen-cdn-v2';
const NET_TIMEOUT = 5000;
// Hanya pustaka statis ber-versi/tampilan. Firestore, Auth, Google Drive, dan peta TIDAK pernah disimpan.
const CDN_HOSTS = ['cdn.tailwindcss.com','cdnjs.cloudflare.com','unpkg.com','cdn.jsdelivr.net','www.gstatic.com','fonts.googleapis.com','fonts.gstatic.com'];
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
// Pustaka yang wajib tersedia agar aplikasi tampil dan berjalan saat offline pertama kali.
const CDN_PRECACHE = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  'https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging.js'
];
const OFFLINE_HTML = '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiAbsen GURU</title><style>body{font-family:system-ui,sans-serif;background:#eef2ff;color:#312e81;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}div{max-width:380px}h1{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.5;color:#475569}button{margin-top:16px;background:#312e81;color:#fff;border:0;border-radius:12px;padding:12px 20px;font-weight:700}</style></head><body><div><h1>Aplikasi belum tersimpan di perangkat ini</h1><p>Buka SiAbsen sekali saat ada internet agar tampilan aplikasi tersimpan. Setelah itu aplikasi dapat dibuka tanpa internet.</p><button onclick="location.reload()">Coba lagi</button></div></body></html>';

// Simpan satu berkas CDN beserta berkas turunannya (impor modul ES dan url() di CSS) agar benar-benar siap offline.
async function precacheCdn(cache, url, seen, depth) {
  if (seen.has(url) || depth > 4) return;
  seen.add(url);
  let res;
  try { res = await fetch(url); } catch (_) { try { res = await fetch(url, { mode: 'no-cors' }); } catch (__) { return; } }
  if (!res || !(res.ok || res.type === 'opaque')) return;
  try { await cache.put(url, res.clone()); } catch (_) {}
  if (res.type === 'opaque') return;
  const ct = res.headers.get('content-type') || '';
  const isJs = /javascript/.test(ct) && /firebasejs/.test(url);
  const isCss = /css/.test(ct);
  if (!isJs && !isCss) return;
  let text = ''; try { text = await res.clone().text(); } catch (_) { return; }
  const found = new Set();
  if (isJs) { const re = /(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g; let m; while ((m = re.exec(text))) found.add(new URL(m[1], url).href); }
  if (isCss) { const re = /url\(\s*["']?([^)"']+?)["']?\s*\)/g; let m; while ((m = re.exec(text))) { if (!/^data:/.test(m[1])) { try { found.add(new URL(m[1], url).href); } catch (_) {} } }
    // Hanya format woff2 (cukup untuk semua browser modern) agar ukuran cache kecil.
  }
  for (const u of found) { if (isCss && !/\.woff2(\?|$)|fonts\.gstatic\.com|\.(png|svg|gif)(\?|$)/.test(u)) continue; await precacheCdn(cache, u, seen, depth + 1); }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    const cdn = await caches.open(CDN_CACHE);
    const seen = new Set();
    await Promise.all(CDN_PRECACHE.map(u => precacheCdn(cdn, u, seen, 0).catch(() => {})));
  })());
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(r => { clearTimeout(t); resolve(r); }, err => { clearTimeout(t); reject(err); });
  });
}

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
  e.respondWith((async () => {
    const cached = () => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? (caches.match('./index.html').then(h => h || caches.match('./'))) : undefined));
    try {
      const res = await fetchWithTimeout(req, NET_TIMEOUT);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    } catch (_) {
      const hit = await cached();
      if (hit) return hit;
      if (req.mode === 'navigate') return new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

// Klik pada notifikasi pengingat: fokus ke jendela aplikasi yang sudah terbuka, atau buka baru.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  }));
});

// Push dari server (FCM, pesan data): tampilkan notifikasi walaupun aplikasi tertutup.
// Pengingat jam mengajar/rapat tidak ditampilkan dobel bila aplikasi sedang terbuka (sudah ditangani di dalam aplikasi).
self.addEventListener('push', event => {
  let raw = {};
  try { raw = event.data ? event.data.json() : {}; } catch (e) { try { raw = { data: { body: event.data.text() } }; } catch (_) {} }
  const d = Object.assign({}, raw.notification || {}, raw.data || {});
  const title = d.title || raw.title || 'Si-Absen GURU';
  const body = d.body || raw.body || '';
  const tag = d.tag || raw.tag || 'siabsen';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(c => c.visibilityState === 'visible') && /^siabsen-(soon|late|meet15)-/.test(tag)) return;
    await self.registration.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [200, 100, 200], data: { url: d.url || './' } });
  })());
});
