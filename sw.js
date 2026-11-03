// مهم: غيّر رقم VERSION عند كل نشر لنسخة جديدة، فهذا ما يجعل المتصفحات تكتشف التحديث
// ويظهر زر "تحديث الآن" للمستخدمين.
var VERSION = "d594ffba39";
var SHELL_CACHE = "quran-radio-shell-" + VERSION;
var RUNTIME_CACHE = "quran-radio-runtime-" + VERSION;

var SHELL_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.webmanifest",
  "favicon.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png"
];

var STREAM_HOSTS = ["radiojar.com"];

function isStream(url) {
  return STREAM_HOSTS.some(function (host) {
    return url.hostname === host || url.hostname.endsWith("." + host);
  });
}

// لا نستدعي skipWaiting هنا: النسخة الجديدة تنتظر حتى يضغط المستخدم "تحديث الآن"
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(
        SHELL_FILES.map(function (file) {
          return new Request(file, { cache: "reload" });
        })
      );
    })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name !== SHELL_CACHE && name !== RUNTIME_CACHE;
            })
            .map(function (name) {
              return caches.delete(name);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  if (isStream(url)) return;
  if (request.headers.has("range")) return;

  // الملفات تُخدم من كاش النسخة الحالية فقط، فلا يحدث خلط بين نسخة قديمة وجديدة
  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match("index.html").then(function (cached) {
          return cached || fetch(request);
        });
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(request, { ignoreSearch: true }).then(function (cached) {
          return cached || fetch(request);
        });
      })
    );
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          var network = fetch(request)
            .then(function (response) {
              if (response && (response.ok || response.type === "opaque")) {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(function () {
              return cached;
            });
          return cached || network;
        });
      })
    );
  }
});
