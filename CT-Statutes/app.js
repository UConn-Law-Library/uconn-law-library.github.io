/* CT General Statutes Explorer
 * Data: ./data/titles_index.json + ./data/title_XX.json (ct_CGS_Crawl-v2.py)
 *       ./data/infractions.json (parse_infractions.py)
 *       ./data/supplement/*.json (ct_CGS_Supplement_Crawl.py)
 */

"use strict";

// -----------------------------
// CONFIG
// -----------------------------
const APP_VERSION = "1.1.1"; // shown on the About page
const APP_YEAR = 2026;

const DATA_DIR = "./data/";
const MASTER_URL = DATA_DIR + "titles_index.json";
const INFRACTIONS_URL = DATA_DIR + "infractions.json";
const STAT_INDEX_URL = DATA_DIR + "statutes_index.json";
const SEARCH_INDEX_URL = DATA_DIR + "search_index.json";
const DATA_VERSION_URL = DATA_DIR + "version.json";
const SUPPLEMENT_DIR = DATA_DIR + "supplement/";
const SUPPLEMENT_MAP_URL = SUPPLEMENT_DIR + "supplement_map.json";

const MAX_GROUP_RESULTS = 100;     // per result group (sections, infractions, …)
const MAX_FULLTEXT_RESULTS = 200;

// Parsed titles kept in page memory for browsing. Bodies for search come from
// the full-text worker, which never retains them, so a small cache is plenty.
const MAX_CACHED_TITLES = 12;
const MAX_CACHED_SUPP_TITLES = 6;

const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_YIELD_MS = 30;

const DATA_CACHE = "cgs-data-v1";  // must match sw.js

// The Android and iOS apps serve this same code from files packaged inside
// the app (Android: WebView asset origin; iOS: WKWebView custom scheme).
// Every data file is local there, so anything phrased as a network
// "download" is really just a read into memory.
const IS_PACKAGED_APP = location.hostname === "appassets.androidplatform.net"
  || location.protocol === "ctstatutes:";

const BOOKMARKS_KEY = "cgs:bookmarks:v1";
const RECENT_KEY = "cgs:recent:v1";
const RECENT_MAX = 20;   // kept in storage
const HOME_ROWS = 5;     // shown on the home page per section
const THEME_KEY = "cgs:theme";       // "light" | "dark" pins a theme; unset follows the system
const TEXT_SIZE_KEY = "cgs:textsize"; // font scale factor; unset = 1
const DENSITY_KEY = "cgs:density";    // "compact"; unset = comfortable
const DATA_VERSION_KEY = "cgs:data-version:v1";
const TEXT_SIZES = [0.85, 0.925, 1, 1.075, 1.15, 1.25, 1.4];

// -----------------------------
// STATE
// -----------------------------
const state = {
  master: null,
  infractions: null,             // infractions.json payload
  infraBySection: new Map(),     // section_key -> [entry, ...]
  infraById: new Map(),          // entry.id -> entry
  infraCategories: [],           // [{name, slug, count}]

  statIndex: null,               // statutes_index.json payload
  idxBySlug: new Map(),          // heading slug -> heading object
  idxByName: new Map(),          // heading name -> heading object
  idxLetters: new Map(),         // "A" -> [heading, ...]
  idxByRef: new Map(),           // base section key -> Set of headings citing it

  searchIndex: null,             // lightweight complete chapter/section catalog
  searchChapterByKey: new Map(), // `${t}:${c}` -> compact search-index chapter
  dataVersion: null,

  supplement: null,              // supplement_map.json payload (amended-key overlay)
  suppTitleKeys: new Set(),      // title keys with supplement entries
  suppTitleCache: new Map(),     // supplement file name -> loaded title object (LRU)

  titleCache: new Map(),         // title_key -> loaded title object
  titleByKey: new Map(),         // title_key -> master entry
  chapterByKey: new Map(),       // `${t}:${c}` -> chapter
  sectionByKey: new Map(),       // `${t}:${c}:${s}` -> section
  sectionLoc: new Map(),         // section_key -> {t, c} (first occurrence)
  chapterLoc: new Map(),         // chapter number (incl. unpadded) -> {t, c}

  route: { area: "browse", titleKey: null, chapterKey: null, sectionKey: null, category: null, infraId: null, letter: null, headingSlug: null },
  search: {
    q: "", scope: "nav", results: null, posTerms: [],
    // streaming full-text state, fed by ft-worker.js
    ft: { id: 0, q: null, running: false, done: 0, total: 0, rows: [] },
  },
  bookmarks: [],
  recents: [],

  download: { running: false, loaded: 0, total: 0, failed: 0, done: false, bytes: 0 },
  offlineStored: false,          // every title file present in the SW data cache
};

// -----------------------------
// DOM
// -----------------------------
const $ = (id) => document.getElementById(id);
const navEl = $("nav");
const viewEl = $("view");
const crumbsEl = $("crumbs");
const crumbsAsideEl = $("crumbsAside");
const statusPill = $("statusPill");
const qEl = $("q");
const omniPanel = $("omniPanel");
const backBtn = $("backBtn");
const backBtnTop = $("backBtnTop");
const navHeading = $("navHeading");
const bmCountEl = $("bmCount");
const settingsBtn = $("settingsBtn");
const settingsPanel = $("settingsPanel");
const tabs = {
  browse: $("tabBrowse"),
  index: $("tabIndex"),
  infractions: $("tabInfractions"),
  bookmarks: $("tabBookmarks"),
};

// -----------------------------
// HELPERS
// -----------------------------
function debounce(fn, wait = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Escaped HTML with <mark> around the query's positive terms
function highlight(text, query) {
  if (!text) return "";
  let terms = state.search.posTerms;
  if (!terms || !terms.length) {
    terms = (query || "").trim().split(/\s+/).filter(Boolean);
  }
  if (!terms.length) return esc(text);
  // longest first so phrases win over the words inside them
  const tokens = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp("(" + tokens.join("|") + ")", "ig");
  return esc(text).replace(re, "<mark>$1</mark>");
}

function setStatus(text) { statusPill.textContent = text; }

function fmtTitle(t) { return `${t.label}${t.name ? " — " + t.name : ""}`; }
function fmtChapter(c) { return `${c.label}${c.name ? " — " + c.name : ""}`; }
function fmtMoney(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function cite(e) { return e.citation || e.stat_no; }

// "2026-02-13T19:31:26Z" or "2026-06-10" -> "February 13, 2026"
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(/T/.test(iso) ? iso : iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US",
    { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function keyChapter(t, c) { return `${t}:${c}`; }
function keySection(t, c, s) { return `${t}:${c}:${s}`; }

function stripSectionPrefix(label) {
  if (!label) return label;
  return label.replace(/^Sec\.\s*[\d\w\-]+\.\s*/i, "");
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -----------------------------
// ROUTING
// -----------------------------
function parseHash() {
  const h = location.hash || "#/";
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const r = { area: "browse", titleKey: null, chapterKey: null, sectionKey: null, subsectionPath: null, category: null, infraId: null, letter: null, headingSlug: null, query: null, titlesList: false };

  if (parts[0] === "q" || parts[0] === "ft") {
    r.area = "search";
    r.query = parts.slice(1).join("/");
    r.searchScope = parts[0] === "ft" ? "fulltext" : "nav";
    return r;
  }

  if (parts[0] === "x") {
    r.area = "index";
    if (parts[1] === "l" && parts[2]) r.letter = parts[2].toUpperCase();
    if (parts[1] === "h" && parts[2]) r.headingSlug = parts[2];
    return r;
  }
  if (parts[0] === "i") {
    r.area = "infractions";
    if (parts[1] === "c" && parts[2]) r.category = parts[2];
    if (parts[1] === "e" && parts[2]) r.infraId = parts[2];
    return r;
  }
  if (parts[0] === "b") {
    r.area = "bookmarks";
    return r;
  }
  if (parts[0] === "a") {
    r.area = "about";
    return r;
  }
  if (parts[0] === "titles") {
    r.area = "browse";
    r.titlesList = true;
    return r;
  }
  for (let i = 0; i < parts.length; i += 2) {
    const k = parts[i], v = parts[i + 1];
    if (k === "t") r.titleKey = v;
    if (k === "c") r.chapterKey = v;
    if (k === "s") r.sectionKey = v;
    if (k === "p" && /^[0-9a-zA-Z]{1,4}(?:\.[0-9a-zA-Z]{1,4})*$/.test(v || "")) r.subsectionPath = v;
  }
  return r;
}

const hashFor = {
  home: () => "#/",
  titles: () => "#/titles",
  title: (t) => `#/t/${encodeURIComponent(t)}`,
  chapter: (t, c) => `#/t/${encodeURIComponent(t)}/c/${encodeURIComponent(c)}`,
  section: (t, c, s) => `#/t/${encodeURIComponent(t)}/c/${encodeURIComponent(c)}/s/${encodeURIComponent(s)}`,
  subsection: (t, c, s, p) => `${hashFor.section(t, c, s)}/p/${encodeURIComponent(p)}`,
  search: (q) => `#/q/${encodeURIComponent(q)}`,
  fulltext: (q) => `#/ft/${encodeURIComponent(q)}`,
  index: () => "#/x",
  indexLetter: (l) => `#/x/l/${encodeURIComponent(l)}`,
  indexHeading: (slug) => `#/x/h/${encodeURIComponent(slug)}`,
  infractions: () => "#/i",
  infraCategory: (slug) => `#/i/c/${encodeURIComponent(slug)}`,
  infraEntry: (id) => `#/i/e/${encodeURIComponent(id)}`,
  bookmarks: () => "#/b",
  about: () => "#/a",
};

function go(hash) { location.hash = hash; }

function parentHash() {
  const r = state.route;
  if (r.area === "search") return hashFor.home();
  if (r.area === "browse") {
    if (r.subsectionPath) return hashFor.section(r.titleKey, r.chapterKey, r.sectionKey);
    if (r.sectionKey) return hashFor.chapter(r.titleKey, r.chapterKey);
    if (r.chapterKey) return hashFor.title(r.titleKey);
    if (r.titleKey) return hashFor.titles();
    if (r.titlesList) return hashFor.home();
    return null;
  }
  if (r.area === "index") {
    if (r.headingSlug) {
      const h = state.idxBySlug.get(r.headingSlug);
      return h ? hashFor.indexLetter(h.h[0]) : hashFor.index();
    }
    if (r.letter) return hashFor.index();
    return hashFor.home();
  }
  if (r.area === "infractions") {
    if (r.infraId) {
      const e = state.infraById.get(r.infraId);
      return e && e.category ? hashFor.infraCategory(slugify(e.category)) : hashFor.infractions();
    }
    if (r.category) return hashFor.infractions();
    return hashFor.home();
  }
  if (r.area === "bookmarks" || r.area === "about") return hashFor.home();
  return null;
}

// -----------------------------
// SETTINGS (theme, text size, density)
// -----------------------------
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
  return t === "light" || t === "dark" || t === "oled" ? t : null;
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
  const eff = effectiveTheme();
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", eff === "oled" ? "#000000" : eff === "dark" ? "#14161b" : "#1e4fa3");

  const scale = textScale();
  if (scale === 1) root.style.removeProperty("--font-scale");
  else root.style.setProperty("--font-scale", String(scale));

  const compact = getSetting(DENSITY_KEY) === "compact";
  if (compact) root.dataset.density = "compact";
  else delete root.dataset.density;

  // reflect state in the panel controls
  const choice = pinned || "auto";
  settingsPanel.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeChoice === choice));
  });
  $("textSizeValue").textContent = Math.round(scale * 100) + "%";
  $("textSmaller").disabled = TEXT_SIZES.indexOf(scale) === 0;
  $("textLarger").disabled = TEXT_SIZES.indexOf(scale) === TEXT_SIZES.length - 1;
  $("densityToggle").checked = compact;
  $("bookmarkHint").textContent = state.bookmarks.length
    ? `${state.bookmarks.length} saved` : "None saved";
  $("clearBookmarksBtn").disabled = !state.bookmarks.length;
  updateOfflineButton();
}

function stepTextSize(delta) {
  const i = TEXT_SIZES.indexOf(textScale()) + delta;
  const next = TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, i))];
  setSetting(TEXT_SIZE_KEY, next === 1 ? null : String(next));
  applySettings();
}

function toggleSettingsPanel(open) {
  const show = open ?? settingsPanel.hidden;
  settingsPanel.hidden = !show;
  settingsBtn.setAttribute("aria-expanded", String(show));
  if (show) applySettings();
}

function bindSettings() {
  settingsBtn.addEventListener("click", () => toggleSettingsPanel());

  document.addEventListener("click", (ev) => {
    // Exclude the whole button subtree: clicking its inner label makes
    // ev.target the <span>, which would otherwise count as an outside click
    // and immediately close the panel the button just opened.
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

  // navigation link inside the panel — close it so the page it opens is visible
  $("aboutLink").addEventListener("click", () => toggleSettingsPanel(false));

  $("offlineDownloadBtn").addEventListener("click", () => {
    requestPersistentStorage(); // user gesture — some browsers prompt
    downloadAllTitles();
    updateOfflineButton();
  });

  $("refreshDataBtn").addEventListener("click", async () => {
    if ("caches" in window) await caches.delete(DATA_CACHE);
    location.reload();
  });

  $("clearBookmarksBtn").addEventListener("click", () => {
    if (!state.bookmarks.length) return;
    if (!confirm(`Remove all ${state.bookmarks.length} bookmarks? This cannot be undone.`)) return;
    state.bookmarks = [];
    saveBookmarks();
    applySettings();
    render();
  });
}

function configurePackagedApp() {
  if (!IS_PACKAGED_APP) return;
  const refreshRow = $("refreshDataBtn")?.closest(".setting-row");
  if (refreshRow) refreshRow.hidden = true;
  const offlineRow = $("offlineDownloadBtn")?.closest(".setting-row");
  if (offlineRow) offlineRow.hidden = true;
}

// -----------------------------
// BOOKMARKS (localStorage)
// -----------------------------
function loadBookmarks() {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    state.bookmarks = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.bookmarks)) state.bookmarks = [];
  } catch {
    state.bookmarks = [];
  }
}

function saveBookmarks() {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(state.bookmarks));
  } catch { /* storage full or unavailable — bookmark stays for this session */ }
  updateBookmarkBadge();
}

function updateBookmarkBadge() {
  const n = state.bookmarks.length;
  bmCountEl.hidden = n === 0;
  bmCountEl.textContent = String(n);
}

function findSectionBookmark(t, c, s) {
  return state.bookmarks.findIndex((b) => b.type === "s" && b.t === t && b.c === c && b.s === s);
}

function findInfraBookmark(id) {
  return state.bookmarks.findIndex((b) => b.type === "i" && b.id === id);
}

function toggleSectionBookmark(t, c, s, label) {
  const i = findSectionBookmark(t, c, s);
  if (i >= 0) state.bookmarks.splice(i, 1);
  else state.bookmarks.push({ type: "s", t, c, s, label, ts: Date.now() });
  saveBookmarks();
}

