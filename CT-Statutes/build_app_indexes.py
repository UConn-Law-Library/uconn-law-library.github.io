#!/usr/bin/env python3
"""Build the lightweight navigation-search index and data version manifest.

Run this after any generated dataset changes.  ``update_data.py`` invokes it
automatically after successful refresh stages.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
MASTER_PATH = DATA_DIR / "titles_index.json"
SEARCH_PATH = DATA_DIR / "search_index.json"
VERSION_PATH = DATA_DIR / "version.json"


def read_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")


def build_search_index(master) -> tuple[int, int]:
    chapters = []
    sections_by_key = {}

    def is_direct_label(label: str, section_key: str) -> bool:
        return bool(re.match(
            rf"^(?:Sec\.\s*)?{re.escape(section_key)}(?:\.|$)",
            label.strip(),
            re.IGNORECASE,
        ))

    for entry in master.get("titles") or []:
        filename = entry.get("file")
        if not filename:
            continue
        title_path = DATA_DIR / filename
        title = read_json(title_path)
        title_key = title.get("title_key") or entry.get("title_key")
        for chapter in title.get("chapters") or []:
            chapter_key = chapter.get("chapter_key")
            if not chapter_key:
                continue
            chapters.append({
                "t": title_key,
                "c": chapter_key,
                "l": chapter.get("label") or f"Chapter {chapter_key}",
                "n": chapter.get("name") or "",
            })
            for section in chapter.get("sections") or []:
                section_key = section.get("section_key")
                if not section_key:
                    continue
                # A few crawler rows describe a renumbered section and expose
                # the old "Formerly Sec." citation as section_key. They are not
                # routes in this title, so keep them out of the navigation map.
                match = re.match(r"^(\d+)([a-z]*)-", section_key, re.IGNORECASE)
                expected_title = ((match.group(1).zfill(2) + match.group(2).lower())
                                  if match else None)
                if expected_title != title_key:
                    continue
                row = {
                    "t": title_key,
                    "c": chapter_key,
                    "s": section_key,
                    "l": section.get("label") or f"Sec. {section_key}",
                }
                previous = sections_by_key.get(section_key)
                if previous is None or (
                    is_direct_label(row["l"], section_key)
                    and not is_direct_label(previous["l"], section_key)
                ):
                    sections_by_key[section_key] = row

    sections = list(sections_by_key.values())

    payload = {
        "source": master.get("source") or {},
        "chapters": chapters,
        "sections": sections,
    }
    write_json(SEARCH_PATH, payload)
    return len(chapters), len(sections)


def data_files(master) -> list[Path]:
    paths = [
        MASTER_PATH,
        DATA_DIR / "statutes_index.json",
        DATA_DIR / "infractions.json",
        SEARCH_PATH,
    ]
    paths.extend(
        DATA_DIR / entry["file"]
        for entry in master.get("titles") or []
        if entry.get("file")
    )
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing generated data files: " + ", ".join(missing))
    return paths


def source_summary(payload) -> dict:
    source = payload.get("source") or {}
    return {
        key: source[key]
        for key in ("generated_at_utc", "generated", "revised", "effective")
        if source.get(key)
    }


def compute_digest(paths) -> tuple[str, int]:
    """Deterministic hash + byte total over the given data files.

    validate_data.py recomputes this to prove version.json matches the
    committed data, so any change here must ship with that check.
    """
    digest = hashlib.sha256()
    total_bytes = 0
    for path in sorted(paths, key=lambda item: item.name):
        raw = path.read_bytes()
        total_bytes += len(raw)
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(raw)
        digest.update(b"\0")
    return digest.hexdigest(), total_bytes


def build_version(master, chapter_count: int, section_count: int) -> tuple[str, int, int]:
    paths = data_files(master)
    version, total_bytes = compute_digest(paths)
    statutes_index = read_json(DATA_DIR / "statutes_index.json")
    infractions = read_json(DATA_DIR / "infractions.json")
    payload = {
        "schema": 1,
        "version": version,
        "files": len(paths),
        "bytes": total_bytes,
        # Record counts let a refresh diff (and validate_data.py --baseline)
        # flag a dataset that silently shrank or ballooned.
        "counts": {
            "titles": len(master.get("titles") or []),
            "chapters": chapter_count,
            "sections": section_count,
            "index_headings": len(statutes_index.get("headings") or []),
            "infractions": len(infractions.get("entries") or []),
        },
        "sources": {
            "statutes": source_summary(master),
            "index": source_summary(statutes_index),
            "infractions": source_summary(infractions),
        },
    }
    write_json(VERSION_PATH, payload)
    return version, len(paths), total_bytes


def main() -> None:
    master = read_json(MASTER_PATH)
    chapter_count, section_count = build_search_index(master)
    version, file_count, total_bytes = build_version(master, chapter_count, section_count)
    print(
        f"Built {SEARCH_PATH.name}: {chapter_count:,} chapters, "
        f"{section_count:,} sections"
    )
    print(
        f"Built {VERSION_PATH.name}: {version[:16]} "
        f"({file_count} files, {total_bytes / 1e6:.1f} MB)"
    )


if __name__ == "__main__":
    main()
