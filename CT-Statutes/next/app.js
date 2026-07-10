/* CGS Reader — a reading-first re-imagining of the CT General Statutes explorer.
 *
 * Same data files as the original app (../data/), entirely new presentation:
 *  - continuous chapter reader with scroll-synced outline and URL
 *  - statute text parsed into a structured subsection hierarchy
 *  - one unified instant search across statutes, index topics, and infractions
 */

"use strict";

// -----------------------------
// CONFIG / STORAGE
// -----------------------------
const APP_VERSION = "1.0.2";
const APP_YEAR = 2026;

const DATA_DIR = "../data/";
const MASTER_URL = DATA_DIR + "titles_index.json";
const INFRACTIONS_URL = DATA_DIR + "infractions.json";
const STAT_INDEX_URL = DATA_DIR + "statutes_index.json";
const SEARCH_INDEX_URL = DATA_DIR + "search_index.json";
const DATA_VERSION_URL = DATA_DIR + "version.json";
const DATA_CACHE = "cgs-data-v1"; // shared with the original app
const DATA_VERSION_KEY = "cgs:data-version:v1";

const THEME_KEY = "cgsr:theme";       // "light" | "dark" pins a theme; unset follows the system
const TEXT_SIZE_KEY = "cgsr:textsize"; // font scale factor; unset = 1
const DENSITY_KEY = "cgsr:density";    // "compact"; unset = comfortable
const TEXT_SIZES = [0.85, 0.925, 1, 1.075, 1.15, 1.25, 1.4];
const BM_KEY = "cgsr:bookmarks";
const RC_KEY = "cgsr:recents";
const RECENT_MAX = 12;
const TITLE_CACHE_MAX = 12;         // parsed titles kept in memory (LRU)
const FT_MAX_RESULTS = 300;

function loadJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { } }

// -----------------------------
// STATE
// -----------------------------
const S = {
  master: null,
  titles: [],
  titleByKey: new Map(),

  titleCache: new Map(),            // title_key -> parsed title JSON (LRU)
  titleLoading: new Map(),          // title_key -> Promise
  registered: new Set(),            // title_keys whose sections are in the nav rows
  secLoc: new Map(),                // section_key -> {tk, ck}
  navSecRows: [],                   // {key,label,tk,ck} for every section seen so far
  navChRows: [],                    // {ck,label,name,tk}

  inf: null,
  infCats: [],                      // [{name, slug, count}]
  infBySec: new Map(),              // section_key -> [entry,...]

  idx: null,                        // statutes_index.json (lazy)
  idxPromise: null,
  idxBySlug: new Map(),
  idxLetters: new Map(),
  idxByRef: new Map(),              // section_key -> Set of headings citing it

  incoming: null,                   // incoming_refs.json targets map (lazy)
  incomingPromise: null,

  route: null,
  renderToken: 0,
  bookmarks: loadJSON(BM_KEY, []),
  recents: loadJSON(RC_KEY, []),

  spyKey: null,
  ft: { running: false, cancel: false },
};

