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
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, Optional, Set

HERE = Path(__file__).resolve().parent

DEFAULT_YEAR = 2026
OUTPUT_DIR = HERE / "data" / "supplement"

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


crawl = load_crawler_module()


def supplement_titles_url(year: int) -> str:
    return f"https://www.cga.ct.gov/{year}/sup/titles.htm"


def build_supplement(
    cfg,
    year: int,
    only_titles: Optional[Set[str]] = None,
    output_dir: Path = OUTPUT_DIR,
) -> Dict:
    import requests

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
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
        title_path = output_dir / title_filename

        try:
            title_html = crawl.fetch_html(session, title_url, cfg)
            chapter_links = crawl.extract_chapter_links(title_html, title_url)
        except Exception as exc:
            raise RuntimeError(
                f"Failed while processing supplement {title_label} "
                f"({title_url}): {exc}") from exc

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
                sections = crawl.extract_section_links(
                    chap_html, chap_url, expected_title_key=title_key)
                sec_text_map = crawl.extract_section_text_map(chap_html, sections)
                repealed_note_map = crawl.extract_repealed_note_map(chap_html)
                chap_soup = None

                for s in sections:
                    k = str(s.get("section_key") or "").strip().lower()
                    grouped_keys = list(s.get("section_keys") or [])
                    label = str(s.get("label") or "")

                    if grouped_keys:
                        if chap_soup is None:
                            from bs4 import BeautifulSoup
                            chap_soup = BeautifulSoup(chap_html, "html.parser")
                        s["content"] = crawl.extract_grouped_section_content(
                            chap_html, s, chap_soup)
                    else:
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

                    crawl.apply_section_status(s["content"], label)
                    map_keys = grouped_keys or ([k] if k else [])
                    for mk in map_keys:
                        if mk in sec_map:
                            raise RuntimeError(
                                f"Duplicate supplement section key {mk}")
                        entry = {
                            "t": title_key,
                            "c": chap_key,
                            "l": label or f"Sec. {mk}",
                            "f": title_filename,
                        }
                        status = s["content"].get("status")
                        if status:
                            entry["status"] = status
                        sec_map[mk] = entry

                chap_obj["sections"] = sections
                if chap_key in chap_map:
                    raise RuntimeError(
                        f"Duplicate supplement chapter key {chap_key}")
                chap_map[chap_key] = {"t": title_key}
            except Exception as exc:
                raise RuntimeError(
                    f"Failed while processing supplement {title_label}, "
                    f"{chap_label} ({chap_url}): {exc}") from exc

            title_obj["chapters"].append(chap_obj)

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
        with (output_dir / "supplement_index.json").open("w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        print("Saved supplement/supplement_index.json")

        overlay = {
            "source": source,
            "titles": [t["title_key"] for t in index["titles"]],
            "chapters": chap_map,
            "sections": sec_map,
        }
        with (output_dir / "supplement_map.json").open("w", encoding="utf-8") as f:
            json.dump(overlay, f, ensure_ascii=False, indent=2)
        print(f"Saved supplement/supplement_map.json "
              f"({len(sec_map):,} sections, {len(chap_map):,} chapters)")

    return index


def validate_staged_supplement(
    index: Dict,
    output_dir: Path,
    only_titles: Optional[Set[str]] = None,
) -> None:
    """Validate the separate supplement dataset before publishing it."""
    output_dir = Path(output_dir)
    index_title_keys = {
        str(entry.get("title_key")) for entry in index.get("titles") or []
    }
    # Reuse per-title/chapter/group validation without requiring the base
    # crawler's titles_index.json filename.
    crawl.validate_staged_base_crawl(
        index, output_dir, only_titles=only_titles or index_title_keys)
    if only_titles:
        return

    try:
        with (output_dir / "supplement_index.json").open(encoding="utf-8") as f:
            staged_index = json.load(f)
        with (output_dir / "supplement_map.json").open(encoding="utf-8") as f:
            overlay = json.load(f)
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Unreadable staged supplement manifest: {exc}") \
            from exc

    if staged_index != index:
        raise RuntimeError(
            "Staged supplement_index.json differs from crawl index")
    if set(overlay.get("titles") or []) != index_title_keys:
        raise RuntimeError(
            "Staged supplement_map title set differs from crawl index")

    known_statuses = {"repealed", "reserved", "transferred", "obsolete", "mixed"}
    for key, entry in (overlay.get("sections") or {}).items():
        if not all(entry.get(name) for name in ("t", "c", "l", "f")):
            raise RuntimeError(
                f"Staged supplement map entry {key} is incomplete: {entry}")
        if entry.get("status") and entry["status"] not in known_statuses:
            raise RuntimeError(
                f"Staged supplement map entry {key} has unknown status "
                f"{entry['status']!r}")
        if not (output_dir / entry["f"]).is_file():
            raise RuntimeError(
                f"Staged supplement map entry {key} points to missing "
                f"file {entry['f']}")


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
    parser.add_argument("--attempts", type=int, default=4,
                        help="Fetch attempts before the crawl fails (default: 4).")
    parser.add_argument("--backoff", type=float, default=1.0,
                        help="Initial exponential retry delay in seconds (default: 1).")
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
        attempts=args.attempts,
        backoff=args.backoff,
    )

    only_titles = {crawl.normalize_title_key(k)
                   for k in args.titles.split(",") if k.strip()} or None
    with tempfile.TemporaryDirectory(
            prefix=".supplement-crawl-", dir=HERE) as tmp:
        staging_dir = Path(tmp)
        index = build_supplement(
            cfg, year=args.year, only_titles=only_titles,
            output_dir=staging_dir)
        validate_staged_supplement(
            index, staging_dir, only_titles=only_titles)

        staged_titles = sorted(
            path.name for path in staging_dir.glob("title_*.json"))
        publish_names = list(staged_titles)
        stale_names = []
        if not only_titles:
            publish_names.extend([
                "supplement_index.json", "supplement_map.json"])
            staged_set = set(staged_titles)
            stale_names = sorted(
                path.name for path in OUTPUT_DIR.glob("title_*.json")
                if path.name not in staged_set)

        crawl.publish_staged_files(
            staging_dir, OUTPUT_DIR, publish_names, stale_names)
        print(f"Published {len(staged_titles)} validated supplement title "
              f"file(s) to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
