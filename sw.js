/* ============================================================
 * Service Worker — Cache First · 版本化
 * 策略：
 *   1. 首次安装时预缓存核心静态资源
 *   2. 后续请求：命中缓存 → 返回缓存，同时后台更新
 *   3. 网络请求（AI API）不拦截，让浏览器自己处理，离线自然失败由 ai.js 兜底
 * ============================================================ */

const CACHE_NAME = 'ryb-v12-20261103';
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/app.css',
  './js/storage.js',
  './js/ai.js',
  './js/schedule.js',
  './js/app.js',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET，跳过跨域（AI API、外部图片等）
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML 导航：Network First + 缓存降级（离线也能打开主页）
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // 其他静态资源：Cache First
  event.respondWith(
    caches.match(req).then((cached) => {
      return cached || fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