function toggleInfraBookmark(id, statNo, label) {
  const i = findInfraBookmark(id);
  if (i >= 0) state.bookmarks.splice(i, 1);
  else state.bookmarks.push({ type: "i", id, statNo, label, ts: Date.now() });
  saveBookmarks();
}

// -----------------------------
// RECENTLY VIEWED (localStorage)
// -----------------------------
function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    state.recents = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.recents)) state.recents = [];
  } catch {
    state.recents = [];
  }
}

function recentIdentity(r) {
  return r.type === "s" ? `s:${r.t}:${r.c}:${r.s}` : `i:${r.id}`;
}

function recordRecent(item) {
  const id = recentIdentity(item);
  state.recents = state.recents.filter((r) => recentIdentity(r) !== id);
  state.recents.unshift({ ...item, ts: Date.now() });
  state.recents.length = Math.min(state.recents.length, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recents));
  } catch { /* private mode — recents last for this session only */ }
}

// -----------------------------
// SHARING
// -----------------------------
// CT statutes commonly nest paragraphs as (a) -> (1) -> (A) -> (i) -> (I).
// Rebuild that path from the crawler's flat paragraphs so every subdivision
// can have a stable URL and a conventional copyable citation.
const SUBSECTION_ORDER = { la: 1, n: 2, ua: 3, lr: 4, ur: 5 };
const SUBSECTION_ROMAN_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

function romanValue(token) {
  const values = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let value = 0;
  for (let i = 0; i < token.length; i++) {
    const current = values[token[i]] || 0;
    const next = values[token[i + 1]] || 0;
    value += current < next ? -current : current;
  }
  return value;
}

function nextAlphaToken(token) {
  if (!/^([a-z])\1*$/i.test(token)) return null;
  const ch = token[0].toLowerCase();
  if (ch === "z") return "a".repeat(token.length + 1);
  return String.fromCharCode(ch.charCodeAt(0) + 1).repeat(token.length);
}

function validSubsectionToken(token) {
  if (/^\d{1,3}$/.test(token)) return true;
  if (/^[a-z]{1,2}$/.test(token) || /^[A-Z]{1,2}$/.test(token)) return true;
  return token.length <= 4 && SUBSECTION_ROMAN_RE.test(token.toLowerCase()) && /^[a-zA-Z]+$/.test(token);
}

function classifySubsectionToken(token, stack) {
  if (/^\d+$/.test(token)) return "n";
  const lower = token === token.toLowerCase();
  const normalized = token.toLowerCase();
  const alpha = lower ? "la" : "ua";
  const roman = lower ? "lr" : "ur";
  if (!SUBSECTION_ROMAN_RE.test(normalized)) return alpha;
  for (const frame of stack) {
    if (frame.type === roman && romanValue(normalized) === romanValue(frame.last.toLowerCase()) + 1) return roman;
  }
  for (const frame of stack) {
    if (frame.type === alpha && nextAlphaToken(frame.last) === normalized) return alpha;
  }
  if (normalized === "i") {
    const top = stack[stack.length - 1];
    if (top && SUBSECTION_ORDER[top.type] === SUBSECTION_ORDER[roman] - 1) return roman;
  }
  return alpha;
}

function applySubsectionToken(token, stack) {
  const type = classifySubsectionToken(token, stack);
  while (stack.length && SUBSECTION_ORDER[stack[stack.length - 1].type] > SUBSECTION_ORDER[type]) stack.pop();
  const top = stack[stack.length - 1];
  if (top && top.type === type) top.last = token;
  else stack.push({ type, last: token });
  return stack.length;
}

function structureParagraphs(paragraphs) {
  const stack = [];
  return paragraphs.map((paragraph) => {
    const match = /^\s*((?:\([0-9a-zA-Z]{1,4}\)\s*)+)/.exec(paragraph);
    if (!match) return { depth: 0, markers: [], path: [], text: paragraph };
    const tokens = [...match[1].matchAll(/\(([0-9a-zA-Z]{1,4})\)/g)].map((m) => m[1]);
    if (!tokens.every(validSubsectionToken)) return { depth: 0, markers: [], path: [], text: paragraph };
    let depth = 0;
    const markers = [];
    tokens.forEach((token, index) => {
      const nextDepth = applySubsectionToken(token, stack);
      if (index === 0) depth = nextDepth;
      markers.push({ token, path: stack.map((frame) => frame.last).join(".") });
    });
    return { depth, markers, path: stack.map((frame) => frame.last), text: paragraph.slice(match[0].length) };
  });
}

function subsectionSuffix(path) {
  return path ? path.split(".").filter(Boolean).map((token) => `(${token})`).join("") : "";
}

function subsectionCitation(sectionKey, path) {
  return `C.G.S. § ${sectionKey}${subsectionSuffix(path)}`;
}

function paragraphForSubsection(paragraphs, path) {
  if (!path) return null;
  const wanted = path.split(".");
  return structureParagraphs(paragraphs).find((row) =>
    row.path.length >= wanted.length && wanted.every((token, index) => row.path[index] === token)) || null;
}

function appUrlFor(hash) {
  const base = IS_PACKAGED_APP
    ? "https://uconn-law-library.github.io/CT-Statutes/"
    : location.origin + location.pathname;
  return base + hash;
}

function mailtoHref(subject, body) {
  // keep the whole URL well under common mailto length limits
  const max = 1800;
  if (body.length > max) body = body.slice(0, max - 1) + "…";
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function sectionShareText(section, titleEntry, chapter, subsectionPath = null) {
  const label = section.label || `Sec. ${section.section_key}`;
  const paras = (section.content && section.content.body_paragraphs) || [];
  const subsection = paragraphForSubsection(paras, subsectionPath);
  let excerpt = subsection
    ? `${subsection.markers.map((m) => `(${m.token})`).join("")} ${subsection.text}`.trim()
    : paras.join("\n\n");
  if (excerpt.length > 1200) excerpt = excerpt.slice(0, 1199) + "…";
  const hash = subsectionPath
    ? hashFor.subsection(titleEntry.title_key, chapter.chapter_key, section.section_key, subsectionPath)
    : hashFor.section(titleEntry.title_key, chapter.chapter_key, section.section_key);
  const citation = subsectionCitation(section.section_key, subsectionPath);
  const lines = [
    subsectionPath ? `${citation} — ${stripSectionPrefix(label)}` : label,
    `Connecticut General Statutes — ${fmtTitle(titleEntry)}, ${fmtChapter(chapter)}`,
    "",
    excerpt,
    "",
    `View in CT Statutes Explorer: ${appUrlFor(hash)}`,
  ];
  if (section.url) lines.push(`Official text: ${section.url}`);
  let topic = stripSectionPrefix(label) || "";
  if (topic.length > 70) topic = topic.slice(0, 69) + "…";
  const subject = `CGS Sec. ${section.section_key}${subsectionSuffix(subsectionPath)}${topic ? " — " + topic : ""}`;
  return { subject, body: lines.join("\n") };
}

function infraShareText(e) {
  const lines = [
    `${e.description}`,
    `Statute: C.G.S. § ${cite(e)}`,
    e.category ? `Category: ${e.category}` : "",
    "",
  ].filter((l) => l !== "");
  const order = [
    ["total_due", "Total amount due"], ["fine", "Fine"], ["fee", "Additional fee"],
    ["z_fee", "Zone (Z) fee"], ["cost", "Cost"], ["surcharge", "Surcharge"],
    ["stf", "STF surcharge"], ["bipsa", "Brain injury fund (BIPSA)"],
    ["mf", "Municipal fee"], ["plus", "Plus"],
  ];
  for (const [k, name] of order) {
    if (e.amounts && e.amounts[k] != null) lines.push(`${name}: ${fmtMoney(e.amounts[k])}`);
  }
  if (e.note) lines.push(`Note: ${e.note}`);
  lines.push("", `View in CT Statutes Explorer: ${appUrlFor(hashFor.infraEntry(e.id))}`);
  if (state.infractions?.source?.url) lines.push(`Official schedule: ${state.infractions.source.url}`);
  return { subject: `CT Infraction — § ${cite(e)}: ${e.description.slice(0, 80)}`, body: lines.join("\n") };
}

function shareButtonsHtml() {
  const native = navigator.share ? `<button class="btn" data-action="share-native">Share…</button>` : "";
  return `
    <button class="btn" data-action="share-email" title="Share via email">✉️ Email</button>
    ${native}
    <button class="btn" data-action="copy-link" title="Copy permalink">Copy link</button>
  `;
}

function bindShareButtons(container, getShare) {
  container.querySelector('[data-action="share-email"]')?.addEventListener("click", () => {
    const { subject, body } = getShare();
    window.location.href = mailtoHref(subject, body);
  });
  container.querySelector('[data-action="share-native"]')?.addEventListener("click", async () => {
    const { subject, body } = getShare();
    try { await navigator.share({ title: subject, text: body }); } catch { /* cancelled */ }
  });
  const copyBtn = container.querySelector('[data-action="copy-link"]');
  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy link"), 900);
    } catch { /* clipboard unavailable */ }
  });
}

// -----------------------------
// DATA LOADING
// -----------------------------
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}

