// 오프라인에서도 앱이 열리도록 앱 파일을 캐시 (데이터는 IndexedDB 에 있음)
const VERSION = 'godnote-v3';
const ASSETS = [
  './', 'index.html', 'style.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/drive.js', 'js/editor.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 앱 파일: 네트워크 우선(업데이트 바로 반영), 실패하면 캐시
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' }).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
