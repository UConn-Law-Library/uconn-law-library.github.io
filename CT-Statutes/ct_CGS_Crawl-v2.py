#!/usr/bin/env python3
"""
CT General Statutes crawler (cga.ct.gov)
- Starts at: https://www.cga.ct.gov/current/pub/titles.htm
- Traverses: Titles -> Chapters -> Sections (anchors on chapter pages)
- Outputs: JSON to a file beside this .py (cgs_index.json)

Dependencies:
  pip install requests beautifulsoup4
"""

from __future__ import annotations

import argparse
from operator import index
import os
import json
import random
import re
import time
import certifi
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag

# If you're temporarily using verify=False for SSL debugging:
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_TITLES_URL = "https://www.cga.ct.gov/current/pub/titles.htm"
OUTPUT_DIR = "data"
os.makedirs(OUTPUT_DIR, exist_ok=True)

TITLE_ID_RE = re.compile(r"\btitle_(\d+[a-z]?)\b", re.IGNORECASE)
CHAP_ID_RE = re.compile(r"\bchap_(\d+[a-z]?)\b", re.IGNORECASE)

# Section anchors can be like #sec_7-123 or #sec7-123; we extract the key "7-123"
SEC_ANCHOR_RE = re.compile(r"#sec[_-]?([0-9]+[a-z]*-[0-9]+[a-z]*)", re.IGNORECASE)
# Fallback from visible label text like "Sec. 7-123. ..."
SEC_LABEL_RE = re.compile(r"\bSec\.\s*([0-9]+[a-z]*-[0-9]+[a-z]*)\b", re.IGNORECASE)

# Repealed note detection and section-fragment extraction within those paragraphs
REPEALED_RE = re.compile(r"\bare repealed\b", re.IGNORECASE)
SEC_FRAG_RE = re.compile(r"#sec[_-]?([0-9]+[a-z]*-[0-9]+[a-z]*)", re.IGNORECASE)

UA = (
    "Mozilla/5.0 (compatible; CTStatutesIndexer/1.0; "
    "+https://www.cga.ct.gov/current/pub/titles.htm)"
)


@dataclass
class FetchConfig:
    sleep: float
    jitter: float
    timeout: float
    verify_ssl: object


def text_clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def sleep_jitter(cfg: FetchConfig) -> None:
    if cfg.sleep <= 0:
        return
    extra = random.random() * cfg.jitter if cfg.jitter > 0 else 0.0
    time.sleep(cfg.sleep + extra)


def normalize_url(url: str) -> str:
    """
    Remove the fragment so we can compare page equality.
    """
    p = urlparse(url)
    return p._replace(fragment="").geturl()


def a_tags_with_href(soup: BeautifulSoup) -> List[Tag]:
    return [a for a in soup.find_all("a") if isinstance(a, Tag) and a.get("href")]


def fetch_html(session: requests.Session, url: str, cfg: FetchConfig) -> str:
    sleep_jitter(cfg)
    resp = session.get(
        url,
        timeout=cfg.timeout,
        verify=False,
        headers={"User-Agent": UA},
    )
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"
    return resp.text


def merge_link_texts_by_url(raw_links: List[Tuple[str, str]], kind: str) -> Dict[str, Dict[str, str]]:
    """
    Many CGA pages have multiple links pointing at the same URL with different text.
    We merge them into "primary" and "secondary" chunks to form label+name.

    Example:
      "Title 1" (primary) + "Provisions of General Application" (secondary)
    """
    merged: Dict[str, Dict[str, str]] = {}

    for url, txt in raw_links:
        t = text_clean(txt)
        if not t:
            continue
        if url not in merged:
            merged[url] = {"primary": "", "secondary": ""}

        # Heuristic: shorter / more structured goes into primary; longer into secondary
        if kind == "title":
            # prefer "Title X" as primary
            if re.match(r"^Title\s+\d", t, re.IGNORECASE):
                merged[url]["primary"] = t
            else:
                # accumulate secondary
                merged[url]["secondary"] = text_clean((merged[url]["secondary"] + " " + t).strip())
        elif kind == "chapter":
            if re.match(r"^Chapter\s+\d", t, re.IGNORECASE):
                merged[url]["primary"] = t
            else:
                merged[url]["secondary"] = text_clean((merged[url]["secondary"] + " " + t).strip())
        else:
            # generic
            if not merged[url]["primary"]:
                merged[url]["primary"] = t
            else:
                merged[url]["secondary"] = text_clean((merged[url]["secondary"] + " " + t).strip())

    return merged


