#!/usr/bin/env python3
"""
CT General Statutes SUPPLEMENT crawler (cga.ct.gov)
- Starts at: https://www.cga.ct.gov/<year>/sup/titles.htm  (default year: 2026)
- Traverses: Titles -> Chapters -> Sections, exactly like ct_CGS_Crawl-v2.py.
  The supplement is a sparse subset of the General Statutes: only titles,
  chapters and sections amended since the last revision appear.
- Page markup is identical to /current/pub/, so all extraction logic is
  imported from ct_CGS_Crawl-v2.py rather than duplicated.

Outputs (under data/supplement/ beside this script):
  - title_XX.json          one per supplement title, same shape as the main
                           crawl so the app can render them with the same code
  - supplement_index.json  master index (analog of titles_index.json)
  - supplement_map.json    flat overlay: section_key -> location in the
                           supplement dataset, plus the chapter and title key
                           sets, so the app can badge amended sections and
                           fetch the supplement text on demand

Dependencies:
  pip install requests beautifulsoup4
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Set

from bs4 import BeautifulSoup, Tag

HERE = Path(__file__).resolve().parent

DEFAULT_YEAR = 2026
OUTPUT_DIR = HERE / "data" / "supplement"

# Grouped repeal anchors, e.g. #secs_10-511_and_10-511a or
# #secs_20-341s_to_20-341bb — a single heading covering a run of repealed
# sections. The single-section regexes in the main crawler skip these.
SECS_FRAG_RE = re.compile(r"#(secs_[0-9a-z_\-]+)$", re.IGNORECASE)
SEC_KEY_PART_RE = re.compile(r"^(.*-)(\d+)([a-z]*)$")

# "Section 12-330mm is repealed, effective ..." / "Sections 10-511 and
# 10-511a are repealed, ..." at the start of a section body.
REPEAL_TEXT_RE = re.compile(r"^Sections?\s[^.]{0,200}?\b(?:is|are)\srepealed\b",
                            re.IGNORECASE)


def load_crawler_module():
    """Load ct_CGS_Crawl-v2.py (its filename is not importable directly)."""
    path = HERE / "ct_CGS_Crawl-v2.py"
    spec = importlib.util.spec_from_file_location("cgs_crawl_v2", path)
    module = importlib.util.module_from_spec(spec)
    # @dataclass resolves the module's string annotations through
    # sys.modules, so register it before executing.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# Importing ct_CGS_Crawl-v2.py runs its module-level os.makedirs("data"),
# which is relative to the CWD; anchor it beside the scripts like the main
# crawler expects.
os.chdir(HERE)
crawl = load_crawler_module()


def supplement_titles_url(year: int) -> str:
    return f"https://www.cga.ct.gov/{year}/sup/titles.htm"


def _suffix_ord(suffix: str) -> Optional[int]:
    """CGS letter suffixes run a..z, aa, bb, ..., zz (same letter doubled)."""
    if not suffix or suffix != suffix[0] * len(suffix):
        return None
    return (len(suffix) - 1) * 26 + (ord(suffix[0]) - ord("a") + 1)


def _suffix_from_ord(n: int) -> str:
    q, r = divmod(n - 1, 26)
    return chr(ord("a") + r) * (q + 1)


def expand_grouped_keys(frag: str) -> List[str]:
    """'secs_20-341s_to_20-341bb' -> ['20-341s', '20-341t', ..., '20-341bb'].

    '_and_' joins the listed keys; '_to_' expands the run when the endpoints
    differ only in their trailing number or letter suffix. If a run cannot be
    expanded, the endpoints alone are returned.
    """
    body = frag[len("secs_"):]
    if "_and_" in body:
        return [k for k in body.split("_and_") if k]
    if "_to_" not in body:
        return [body] if body else []

    lo, hi = (body.split("_to_") + [""])[:2]
    m_lo, m_hi = SEC_KEY_PART_RE.match(lo), SEC_KEY_PART_RE.match(hi)
    if m_lo and m_hi and m_lo.group(1) == m_hi.group(1):
        prefix = m_lo.group(1)
        num_lo, num_hi = int(m_lo.group(2)), int(m_hi.group(2))
        suf_lo, suf_hi = m_lo.group(3), m_hi.group(3)
        if num_lo == num_hi:
            a, b = _suffix_ord(suf_lo), _suffix_ord(suf_hi)
            if a is not None and b is not None and 0 < b - a < 100:
                return [f"{prefix}{num_lo}{_suffix_from_ord(n)}"
                        for n in range(a, b + 1)]
        elif not suf_lo and not suf_hi and 0 < num_hi - num_lo < 100:
            return [f"{prefix}{n}" for n in range(num_lo, num_hi + 1)]
    return [k for k in (lo, hi) if k]


def extract_grouped_content(soup: BeautifulSoup, frag: str,
                            label: str) -> Optional[Dict[str, object]]:
    """Extract the body of a grouped #secs_... entry (typically a repeal note).

    Mirrors the main crawler's per-section extraction: the paragraph holding
    the anchor plus following <p>/<li> siblings, classified by CSS class,
    stopping at the next section anchor or nav table.
    """
    start = soup.find(id=frag)
    if not start:
        return None
    container = start.find_parent(["p", "li"])
    if not container:
        return None

    body: List[str] = []
    source: List[str] = []
    history: List[str] = []
    annotations: List[Dict[str, object]] = []

    def add(txt: str, classes: List[str]) -> None:
        if "source-first" in classes or "source" in classes:
            source.append(txt)
        elif "history-first" in classes or "history" in classes:
            history.append(txt)
        elif "annotation-first" in classes:
            annotations.append({"first": True, "text": txt})
        elif "annotation" in classes:
            annotations.append({"first": False, "text": txt})
        else:
            body.append(txt)

    txt = crawl.text_clean(container.get_text(" ", strip=True))
    if label and txt.startswith(label):
        txt = txt[len(label):].strip()
    if txt:
        add(txt, container.get("class", []) or [])

    for el in container.next_siblings:
        if not isinstance(el, Tag):
            continue
        if el.name == "table":
            break
        if el.name not in ("p", "li"):
            continue
        nested = el.find(lambda t: isinstance(t, Tag)
                         and crawl._is_section_anchor_tag(t))
        if nested is not None or crawl._is_section_anchor_tag(el):
            break
        p_txt = crawl.text_clean(el.get_text(" ", strip=True))
        if p_txt:
            add(p_txt, el.get("class", []) or [])

    text = "\n\n".join(body).strip()
    if not text:
        return None
    content: Dict[str, object] = {
        "body_paragraphs": body,
        "source": source,
        "history": history,
        "annotations": annotations,
        "text": text,
    }
    if REPEAL_TEXT_RE.match(text):
        content["status"] = "repealed"
    return content


def build_supplement(cfg, year: int, only_titles: Optional[Set[str]] = None) -> Dict:
    import requests

    session = requests.Session()
    session.headers.update({"User-Agent": crawl.UA})

    titles_url = supplement_titles_url(year)
    titles_html = crawl.fetch_html(session, titles_url, cfg)
    title_links = crawl.extract_title_links(titles_html, titles_url)

    if only_titles:
        title_links = [t for t in title_links if t[0] in only_titles]
        missing = only_titles - {t[0] for t in title_links}
        if missing:
            raise SystemExit(f"Title key(s) not in the {year} supplement: "
                             f"{', '.join(sorted(missing))}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    source = {
        "kind": "supplement",
        "supplement_year": year,
        "titles_url": titles_url,
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "user_agent": crawl.UA,
    }

    index: Dict = {"source": source, "titles": []}

    # Overlay map: lets the app answer "does section X / chapter Y / title Z
    # have a supplement entry?" without loading any per-title file.
    sec_map: Dict[str, Dict[str, str]] = {}
    chap_map: Dict[str, Dict[str, str]] = {}

    for i, (title_key, title_label, title_name, title_url) in enumerate(title_links, 1):
        print(f"Processing {title_label} ({i}/{len(title_links)})...")

        title_obj = {
            "title_key": title_key,
            "label": title_label,
            "name": title_name,
            "url": title_url,
            "supplement_year": year,
            "chapters": [],
        }

        title_filename = f"title_{title_key}.json"
        title_path = OUTPUT_DIR / title_filename

        try:
            title_html = crawl.fetch_html(session, title_url, cfg)
            chapter_links = crawl.extract_chapter_links(title_html, title_url)

            for chap_key, chap_label, chap_name, chap_url in chapter_links:
                chap_obj = {
                    "chapter_key": chap_key,
                    "label": chap_label,
                    "name": chap_name,
                    "url": chap_url,
                    "sections": [],
                }

                try:
                    chap_html = crawl.fetch_html(session, chap_url, cfg)
                    sections = crawl.extract_section_links(chap_html, chap_url)
                    sec_text_map = crawl.extract_section_text_map(chap_html, sections)
                    repealed_note_map = crawl.extract_repealed_note_map(chap_html)
                    chap_soup: Optional[BeautifulSoup] = None

                    for s in sections:
                        k = (s.get("section_key") or "").strip().lower()
                        content = sec_text_map.get(k)

                        if (not content) or (not content.get("text")):
                            note = repealed_note_map.get(k)
                            if note:
                                s["content"] = {
                                    "body_paragraphs": [note],
                                    "source": [],
                                    "history": [],
                                    "annotations": [],
                                    "text": note,
                                    "status": "repealed",
                                }
                            else:
                                s["content"] = {
                                    "body_paragraphs": [],
                                    "source": [],
                                    "history": [],
                                    "annotations": [],
                                    "text": "",
                                }
                        else:
                            s["content"] = content

                        # The supplement often marks a repeal as the section's
                        # entire body ("Section X is repealed, effective ...").
                        if (not s["content"].get("status")
                                and REPEAL_TEXT_RE.match(s["content"].get("text") or "")):
                            s["content"]["status"] = "repealed"

                        map_keys = [k] if k else []
                        label = s.get("label") or ""

                        if not k:
                            # Grouped repeal heading covering several sections
                            # (#secs_A_and_B / #secs_A_to_B): expand it so each
                            # repealed section appears in the overlay map.
                            m = SECS_FRAG_RE.search(s.get("url") or "")
                            if m:
                                frag = m.group(1)
                                if chap_soup is None:
                                    chap_soup = BeautifulSoup(chap_html, "html.parser")
                                grouped = extract_grouped_content(chap_soup, frag, label)
                                if grouped:
                                    s["content"] = grouped
                                map_keys = expand_grouped_keys(frag.lower())
                                if map_keys:
                                    s["section_keys"] = map_keys

                        for mk in map_keys:
                            entry = {
                                "t": title_key,
                                "c": chap_key,
                                "l": label or f"Sec. {mk}",
                                "f": title_filename,
                            }
                            if s["content"].get("status") == "repealed":
                                entry["status"] = "repealed"
                            sec_map[mk] = entry

                    chap_obj["sections"] = sections
                    chap_map[chap_key] = {"t": title_key}

                except Exception as e:
                    chap_obj["error"] = str(e)

                title_obj["chapters"].append(chap_obj)

        except Exception as e:
            title_obj["error"] = str(e)

        with title_path.open("w", encoding="utf-8") as f:
            json.dump(title_obj, f, ensure_ascii=False, indent=2)
        print(f"Saved supplement/{title_filename}")

        index["titles"].append({
            "title_key": title_key,
            "label": title_label,
            "name": title_name,
            "url": title_url,
            "file": title_filename,
        })

    # A partial crawl must not clobber the full index or overlay map.
    if only_titles:
        print("Skipped supplement_index.json and supplement_map.json (partial crawl)")
    else:
        with (OUTPUT_DIR / "supplement_index.json").open("w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        print("Saved supplement/supplement_index.json")

        overlay = {
            "source": source,
            "titles": [t["title_key"] for t in index["titles"]],
            "chapters": chap_map,
            "sections": sec_map,
        }
        with (OUTPUT_DIR / "supplement_map.json").open("w", encoding="utf-8") as f:
            json.dump(overlay, f, ensure_ascii=False, indent=2)
        print(f"Saved supplement/supplement_map.json "
              f"({len(sec_map):,} sections, {len(chap_map):,} chapters)")

    return index


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Crawl the CT General Statutes Supplement to JSON "
                    "(data/supplement/)."
    )
    parser.add_argument("--year", type=int, default=DEFAULT_YEAR,
                        help=f"Supplement year (default: {DEFAULT_YEAR}).")
    parser.add_argument("--sleep", type=float, default=0.3,
                        help="Base sleep between requests (seconds).")
    parser.add_argument("--jitter", type=float, default=0.2,
                        help="Random jitter added to sleep (seconds).")
    parser.add_argument("--timeout", type=float, default=30.0,
                        help="Request timeout (seconds).")
    parser.add_argument("--no-ssl-verify", action="store_true",
                        help="Disable SSL verification (not recommended).")
    parser.add_argument(
        "--titles",
        type=str,
        default="",
        help="Comma-separated title keys to crawl (e.g. '1,42a'). "
             "Crawls everything when omitted; a partial crawl leaves "
             "supplement_index.json and supplement_map.json untouched.",
    )
    args = parser.parse_args()

    # Same SSL handling as the main crawler: cga.ct.gov omits its
    # intermediate certificate, so prefer the OS trust store when available.
    if args.no_ssl_verify:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        verify_ssl: object = False
    else:
        try:
            import truststore
            truststore.inject_into_ssl()
            verify_ssl = True
        except ImportError:
            import certifi
            verify_ssl = certifi.where()

    cfg = crawl.FetchConfig(
        sleep=args.sleep,
        jitter=args.jitter,
        timeout=args.timeout,
        verify_ssl=verify_ssl,
    )

    only_titles = {crawl.normalize_title_key(k)
                   for k in args.titles.split(",") if k.strip()} or None
    build_supplement(cfg, year=args.year, only_titles=only_titles)


if __name__ == "__main__":
    main()
