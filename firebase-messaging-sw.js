// EMTP 學習系統 — Service Worker（階段二：FCM 推播 + PWA）
// 角色：①背景接收 FCM 推播（App 關著也跳通知）②設定 App 角標數字
//       ③點通知開啟對應頁面 ④維持 PWA 可安裝（fetch 純放行、不快取）
// 取代原 sw.js：三端 HTML 改註冊本檔。

importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCYRUG97mj3JRz6YNRuN_UdRzgZcC1y9YE",
  authDomain: "emtp-learning-system.firebaseapp.com",
  projectId: "emtp-learning-system",
  storageBucket: "emtp-learning-system.firebasestorage.app",
  messagingSenderId: "1057617665185",
  appId: "1:1057617665185:web:2d1902083fa21af0e7a4e0",
});

const messaging = firebase.messaging();

// 背景訊息：data-only → 自行顯示通知 + 設定角標
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || "EMTP";
  const options = {
    body: d.body || "",
    icon: d.icon || "icon-student-192.png",
    badge: "icon-student-192.png",
    data: { url: d.url || "/" },
    tag: d.tag || undefined,
    renotify: !!d.tag,
  };
  try {
    if (self.navigator.setAppBadge) {
      const c = parseInt(d.badge || "0", 10);
      if (c > 0) self.navigator.setAppBadge(c);
      else if (self.navigator.clearAppBadge) self.navigator.clearAppBadge();
    }
  } catch (e) {}
  return self.registration.showNotification(title, options);
});

// 點通知：聚焦既有視窗或開新視窗
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          if (w.navigate) {
            try { w.navigate(url); } catch (e) {}
          }
          return w.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── PWA：立即接管 + fetch 純放行（永遠走網路最新版，不破壞改版工作流）──
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
