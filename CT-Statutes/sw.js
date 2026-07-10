/* Service worker for CT General Statutes Explorer.
 *
 * Shell (HTML/CSS/JS): network-first so deploys take effect on reload,
 * falling back to cache when offline.
 * Data (./data/*.json):  cache-first — statute text rarely changes; the app's
 * "Re-download data" button clears DATA_CACHE to force a refresh.
 */

"use strict";

const SHELL_CACHE = "cgs-shell-v5";
const DATA_CACHE = "cgs-data-v1"; // must match app.js
const META_CACHE = "cgs-meta-v1"; // shared with next/sw.js

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./search-query.js",
  "./ft-worker.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./wordmark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        // Cache Storage is origin-wide. Only remove this app's old shell
        // caches; cgsr-* belongs to the /next/ reader and cgs-data/meta are
        // intentionally shared by both apps.
        keys.filter((k) => k.startsWith("cgs-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    throw err;
  }
}

function withVersionSource(response, source) {
  const headers = new Headers(response.headers);
  headers.set("X-CGS-Version-Source", source);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function parsedVersion(response) {
  try {
    return (await response.clone().json()).version || null;
  } catch {
    return null;
  }
}

// version.json is always checked online first. When its deterministic hash
// changes, discard the shared legal-data cache before the page requests any
// master or title JSON. Offline launches fall back to the last manifest and
// keep their stored corpus intact.
async function versionFirst(request) {
  const cache = await caches.open(META_CACHE);
  const url = new URL(request.url);
  const cacheKey = new Request(url.origin + url.pathname);
  const previous = await cache.match(cacheKey);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (!response.ok) return response;
    const [oldVersion, newVersion] = await Promise.all([
      previous ? parsedVersion(previous) : null,
      parsedVersion(response),
    ]);
    if (newVersion && oldVersion !== newVersion) await caches.delete(DATA_CACHE);
    await cache.put(cacheKey, response.clone());
    return withVersionSource(response, "network");
  } catch (err) {
    if (previous) return withVersionSource(previous, "cache");
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  if (url.pathname.endsWith("/data/version.json")) {
    event.respondWith(versionFirst(request));
  } else if (url.pathname.includes("/data/")) {
    event.respondWith(cacheFirst(request, DATA_CACHE));
  } else {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});