// -----------------------------
// DOM / HELPERS
// -----------------------------
const $ = (id) => document.getElementById(id);
const readerEl = $("reader");
const sidenavEl = $("sidenav");
const outlineEl = $("outline");
const qEl = $("q");
const omniPanel = $("omniPanel");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function debounce(fn, ms = 150) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function fmtMoney(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function tokenize(q) { return q.toLowerCase().split(/\s+/).filter(Boolean); }
function matches(hay, terms) { const h = hay.toLowerCase(); return terms.every((t) => h.includes(t)); }
function highlightTerms(escaped, terms) {
  if (!terms.length) return escaped;
  const re = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
  return escaped.replace(re, "<mark>$1</mark>");
}

// "14-296aa" -> master title key "14"; "2c-5" -> "02c"
function titleKeyForSection(sk) {
  const m = /^(\d+)([a-z]*)-/.exec(String(sk));
  if (!m) return null;
  const k = m[1].padStart(2, "0") + m[2];
  if (S.titleByKey.has(k)) return k;
  return S.titleByKey.has(m[1] + m[2]) ? m[1] + m[2] : null;
}

// split "Sec. 14-296aa. Use of hand-held..." into number + caption
function splitLabel(label) {
  const m = /^Sec\.\s*([\w-]+)\.\s*(.*)$/s.exec(label || "");
  if (m) return { num: "Sec. " + m[1] + ".", cap: m[2] };
  return { num: "", cap: label || "" };
}


// -----------------------------
// HASH HELPERS
// -----------------------------
const H = {
  home: () => "#/",
  title: (t) => `#/t/${encodeURIComponent(t)}`,
  chapter: (t, c) => `#/t/${encodeURIComponent(t)}/c/${encodeURIComponent(c)}`,
  section: (t, c, s) => `#/t/${encodeURIComponent(t)}/c/${encodeURIComponent(c)}/s/${encodeURIComponent(s)}`,
  sub: (t, c, s, path) => `${H.section(t, c, s)}/p/${encodeURIComponent(path)}`,
  resolve: (s) => `#/s/${encodeURIComponent(s)}`,
  search: (q) => `#/q/${encodeURIComponent(q)}`,
  fulltext: (q) => `#/ft/${encodeURIComponent(q)}`,
  ix: () => "#/ix",
  ixLetter: (l) => `#/ix/l/${encodeURIComponent(l)}`,
  ixHeading: (slug) => `#/ix/h/${encodeURIComponent(slug)}`,
  inf: () => "#/inf",
  infCat: (slug) => `#/inf/c/${encodeURIComponent(slug)}`,
  bm: () => "#/bm",
  about: () => "#/about",
};

function parseHash() {
  const parts = (location.hash || "#/").replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const r = { area: "home" };
  if (!parts.length) return r;
  switch (parts[0]) {
    case "t":
      r.area = "browse"; r.tk = parts[1];
      if (parts[2] === "c") r.ck = parts[3];
      if (parts[4] === "s") r.sk = parts[5];
      if (parts[6] === "p") r.sub = parts[7];
      return r;
    case "s": r.area = "resolve"; r.sk = parts[1]; return r;
    case "q": r.area = "search"; r.q = parts.slice(1).join("/"); return r;
    case "ft": r.area = "fulltext"; r.q = parts.slice(1).join("/"); return r;
    case "ix":
      r.area = "ix";
      if (parts[1] === "l") r.letter = (parts[2] || "").toUpperCase();
      if (parts[1] === "h") r.slug = parts[2];
      return r;
    case "inf":
      r.area = "inf";
      if (parts[1] === "c") r.cat = parts[2];
      return r;
    case "bm": r.area = "bm"; return r;
    case "about": r.area = "about"; return r;
  }
  return r;
}

// -----------------------------
// DATA LOADING
// -----------------------------
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function ensureCurrentDataVersion() {
  try {
    const res = await fetch(`${DATA_VERSION_URL}?check=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const manifest = await res.json();
    if (!manifest?.version) return;
    const previous = localStorage.getItem(DATA_VERSION_KEY);
    const authoritative = res.headers.get("X-CGS-Version-Source") !== "cache";
    if (!IS_PACKAGED_APP && authoritative && previous !== manifest.version && "caches" in window) {
      await caches.delete(DATA_CACHE);
    }
    localStorage.setItem(DATA_VERSION_KEY, manifest.version);
  } catch {
    // Preserve the currently stored corpus when offline.
  }
}

function registerTitle(t) {
  if (S.registered.has(t.title_key)) return;
  S.registered.add(t.title_key);
  for (const ch of t.chapters || []) {
    S.navChRows.push({ ck: ch.chapter_key, label: ch.label, name: ch.name || "", tk: t.title_key });
    for (const sec of ch.sections || []) {
      if (!S.secLoc.has(sec.section_key)) S.secLoc.set(sec.section_key, { tk: t.title_key, ck: ch.chapter_key });
      S.navSecRows.push({ key: sec.section_key, label: sec.label || "", tk: t.title_key, ck: ch.chapter_key });
    }
  }
}

async function loadTitle(tk) {
  if (S.titleCache.has(tk)) {
    const t = S.titleCache.get(tk);
    S.titleCache.delete(tk); S.titleCache.set(tk, t);   // LRU touch
    return t;
  }
  if (S.titleLoading.has(tk)) return S.titleLoading.get(tk);
  const entry = S.titleByKey.get(tk);
  if (!entry) throw new Error("Unknown title " + tk);
  const p = fetchJSON(DATA_DIR + entry.file).then((t) => {
    registerTitle(t);
    S.titleCache.set(tk, t);
    while (S.titleCache.size > TITLE_CACHE_MAX) {
      const oldest = S.titleCache.keys().next().value;
      if (oldest === tk) break;
      S.titleCache.delete(oldest);
    }
    S.titleLoading.delete(tk);
    return t;
  }).catch((e) => { S.titleLoading.delete(tk); throw e; });
  S.titleLoading.set(tk, p);
  return p;
}

function loadIndexLazy() {
  if (S.idxPromise) return S.idxPromise;
  S.idxPromise = fetchJSON(STAT_INDEX_URL).then((idx) => {
    S.idx = idx;
    for (const h of idx.headings || []) {
      let slug = slugify(h.h) || "h";
      while (S.idxBySlug.has(slug)) slug += "-2";
      h.slug = slug;
      S.idxBySlug.set(slug, h);
      const L = (h.h[0] || "#").toUpperCase();
      if (!S.idxLetters.has(L)) S.idxLetters.set(L, []);
      S.idxLetters.get(L).push(h);
      for (const it of h.items || []) {
        for (const [, key] of it.r || []) {
          if (!key) continue;
          if (!S.idxByRef.has(key)) S.idxByRef.set(key, new Set());
          S.idxByRef.get(key).add(h);
        }
      }
    }
    return idx;
  });
  return S.idxPromise;
}

function loadIncomingLazy() {
  if (S.incomingPromise) return S.incomingPromise;
  S.incomingPromise = fetchJSON("./incoming_refs.json").then((d) => {
    S.incoming = d.targets || {};
    updateCiteChips();
    return S.incoming;
  }).catch(() => { S.incoming = {}; return S.incoming; });
  return S.incomingPromise;
}

// once the reverse-citation map arrives, fill in counts on any rendered chips
function updateCiteChips() {
  if (!S.incoming) return;
  document.querySelectorAll("article.sec [data-act='cites']").forEach((btn) => {
    const key = btn.closest("article.sec")?.dataset.key;
    const n = (S.incoming[key] || []).length;
    btn.textContent = n ? `Cited by (${n})` : "Cited by";
  });
}

async function boot() {
  await ensureCurrentDataVersion();
  const [master, searchIndex] = await Promise.all([
    fetchJSON(MASTER_URL),
    fetchJSON(SEARCH_INDEX_URL),
  ]);
  S.master = master;
  S.titles = S.master.titles || [];
  for (const t of S.titles) S.titleByKey.set(t.title_key, t);
  S.navChRows = (searchIndex.chapters || []).map((c) => ({
    ck: c.c, label: c.l, name: c.n || "", tk: c.t,
  }));
  S.navSecRows = (searchIndex.sections || []).map((s) => ({
    key: s.s, label: s.l || "", tk: s.t, ck: s.c,
  }));
  for (const s of S.navSecRows) {
    if (!S.secLoc.has(s.key)) S.secLoc.set(s.key, { tk: s.tk, ck: s.ck });
  }
  for (const t of S.titles) S.registered.add(t.title_key);
  checkOfflineStored();

  fetchJSON(INFRACTIONS_URL).then((inf) => {
    S.inf = inf;
    const cats = new Map();
    for (const e of inf.entries || []) {
      const c = e.category || "Other";
      cats.set(c, (cats.get(c) || 0) + 1);
      if (e.section_key) {
        if (!S.infBySec.has(e.section_key)) S.infBySec.set(e.section_key, []);
        S.infBySec.get(e.section_key).push(e);
      }
    }
    S.infCats = [...cats.entries()].map(([name, count]) => ({ name, count, slug: slugify(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (S.route && (S.route.area === "inf" || S.route.area === "home")) render();
  }).catch(() => { });

  // subject index is 14 MB — start it in the background after first paint
  setTimeout(() => { loadIndexLazy().then(() => { if (S.route?.area === "ix") render(); }); }, 900);
  setTimeout(loadIncomingLazy, 1400);
  setTimeout(backgroundOfflineDownload, 2500);

  window.addEventListener("hashchange", onHashChange);
  render();
}

// -----------------------------
// SUBSECTION STRUCTURE PARSER
// -----------------------------
// CT statutes nest as (a) -> (1) -> (A) -> (i) -> (I). Markers arrive flattened
// at the start of paragraphs; we rebuild indentation from them.
const ORDER = { la: 1, n: 2, ua: 3, lr: 4, ur: 5 };
const ROMAN_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function romanVal(t) {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const a = v[t[i]] || 0, b = v[t[i + 1]] || 0;
    n += a < b ? -a : a;
  }
  return n;
}
function nextAlpha(t) {
  // a -> b, z -> aa, aa -> bb (CT doubles letters after z)
  if (!/^([a-z])\1*$/i.test(t)) return null;
  const ch = t[0].toLowerCase();
  if (ch === "z") return "a".repeat(t.length + 1);
  return String.fromCharCode(ch.charCodeAt(0) + 1).repeat(t.length);
}
function validToken(tok) {
  if (/^\d{1,3}$/.test(tok)) return true;
  if (/^[a-z]{1,2}$/.test(tok) || /^[A-Z]{1,2}$/.test(tok)) return true;
  return tok.length <= 4 && ROMAN_RE.test(tok.toLowerCase()) && /^[a-zA-Z]+$/.test(tok);
}
function classify(tok, stack) {
  if (/^\d+$/.test(tok)) return "n";
  const lower = tok === tok.toLowerCase();
  const t = tok.toLowerCase();
  const alpha = lower ? "la" : "ua";
  const roman = lower ? "lr" : "ur";
  if (!ROMAN_RE.test(t)) return alpha;
  // roman-shaped token (i, v, x, ii, iv, ...): prefer continuing an open list
  for (const f of stack) if (f.type === roman && romanVal(t) === romanVal(f.last.toLowerCase()) + 1) return roman;
  for (const f of stack) if (f.type === alpha && nextAlpha(f.last) === t) return alpha;
  if (t === "i") {
    const top = stack[stack.length - 1];
    if (top && ORDER[top.type] === ORDER[roman] - 1) return roman;
  }
  return alpha;
}
function applyMarker(tok, stack) {
  const type = classify(tok, stack);
  while (stack.length && ORDER[stack[stack.length - 1].type] > ORDER[type]) stack.pop();
  const top = stack[stack.length - 1];
  if (top && top.type === type) top.last = tok;
  else stack.push({ type, last: tok });
  return stack.length;
}
function structureParagraphs(paras) {
  const stack = [];
  const out = [];
  for (const p of paras) {
    const m = /^\s*((?:\([0-9a-zA-Z]{1,4}\)\s*)+)/.exec(p);
    if (!m) { out.push({ depth: 0, markers: [], path: [], text: p }); continue; }
    const toks = [...m[1].matchAll(/\(([0-9a-zA-Z]{1,4})\)/g)].map((x) => x[1]);
    if (!toks.every(validToken)) { out.push({ depth: 0, markers: [], path: [], text: p }); continue; }
    let depth = 0;
    const markers = [];
    toks.forEach((tok, i) => {
      const d = applyMarker(tok, stack);
      if (i === 0) depth = d;
      // each marker knows its own subsection path, e.g. (b) -> "b", (1) -> "b.1"
      markers.push({ tok, path: stack.map((f) => f.last).join(".") });
    });
    out.push({ depth, markers, path: stack.map((f) => f.last), text: p.slice(m[0].length) });
  }
  return out;
}

// -----------------------------
// CITATION AUTOLINKS
// -----------------------------
function linkifyCitations(escapedHtml, selfKey) {
  // second dash segment covers UCC-style keys like 42a-1-201
  return escapedHtml.replace(/\b(\d{1,3}[a-z]{0,2}-\d+[a-z]{0,3}(?:-\d+[a-z]{0,3})?)\b/g, (m, key, off, str) => {
    const before = str.slice(Math.max(0, off - 18), off);
    if (/(P\.A\.|S\.A\.|No\.)\s*$/i.test(before)) return m;           // public/special acts
    if (/\b(19|20)\d{2},?\s*$/.test(before)) return m;                // "1961, 573"-style
    const after = str.slice(off + m.length, off + m.length + 8);
    if (/^,\s*S\.\s/.test(after)) return m;                           // "05-220, S. 2" act lists
    if (key === selfKey) return m;
    if (!titleKeyForSection(key)) return m;
    return `<a class="xref" href="${H.resolve(key)}" title="Go to section ${key}">${m}</a>`;
  });
}

// -----------------------------
// BODY RENDERING (paragraphs, anchors, definition groups)
// -----------------------------
const DEF_RE = /^\s*["“]([^"”]{1,80})["”]/;   // paragraph opens with a quoted term

function paraHtml(r, sec, tk, ck) {
  const mks = r.markers.map((m) =>
    `<a class="mk" href="${H.sub(tk, ck, sec.section_key, m.path)}" title="Link to Sec. ${esc(sec.section_key)}(${esc(m.tok)})">(${esc(m.tok)})</a>`).join("");
  const anchor = r.markers.length ? ` data-path="${esc(r.path.join("."))}"` : "";
  return `<p class="stx" style="--d:${Math.min(r.depth, 6)}"${anchor}>${mks}${mks ? " " : ""}${linkifyCitations(esc(r.text), sec.section_key)}</p>`;
}

// Collapse runs of 3+ same-depth paragraphs that each define a quoted term
// (deeper paragraphs in between belong to the definition above them).
function groupDefinitions(rows) {
  const blocks = [];
  const pushPlain = (r) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "plain") last.rows.push(r);
    else blocks.push({ kind: "plain", rows: [r] });
  };
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    const isDef = r.markers.length && DEF_RE.test(r.text);
    if (!isDef) { pushPlain(r); i++; continue; }
    const d = r.depth;
    const grp = [r];
    const terms = [DEF_RE.exec(r.text)[1]];
    let j = i + 1;
    while (j < rows.length) {
      const n = rows[j];
      if (n.markers.length && n.depth > d) { grp.push(n); j++; continue; }
      if (n.markers.length && n.depth === d && DEF_RE.test(n.text)) {
        grp.push(n); terms.push(DEF_RE.exec(n.text)[1]); j++; continue;
      }
      break;
    }
    if (terms.length >= 3) blocks.push({ kind: "defs", rows: grp, terms });
    else grp.forEach(pushPlain);
    i = j;
  }
  return blocks;
}

function defGroupHtml(b, sec, tk, ck) {
  const shown = b.terms.slice(0, 4).map((t) => `“${esc(t)}”`).join(" · ");
  return `<div class="defgroup">
    <button class="defgroup-toggle" data-deftoggle aria-expanded="false">
      <span class="dg-arrow" aria-hidden="true">▸</span>
      <b>${b.terms.length} definitions</b>
      <span class="dg-terms">${shown}${b.terms.length > 4 ? " · …" : ""}</span>
    </button>
    <div class="defgroup-body" hidden>${b.rows.map((r) => paraHtml(r, sec, tk, ck)).join("")}</div>
  </div>`;
}

function renderBodyBlocks(rows, sec, tk, ck) {
  return groupDefinitions(rows).map((b) =>
    b.kind === "defs"
      ? defGroupHtml(b, sec, tk, ck)
      : b.rows.map((r) => paraHtml(r, sec, tk, ck)).join("")
  ).join("");
}

// -----------------------------
// BOOKMARKS / RECENTS
// -----------------------------
function isBookmarked(key) { return S.bookmarks.some((b) => b.key === key); }
function toggleBookmark(rec) {
  const i = S.bookmarks.findIndex((b) => b.key === rec.key);
  if (i >= 0) S.bookmarks.splice(i, 1);
  else S.bookmarks.unshift({ ...rec, when: Date.now() });
  saveJSON(BM_KEY, S.bookmarks);
  updateBmBadge();
}
function updateBmBadge() {
  const el = $("bmBadge");
  el.hidden = !S.bookmarks.length;
  el.textContent = S.bookmarks.length;
}
function addRecent(rec) {
  S.recents = S.recents.filter((r) => r.key !== rec.key);
  S.recents.unshift({ ...rec, when: Date.now() });
  S.recents = S.recents.slice(0, RECENT_MAX);
  saveJSON(RC_KEY, S.recents);
}

// -----------------------------
// ROUTER
// -----------------------------
function onHashChange() {
  const next = parseHash();
  const cur = S.route;
  // same chapter, different section — just scroll, don't rebuild the reader
  if (cur && next.area === "browse" && cur.area === "browse" &&
    next.tk === cur.tk && next.ck === cur.ck && next.ck && next.sk) {
    S.route = next;
    scrollToSection(next.sk, false, next.sub || null);
    return;
  }
  render();
}

async function render() {
  S.route = parseHash();
  const token = ++S.renderToken;
  const r = S.route;

  document.body.classList.remove("nav-open");
  $("menuBtn").setAttribute("aria-expanded", "false");
  $("scrim").hidden = true;
  S.ft.cancel = true;
  stopSpy();                 // the old view's scroll listener must not see the rebuild
  setOutlineOpen(false);
  $("outlineFab").hidden = true;
  outlineEl.hidden = true;
  outlineEl.innerHTML = "";
  markQuickNav(r);

  try {
    if (r.area === "home") return viewHome(token);
    if (r.area === "browse" && r.tk && r.ck) return await viewChapter(token, r.tk, r.ck, r.sk, r.sub);
    if (r.area === "browse" && r.tk) return await viewTitle(token, r.tk);
    if (r.area === "browse") return viewHome(token);
    if (r.area === "resolve") return await viewResolve(token, r.sk);
    if (r.area === "search") return await viewSearch(token, r.q || "");
    if (r.area === "fulltext") return await viewFulltext(token, r.q || "");
    if (r.area === "ix") return await viewIndex(token, r);
    if (r.area === "inf") return viewInfractions(token, r);
    if (r.area === "bm") return viewBookmarks(token);
    if (r.area === "about") return viewAbout(token);
    viewHome(token);
  } catch (e) {
    if (token !== S.renderToken) return;
    readerEl.innerHTML = `<div class="notice">Could not load this page: ${esc(e.message)}.
      Make sure the site is served over HTTP and the <code>data/</code> folder is present.</div>`;
  }
}

function markQuickNav(r) {
  const map = { home: "home", browse: "home", resolve: "home", search: "home", fulltext: "home", ix: "ix", inf: "inf", bm: "bm" };
  const area = map[r.area] || "home";
  document.querySelectorAll(".quick-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.area === area);
  });
}

function loadingHtml(msg) {
  return `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;
}

// -----------------------------
// SIDENAV BUILDERS
// -----------------------------
function sidenavTitles(activeTk) {
  const rows = S.titles.map((t) => `
    <a class="nav-item ${t.title_key === activeTk ? "active" : ""}" href="${H.title(t.title_key)}">
      <span class="ni-key">${esc(t.label.replace("Title ", ""))}</span>${esc(t.name || "")}
    </a>`).join("");
  sidenavEl.innerHTML = `
    <div class="nav-head">Titles</div>
    <input class="nav-filter" id="navFilter" type="search" placeholder="Filter titles…" aria-label="Filter titles" />
    <div id="navList">${rows}</div>`;
  wireNavFilter();
}

function sidenavChapters(t, activeCk) {
  const rows = (t.chapters || []).map((c) => `
    <a class="nav-item ${c.chapter_key === activeCk ? "active" : ""}" href="${H.chapter(t.title_key, c.chapter_key)}">
      <span class="ni-key">${esc(c.chapter_key)}</span>${esc(c.name || c.label)}
      <span class="ni-count">${(c.sections || []).length}</span>
    </a>`).join("");
  sidenavEl.innerHTML = `
    <a class="nav-back" href="#/">← All titles</a>
    <div class="nav-title">${esc(t.label)} — ${esc(t.name || "")}</div>
    <div class="nav-head">Chapters</div>
    <input class="nav-filter" id="navFilter" type="search" placeholder="Filter chapters…" aria-label="Filter chapters" />
    <div id="navList">${rows}</div>`;
  wireNavFilter();
  const act = sidenavEl.querySelector(".nav-item.active");
  if (act) act.scrollIntoView({ block: "center" });
}

function wireNavFilter() {
  const filter = $("navFilter");
  if (!filter) return;
  filter.addEventListener("input", () => {
    const terms = tokenize(filter.value);
    sidenavEl.querySelectorAll("#navList .nav-item").forEach((el) => {
      el.style.display = !terms.length || matches(el.textContent, terms) ? "" : "none";
    });
  });
}

function lettersHtml(active) {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) =>
    `<a href="${H.ixLetter(l)}" class="${l === active ? "active" : ""}">${l}</a>`).join("");
}

function sidenavLetters(active) {
  sidenavEl.innerHTML = `
    <a class="nav-back" href="#/">← Home</a>
    <div class="nav-head">Subject index</div>
    <div class="letters">${lettersHtml(active)}</div>`;
}

// on narrow layouts the sidebar lives in a drawer, so index pages repeat the
// A–Z grid inline (hidden on wide screens via .letters-inline)
function lettersInlineHtml(active) {
  return `<div class="letters letters-inline" aria-label="Index letters">${lettersHtml(active)}</div>`;
}

function sidenavInfCats(active) {
  const rows = S.infCats.map((c) => `
    <a class="nav-item ${c.slug === active ? "active" : ""}" href="${H.infCat(c.slug)}">
      ${esc(titleCase(c.name))}<span class="ni-count">${c.count}</span>
    </a>`).join("");
  sidenavEl.innerHTML = `
    <a class="nav-back" href="#/">← Home</a>
    <div class="nav-head">Infraction categories</div>
    ${rows || `<div class="muted small" style="padding:8px">Loading…</div>`}`;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// -----------------------------
// VIEW: HOME
// -----------------------------
function viewHome(token) {
  sidenavTitles(null);
  const recents = S.recents.slice(0, 5).map(rowItemHtml).join("");
  const bms = S.bookmarks.slice(0, 5).map(rowItemHtml).join("");
  const titleCards = S.titles.map((t) => `
    <a class="row-item" href="${H.title(t.title_key)}">
      <span class="ri-key">${esc(t.label)}</span>${esc(t.name || "")}
    </a>`).join("");

  readerEl.innerHTML = `
    <div class="hero">
      <h1 class="page-h">Connecticut General Statutes</h1>
      <p class="page-sub">Read the General Statutes chapter by chapter, jump anywhere with one search
        (<kbd>/</kbd>), and check infraction fines in place. A research aid — verify language and amounts
        with the official CGA and Judicial Branch sources.</p>
      <div class="stat-row">
        <span><b>${S.titles.length}</b> titles</span>
        <span><b>${S.inf ? S.inf.entries.length.toLocaleString() : "…"}</b> infraction entries</span>
        <span><b>${S.idx ? S.idx.headings.length.toLocaleString() : "…"}</b> index topics</span>
      </div>
    </div>

    <div class="card-grid">
      <a class="card" href="${H.ix()}"><b>🔎 Subject index</b><span class="small">The official LCO topic index, A–Z, with statute references.</span></a>
      <a class="card" href="${H.inf()}"><b>💵 Infraction fines</b><span class="small">The Judicial Branch schedule${S.inf?.source?.effective ? `, effective ${esc(S.inf.source.effective)}` : ""}.</span></a>
      <a class="card" href="${H.bm()}"><b>★ Saved sections</b><span class="small">${S.bookmarks.length ? S.bookmarks.length + " bookmarked section" + (S.bookmarks.length > 1 ? "s" : "") : "Bookmark sections as you read."}</span></a>
    </div>

    ${recents ? `<div class="sec-h">Continue reading</div>${recents}` : ""}
    ${bms ? `<div class="sec-h">Saved <a href="${H.bm()}">view all</a></div>${bms}` : ""}

    <div class="sec-h">All titles</div>
    <div class="title-grid">${titleCards}</div>`;
}

function rowItemHtml(r) {
  const { num, cap } = splitLabel(r.label);
  return `<a class="row-item" href="${H.section(r.tk, r.ck, r.key)}">
    <span class="ri-key">${esc(num || r.key)}</span>${esc(cap)}
    <span class="ri-sub">Title ${esc(r.tk.replace(/^0/, ""))} · Chapter ${esc(r.ck)}</span>
  </a>`;
}

// -----------------------------
// VIEW: TITLE
// -----------------------------
async function viewTitle(token, tk) {
  const entry = S.titleByKey.get(tk);
  if (!entry) { readerEl.innerHTML = `<div class="notice">Unknown title “${esc(tk)}”.</div>`; return; }
  sidenavTitles(tk);
  readerEl.innerHTML = loadingHtml(`Loading ${entry.label}…`);
  const t = await loadTitle(tk);
  if (token !== S.renderToken) return;

  sidenavChapters(t, null);
  const cards = (t.chapters || []).map((c) => {
    const secs = c.sections || [];
    const first = secs[0]?.section_key, last = secs[secs.length - 1]?.section_key;
    return `<a class="ch-card" href="${H.chapter(tk, c.chapter_key)}">
      <span class="ck">Chapter ${esc(c.chapter_key)}</span>${esc(c.name || "")}
      <div class="ch-meta">${secs.length} section${secs.length === 1 ? "" : "s"}${first ? ` · §§ ${esc(first)}–${esc(last)}` : ""}</div>
    </a>`;
  }).join("");

  readerEl.innerHTML = `
    <div class="crumbs"><a href="#/">Titles</a><span class="sep">›</span>${esc(t.label)}</div>
    <h1 class="page-h">${esc(t.label)} — ${esc(t.name || "")}</h1>
    <p class="page-sub">${(t.chapters || []).length} chapters. Choose one to read it straight through.</p>
    ${cards}`;
}

// -----------------------------
// VIEW: CHAPTER READER
// -----------------------------
async function viewChapter(token, tk, ck, sk, sub) {
  const entry = S.titleByKey.get(tk);
  if (!entry) { readerEl.innerHTML = `<div class="notice">Unknown title “${esc(tk)}”.</div>`; return; }
  readerEl.innerHTML = loadingHtml(`Loading ${entry.label}…`);
  const t = await loadTitle(tk);
  if (token !== S.renderToken) return;
  const ch = (t.chapters || []).find((c) => c.chapter_key === ck);
  if (!ch) { readerEl.innerHTML = `<div class="notice">Chapter ${esc(ck)} not found in ${esc(t.label)}.</div>`; return; }

  sidenavChapters(t, ck);
  const secs = ch.sections || [];

  readerEl.innerHTML = `
    <div class="crumbs">
      <a href="#/">Titles</a><span class="sep">›</span>
      <a href="${H.title(tk)}">${esc(t.label)}</a><span class="sep">›</span>
      Chapter ${esc(ck)}
    </div>
    <div class="ch-header">
      <h1 class="page-h">Chapter ${esc(ck)} — ${esc(ch.name || "")}</h1>
      <p class="page-sub">${esc(t.label)} · ${secs.length} section${secs.length === 1 ? "" : "s"}</p>
    </div>
    <div id="secs"></div>`;

  buildOutline(ch, tk);

  // render in chunks so long chapters paint fast; scroll instantly as soon as
  // the target exists, then correct once the layout above it stops growing
  const holder = $("secs");
  const CHUNK = 24;
  let pendingScroll = !!sk;
  for (let i = 0; i < secs.length; i += CHUNK) {
    if (token !== S.renderToken) return;
    const frag = document.createElement("div");
    frag.innerHTML = secs.slice(i, i + CHUNK).map((s) => sectionHtml(s, tk, ck)).join("");
    while (frag.firstChild) holder.appendChild(frag.firstChild);
    if (pendingScroll && document.getElementById("s_" + cssId(sk))) {
      scrollToSection(sk, true, sub);
      pendingScroll = false;
    }
    if (i + CHUNK < secs.length) await new Promise(requestAnimationFrame);
  }
  if (token !== S.renderToken) return;
  if (sk) scrollToSection(sk, true, sub);
  wireSectionTools(holder, tk, ck);
  startSpy(tk, ck);
}

function cssId(k) { return String(k).replace(/[^\w-]/g, "_"); }

function sectionHtml(sec, tk, ck) {
  const { num, cap } = splitLabel(sec.label);
  const c = sec.content || {};
  const repealed = !!c.status;
  const fines = S.infBySec.get(sec.section_key) || [];
  const hist = c.history || [];
  const ann = c.annotations || [];
  const src = (c.source || []).join(" ");
  const bm = isBookmarked(sec.section_key);

  const rows = structureParagraphs(c.body_paragraphs || []);
  const body = renderBodyBlocks(rows, sec, tk, ck) || `<p class="muted">${esc(c.text || "No text available.")}</p>`;
  const citedBy = S.incoming ? (S.incoming[sec.section_key] || []).length : null;

  return `
  <article class="sec ${repealed ? "repealed" : ""}" id="s_${cssId(sec.section_key)}" data-key="${esc(sec.section_key)}">
    <div class="sec-head">
      <span class="sec-num">${esc(num || sec.section_key)}</span>
      <span class="sec-cap">${esc(cap)}</span>
      ${repealed ? `<span class="pill repealed">Repealed</span>` : ""}
      ${fines.length ? `<span class="pill fine">Infraction · ${fines.length}</span>` : ""}
    </div>
    <div class="sec-body">${body}</div>
    ${src ? `<p class="sec-src">${esc(src)}</p>` : ""}
    <div class="sec-tools">
      <button class="chip bm ${bm ? "on" : ""}" data-act="bm">${bm ? "★ Saved" : "☆ Save"}</button>
      ${hist.length ? `<button class="chip" data-act="hist">History</button>` : ""}
      ${ann.length ? `<button class="chip" data-act="ann">Annotations (${ann.length})</button>` : ""}
      ${fines.length ? `<button class="chip" data-act="fines">Infractions (${fines.length})</button>` : ""}
      <button class="chip" data-act="cites">${citedBy ? `Cited by (${citedBy})` : "Cited by"}</button>
      <button class="chip" data-act="copy">Copy link</button>
      ${sec.url ? `<a class="chip" href="${esc(sec.url)}" target="_blank" rel="noopener">cga.ct.gov ↗</a>` : ""}
    </div>
    ${hist.length ? `<div class="sec-panel" data-panel="hist" hidden><h4>Amendment history</h4>${hist.map((h) => `<p>${linkifyCitations(esc(h), sec.section_key)}</p>`).join("")}</div>` : ""}
    ${ann.length ? `<div class="sec-panel" data-panel="ann" hidden><h4>Annotations</h4>${ann.map((a) => `<p>${linkifyCitations(esc(typeof a === "string" ? a : a.text || ""), sec.section_key)}</p>`).join("")}</div>` : ""}
    ${fines.length ? `<div class="sec-panel" data-panel="fines" hidden><h4>Infraction schedule${S.inf?.source?.effective ? ` (effective ${esc(S.inf.source.effective)})` : ""}</h4>${finesTable(fines)}</div>` : ""}
  </article>`;
}

function finesTable(entries) {
  return `<table class="fines">
    <tr><th>Violation</th><th></th><th style="text-align:right">Amount</th></tr>
    ${entries.map((e) => `<tr>
      <td>${esc(e.description || "")}</td>
      <td>${e.subsequent ? `<span class="muted small">subsequent offense</span>` : ""}</td>
      <td class="amt"><b>${e.amounts?.total_due != null ? fmtMoney(e.amounts.total_due) : "—"}</b></td>
    </tr>`).join("")}
  </table>`;
}

function setDefGroupOpen(toggle, open) {
  const body = toggle.nextElementSibling;
  body.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.querySelector(".dg-arrow").textContent = open ? "▾" : "▸";
}

function wireSectionTools(holder, tk, ck) {
  holder.addEventListener("click", (ev) => {
    const dt = ev.target.closest("[data-deftoggle]");
    if (dt) { setDefGroupOpen(dt, dt.nextElementSibling.hidden); return; }
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const art = btn.closest("article.sec");
    const key = art.dataset.key;
    const act = btn.dataset.act;
    if (act === "cites") { toggleCitesPanel(art, btn, key); return; }
    if (act === "bm") {
      const labelEl = art.querySelector(".sec-head");
      toggleBookmark({ key, label: `Sec. ${key}. ${art.querySelector(".sec-cap")?.textContent || ""}`, tk, ck });
      const on = isBookmarked(key);
      btn.classList.toggle("on", on);
      btn.textContent = on ? "★ Saved" : "☆ Save";
      return;
    }
    if (act === "copy") {
      const url = location.href.split("#")[0] + H.section(tk, ck, key);
      navigator.clipboard?.writeText(url).then(() => {
        const old = btn.textContent;
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = old; }, 1200);
      });
      return;
    }
    const panel = art.querySelector(`[data-panel="${act}"]`);
    if (panel) {
      panel.hidden = !panel.hidden;
      btn.classList.toggle("on", !panel.hidden);
    }
  });
}