// Fetch the small version manifest before any legal data. The cache-busting
// query gets through an older installed service worker, allowing this release
// to migrate legacy cache-first data immediately. The current service worker
// identifies offline fallbacks so an offline launch never discards its only
// stored copy.
async function ensureCurrentDataVersion() {
  try {
    const res = await fetch(`${DATA_VERSION_URL}?check=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const manifest = await res.json();
    if (!manifest?.version) return;

    const previous = getSetting(DATA_VERSION_KEY);
    const source = res.headers.get("X-CGS-Version-Source");
    const authoritative = source !== "cache";
    if (!IS_PACKAGED_APP && authoritative && previous !== manifest.version && "caches" in window) {
      await caches.delete(DATA_CACHE);
    }
    setSetting(DATA_VERSION_KEY, manifest.version);
    state.dataVersion = manifest;
  } catch {
    // Offline or an older deployment without a manifest: preserve cached data.
  }
}

async function loadMaster() {
  setStatus("Loading titles index…");
  const master = await fetchJson(MASTER_URL);
  state.master = master;
  state.titleByKey.clear();
  for (const t of master.titles || []) state.titleByKey.set(t.title_key, t);
}

async function loadSearchIndex() {
  const data = await fetchJson(SEARCH_INDEX_URL);
  state.searchIndex = data;
  state.searchChapterByKey.clear();
  for (const chapter of data.chapters || []) {
    state.searchChapterByKey.set(keyChapter(chapter.t, chapter.c), chapter);
    // route in-text "chapter 246" citations without loading any title body
    const loc = { t: chapter.t, c: chapter.c };
    const unpadded = chapter.c.replace(/^0+(?=\d)/, "");
    if (!state.chapterLoc.has(unpadded)) {
      state.chapterLoc.set(unpadded, loc);
      state.chapterLoc.set(chapter.c, loc);
    }
  }
  for (const section of data.sections || []) {
    if (!state.sectionLoc.has(section.s)) {
      state.sectionLoc.set(section.s, { t: section.t, c: section.c });
    }
  }
}

async function loadInfractions() {
  try {
    const data = await fetchJson(INFRACTIONS_URL);
    state.infractions = data;
    state.infraBySection.clear();
    state.infraById.clear();

    const counters = new Map();
    const catCounts = new Map();
    for (const e of data.entries || []) {
      const n = (counters.get(e.section_key) || 0) + 1;
      counters.set(e.section_key, n);
      e.id = `${e.section_key}:${n}`;
      state.infraById.set(e.id, e);

      if (!state.infraBySection.has(e.section_key)) state.infraBySection.set(e.section_key, []);
      state.infraBySection.get(e.section_key).push(e);

      if (e.category) catCounts.set(e.category, (catCounts.get(e.category) || 0) + 1);
    }
    state.infraCategories = [...catCounts.entries()].map(([name, count]) => ({
      name, count, slug: slugify(name),
    }));
  } catch (err) {
    console.warn("Infractions data unavailable:", err);
    state.infractions = null;
  }
}

async function loadStatutesIndex() {
  try {
    const data = await fetchJson(STAT_INDEX_URL);
    state.statIndex = data;
    state.idxBySlug.clear();
    state.idxByName.clear();
    state.idxLetters.clear();

    for (const h of data.headings || []) {
      let slug = slugify(h.h) || "heading";
      while (state.idxBySlug.has(slug)) slug += "-x";
      h.slug = slug;
      state.idxBySlug.set(slug, h);
      state.idxByName.set(h.h, h);
      const letter = /^[A-Z]/.test(h.h) ? h.h[0] : "#";
      if (!state.idxLetters.has(letter)) state.idxLetters.set(letter, []);
      state.idxLetters.get(letter).push(h);

      for (const it of h.items) {
        for (const [, base] of it.r || []) {
          if (!base) continue;
          if (!state.idxByRef.has(base)) state.idxByRef.set(base, new Set());
          state.idxByRef.get(base).add(h);
        }
      }
    }
    // refresh whatever is on screen now that the index is available
    if (state.search.q) {
      runSearch();
      render();
      if (document.activeElement === qEl) renderOmni();
    } else if (state.route.area === "index" || (state.route.area === "browse" && !state.route.titleKey)) {
      render();
    }
  } catch (err) {
    console.warn("Statutes index unavailable:", err);
    state.statIndex = null;
  }
}

// -----------------------------
// 2026 SUPPLEMENT OVERLAY
// -----------------------------
// The supplement is a sparse overlay on the base revision: only amended
// titles/chapters/sections appear. supplement_map.json is small and answers
// "is X amended?" at startup; the per-title supplement files (same shape as
// data/title_XX.json) load on demand when an amended section is viewed.
async function loadSupplementMap() {
  try {
    const data = await fetchJson(SUPPLEMENT_MAP_URL);
    state.supplement = data;
    state.suppTitleKeys = new Set(data.titles || []);
  } catch (err) {
    console.warn("Supplement data unavailable:", err);
    state.supplement = null;
    state.suppTitleKeys = new Set();
  }
}

function suppYear() {
  return state.supplement?.source?.supplement_year || 2026;
}

// The supplement to year Y is read against the statutes revised to Jan 1, Y-1.
function suppReadWithNote() {
  return `intended to be read with the General Statutes revised to January 1, ${suppYear() - 1}`;
}

function suppSectionEntry(sectionKey) {
  return (sectionKey && state.supplement?.sections?.[sectionKey]) || null;
}

// Chapter numbers are unique across the whole CGS, so the overlay keys
// chapters without their title.
function suppChapterEntry(chapterKey) {
  return (chapterKey && state.supplement?.chapters?.[chapterKey]) || null;
}

function suppTagHtml(entry) {
  if (!entry) return "";
  return entry.status === "repealed"
    ? `<span class="tag repealed">Repealed</span>`
    : `<span class="tag supp">${suppYear()} Supp.</span>`;
}

async function ensureSuppTitleLoaded(file) {
  const cached = state.suppTitleCache.get(file);
  if (cached) {
    state.suppTitleCache.delete(file);   // refresh LRU recency
    state.suppTitleCache.set(file, cached);
    return cached;
  }
  const titleObj = await fetchJson(SUPPLEMENT_DIR + file);
  state.suppTitleCache.set(file, titleObj);
  while (state.suppTitleCache.size > MAX_CACHED_SUPP_TITLES) {
    const oldest = state.suppTitleCache.keys().next().value;
    if (oldest === file) break;
    state.suppTitleCache.delete(oldest);
  }
  return titleObj;
}

// Locate a section inside a loaded supplement title. Grouped repeal rows
// cover several keys via section_keys, so match those too.
function findSuppSection(titleObj, sectionKey) {
  for (const c of titleObj.chapters || []) {
    for (const s of c.sections || []) {
      if (s.section_key === sectionKey
        || (Array.isArray(s.section_keys) && s.section_keys.includes(sectionKey))) {
        return { section: s, chapter: c };
      }
    }
  }
  return null;
}

function findSuppChapter(titleObj, chapterKey) {
  return (titleObj.chapters || []).find((c) => c.chapter_key === chapterKey) || null;
}

// Fetch the supplement title file the current route needs (amended section,
// or a supplement-only chapter), so render functions can use it synchronously.
// A failed fetch is fine: the section view falls back to the base text with
// a note, and supplement-only routes show "not found".
async function ensureSupplementForRoute() {
  const { area, titleKey, chapterKey, sectionKey } = state.route;
  if (area !== "browse" || !state.supplement) return;
  let file = null;
  if (sectionKey) {
    file = suppSectionEntry(sectionKey)?.f || null;
  } else if (chapterKey && !state.chapterByKey.has(keyChapter(titleKey, chapterKey))) {
    const entry = suppChapterEntry(chapterKey);
    if (entry) file = `title_${entry.t}.json`;
  }
  if (!file) return;
  try {
    await ensureSuppTitleLoaded(file);
  } catch (err) {
    console.warn("Supplement title unavailable:", err);
  }
}

// Supplement-only chapters of a title (new chapters the base revision lacks),
// for the browse nav. Labels come from the loaded supplement file when it is
// cached; otherwise they are derived from the chapter key.
function suppOnlyChaptersFor(titleKey, baseTitleObj) {
  if (!state.supplement) return [];
  const baseKeys = new Set((baseTitleObj?.chapters || []).map((c) => c.chapter_key));
  const rows = [];
  for (const [chapterKey, entry] of Object.entries(state.supplement.chapters || {})) {
    if (entry.t !== titleKey || baseKeys.has(chapterKey)) continue;
    const cached = state.suppTitleCache.get(`title_${titleKey}.json`);
    const chapter = cached ? findSuppChapter(cached, chapterKey) : null;
    rows.push({
      chapter_key: chapterKey,
      label: chapter?.label || chapLabelFromKey(chapterKey),
      name: chapter?.name || "",
      count: chapter ? (chapter.sections || []).length : null,
    });
  }
  return rows.sort((a, b) => a.chapter_key.localeCompare(b.chapter_key, "en", { numeric: true }));
}

// "023m" -> "Chapter 23m"; UCC article keys "art_012a" -> "Article 12a"
function chapLabelFromKey(chapterKey) {
  const m = chapterKey.match(/^art_0*(\w+)$/);
  if (m) return `Article ${m[1]}`;
  return `Chapter ${chapterKey.replace(/^0+(?=\d)/, "")}`;
}

// Supplement sections of a chapter that the base revision doesn't have
// (sections added by the supplement), for the browse nav.
function suppOnlySectionsFor(titleKey, chapterKey, baseChapter) {
  if (!state.supplement) return [];
  const baseKeys = new Set((baseChapter?.sections || []).map((s) => s.section_key));
  const rows = [];
  for (const [sectionKey, entry] of Object.entries(state.supplement.sections || {})) {
    if (entry.t !== titleKey || entry.c !== chapterKey || baseKeys.has(sectionKey)) continue;
    rows.push({ section_key: sectionKey, label: entry.l, status: entry.status });
  }
  return rows.sort((a, b) => a.section_key.localeCompare(b.section_key, "en", { numeric: true }));
}

function indexLoadedTitle(titleObj) {
  for (const c of titleObj.chapters || []) {
    state.chapterByKey.set(keyChapter(titleObj.title_key, c.chapter_key), c);
    const loc = { t: titleObj.title_key, c: c.chapter_key };
    const unpadded = c.chapter_key.replace(/^0+(?=\d)/, "");
    if (!state.chapterLoc.has(unpadded)) {
      state.chapterLoc.set(unpadded, loc);
      state.chapterLoc.set(c.chapter_key, loc);
    }
    for (const s of c.sections || []) {
      if (!s.section_key) continue;
      state.sectionByKey.set(keySection(titleObj.title_key, c.chapter_key, s.section_key), s);
      if (!state.sectionLoc.has(s.section_key)) {
        state.sectionLoc.set(s.section_key, { t: titleObj.title_key, c: c.chapter_key });
      }
    }
  }
}

// Drop a parsed title from memory, including its entries in the derived
// lookup maps (which would otherwise pin the whole object graph).
// sectionLoc/chapterLoc stay: they hold tiny locators, not section bodies,
// and are seeded from search_index.json anyway.
function evictTitle(titleKey) {
  const titleObj = state.titleCache.get(titleKey);
  if (!titleObj) return;
  state.titleCache.delete(titleKey);
  for (const c of titleObj.chapters || []) {
    state.chapterByKey.delete(keyChapter(titleKey, c.chapter_key));
    for (const s of c.sections || []) {
      if (s.section_key) state.sectionByKey.delete(keySection(titleKey, c.chapter_key, s.section_key));
    }
  }
}

async function ensureTitleLoaded(titleKey) {
  if (!titleKey) return;
  if (state.titleCache.has(titleKey)) {
    // refresh LRU recency (Map preserves insertion order)
    const titleObj = state.titleCache.get(titleKey);
    state.titleCache.delete(titleKey);
    state.titleCache.set(titleKey, titleObj);
    return;
  }
  const entry = state.titleByKey.get(titleKey);
  if (!entry || !entry.file) return;

  setStatus(`Loading ${entry.label}…`);
  const titleObj = await fetchJson(DATA_DIR + entry.file);
  state.titleCache.set(titleKey, titleObj);
  indexLoadedTitle(titleObj);
  while (state.titleCache.size > MAX_CACHED_TITLES) {
    const oldest = state.titleCache.keys().next().value;
    if (oldest === state.route.titleKey || oldest === titleKey) break;
    evictTitle(oldest);
  }
  setStatus("Ready");
}

function setDownloadStatus() {
  const d = state.download;
  if (d.running) {
    setStatus(`Downloading for offline use ${d.loaded}/${d.total}…`);
  } else if (d.done && !d.failed) {
    setStatus("Ready — available offline");
  } else if (d.done) {
    setStatus(`Ready (${d.failed} title${d.failed === 1 ? "" : "s"} failed to download)`);
  } else {
    setStatus("Ready");
  }
  updateOfflineButton();
}

// Reflect download progress in the settings "Download" control (offline
// copy). The bulk download is opt-in via this button only; browsing and
// full-text search store titles as a side effect of the cache-first worker,
// so nothing is fetched wholesale without an explicit request.
function updateOfflineButton() {
  const btn = $("offlineDownloadBtn");
  if (!btn) return;
  const hint = $("offlineHint");
  const d = state.download;
  if (d.running) {
    btn.disabled = true;
    btn.textContent = `Downloading… ${d.loaded}/${d.total}`;
    if (hint) hint.textContent = "Keep this tab open";
  } else if (d.done) {
    btn.disabled = true;
    btn.textContent = d.failed ? `Downloaded (${d.failed} failed)` : "Downloaded ✓";
    if (hint) hint.textContent = d.failed ? "Some titles failed" : "Available offline";
  } else if (state.offlineStored) {
    btn.disabled = true;
    btn.textContent = "Downloaded ✓";
    if (hint) hint.textContent = "Stored on this device";
  } else {
    btn.disabled = false;
    btn.textContent = "Download";
    if (hint) hint.textContent = "For offline use";
  }
}

// Ask the browser not to evict our origin's storage (Cache Storage holds the
// downloaded statutes). Without this the data survives closing the app but is
// "best effort" — the browser may reclaim it under disk pressure. Chromium
// grants this silently (more readily once the PWA is installed); it never
// blocks, so failures are fine to ignore.
async function requestPersistentStorage() {
  try {
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

// Every data file the bulk offline download covers, as paths relative to
// DATA_DIR: the base title files plus the 2026 Supplement overlay files.
function offlineDataFiles() {
  const files = (state.master?.titles || []).map((t) => t.file).filter(Boolean);
  if (state.supplement) {
    const supp = new Set(["supplement/supplement_map.json"]);
    for (const e of Object.values(state.supplement.sections || {})) {
      if (e.f) supp.add("supplement/" + e.f);
    }
    files.push(...supp);
  }
  return files;
}

// The service worker keeps downloaded titles in Cache Storage across launches,
// but preload state lives in memory, so on a fresh launch the Settings button
// would offer to download data that is already on the device. Compare the data
// cache against the download list and reflect "already stored" in the UI.
// (Match on the /data/-relative path, not the basename: supplement files reuse
// the base files' names in a subdirectory.)
async function checkOfflineStored() {
  if (IS_PACKAGED_APP || !("caches" in window)) return;
  try {
    const cache = await caches.open(DATA_CACHE);
    const keys = await cache.keys();
    const cachedPaths = keys.map((r) => new URL(r.url).pathname);
    const files = offlineDataFiles();
    state.offlineStored = files.length > 0
      && files.every((f) => cachedPaths.some((p) => p.endsWith("/data/" + f)));
  } catch {
    state.offlineStored = false;
  }
  updateOfflineButton();
}

// Fetch every title file so the service worker's cache-first data handler
// stores it. Responses are read and discarded — nothing is parsed or kept in
// page memory; navigation links come from search_index.json and full-text
// search streams bodies through ft-worker.js.
async function downloadAllTitles() {
  if (state.download.running) return;
  const files = offlineDataFiles();
  state.download.running = true;
  state.download.total = files.length;
  state.download.loaded = 0;
  state.download.failed = 0;
  state.download.bytes = 0;

  const queue = [...files];

  async function fetchNext() {
    while (queue.length) {
      const file = queue.shift();
      try {
        const res = await fetch(DATA_DIR + file);
        if (!res.ok) throw new Error(String(res.status));
        state.download.bytes += (await res.arrayBuffer()).byteLength;
      } catch {
        state.download.failed++;
      }
      state.download.loaded++;
      setDownloadStatus();
      await sleep(DOWNLOAD_YIELD_MS);
    }
  }

  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, fetchNext));
  state.download.running = false;
  state.download.done = true;
  if (!state.download.failed) state.offlineStored = true;
  setDownloadStatus();
}

// -----------------------------
// SEARCH
// -----------------------------
// Second dash segment covers UCC citations like 42a-1-201.
const STAT_QUERY_RE = /^(?:sec(?:tion)?\.?\s*|§\s*)?(\d+[a-z]{0,2}-\d+[a-z]{0,3}(?:-\d+[a-z]{0,3})?)\.?$/i;

// The boolean query language (parseQuery / evalQuery / collectPositive and
// the per-title scanner) lives in search-query.js, shared with ft-worker.js.

// --- full-text search, streamed off the main thread ---------------------
// ft-worker.js fetches title files one at a time (cache-first via the
// service worker), scans them, and posts matches back; nothing is retained.
// Where workers are unavailable (some packaged-app WebViews), the same scan
// runs on the main thread with a yield between titles.
let ftWorker = null;
let ftWorkerBroken = false;
let ftRenderTimer = null;

function getFtWorker() {
  if (ftWorkerBroken) return null;
  if (ftWorker) return ftWorker;
  try {
    ftWorker = new Worker("./ft-worker.js");
  } catch {
    ftWorkerBroken = true;
    return null;
  }
  ftWorker.onmessage = (ev) => onFtProgress(ev.data);
  ftWorker.onerror = () => {
    // e.g. the worker script failed to load — redo the search in-page
    ftWorkerBroken = true;
    ftWorker.terminate();
    ftWorker = null;
    const ft = state.search.ft;
    if (ft.running) {
      ft.q = null; // force a restart through the fallback path
      runSearch();
      render();
    }
  };
  return ftWorker;
}

// Re-render at most a few times a second while results stream in, so the
// list stays readable and typing stays responsive.
function scheduleFtRender() {
  if (ftRenderTimer) return;
  ftRenderTimer = setTimeout(() => {
    ftRenderTimer = null;
    if (state.search.q && state.search.scope === "fulltext") {
      runSearch();
      render();
      if (document.activeElement === qEl) renderOmni();
    }
  }, 300);
}

function onFtProgress(msg) {
  const ft = state.search.ft;
  if (!msg || msg.id !== ft.id) return; // stale search
  if (msg.rows) {
    ft.done = msg.done;
    ft.total = msg.total;
    ft.rows.push(...msg.rows);
  }
  if (msg.finished) {
    ft.running = false;
    if (ftRenderTimer) { clearTimeout(ftRenderTimer); ftRenderTimer = null; }
    if (state.search.q && state.search.scope === "fulltext") {
      runSearch();
      render();
      if (document.activeElement === qEl) renderOmni();
    }
    return;
  }
  scheduleFtRender();
}

function startFulltextSearch(qRaw) {
  const ft = state.search.ft;
  if (ft.q === qRaw) return; // already running or finished for this query
  const files = (state.master?.titles || [])
    .filter((t) => t.file)
    .map((t) => ({ key: t.title_key, file: t.file }));
  ft.id++;
  ft.q = qRaw;
  ft.running = true;
  ft.done = 0;
  ft.total = files.length;
  ft.rows = [];

  const worker = getFtWorker();
  const req = { id: ft.id, query: qRaw, dataDir: DATA_DIR, files, max: MAX_FULLTEXT_RESULTS };
  if (worker) worker.postMessage(req);
  else fulltextScanInPage(req);
}

async function fulltextScanInPage(req) {
  const ast = parseQuery(req.query);
  const posTerms = collectPositive(ast);
  let found = 0;
  let done = 0;
  for (const entry of req.files) {
    if (req.id !== state.search.ft.id) return;
    let rows = [];
    try {
      if (ast) {
        const titleObj = await fetchJson(req.dataDir + entry.file);
        rows = scanTitleForQuery(titleObj, ast, posTerms, req.max - found);
      }
    } catch { /* skip unreachable titles; the progress line shows coverage */ }
    if (req.id !== state.search.ft.id) return;
    done++;
    found += rows.length;
    onFtProgress({ id: req.id, done, total: req.files.length, rows });
    if (found >= req.max) break;
    await sleep(15); // keep the page interactive between titles
  }
  onFtProgress({ id: req.id, finished: true, found });
}

function setSearch(q, scope) {
  state.search.q = q.trim();
  state.search.scope = scope;
  runSearch();
  render();
  if (!state.search.q) closeOmni();
}

function cancelFulltextSearch() {
  const ft = state.search.ft;
  if (ft.running) ft.id++; // the worker abandons a stale id between titles
  ft.running = false;
  ft.q = null;
}

function runSearch() {
  const qRaw = state.search.q;
  if (!qRaw) {
    state.search.results = null;
    state.search.posTerms = [];
    cancelFulltextSearch();
    return;
  }
  if (state.search.scope !== "fulltext") cancelFulltextSearch();
  const statMatch = qRaw.match(STAT_QUERY_RE);
  const statKey = statMatch ? statMatch[1].toLowerCase() : null;
  const statTitleKey = statKey ? titleKeyForSection(statKey) : null;
  const ast = parseQuery(qRaw);
  const posTerms = collectPositive(ast);
  state.search.posTerms = posTerms;

  const groups = { sections: [], infractions: [], topics: [], chapters: [], titles: [] };

  const matchesTokens = (hay) => (ast ? evalQuery(ast, hay) : false);

  // --- titles (always available from master)
  for (const t of state.master?.titles || []) {
    const hay = `${t.label} ${t.name || ""}`.toLowerCase();
    if ((statTitleKey && t.title_key === statTitleKey) || matchesTokens(hay)) {
      groups.titles.push({ label: fmtTitle(t), hash: hashFor.title(t.title_key) });
      if (groups.titles.length >= 20) break;
    }
  }

  // --- statute-number lookup across the complete lightweight catalog
  if (statKey) {
    for (const row of state.searchIndex?.sections || []) {
      const skey = row.s;
      if (skey === statKey || skey.startsWith(statKey)) {
        const tEntry = state.titleByKey.get(row.t);
        const ch = state.searchChapterByKey.get(keyChapter(row.t, row.c));
        groups.sections.push({
          exact: skey === statKey,
          label: row.l || `Sec. ${skey}`,
          sub: `${tEntry ? fmtTitle(tEntry) : row.t} • ${ch ? `${ch.l}${ch.n ? " — " + ch.n : ""}` : row.c}`,
          supp: suppSectionEntry(skey),
          hash: hashFor.section(row.t, row.c, skey),
        });
      }
    }
    // sections that exist only in the 2026 Supplement (new since the base revision)
    for (const [skey, e] of Object.entries(state.supplement?.sections || {})) {
      if ((skey === statKey || skey.startsWith(statKey)) && !state.sectionLoc.has(skey)) {
        const tEntry = state.titleByKey.get(e.t);
        groups.sections.push({
          exact: skey === statKey,
          label: e.l || `Sec. ${skey}`,
          sub: `${tEntry ? fmtTitle(tEntry) : e.t} • New — ${suppYear()} Supplement`,
          supp: e,
          hash: hashFor.section(e.t, e.c, skey),
        });
      }
    }
    groups.sections.sort((a, b) => (b.exact - a.exact) || a.label.localeCompare(b.label, "en", { numeric: true }));
    groups.sections = groups.sections.slice(0, MAX_GROUP_RESULTS);

    for (const [skey, entries] of state.infraBySection.entries()) {
      if (skey === statKey || skey.startsWith(statKey)) {
        for (const e of entries) {
          groups.infractions.push({
            exact: skey === statKey,
            label: e.description,
            sub: `§ ${cite(e)}${e.category ? " • " + e.category : ""}`,
            amount: e.amounts?.total_due,
            hash: hashFor.infraEntry(e.id),
          });
        }
      }
    }
    groups.infractions.sort((a, b) => (b.exact - a.exact) || a.sub.localeCompare(b.sub, "en", { numeric: true }));
    groups.infractions = groups.infractions.slice(0, MAX_GROUP_RESULTS);

    // index topics that cite this section
    for (const h of state.idxByRef.get(statKey) || []) {
      groups.topics.push({
        label: h.h,
        sub: `cites § ${statKey} — ${h.items.length} entries`,
        hash: hashFor.indexHeading(h.slug),
      });
      if (groups.topics.length >= 50) break;
    }
  }

  if (state.search.scope === "fulltext" && !statKey) {
    // full text of statute bodies: streamed in by ft-worker.js, which scans
    // every title without keeping any of them in page memory
    startFulltextSearch(qRaw);
    for (const row of state.search.ft.rows) {
      const tEntry = state.titleByKey.get(row.t);
      groups.sections.push({
        label: stripSectionPrefix(row.label) || row.s,
        sub: `${tEntry ? fmtTitle(tEntry) : row.t} • ${row.cLabel}`,
        snippet: row.snippet,
        supp: suppSectionEntry(row.s),
        hash: hashFor.section(row.t, row.c, row.s),
      });
      if (groups.sections.length >= MAX_FULLTEXT_RESULTS) break;
    }
  } else if (!statKey) {
    // label search: every chapter + section, without loading the body files
    for (const c of state.searchIndex?.chapters || []) {
      const cHay = `${c.l || ""} ${c.n || ""}`.toLowerCase();
      if (matchesTokens(cHay)) {
        const tEntry = state.titleByKey.get(c.t);
        groups.chapters.push({
          label: `${c.l}${c.n ? " — " + c.n : ""}`,
          sub: tEntry ? fmtTitle(tEntry) : c.t,
          hash: hashFor.chapter(c.t, c.c),
        });
        if (groups.chapters.length >= MAX_GROUP_RESULTS) break;
      }
    }
    for (const s of state.searchIndex?.sections || []) {
      const sHay = `${s.l || ""} ${s.s}`.toLowerCase();
      if (matchesTokens(sHay)) {
        const tEntry = state.titleByKey.get(s.t);
        const ch = state.searchChapterByKey.get(keyChapter(s.t, s.c));
        groups.sections.push({
          label: s.l || s.s,
          sub: `${tEntry ? fmtTitle(tEntry) : s.t} • ${ch ? `${ch.l}${ch.n ? " — " + ch.n : ""}` : s.c}`,
          supp: suppSectionEntry(s.s),
          hash: hashFor.section(s.t, s.c, s.s),
        });
        if (groups.sections.length >= MAX_GROUP_RESULTS) break;
      }
    }
    // labels of sections that exist only in the 2026 Supplement
    for (const [skey, e] of Object.entries(state.supplement?.sections || {})) {
      if (groups.sections.length >= MAX_GROUP_RESULTS) break;
      if (state.sectionLoc.has(skey)) continue;
      if (matchesTokens(`${e.l || ""} ${skey}`.toLowerCase())) {
        const tEntry = state.titleByKey.get(e.t);
        groups.sections.push({
          label: e.l || skey,
          sub: `${tEntry ? fmtTitle(tEntry) : e.t} • New — ${suppYear()} Supplement`,
          supp: e,
          hash: hashFor.section(e.t, e.c, skey),
        });
      }
    }
    // subject-index headings by keyword
    for (const h of state.statIndex?.headings || []) {
      if (matchesTokens(h.h.toLowerCase())) {
        groups.topics.push({
          label: h.h,
          sub: `${h.items.length} entries`,
          hash: hashFor.indexHeading(h.slug),
        });
        if (groups.topics.length >= 50) break;
      }
    }
    // infractions by keyword
    for (const e of state.infractions?.entries || []) {
      const hay = `${e.stat_no} ${cite(e)} ${e.description} ${e.category || ""}`.toLowerCase();
      if (matchesTokens(hay)) {
        groups.infractions.push({
          label: e.description,
          sub: `§ ${cite(e)}${e.category ? " • " + e.category : ""}`,
          amount: e.amounts?.total_due,
          hash: hashFor.infraEntry(e.id),
        });
        if (groups.infractions.length >= MAX_GROUP_RESULTS) break;
      }
    }
  }

  state.search.results = groups;
}

// Quick mixed-result panel adapted from the /next/ reader. Its rows come
// from runSearch(), so the same Boolean AST drives both these suggestions
// and the complete metadata/full-text result views.
let omniSelection = -1;

function omniItems() {
  return [...omniPanel.querySelectorAll(".omni-item")];
}

function closeOmni() {
  omniPanel.hidden = true;
  qEl.setAttribute("aria-expanded", "false");
  qEl.removeAttribute("aria-activedescendant");
  omniSelection = -1;
}

function renderOmni() {
  const q = qEl.value.trim();
  if (!q || q !== state.search.q) {
    closeOmni();
    return;
  }

  const g = state.search.results || { sections: [], infractions: [], topics: [], chapters: [], titles: [] };
  const rows = [];
  const addRows = (kind, items, limit, map) => {
    for (const item of items.slice(0, limit)) rows.push({ kind, ...map(item) });
  };

  addRows("Section", g.sections || [], 5, (r) => ({
    hash: r.hash, title: r.label, sub: r.sub || "", amount: null,
  }));
  addRows("Title", g.titles || [], 2, (r) => ({
    hash: r.hash, title: r.label, sub: "", amount: null,
  }));
  addRows("Chapter", g.chapters || [], 3, (r) => ({
    hash: r.hash, title: r.label, sub: r.sub || "", amount: null,
  }));
  addRows("Topic", g.topics || [], 3, (r) => ({
    hash: r.hash, title: r.label, sub: r.sub || "", amount: null,
  }));
  addRows("Fine", g.infractions || [], 3, (r) => ({
    hash: r.hash, title: r.label, sub: r.sub || "", amount: r.amount,
  }));

  if (!rows.length) {
    const pending = !state.statIndex ? " Index topics are still loading." : "";
    omniPanel.innerHTML = `<div class="omni-empty">No quick matches.${pending}
      Press <b>Enter</b> for complete results; Boolean operators are supported.</div>`;
  } else {
    const clamp = (s, max = 150) => s.length > max ? s.slice(0, max) + "..." : s;
    omniPanel.innerHTML = rows.map((row, i) => `
      <a class="omni-item" id="omniOption${i}" role="option" aria-selected="false"
         data-omni-index="${i}" href="${esc(row.hash)}">
        <span class="omni-kind">${esc(row.kind)}</span>
        <span class="omni-main">${highlight(clamp(row.title), q)}</span>
        ${row.amount != null ? `<span class="omni-amount">${fmtMoney(row.amount)}</span>` : ""}
        ${row.sub ? `<span class="omni-sub">${esc(clamp(row.sub, 180))}</span>` : ""}
      </a>`).join("");
  }

  const ft = state.search.ft;
  const progress = state.search.scope === "fulltext" && ft.running
    ? `Searching full text: ${ft.done}/${ft.total} titles`
    : "Enter: all results | Up/Down: choose | Esc: close";
  omniPanel.insertAdjacentHTML("beforeend", `<div class="omni-foot">${esc(progress)}</div>`);
  omniPanel.hidden = false;
  qEl.setAttribute("aria-expanded", "true");
  omniSelection = -1;
}

function moveOmniSelection(delta) {
  const items = omniItems();
  if (!items.length) return false;
  omniSelection = (omniSelection + delta + items.length) % items.length;
  items.forEach((item, i) => {
    const selected = i === omniSelection;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  const active = items[omniSelection];
  qEl.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
  return true;
}

// -----------------------------
// RENDER — shared widgets
// -----------------------------

// Wrap statute citations in already-escaped text with links. Tokens only
// link when they resolve in the loaded data, which filters false positives
// like year ranges ("2019-2020" is not a section). Run on escaped HTML.
function linkifyCitations(escapedText, selfKey) {
  // UCC keys carry a second dash and an uppercase article letter (42a-2A-303);
  // stored section keys are lowercase, so match loosely and look up lowercased.
  let html = escapedText.replace(/\b(\d+[a-zA-Z]{0,3}-\d+[a-zA-Z]{0,3}(?:-\d+[a-zA-Z]{0,3})?)\b((?:\([0-9a-zA-Z]{1,4}\))*)/g,
    (token, base, suffix, offset, str) => {
    const key = base.toLowerCase();
    if (key === selfKey && !suffix) return token;
    // public/special act numbers ("P.A. 14-130") share the section format
    const before = str.slice(Math.max(0, offset - 12), offset);
    if (/(?:P\.?A\.?|S\.?A\.?|act)\s*$/i.test(before)) return token;
    const loc = state.sectionLoc.get(key);
    if (!loc) return token;
    const path = suffix
      ? [...suffix.matchAll(/\(([0-9a-zA-Z]{1,4})\)/g)].map((m) => m[1]).join(".")
      : null;
    const hash = path ? hashFor.subsection(loc.t, loc.c, key, path) : hashFor.section(loc.t, loc.c, key);
    return `<a href="${hash}">${token}</a>`;
  });
  html = html.replace(/\b(chapters?\s+)(\d+[a-z]?)\b/gi, (m, word, num) => {
    const loc = state.chapterLoc.get(num.toLowerCase());
    if (!loc) return m;
    return `${word}<a href="${hashFor.chapter(loc.t, loc.c)}">${num}</a>`;
  });
  return html;
}

function renderStatuteParagraphs(paragraphs, titleKey, chapterKey, sectionKey, interactive = true) {
  return structureParagraphs(paragraphs).map((row) => {
    if (!row.markers.length) return `<p>${linkifyCitations(esc(row.text), sectionKey)}</p>`;
    const path = row.path.join(".");
    const markers = row.markers.map((marker) => {
      if (!interactive) return `<span class="subsection-marker">(${esc(marker.token)})</span>`;
      const href = hashFor.subsection(titleKey, chapterKey, sectionKey, marker.path);
      const markerCitation = subsectionCitation(sectionKey, marker.path);
      return `<a class="subsection-marker" href="${href}" title="Link to ${esc(markerCitation)}">(${esc(marker.token)})</a>`;
    }).join("");
    if (!interactive) return `<p class="statute-paragraph" style="--subsection-depth:${Math.min(row.depth, 6)}">
      ${markers} ${linkifyCitations(esc(row.text), sectionKey)}</p>`;
    const citation = subsectionCitation(sectionKey, path);
    return `<p class="statute-paragraph" style="--subsection-depth:${Math.min(row.depth, 6)}"
      data-subsection-path="${esc(path)}" tabindex="-1">${markers}
      <button class="copy-citation" type="button" data-copy-citation="${esc(citation)}"
        aria-label="Copy ${esc(citation)}">Copy citation</button>
      ${linkifyCitations(esc(row.text), sectionKey)}</p>`;
  }).join("");
}
function renderList(items) {
  const wrap = document.createElement("div");
  wrap.className = "list";
  for (const it of items) {
    const card = document.createElement(it.hash ? "a" : "div");
    card.className = "card";
    if (it.hash) card.href = it.hash;
    if (it.selected) {
      card.classList.add("selected");
      card.setAttribute("aria-current", "true");
    }
    card.innerHTML = `
      <div class="row-between">
        <div class="kicker">${esc(it.kicker || "")}</div>
        ${it.right || ""}
      </div>
      <div class="title">${it.titleHtml ? it.titleHtml : esc(it.title)}</div>
      ${it.sub ? `<div class="sub">${it.subHtml ? it.subHtml : esc(it.sub)}</div>` : ""}
    `;
    wrap.appendChild(card);
  }
  return wrap;
}

function renderPanel(title, arr, open = false, selfKey = null) {
  const count = Array.isArray(arr) ? arr.length : 0;
  return `
    <details${open && count ? " open" : ""}>
      <summary>${esc(title)} <span class="muted">(${count})</span></summary>
      <div class="panel">
        ${count ? arr.map((p) => `<p>${linkifyCitations(esc(p), selfKey)}</p>`).join("") : `<div class="muted">None.</div>`}
      </div>
    </details>
  `;
}

function renderAnnotationsPanel(title, arr, selfKey = null) {
  const count = Array.isArray(arr) ? arr.length : 0;
  return `
    <details>
      <summary>${esc(title)} <span class="muted">(${count})</span></summary>
      <div class="panel">
        ${count
      ? arr.map((a) => {
        const text = linkifyCitations(esc(a.text || ""), selfKey);
        return `<p>${a.first ? `<strong>${text}</strong>` : text}</p>`;
      }).join("")
      : `<div class="muted">None.</div>`}
      </div>
    </details>
  `;
}

function amountTag(e) {
  if (e.amounts && e.amounts.total_due != null) {
    return `<span class="tag amount">${fmtMoney(e.amounts.total_due)}</span>`;
  }
  if (e.note) return `<span class="tag">varies</span>`;
  return "";
}

function setTab(area) {
  for (const [name, el] of Object.entries(tabs)) {
    if (name === area) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
}

// -----------------------------
// RENDER — main dispatcher
// -----------------------------

// On phones the navigation list is hidden whenever the main view stands on
// its own (statute section, infraction entry, all index/bookmark views,
// search results) so the content gets the full screen.
function mobileNeedsAside() {
  if (state.search.q) return false;
  const r = state.route;
  if (r.area === "browse") return r.titlesList || (!!r.titleKey && !r.sectionKey);
  if (r.area === "infractions") return !r.category && !r.infraId;
  return false;
}

function setBackButtons(hidden) {
  backBtn.hidden = hidden;
  backBtnTop.hidden = hidden;
}

function render() {
  renderInner();
  // mobile title/chapter browsing shows the breadcrumbs in the list header
  crumbsAsideEl.innerHTML = crumbsEl.innerHTML;
}

function renderInner() {
  updateBookmarkBadge();
  document.body.classList.toggle("no-aside", !mobileNeedsAside());
  // multi-pane sidebar width only applies while browsing; renderBrowseNav resets it
  document.body.removeAttribute("data-nav-cols");
  const r = state.route;
  document.body.classList.toggle("list-nav",
    !state.search.q && (
      (r.area === "browse" && (r.titlesList || (!!r.titleKey && !r.sectionKey))) ||
      (r.area === "infractions" && !r.category && !r.infraId)
    ));

  if (state.search.q) {
    setTab(null);
    renderSearch();
    setBackButtons(true);
    return;
  }

  setTab(state.route.area);
  const up = parentHash();
  setBackButtons(!up);

  if (state.route.area === "index") {
    renderIndexNav();
    renderIndexView();
  } else if (state.route.area === "infractions") {
    renderInfractionsNav();
    renderInfractionsView();
  } else if (state.route.area === "bookmarks") {
    renderBookmarksNav();
    renderBookmarksView();
  } else if (state.route.area === "about") {
    renderAboutNav();
    renderAboutView();
  } else {
    renderBrowseNav();
    renderBrowseView();
  }
}

// -----------------------------
// RENDER — browse area
// -----------------------------
// Miller-column browse navigation: Titles, Chapters and Sections panes sit
// side by side on desktop, each highlighting the item on the current route.
// On mobile the CSS shows only the deepest pane, preserving the drill-down.
function navColumn(heading, items) {
  const col = document.createElement("div");
  col.className = "nav-col";
  const head = document.createElement("div");
  head.className = "nav-col-head";
  head.textContent = heading;
  col.appendChild(head);
  col.appendChild(renderList(items));
  return col;
}

function navColumnMessage(heading, message) {
  const col = navColumn(heading, []);
  col.insertAdjacentHTML("beforeend", `<div class="empty">${esc(message)}</div>`);
  return col;
}

let connectorRaf = 0;
function scheduleConnector() {
  if (connectorRaf) return;
  connectorRaf = requestAnimationFrame(() => {
    connectorRaf = 0;
    drawNavConnector();
  });
}

// Draws a curve linking the selected card in each pane to the selected card
// in the next one. Anchors are clamped to the visible part of each pane, so
// when a selection is scrolled out of view the line still points toward it.
function drawNavConnector() {
  const svg = navEl.querySelector(".nav-connector");
  if (!svg) return;
  const wrap = svg.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  svg.setAttribute("width", Math.max(1, Math.round(wrapRect.width)));
  svg.setAttribute("height", Math.max(1, Math.round(wrapRect.height)));

  const anchors = [];
  for (const col of wrap.querySelectorAll(".nav-col")) {
    const sel = col.querySelector(".card.selected");
    if (!sel) break; // the chain ends at the first pane without a selection
    const colRect = col.getBoundingClientRect();
    const headH = col.querySelector(".nav-col-head")?.offsetHeight || 0;
    const selRect = sel.getBoundingClientRect();
    const y = Math.max(colRect.top + headH + 12,
      Math.min(colRect.bottom - 12, selRect.top + selRect.height / 2)) - wrapRect.top;
    anchors.push({ left: selRect.left - wrapRect.left, right: selRect.right - wrapRect.left, y });
  }

  let html = "";
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    const mx = (a.right + b.left) / 2;
    html += `<path d="M ${a.right} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.left} ${b.y}"/>`
      + `<circle cx="${a.right}" cy="${a.y}" r="2.5"/>`
      + `<circle cx="${b.left}" cy="${b.y}" r="2.5"/>`;
  }
  svg.innerHTML = html;
}

function renderBrowseNav() {
  const { titleKey, chapterKey, sectionKey } = state.route;
  navEl.innerHTML = "";
  navHeading.textContent = "Browse";

  const cols = document.createElement("div");
  cols.className = "nav-cols";

  cols.appendChild(navColumn("Titles", (state.master?.titles || []).map((t) => ({
    kicker: t.label,
    title: t.name || "(no title name)",
    hash: hashFor.title(t.title_key),
    selected: t.title_key === titleKey,
  }))));

  if (titleKey) {
    const titleObj = state.titleCache.get(titleKey);
    const titleEntry = state.titleByKey.get(titleKey);
    const head = `${titleEntry?.label || "Title"} — chapters`;
    if (!titleObj) {
      cols.appendChild(navColumnMessage(head, `Loading ${titleEntry?.label || "title"}…`));
    } else {
      // amended-but-existing chapters carry no chip — only sections (and
      // wholly new chapters, below) are badged, to keep the panes calm
      const items = (titleObj.chapters || []).map((c) => ({
        kicker: `${c.label} · ${(c.sections || []).length} sections`,
        title: c.name || "(no chapter name)",
        hash: hashFor.chapter(titleKey, c.chapter_key),
        selected: c.chapter_key === chapterKey,
      }));
      // chapters added by the supplement that the base revision doesn't have
      for (const c of suppOnlyChaptersFor(titleKey, titleObj)) {
        items.push({
          kicker: `${c.label}${c.count != null ? ` · ${c.count} sections` : ""}`,
          title: c.name || "(new chapter)",
          hash: hashFor.chapter(titleKey, c.chapter_key),
          selected: c.chapter_key === chapterKey,
          right: `<span class="tag supp">new — ${suppYear()} Supp.</span>`,
        });
      }
      cols.appendChild(navColumn(head, items));
    }
  }

  if (titleKey && chapterKey) {
    const c = state.chapterByKey.get(keyChapter(titleKey, chapterKey));
    const suppChapter = !c && state.suppTitleCache.has(`title_${titleKey}.json`)
      ? findSuppChapter(state.suppTitleCache.get(`title_${titleKey}.json`), chapterKey)
      : null;
    const head = `${c?.label || suppChapter?.label || "Chapter"} — sections`;
    if (!c && !suppChapter) {
      cols.appendChild(navColumnMessage(head, "Loading…"));
    } else if (!c) {
      // supplement-only chapter: every section comes from the supplement file
      cols.appendChild(navColumn(head, (suppChapter.sections || []).map((s) => {
        const key = s.section_key || (s.section_keys || [])[0];
        return {
          kicker: key ? `Sec. ${key}` : "Sections",
          title: stripSectionPrefix(s.label) || "(no label)",
          hash: key ? hashFor.section(titleKey, chapterKey, key) : hashFor.chapter(titleKey, chapterKey),
          selected: key === sectionKey
            || (Array.isArray(s.section_keys) && s.section_keys.includes(sectionKey)),
          right: s.content?.status === "repealed"
            ? `<span class="tag repealed">Repealed</span>`
            : `<span class="tag supp">${suppYear()} Supp.</span>`,
        };
      })));
    } else {
      const items = (c.sections || []).filter((s) => s.section_key).map((s) => ({
        kicker: `Sec. ${s.section_key}`,
        title: stripSectionPrefix(s.label) || "(no label)",
        hash: hashFor.section(titleKey, chapterKey, s.section_key),
        selected: s.section_key === sectionKey,
        right: [
          state.infraBySection.has(s.section_key) ? `<span class="tag">infraction</span>` : "",
          s.content?.status ? `<span class="tag">${esc(s.content.status)}</span>` : "",
          suppTagHtml(suppSectionEntry(s.section_key)),
        ].join(""),
      }));
      // sections added by the supplement that the base chapter doesn't have
      for (const s of suppOnlySectionsFor(titleKey, chapterKey, c)) {
        items.push({
          kicker: `Sec. ${s.section_key}`,
          title: stripSectionPrefix(s.label) || "(no label)",
          hash: hashFor.section(titleKey, chapterKey, s.section_key),
          selected: s.section_key === sectionKey,
          right: s.status === "repealed"
            ? `<span class="tag repealed">Repealed</span>`
            : `<span class="tag supp">new — ${suppYear()} Supp.</span>`,
        });
      }
      cols.appendChild(navColumn(head, items));
    }
  }

  // the pane count drives the sidebar width on desktop (see styles.css)
  document.body.dataset.navCols = String(cols.children.length);

  // overlay tracing the selected Title → Chapter → Section chain; prepended
  // (not appended) so the panes stay the last children — the mobile CSS
  // shows only the last .nav-col via :last-child
  const connector = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  connector.setAttribute("class", "nav-connector");
  connector.setAttribute("aria-hidden", "true");
  cols.prepend(connector);

  navEl.appendChild(cols);

  // keep the active item visible in each pane
  for (const col of cols.querySelectorAll(".nav-col")) {
    const sel = col.querySelector(".card.selected");
    if (sel) col.scrollTop = sel.offsetTop - col.clientHeight / 2 + sel.offsetHeight / 2;
    col.addEventListener("scroll", scheduleConnector, { passive: true });
  }
  drawNavConnector();
}

function renderBrowseView() {
  const { titleKey, chapterKey, sectionKey } = state.route;
  const titleEntry = titleKey ? state.titleByKey.get(titleKey) : null;
  const title = titleKey ? state.titleCache.get(titleKey) : null;
  let chapter = titleKey && chapterKey ? state.chapterByKey.get(keyChapter(titleKey, chapterKey)) : null;
  const section = titleKey && chapterKey && sectionKey
    ? state.sectionByKey.get(keySection(titleKey, chapterKey, sectionKey)) : null;

  // supplement-only routes: a chapter or section that exists only in the
  // 2026 Supplement (ensureSupplementForRoute fetched its title file)
  let suppOnlyChapter = false;
  if (chapterKey && !chapter) {
    const entry = suppChapterEntry(chapterKey);
    const suppTitle = entry ? state.suppTitleCache.get(`title_${entry.t}.json`) : null;
    const found = suppTitle ? findSuppChapter(suppTitle, chapterKey) : null;
    if (found) { chapter = found; suppOnlyChapter = true; }
  }
  let suppOnlySection = null;
  if (sectionKey && !section && suppSectionEntry(sectionKey)) {
    const suppTitle = state.suppTitleCache.get(suppSectionEntry(sectionKey).f);
    suppOnlySection = suppTitle ? findSuppSection(suppTitle, sectionKey) : null;
  }

  crumbsEl.innerHTML = renderBreadcrumbs({
    titleEntry,
    chapter: chapter || suppOnlySection?.chapter,
    section: section || (suppOnlySection ? { section_key: sectionKey } : null),
  });

  if (!titleKey) {
    if (state.route.titlesList) {
      viewEl.innerHTML = `
        <h1 class="h1">Titles</h1>
        <div class="empty">Select a title from the list to drill into its chapters and sections.</div>`;
    } else {
      renderHome();
    }
    return;
  }

  if (!chapterKey) {
    if (!title) {
      viewEl.innerHTML = `
        <h1 class="h1">${esc(titleEntry?.label || "Title")}${titleEntry?.name ? ` — ${esc(titleEntry.name)}` : ""}</h1>
        <div class="empty">Loading title data…</div>`;
      return;
    }
    viewEl.innerHTML = `
      <h1 class="h1">${esc(title.label)}${title.name ? ` — ${esc(title.name)}` : ""}</h1>
      <div class="meta">
        <span class="muted">Chapters: ${(title.chapters || []).length}</span>
        ${title.url ? `<a href="${esc(title.url)}" target="_blank" rel="noopener">Open on cga.ct.gov</a>` : ""}
      </div>
      <div class="empty">Choose a chapter from the list.</div>`;
    return;
  }

  if (!sectionKey) {
    viewEl.innerHTML = `
      <h1 class="h1">${esc(chapter?.label || "Chapter")}${chapter?.name ? ` — ${esc(chapter.name)}` : ""}</h1>
      <div class="meta">
        ${suppOnlyChapter ? `<span class="tag supp">New — ${suppYear()} Supplement</span>` : ""}
        <span class="muted">Sections: ${(chapter?.sections || []).length}</span>
        ${chapter?.url ? `<a href="${esc(chapter.url)}" target="_blank" rel="noopener">Open on cga.ct.gov</a>` : ""}
      </div>
      ${suppOnlyChapter ? `<p class="muted" style="max-width:70ch;">This chapter was added by the
        ${suppYear()} Supplement and does not appear in the General Statutes revised to
        January 1, ${suppYear() - 1}.</p>` : ""}
      <div class="empty">Choose a section from the list.</div>`;
    return;
  }

  if (!section) {
    if (suppOnlySection) {
      renderSectionView(suppOnlySection.section, titleEntry, suppOnlySection.chapter,
        { suppOnly: true, routeKey: sectionKey });
      return;
    }
    viewEl.innerHTML = title
      ? `<div class="empty">Section not found in this chapter.</div>`
      : `<div class="empty">Loading…</div>`;
    return;
  }

  renderSectionView(section, titleEntry, chapter);
}

function renderSectionView(section, titleEntry, chapter, opts = {}) {
  // grouped supplement repeal rows have no single section_key of their own;
  // normalize to the routed key so bookmarks/recents/share all work
  if (!section.section_key && opts.routeKey) {
    section = { ...section, section_key: opts.routeKey };
  }
  const content = section.content || {};
  const body = Array.isArray(content.body_paragraphs) ? content.body_paragraphs : [];
  const source = Array.isArray(content.source) ? content.source : [];
  const history = Array.isArray(content.history) ? content.history : [];
  const annotations = Array.isArray(content.annotations) ? content.annotations : [];
  const infraEntries = state.infraBySection.get(section.section_key) || [];

  // 2026 Supplement overlay for this section (opts.suppOnly means the
  // section object itself already IS the supplement text — a new section)
  const year = suppYear();
  const suppEntry = opts.suppOnly ? null : suppSectionEntry(section.section_key);
  let supp = null;         // {section, chapter} from the supplement title file
  if (suppEntry) {
    const suppTitle = state.suppTitleCache.get(suppEntry.f);
    supp = suppTitle ? findSuppSection(suppTitle, section.section_key) : null;
  }
  const suppContent = supp?.section?.content || (opts.suppOnly ? content : null);
  const suppBody = Array.isArray(suppContent?.body_paragraphs) ? suppContent.body_paragraphs : [];
  const repealed = (suppEntry?.status || suppContent?.status) === "repealed";
  const hasSuppText = (opts.suppOnly || supp) && suppBody.length > 0;

  const xrefKeys = citedSectionKeys(
    hasSuppText && !opts.suppOnly ? [...suppBody, ...body] : (opts.suppOnly ? suppBody : body),
    section.section_key);

  const bookmarked = findSectionBookmark(titleEntry.title_key, chapter.chapter_key, section.section_key) >= 0;

  recordRecent({
    type: "s",
    t: titleEntry.title_key,
    c: chapter.chapter_key,
    s: section.section_key,
    label: section.label || `Sec. ${section.section_key}`,
  });

  // --- supplement blocks -------------------------------------------------
  let suppChip = "";
  let suppBlock = "";
  let bodyBlock;
  const paras = (arr, interactive = true) => renderStatuteParagraphs(
    arr, titleEntry.title_key, chapter.chapter_key, section.section_key, interactive);

  // the supplement chips are the sole provenance notice on the page; the
  // share/email text keeps a spelled-out note, and only the load-failure
  // case below still shows a banner (there the chip alone would mislead)
  if (opts.suppOnly) {
    suppChip = repealed
      ? `<span class="tag repealed">Repealed — ${year} Supplement</span>`
      : `<span class="tag supp">New — ${year} Supplement</span>`;
    bodyBlock = `
      <div class="body">
        ${suppBody.length ? paras(suppBody)
        : `<div class="empty">No statute body text found for this section.</div>`}
      </div>`;
  } else if (suppEntry && hasSuppText) {
    suppChip = repealed
      ? `<span class="tag repealed">Repealed — ${year} Supplement</span>`
      : `<span class="tag supp">Amended — ${year} Supplement</span>`;
    bodyBlock = `
      <div class="body">${paras(suppBody)}</div>
      ${suppContent.source?.length ? renderPanel(`Source (${year} Supplement)`, suppContent.source, false, section.section_key) : ""}
      ${suppContent.history?.length ? renderPanel(`History (${year} Supplement)`, suppContent.history, false, section.section_key) : ""}
      <details class="prior">
        <summary>Text of the ${year - 1} revision <span class="muted">(${repealed ? "repealed" : "superseded"} by the ${year} Supplement)</span></summary>
        <div class="panel">
          ${body.length ? paras(body, false) : `<div class="muted">No body text in the ${year - 1} revision.</div>`}
          ${renderPanel("Source", source, false, section.section_key)}
          ${renderPanel("History", history, false, section.section_key)}
          ${renderAnnotationsPanel("Annotations", annotations, section.section_key)}
        </div>
      </details>`;
  } else {
    if (suppEntry) {
      // amended per the overlay map, but the supplement file didn't load
      suppChip = suppTagHtml(suppEntry);
      const suppUrl = state.supplement?.source?.titles_url;
      suppBlock = `
        <div class="supp-note${repealed ? " repealed" : ""}" role="note">
          <strong>${repealed ? `Repealed by the ${year} Supplement` : `Amended by the ${year} Supplement`}</strong>
          — the supplement text could not be loaded; the text below is the ${year - 1} revision.
          ${suppUrl ? `<a href="${esc(suppUrl)}" target="_blank" rel="noopener">Official ${year} Supplement ↗</a>` : ""}
        </div>`;
    }
    bodyBlock = `
      <div class="body">
        ${body.length ? paras(body)
        : `<div class="empty">No statute body text found for this section.</div>`}
      </div>`;
  }

  viewEl.innerHTML = `
    <div class="section-label">${esc(section.label || `Sec. ${section.section_key}`)}</div>
    <div class="meta">
      ${content.status && !opts.suppOnly ? `<span class="tag">${esc(content.status)}</span>` : ""}
      ${suppChip}
      <button class="btn star" data-action="bookmark" aria-pressed="${bookmarked}"
        aria-label="${bookmarked ? "Remove bookmark" : "Bookmark this section"}">★ ${bookmarked ? "Bookmarked" : "Bookmark"}</button>
      ${shareButtonsHtml()}
      ${section.url ? `<a href="${esc(section.url)}" target="_blank" rel="noopener">Open on cga.ct.gov</a>` : ""}
    </div>

    ${suppBlock}
    ${bodyBlock}

    ${infraEntries.length ? renderInfractionsForSection(infraEntries) : ""}
    ${opts.suppOnly ? `
      ${renderPanel(`Source (${year} Supplement)`, source, false, section.section_key)}
      ${history.length ? renderPanel(`History (${year} Supplement)`, history, false, section.section_key) : ""}
      ${annotations.length ? renderAnnotationsPanel(`Annotations (${year} Supplement)`, annotations, section.section_key) : ""}
    ` : suppEntry && hasSuppText ? "" /* 2025-revision panels live inside details.prior */ : `
      ${renderPanel("Source", source, false, section.section_key)}
      ${renderPanel("History", history, false, section.section_key)}
      ${renderAnnotationsPanel("Annotations", annotations, section.section_key)}
    `}
    ${xrefKeys.length ? renderCrossRefsPanel(xrefKeys) : ""}
  `;

  viewEl.querySelector('[data-action="bookmark"]').addEventListener("click", () => {
    toggleSectionBookmark(
      titleEntry.title_key, chapter.chapter_key, section.section_key,
      section.label || `Sec. ${section.section_key}`
    );
    renderSectionView(section, titleEntry, chapter, opts);
  });

  viewEl.querySelectorAll("[data-copy-citation]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyCitation);
        const old = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = old; }, 900);
      } catch {
        button.textContent = "Copy unavailable";
      }
    });
  });

  // share the current (supplement) text, flagged with its provenance
  const shareSection = hasSuppText
    ? {
      ...section,
      content: {
        ...content,
        body_paragraphs: [
          `[${repealed ? "Repealed by" : "As amended by"} the ${year} Supplement — ${suppReadWithNote()}.]`,
          ...suppBody,
        ],
      },
    }
    : section;
  bindShareButtons(viewEl, () => sectionShareText(
    shareSection, titleEntry, chapter, state.route.subsectionPath));
  bindCrossRefsPanel(xrefKeys);
}

// Title that a section key belongs to, derived from its numeric prefix:
// "2-35" → "02", "38a-707" → "38a". Returns null for unknown titles.
function titleKeyForSection(sectionKey) {
  const m = sectionKey.match(/^(\d+)([a-z]*)-/);
  if (!m) return null;
  const tk = m[1].padStart(2, "0") + m[2];
  return state.titleByKey.has(tk) ? tk : null;
}

// Section keys cited in the given paragraphs, using the same rules as
// linkifyCitations: skip the section's own key and public/special act
// numbers. Keys are kept when their section is already loaded or their
// title exists in the master index (fetched on demand when expanded).
function citedSectionKeys(paragraphs, selfKey) {
  const found = new Set();
  for (const p of paragraphs || []) {
    const str = String(p);
    for (const m of str.matchAll(/\b\d+[a-zA-Z]{0,3}-\d+[a-zA-Z]{0,3}(?:-\d+[a-zA-Z]{0,3})?\b/g)) {
      const key = m[0].toLowerCase();
      if (key === selfKey || found.has(key)) continue;
      const before = str.slice(Math.max(0, m.index - 12), m.index);
      if (/(?:P\.?A\.?|S\.?A\.?|act)\s*$/i.test(before)) continue;
      if (!state.sectionLoc.has(key) && !titleKeyForSection(key)) continue;
      found.add(key);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

// Expandable panel showing the text of every section this one cites, so the
// reader can consult cross-references without leaving the page. Sections in
// titles that haven't loaded yet render as placeholders; opening the panel
// fetches those titles and re-renders it (settled = that fetch already ran,
// so a still-unresolved key is a failure rather than pending).
function renderCrossRefsPanel(keys, settled = false) {
  const items = keys.map((k) => {
    const loc = state.sectionLoc.get(k);
    const s = loc ? state.sectionByKey.get(keySection(loc.t, loc.c, k)) : null;
    if (!loc || (!s && !settled)) {
      return `
      <details class="xref">
        <summary>Sec. ${esc(k)}</summary>
        <div class="panel">
          <div class="muted">${settled ? "This section could not be loaded." : "Loading…"}</div>
        </div>
      </details>`;
    }
    const paras = s?.content?.body_paragraphs || [];
    return `
      <details class="xref">
        <summary>${esc(s?.label || `Sec. ${k}`)}</summary>
        <div class="panel">
          ${paras.length
        ? paras.map((p) => `<p>${linkifyCitations(esc(p), k)}</p>`).join("")
        : `<div class="muted">No body text found for this section.</div>`}
          <p class="small"><a href="${hashFor.section(loc.t, loc.c, k)}">Open Sec. ${esc(k)} →</a></p>
        </div>
      </details>`;
  });
  return `
    <details class="xrefs">
      <summary>Cross-referenced sections <span class="muted">(${keys.length})</span></summary>
      <div class="panel">
        ${items.join("")}
      </div>
    </details>
  `;
}

// First open of the panel fetches any titles the cross-references need,
// then swaps in a fresh render with the loaded text.
function bindCrossRefsPanel(keys) {
  const el = viewEl.querySelector("details.xrefs");
  if (!el) return;
  el.addEventListener("toggle", async () => {
    if (!el.open) return;
    // "missing" means the section body isn't in memory — sectionLoc knows
    // every section's location up front (search_index.json), so test the
    // loaded-body map instead.
    const missing = [...new Set(
      keys.filter((k) => {
        const loc = state.sectionLoc.get(k);
        return !loc || !state.sectionByKey.has(keySection(loc.t, loc.c, k));
      }).map(titleKeyForSection).filter(Boolean)
    )];
    if (!missing.length) return;
    await Promise.all(missing.map((t) => ensureTitleLoaded(t).catch(() => { })));
    const tmp = document.createElement("template");
    tmp.innerHTML = renderCrossRefsPanel(keys, true).trim();
    const next = tmp.content.firstElementChild;
    next.open = true;
    el.replaceWith(next);
  }, { once: true });
}

function renderInfractionsForSection(entries) {
  return `
    <details open>
      <summary>Infraction schedule <span class="muted">(${entries.length})</span></summary>
      <div class="panel">
        <div class="list">
          ${entries.map((e) => `
            <a class="card" href="${hashFor.infraEntry(e.id)}">
              <div class="row-between">
                <div class="kicker">§ ${esc(cite(e))}</div>
                ${amountTag(e)}
              </div>
              <div class="title">${esc(e.description)}</div>
              ${e.note ? `<div class="sub">${esc(e.note)}</div>` : ""}
            </a>`).join("")}
        </div>
        <p class="small muted">Amounts from the ${esc(state.infractions?.source?.title || "infraction schedule")}${state.infractions?.source?.effective ? `, effective ${esc(state.infractions.source.effective)}` : ""}.</p>
      </div>
    </details>
  `;
}

function renderBreadcrumbs({ titleEntry, chapter, section }) {
  const parts = [`<a href="${hashFor.titles()}">Titles</a>`];
  if (titleEntry) parts.push(`<a href="${hashFor.title(titleEntry.title_key)}">${esc(titleEntry.label)}</a>`);
  if (titleEntry && chapter) parts.push(`<a href="${hashFor.chapter(titleEntry.title_key, chapter.chapter_key)}">${esc(chapter.label)}</a>`);
  if (section) parts.push(`<span>Sec. ${esc(section.section_key)}</span>`);
  return parts.join(` <span class="muted">/</span> `);
}

// compact row list for the home page (recents, bookmarks); items share the
// bookmark shape: {type:"s",t,c,s,label} or {type:"i",id,statNo,label}
function renderHomeRows(heading, items, viewAllHash) {
  if (!items.length) return "";
  return `
    <div class="home-section">
      <div class="row-between">
        <h2>${esc(heading)}</h2>
        ${viewAllHash ? `<a class="small" href="${viewAllHash}">View all →</a>` : ""}
      </div>
      <div class="list">
        ${items.map((r) => `
          <a class="card" href="${bookmarkHash(r)}">
            <div class="kicker">${r.type === "s" ? "Statute" : `Infraction § ${esc(r.statNo)}`}</div>
            <div class="title">${esc(r.label)}</div>
          </a>`).join("")}
      </div>
    </div>
  `;
}

function renderHome() {
  const inf = state.infractions;
  viewEl.innerHTML = `
    <h1 class="h1">Connecticut General Statutes</h1>
    <p class="muted" style="max-width:70ch;">Browse and search the Connecticut General Statutes, the official
      subject index, and the Judicial Branch infraction schedule. Search by keyword or statute number, such as
      <a href="#" id="exampleSearch">14-296aa</a>. You can also save bookmarks and share links to sections.</p>

    <div class="home-grid">
      <a class="home-card" href="${hashFor.titles()}">
        <h2>📚 Browse statutes</h2>
        <p>Browse the General Statutes by title, chapter, or section.</p>
      </a>
      <a class="home-card" href="${hashFor.index()}">
        <h2>🔎 Subject index</h2>
        <p>Find statutes by topic in the official Legislative Commissioners' Office index.</p>
      </a>
      <a class="home-card" href="${hashFor.infractions()}">
        <h2>🎫 Infraction schedule</h2>
        <p>Review infractions and violations, including listed fine amounts and links to relevant statutes.${inf?.source?.effective ? ` Effective ${esc(inf.source.effective)}.` : ""}</p>
      </a>
      <a class="home-card" href="${hashFor.bookmarks()}">
        <h2>★ Bookmarks</h2>
        <p>Save sections and infractions for quick access on this device.</p>
      </a>
    </div>
    ${renderHomeRows("🕘 Recently viewed", state.recents.slice(0, HOME_ROWS), null)}
    ${renderHomeRows("★ Bookmarks",
    [...state.bookmarks].sort((a, b) => b.ts - a.ts).slice(0, HOME_ROWS),
    state.bookmarks.length > HOME_ROWS ? hashFor.bookmarks() : null)}
  `;

  $("exampleSearch")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    qEl.value = "14-296aa";
    go(hashFor.search(qEl.value));
  });
}

// -----------------------------
// RENDER — subject index area
// -----------------------------
function renderIndexNav() {
  navEl.innerHTML = "";
  if (!state.statIndex) {
    navHeading.textContent = "Subject index";
    navEl.innerHTML = `<div class="empty">Loading the subject index…</div>`;
    return;
  }

  const { letter, headingSlug } = state.route;
  const current = headingSlug ? state.idxBySlug.get(headingSlug) : null;
  const activeLetter = letter || (current ? current.h[0] : null);

  if (!activeLetter) {
    navHeading.textContent = "Subject index";
    const items = [...state.idxLetters.keys()].sort().map((l) => ({
      kicker: `${state.idxLetters.get(l).length} headings`,
      title: l,
      hash: hashFor.indexLetter(l),
    }));
    navEl.appendChild(renderList(items));
    return;
  }

  navHeading.textContent = `Index — ${activeLetter}`;
  const headings = state.idxLetters.get(activeLetter) || [];
  const items = headings.map((h) => ({
    kicker: `${h.items.length} entries`,
    title: h.h,
    hash: hashFor.indexHeading(h.slug),
    right: current === h ? `<span class="tag">viewing</span>` : "",
  }));
  navEl.appendChild(renderList(items));
}

function refLinkHtml(display, baseKey) {
  if (baseKey) {
    const loc = state.sectionLoc.get(baseKey);
    if (loc) return `<a href="${hashFor.section(loc.t, loc.c, baseKey)}">${esc(display)}</a>`;
  }
  return `<span class="muted">${esc(display)}</span>`;
}

function seeLinkHtml(target) {
  const [name, sub] = target;
  const h = state.idxByName.get(name);
  const label = sub ? `${name}, at ${sub}` : name;
  if (!h) return "";
  return `<a class="see-link" href="${hashFor.indexHeading(h.slug)}">→ ${esc(label)}</a>`;
}

function renderIndexView() {
  crumbsEl.innerHTML = `<a href="${hashFor.index()}">Index</a>`;

  if (!state.statIndex) {
    viewEl.innerHTML = `<div class="empty">The subject index is loading (or unavailable). Try again in a moment.</div>`;
    return;
  }

  const { letter, headingSlug } = state.route;

  if (headingSlug) {
    const h = state.idxBySlug.get(headingSlug);
    if (!h) {
      viewEl.innerHTML = `<div class="empty">Index heading not found.</div>`;
      return;
    }
    crumbsEl.innerHTML += ` <span class="muted">/</span> <a href="${hashFor.indexLetter(h.h[0])}">${esc(h.h[0])}</a>`
      + ` <span class="muted">/</span> <span>${esc(h.h)}</span>`;
    viewEl.innerHTML = `
      <h1 class="h1">${esc(h.h)}</h1>
      <div class="meta"><span class="muted">${h.items.length} entries</span></div>
      <div class="idx-items">
        ${h.items.map((it) => `
          <div class="idx-item" style="--lvl:${it.l}">
            ${esc(it.t)}${it.r ? `<span class="refs">${it.r.map(([d, k]) => refLinkHtml(d, k)).join(",")}</span>` : ""}
            ${it.see ? it.see.map(seeLinkHtml).join("") : ""}
          </div>`).join("")}
      </div>
    `;
    return;
  }

  if (letter) {
    const headings = state.idxLetters.get(letter) || [];
    crumbsEl.innerHTML += ` <span class="muted">/</span> <span>${esc(letter)}</span>`;
    viewEl.innerHTML = `
      <h1 class="h1">Index — ${esc(letter)}</h1>
      <div class="meta"><span class="muted">${headings.length} headings</span></div>
      <div class="list" id="letterList"></div>
    `;
    $("letterList").append(renderList(headings.map((h) => ({
      kicker: `${h.items.length} entries`,
      title: h.h,
      hash: hashFor.indexHeading(h.slug),
    }))));
    return;
  }

  const src = state.statIndex.source || {};
  viewEl.innerHTML = `
    <h1 class="h1">Subject index</h1>
    <div class="meta">
      <span class="muted">${state.statIndex.headings.length.toLocaleString()} headings</span>
      ${src.revised ? `<span class="tag">${esc(src.revised)}</span>` : ""}
      ${src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">Official index (cga.ct.gov)</a>` : ""}
    </div>
    <p class="muted" style="max-width:75ch;">The Legislative Commissioners' Office prepares this official subject
      index to the General Statutes. Select a topic to see the sections listed under it. If you do not find the term
      you expected, try a broader heading or follow an index cross-reference.</p>
    <div class="letter-grid">
      ${[...state.idxLetters.keys()].sort().map((l) =>
    `<a href="${hashFor.indexLetter(l)}">${esc(l)}</a>`).join("")}
    </div>
  `;
}

// -----------------------------
// RENDER — infractions area
// -----------------------------
function renderInfractionsNav() {
  navHeading.textContent = "Infraction categories";
  navEl.innerHTML = "";
  if (!state.infractions) {
    navEl.innerHTML = `<div class="empty">Infraction schedule not available.</div>`;
    return;
  }
  const selected = state.route.category;
  const items = state.infraCategories.map((c) => ({
    kicker: `${c.count} entries`,
    title: c.name,
    hash: hashFor.infraCategory(c.slug),
    right: selected === c.slug ? `<span class="tag">viewing</span>` : "",
  }));
  navEl.appendChild(renderList(items));
}

function renderInfractionsView() {
  const inf = state.infractions;
  crumbsEl.innerHTML = `<a href="${hashFor.infractions()}">Infractions</a>`;

  if (!inf) {
    viewEl.innerHTML = `<div class="empty">The infraction schedule could not be loaded.</div>`;
    return;
  }

  // single entry
  if (state.route.infraId) {
    const e = state.infraById.get(state.route.infraId);
    if (!e) {
      viewEl.innerHTML = `<div class="empty">Infraction not found.</div>`;
      return;
    }
    renderInfractionDetail(e);
    return;
  }

  // category listing
  if (state.route.category) {
    const cat = state.infraCategories.find((c) => c.slug === state.route.category);
    if (!cat) {
      viewEl.innerHTML = `<div class="empty">Category not found.</div>`;
      return;
    }
    crumbsEl.innerHTML += ` <span class="muted">/</span> <span>${esc(cat.name)}</span>`;
    const entries = inf.entries.filter((e) => e.category === cat.name);
    viewEl.innerHTML = `
      <h1 class="h1">${esc(cat.name)}</h1>
      <div class="meta"><span class="muted">${entries.length} entries</span></div>
      <div class="list" id="catList"></div>
    `;
    $("catList").append(renderList(entries.map((e) => ({
      kicker: `§ ${cite(e)}`,
      title: e.description,
      hash: hashFor.infraEntry(e.id),
      right: amountTag(e),
    }))));
    return;
  }

  // overview
  viewEl.innerHTML = `
    <h1 class="h1">Infraction &amp; violation schedule</h1>
    <div class="meta">
      <span class="muted">${inf.entries.length} entries in ${state.infraCategories.length} categories</span>
      ${inf.source?.effective ? `<span class="tag">Effective ${esc(inf.source.effective)}</span>` : ""}
      ${inf.source?.url ? `<a href="${esc(inf.source.url)}" target="_blank" rel="noopener">Official schedule (PDF)</a>` : ""}
    </div>
    <p class="muted" style="max-width:75ch;">This schedule lists fines and total amounts payable through the
      Centralized Infractions Bureau. It is based on the ${esc(inf.source?.title || "schedule")} published by the
      ${esc(inf.source?.publisher || "CT Judicial Branch")}. Select a category or use the search box to find an entry.
      When available, entries include a link to the relevant statute.</p>
    <div class="empty">Select a category to view its entries.</div>
  `;
}

function renderInfractionDetail(e) {
  const cat = e.category ? state.infraCategories.find((c) => c.name === e.category) : null;
  if (cat) {
    crumbsEl.innerHTML += ` <span class="muted">/</span> <a href="${hashFor.infraCategory(cat.slug)}">${esc(cat.name)}</a>`;
  }
  crumbsEl.innerHTML += ` <span class="muted">/</span> <span>§ ${esc(cite(e))}</span>`;

  const bookmarked = findInfraBookmark(e.id) >= 0;

  recordRecent({ type: "i", id: e.id, statNo: cite(e), label: e.description });
  const order = [
    ["fine", "Fine"], ["fee", "Additional fee (C.G.S. § 51-56a(c))"], ["z_fee", "Zone (Z) fee"],
    ["cost", "Cost (C.G.S. § 54-143(a))"], ["surcharge", "Surcharge (C.G.S. § 54-143a)"],
    ["stf", "Special Transportation Fund surcharge"], ["bipsa", "Brain injury fund assessment (BIPSA)"],
    ["mf", "Municipal fee"], ["plus", "Plus"],
  ];
  const rows = order
    .filter(([k]) => e.amounts && e.amounts[k] != null)
    .map(([k, name]) => `<tr><th>${esc(name)}</th><td>${fmtMoney(e.amounts[k])}</td></tr>`);
  const total = e.amounts?.total_due != null
    ? `<tr class="total"><th>Total amount due</th><td>${fmtMoney(e.amounts.total_due)}</td></tr>` : "";

  const loc = e.ref;
  const sectionLink = loc
    ? `<a class="card" href="${hashFor.section(loc.title_key, loc.chapter_key, e.section_key)}">
        <div class="kicker">Underlying statute</div>
        <div class="title">C.G.S. Sec. ${esc(e.section_key)}</div>
        <div class="sub">Open the full statute text</div>
      </a>`
    : `<div class="empty">${e.section_key.startsWith("pa")
        ? `This entry cites a public act (${esc(cite(e))}) not yet folded into the codified statute data.`
        : `The underlying statute (Sec. ${esc(e.section_key)}) is not in the local statute data.`}</div>`;

  viewEl.innerHTML = `
    <div class="section-label">§ ${esc(cite(e))} — infraction/violation</div>
    <div class="meta">
      ${e.category ? `<span class="tag">${esc(e.category)}</span>` : ""}
      ${e.subsequent ? `<span class="tag">subsequent offense</span>` : ""}
      <button class="btn star" data-action="bookmark" aria-pressed="${bookmarked}"
        aria-label="${bookmarked ? "Remove bookmark" : "Bookmark this infraction"}">★ ${bookmarked ? "Bookmarked" : "Bookmark"}</button>
      ${shareButtonsHtml()}
    </div>

    <div class="body"><p>${esc(e.description)}</p></div>

    ${rows.length || total
      ? `<table class="amounts"><tbody>${total}${rows.join("")}</tbody></table>`
      : `<div class="empty">No fixed amount listed${e.note ? ` — ${esc(e.note)}` : ""}.</div>`}
    ${e.note && (rows.length || total) ? `<p class="small muted">${esc(e.note)}</p>` : ""}

    <div style="margin-top:14px; max-width:480px;">${sectionLink}</div>

    <p class="small muted" style="margin-top:16px;">
      Source: ${esc(state.infractions.source?.title || "")}${state.infractions.source?.effective ? `, effective ${esc(state.infractions.source.effective)}` : ""}.
      ${state.infractions.source?.url ? `<a href="${esc(state.infractions.source.url)}" target="_blank" rel="noopener">Official PDF</a>.` : ""}
    </p>
  `;

  viewEl.querySelector('[data-action="bookmark"]').addEventListener("click", () => {
    toggleInfraBookmark(e.id, cite(e), e.description);
    renderInfractionDetail(e);
  });

  bindShareButtons(viewEl, () => infraShareText(e));
}

// -----------------------------
// RENDER — bookmarks area
// -----------------------------
function bookmarkHash(b) {
  return b.type === "s" ? hashFor.section(b.t, b.c, b.s) : hashFor.infraEntry(b.id);
}

function renderBookmarksNav() {
  navHeading.textContent = "Bookmarks";
  navEl.innerHTML = "";
  if (!state.bookmarks.length) {
    navEl.innerHTML = `<div class="empty">No bookmarks yet.</div>`;
    return;
  }
  const items = [...state.bookmarks].sort((a, b) => b.ts - a.ts).map((b) => ({
    kicker: b.type === "s" ? "Statute" : `Infraction § ${b.statNo}`,
    title: b.label,
    hash: bookmarkHash(b),
  }));
  navEl.appendChild(renderList(items));
}

function renderBookmarksView() {
  crumbsEl.innerHTML = `<span class="muted">Bookmarks</span>`;
  if (!state.bookmarks.length) {
    viewEl.innerHTML = `
      <h1 class="h1">Bookmarks</h1>
      <div class="empty">You have not saved any bookmarks. Select <strong>★ Bookmark</strong> on a statute section
        or infraction to save it on this device.</div>`;
    return;
  }

  const sorted = [...state.bookmarks].sort((a, b) => b.ts - a.ts);
  viewEl.innerHTML = `
    <h1 class="h1">Bookmarks</h1>
    <div class="meta"><span class="muted">${sorted.length} saved on this device</span></div>
    <div class="list">
      ${sorted.map((b, i) => `
        <div class="card">
          <div class="row-between">
            <div class="kicker">${b.type === "s" ? "Statute" : `Infraction § ${esc(b.statNo)}`}</div>
            <button class="btn small" data-remove="${i}" aria-label="Remove bookmark">Remove</button>
          </div>
          <div class="title"><a href="${bookmarkHash(b)}">${esc(b.label)}</a></div>
        </div>`).join("")}
    </div>
  `;

  viewEl.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.remove);
      const target = sorted[idx];
      const real = state.bookmarks.indexOf(target);
      if (real >= 0) state.bookmarks.splice(real, 1);
      saveBookmarks();
      render();
    });
  });
}

// -----------------------------
// RENDER — about / data & sources
// -----------------------------
// One record per dataset: what it is, where the official copy lives, and how
// current the local snapshot is. The per-dataset source objects load with the
// data; version.json's summary fills in when a dataset hasn't loaded yet.
function datasetProvenance() {
  const v = state.dataVersion?.sources || {};
  const statutes = state.master?.source || v.statutes || {};
  const index = state.statIndex?.source || v.index || {};
  const infractions = state.infractions?.source || v.infractions || {};
  const supplement = state.supplement?.source || v.supplement || null;
  const datasets = [
    {
      name: "Statute text",
      what: "Connecticut General Statutes text collected from the General Assembly's website.",
      publisher: "Connecticut General Assembly",
      url: statutes.titles_url || "https://www.cga.ct.gov/current/pub/titles.htm",
      dates: [statutes.generated_at_utc
        && `Captured ${fmtDate(statutes.generated_at_utc)}`],
      caveat: "Changes published after the capture date will appear after the site's next data update.",
    },
    {
      name: "Subject index",
      what: "The official subject index prepared by the Legislative Commissioners' Office.",
      publisher: index.publisher || "Connecticut General Assembly, Legislative Commissioners' Office",
      url: index.url || "https://www.cga.ct.gov/lco/statutes-index.asp",
      dates: [index.revised, index.generated && `Parsed ${fmtDate(index.generated)}`],
      caveat: "The official index is revised annually and can trail recently passed legislation.",
    },
    {
      name: "Infractions schedule",
      what: "Chart A of the Judicial Branch schedule, covering mail-in violations and infractions.",
      publisher: infractions.publisher || "State of Connecticut Judicial Branch",
      url: infractions.url || "https://www.jud.ct.gov/webforms/forms/infractions.pdf",
      dates: [infractions.effective && `Effective ${infractions.effective}`,
        infractions.generated && `Parsed ${fmtDate(infractions.generated)}`],
      caveat: "Fine amounts may change. Confirm the amount in the current official schedule before relying on it.",
    },
  ];
  if (supplement) {
    const year = supplement.supplement_year || suppYear();
    datasets.splice(1, 0, {
      name: `${year} Supplement`,
      what: "Sections amended, added, or repealed by the supplement. The site identifies these sections and displays the supplement text when available.",
      publisher: "Connecticut General Assembly",
      url: supplement.titles_url || `https://www.cga.ct.gov/${year}/sup/titles.htm`,
      dates: [supplement.generated_at_utc && `Captured ${fmtDate(supplement.generated_at_utc)}`],
      caveat: `Read the supplement together with the General Statutes revised to January 1, ${year - 1}. It replaces only the sections identified in the supplement.`,
    });
  }
  return datasets;
}