def extract_title_links(titles_html: str, titles_url: str) -> List[Tuple[str, str, str, str]]:
    soup = BeautifulSoup(titles_html, "html.parser")

    raw: List[Tuple[str, str]] = []
    for a in a_tags_with_href(soup):
        href = a["href"].strip()
        abs_url = urljoin(titles_url, href)
        if not TITLE_ID_RE.search(urlparse(abs_url).path):
            continue
        raw.append((abs_url, a.get_text(" ", strip=True)))

    merged = merge_link_texts_by_url(raw, kind="title")

    titles: List[Tuple[str, str, str, str]] = []
    for abs_url, parts in merged.items():
        m = TITLE_ID_RE.search(abs_url)
        if not m:
            continue
        title_key = m.group(1).lower().zfill(2) if m.group(1).isdigit() else m.group(1).lower()
        title_label = parts["primary"] or f"Title {title_key}"
        title_name = parts["secondary"] or ""
        titles.append((title_key, title_label, title_name, abs_url))

    def sort_key(t: Tuple[str, str, str, str]):
        k = t[0]
        m = re.match(r"^(\d+)([a-z]?)$", k)
        if not m:
            return (9999, k)
        return (int(m.group(1)), m.group(2))

    titles.sort(key=sort_key)
    return titles


def extract_chapter_links(title_html: str, title_url: str) -> List[Tuple[str, str, str, str]]:
    soup = BeautifulSoup(title_html, "html.parser")

    raw: List[Tuple[str, str]] = []
    for a in a_tags_with_href(soup):
        href = a["href"].strip()
        abs_url = urljoin(title_url, href)
        if not CHAP_ID_RE.search(urlparse(abs_url).path):
            continue
        raw.append((abs_url, a.get_text(" ", strip=True)))

    merged = merge_link_texts_by_url(raw, kind="chapter")

    chapters: List[Tuple[str, str, str, str]] = []
    for abs_url, parts in merged.items():
        m = CHAP_ID_RE.search(abs_url)
        if not m:
            continue
        chap_key = m.group(1).lower()
        chap_label = parts["primary"] or f"Chapter {chap_key}"
        chap_name = parts["secondary"] or ""
        chapters.append((chap_key, chap_label, chap_name, abs_url))

    def sort_key(c: Tuple[str, str, str, str]):
        k = c[0]
        num = int(re.match(r"\d+", k).group(0)) if re.match(r"\d+", k) else 0
        suffix = k[len(str(num)) :]
        return (num, suffix)

    chapters.sort(key=sort_key)
    return chapters


def extract_section_links(chapter_html: str, chapter_url: str) -> List[Dict[str, str]]:
    """
    Returns section anchors for THIS chapter page only.
    This prevents pulling cross-references to other chapters.
    """
    soup = BeautifulSoup(chapter_html, "html.parser")
    sections: List[Dict[str, str]] = []
    seen: Set[str] = set()

    chapter_page = normalize_url(chapter_url)

    for a in a_tags_with_href(soup):
        href = a["href"].strip()
        abs_url = urljoin(chapter_url, href)

        # Keep only anchors that point to the same chapter page
        if normalize_url(abs_url) != chapter_page:
            continue

        # Require a section anchor
        if "#sec" not in abs_url.lower():
            continue

        if abs_url in seen:
            continue
        seen.add(abs_url)

        label = text_clean(a.get_text(" ", strip=True))
        m = SEC_ANCHOR_RE.search(abs_url)
        sec_key = m.group(1).lower() if m else ""

        # Fallback: derive from visible label if fragment did not match
        if not sec_key:
            lm = SEC_LABEL_RE.search(label)
            if lm:
                sec_key = lm.group(1).lower()

        sections.append(
            {
                "section_key": sec_key,
                "label": label,
                "url": abs_url,
            }
        )

    return sections


