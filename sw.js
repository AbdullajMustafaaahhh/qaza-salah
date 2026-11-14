/* Offline support. Tries the network first (so updates arrive), falls back to the saved copy when offline. */
const CACHE = "qaza-salah-v4-1";
const FILES = ["./", "index.html", "styles.css", "core.js", "habits.js", "sync.js", "app.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png", "splash-1290x2796.png"];
self.addEventListener("install", e => {
  // each file on its own: if one is missing, the others are still saved
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
