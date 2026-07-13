#!/usr/bin/env python3
"""Data-quality gate for the generated CT-Statutes datasets.

Validates the JSON in data/ before it ships to the live apps: structural
schema, record-count bounds, key uniqueness, citation referential integrity,
empty statute bodies, parser artifacts (squashed citations, header bleed),
sentinel records, and version.json consistency. update_data.py runs this as
its final stage; run it directly after any manual data edit.

Thresholds are grounded in the February 2026 corpus (81 titles, 1,102
chapters, ~30k sections, ~5.7k index headings, ~1.7k infractions, ~1.9k
supplement-amended sections) with wide margins, so they gate parser
breakage — not ordinary legislative drift.

Usage (from inside CT-Statutes):
  python validate_data.py                          # validate data/
  python validate_data.py --baseline old_version.json
                          # additionally fail when a record count moved more
                          # than 20% from the given previous version manifest

Exits 0 when every check passes, 1 otherwise. Stdlib only.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from build_app_indexes import (
    DATA_DIR,
    MASTER_PATH,
    SEARCH_PATH,
    SUPPLEMENT_DIR,
    SUPPLEMENT_INDEX_PATH,
    SUPPLEMENT_MAP_PATH,
    VERSION_PATH,
    compute_digest,
    data_files,
    read_json,
)

# Absolute sanity bounds per dataset (see module docstring for current values).
COUNT_BOUNDS = {
    "titles": (60, 110),
    "chapters": (900, 1400),
    "sections": (24000, 40000),
    "index_headings": (4000, 8000),
    "infractions": (1300, 2400),
    # sparse overlay: the July 2026 supplement holds ~1.9k amended sections
    "supplement_sections": (200, 8000),
}
BASELINE_MAX_DRIFT = 0.20     # --baseline: fail beyond +/-20% per count

MAX_EMPTY_SECTION_FRACTION = 0.03   # repealed/reserved sections; now ~1.3%
MAX_MISTITLED_SECTION_ROWS = 100    # "Formerly Sec." crawler rows; now 13
MAX_DUPLICATE_SECTION_KEYS = 30     # same key crawled in two chapters; now 6
MIN_INDEX_REF_RESOLVED = 0.95       # index cites repealed sections; now ~97.6%
MIN_INFRACTIONS_LINKED = 0.90       # PA rows never link; now ~99.4%
MIN_INFRACTIONS_WITH_TOTAL = 0.90   # "See Appx" rows have no total; now ~97%
MAX_AMOUNT = 100000.0               # largest schedule amount is $20,000

# Records that have been in these datasets for decades; their absence means
# the parser lost a whole region of its source, whatever the counts say.
SENTINEL_SECTIONS = ("1-1", "14-227a", "47a-21")
SENTINEL_INDEX_HEADINGS = ("MOTOR VEHICLES", "DOGS", "DIVORCE", "TAXATION")
SENTINEL_INFRACTION_KEYS = ("14-296aa", "14-219", "53-198")

AMOUNT_COLUMNS = {"total_due", "fine", "fee", "z_fee", "cost",
                  "surcharge", "stf", "bipsa", "mf", "plus"}

# Parser artifacts that once shipped and must never ship again: schedule
# column headers absorbed into a description, the alphabetical re-listing,
# and squashed offense ordinals such as "14-296aa(b1st".
BLEED_MARKERS = ("STAT NO", "INFRACTIONS/VIOLATIONS", "AMT DUE",
                 "Alphabetical Order", "TOTAL AMOUNT DUE")
SQUASHED_ORDINAL_RE = re.compile(r"\([a-z]+(?:1st|2nd|3rd|\dth)\b")

SECTION_TITLE_RE = re.compile(r"^(\d+)([a-z]*)-", re.IGNORECASE)
REF_KEY_RE = re.compile(r"^(\d+[a-z]*-\d+[a-z]*)")


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, name: str, ok: bool, detail: str) -> None:
        if ok:
            print(f"  ok   {name}: {detail}")
        else:
            print(f"  FAIL {name}: {detail}")
            self.failures.append(f"{name}: {detail}")

    def examples(self, name: str, bad: list, detail: str, limit: int = 5) -> None:
        shown = "; ".join(str(b)[:120] for b in bad[:limit])
        suffix = f" (first {limit} of {len(bad)}: {shown})" if bad else ""
        self.check(name, not bad, detail + suffix)


def in_bounds(name: str, value: int) -> str:
    lo, hi = COUNT_BOUNDS[name]
    return f"{value:,} (allowed {lo:,}..{hi:,})"


def expected_title_key(section_key: str):
    m = SECTION_TITLE_RE.match(section_key)
    return (m.group(1).zfill(2) + m.group(2).lower()) if m else None


def section_text(section) -> str:
    content = section.get("content")
    if not isinstance(content, dict):
        return ""
    parts = []
    for value in content.values():
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, list):
            parts.extend(str(v) for v in value)
    return " ".join(parts).strip()


def validate_titles(c: Checker, master):
    print("titles_index.json + title files")
    titles = master.get("titles") or []
    lo, hi = COUNT_BOUNDS["titles"]
    c.check("titles.count", lo <= len(titles) <= hi, in_bounds("titles", len(titles)))
    c.check("titles.source", bool((master.get("source") or {}).get("generated_at_utc")),
            "source.generated_at_utc present")

    bad_entries = [t for t in titles
                   if not (t.get("title_key") and t.get("file") and t.get("label"))]
    c.examples("titles.entries", bad_entries, "every entry has title_key/file/label")
    dup_titles = len(titles) - len({t.get("title_key") for t in titles})
    c.check("titles.unique", dup_titles == 0, f"{dup_titles} duplicate title_keys")

    chapters = {}                # (title_key, chapter_key) -> set of section keys
    routable = {}                # section_key -> (title_key, chapter_key)
    all_section_keys = set()
    stats = {"chapters": 0, "sections": 0, "mistitled": 0, "dup_routable": 0,
             "empty": 0}
    bad_sections: list[str] = []
    bad_chapters: list[str] = []

    for entry in titles:
        title = read_json(DATA_DIR / entry["file"])
        if title.get("title_key") != entry.get("title_key"):
            bad_chapters.append(f"{entry['file']}: title_key mismatch")
            continue
        title_key = title["title_key"]
        for chapter in title.get("chapters") or []:
            chapter_key = chapter.get("chapter_key")
            if not chapter_key or not chapter.get("label"):
                bad_chapters.append(f"{title_key}: chapter missing key/label")
                continue
            if (title_key, chapter_key) in chapters:
                bad_chapters.append(f"{title_key}: duplicate chapter {chapter_key}")
            keys = set()
            chapters[(title_key, chapter_key)] = keys
            stats["chapters"] += 1
            for section in chapter.get("sections") or []:
                key = section.get("section_key")
                if not key:
                    continue
                stats["sections"] += 1
                all_section_keys.add(key.lower())
                if not section.get("label"):
                    bad_sections.append(f"{key}: no label")
                if not section_text(section):
                    stats["empty"] += 1
                if expected_title_key(key) != title_key:
                    stats["mistitled"] += 1   # renumbered "Formerly Sec." rows
                    continue
                keys.add(key)
                if key in routable:
                    stats["dup_routable"] += 1
                else:
                    routable[key] = (title_key, chapter_key)

    c.examples("titles.files", bad_chapters, "title files structurally sound")
    c.examples("titles.sections", bad_sections, "every section has a label")
    c.check("chapters.count",
            COUNT_BOUNDS["chapters"][0] <= stats["chapters"] <= COUNT_BOUNDS["chapters"][1],
            in_bounds("chapters", stats["chapters"]))
    n_routable = len(routable)
    c.check("sections.count",
            COUNT_BOUNDS["sections"][0] <= n_routable <= COUNT_BOUNDS["sections"][1],
            in_bounds("sections", n_routable))
    empty_fraction = stats["empty"] / max(stats["sections"], 1)
    c.check("sections.bodies", empty_fraction <= MAX_EMPTY_SECTION_FRACTION,
            f"{stats['empty']:,} of {stats['sections']:,} sections have no text "
            f"({empty_fraction:.1%}, allowed {MAX_EMPTY_SECTION_FRACTION:.0%})")
    c.check("sections.mistitled", stats["mistitled"] <= MAX_MISTITLED_SECTION_ROWS,
            f"{stats['mistitled']} rows keyed outside their title "
            f"(allowed {MAX_MISTITLED_SECTION_ROWS})")
    c.check("sections.duplicates", stats["dup_routable"] <= MAX_DUPLICATE_SECTION_KEYS,
            f"{stats['dup_routable']} duplicate routable section keys "
            f"(allowed {MAX_DUPLICATE_SECTION_KEYS})")

    missing = [k for k in SENTINEL_SECTIONS if k not in routable]
    c.examples("sections.sentinels", missing,
               f"sentinel sections present: {', '.join(SENTINEL_SECTIONS)}")
    return chapters, routable, all_section_keys


def validate_index(c: Checker, all_section_keys):
    print("statutes_index.json")
    index = read_json(DATA_DIR / "statutes_index.json")
    headings = index.get("headings") or []
    lo, hi = COUNT_BOUNDS["index_headings"]
    c.check("index.count", lo <= len(headings) <= hi,
            in_bounds("index_headings", len(headings)))
    c.check("index.source", bool((index.get("source") or {}).get("generated")),
            "source.generated present")

    bad = []
    total_refs = resolved = 0
    letters = set()
    for heading in headings:
        h = heading.get("h")
        if not h or not isinstance(heading.get("items"), list):
            bad.append(f"malformed heading: {h!r}")
            continue
        letters.add(h[:1].upper())
        for item in heading["items"]:
            if not item.get("t"):
                bad.append(f"{h}: item without text")
            for pair in item.get("r") or []:
                key = pair[1] if isinstance(pair, list) and len(pair) > 1 else pair
                total_refs += 1
                m = REF_KEY_RE.match(str(key or "").lower())
                if m and m.group(1) in all_section_keys:
                    resolved += 1
    c.examples("index.structure", bad, "headings and items well-formed")
    c.check("index.letters", len(letters & set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")) >= 20,
            f"headings span {len(letters)} initial letters")
    fraction = resolved / max(total_refs, 1)
    c.check("index.refs", fraction >= MIN_INDEX_REF_RESOLVED,
            f"{resolved:,} of {total_refs:,} statute refs resolve into the crawl "
            f"({fraction:.1%}, required {MIN_INDEX_REF_RESOLVED:.0%})")

    present = {h.get("h") for h in headings}
    missing = [h for h in SENTINEL_INDEX_HEADINGS if h not in present]
    c.examples("index.sentinels", missing,
               f"sentinel headings present: {', '.join(SENTINEL_INDEX_HEADINGS)}")
    return len(headings)


def validate_infractions(c: Checker, chapters, all_section_keys):
    print("infractions.json")
    data = read_json(DATA_DIR / "infractions.json")
    entries = data.get("entries") or []
    lo, hi = COUNT_BOUNDS["infractions"]
    c.check("infractions.count", lo <= len(entries) <= hi,
            in_bounds("infractions", len(entries)))
    source = data.get("source") or {}
    c.check("infractions.source", bool(source.get("effective") and source.get("generated")),
            "source.effective and source.generated present")

    structural, artifacts, amounts_bad, ref_bad = [], [], [], []
    linked = with_total = 0
    for e in entries:
        stat_no = e.get("stat_no", "?")
        desc = e.get("description") or ""
        citation = e.get("citation") or ""
        if not (e.get("stat_no") and citation and e.get("section_key")
                and desc and e.get("category") and isinstance(e.get("amounts"), dict)):
            structural.append(f"{stat_no}: missing required field")
            continue
        if not 5 <= len(desc) <= 400:
            artifacts.append(f"{stat_no}: description length {len(desc)}")
        if desc.count("(") != desc.count(")") or citation.count("(") != citation.count(")"):
            artifacts.append(f"{stat_no}: unbalanced parentheses")
        if SQUASHED_ORDINAL_RE.search(desc) or SQUASHED_ORDINAL_RE.search(citation):
            artifacts.append(f"{stat_no}: squashed offense ordinal")
        if any(marker in desc for marker in BLEED_MARKERS):
            artifacts.append(f"{stat_no}: schedule header text in description")

        for name, value in e["amounts"].items():
            if name not in AMOUNT_COLUMNS or not isinstance(value, (int, float)) \
                    or not 0 < value <= MAX_AMOUNT:
                amounts_bad.append(f"{stat_no}: {name}={value!r}")
        if e["amounts"].get("total_due"):
            with_total += 1

        ref = e.get("ref")
        if ref:
            linked += 1
            if (ref.get("title_key"), ref.get("chapter_key")) not in chapters:
                ref_bad.append(f"{stat_no}: ref to unknown chapter {ref}")
            elif e["section_key"] not in all_section_keys:
                ref_bad.append(f"{stat_no}: linked key {e['section_key']} not crawled")

    c.examples("infractions.structure", structural, "required fields on every entry")
    c.examples("infractions.artifacts", artifacts, "no parser artifacts in text")
    c.examples("infractions.amounts", amounts_bad, "amount columns known and plausible")
    c.examples("infractions.refs", ref_bad, "statute links resolve")
    linked_fraction = linked / max(len(entries), 1)
    c.check("infractions.linked", linked_fraction >= MIN_INFRACTIONS_LINKED,
            f"{linked:,} of {len(entries):,} entries link to a statute "
            f"({linked_fraction:.1%}, required {MIN_INFRACTIONS_LINKED:.0%})")
    total_fraction = with_total / max(len(entries), 1)
    c.check("infractions.totals", total_fraction >= MIN_INFRACTIONS_WITH_TOTAL,
            f"{with_total:,} of {len(entries):,} entries carry total_due "
            f"({total_fraction:.1%}, required {MIN_INFRACTIONS_WITH_TOTAL:.0%})")

    present = {e.get("section_key") for e in entries}
    missing = [k for k in SENTINEL_INFRACTION_KEYS if k not in present]
    c.examples("infractions.sentinels", missing,
               f"sentinel infractions present: {', '.join(SENTINEL_INFRACTION_KEYS)}")
    return len(entries)


# The overlay is a sparse subset of the statutes, so most amended keys should
# exist in the base corpus; the rest are sections the supplement adds. The
# July 2026 crawl overlaps ~80%.
MIN_SUPPLEMENT_OVERLAP = 0.5


def validate_supplement(c: Checker, master, all_section_keys):
    """Schema/count checks for the data/supplement/ overlay. Returns the
    amended-section count, or None when no supplement dataset exists (a
    supplement is optional — see build_app_indexes.supplement_files)."""
    print("supplement/")
    if not SUPPLEMENT_MAP_PATH.is_file():
        print("  skipped — no supplement dataset")
        return None

    overlay = read_json(SUPPLEMENT_MAP_PATH)
    supp_index = read_json(SUPPLEMENT_INDEX_PATH)

    source = overlay.get("source") or {}
    c.check("supplement.source",
            source.get("kind") == "supplement"
            and bool(source.get("supplement_year"))
            and bool(source.get("generated_at_utc")),
            "source kind/supplement_year/generated_at_utc present")

    title_keys = set(overlay.get("titles") or [])
    chapters_map = overlay.get("chapters") or {}
    sections_map = overlay.get("sections") or {}
    master_keys = {t.get("title_key") for t in master.get("titles") or []}

    lo, hi = COUNT_BOUNDS["supplement_sections"]
    c.check("supplement.count", lo <= len(sections_map) <= hi,
            in_bounds("supplement_sections", len(sections_map)))
    c.check("supplement.titles", bool(title_keys) and title_keys <= master_keys,
            f"{len(title_keys)} supplement titles, all in the master index")

    bad_chapters = [f"{ck}: title {entry.get('t')!r} not in supplement titles"
                    for ck, entry in chapters_map.items()
                    if entry.get("t") not in title_keys]
    c.examples("supplement.chapters", bad_chapters,
               f"{len(chapters_map)} chapter entries point at supplement titles")

    # per-title files listed by the index: present, parseable, keys consistent
    index_files = {}
    bad_files = []
    for entry in supp_index.get("titles") or []:
        fname = entry.get("file")
        if not fname or not entry.get("title_key"):
            bad_files.append(f"index entry missing file/title_key: {entry!r}")
            continue
        path = SUPPLEMENT_DIR / fname
        if not path.is_file():
            bad_files.append(f"{fname}: missing")
            continue
        title = read_json(path)
        if title.get("title_key") != entry["title_key"]:
            bad_files.append(f"{fname}: title_key mismatch")
            continue
        keys = set()
        for chapter in title.get("chapters") or []:
            for section in chapter.get("sections") or []:
                key = (section.get("section_key") or "").lower()
                if key:
                    keys.add(key)
                for grouped in section.get("section_keys") or []:
                    keys.add(str(grouped).lower())
        index_files[fname] = keys
    c.examples("supplement.files", bad_files,
               f"{len(index_files)} per-title files present and consistent")

    # every overlay entry routes into its per-title file
    bad_entries = []
    overlap = 0
    for key, entry in sections_map.items():
        if not (entry.get("t") and entry.get("c") and entry.get("l")
                and entry.get("f")):
            bad_entries.append(f"{key}: missing t/c/l/f")
            continue
        if entry.get("status") not in (
                None, "repealed", "reserved", "transferred", "obsolete", "mixed"):
            bad_entries.append(f"{key}: unknown status {entry['status']!r}")
        if entry["t"] not in title_keys:
            bad_entries.append(f"{key}: title {entry['t']!r} not in supplement")
        file_keys = index_files.get(entry["f"])
        if file_keys is not None and key.lower() not in file_keys:
            bad_entries.append(f"{key}: not found in {entry['f']}")
        if key.lower() in all_section_keys:
            overlap += 1
    c.examples("supplement.entries", bad_entries,
               "overlay entries resolve into their supplement files")

    fraction = overlap / max(len(sections_map), 1)
    c.check("supplement.overlap", fraction >= MIN_SUPPLEMENT_OVERLAP,
            f"{overlap:,} of {len(sections_map):,} amended sections exist in "
            f"the base corpus ({fraction:.1%}, required "
            f"{MIN_SUPPLEMENT_OVERLAP:.0%}); the rest are new sections")
    return len(sections_map)


def validate_search_index(c: Checker, master, chapters, routable):
    print("search_index.json")
    search = read_json(SEARCH_PATH)
    master_keys = {t.get("title_key") for t in master.get("titles") or []}

    bad_chapters = []
    seen_chapters = set()
    for row in search.get("chapters") or []:
        pair = (row.get("t"), row.get("c"))
        seen_chapters.add(pair)
        if row.get("t") not in master_keys or pair not in chapters or not row.get("l"):
            bad_chapters.append(f"{pair}: unknown chapter or missing label")
    c.examples("search.chapters", bad_chapters, "chapter rows route to real chapters")
    c.check("search.chapters.complete", seen_chapters == set(chapters),
            f"{len(seen_chapters):,} chapter rows cover all "
            f"{len(chapters):,} crawled chapters")

    bad_sections = []
    seen_sections = set()
    for row in search.get("sections") or []:
        key, pair = row.get("s"), (row.get("t"), row.get("c"))
        seen_sections.add(key)
        if key not in routable or pair not in chapters or key not in chapters[pair]:
            bad_sections.append(f"{key}: route {pair} not in crawl")
    c.examples("search.sections", bad_sections, "section rows route to real sections")
    missing = set(routable) - seen_sections
    extra = seen_sections - set(routable)
    c.check("search.sections.complete", not missing and not extra,
            f"{len(seen_sections):,} section rows == {len(routable):,} routable "
            f"sections ({len(missing)} missing, {len(extra)} extra)")


def validate_version(c: Checker, master, counts):
    print("version.json")
    version = read_json(VERSION_PATH)
    digest, total_bytes = compute_digest(data_files(master))
    c.check("version.hash", version.get("version") == digest,
            f"manifest hash matches recomputed data digest {digest[:16]}")
    c.check("version.bytes", version.get("bytes") == total_bytes,
            f"byte total {total_bytes:,} matches")
    recorded = version.get("counts") or {}
    c.check("version.counts", recorded == counts,
            f"recorded counts {recorded} == measured {counts}")
    sources = version.get("sources") or {}
    c.check("version.sources",
            all(sources.get(k) for k in ("statutes", "index", "infractions")),
            "statutes/index/infractions source dates present")


def validate_baseline(c: Checker, counts, baseline_path: str):
    print(f"baseline comparison ({baseline_path})")
    baseline = (read_json(Path(baseline_path)) or {}).get("counts") or {}
    if not baseline:
        c.check("baseline.counts", False,
                "baseline manifest has no counts (predates schema addition?)")
        return
    for name, value in counts.items():
        previous = baseline.get(name)
        if not previous:
            # a count added since the baseline manifest (e.g. the supplement
            # dataset shipping for the first time) has nothing to drift from
            c.check(f"baseline.{name}", True,
                    f"{value:,} (new count, not in baseline)")
            continue
        drift = abs(value - previous) / previous
        c.check(f"baseline.{name}", drift <= BASELINE_MAX_DRIFT,
                f"{previous:,} -> {value:,} ({drift:+.1%} vs allowed "
                f"+/-{BASELINE_MAX_DRIFT:.0%})")


def main() -> None:
    ap = argparse.ArgumentParser(description="Validate the generated data/ files.")
    ap.add_argument("--baseline", metavar="VERSION_JSON",
                    # argparse %-formats help strings, so escape the percent
                    help="previous version.json; fail when record counts "
                         f"drift more than {BASELINE_MAX_DRIFT * 100:.0f}%%")
    args = ap.parse_args()

    c = Checker()
    master = read_json(MASTER_PATH)
    chapters, routable, all_section_keys = validate_titles(c, master)
    heading_count = validate_index(c, all_section_keys)
    infraction_count = validate_infractions(c, chapters, all_section_keys)
    validate_search_index(c, master, chapters, routable)
    supplement_count = validate_supplement(c, master, all_section_keys)
    counts = {
        "titles": len(master.get("titles") or []),
        "chapters": len(chapters),
        "sections": len(routable),
        "index_headings": heading_count,
        "infractions": infraction_count,
    }
    if supplement_count is not None:
        counts["supplement_sections"] = supplement_count
    validate_version(c, master, counts)
    if args.baseline:
        validate_baseline(c, counts, args.baseline)

    if c.failures:
        print(f"\nFAILED — {len(c.failures)} check(s) did not pass:")
        for failure in c.failures:
            print(f"  - {failure}")
        sys.exit(1)
    print("\nAll data-quality checks passed.")


if __name__ == "__main__":
    main()
