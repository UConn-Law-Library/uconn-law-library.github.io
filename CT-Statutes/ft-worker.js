/* Full-text search worker for the CT General Statutes Explorer.
 *
 * The statute corpus is ~160 MB of JSON, far too much to hold in page memory
 * or scan on the main thread. Each search streams through the title files
 * here instead: fetch one, scan its sections, post any matches, and let the
 * parsed JSON be collected before the next file loads. Fetches go through
 * the service worker's cache-first data handler, so titles already viewed or
 * downloaded for offline use read from disk and anything else is fetched
 * once and cached as a side effect.
 *
 * Protocol (all messages carry the search's id):
 *   in:  { id, query, dataDir, files: [{key, file, label}], max }
 *   out: { id, done, total, rows: [...] }   after each title (rows may be [])
 *   out: { id, finished: true, found }      when the search completes
 * A message with a newer id abandons the running search between titles.
 */

"use strict";

importScripts("./search-query.js");

let latestId = 0;

self.onmessage = (ev) => {
  const req = ev.data;
  if (!req || typeof req.id !== "number") return;
  latestId = req.id;
  run(req).catch((err) => {
    if (req.id === latestId) {
      self.postMessage({ id: req.id, finished: true, found: 0, error: String(err?.message || err) });
    }
  });
};

async function run(req) {
  const ast = parseQuery(req.query);
  if (!ast) {
    self.postMessage({ id: req.id, finished: true, found: 0 });
    return;
  }
  const posTerms = collectPositive(ast);
  const total = req.files.length;
  let done = 0;
  let found = 0;

  for (const entry of req.files) {
    if (req.id !== latestId) return; // a newer search superseded this one
    let rows = [];
    try {
      const res = await fetch(req.dataDir + entry.file);
      if (res.ok) {
        const titleObj = await res.json();
        rows = scanTitleForQuery(titleObj, ast, posTerms, req.max - found);
      }
    } catch {
      // offline and not cached — skip; the page shows how many titles ran
    }
    if (req.id !== latestId) return;
    done++;
    found += rows.length;
    self.postMessage({ id: req.id, done, total, rows });
    if (found >= req.max) break;
  }
  self.postMessage({ id: req.id, finished: true, found });
}