function renderAboutNav() {
  navHeading.textContent = "About";
  navEl.innerHTML = "";
  navEl.appendChild(renderList(datasetProvenance().map((d) => ({
    kicker: d.publisher,
    title: `${d.name} ↗`,
    hash: d.url,
  }))));
  navEl.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener";
  });
}

function renderAboutView() {
  crumbsEl.innerHTML = `<span class="muted">About</span>`;
  const counts = state.dataVersion?.counts;
  const cards = datasetProvenance().map((d) => `
    <div class="card about-source">
      <div class="kicker">${esc(d.publisher)}</div>
      <div class="title">${esc(d.name)}</div>
      <div class="sub">${esc(d.what)}</div>
      ${d.dates.filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join(" ")}
      <div class="sub">${esc(d.caveat)}</div>
      <p class="small"><a href="${esc(d.url)}" target="_blank" rel="noopener">Official source ↗</a></p>
    </div>`).join("");

  viewEl.innerHTML = `
    <div class="about-brand">
      <img src="./wordmark.svg" alt="UConn School of Law — Law Library and Technology" />
    </div>
    <h1 class="h1">About CT General Statutes Explorer</h1>
    <p class="muted">The UConn Law Library provides this tool for searching and browsing the Connecticut
      General Statutes, the official subject index, and the Judicial Branch infraction schedule.</p>
    <p class="about-meta">Version ${APP_VERSION} · ${APP_YEAR}</p>
    <p><a class="btn primary" href="https://library.law.uconn.edu/" target="_blank" rel="noopener">Visit the Law Library ↗</a></p>
    <h2>Data &amp; sources</h2>
    <div class="list">${cards}</div>
    ${counts ? `<p class="small muted">The current data includes ${counts.titles} titles,
      ${Number(counts.chapters).toLocaleString("en-US")} chapters,
      ${Number(counts.sections).toLocaleString("en-US")} statute sections,
      ${Number(counts.index_headings).toLocaleString("en-US")} index headings and
      ${Number(counts.infractions).toLocaleString("en-US")} infraction entries${counts.supplement_sections
      ? `, plus ${Number(counts.supplement_sections).toLocaleString("en-US")} sections
      amended, added or repealed by the ${suppYear()} Supplement` : ""}.</p>` : ""}
    <p class="small muted">The data is updated monthly from official publications. The site checks for updated
      data when it opens. Information about data collection, parsing, and validation is available in the
      <a href="https://github.com/UConn-Law-Library/uconn-law-library.github.io/tree/main/CT-Statutes"
         target="_blank" rel="noopener">public source repository ↗</a>.</p>
  `;
}