def _find_section_anchor(soup: BeautifulSoup, sec_key: str) -> Optional[Tag]:
    """Find the section boundary anchor for a section key (e.g., '7-123a').

    CGA chapter pages commonly use id/name like:
      - sec_7-123
      - sec7-123
    """
    if not sec_key:
        return None

    candidates = [f"sec_{sec_key}".lower(), f"sec{sec_key}".lower()]

    for anchor in candidates:
        t = soup.find(id=anchor)
        if t:
            return t
        t = soup.find("a", attrs={"name": anchor})
        if t:
            return t
        t = soup.find(attrs={"name": anchor})
        if t:
            return t

    return None


def _is_section_anchor_tag(tag: Tag) -> bool:
    """True if tag looks like a section boundary anchor."""
    if not isinstance(tag, Tag):
        return False
    for attr in ("id", "name"):
        v = tag.get(attr)
        if isinstance(v, str) and v.lower().startswith("sec"):
            return True
    return False


def extract_section_text_map(chapter_html: str, sections: List[Dict[str, str]]) -> Dict[str, Dict[str, object]]:
    soup = BeautifulSoup(chapter_html, "html.parser")
    out: Dict[str, Dict[str, object]] = {}

    def _container_starts_new_section(container: Tag, start_anchor: Tag) -> bool:
        nested = container.find(lambda t: isinstance(t, Tag) and _is_section_anchor_tag(t))
        return bool(nested and nested is not start_anchor)

    def _add_classified(txt: str, classes: List[str],
                        body: List[str], source: List[str], history: List[str],
                        annotations: List[Dict[str, object]]) -> None:
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

    for sec in sections:
        sec_key = (sec.get("section_key") or "").strip().lower()
        if not sec_key:
            continue

        start = _find_section_anchor(soup, sec_key)
        if not start:
            continue

        body: List[str] = []
        source: List[str] = []
        history: List[str] = []
        annotations: List[Dict[str, object]] = []

        # --- NEW: capture the container <p>/<li> that contains the anchor ---
        container = start.find_parent(["p", "li"])
        iterator = start.next_elements  # default

        if container:
            container_text = text_clean(container.get_text(" ", strip=True))
            container_classes = container.get("class", []) or []

            # Strip the section heading label prefix if present
            label = text_clean(sec.get("label") or "")
            body_text = container_text
            if label and body_text.startswith(label):
                body_text = body_text[len(label):].strip()

            if body_text:
                _add_classified(body_text, container_classes, body, source, history, annotations)

            # Continue scanning after the container node (so we don't miss following paragraphs)
            iterator = container.next_elements

        for el in iterator:
            if not isinstance(el, Tag):
                continue

            # Stop at next section boundary anchor
            if _is_section_anchor_tag(el) and el is not start:
                break

            if el.name not in ("p", "li"):
                continue

            # Avoid re-capturing the container we already handled
            if container is not None and el is container:
                continue

            # Prevent capturing the next section's header paragraph (header is often nested inside <p>)
            if _container_starts_new_section(el, start):
                break

            txt = text_clean(el.get_text(" ", strip=True))
            if not txt:
                continue

            classes = el.get("class", []) or []
            _add_classified(txt, classes, body, source, history, annotations)

        # De-dupe adjacent duplicates
        def dedupe(lst):
            out_l = []
            for x in lst:
                if not out_l or out_l[-1] != x:
                    out_l.append(x)
            return out_l

        body = dedupe(body)
        source = dedupe(source)
        history = dedupe(history)

        # Also de-dupe annotations by adjacent duplicate text
        dedup_anno: List[Dict[str, object]] = []
        for a in annotations:
            t = a.get("text", "")
            if not dedup_anno or dedup_anno[-1].get("text") != t:
                dedup_anno.append(a)
        annotations = dedup_anno

        full_text = "\n\n".join(body).strip()

        out[sec_key] = {
            "body_paragraphs": body,
            "source": source,
            "history": history,
            "annotations": annotations,
            "text": full_text,
        }

    return out





def extract_repealed_note_map(chapter_html: str) -> Dict[str, str]:
    """Map section_key -> repealed note text by scanning chapter paragraphs.

    Example paragraph pattern:
      <p>... Sections <a href="...#sec_7-123">7-123</a> to <a href="...#sec_7-125">7-125</a>, inclusive, are repealed.</p>
    """
    soup = BeautifulSoup(chapter_html, "html.parser")
    out: Dict[str, str] = {}

    for p in soup.find_all("p"):
        p_text = text_clean(p.get_text(" ", strip=True))
        if not p_text or not REPEALED_RE.search(p_text):
            continue

        keys: Set[str] = set()
        for a in p.find_all("a", href=True):
            m = SEC_FRAG_RE.search(a["href"])
            if m:
                keys.add(m.group(1).lower())

        for k in keys:
            out[k] = p_text

    return out


