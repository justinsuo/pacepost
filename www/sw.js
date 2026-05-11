// Service worker for pacepost.
// - App shell: cache-first (same-origin assets bundled with the app)
// - Map tiles (CARTO basemaps): cache-first with size cap so the last viewed
//   regions stay available offline (mountains, etc.)
// - Other cross-origin (Leaflet CDN, Firebase SDK, weather, etc.):
//   stale-while-revalidate when possible, network-first fallback when not.

const APP_CACHE = "pacepost-app-v2-2026-05-10";
const TILE_CACHE = "pacepost-tiles-v1";
const VENDOR_CACHE = "pacepost-vendor-v1";
const TILE_MAX_ENTRIES = 1000;

const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./tracker.js",
  "./cloud.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./data/routes.json",
  "./data/workouts.json",
  "./data/achievements.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP_CACHE)
      .then((c) => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  const keep = new Set([APP_CACHE, TILE_CACHE, VENDOR_CACHE]);
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /basemaps\.cartocdn\.com|tile\.openstreetmap\.org|tiles\.stadiamaps\.com/.test(url.host);
}
function isVendorRequest(url) {
  return /unpkg\.com|cdn\.jsdelivr\.net|gstatic\.com\/firebasejs|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url.host);
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    const excess = keys.length - maxEntries;
    await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
  }
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // App shell (same origin): cache-first w/ network update
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then((res) => {
        if (res && res.status === 200) cache.put(e.request, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
    return;
  }

  // Map tiles: cache-first, size-capped
  if (isTileRequest(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(e.request);
      if (cached) return cached;
      try {
        const res = await fetch(e.request);
        if (res && res.status === 200) {
          cache.put(e.request, res.clone()).then(() => trimCache(TILE_CACHE, TILE_MAX_ENTRIES)).catch(() => {});
        }
        return res;
      } catch {
        // offline + uncached → return a transparent 1×1 PNG so the map still
        // works without a tile (rather than rendering broken-image squares).
        return new Response(
          Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhCwm1QAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)),
          { headers: { "Content-Type": "image/png" } }
        );
      }
    })());
    return;
  }

  // Vendor libraries (Leaflet, Firebase, fonts): stale-while-revalidate
  if (isVendorRequest(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then((res) => {
        if (res && res.status === 200) cache.put(e.request, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
    return;
  }

  // Other cross-origin (e.g., open-meteo weather): network-first
  e.respondWith(fetch(e.request).catch(() => new Response("", { status: 504 })));
});