// -----------------------------
// RENDER — search results
// -----------------------------
function renderSearch() {
  const g = state.search.results || { sections: [], infractions: [], topics: [], chapters: [], titles: [] };
  const q = state.search.q;
  const totals = g.sections.length + g.infractions.length + (g.topics?.length || 0) + g.chapters.length + g.titles.length;

  navHeading.textContent = `Search results (${totals})`;
  navEl.innerHTML = "";

  const navItems = [
    ...g.sections.slice(0, 30).map((r) => ({ kicker: "Section", title: r.label, titleHtml: highlight(r.label, q), hash: r.hash })),
    ...g.infractions.slice(0, 30).map((r) => ({ kicker: "Infraction", title: r.label, titleHtml: highlight(r.label, q), hash: r.hash })),
  ];
  if (navItems.length) navEl.appendChild(renderList(navItems));
  else navEl.innerHTML = `<div class="empty">No results.</div>`;

  crumbsEl.innerHTML = `<span class="muted">Search</span>`;

  const ft = state.search.ft;
  const stillLoading = state.search.scope === "fulltext" && ft.running
    ? `<span class="tag">searching all statutes — ${ft.done}/${ft.total} titles${IS_PACKAGED_APP || state.offlineStored
      ? "" : " (titles download once, then search from this device)"}</span>` : "";

  const group = (name, items, renderItem) => items.length ? `
    <div class="result-group">
      <h2>${esc(name)} (${items.length}${items.length >= MAX_GROUP_RESULTS ? "+" : ""})</h2>
      <div class="list">${items.map(renderItem).join("")}</div>
    </div>` : "";

  viewEl.innerHTML = `
    <h1 class="h1">Search: “${esc(q)}”</h1>
    <div class="meta">
      <span class="muted">${state.search.scope === "fulltext"
        ? "Full text of statutes"
        : "Titles, chapters, sections, index topics & infractions"}</span>
      ${stillLoading}
      <button class="btn" id="scopeSwitchBtn">${state.search.scope === "fulltext"
        ? "← Back to quick results"
        : "Search full text of all statutes →"}</button>
    </div>
    ${totals === 0 ? `<div class="empty">No results for “${esc(q)}”. Try fewer words, a statute number like “14-227a”,
      the full-text search, or boolean operators — e.g. <code>leash OR muzzle</code>.</div>` : ""}
    <p class="small muted search-tips">Advanced: words combine with AND by default · <code>leash OR muzzle</code> ·
      <code>dog NOT license</code> or <code>-license</code> · <code>"evading responsibility"</code> for exact phrases ·
      <code>(dog OR cat) AND bite</code> — operators must be CAPITALIZED.</p>
    ${group("Statute sections", g.sections, (r) => `
      <a class="card" href="${r.hash}">
        <div class="kicker">Section${r.exact ? ` <span class="tag">exact match</span>` : ""}${r.supp ? ` ${suppTagHtml(r.supp)}` : ""}</div>
        <div class="title">${highlight(r.label, q)}</div>
        ${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ""}
        ${r.snippet ? `<div class="sub">…${highlight(r.snippet, q)}…</div>` : ""}
      </a>`)}
    ${group("Infractions & violations", g.infractions, (r) => `
      <a class="card" href="${r.hash}">
        <div class="row-between">
          <div class="kicker">Infraction</div>
          ${r.amount != null ? `<span class="tag amount">${fmtMoney(r.amount)}</span>` : ""}
        </div>
        <div class="title">${highlight(r.label, q)}</div>
        <div class="sub">${highlight(r.sub, q)}</div>
      </a>`)}
    ${group("Index topics", g.topics || [], (r) => `
      <a class="card" href="${r.hash}">
        <div class="kicker">Index topic</div>
        <div class="title">${highlight(r.label, q)}</div>
        <div class="sub">${esc(r.sub)}</div>
      </a>`)}
    ${group("Chapters", g.chapters, (r) => `
      <a class="card" href="${r.hash}">
        <div class="kicker">Chapter</div>
        <div class="title">${highlight(r.label, q)}</div>
        <div class="sub">${esc(r.sub)}</div>
      </a>`)}
    ${group("Titles", g.titles, (r) => `
      <a class="card" href="${r.hash}">
        <div class="kicker">Title</div>
        <div class="title">${highlight(r.label, q)}</div>
      </a>`)}
  `;

  // replaces the old scope dropdown: widen this query to the statute bodies,
  // or drop back to the quick metadata search
  $("scopeSwitchBtn")?.addEventListener("click", () => {
    const target = state.search.scope === "fulltext" ? hashFor.search(q) : hashFor.fulltext(q);
    if (location.hash === target) applyRoute();
    else go(target);
  });
}