// "Cited by" panel: incoming statute citations + index topics referencing the section
async function toggleCitesPanel(art, btn, key) {
  let panel = art.querySelector('[data-panel="cites"]');
  if (panel) {
    panel.hidden = !panel.hidden;
    btn.classList.toggle("on", !panel.hidden);
    return;
  }
  panel = document.createElement("div");
  panel.className = "sec-panel";
  panel.dataset.panel = "cites";
  panel.innerHTML = `<h4>Cited by</h4><p class="muted">Loading…</p>`;
  art.appendChild(panel);
  btn.classList.add("on");

  await loadIncomingLazy();
  const citing = S.incoming[key] || [];
  const MAX = 120;
  const links = citing.slice(0, MAX).map((k) => `<a href="${H.resolve(k)}">§ ${esc(k)}</a>`).join(", ");
  const statutesHtml = citing.length
    ? `<p>${links}${citing.length > MAX ? `, … and ${citing.length - MAX} more` : ""}</p>`
    : `<p class="muted">No other section's statute text cites this one.</p>`;
  panel.innerHTML = `
    <h4>Cited by ${citing.length ? `${citing.length} section${citing.length === 1 ? "" : "s"}` : ""}</h4>
    ${statutesHtml}
    <h4 style="margin-top:12px">Index topics</h4>
    <p class="muted" data-cites-topics>Loading the subject index…</p>`;

  loadIndexLazy().then(() => {
    const slot = panel.querySelector("[data-cites-topics]");
    if (!slot) return;
    const heads = [...(S.idxByRef.get(key) || [])];
    if (!heads.length) { slot.textContent = "No index topics reference this section."; return; }
    slot.outerHTML = `<p>${heads.map((h) =>
      `<a href="${H.ixHeading(h.slug)}">${esc(titleCase(h.h))}</a>`).join(" · ")}</p>`;
  });
}

