#!/usr/bin/env python3
"""
CT Infractions Schedule parser (jud.ct.gov)
- Input:  infractions_schedule.pdf  (Chart A: "Mail-In Violations and Infractions
          Schedule", https://www.jud.ct.gov/webforms/forms/infractions.pdf)
- Output: data/infractions.json

Each schedule row becomes an entry:
  stat_no      statute citation as printed (e.g. "14-100a(d1B*")
  section_key  base C.G.S. section (e.g. "14-100a") used to link into the
               statute JSON produced by ct_CGS_Crawl-v2.py
  description  infraction/violation description
  amounts      column values (total_due, fine, fee, z_fee, cost, surcharge,
               stf, bipsa, mf, plus) where present
  category     schedule category heading (e.g. "MOTOR VEHICLES")
  subsequent   True when the citation carries the schedule's "*" marker
               (2nd/subsequent-offense rows)
  ref          {title_key, chapter_key} when the base section exists in data/

Dependencies:
  pip install pdfplumber
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date

import pdfplumber

PDF_PATH = "infractions_schedule.pdf"
DATA_DIR = "data"
OUTPUT_PATH = os.path.join(DATA_DIR, "infractions.json")
SOURCE_URL = "https://www.jud.ct.gov/webforms/forms/infractions.pdf"

FIRST_SCHEDULE_PAGE = 5  # 0-based; pages before this are cover/TOC/preface

# Statute citation at the start of a row, e.g. "14-100a(d1B*", "36a-787", "14-26(b)*".
# Section letters are lowercase in the schedule; uppercase Z/SZ suffixes are
# construction-zone / school-zone fee variants, not part of the section number.
STAT_RE = re.compile(r"^(\d+[a-z]{0,2}-\d+[a-z]{0,3})\S*$")
AMOUNT_RE = re.compile(r"^\d{1,3}(?:,\d{3})*\.\d{2}$")

# x coordinate that separates description text from the amount columns
AMOUNT_ZONE_X = 410
# rows starting left of this are statute/category rows; right of it, wrapped text
ROW_START_X = 60

COLUMN_NAMES = ["total_due", "fine", "fee", "z_fee", "cost",
                "surcharge", "stf", "bipsa", "mf", "plus"]
# Header tokens (second header row) in column order
HEADER_TOKENS = ["DUE", "FINE", "FEE", "FEE", "COST",
                 "CHARGE", "STF", "BIPSA", "MF", "PLUS"]
# Fallback centers measured from the PDF, used if a page header can't be read
DEFAULT_CENTERS = [452, 479, 516, 549, 590, 631, 664, 701, 733, 760]


def page_lines(page, tolerance=2.0):
    """Group words into visual lines (sorted top-to-bottom, left-to-right)."""
    words = sorted(page.extract_words(), key=lambda w: w["top"])
    lines = []
    current, current_top = [], None
    for w in words:
        if current_top is None or w["top"] - current_top <= tolerance:
            current.append(w)
            current_top = w["top"] if current_top is None else current_top
        else:
            lines.append(sorted(current, key=lambda x: x["x0"]))
            current, current_top = [w], w["top"]
    if current:
        lines.append(sorted(current, key=lambda x: x["x0"]))
    return lines


def header_centers(lines):
    """Locate the amount-column header row and return each column's center x."""
    for ws in lines:
        texts = [w["text"] for w in ws]
        if "STAT" in texts and "FINE" in texts:
            centers = []
            i = 0
            for tok in HEADER_TOKENS:
                while i < len(ws) and ws[i]["text"] != tok:
                    i += 1
                if i >= len(ws):
                    return DEFAULT_CENTERS
                centers.append((ws[i]["x0"] + ws[i]["x1"]) / 2)
                i += 1
            return centers
    return DEFAULT_CENTERS


def assign_amounts(entry, words, centers):
    """Map amount-zone words onto named columns by nearest header center."""
    for w in words:
        text = w["text"]
        if AMOUNT_RE.match(text):
            center = (w["x0"] + w["x1"]) / 2
            col = min(range(len(centers)), key=lambda i: abs(centers[i] - center))
            name = COLUMN_NAMES[col]
            value = float(text.replace(",", ""))
            # never overwrite (some rows repeat a wrapped amount line)
            if entry["amounts"].get(name) is None:
                entry["amounts"][name] = value
        elif len(text) > 1:  # single chars are stray footnote/superscript marks
            note = (entry.get("note", "") + " " + text).strip()
            entry["note"] = note


def clean_citation(stat_no, base):
    """Reconstruct a readable citation from the schedule's squashed form.

    The PDF compresses subsection chains and offense/zone markers into the
    citation, e.g. "14-296aa(b1st" (= 14-296aa(b), 1st offense) or
    "14-219(a(1SZ" (= 14-219(a)(1) in a school zone). The markers are kept
    in `subsequent`/description; here we rebuild "14-296aa(b)" etc.
    """
    rest = stat_no[len(base):]
    rest = rest.rstrip("*")
    rest = re.sub(r"(?:SZ|Z)+$", "", rest)          # zone-fee variant markers
    rest = re.sub(r"(?:1st|2nd|3rd|\dth)$", "", rest)  # offense ordinals
    if not rest.startswith("("):
        return base + rest
    groups = re.findall(r"[A-Za-z]+|\d+", rest)
    return base + "".join(f"({g})" for g in groups)


