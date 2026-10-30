var VERSION = "v1";
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

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        return cache.addAll(SHELL_FILES);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
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

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            cache.put("index.html", copy);
          });
          return response;
        })
        .catch(function () {
          return caches.match("index.html");
        })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        var network = fetch(request)
          .then(function (response) {
            if (response && response.ok) {
              var copy = response.clone();
              caches.open(SHELL_CACHE).then(function (cache) {
                cache.put(request, copy);
              });
            }
            return response;
          })
          .catch(function () {
            return cached;
          });
        return cached || network;
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
