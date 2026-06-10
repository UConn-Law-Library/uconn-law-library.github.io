/* CT General Statutes Explorer
 * Data: ./data/titles_index.json + ./data/title_XX.json (ct_CGS_Crawl-v2.py)
 *       ./data/infractions.json (parse_infractions.py)
 */

"use strict";

// -----------------------------
// CONFIG
// -----------------------------
const DATA_DIR = "./data/";
const MASTER_URL = DATA_DIR + "titles_index.json";
const INFRACTIONS_URL = DATA_DIR + "infractions.json";
const STAT_INDEX_URL = DATA_DIR + "statutes_index.json";

const MAX_GROUP_RESULTS = 100;     // per result group (sections, infractions, …)
const MAX_FULLTEXT_RESULTS = 200;

const PRELOAD_CONCURRENCY = 3;
const PRELOAD_YIELD_MS = 30;

const DATA_CACHE = "cgs-data-v1";  // must match sw.js

const BOOKMARKS_KEY = "cgs:bookmarks:v1";
const THEME_KEY = "cgs:theme";       // "light" | "dark" pins a theme; unset follows the system
const TEXT_SIZE_KEY = "cgs:textsize"; // font scale factor; unset = 1
const DENSITY_KEY = "cgs:density";    // "compact"; unset = comfortable
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

  titleCache: new Map(),         // title_key -> loaded title object
  titleByKey: new Map(),         // title_key -> master entry
  chapterByKey: new Map(),       // `${t}:${c}` -> chapter
  sectionByKey: new Map(),       // `${t}:${c}:${s}` -> section
  sectionLoc: new Map(),         // section_key -> {t, c} (first occurrence)

  route: { area: "browse", titleKey: null, chapterKey: null, sectionKey: null, category: null, infraId: null, letter: null, headingSlug: null },
  search: { q: "", scope: "nav", results: null },
  bookmarks: [],

  preload: { running: false, loaded: 0, total: 0, failed: 0, done: false },
};

// -----------------------------
// DOM
// -----------------------------
const $ = (id) => document.getElementById(id);
const navEl = $("nav");
const viewEl = $("view");
const crumbsEl = $("crumbs");
const statusPill = $("statusPill");
const qEl = $("q");
const scopeEl = $("scope");
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

// Escaped HTML with <mark> around query tokens
function highlight(text, query) {
  if (!text) return "";
  query = (query || "").trim();
  if (!query) return esc(text);
  const tokens = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!tokens.length) return esc(text);
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
  const r = { area: "browse", titleKey: null, chapterKey: null, sectionKey: null, category: null, infraId: null, letter: null, headingSlug: null };

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
  for (let i = 0; i < parts.length; i += 2) {
    const k = parts[i], v = parts[i + 1];
    if (k === "t") r.titleKey = v;
    if (k === "c") r.chapterKey = v;
    if (k === "s") r.sectionKey = v;
  }
  return r;
}

const hashFor = {
  home: () => "#/",
  title: (t) => `#/t/${encodeURIComponent(t)}`,
  chapter: (t, c) => `#/t/${encodeURIComponent(t)}/c/${encodeURIComponent(c)}`,
  section: (t, c, s) => `#/t/${encodeURIComponent(t)}/c/${encodeURIComponent(c)}/s/${encodeURIComponent(s)}`,
  index: () => "#/x",
  indexLetter: (l) => `#/x/l/${encodeURIComponent(l)}`,
  indexHeading: (slug) => `#/x/h/${encodeURIComponent(slug)}`,
  infractions: () => "#/i",
  infraCategory: (slug) => `#/i/c/${encodeURIComponent(slug)}`,
  infraEntry: (id) => `#/i/e/${encodeURIComponent(id)}`,
  bookmarks: () => "#/b",
};

function go(hash) { location.hash = hash; }