def is_category(ws):
    """Category headings sit at the left margin, all-caps, with no citation."""
    text = " ".join(w["text"] for w in ws)
    if STAT_RE.match(ws[0]["text"]):
        return False
    if ws[0]["x0"] > 40:
        return False
    # ignore mixed-case qualifiers like "MOTOR VEHICLES - Numerical Order"
    text = re.sub(r"\s*-\s*Numerical Order\s*$", "", text)
    letters = re.sub(r"[^A-Za-z]", "", text)
    return bool(letters) and letters.upper() == letters


def parse_schedule(pdf):
    entries = []
    category = None
    current = None

    for page_idx in range(FIRST_SCHEDULE_PAGE, len(pdf.pages)):
        page = pdf.pages[page_idx]
        lines = page_lines(page)
        if any(w["text"] == "B" and ws[0]["text"] == "CHART"
               for ws in lines[:2] for w in ws):
            break  # Chart B (fee cross-reference tables) ends the schedule
        centers = header_centers(lines)

        for ws in lines:
            text = " ".join(w["text"] for w in ws)
            # skip the two header rows and the page-number footer
            if text.startswith("TOTAL") or text.startswith("STAT NO"):
                continue
            if len(ws) == 1 and re.fullmatch(r"\d{1,3}", text):
                continue

            left = [w for w in ws if w["x0"] < AMOUNT_ZONE_X]
            right = [w for w in ws if w["x0"] >= AMOUNT_ZONE_X]

            first = ws[0]
            if first["x0"] <= ROW_START_X and STAT_RE.match(first["text"]):
                if current:
                    entries.append(current)
                stat_no = first["text"]
                base = STAT_RE.match(stat_no).group(1).lower()
                current = {
                    "stat_no": stat_no,
                    "citation": clean_citation(stat_no, base),
                    "section_key": base,
                    "description": " ".join(w["text"] for w in left[1:]),
                    "amounts": {},
                    "category": category,
                    "subsequent": "*" in stat_no,
                    "page": page_idx + 1,
                }
                assign_amounts(current, right, centers)
            elif is_category(ws) and not right:
                if current:
                    entries.append(current)
                    current = None
                # strip trailing qualifiers like "- Numerical Order"
                category = re.sub(r"\s*-\s*Numerical Order\s*$", "", text).strip()
            elif current:
                if left:
                    more = " ".join(w["text"] for w in left)
                    desc = current["description"]
                    # join words hyphenated across line breaks ("vio-" + "lated")
                    if desc.endswith("-") and more[:1].islower():
                        current["description"] = desc[:-1] + more
                    else:
                        current["description"] = (desc + " " + more).strip()
                assign_amounts(current, right, centers)

    if current:
        entries.append(current)
    return entries


def link_to_statutes(entries):
    """Attach {title_key, chapter_key} for section keys present in data/."""
    locations = {}
    for fname in sorted(os.listdir(DATA_DIR)):
        if not (fname.startswith("title_") and fname.endswith(".json")):
            continue
        with open(os.path.join(DATA_DIR, fname), encoding="utf-8") as f:
            title = json.load(f)
        for chapter in title.get("chapters") or []:
            for section in chapter.get("sections") or []:
                key = (section.get("section_key") or "").lower()
                if key and key not in locations:
                    locations[key] = {
                        "title_key": title["title_key"],
                        "chapter_key": chapter["chapter_key"],
                    }

    linked = 0
    for entry in entries:
        key = entry["section_key"]
        ref = locations.get(key)
        # PDF extraction sometimes mangles offense markers into the citation
        # (e.g. "22-90(1st offense)" -> "22-901st"); strip mangled ordinals
        if ref is None:
            m = re.match(r"^(.*)(?:1st|2nd|3rd|\dth)$", key)
            if m and locations.get(m.group(1)):
                key = m.group(1)
                ref = locations[key]
                if entry["citation"] == entry["section_key"]:
                    entry["citation"] = key
        # likewise subsection markers (e.g. "14-100a(c" -> "14-100ac");
        # trim trailing letters until it links
        while ref is None and key and key[-1].isalpha():
            key = key[:-1]
            ref = locations.get(key)
        if ref:
            entry["section_key"] = key
            linked += 1
        entry["ref"] = ref
    return linked


def main():
    if not os.path.exists(PDF_PATH):
        sys.exit(f"Missing {PDF_PATH} — download it from {SOURCE_URL}")

    with pdfplumber.open(PDF_PATH) as pdf:
        first_page_text = pdf.pages[0].extract_text() or ""
        effective = None
        m = re.search(r"Effective\s+(\w+\s+\d{1,2},\s+\d{4})", first_page_text)
        if m:
            effective = m.group(1)
        entries = parse_schedule(pdf)

    linked = link_to_statutes(entries)

    out = {
        "source": {
            "url": SOURCE_URL,
            "title": "Mail-In Violations and Infractions Schedule (Chart A)",
            "publisher": "State of Connecticut Judicial Branch",
            "effective": effective,
            "generated": date.today().isoformat(),
        },
        "entries": entries,
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    cats = sorted({e["category"] for e in entries if e["category"]})
    print(f"Parsed {len(entries)} entries across {len(cats)} categories "
          f"({linked} linked to statutes) -> {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