// -----------------------------
// INIT + EVENTS
// -----------------------------
async function applyRoute() {
  closeOmni();
  state.route = parseHash();

  if (state.route.area === "search") {
    state.search.q = (state.route.query || "").trim();
    state.search.scope = state.route.searchScope || "nav";
    qEl.value = state.search.q;
    runSearch();
  } else if (state.search.q || qEl.value) {
    // Navigating away from a search route exits search mode.
    state.search.q = "";
    state.search.scope = "nav";
    state.search.results = null;
    qEl.value = "";
  }

  try {
    if (state.route.area === "browse" && state.route.titleKey) {
      await ensureTitleLoaded(state.route.titleKey);
      await ensureSupplementForRoute();
    }
    render();
    const subsection = state.route.subsectionPath
      ? [...viewEl.querySelectorAll("[data-subsection-path]")].find((element) => {
        const actual = element.dataset.subsectionPath.split(".");
        const wanted = state.route.subsectionPath.split(".");
        return actual.length >= wanted.length && wanted.every((token, index) => actual[index] === token);
      })
      : null;
    if (subsection) {
      subsection.scrollIntoView({ block: "start" });
      subsection.focus({ preventScroll: true });
      subsection.classList.add("subsection-target");
      // A paragraph can begin with several nested markers, such as (a)(1).
      // Make the revealed control copy the marker that was actually selected.
      const copyButton = subsection.querySelector("[data-copy-citation]");
      if (copyButton) {
        const citation = subsectionCitation(state.route.sectionKey, state.route.subsectionPath);
        copyButton.dataset.copyCitation = citation;
        copyButton.setAttribute("aria-label", `Copy ${citation}`);
      }
    } else {
      viewEl.focus({ preventScroll: true });
    }
  } catch (e) {
    setStatus("Error");
    crumbsEl.textContent = "";
    viewEl.innerHTML = `<div class="empty">Failed to load: ${esc(e.message || String(e))}</div>`;
  }
}