// outline rail + scroll spy
function buildOutline(ch, tk) {
  const secs = ch.sections || [];
  if (!secs.length) return;
  outlineEl.hidden = false;
  $("outlineFab").hidden = false;   // small screens: floating button opens this as a popover
  outlineEl.innerHTML = `
    <div class="ol-head">On this page</div>
    ${secs.map((s) => {
      const { cap } = splitLabel(s.label);
      return `<a class="ol-item" data-key="${esc(s.section_key)}" href="${H.section(tk, ch.chapter_key, s.section_key)}">
        <span class="ol-key">${esc(s.section_key)}</span> ${esc(cap.length > 52 ? cap.slice(0, 52) + "…" : cap)}</a>`;
    }).join("")}`;
}

let spyHandler = null;
let spyGen = 0;
function startSpy(tk, ck) {
  stopSpy();
  const gen = spyGen;
  const onScroll = debounce(() => {
    if (gen !== spyGen) return;   // a pending debounce may outlive stopSpy()
    if (S.route?.area !== "browse" || S.route.ck !== ck) return;
    const arts = readerEl.querySelectorAll("article.sec");
    if (!arts.length) return;
    const fold = 130;
    let current = arts[0];
    for (const a of arts) {
      if (a.getBoundingClientRect().top <= fold) current = a;
      else break;
    }
    const key = current.dataset.key;
    if (key === S.spyKey) return;
    S.spyKey = key;
    outlineEl.querySelectorAll(".ol-item").forEach((el) => {
      const on = el.dataset.key === key;
      el.classList.toggle("active", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
    // keep the URL pointing at what you're reading (no history spam); leave a
    // subsection anchor alone while the reader is still inside its section
    if (S.route.sk !== key) {
      S.route.sk = key;
      S.route.sub = null;
      history.replaceState(null, "", H.section(tk, ck, key));
    }
    scheduleRecent(current, tk, ck);
  }, 120);
  spyHandler = onScroll;
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}
function stopSpy() {
  spyGen++;
  if (spyHandler) window.removeEventListener("scroll", spyHandler);
  spyHandler = null;
  S.spyKey = null;
}

let recentTimer = null;
function scheduleRecent(art, tk, ck) {
  clearTimeout(recentTimer);
  const key = art.dataset.key;
  const cap = art.querySelector(".sec-cap")?.textContent || "";
  recentTimer = setTimeout(() => {
    addRecent({ key, label: `Sec. ${key}. ${cap}`, tk, ck });
  }, 2500);
}

function scrollToSection(sk, instant = false, sub = null) {
  const el = document.getElementById("s_" + cssId(sk));
  if (!el) return;
  let target = el;
  if (sub) {
    const p = findParagraph(el, sub);
    if (p) {
      const body = p.closest(".defgroup-body");
      if (body?.hidden) setDefGroupOpen(body.previousElementSibling, true);
      target = p;
    }
  }
  target.scrollIntoView({ block: "start", behavior: instant ? "auto" : "smooth" });
  if (target !== el) {
    target.classList.remove("flash");
    void target.offsetWidth;          // restart the animation if re-triggered
    target.classList.add("flash");
  }
}

// first paragraph whose subsection path starts with the requested path,
// e.g. "b.1" matches data-path="b.1" or, failing that, "b.1.A"
function findParagraph(secEl, sub) {
  const want = sub.split(".");
  for (const p of secEl.querySelectorAll("p.stx[data-path]")) {
    const path = p.dataset.path.split(".");
    if (path.length >= want.length && want.every((t, i) => path[i] === t)) return p;
  }
  return null;
}

// -----------------------------
// VIEW: RESOLVER  (#/s/14-296aa)
// -----------------------------
async function viewResolve(token, ref) {
  sidenavTitles(null);
  readerEl.innerHTML = loadingHtml(`Locating section ${ref}…`);
  // accept a bare key or a citation with subsections: 14-296aa(b)(1)
  const m = /^([\d\w-]+?)((?:\([0-9a-zA-Z]{1,4}\))*)$/.exec(String(ref).replace(/\s+/g, ""));
  const sk = m ? m[1] : ref;
  const sub = m && m[2] ? [...m[2].matchAll(/\(([0-9a-zA-Z]{1,4})\)/g)].map((x) => x[1]).join(".") : null;
  const tk = titleKeyForSection(sk);
  if (!tk) { readerEl.innerHTML = `<div class="notice">Could not map “${esc(sk)}” to a title.</div>`; return; }
  const t = await loadTitle(tk);
  if (token !== S.renderToken) return;
  const loc = S.secLoc.get(sk);
  if (!loc) {
    const entry = S.titleByKey.get(tk);
    const empty = !(t.chapters || []).length;
    readerEl.innerHTML = `<div class="notice">Section ${esc(sk)} was not found in ${esc(entry?.label || tk)}.
      ${empty
        ? `This title has no sections in the crawled data snapshot (the crawler does not currently capture it).`
        : `It may be repealed or renumbered. <a href="${H.title(tk)}">Browse the title</a>.`}
      ${entry?.url ? ` <a href="${esc(entry.url)}" target="_blank" rel="noopener">Open ${esc(entry.label)} on cga.ct.gov ↗</a>` : ""}</div>`;
    return;
  }
  location.replace(sub ? H.sub(loc.tk, loc.ck, sk, sub) : H.section(loc.tk, loc.ck, sk));
}

// -----------------------------
// SEARCH (instant + results page)
// -----------------------------
function navSearch(q, perGroup) {
  const terms = tokenize(q);
  const out = { jump: null, titles: [], chapters: [], sections: [], topics: [], fines: [], topicsPending: !S.idx };
  if (!terms.length) return out;

  // citation jump, with optional subsections: "14-296aa" or "14-296aa(b)(1)"
  const jm = /^(\d{1,3}[a-z]{0,2}-\d+[a-z]{0,3})((?:\([0-9a-zA-Z]{1,4}\))*)$/i.exec(q.trim().replace(/\s+/g, ""));
  if (jm) out.jump = jm[1].toLowerCase() + (jm[2] || "");

  for (const t of S.titles) {
    if (matches(`${t.label} ${t.name || ""}`, terms)) out.titles.push(t);
    if (out.titles.length >= perGroup) break;
  }
  for (const c of S.navChRows) {
    if (matches(`${c.label} ${c.name}`, terms)) out.chapters.push(c);
    if (out.chapters.length >= perGroup) break;
  }
  for (const s of S.navSecRows) {
    if (matches(s.label + " " + s.key, terms)) out.sections.push(s);
    if (out.sections.length >= perGroup) break;
  }
  if (S.idx) {
    for (const h of S.idx.headings) {
      if (matches(h.h, terms)) out.topics.push(h);
      if (out.topics.length >= perGroup) break;
    }
  }
  if (S.inf) {
    for (const e of S.inf.entries) {
      if (matches(`${e.citation || e.stat_no} ${e.description || ""} ${e.category || ""}`, terms)) out.fines.push(e);
      if (out.fines.length >= perGroup) break;
    }
  }
  return out;
}

async function viewSearch(token, q) {
  sidenavTitles(null);
  if (!q.trim()) { readerEl.innerHTML = `<div class="notice">Type something in the search box above.</div>`; return; }
  if (!S.idx) {
    // re-render once the index topics arrive, if we're still on this search
    loadIndexLazy().then(() => {
      if (token === S.renderToken && S.route?.area === "search" && S.route.q === q) render();
    });
  }
  const r = navSearch(q, 50);
  const terms = tokenize(q);
  const hl = (s) => highlightTerms(esc(s), terms);
  const grp = (label, rows) => rows.length ? `<div class="res-grp"><div class="sec-h">${label} (${rows.length}${rows.length >= 50 ? "+" : ""})</div>${rows.join("")}</div>` : "";

  readerEl.innerHTML = `
    <h1 class="page-h">Results for “${esc(q)}”</h1>
    <p class="page-sub">Matched against titles, chapters, section headings, index topics, and the infraction schedule.
      Section headings cover all <b>${S.titles.length}</b> titles —
      full-text search scans every word of all ${S.titles.length} titles.</p>
    <p><a class="btn primary" href="${H.fulltext(q)}">Search full text of all statutes →</a></p>
    ${r.jump ? `<div class="res-grp"><div class="sec-h">Citation</div>
      <a class="row-item" href="${H.resolve(r.jump)}"><span class="ri-key">§ ${esc(r.jump)}</span>Go to this section</a></div>` : ""}
    ${grp("Sections", r.sections.map((s) => {
      const { num, cap } = splitLabel(s.label);
      return `<a class="row-item" href="${H.section(s.tk, s.ck, s.key)}"><span class="ri-key">${esc(num || s.key)}</span>${hl(cap)}
        <span class="ri-sub">Title ${esc(s.tk.replace(/^0/, ""))} · Chapter ${esc(s.ck)}</span></a>`;
    }))}
    ${grp("Titles", r.titles.map((t) => `<a class="row-item" href="${H.title(t.title_key)}"><span class="ri-key">${esc(t.label)}</span>${hl(t.name || "")}</a>`))}
    ${grp("Chapters", r.chapters.map((c) => `<a class="row-item" href="${H.chapter(c.tk, c.ck)}"><span class="ri-key">Ch. ${esc(c.ck)}</span>${hl(c.name || c.label)}
      <span class="ri-sub">Title ${esc(c.tk.replace(/^0/, ""))}</span></a>`))}
    ${grp("Index topics", r.topics.map((h) => `<a class="row-item" href="${H.ixHeading(h.slug)}"><span class="ri-key">Topic</span>${hl(h.h)}</a>`))}
    ${r.topicsPending ? `<p class="muted small">Index topics are still loading…</p>` : ""}
    ${grp("Infractions", r.fines.map(infRowHtml(terms)))}
    ${!r.jump && !r.sections.length && !r.titles.length && !r.chapters.length && !r.topics.length && !r.fines.length
      ? `<div class="notice">No matches in headings or schedules. Try the full-text search above.</div>` : ""}`;
}

function infRowHtml(terms) {
  return (e) => {
    const cite = e.citation || e.stat_no || "";
    const target = e.section_key ? H.resolve(e.section_key) : null;
    const amt = e.amounts?.total_due != null ? fmtMoney(e.amounts.total_due) : "";
    const desc = (e.description || "").length > 220 ? e.description.slice(0, 220) + "…" : (e.description || "");
    const inner = `<span class="ri-key">§ ${esc(cite)}</span>${highlightTerms(esc(desc), terms)}
      ${amt ? `<b style="float:right">${amt}</b>` : ""}
      <span class="ri-sub">${esc(titleCase(e.category || ""))}${e.subsequent ? " · subsequent offense" : ""}</span>`;
    return target ? `<a class="row-item" href="${target}">${inner}</a>` : `<div class="row-item">${inner}</div>`;
  };
}

// -----------------------------
// VIEW: ABOUT
// -----------------------------
function viewAbout(token) {
  sidenavTitles(null);
  readerEl.innerHTML = `
    <div class="about">
      <div class="about-brand">
        <img src="./wordmark.svg" alt="UConn School of Law — Law Library and Technology" />
      </div>
      <h1 class="page-h">CGS Reader</h1>
      <p class="page-sub">A reading-first explorer for the Connecticut General Statutes:
        continuous chapter reading, structured subsections, and one unified search.</p>
      <p class="about-meta">Version ${APP_VERSION} · ${APP_YEAR}</p>
      <p><a class="btn primary" href="https://library.law.uconn.edu/" target="_blank" rel="noopener">Visit the Law Library ↗</a></p>
      <p class="muted small">Statute text and the infraction schedule are drawn from the Connecticut General
        Assembly's published revision. This reader is an unofficial research aid — verify language
        and amounts against official sources before relying on them.</p>
    </div>`;
}

// -----------------------------
// VIEW: FULL-TEXT SEARCH
// -----------------------------
async function viewFulltext(token, q) {
  sidenavTitles(null);
  const terms = tokenize(q);
  if (!terms.length) { readerEl.innerHTML = `<div class="notice">Nothing to search for.</div>`; return; }

  readerEl.innerHTML = `
    <h1 class="page-h">Full-text: “${esc(q)}”</h1>
    <p class="page-sub">Scanning every section of all ${S.titles.length} titles. Sections match when they contain all search words.</p>
    <div class="progress"><div id="ftBar"></div></div>
    <div class="small muted" id="ftStatus">Starting…</div>
    <div id="ftResults"></div>`;

  S.ft.cancel = false;
  S.ft.running = true;
  const bar = $("ftBar"), status = $("ftStatus"), box = $("ftResults");
  let found = 0;

  for (let i = 0; i < S.titles.length; i++) {
    if (token !== S.renderToken || S.ft.cancel) { S.ft.running = false; return; }
    const entry = S.titles[i];
    status.textContent = `Searching ${entry.label} — ${entry.name || ""} (${i + 1}/${S.titles.length}) · ${found} match${found === 1 ? "" : "es"}`;
    bar.style.width = ((i / S.titles.length) * 100).toFixed(1) + "%";
    let t;
    try { t = await loadTitle(entry.title_key); }
    catch { continue; }
    if (token !== S.renderToken || S.ft.cancel) { S.ft.running = false; return; }

    const rows = [];
    for (const ch of t.chapters || []) {
      for (const sec of ch.sections || []) {
        const text = (sec.label || "") + " " + (sec.content?.text || "");
        if (!matches(text, terms)) continue;
        found++;
        rows.push(ftRowHtml(sec, entry.title_key, ch.chapter_key, terms));
        if (found >= FT_MAX_RESULTS) break;
      }
      if (found >= FT_MAX_RESULTS) break;
    }
    if (rows.length) {
      const div = document.createElement("div");
      div.className = "res-grp";
      div.innerHTML = `<div class="sec-h">${esc(entry.label)} — ${esc(entry.name || "")}</div>` + rows.join("");
      box.appendChild(div);
    }
    if (found >= FT_MAX_RESULTS) { status.textContent = `Stopped at ${FT_MAX_RESULTS} matches — refine the search to see more specific results.`; bar.style.width = "100%"; S.ft.running = false; return; }
    await new Promise(requestAnimationFrame);
  }
  bar.style.width = "100%";
  status.textContent = found
    ? `Done — ${found} matching section${found === 1 ? "" : "s"}.`
    : "Done — no sections contain all of those words.";
  S.ft.running = false;
}

function ftRowHtml(sec, tk, ck, terms) {
  const { num, cap } = splitLabel(sec.label);
  const text = sec.content?.text || "";
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) { const p = lower.indexOf(t); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  let snip = "";
  if (pos >= 0) {
    const start = Math.max(0, pos - 90), end = Math.min(text.length, pos + 190);
    snip = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }
  return `<a class="row-item" href="${H.section(tk, ck, sec.section_key)}">
    <span class="ri-key">${esc(num || sec.section_key)}</span>${highlightTerms(esc(cap), terms)}
    ${snip ? `<span class="snippet">${highlightTerms(esc(snip), terms)}</span>` : ""}
  </a>`;
}

// -----------------------------
// VIEW: SUBJECT INDEX
// -----------------------------
async function viewIndex(token, r) {
  sidenavLetters(r.letter || (r.slug ? null : null));
  if (!S.idx) {
    readerEl.innerHTML = loadingHtml("Loading the subject index (about 14 MB, cached after the first load)…");
    await loadIndexLazy();
    if (token !== S.renderToken) return;
  }

  if (r.slug) {
    const h = S.idxBySlug.get(r.slug);
    if (!h) { readerEl.innerHTML = `<div class="notice">Index topic not found.</div>`; return; }
    sidenavLetters((h.h[0] || "").toUpperCase());
    readerEl.innerHTML = `
      <div class="crumbs"><a href="${H.ix()}">Index</a><span class="sep">›</span>
        <a href="${H.ixLetter((h.h[0] || "A").toUpperCase())}">${esc((h.h[0] || "A").toUpperCase())}</a><span class="sep">›</span>${esc(h.h)}</div>
      <h1 class="page-h">${esc(titleCase(h.h))}</h1>
      <div style="margin-top:14px">${(h.items || []).map(ixItemHtml).join("")}</div>`;
    return;
  }

  if (r.letter) {
    const list = S.idxLetters.get(r.letter) || [];
    sidenavLetters(r.letter);
    readerEl.innerHTML = `
      <div class="crumbs"><a href="${H.ix()}">Index</a><span class="sep">›</span>${esc(r.letter)}</div>
      <h1 class="page-h">Index — ${esc(r.letter)}</h1>
      <p class="page-sub">${list.length} topics</p>
      ${lettersInlineHtml(r.letter)}
      <div class="ix-cols">${list.map((h) =>
        `<a class="row-item" href="${H.ixHeading(h.slug)}">${esc(titleCase(h.h))}</a>`).join("")}</div>`;
    return;
  }

  readerEl.innerHTML = `
    <h1 class="page-h">Subject index</h1>
    <p class="page-sub">The Legislative Commissioners' official index to the General Statutes —
      ${S.idx.headings.length.toLocaleString()} topics. Pick a letter, or just search from the box above:
      index topics are part of every search.</p>
    ${lettersInlineHtml(null)}`;
}

function ixItemHtml(it) {
  const refs = (it.r || []).map(([disp, key]) => {
    if (!key) return esc(disp);
    // when the printed citation carries subsections ("22-332(c)"), link to them
    const clean = String(disp).replace(/\s+/g, "");
    const keyRe = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^${keyRe}((?:\\([0-9a-zA-Z]{1,4}\\))+)$`).exec(clean);
    return `<a href="${H.resolve(m ? key + m[1] : key)}">${esc(disp)}</a>`;
  }).join(", ");
  const sees = (it.see || []).map(([target, sub]) => {
    const h = S.idx.headings.find((x) => x.h === target);
    const label = esc(titleCase(target)) + (sub ? ` › ${esc(sub)}` : "");
    return h ? `<a href="${H.ixHeading(h.slug)}">${label}</a>` : label;
  }).join("; ");
  const text = it.see?.length
    ? `<span class="ix-see">${esc(it.t.replace(/^See\s+.*$/i, "See"))} ${sees}</span>`
    : `${esc(it.t)}${refs ? ` <span class="refs">${refs}</span>` : ""}`;
  return `<div class="ix-item" style="--l:${it.l || 0}">${text}</div>`;
}

// -----------------------------
// VIEW: INFRACTIONS
// -----------------------------
function viewInfractions(token, r) {
  sidenavInfCats(r.cat || null);
  if (!S.inf) { readerEl.innerHTML = loadingHtml("Loading the infraction schedule…"); return; }
  const src = S.inf.source || {};

  if (r.cat) {
    const cat = S.infCats.find((c) => c.slug === r.cat);
    if (!cat) { readerEl.innerHTML = `<div class="notice">Category not found.</div>`; return; }
    const entries = S.inf.entries.filter((e) => (e.category || "Other") === cat.name);
    readerEl.innerHTML = `
      <div class="crumbs"><a href="${H.inf()}">Infractions</a><span class="sep">›</span>${esc(titleCase(cat.name))}</div>
      <h1 class="page-h">${esc(titleCase(cat.name))}</h1>
      <p class="page-sub">${entries.length} entries · amounts from the Judicial Branch schedule${src.effective ? `, effective ${esc(src.effective)}` : ""}.
        Click an entry to read the statute it enforces.</p>
      ${entries.map(infRowHtml([])).join("")}`;
    return;
  }

  readerEl.innerHTML = `
    <h1 class="page-h">Infraction fines</h1>
    <p class="page-sub">${esc(src.title || "Violations and Infractions Schedule")}
      ${src.effective ? `· effective ${esc(src.effective)}` : ""} · ${S.inf.entries.length.toLocaleString()} entries.
      Fine amounts also appear inline while you read any statute that carries one.</p>
    <div class="card-grid">
      ${S.infCats.map((c) => `<a class="card" href="${H.infCat(c.slug)}"><b>${esc(titleCase(c.name))}</b>
        <span class="small">${c.count} entries</span></a>`).join("")}
    </div>
    ${src.url ? `<p class="small muted">Source: <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.url)}</a></p>` : ""}`;
}

// -----------------------------
// VIEW: BOOKMARKS
// -----------------------------
function viewBookmarks(token) {
  sidenavTitles(null);
  const rows = S.bookmarks.map((b) => `
    <div style="position:relative">
      ${rowItemHtml(b)}
      <button class="chip" data-unbm="${esc(b.key)}" style="position:absolute;top:12px;right:12px">Remove</button>
    </div>`).join("");
  readerEl.innerHTML = `
    <h1 class="page-h">Saved sections</h1>
    <p class="page-sub">${S.bookmarks.length ? "Stored in this browser only." : "Nothing saved yet — use ☆ Save under any section while reading."}</p>
    ${rows}`;
  readerEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-unbm]");
    if (!btn) return;
    ev.preventDefault();
    S.bookmarks = S.bookmarks.filter((b) => b.key !== btn.dataset.unbm);
    saveJSON(BM_KEY, S.bookmarks);
    updateBmBadge();
    viewBookmarks(token);
  }, { once: true });
}

// -----------------------------
// OMNIBOX
// -----------------------------
let omniSel = -1;
function omniItems() { return [...omniPanel.querySelectorAll(".omni-item")]; }

const KIND_LABEL = { jump: "Go to", sections: "Section", titles: "Title", chapters: "Chapter", topics: "Topic", fines: "Fine" };

function renderOmni(q) {
  const terms = tokenize(q);
  if (!terms.length) { closeOmni(); return; }
  loadIndexLazy();
  const r = navSearch(q, 5);
  const hl = (s) => highlightTerms(esc(s), terms);
  const items = [];

  if (r.jump) items.push({ kind: "jump", href: H.resolve(r.jump), main: `§ ${r.jump}`, sub: "Jump straight to this section" });
  for (const s of r.sections) {
    const { num, cap } = splitLabel(s.label);
    items.push({ kind: "sections", href: H.section(s.tk, s.ck, s.key), main: `${num || s.key} ${cap}`, sub: `Title ${s.tk.replace(/^0/, "")} · Chapter ${s.ck}` });
  }
  for (const t of r.titles) items.push({ kind: "titles", href: H.title(t.title_key), main: `${t.label} — ${t.name || ""}` });
  for (const c of r.chapters) items.push({ kind: "chapters", href: H.chapter(c.tk, c.ck), main: `Chapter ${c.ck} — ${c.name}`, sub: `Title ${c.tk.replace(/^0/, "")}` });
  for (const h of r.topics) items.push({ kind: "topics", href: H.ixHeading(h.slug), main: titleCase(h.h) });
  for (const e of r.fines) {
    const amt = e.amounts?.total_due != null ? ` · ${fmtMoney(e.amounts.total_due)}` : "";
    items.push({ kind: "fines", href: e.section_key ? H.resolve(e.section_key) : H.inf(), main: `${e.citation || e.stat_no} — ${e.description || ""}${amt}` });
  }

  if (!items.length) {
    omniPanel.innerHTML = `<div class="omni-empty">No quick matches${r.topicsPending ? " (index topics still loading)" : ""}.
      Press <b>Enter</b> for full results & full-text search.</div>`;
  } else {
    const clamp = (s) => s.length > 130 ? s.slice(0, 130) + "…" : s;
    omniPanel.innerHTML = items.map((it, i) => `
      <a class="omni-item" data-i="${i}" href="${it.href}">
        <span class="oi-kind">${KIND_LABEL[it.kind]}</span>${hl(clamp(it.main))}
        ${it.sub ? `<span class="oi-sub">${esc(it.sub)}</span>` : ""}
      </a>`).join("") +
      `<div class="omni-foot">↵ all results &nbsp;·&nbsp; ↑↓ choose &nbsp;·&nbsp; Esc close</div>`;
  }
  omniPanel.hidden = false;
  qEl.setAttribute("aria-expanded", "true");
  omniSel = -1;
}

function closeOmni() {
  omniPanel.hidden = true;
  qEl.setAttribute("aria-expanded", "false");
  omniSel = -1;
}

function wireOmni() {
  qEl.addEventListener("input", debounce(() => renderOmni(qEl.value), 120));
  qEl.addEventListener("focus", () => { if (qEl.value.trim()) renderOmni(qEl.value); });
  qEl.addEventListener("keydown", (ev) => {
    const items = omniItems();
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!items.length) return;
      ev.preventDefault();
      omniSel = (omniSel + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("sel", i === omniSel));
      items[omniSel].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (omniSel >= 0 && items[omniSel]) location.hash = items[omniSel].getAttribute("href");
      else if (qEl.value.trim()) location.hash = H.search(qEl.value.trim());
      closeOmni();
      qEl.blur();
    } else if (ev.key === "Escape") {
      closeOmni();
      qEl.blur();
    }
  });
  omniPanel.addEventListener("mousedown", (ev) => {
    const a = ev.target.closest(".omni-item");
    if (a) { location.hash = a.getAttribute("href"); closeOmni(); qEl.blur(); ev.preventDefault(); }
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".omni")) closeOmni();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
      ev.preventDefault();
      qEl.focus();
      qEl.select();
    }
  });
}

// -----------------------------
// SETTINGS (theme, text size, density, offline data, bookmarks)
// -----------------------------
// Same menu as the original app's ⚙ Settings, adapted to the Reader's chrome.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function getSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function setSetting(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode — applies for this session only */ }
}

function storedTheme() {
  const t = getSetting(THEME_KEY);
  return t === "light" || t === "dark" ? t : null;
}

function effectiveTheme() {
  return storedTheme() || (darkQuery.matches ? "dark" : "light");
}

function textScale() {
  const v = parseFloat(getSetting(TEXT_SIZE_KEY));
  return TEXT_SIZES.includes(v) ? v : 1;
}

function applySettings() {
  const root = document.documentElement;

  const pinned = storedTheme();
  if (pinned) root.dataset.theme = pinned;
  else delete root.dataset.theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", effectiveTheme() === "dark" ? "#14161b" : "#1e4fa3");

  const scale = textScale();
  if (scale === 1) root.style.removeProperty("--font-scale");
  else root.style.setProperty("--font-scale", String(scale));

  const compact = getSetting(DENSITY_KEY) === "compact";
  if (compact) root.dataset.density = "compact";
  else delete root.dataset.density;

  // reflect state in the panel controls
  const choice = pinned || "auto";
  $("settingsPanel").querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeChoice === choice));
  });
  $("textSizeValue").textContent = Math.round(scale * 100) + "%";
  $("textSmaller").disabled = TEXT_SIZES.indexOf(scale) === 0;
  $("textLarger").disabled = TEXT_SIZES.indexOf(scale) === TEXT_SIZES.length - 1;
  $("densityToggle").checked = compact;
  $("bookmarkHint").textContent = S.bookmarks.length
    ? `${S.bookmarks.length} saved` : "None saved";
  $("clearBookmarksBtn").disabled = !S.bookmarks.length;
  updateOfflineButton();
}

function stepTextSize(delta) {
  const i = TEXT_SIZES.indexOf(textScale()) + delta;
  const next = TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, i))];
  setSetting(TEXT_SIZE_KEY, next === 1 ? null : String(next));
  applySettings();
}

function toggleSettingsPanel(open) {
  const panel = $("settingsPanel");
  const show = open ?? panel.hidden;
  panel.hidden = !show;
  $("settingsBtn").setAttribute("aria-expanded", String(show));
  if (show) applySettings();
}

function bindSettings() {
  const settingsBtn = $("settingsBtn"), settingsPanel = $("settingsPanel");
  settingsBtn.addEventListener("click", () => toggleSettingsPanel());

  document.addEventListener("click", (ev) => {
    // Exclude the whole button subtree so opening clicks don't count as
    // outside clicks and immediately close the panel again.
    if (!settingsPanel.hidden && !settingsPanel.contains(ev.target) && !settingsBtn.contains(ev.target)) {
      toggleSettingsPanel(false);
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !settingsPanel.hidden) toggleSettingsPanel(false);
  });

  settingsPanel.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.themeChoice;
      setSetting(THEME_KEY, c === "auto" ? null : c);
      applySettings();
    });
  });
  // keep theme in sync with the OS while in auto mode
  darkQuery.addEventListener?.("change", applySettings);

  $("textSmaller").addEventListener("click", () => stepTextSize(-1));
  $("textLarger").addEventListener("click", () => stepTextSize(1));

  $("densityToggle").addEventListener("change", (ev) => {
    setSetting(DENSITY_KEY, ev.target.checked ? "compact" : null);
    applySettings();
  });

  $("offlineDownloadBtn").addEventListener("click", () => {
    // user gesture — some browsers prompt for persistent storage
    try { navigator.storage?.persist?.(); } catch { /* best effort */ }
    downloadCorpus();
  });

  $("refreshDataBtn").addEventListener("click", async () => {
    if ("caches" in window) await caches.delete(DATA_CACHE);
    location.reload();
  });

  $("aboutBtn").addEventListener("click", () => {
    toggleSettingsPanel(false);
    location.hash = H.about();
  });

  $("clearBookmarksBtn").addEventListener("click", () => {
    if (!S.bookmarks.length) return;
    if (!confirm(`Remove all ${S.bookmarks.length} bookmarks? This cannot be undone.`)) return;
    S.bookmarks = [];
    saveJSON(BM_KEY, S.bookmarks);
    updateBmBadge();
    applySettings();
    render();
  });

  // packaged apps ship the data on disk — offline controls make no sense there
  if (IS_PACKAGED_APP) {
    $("offlineDownloadBtn").closest(".setting-row").hidden = true;
    $("refreshDataBtn").closest(".setting-row").hidden = true;
  }
}

// -----------------------------
// MOBILE NAV
// -----------------------------
// On narrow screens the "On this page" outline rail is hidden; a floating
// button in the bottom-right corner of the chapter reader opens it as a
// popover instead.
function setOutlineOpen(open) {
  document.body.classList.toggle("outline-open", open);
  $("outlineFab").setAttribute("aria-expanded", String(open));
  if (open) {
    outlineEl.querySelector(".ol-item.active")?.scrollIntoView({ block: "center" });
  }
}

function wireOutlineFab() {
  const fab = $("outlineFab");
  fab.addEventListener("click", () => {
    setOutlineOpen(!document.body.classList.contains("outline-open"));
  });
  outlineEl.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) setOutlineOpen(false);
  });
  document.addEventListener("click", (ev) => {
    if (document.body.classList.contains("outline-open")
      && !outlineEl.contains(ev.target) && !fab.contains(ev.target)) {
      setOutlineOpen(false);
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.body.classList.contains("outline-open")) setOutlineOpen(false);
  });
}

function wireChrome() {
  const menuBtn = $("menuBtn"), scrim = $("scrim");
  menuBtn.addEventListener("click", () => {
    const open = !document.body.classList.contains("nav-open");
    document.body.classList.toggle("nav-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    scrim.hidden = !open;
  });
  scrim.addEventListener("click", () => {
    document.body.classList.remove("nav-open");
    menuBtn.setAttribute("aria-expanded", "false");
    scrim.hidden = true;
  });
  sidenavEl.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) {
      document.body.classList.remove("nav-open");
      scrim.hidden = true;
    }
  });
}

// -----------------------------
// PWA (install button + offline shell)
// -----------------------------
// Same approach as ../app.js. The Android/iOS shells serve this code from
// files packaged inside the app, where installing makes no sense.
const IS_PACKAGED_APP = location.hostname === "appassets.androidplatform.net"
  || location.protocol === "ctstatutes:";

// Chromium browsers fire beforeinstallprompt when the app is installable; we
// stash the event so the header "Install app" button can re-fire it. iOS
// Safari has no install API at all, so there the button explains the manual
// Share → Add to Home Screen steps instead.
let deferredInstallPrompt = null;

function isInstalledDisplayMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || navigator.standalone === true; // iOS home-screen web app
}

function setupInstallUI() {
  if (IS_PACKAGED_APP || isInstalledDisplayMode()) return;
  const btn = $("installBtn");
  if (!btn) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS reports as Mac

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    btn.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    btn.hidden = true;
    // ask the browser not to evict the cached statutes under disk pressure
    try { navigator.storage?.persist?.(); } catch { /* best effort */ }
    // start fetching the corpus now so it's offline-ready by first launch
    backgroundOfflineDownload(true);
  });

  btn.addEventListener("click", async () => {
    if (isIOS && !deferredInstallPrompt) {
      alert("To install: tap the Share button in Safari, then choose “Add to Home Screen”.");
      return;
    }
    if (!deferredInstallPrompt) return;
    const ev = deferredInstallPrompt;
    deferredInstallPrompt = null;
    ev.prompt();
    const choice = await ev.userChoice.catch(() => null);
    if (choice?.outcome === "accepted") {
      btn.hidden = true;
    } else {
      deferredInstallPrompt = ev; // declined — keep the button so they can retry
    }
  });

  if (isIOS) btn.hidden = false;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || IS_PACKAGED_APP) return;
  // file:// and some embedded contexts don't support SW — offline mode then degrades gracefully
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}

// Fetch the whole corpus (~160 MB): one title at a time, through the service
// worker (which stores it in the shared data cache), skipping files already
// there. Runs a few seconds after boot so it never competes with what the
// user is reading. If the network drops mid-run it just stops; the next
// launch (or button press) picks up the remainder. Since the cache is
// shared, this also lights up the original app's "Downloaded ✓" state.
// Two entry points: automatically when the app is installed (installing is
// the signal of commitment; a casual browser visit stays lightweight and
// just caches what it reads), or manually from Settings.
const offlineDL = { running: false, stored: false, loaded: 0, total: 0 };

// Reflect download progress in the Settings "Download for offline use" control.
function updateOfflineButton() {
  const btn = $("offlineDownloadBtn");
  if (!btn) return;
  const hint = $("offlineHint");
  if (offlineDL.running) {
    btn.disabled = true;
    btn.textContent = `Downloading… ${offlineDL.loaded}/${offlineDL.total}`;
    hint.textContent = "Keep this tab open";
  } else if (offlineDL.stored) {
    btn.disabled = true;
    btn.textContent = "Downloaded ✓";
    hint.textContent = "Available offline";
  } else {
    btn.disabled = false;
    btn.textContent = "Download for offline use";
    hint.textContent = "All statutes";
  }
}

// The data cache persists across launches but download state lives in memory,
// so on a fresh launch Settings would offer to download data already on the
// device. Compare the cache against the master title list.
async function checkOfflineStored() {
  if (IS_PACKAGED_APP || !("caches" in window)) return;
  try {
    const cache = await caches.open(DATA_CACHE);
    const have = new Set((await cache.keys())
      .map((r) => new URL(r.url).pathname.split("/").pop()));
    const files = (S.titles || []).map((t) => t.file).filter(Boolean);
    offlineDL.stored = files.length > 0 && files.every((f) => have.has(f));
  } catch {
    offlineDL.stored = false;
  }
  updateOfflineButton();
}

async function downloadCorpus() {
  if (IS_PACKAGED_APP) return;                       // data is already on disk
  if (offlineDL.running) return;
  if (!("caches" in window) || !("serviceWorker" in navigator)) return;

  offlineDL.running = true;
  updateOfflineButton();
  try {
    // wait until a worker controls the page — fetches aren't cached before that
    // (sw.js calls clients.claim(), so the first visit gains control mid-session)
    await navigator.serviceWorker.ready.catch(() => null);
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => {
        const t = setTimeout(res, 8000);
        navigator.serviceWorker.addEventListener("controllerchange",
          () => { clearTimeout(t); res(); }, { once: true });
      });
      if (!navigator.serviceWorker.controller) return; // try again next launch
    }

    const files = (S.titles || []).map((t) => t.file).filter(Boolean);
    const cache = await caches.open(DATA_CACHE);
    const have = new Set((await cache.keys())
      .map((r) => new URL(r.url).pathname.split("/").pop()));
    const missing = files.filter((f) => !have.has(f));
    offlineDL.total = files.length;
    offlineDL.loaded = files.length - missing.length;
    if (!missing.length) { offlineDL.stored = true; return; }
    updateOfflineButton();

    for (const f of missing) {
      try {
        const resp = await fetch(DATA_DIR + f);
        if (!resp.ok) continue;
        await resp.blob(); // drain so the SW's cache.put of the clone completes
        offlineDL.loaded++;
        updateOfflineButton();
      } catch {
        return; // offline — resume on the next launch
      }
      await new Promise((r) => setTimeout(r, 150)); // stay off the interactive path
    }
    offlineDL.stored = offlineDL.loaded >= offlineDL.total;

    // the corpus is now on the device — ask the browser not to evict it
    try {
      if (!(await navigator.storage?.persisted?.())) navigator.storage?.persist?.();
    } catch { /* best effort */ }
  } finally {
    offlineDL.running = false;
    updateOfflineButton();
  }
}

async function backgroundOfflineDownload(justInstalled = false) {
  // right after an in-browser install the tab is still in browser display
  // mode, so the appinstalled handler passes justInstalled to start early
  if (!justInstalled && !isInstalledDisplayMode()) return;
  if (navigator.connection?.saveData) return;        // respect Data Saver
  return downloadCorpus();
}

// -----------------------------
// GO
// -----------------------------
// the URL names the reading position; don't let the browser fight our scrolls
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
updateBmBadge();
wireOmni();
wireChrome();
wireOutlineFab();
bindSettings();
applySettings();
setupInstallUI();
registerServiceWorker();
boot().catch((e) => {
  readerEl.innerHTML = `<div class="notice">Failed to start: ${esc(e.message)}.
    Serve this folder over HTTP with the <code>data/</code> directory one level up
    (e.g. <code>python -m http.server</code> from <code>CT-Statutes/</code>, then open <code>/next/</code>).</div>`;
});