function parentHash() {
  const r = state.route;
  if (r.area === "browse") {
    if (r.sectionKey) return hashFor.chapter(r.titleKey, r.chapterKey);
    if (r.chapterKey) return hashFor.title(r.titleKey);
    if (r.titleKey) return hashFor.home();
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
  if (r.area === "bookmarks") return hashFor.home();
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
    ?.setAttribute("content", effectiveTheme() === "dark" ? "#0f172a" : "#1e3a8a");

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
    if (!settingsPanel.hidden && !settingsPanel.contains(ev.target) && ev.target !== settingsBtn) {
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
// SHARING
// -----------------------------
function appUrlFor(hash) {
  return location.origin + location.pathname + hash;
}

function mailtoHref(subject, body) {
  // keep the whole URL well under common mailto length limits
  const max = 1800;
  if (body.length > max) body = body.slice(0, max - 1) + "…";
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function sectionShareText(section, titleEntry, chapter) {
  const label = section.label || `Sec. ${section.section_key}`;
  const paras = (section.content && section.content.body_paragraphs) || [];
  let excerpt = paras.join("\n\n");
  if (excerpt.length > 1200) excerpt = excerpt.slice(0, 1199) + "…";
  const hash = hashFor.section(titleEntry.title_key, chapter.chapter_key, section.section_key);
  const lines = [
    label,
    `Connecticut General Statutes — ${fmtTitle(titleEntry)}, ${fmtChapter(chapter)}`,
    "",
    excerpt,
    "",
    `View in CT Statutes Explorer: ${appUrlFor(hash)}`,
  ];
  if (section.url) lines.push(`Official text: ${section.url}`);
  let topic = stripSectionPrefix(label) || "";
  if (topic.length > 70) topic = topic.slice(0, 69) + "…";
  const subject = `CGS Sec. ${section.section_key}${topic ? " — " + topic : ""}`;
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

async function loadMaster() {
  setStatus("Loading titles index…");
  const master = await fetchJson(MASTER_URL);
  state.master = master;
  state.titleByKey.clear();
  for (const t of master.titles || []) state.titleByKey.set(t.title_key, t);
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
    } else if (state.route.area === "index" || (state.route.area === "browse" && !state.route.titleKey)) {
      render();
    }
  } catch (err) {
    console.warn("Statutes index unavailable:", err);
    state.statIndex = null;
  }
}

function indexLoadedTitle(titleObj) {
  for (const c of titleObj.chapters || []) {
    state.chapterByKey.set(keyChapter(titleObj.title_key, c.chapter_key), c);
    for (const s of c.sections || []) {
      if (!s.section_key) continue;
      state.sectionByKey.set(keySection(titleObj.title_key, c.chapter_key, s.section_key), s);
      if (!state.sectionLoc.has(s.section_key)) {
        state.sectionLoc.set(s.section_key, { t: titleObj.title_key, c: c.chapter_key });
      }
    }
  }
}

async function ensureTitleLoaded(titleKey) {
  if (!titleKey || state.titleCache.has(titleKey)) return;
  const entry = state.titleByKey.get(titleKey);
  if (!entry || !entry.file) return;

  setStatus(`Loading ${entry.label}…`);
  const titleObj = await fetchJson(DATA_DIR + entry.file);
  state.titleCache.set(titleKey, titleObj);
  indexLoadedTitle(titleObj);
  setPreloadStatus();
}

function setPreloadStatus() {
  const p = state.preload;
  if (p.running) {
    setStatus(`Downloading for offline use ${p.loaded}/${p.total}…`);
  } else if (p.done && !p.failed) {
    setStatus("Ready — available offline");
  } else if (p.done) {
    setStatus(`Ready (${p.failed} title${p.failed === 1 ? "" : "s"} failed to load)`);
  } else {
    setStatus("Ready");
  }
}

async function preloadAllTitles() {
  if (state.preload.running) return;
  const titles = state.master?.titles || [];
  state.preload.running = true;
  state.preload.total = titles.length;
  state.preload.loaded = state.titleCache.size;
  state.preload.failed = 0;

  const queue = titles.map((t) => t.title_key).filter((k) => !state.titleCache.has(k));

  async function worker() {
    while (queue.length) {
      const titleKey = queue.shift();
      try {
        await ensureTitleLoaded(titleKey);
      } catch {
        state.preload.failed++;
      }
      state.preload.loaded = state.titleCache.size;
      setPreloadStatus();
      await sleep(PRELOAD_YIELD_MS);
    }
  }

  await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker));
  state.preload.running = false;
  state.preload.done = true;
  setPreloadStatus();

  if (state.search.q) {
    runSearch();
    render();
  } else if (state.route.area === "browse" && !state.route.titleKey) {
    render(); // refresh home offline card
  }
}

// -----------------------------
// SEARCH
// -----------------------------
const STAT_QUERY_RE = /^(?:sec(?:tion)?\.?\s*|§\s*)?(\d+[a-z]{0,2}-\d+[a-z]{0,3})\.?$/i;

function setSearch(q, scope) {
  state.search.q = q.trim();
  state.search.scope = scope;
  runSearch();
  render();
}

function runSearch() {
  const qRaw = state.search.q;
  if (!qRaw) {
    state.search.results = null;
    return;
  }
  const q = qRaw.toLowerCase();
  const statMatch = qRaw.match(STAT_QUERY_RE);
  const statKey = statMatch ? statMatch[1].toLowerCase() : null;
  const tokens = q.split(/\s+/).filter(Boolean);

  const groups = { sections: [], infractions: [], topics: [], chapters: [], titles: [] };

  const matchesTokens = (hay) => tokens.every((tok) => hay.includes(tok));

  // --- titles (always available from master)
  for (const t of state.master?.titles || []) {
    const hay = `${t.label} ${t.name || ""}`.toLowerCase();
    if ((statKey && t.title_key === statKey.split("-")[0]) || matchesTokens(hay)) {
      groups.titles.push({ label: fmtTitle(t), hash: hashFor.title(t.title_key) });
      if (groups.titles.length >= 20) break;
    }
  }

  // --- statute-number lookup across loaded titles
  if (statKey) {
    for (const [skey, loc] of state.sectionLoc.entries()) {
      if (skey === statKey || skey.startsWith(statKey)) {
        const s = state.sectionByKey.get(keySection(loc.t, loc.c, skey));
        const tEntry = state.titleByKey.get(loc.t);
        const ch = state.chapterByKey.get(keyChapter(loc.t, loc.c));
        groups.sections.push({
          exact: skey === statKey,
          label: s?.label || `Sec. ${skey}`,
          sub: `${tEntry ? fmtTitle(tEntry) : loc.t} • ${ch ? fmtChapter(ch) : loc.c}`,
          hash: hashFor.section(loc.t, loc.c, skey),
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
    // full text of statute bodies, across all loaded titles
    for (const [titleKey, titleObj] of state.titleCache.entries()) {
      const tEntry = state.titleByKey.get(titleKey);
      const tLabel = tEntry ? fmtTitle(tEntry) : titleKey;
      for (const c of titleObj.chapters || []) {
        for (const s of c.sections || []) {
          if (!s.section_key) continue;
          const text = s.content && s.content.text ? String(s.content.text) : "";
          if (!text) continue;
          const hay = text.toLowerCase();
          if (!matchesTokens(hay)) continue;
          const idx = hay.indexOf(tokens[0]);
          const start = Math.max(0, idx - 60);
          const end = Math.min(text.length, idx + tokens[0].length + 110);
          groups.sections.push({
            label: stripSectionPrefix(s.label || s.section_key) || s.section_key,
            sub: `${tLabel} • ${fmtChapter(c)}`,
            snippet: text.slice(start, end).replace(/\s+/g, " ").trim(),
            hash: hashFor.section(titleKey, c.chapter_key, s.section_key),
          });
          if (groups.sections.length >= MAX_FULLTEXT_RESULTS) break;
        }
        if (groups.sections.length >= MAX_FULLTEXT_RESULTS) break;
      }
      if (groups.sections.length >= MAX_FULLTEXT_RESULTS) break;
    }
  } else if (!statKey) {
    // label search: chapters + sections across loaded titles
    for (const [titleKey, titleObj] of state.titleCache.entries()) {
      const tEntry = state.titleByKey.get(titleKey);
      const tLabel = tEntry ? fmtTitle(tEntry) : titleKey;
      for (const c of titleObj.chapters || []) {
        const cHay = `${c.label} ${c.name || ""}`.toLowerCase();
        if (groups.chapters.length < MAX_GROUP_RESULTS && matchesTokens(cHay)) {
          groups.chapters.push({
            label: fmtChapter(c),
            sub: tLabel,
            hash: hashFor.chapter(titleKey, c.chapter_key),
          });
        }
        if (groups.sections.length < MAX_GROUP_RESULTS) {
          for (const s of c.sections || []) {
            if (!s.section_key) continue;
            const sHay = `${s.label || ""} ${s.section_key}`.toLowerCase();
            if (matchesTokens(sHay)) {
              groups.sections.push({
                label: s.label || s.section_key,
                sub: `${tLabel} • ${fmtChapter(c)}`,
                hash: hashFor.section(titleKey, c.chapter_key, s.section_key),
              });
              if (groups.sections.length >= MAX_GROUP_RESULTS) break;
            }
          }
        }
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

// -----------------------------
// RENDER — shared widgets
// -----------------------------
function renderList(items) {
  const wrap = document.createElement("div");
  wrap.className = "list";
  for (const it of items) {
    const card = document.createElement(it.hash ? "a" : "div");
    card.className = "card";
    if (it.hash) card.href = it.hash;
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

function renderPanel(title, arr, open = false) {
  const count = Array.isArray(arr) ? arr.length : 0;
  return `
    <details${open && count ? " open" : ""}>
      <summary>${esc(title)} <span class="muted">(${count})</span></summary>
      <div class="panel">
        ${count ? arr.map((p) => `<p>${esc(p)}</p>`).join("") : `<div class="muted">None.</div>`}
      </div>
    </details>
  `;
}

function renderAnnotationsPanel(title, arr) {
  const count = Array.isArray(arr) ? arr.length : 0;
  return `
    <details>
      <summary>${esc(title)} <span class="muted">(${count})</span></summary>
      <div class="panel">
        ${count
      ? arr.map((a) => {
        const text = a.text || "";
        return `<p>${a.first ? `<strong>${esc(text)}</strong>` : esc(text)}</p>`;
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
  if (r.area === "browse") return !r.sectionKey;
  if (r.area === "infractions") return !r.category && !r.infraId;
  return false;
}

function setBackButtons(hidden) {
  backBtn.hidden = hidden;
  backBtnTop.hidden = hidden;
}

function render() {
  updateBookmarkBadge();
  document.body.classList.toggle("no-aside", !mobileNeedsAside());

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
  } else {
    renderBrowseNav();
    renderBrowseView();
  }
}

// -----------------------------
// RENDER — browse area
// -----------------------------
function renderBrowseNav() {
  const { titleKey, chapterKey } = state.route;
  navEl.innerHTML = "";

  if (!titleKey) {
    navHeading.textContent = "Titles";
    const items = (state.master?.titles || []).map((t) => ({
      kicker: t.label,
      title: t.name || "(no title name)",
      hash: hashFor.title(t.title_key),
    }));
    navEl.appendChild(renderList(items));
    return;
  }

  const titleObj = state.titleCache.get(titleKey);
  const titleEntry = state.titleByKey.get(titleKey);

  if (!chapterKey) {
    navHeading.textContent = titleEntry ? titleEntry.label : "Title";
    if (!titleObj) {
      navEl.innerHTML = `<div class="empty">Loading ${esc(titleEntry?.label || "title")}…</div>`;
      return;
    }
    const items = (titleObj.chapters || []).map((c) => ({
      kicker: c.label,
      title: c.name || "(no chapter name)",
      hash: hashFor.chapter(titleKey, c.chapter_key),
      right: `<span class="tag">${(c.sections || []).length} sections</span>`,
    }));
    navEl.appendChild(renderList(items));
    return;
  }

  const c = state.chapterByKey.get(keyChapter(titleKey, chapterKey));
  navHeading.textContent = c ? c.label : "Chapter";
  const items = (c?.sections || []).filter((s) => s.section_key).map((s) => ({
    kicker: `Sec. ${s.section_key}`,
    title: stripSectionPrefix(s.label) || "(no label)",
    hash: hashFor.section(titleKey, chapterKey, s.section_key),
    right: [
      state.infraBySection.has(s.section_key) ? `<span class="tag">infraction</span>` : "",
      s.content?.status ? `<span class="tag">${esc(s.content.status)}</span>` : "",
    ].join(""),
  }));
  navEl.appendChild(renderList(items));
}

function renderBrowseView() {
  const { titleKey, chapterKey, sectionKey } = state.route;
  const titleEntry = titleKey ? state.titleByKey.get(titleKey) : null;
  const title = titleKey ? state.titleCache.get(titleKey) : null;
  const chapter = titleKey && chapterKey ? state.chapterByKey.get(keyChapter(titleKey, chapterKey)) : null;
  const section = titleKey && chapterKey && sectionKey
    ? state.sectionByKey.get(keySection(titleKey, chapterKey, sectionKey)) : null;

  crumbsEl.innerHTML = renderBreadcrumbs({ titleEntry, chapter, section });

  if (!titleKey) {
    renderHome();
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
        <span class="muted">Sections: ${(chapter?.sections || []).length}</span>
        ${chapter?.url ? `<a href="${esc(chapter.url)}" target="_blank" rel="noopener">Open on cga.ct.gov</a>` : ""}
      </div>
      <div class="empty">Choose a section from the list.</div>`;
    return;
  }

  if (!section) {
    viewEl.innerHTML = title
      ? `<div class="empty">Section not found in this chapter.</div>`
      : `<div class="empty">Loading…</div>`;
    return;
  }

  renderSectionView(section, titleEntry, chapter);
}

function renderSectionView(section, titleEntry, chapter) {
  const content = section.content || {};
  const body = Array.isArray(content.body_paragraphs) ? content.body_paragraphs : [];
  const source = Array.isArray(content.source) ? content.source : [];
  const history = Array.isArray(content.history) ? content.history : [];
  const annotations = Array.isArray(content.annotations) ? content.annotations : [];
  const infraEntries = state.infraBySection.get(section.section_key) || [];

  const bookmarked = findSectionBookmark(titleEntry.title_key, chapter.chapter_key, section.section_key) >= 0;

  viewEl.innerHTML = `
    <div class="section-label">${esc(section.label || `Sec. ${section.section_key}`)}</div>
    <div class="meta">
      ${content.status ? `<span class="tag">${esc(content.status)}</span>` : ""}
      <button class="btn star" data-action="bookmark" aria-pressed="${bookmarked}"
        aria-label="${bookmarked ? "Remove bookmark" : "Bookmark this section"}">★ ${bookmarked ? "Bookmarked" : "Bookmark"}</button>
      ${shareButtonsHtml()}
      ${section.url ? `<a href="${esc(section.url)}" target="_blank" rel="noopener">Open on cga.ct.gov</a>` : ""}
    </div>

    <div class="body">
      ${body.length
      ? body.map((p) => `<p>${esc(p)}</p>`).join("")
      : `<div class="empty">No statute body text found for this section.</div>`}
    </div>

    ${infraEntries.length ? renderInfractionsForSection(infraEntries) : ""}
    ${renderPanel("Source", source)}
    ${renderPanel("History", history)}
    ${renderAnnotationsPanel("Annotations", annotations)}
  `;

  viewEl.querySelector('[data-action="bookmark"]').addEventListener("click", () => {
    toggleSectionBookmark(
      titleEntry.title_key, chapter.chapter_key, section.section_key,
      section.label || `Sec. ${section.section_key}`
    );
    renderSectionView(section, titleEntry, chapter);
  });

  bindShareButtons(viewEl, () => sectionShareText(section, titleEntry, chapter));
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
  const parts = [`<a href="#/">Titles</a>`];
  if (titleEntry) parts.push(`<a href="${hashFor.title(titleEntry.title_key)}">${esc(titleEntry.label)}</a>`);
  if (titleEntry && chapter) parts.push(`<a href="${hashFor.chapter(titleEntry.title_key, chapter.chapter_key)}">${esc(chapter.label)}</a>`);
  if (section) parts.push(`<span>Sec. ${esc(section.section_key)}</span>`);
  return parts.join(` <span class="muted">/</span> `);
}

function renderHome() {
  const p = state.preload;
  const offlineLine = p.running
    ? `Downloading titles for offline use: ${p.loaded}/${p.total}`
    : p.done && !p.failed
      ? `All ${p.total} titles are stored on this device — the app now works without an internet connection.`
      : p.done
        ? `${p.loaded}/${p.total} titles stored offline (${p.failed} failed — they will retry next visit).`
        : "Preparing offline storage…";

  const inf = state.infractions;
  viewEl.innerHTML = `
    <h1 class="h1">Connecticut General Statutes</h1>
    <p class="muted" style="max-width:70ch;">Browse every title, chapter and section of the General Statutes,
      plus the complete infraction schedule with fine amounts. Search by keyword or statute number
      (for example <a href="#" id="exampleSearch">14-296aa</a>), bookmark what you use most, and share sections by email.</p>

    <div class="home-grid">
      <div class="home-card">
        <h2>📚 Browse statutes</h2>
        <p>${(state.master?.titles || []).length} titles. Pick one from the list to drill into chapters and sections.</p>
      </div>
      <div class="home-card">
        <h2>🔎 Subject index</h2>
        <p>${state.statIndex ? `${state.statIndex.headings.length.toLocaleString()} topics from the official LCO index, A to Z.` : "Loading the official subject index…"}
          <a href="${hashFor.index()}">Browse the index →</a></p>
      </div>
      <div class="home-card">
        <h2>🎫 Infraction schedule</h2>
        <p>${inf ? `${inf.entries.length} infractions & violations, linked to their statutes.` : "Not available."}</p>
        <p>${inf?.source?.effective ? `Effective ${esc(inf.source.effective)}.` : ""} <a href="${hashFor.infractions()}">Open the schedule →</a></p>
      </div>
      <div class="home-card">
        <h2>📴 Offline access</h2>
        <p id="offlineLine">${esc(offlineLine)}</p>
        <p class="small muted">Theme, text size and data refresh live in ⚙ Settings (top right).</p>
      </div>
      <div class="home-card">
        <h2>★ Bookmarks</h2>
        <p>${state.bookmarks.length ? `${state.bookmarks.length} saved.` : "Bookmark sections and infractions to find them quickly."} <a href="${hashFor.bookmarks()}">View bookmarks →</a></p>
      </div>
    </div>
  `;

  $("exampleSearch")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    qEl.value = "14-296aa";
    setSearch(qEl.value, scopeEl.value);
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
    <p class="muted" style="max-width:75ch;">The official subject index to the General Statutes, prepared by the
      Legislative Commissioners' Office. Look up a topic to find every statute about it — section numbers link
      straight to the statute text. If a topic isn't listed under the word you expect, try a more general heading,
      or follow the “→” cross-references.</p>
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
    <p class="muted" style="max-width:75ch;">Fines and total amounts payable through the Centralized Infractions
      Bureau, from the ${esc(inf.source?.title || "schedule")} published by the ${esc(inf.source?.publisher || "CT Judicial Branch")}.
      Each entry links to the statute it enforces. Pick a category from the list, or use the search box —
      it matches infractions too.</p>
    <div class="empty">Choose a category from the list to see its infractions.</div>
  `;
}

function renderInfractionDetail(e) {
  const cat = e.category ? state.infraCategories.find((c) => c.name === e.category) : null;
  if (cat) {
    crumbsEl.innerHTML += ` <span class="muted">/</span> <a href="${hashFor.infraCategory(cat.slug)}">${esc(cat.name)}</a>`;
  }
  crumbsEl.innerHTML += ` <span class="muted">/</span> <span>§ ${esc(cite(e))}</span>`;

  const bookmarked = findInfraBookmark(e.id) >= 0;
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
    : `<div class="empty">The underlying statute (Sec. ${esc(e.section_key)}) is not in the local statute data.</div>`;

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
      <div class="empty">Nothing saved yet. Open any statute section or infraction and press
        <strong>★ Bookmark</strong> — saved items appear here and stay on this device.</div>`;
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

  const stillLoading = state.preload.running
    ? `<span class="tag">still downloading titles — results may grow (${state.preload.loaded}/${state.preload.total})</span>` : "";

  const group = (name, items, renderItem) => items.length ? `
    <div class="result-group">
      <h2>${esc(name)} (${items.length}${items.length >= MAX_GROUP_RESULTS ? "+" : ""})</h2>
      <div class="list">${items.map(renderItem).join("")}</div>
    </div>` : "";

  viewEl.innerHTML = `
    <h1 class="h1">Search: “${esc(q)}”</h1>
    <div class="meta">
      <span class="muted">${state.search.scope === "fulltext" ? "Full text of statutes" : "Titles, sections & infractions"}</span>
      ${stillLoading}
    </div>
    ${totals === 0 ? `<div class="empty">No results for “${esc(q)}”. Try fewer words, a statute number like “14-227a”, or the full-text scope.</div>` : ""}
    ${group("Statute sections", g.sections, (r) => `
      <a class="card" href="${r.hash}">
        <div class="kicker">Section${r.exact ? ` <span class="tag">exact match</span>` : ""}</div>
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
}

// -----------------------------
// INIT + EVENTS
// -----------------------------
async function applyRoute() {
  state.route = parseHash();

  // navigating anywhere exits search mode
  if (state.search.q) {
    state.search.q = "";
    state.search.results = null;
    qEl.value = "";
  }

  try {
    if (state.route.area === "browse" && state.route.titleKey) {
      await ensureTitleLoaded(state.route.titleKey);
    }
    render();
    viewEl.focus({ preventScroll: true });
  } catch (e) {
    setStatus("Error");
    crumbsEl.textContent = "";
    viewEl.innerHTML = `<div class="empty">Failed to load: ${esc(e.message || String(e))}</div>`;
  }
}

function bindUI() {
  const navScopeDelay = () => (scopeEl.value === "fulltext" ? 350 : 180);
  let searchTimer;
  qEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setSearch(qEl.value, scopeEl.value), navScopeDelay());
  });
  scopeEl.addEventListener("change", () => setSearch(qEl.value, scopeEl.value));

  const goUp = () => {
    const up = parentHash();
    if (up) go(up);
  };
  backBtn.addEventListener("click", goUp);
  backBtnTop.addEventListener("click", goUp);

  window.addEventListener("hashchange", applyRoute);

  document.addEventListener("keydown", (ev) => {
    const inField = /^(input|select|textarea)$/i.test(document.activeElement?.tagName || "");
    if (ev.key === "/" && !inField) {
      ev.preventDefault();
      qEl.focus();
      qEl.select();
    } else if (ev.key === "Escape" && state.search.q) {
      qEl.value = "";
      setSearch("", scopeEl.value);
    }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // file:// and some embedded contexts don't support SW — offline mode then degrades gracefully
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}

(async function main() {
  loadBookmarks();
  applySettings();
  bindSettings();
  updateBookmarkBadge();
  bindUI();
  registerServiceWorker();

  try {
    await Promise.all([loadMaster(), loadInfractions()]);
    setStatus("Ready");
    await applyRoute();
    loadStatutesIndex(); // large file — load without blocking first paint
    preloadAllTitles();
  } catch (e) {
    setStatus("Error");
    viewEl.innerHTML = `<div class="empty">Failed to load data: ${esc(e.message || String(e))}<br>
      Check that <code>${esc(MASTER_URL)}</code> is reachable.</div>`;
  }
})();
