/* Retire the legacy CT Statutes offline app, including the /next/ reader.
 * Keep this file at its original URL so installed workers receive the update.
 * Cache Storage and localStorage share an origin with /CGS/: leave them intact.
 */
"use strict";

const DESTINATION = "https://uconn-law-library.github.io/CGS/";
const LEGACY_PATH = "/CT-Statutes/";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Future visits use the redirect HTML instead of an offline app shell.
    await self.registration.unregister();
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    // Never move CGS tabs or other apps hosted on this origin.
    await Promise.allSettled(windows.filter((client) => {
      const url = new URL(client.url);
      return url.origin === self.location.origin && url.pathname.startsWith(LEGACY_PATH);
    }).map((client) => client.navigate(DESTINATION)));
  })());
});