function bindUI() {
  // typing while a full-text search is showing keeps that scope; a fresh
  // search starts in the quick "everything" scope (the results page has a
  // button to widen it to full text)
  const currentScope = () => state.search.scope || "nav";
  const navScopeDelay = () => (currentScope() === "fulltext" ? 350 : 180);
  let searchTimer;
  const refreshSearchFromInput = () => {
    setSearch(qEl.value, currentScope());
    if (document.activeElement === qEl) renderOmni();
  };

  qEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshSearchFromInput, navScopeDelay());
  });
  qEl.addEventListener("focus", () => {
    if (!qEl.value.trim()) return;
    clearTimeout(searchTimer);
    if (state.search.q !== qEl.value.trim()) {
      setSearch(qEl.value, currentScope());
    }
    renderOmni();
  });
  qEl.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (omniPanel.hidden || !moveOmniSelection(ev.key === "ArrowDown" ? 1 : -1)) return;
      ev.preventDefault();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      clearTimeout(searchTimer);
      const items = omniItems();
      if (!omniPanel.hidden && omniSelection >= 0 && items[omniSelection]) {
        const target = items[omniSelection].getAttribute("href");
        closeOmni();
        qEl.blur();
        if (location.hash === target) applyRoute();
        else go(target);
      } else {
        const query = qEl.value.trim();
        const target = currentScope() === "fulltext" ? hashFor.fulltext(query) : hashFor.search(query);
        closeOmni();
        qEl.blur();
        if (query) {
          if (location.hash === target) applyRoute();
          else go(target);
        }
      }
      return;
    }
    if (ev.key === "Escape" && !omniPanel.hidden) {
      ev.preventDefault();
      ev.stopPropagation();
      closeOmni();
      qEl.blur();
    }
  });
  omniPanel.addEventListener("mousedown", (ev) => {
    const link = ev.target.closest(".omni-item");
    if (!link) return;
    ev.preventDefault();
    clearTimeout(searchTimer);
    const target = link.getAttribute("href");
    closeOmni();
    qEl.blur();
    if (location.hash === target) applyRoute();
    else go(target);
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".search-omni")) closeOmni();
  });

  const goUp = () => {
    const up = parentHash();
    if (up) go(up);
  };
  backBtn.addEventListener("click", goUp);
  backBtnTop.addEventListener("click", goUp);

  window.addEventListener("hashchange", applyRoute);
  window.addEventListener("resize", scheduleConnector);

  document.addEventListener("keydown", (ev) => {
    const inField = /^(input|select|textarea)$/i.test(document.activeElement?.tagName || "");
    if (ev.key === "/" && !inField) {
      ev.preventDefault();
      qEl.focus();
      qEl.select();
    } else if (ev.key === "Escape" && state.search.q) {
      if (state.route.area === "search") go(hashFor.home());
      else {
        qEl.value = "";
        setSearch("", "nav");
      }
    }
  });
}

