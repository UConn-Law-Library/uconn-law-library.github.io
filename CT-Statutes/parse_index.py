#!/usr/bin/env python3
"""
CT General Statutes subject-index parser (LCO index PDFs).

Input:  "Index A-H.pdf", "Index I-S.pdf", "Index T-Z.pdf"
        (https://www.cga.ct.gov/lco/statutes-index.asp)
Output: data/statutes_index.json

Page layout: two columns; bold all-caps main headings at the column base
indent; subentries indented in 9pt steps; runover (wrapped) lines indented
two steps past their entry; "HEADING—Cont'd" markers repeat the heading at
the top of continuation columns.

Output schema:
{
  "source": {...},
  "headings": [
    {"h": "ABANDONMENT",
     "items": [
       {"l": 0, "t": "Aircraft", "r": [["15-76", "15-76"]]},
       {"l": 0, "t": "Children—See CHILDREN AND MINORS, at Abandonment.",
        "see": [["CHILDREN AND MINORS", "Abandonment"]]},
       ...
     ]}
  ]
}
  l    indent level (0 = directly under the heading)
  t    entry text (refs removed)
  r    statute references: [display, base_section_key | null]
       (null base key for constitution citations)
  see  cross-references: [target heading, target subheading | null]

Dependencies: pip install pdfplumber
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date

import pdfplumber

PDF_FILES = ["Index A-H.pdf", "Index I-S.pdf", "Index T-Z.pdf"]
DATA_DIR = "data"
OUTPUT_PATH = os.path.join(DATA_DIR, "statutes_index.json")
SOURCE_URL = "https://www.cga.ct.gov/lco/statutes-index.asp"

COLUMN_SPLIT_X = 295        # left column starts ~123, right column ~312
COLUMN_BASES = (123.0, 312.0)
INDENT_STEP = 9.0
HEADER_TOP = 110            # page number / INDEX running head sits above this
BODY_FONT_SIZE_MAX = 9.5    # intro text and letter dividers are larger

# statute section reference, e.g. 15-76, 19a-601(d), 16-245(j)
SEC_REF_RE = re.compile(r"^(\d+[a-z]{0,3}-\d+[a-z]{0,3})((?:\([^()]*\))*)[,.;]?$")
# tokens that belong to constitution citations: U.S. Const. Am. XIV:1
CONST_TOKEN_RE = re.compile(r"^(?:U\.S\.|Ct\.|Const\.|Am\.|[IVXLC]+(?::\d+[a-z]?)?[,.;]?)$")
CONST_REF_RE = re.compile(
    r"(?:U\.S\.|Ct\.)\s+Const\.(?:\s+Am\.)?\s+[IVXLC]+(?::\d+[a-z]?)?", re.IGNORECASE)
CONTD_RE = re.compile(r"[—–-]\s*Cont[’']?d\.?$")


def line_text(words):
    """Join words, inserting spaces only across real gaps."""
    out = []
    prev_x1 = None
    for w in words:
        if prev_x1 is not None and w["x0"] - prev_x1 > 1.0:
            out.append(" ")
        out.append(w["text"])
        prev_x1 = w["x1"]
    return "".join(out).strip()


def is_caps(text):
    letters = re.sub(r"[^A-Za-z]", "", text)
    return bool(letters) and letters.upper() == letters


def token_is_ref(tok):
    return bool(SEC_REF_RE.match(tok) or CONST_TOKEN_RE.match(tok))


def is_ref_only(text):
    toks = text.split()
    return bool(toks) and all(token_is_ref(t) for t in toks)


def has_terminator(text):
    if not text:
        return False
    if text.endswith((".", ",", ";", ":")):
        return True
    return token_is_ref(text.split()[-1])


def split_refs(text):
    """Split trailing statute/constitution references off an entry text."""
    toks = text.split()
    i = len(toks)
    while i > 0 and token_is_ref(toks[i - 1]):
        i -= 1
    desc = " ".join(toks[:i]).rstrip(",;").strip()
    tail = " ".join(toks[i:])
    refs = []
    rest = tail
    # constitution citations first (they contain several tokens)
    for m in CONST_REF_RE.finditer(tail):
        refs.append([m.group(0).rstrip(",.;"), None])
    rest = CONST_REF_RE.sub(" ", rest)
    for tok in rest.split():
        m = SEC_REF_RE.match(tok)
        if m:
            refs.append([(m.group(1) + m.group(2)).rstrip(",.;"), m.group(1)])
    return desc, refs


def split_see(text):
    """Extract cross-reference targets from '—See X, at Y.' style text."""
    m = re.search(r"\bSee(?:\s+also)?\s+(.+)$", text)
    if not m:
        return None
    targets = []
    for part in m.group(1).split(";"):
        part = part.strip().rstrip(".").strip()
        if not part:
            continue
        if ", at " in part:
            head, sub = part.split(", at ", 1)
        else:
            head, sub = part, None
        head = head.strip().rstrip(",")
        if is_caps(head):
            targets.append([head, sub.strip() if sub else None])
    return targets or None


class IndexParser:
    def __init__(self):
        self.headings = []          # output list
        self.by_name = {}           # heading name -> heading dict
        self.heading = None         # current heading dict
        self.entry = None           # open entry: {"t": str}
        self.entry_level = 0
        self.just_opened = False    # heading opened by the previous line
        self.opened_new = False     # last open_heading created a new heading
        self.body_count = 99        # body lines since last "—Cont'd" heading

    def flush_entry(self):
        if not self.entry:
            return
        text = self.entry["t"].strip()
        self.entry = None
        if not text or not self.heading:
            return
        desc, refs = split_refs(text)
        if not desc and not refs:
            return
        item = {"l": self.entry_level, "t": desc if desc else text}
        if refs:
            item["r"] = refs
        see = split_see(desc)
        if see:
            item["see"] = see
        self.heading["items"].append(item)

    def open_heading(self, name):
        self.flush_entry()
        name = name.strip()
        if not name:
            return
        existing = self.by_name.get(name)
        if existing is not None:
            self.heading = existing
            self.opened_new = False
            return
        self.heading = {"h": name, "items": []}
        self.by_name[name] = self.heading
        self.headings.append(self.heading)
        self.opened_new = True

    def switch_to_wrapped(self, second_half):
        """Handle the second line of a heading that wrapped at a column top.

        "ADMINISTRATIVE SERVICES\nDEPARTMENT—Cont'd" makes the previous line
        look like a heading of its own; if first+second names a known heading,
        switch to it and drop the spurious fragment.
        """
        if not (self.just_opened and self.heading):
            return False
        candidate = self.join_wrapped(self.heading["h"], second_half)
        target = self.by_name.get(candidate)
        if target is None:
            return False
        if target is not self.heading and self.opened_new and not self.heading["items"]:
            self.by_name.pop(self.heading["h"], None)
            self.headings.remove(self.heading)
        self.heading = target
        return True

    @staticmethod
    def join_wrapped(cur, text):
        # PDF line-break hyphens are soft: "MAM-" + "MOGRAPHIC" -> "MAMMOGRAPHIC"
        if cur.endswith("-") and text[:1].isalpha():
            return cur[:-1] + text
        return cur + " " + text

    def join_entry(self, text):
        self.entry["t"] = self.join_wrapped(self.entry["t"], text)

    def feed_line(self, level, text):
        caps = is_caps(text)

        if CONTD_RE.search(text):
            base = CONTD_RE.sub("", text).strip().rstrip(",")
            # "HEADING—Cont'd" at a column top: re-establish heading context.
            # Re-stated parent subentries ("Damages,—Cont'd", "AIDS,—Cont'd")
            # are skipped — their children attach to the original entry list.
            restated_sub = re.search(r",\s*[—–-]\s*Cont", text)
            if is_caps(base) and not restated_sub:
                if self.switch_to_wrapped(base):
                    self.body_count = 0
                    self.just_opened = False
                    return
                # an entry cut off mid-line at the column break stays open so
                # its continuation can rejoin after the Cont'd block
                if self.entry and has_terminator(self.entry["t"]):
                    self.flush_entry()
                # when the previous line opened a heading, this Cont'd line is
                # the second half of a wrapped "X—Cont'd" — use the full name
                if self.just_opened and self.heading:
                    base = self.join_wrapped(self.heading["h"], base)
                if not self.heading or self.heading["h"] != base:
                    self.flush_entry()
                    self.open_heading(base)
                self.body_count = 0
            elif (self.entry and self.body_count == 1
                    and not has_terminator(self.entry["t"])):
                # a long re-stated parent wraps: its first half was mistaken
                # for a new entry on the previous line — drop it
                self.entry = None
            self.just_opened = False
            return

        self.body_count += 1

        # entry continuations come first: runovers are indented two steps past
        # their entry (and may be ALL CAPS, e.g. a wrapped See-reference)
        if self.entry is not None and not (caps and level == 0):
            if (is_ref_only(text)
                    or not has_terminator(self.entry["t"])
                    or level - self.entry_level >= 2):
                self.join_entry(text)
                return

        # all-caps acronym subentries ("AIDS,", "PCB,") sit at the heading
        # indent but end with a comma — real headings never do
        caps_heading = caps and not text.rstrip().endswith(",")

        if (caps_heading and self.just_opened and self.heading
                and self.entry is None):
            # likely the second line of a long heading
            if self.switch_to_wrapped(text):
                return
            if self.opened_new and not self.heading["items"]:
                del self.by_name[self.heading["h"]]
                self.heading["h"] = self.join_wrapped(self.heading["h"], text)
                self.by_name[self.heading["h"]] = self.heading
                return
            if level > 0:
                # previous line reused an existing heading that is a prefix
                # of this longer one ("HUMAN RIGHTS AND OPPORTUNITIES" /
                # "…COMMISSION") — open the combined heading, leave the
                # short one and its items intact
                self.open_heading(self.join_wrapped(self.heading["h"], text))
                return

        if caps_heading and level == 0 and not is_ref_only(text):
            self.flush_entry()
            self.open_heading(text)
            self.just_opened = True
            return

        self.just_opened = False
        self.flush_entry()
        self.entry = {"t": text}
        self.entry_level = level

    def finish(self):
        self.flush_entry()
        return self.headings


def page_column_lines(page):
    """Yield (level, text) for body lines, left column then right column."""
    words = [
        w for w in page.extract_words(x_tolerance=1, extra_attrs=["size"])
        if w["top"] > HEADER_TOP and w["size"] <= BODY_FONT_SIZE_MAX
    ]
    for col in (0, 1):
        col_words = sorted(
            (w for w in words
             if (w["x0"] < COLUMN_SPLIT_X) == (col == 0)),
            key=lambda w: (w["top"], w["x0"]))
        lines = []
        current, current_top = [], None
        for w in col_words:
            if current_top is None or w["top"] - current_top <= 2.5:
                current.append(w)
                if current_top is None:
                    current_top = w["top"]
            else:
                lines.append(current)
                current, current_top = [w], w["top"]
        if current:
            lines.append(current)
        base = COLUMN_BASES[col]
        for ws in lines:
            ws.sort(key=lambda w: w["x0"])
            x0 = ws[0]["x0"]
            level = max(0, round((x0 - base) / INDENT_STEP))
            text = line_text(ws)
            if text:
                yield level, text


def parse_file(args):
    path, limit = args
    parser = IndexParser()
    with pdfplumber.open(path) as pdf:
        pages = pdf.pages[:limit] if limit else pdf.pages
        for page in pages:
            for level, text in page_column_lines(page):
                parser.feed_line(level, text)
            try:  # keep memory flat across thousands of pages
                page.flush_cache()
                page.get_textmap.cache_clear()
            except AttributeError:
                pass
    return parser.finish()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="parse only the first N pages of each PDF (debug)")
    ap.add_argument("--serial", action="store_true",
                    help="parse files sequentially instead of in parallel")
    args = ap.parse_args()

    missing = [f for f in PDF_FILES if not os.path.exists(f)]
    if missing:
        sys.exit(f"Missing PDFs: {missing} — download from {SOURCE_URL}")

    jobs = [(f, args.limit) for f in PDF_FILES]
    if args.serial:
        results = [parse_file(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=len(jobs)) as pool:
            results = list(pool.map(parse_file, jobs))

    headings = []
    seen = {}
    for part in results:
        for h in part:
            if h["h"] in seen:           # heading split across PDF boundaries
                seen[h["h"]]["items"].extend(h["items"])
            else:
                seen[h["h"]] = h
                headings.append(h)

    out = {
        "source": {
            "url": SOURCE_URL,
            "title": "Index to the General Statutes of Connecticut",
            "publisher": "Connecticut General Assembly, Legislative Commissioners' Office",
            "revised": "Revision of 1958, revised to January 1, 2025",
            "generated": date.today().isoformat(),
        },
        "headings": headings,
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    items = sum(len(h["items"]) for h in headings)
    refs = sum(len(i.get("r", [])) for h in headings for i in h["items"])
    sees = sum(len(i.get("see", [])) for h in headings for i in h["items"])
    size_mb = os.path.getsize(OUTPUT_PATH) / 1e6
    print(f"{len(headings)} headings, {items} items, {refs} refs, "
          f"{sees} cross-refs -> {OUTPUT_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
