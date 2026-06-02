// EMTP 學習系統 — Service Worker（階段一）
// 目的：讓 student/instructor/admin 三端可「加到主畫面」成為可安裝 PWA，
//       並為階段二（FCM 推播 + 關著時更新角標）預留掛載點。
// ⚠️ 刻意「不快取任何 HTML/JS」：保留有 fetch handler（滿足可安裝性條件），
//    但一律走網路最新版 → 不破壞「改 HTML → push → Ctrl+Shift+R 即生效」的工作流。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 純網路通過：不呼叫 respondWith → 瀏覽器照預設抓網路，永遠拿到最新檔案。
self.addEventListener('fetch', () => {
  return;
});

// ── 階段二（尚未啟用）：推播接收 + 點擊開啟 + 更新 App 角標 ──
// self.addEventListener('push', (event) => { ... navigator.setAppBadge / showNotification ... });
// self.addEventListener('notificationclick', (event) => { ... clients.openWindow ... });