// -----------------------------
// PWA INSTALL
// -----------------------------
// Chromium browsers fire beforeinstallprompt when the app is installable; we
// stash the event so the Settings "Install app" button can re-fire it. iOS
// Safari has no install API at all, so there the button explains the manual
// Share → Add to Home Screen steps instead.
let deferredInstallPrompt = null;

function isInstalledDisplayMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || navigator.standalone === true; // iOS home-screen web app
}

function setupInstallUI() {
  if (IS_PACKAGED_APP || isInstalledDisplayMode()) return;
  const row = $("installRow");
  const btn = $("installBtn");
  const hint = $("installHint");
  if (!row || !btn) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS reports as Mac

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    row.hidden = false;
    if (hint) hint.textContent = "Add to home screen";
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    row.hidden = true;
    // Installed apps get persistent storage granted more readily.
    requestPersistentStorage();
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
      row.hidden = true;
    } else {
      deferredInstallPrompt = ev; // declined — keep the button so they can retry
    }
  });

  if (isIOS) {
    row.hidden = false;
    if (hint) hint.textContent = "Share → Add to Home Screen";
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Android packages these files directly; its WebView asset origin is already offline.
  if (IS_PACKAGED_APP) return;
  // file:// and some embedded contexts don't support SW — offline mode then degrades gracefully
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}

(async function main() {
  loadBookmarks();
  loadRecents();
  applySettings();
  bindSettings();
  configurePackagedApp();
  updateBookmarkBadge();
  bindUI();
  setupInstallUI();
  registerServiceWorker();

  try {
    await ensureCurrentDataVersion();
    await Promise.all([loadMaster(), loadInfractions(), loadSearchIndex(), loadSupplementMap()]);
    setStatus("Ready");
    checkOfflineStored(); // async — reflects a previous session's download
    await applyRoute();
    loadStatutesIndex(); // large file — load without blocking first paint
    // Title bodies load on demand: a small LRU while browsing, and streamed
    // through ft-worker.js for full-text search. Nothing preloads the whole
    // corpus into memory — not even the packaged apps, where every file is
    // already on disk and the worker reads it locally.
  } catch (e) {
    setStatus("Error");
    viewEl.innerHTML = `<div class="empty">Failed to load data: ${esc(e.message || String(e))}<br>
      Check that <code>${esc(MASTER_URL)}</code> is reachable.</div>`;
  }
})();
