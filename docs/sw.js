// Keep in sync with app.js's CORE_CACHE_NAME.
//
// Two separate caches on purpose. CORE_CACHE_NAME covers the small app shell
// (this file's own scripts/styles/manifest) and is bumped on every update, as
// before. ASSET_CACHE_NAME covers the question/document page images — up to
// several thousand files, tens to a hundred+ MB, fetched on demand or via
// "Download for offline use" — and is deliberately NOT bumped alongside the
// app version. It previously shared one version with the app shell, so
// activate()'s "delete anything not the current cache" cleanup silently
// wiped a user's entire offline download on every single app update,
// forcing a full multi-thousand-image re-fetch that may not even be
// possible if they're on a constrained or filtered connection by the time
// the update lands. Bump ASSET_CACHE_NAME only if the images themselves
// change in a way that requires invalidating old ones.
const CORE_CACHE_NAME = "physics-mcq-core-v27";
const ASSET_CACHE_NAME = "physics-mcq-assets-v1";

const CORE_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "answer-logger.css",
  "app.js",
  "answer-logger.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/questions.json",
  "data/documents.json",
  "asset-manifest.json",
];

function isAssetRequest(url) {
  return url.pathname.includes("/img/") || url.pathname.includes("/doc_img/");
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CORE_CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CORE_CACHE_NAME && name !== ASSET_CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) {
    return;
  }

  const cacheName = isAssetRequest(new URL(request.url)) ? ASSET_CACHE_NAME : CORE_CACHE_NAME;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(cacheName).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
