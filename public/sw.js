/**
 * Service Worker：只管「外壳」离线，不管照片
 *
 * 为什么不管照片：/media 是几十 GB 的原文件，/thumb 是按尺寸参数现算的，
 * 把它们塞进 CacheStorage 会把手机存储吃掉，而且素材一变索引就变了，
 * 缓存反而变成「看到的和磁盘上不一样」的麻烦来源。
 *
 * 为什么你可能见不到它生效：Service Worker 只在安全上下文注册，
 * 也就是 https 或者 localhost。局域网里用 http://192.168.x.x:8123 访问时
 * 浏览器会直接拒绝注册——这不是 bug，是规范。家里想装成 App，
 * iOS/Android 的「添加到主屏幕」靠的是 manifest + 图标，不需要 SW，一样能用。
 */

// 改了 SHELL 里任何一个文件（app.js / 首页样式）就抬一下这个号：
// 旧缓存是在 activate 里按名字删的，不抬号就有人长期拿到上一版 JS
// （首页是网络优先不会中招，app.js 是“先用缓存、后台补新的”会）
const VERSION = 'family-gallery-shell-v7';
const SHELL = [
  '/',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

// 这些前缀的请求一律不碰，直接走网络
const PASSTHROUGH = ['/api/', '/media/', '/thumb', '/anim', '/healthz'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      // 预缓存里只要有一个没拿到就整体失败：宁可没有离线，也不要半个外壳
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (PASSTHROUGH.some((p) => url.pathname.startsWith(p))) {
    return;
  }

  // 导航：先问网络，断了再拿缓存的首页顶上（本站是单页，首页就是全部）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/').then((hit) => hit || Response.error()))
    );
    return;
  }

  // 静态外壳：命中缓存就用，同时后台补一份新的；没命中就去网络
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => null);
      return hit || refresh || Response.error();
    })
  );
});