def build_index(cfg: FetchConfig) -> Dict:
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    titles_html = fetch_html(session, BASE_TITLES_URL, cfg)
    title_links = extract_title_links(titles_html, BASE_TITLES_URL)

    index: Dict = {
        "source": {
            "titles_url": BASE_TITLES_URL,
            "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "user_agent": UA,
        },
        "titles": [],  # lightweight entries only
    }

    for i, (title_key, title_label, title_name, title_url) in enumerate(title_links, 1):
        print(f"Processing {title_label} ({i}/{len(title_links)})...")

        title_obj = {
            "title_key": title_key,
            "label": title_label,
            "name": title_name,
            "url": title_url,
            "chapters": [],
        }

        title_filename = f"title_{title_key}.json"
        title_path = os.path.join(OUTPUT_DIR, title_filename)

        try:
            title_html = fetch_html(session, title_url, cfg)
            chapter_links = extract_chapter_links(title_html, title_url)

            for chap_key, chap_label, chap_name, chap_url in chapter_links:
                chap_obj = {
                    "chapter_key": chap_key,
                    "label": chap_label,
                    "name": chap_name,
                    "url": chap_url,
                    "sections": [],
                }

                try:
                    chap_html = fetch_html(session, chap_url, cfg)
                    sections = extract_section_links(chap_html, chap_url)
                    sec_text_map = extract_section_text_map(chap_html, sections)
                    repealed_note_map = extract_repealed_note_map(chap_html)

                    for s in sections:
                        k = (s.get("section_key") or "").strip().lower()
                        content = sec_text_map.get(k)

                        # Note: your structured extractor returns body_paragraphs/text/etc.
                        # but your fallback uses {"paragraphs": ...}. Keep consistent here:
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

                    chap_obj["sections"] = sections

                except Exception as e:
                    chap_obj["error"] = str(e)

                title_obj["chapters"].append(chap_obj)

        except Exception as e:
            title_obj["error"] = str(e)

        # ---------- WRITE PER-TITLE FILE (ALWAYS) ----------
        with open(title_path, "w", encoding="utf-8") as f:
            json.dump(title_obj, f, ensure_ascii=False, indent=2)
        print(f"Saved {title_filename}")

        # ---------- ADD LIGHTWEIGHT ENTRY TO MASTER INDEX ----------
        index["titles"].append({
            "title_key": title_key,
            "label": title_label,
            "name": title_name,
            "url": title_url,
            "file": title_filename
        })

    # ---------- WRITE MASTER INDEX (ONCE) ----------
    master_path = os.path.join(OUTPUT_DIR, "titles_index.json")
    with open(master_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print("Saved titles_index.json")

    return index


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl CT General Statutes titles/chapters/sections to JSON.")
    parser.add_argument("--sleep", type=float, default=0.3, help="Base sleep between requests (seconds).")
    parser.add_argument("--jitter", type=float, default=0.2, help="Random jitter added to sleep (seconds).")
    parser.add_argument("--timeout", type=float, default=30.0, help="Request timeout (seconds).")
    parser.add_argument("--no-ssl-verify", action="store_true", help="Disable SSL verification (not recommended).")
    parser.add_argument(
        "--out",
        type=str,
        default="cgs_index.json",
        help="Output JSON filename (written beside this script unless absolute path).",
    )
    args = parser.parse_args()

    cfg = FetchConfig(
        sleep=args.sleep,
        jitter=args.jitter,
        timeout=args.timeout,
        verify_ssl=certifi.where(),
    )

    index = build_index(cfg)

    out_json = json.dumps(index, ensure_ascii=False, indent=2)

    # Write output beside this script unless user provided an absolute path
    if os.path.isabs(args.out):
        output_path = args.out
    else:
        here = os.path.dirname(os.path.abspath(__file__))
        output_path = os.path.join(here, args.out)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(out_json)

    print(f"\nSaved to: {output_path}")
    print(f"File size: {os.path.getsize(output_path)/1024/1024:.2f} MB")


if __name__ == "__main__":
    main()
