#!/usr/bin/env python3
"""
CT General Statutes crawler (cga.ct.gov)
- Starts at: https://www.cga.ct.gov/current/pub/titles.htm
- Traverses: Titles -> Chapters -> Sections (anchors on chapter pages).
  Title 42a (UCC) uses articles instead of chapters; they are crawled the
  same way and stored in the chapters[] shape with keys like "art_002a".
- Outputs: JSON to a file beside this .py (cgs_index.json)

Dependencies:
  pip install requests beautifulsoup4
"""

from __future__ import annotations

import argparse
import os
import json
import random
import re
import tempfile
import time
import certifi
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import unquote, urljoin, urlparse

import requests
import urllib3
from bs4 import BeautifulSoup, Tag

BASE_TITLES_URL = "https://www.cga.ct.gov/current/pub/titles.htm"
HERE = Path(__file__).resolve().parent
OUTPUT_DIR = HERE / "data"

TITLE_ID_RE = re.compile(r"\btitle_(\d+[a-z]?)\b", re.IGNORECASE)
CHAP_ID_RE = re.compile(r"\bchap_(\d+[a-z]*)\b", re.IGNORECASE)
# Title 42a (UCC) is divided into articles (art_001.htm ... art_010.htm)
# instead of chapters; they use the same page layout as chapter pages.
ART_ID_RE = re.compile(r"\bart_(\d+[a-z]?)\b", re.IGNORECASE)

# Section anchors can be like #sec_7-123 or #sec7-123. UCC sections carry a
# second dash (#sec_42a-1-201 -> "42a-1-201"). Keep the fragment pattern
# anchored: CGA also uses grouped fragments such as #sec_10-153p_to_10-153r,
# which must not be mistaken for the individual section 10-153p.
SECTION_KEY_PATTERN = r"[0-9]+[a-z]*-[0-9]+[a-z]*(?:-[0-9]+[a-z]*)?"
SEC_ANCHOR_RE = re.compile(
    rf"#sec[_-]?({SECTION_KEY_PATTERN})$", re.IGNORECASE)
SEC_FRAGMENT_RE = re.compile(
    rf"^sec[_-]?({SECTION_KEY_PATTERN})$", re.IGNORECASE)
# A visible table-of-contents heading is more authoritative than a fragment.
# Requiring the period after the key avoids treating grouped headings such as
# "Sec. 10-153p to 10-153r" as an individual section.
SEC_HEADING_RE = re.compile(
    rf"^\s*Sec\.\s*({SECTION_KEY_PATTERN})\s*\.", re.IGNORECASE)
# Some legacy/obsolete pages use a bare section key as their link text.
SEC_BARE_LABEL_RE = re.compile(
    rf"^\s*({SECTION_KEY_PATTERN})\s*\.?\s*$", re.IGNORECASE)
SECTION_KEY_TOKEN_RE = re.compile(SECTION_KEY_PATTERN, re.IGNORECASE)
SECTION_KEY_PART_RE = re.compile(r"^(.*-)(\d+)([a-z]*)$", re.IGNORECASE)
MAX_GROUP_EXPANSION = 5000

SECTION_STATUS_PATTERNS = (
    ("repealed", re.compile(
        r"^\s*(?:repealed\b|Secs?\..{0,300}?\.\s*repealed\b|"
        r"(?:Secs?\.?|Sections?)\s+.{0,300}?"
        r"\b(?:is|are)\s+repealed\b|All\s+sections\b.{0,300}?\brepealed\b)",
        re.IGNORECASE | re.DOTALL)),
    ("reserved", re.compile(
        r"^\s*(?:reserved\b|(?:Secs?\.?|Sections?)\s+.{0,300}?"
        r"\b(?:is|are)\s+reserved\b|All\s+sections\b.{0,300}?\breserved\b|"
        r"Secs?\..{0,300}?\.\s*Reserved\b)",
        re.IGNORECASE | re.DOTALL)),
    ("transferred", re.compile(
        r"^\s*(?:transferred\b|(?:Secs?\.?|Sections?)\s+(?:are\s+)?transferred\b|"
        r"Secs?\..{0,300}?\.\s*transferred\b|"
        r"(?:Secs?\.?|Sections?)\s+.{0,300}?"
        r"\b(?:is|are)\s+transferred\b|All\s+sections\b.{0,300}?\btransferred\b)",
        re.IGNORECASE | re.DOTALL)),
    ("obsolete", re.compile(
        r"^\s*(?:obsolete\b|Secs?\..{0,300}?\.\s*obsolete\b|"
        r"(?:Secs?\.?|Sections?)\s+.{0,300}?"
        r"\b(?:is|are)\s+obsolete\b|All\s+sections\b.{0,300}?\bobsolete\b)",
        re.IGNORECASE | re.DOTALL)),
)

# Repealed note detection and section-fragment extraction within those paragraphs
REPEALED_RE = re.compile(r"\bare repealed\b", re.IGNORECASE)
SEC_FRAG_RE = re.compile(r"#sec[_-]?([0-9]+[a-z]*-[0-9]+[a-z]*(?:-[0-9]+[a-z]*)?)", re.IGNORECASE)

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
    attempts: int = 4
    backoff: float = 1.0


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
    attempts = max(1, cfg.attempts)
    last_error: Optional[Exception] = None

    for attempt in range(1, attempts + 1):
        sleep_jitter(cfg)
        try:
            resp = session.get(
                url,
                timeout=cfg.timeout,
                verify=cfg.verify_ssl,
                headers={"User-Agent": UA},
            )
            resp.raise_for_status()
            content_type = (resp.headers.get("Content-Type") or "").lower()
            if content_type and "html" not in content_type:
                raise ValueError(
                    f"Expected HTML from {url}, received {content_type!r}")
            if not resp.content:
                raise ValueError(f"Empty response body from {url}")
            resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt >= attempts:
                break
            delay = max(0.0, cfg.backoff) * (2 ** (attempt - 1))
            print(f"WARNING: fetch failed for {url} ({attempt}/{attempts}): "
                  f"{exc}; retrying in {delay:.1f}s")
            if delay:
                time.sleep(delay)

    raise RuntimeError(
        f"Failed to fetch {url} after {attempts} attempt(s): {last_error}") \
        from last_error


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
            if re.match(r"^(?:Chapter|Article)\s+\d", t, re.IGNORECASE):
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
        path = urlparse(abs_url).path
        if not (CHAP_ID_RE.search(path) or ART_ID_RE.search(path)):
            continue
        raw.append((abs_url, a.get_text(" ", strip=True)))

    merged = merge_link_texts_by_url(raw, kind="chapter")

    chapters: List[Tuple[str, str, str, str]] = []
    for abs_url, parts in merged.items():
        m = CHAP_ID_RE.search(abs_url)
        if m:
            chap_key = m.group(1).lower()
            fallback_label = f"Chapter {chap_key}"
        else:
            m = ART_ID_RE.search(abs_url)
            if not m:
                continue
            # Prefix keeps article keys distinct from chapter numbers.
            chap_key = f"art_{m.group(1).lower()}"
            fallback_label = f"Article {m.group(1).lstrip('0').lower()}"
        chap_label = parts["primary"] or fallback_label
        chap_name = parts["secondary"] or ""
        chapters.append((chap_key, chap_label, chap_name, abs_url))

    def sort_key(c: Tuple[str, str, str, str]):
        m = re.match(r"^(?:art_)?0*(\d+)([a-z]*)$", c[0])
        if not m:
            return (0, 0, c[0])
        suffix = m.group(2)
        # CGA advances through single-letter suffixes before double-letter
        # suffixes (319y precedes 319aa), so plain lexical sorting is wrong.
        return (int(m.group(1)), len(suffix), suffix)

    chapters.sort(key=sort_key)
    return chapters


def _section_key_from_heading(label: str) -> str:
    m = SEC_HEADING_RE.match(label or "")
    return m.group(1).lower() if m else ""


def _section_key_from_fragment(fragment: str) -> str:
    m = SEC_FRAGMENT_RE.fullmatch(unquote(fragment or ""))
    return m.group(1).lower() if m else ""


def _section_key_from_bare_label(label: str) -> str:
    m = SEC_BARE_LABEL_RE.fullmatch(label or "")
    return m.group(1).lower() if m else ""


def _section_title_key(section_key: str) -> str:
    """Return the normalized title portion of a section key."""
    m = re.match(r"^(\d+)([a-z]*)-", section_key or "", re.IGNORECASE)
    if not m:
        return ""
    return m.group(1).zfill(2) + m.group(2).lower()


def _suffix_ordinal(suffix: str) -> Optional[int]:
    """Map CGA suffix order: no suffix, a..z, aa, bb, ... zz."""
    suffix = (suffix or "").lower()
    if not suffix:
        return 0
    if suffix != suffix[0] * len(suffix):
        return None
    return (len(suffix) - 1) * 26 + (ord(suffix[0]) - ord("a") + 1)


def _suffix_from_ordinal(n: int) -> str:
    if n == 0:
        return ""
    q, r = divmod(n - 1, 26)
    return chr(ord("a") + r) * (q + 1)


def _expand_section_range(lo: str, hi: str) -> List[str]:
    """Expand a CGA section range when its endpoints share a prefix."""
    lo, hi = lo.lower(), hi.lower()
    m_lo, m_hi = SECTION_KEY_PART_RE.fullmatch(lo), SECTION_KEY_PART_RE.fullmatch(hi)
    if not m_lo or not m_hi or m_lo.group(1).lower() != m_hi.group(1).lower():
        return [lo, hi]

    prefix = m_lo.group(1).lower()
    num_lo, num_hi = int(m_lo.group(2)), int(m_hi.group(2))
    suf_lo, suf_hi = m_lo.group(3).lower(), m_hi.group(3).lower()

    if num_lo == num_hi:
        ord_lo, ord_hi = _suffix_ordinal(suf_lo), _suffix_ordinal(suf_hi)
        if (ord_lo is not None and ord_hi is not None
                and 0 <= ord_hi - ord_lo <= MAX_GROUP_EXPANSION):
            return [f"{prefix}{num_lo}{_suffix_from_ordinal(n)}"
                    for n in range(ord_lo, ord_hi + 1)]

    if (suf_lo == suf_hi and 0 <= num_hi - num_lo <= MAX_GROUP_EXPANSION):
        return [f"{prefix}{n}{suf_lo}" for n in range(num_lo, num_hi + 1)]

    # Preserve both endpoints when the source uses a range that cannot be
    # expanded safely under Connecticut's numbering conventions.
    return [lo, hi]


def _keys_from_group_expression(expression: str) -> List[str]:
    """Extract listed keys and expand adjacent `to` ranges."""
    matches = list(SECTION_KEY_TOKEN_RE.finditer(expression or ""))
    if not matches:
        return []

    keys: List[str] = []
    i = 0
    while i < len(matches):
        current = matches[i].group(0).lower()
        if i + 1 < len(matches):
            between = expression[matches[i].end():matches[i + 1].start()]
            if re.search(r"(?:^|[_\s,])to(?:$|[_\s,])", between,
                         re.IGNORECASE):
                keys.extend(_expand_section_range(
                    current, matches[i + 1].group(0).lower()))
                i += 2
                continue
        keys.append(current)
        i += 1

    # Preserve source order while removing overlapping range/list endpoints.
    return list(dict.fromkeys(keys))


def expand_grouped_section_keys(fragment: str, label: str = "") -> List[str]:
    """Expand grouped section keys from a CGA fragment and heading.

    Handles `_and_`, `_to_`, comma/underscore lists, mixed ranges plus listed
    keys, numeric ranges, and Connecticut's a..z, aa, bb suffix order.
    """
    raw_fragment = unquote(fragment or "").lstrip("#")
    m = re.match(r"^secs?_(.+)$", raw_fragment, re.IGNORECASE)
    fragment_keys = _keys_from_group_expression(m.group(1) if m else "")

    # Fragment identifiers are the cleanest source. Fall back to the initial
    # heading expression after removing Formerly-Sec parentheticals, which
    # would otherwise introduce obsolete keys into the group.
    heading = re.sub(r"\([^)]*Formerly\s+Secs?\.[^)]*\)", "", label or "",
                     flags=re.IGNORECASE)
    heading = re.sub(r"^\s*Secs?\.\s*", "", heading, flags=re.IGNORECASE)
    heading = heading.split(".", 1)[0]
    heading_keys = _keys_from_group_expression(heading)

    keys = fragment_keys
    if len(heading_keys) > len(fragment_keys):
        keys = heading_keys
    return list(dict.fromkeys(keys))


def expand_grouped_keys(fragment: str) -> List[str]:
    """Compatibility wrapper used by older supplement integrations."""
    return expand_grouped_section_keys(fragment)


def detect_section_status(*texts: str) -> List[str]:
    """Return every legal status explicitly present in the supplied text."""
    return [name for name, pattern in SECTION_STATUS_PATTERNS
            if any(pattern.search(text or "") for text in texts)]


def apply_section_status(content: Dict[str, object], *context: str) -> None:
    """Attach a single status or an explicit mixed-status list to content."""
    statuses = detect_section_status(
        *(context + (str(content.get("text") or ""),)))
    if not statuses:
        return
    content["statuses"] = statuses
    content["status"] = statuses[0] if len(statuses) == 1 else "mixed"


def _looks_like_grouped_section_link(fragment: str, label: str) -> bool:
    """Keep grouped rows for the dedicated grouped-range parser."""
    frag = unquote(fragment or "").lower()
    label = (label or "").strip()
    if frag.startswith("secs_"):
        return True
    if re.match(r"^Secs\.\s", label, re.IGNORECASE):
        return True
    return bool(re.match(r"^Sec\.\s.*\b(?:and|to)\b", label,
                         re.IGNORECASE))


def extract_section_links(
    chapter_html: str,
    chapter_url: str,
    expected_title_key: Optional[str] = None,
) -> List[Dict[str, object]]:
    """
    Returns section anchors for THIS chapter page only.
    This prevents pulling cross-references to other chapters.
    """
    soup = BeautifulSoup(chapter_html, "html.parser")
    sections: List[Dict[str, object]] = []
    seen_keys: Set[str] = set()
    seen_unkeyed_urls: Set[str] = set()

    chapter_page = normalize_url(chapter_url)
    expected_title = (normalize_title_key(expected_title_key)
                      if expected_title_key else "")

    for a in a_tags_with_href(soup):
        href = a["href"].strip()
        abs_url = urljoin(chapter_url, href)

        # Keep only anchors that point to the same chapter page
        if normalize_url(abs_url) != chapter_page:
            continue

        fragment = unquote(urlparse(abs_url).fragment)

        # Require a section-like fragment.
        if not fragment.lower().startswith("sec"):
            continue

        label = text_clean(a.get_text(" ", strip=True))
        heading_key = _section_key_from_heading(label)
        fragment_key = _section_key_from_fragment(fragment)
        bare_key = _section_key_from_bare_label(label)

        # Full visible headings are authoritative. Fragment-only and legacy
        # bare-label links remain supported, but are less trustworthy.
        sec_key = heading_key or fragment_key or bare_key
        identifier_warnings: List[str] = []

        if heading_key and fragment_key and heading_key != fragment_key:
            identifier_warnings.append(
                f"heading key {heading_key} disagrees with fragment key "
                f"{fragment_key}; heading key used")
        elif heading_key and not fragment_key:
            identifier_warnings.append(
                f"heading key {heading_key} has noncanonical fragment "
                f"#{fragment}; heading key used")

        if not sec_key:
            # Preserve only intentional grouped rows. Malformed same-page
            # cross-reference fragments should not become empty section rows.
            if not _looks_like_grouped_section_link(fragment, label):
                continue
            if abs_url in seen_unkeyed_urls:
                continue
            seen_unkeyed_urls.add(abs_url)
        else:
            actual_title = _section_title_key(sec_key)
            if expected_title and actual_title != expected_title:
                identifier_warnings.append(
                    f"section key {sec_key} belongs to title {actual_title or '?'} "
                    f"but appears in title {expected_title}")
                # A fragment-only cross-title link is a reference, not a
                # section boundary. A full heading is retained and reported
                # because it represents a source-page anomaly worth auditing.
                if not heading_key:
                    continue

            # Canonical-key deduplication prevents malformed fragment variants
            # and later in-body cross-references from creating duplicate rows.
            if sec_key in seen_keys:
                continue
            seen_keys.add(sec_key)

        section = {
            "section_key": sec_key,
            "label": label,
            "url": abs_url,
        }
        if not sec_key:
            grouped_keys = expand_grouped_section_keys(fragment, label)
            if grouped_keys:
                section["grouped"] = True
                section["section_keys"] = grouped_keys
                if expected_title:
                    wrong_titles = sorted({
                        _section_title_key(key) for key in grouped_keys
                        if _section_title_key(key) != expected_title
                    })
                    if wrong_titles:
                        identifier_warnings.append(
                            "group contains key(s) outside title "
                            f"{expected_title}: {', '.join(wrong_titles)}")
            else:
                identifier_warnings.append(
                    f"grouped section fragment #{fragment} yielded no keys")
        if heading_key and fragment_key and heading_key != fragment_key:
            section["source_fragment_key"] = fragment_key
        if identifier_warnings:
            warning = "; ".join(identifier_warnings)
            section["identifier_warning"] = warning
            print(f"WARNING: {warning} [{abs_url}]")
        sections.append(section)

    return sections


def _find_section_anchor(
    soup: BeautifulSoup,
    sec_key: str,
    source_fragment: str = "",
) -> Optional[Tag]:
    """Find the section boundary anchor for a section key (e.g., '7-123a').

    CGA chapter pages commonly use id/name like:
      - sec_7-123
      - sec7-123

    The lookup is case-insensitive because keys are lowercased while UCC
    anchor ids keep the article's case (e.g. sec_42a-2A-101).
    """
    if not sec_key:
        return None

    patterns = [
        re.compile(rf"^sec[_-]?{re.escape(sec_key)}$", re.IGNORECASE)
    ]
    raw_fragment = unquote(source_fragment or "").strip()
    if raw_fragment:
        raw_pattern = re.compile(rf"^{re.escape(raw_fragment)}$", re.IGNORECASE)
        if raw_pattern.pattern != patterns[0].pattern:
            patterns.append(raw_pattern)

    for pattern in patterns:
        t = soup.find(id=pattern)
        if t:
            return t
        t = soup.find("a", attrs={"name": pattern})
        if t:
            return t
        t = soup.find(attrs={"name": pattern})
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


def extract_grouped_section_content(
    chapter_html: str,
    section: Dict[str, object],
    soup: Optional[BeautifulSoup] = None,
) -> Dict[str, object]:
    """Extract and classify the source record for a grouped section range."""
    soup = soup or BeautifulSoup(chapter_html, "html.parser")
    label = text_clean(str(section.get("label") or ""))
    fragment = unquote(urlparse(str(section.get("url") or "")).fragment)
    anchor_pattern = re.compile(rf"^{re.escape(fragment)}$", re.IGNORECASE)
    start = soup.find(id=anchor_pattern) or soup.find(attrs={"name": anchor_pattern})

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

    container = None
    if isinstance(start, Tag):
        container = (start if start.name in ("p", "li")
                     else start.find_parent(["p", "li"]))
    if container:
        txt = text_clean(container.get_text(" ", strip=True))
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
                             and _is_section_anchor_tag(t))
            if nested is not None or _is_section_anchor_tag(el):
                break
            txt = text_clean(el.get_text(" ", strip=True))
            if txt:
                add(txt, el.get("class", []) or [])

    content: Dict[str, object] = {
        "body_paragraphs": body,
        "source": source,
        "history": history,
        "annotations": annotations,
        "text": "\n\n".join(body).strip(),
    }
    apply_section_status(content, label)
    return content


def extract_section_text_map(
    chapter_html: str,
    sections: List[Dict[str, object]],
) -> Dict[str, Dict[str, object]]:
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

        source_fragment = unquote(urlparse(sec.get("url") or "").fragment)
        start = _find_section_anchor(soup, sec_key, source_fragment)
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


def normalize_title_key(key: str) -> str:
    """'4a' -> '04a', '42A' -> '42a' (matches extract_title_links keys)."""
    m = re.match(r"^(\d+)([a-z]?)$", key.strip().lower())
    if not m:
        return key.strip().lower()
    return m.group(1).zfill(2) + m.group(2)


def build_index(
    cfg: FetchConfig,
    only_titles: Optional[Set[str]] = None,
    output_dir: Path = OUTPUT_DIR,
) -> Dict:
    """Crawl into output_dir, raising immediately on any incomplete page."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    titles_html = fetch_html(session, BASE_TITLES_URL, cfg)
    title_links = extract_title_links(titles_html, BASE_TITLES_URL)

    if only_titles:
        title_links = [t for t in title_links if t[0] in only_titles]
        missing = only_titles - {t[0] for t in title_links}
        if missing:
            raise SystemExit(f"Unknown title key(s): {', '.join(sorted(missing))}")

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
        title_path = output_dir / title_filename

        try:
            title_html = fetch_html(session, title_url, cfg)
            chapter_links = extract_chapter_links(title_html, title_url)
        except Exception as exc:
            raise RuntimeError(
                f"Failed while processing {title_label} ({title_url}): {exc}") \
                from exc

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
                sections = extract_section_links(
                    chap_html, chap_url, expected_title_key=title_key)
                sec_text_map = extract_section_text_map(chap_html, sections)
                repealed_note_map = extract_repealed_note_map(chap_html)
                chap_soup: Optional[BeautifulSoup] = None

                for s in sections:
                    k = str(s.get("section_key") or "").strip().lower()
                    grouped_keys = s.get("section_keys") or []
                    if grouped_keys:
                        if chap_soup is None:
                            chap_soup = BeautifulSoup(chap_html, "html.parser")
                        content = extract_grouped_section_content(
                            chap_html, s, chap_soup)
                        s["content"] = content
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

                    apply_section_status(
                        s["content"], str(s.get("label") or ""))

                chap_obj["sections"] = sections
            except Exception as exc:
                raise RuntimeError(
                    f"Failed while processing {title_label}, {chap_label} "
                    f"({chap_url}): {exc}") from exc

            title_obj["chapters"].append(chap_obj)

        with title_path.open("w", encoding="utf-8") as f:
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
    # A partial crawl must not clobber the full master index.
    if only_titles:
        print("Skipped titles_index.json (partial crawl)")
    else:
        master_path = output_dir / "titles_index.json"
        with master_path.open("w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        print("Saved titles_index.json")

    return index


def validate_staged_base_crawl(
    index: Dict,
    output_dir: Path,
    only_titles: Optional[Set[str]] = None,
) -> None:
    """Validate staged crawler output before any live data file is replaced."""
    output_dir = Path(output_dir)
    entries = index.get("titles") or []
    if not entries:
        raise RuntimeError("Staged crawl contains no titles")

    title_keys = [entry.get("title_key") for entry in entries]
    if len(title_keys) != len(set(title_keys)):
        raise RuntimeError("Staged crawl contains duplicate title keys")
    if only_titles and set(title_keys) != set(only_titles):
        raise RuntimeError(
            f"Staged title set {set(title_keys)} does not match requested "
            f"titles {set(only_titles)}")

    chapter_count = 0
    section_count = 0
    for entry in entries:
        filename = entry.get("file")
        if not filename:
            raise RuntimeError(f"Staged title entry has no file: {entry!r}")
        if Path(str(filename)).name != filename:
            raise RuntimeError(
                f"Staged title entry has unsafe file name: {filename!r}")
        path = output_dir / filename
        try:
            with path.open(encoding="utf-8") as f:
                title = json.load(f)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Unreadable staged title file {path}: {exc}") \
                from exc

        if title.get("error"):
            raise RuntimeError(f"{filename} contains crawler error: "
                               f"{title['error']}")
        if title.get("title_key") != entry.get("title_key"):
            raise RuntimeError(f"{filename} title_key does not match its index")

        chapter_keys: Set[str] = set()
        for chapter in title.get("chapters") or []:
            chapter_count += 1
            chapter_key = chapter.get("chapter_key")
            if not chapter_key or chapter_key in chapter_keys:
                raise RuntimeError(
                    f"{filename} has missing/duplicate chapter key {chapter_key!r}")
            chapter_keys.add(chapter_key)
            if chapter.get("error"):
                raise RuntimeError(
                    f"{filename} chapter {chapter_key} contains crawler error: "
                    f"{chapter['error']}")
            sections = chapter.get("sections") or []
            if not sections:
                raise RuntimeError(
                    f"{filename} chapter {chapter_key} contains no sections")
            for section in sections:
                section_count += 1
                key = section.get("section_key")
                grouped_keys = section.get("section_keys") or []
                if not key and not grouped_keys:
                    raise RuntimeError(
                        f"{filename} chapter {chapter_key} contains an "
                        "unidentified section/group")
                if grouped_keys and len(grouped_keys) != len(set(grouped_keys)):
                    raise RuntimeError(
                        f"{filename} chapter {chapter_key} has duplicate grouped "
                        f"keys: {grouped_keys}")
                content = section.get("content")
                required_content = {
                    "body_paragraphs", "source", "history", "annotations", "text"
                }
                if (not isinstance(content, dict)
                        or not required_content.issubset(content)):
                    raise RuntimeError(
                        f"{filename} chapter {chapter_key} section/group "
                        f"{key or grouped_keys} has incomplete content")

    if not only_titles:
        if not 60 <= len(entries) <= 110:
            raise RuntimeError(
                f"Full staged crawl has implausible title count {len(entries)}")
        if not 900 <= chapter_count <= 1400:
            raise RuntimeError(
                f"Full staged crawl has implausible chapter count {chapter_count}")
        if not 24000 <= section_count <= 40000:
            raise RuntimeError(
                f"Full staged crawl has implausible section/group count "
                f"{section_count}")

        master_path = output_dir / "titles_index.json"
        try:
            with master_path.open(encoding="utf-8") as f:
                staged_master = json.load(f)
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Unreadable staged master index: {exc}") from exc
        if staged_master != index:
            raise RuntimeError("Staged titles_index.json differs from crawl index")


def publish_staged_files(
    staging_dir: Path,
    target_dir: Path,
    filenames: List[str],
    stale_filenames: Optional[List[str]] = None,
) -> None:
    """Publish staged files with rollback; callers put manifests last."""
    staging_dir, target_dir = Path(staging_dir), Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    backup_dir = staging_dir / ".publish-backup"
    backup_dir.mkdir(exist_ok=True)
    stale_filenames = stale_filenames or []

    ordered = list(dict.fromkeys(filenames))
    for name in ordered + stale_filenames:
        if Path(name).name != name:
            raise ValueError(f"Publish filename must be a basename: {name!r}")
    for name in ordered:
        if not (staging_dir / name).is_file():
            raise RuntimeError(f"Missing staged publish file: {name}")

    installed: List[Tuple[str, bool]] = []
    removed_stale: List[str] = []
    try:
        for name in ordered:
            src, dst, backup = (staging_dir / name, target_dir / name,
                                backup_dir / name)
            had_existing = dst.exists()
            if had_existing:
                os.replace(dst, backup)
            try:
                os.replace(src, dst)
            except Exception:
                if had_existing and backup.exists():
                    os.replace(backup, dst)
                raise
            installed.append((name, had_existing))

        # Stale files are retired only after all new files and manifests are
        # installed. They remain in the backup directory until commit returns.
        for name in stale_filenames:
            dst, backup = target_dir / name, backup_dir / name
            if dst.exists():
                os.replace(dst, backup)
                removed_stale.append(name)
    except Exception as publish_error:
        rollback_errors: List[str] = []
        for name in reversed(removed_stale):
            try:
                os.replace(backup_dir / name, target_dir / name)
            except Exception as exc:
                rollback_errors.append(f"restore stale {name}: {exc}")
        for name, had_existing in reversed(installed):
            src, dst, backup = (staging_dir / name, target_dir / name,
                                backup_dir / name)
            try:
                if dst.exists():
                    os.replace(dst, src)
                if had_existing and backup.exists():
                    os.replace(backup, dst)
            except Exception as exc:
                rollback_errors.append(f"restore {name}: {exc}")
        if rollback_errors:
            raise RuntimeError(
                f"Publish failed ({publish_error}); rollback also failed: "
                + "; ".join(rollback_errors)) from publish_error
        raise RuntimeError(
            f"Publish failed and was rolled back: {publish_error}") \
            from publish_error


def write_text_atomic(path: Path, text: str) -> None:
    """Write a text file beside its destination and atomically replace it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)


def main() -> None:
    parser = argparse.ArgumentParser(description="Crawl CT General Statutes titles/chapters/sections to JSON.")
    parser.add_argument("--sleep", type=float, default=0.3, help="Base sleep between requests (seconds).")
    parser.add_argument("--jitter", type=float, default=0.2, help="Random jitter added to sleep (seconds).")
    parser.add_argument("--timeout", type=float, default=30.0, help="Request timeout (seconds).")
    parser.add_argument("--attempts", type=int, default=4,
                        help="Fetch attempts before the crawl fails (default: 4).")
    parser.add_argument("--backoff", type=float, default=1.0,
                        help="Initial exponential retry delay in seconds (default: 1).")
    parser.add_argument("--no-ssl-verify", action="store_true", help="Disable SSL verification (not recommended).")
    parser.add_argument(
        "--titles",
        type=str,
        default="",
        help="Comma-separated title keys to crawl (e.g. '42a,42b'). "
             "Crawls everything when omitted; a partial crawl leaves titles_index.json untouched.",
    )
    parser.add_argument(
        "--out",
        type=str,
        default="cgs_index.json",
        help="Output JSON filename (written beside this script unless absolute path).",
    )
    args = parser.parse_args()

    # cga.ct.gov omits its intermediate certificate, which fails against
    # certifi's bundle; the OS trust store (truststore) builds the chain the
    # way browsers do, so prefer it when installed.
    if args.no_ssl_verify:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        verify_ssl: object = False
    else:
        try:
            import truststore
            truststore.inject_into_ssl()
            verify_ssl = True
        except ImportError:
            verify_ssl = certifi.where()

    cfg = FetchConfig(
        sleep=args.sleep,
        jitter=args.jitter,
        timeout=args.timeout,
        verify_ssl=verify_ssl,
        attempts=args.attempts,
        backoff=args.backoff,
    )

    only_titles = {normalize_title_key(k) for k in args.titles.split(",") if k.strip()} or None
    with tempfile.TemporaryDirectory(prefix=".cgs-crawl-", dir=HERE) as tmp:
        staging_dir = Path(tmp)
        index = build_index(
            cfg, only_titles=only_titles, output_dir=staging_dir)
        validate_staged_base_crawl(
            index, staging_dir, only_titles=only_titles)

        staged_titles = sorted(path.name for path in staging_dir.glob("title_*.json"))
        publish_names = list(staged_titles)
        stale_names: List[str] = []
        if not only_titles:
            # The manifest is installed after every title file, so it never
            # points at a staged file that has not yet been published.
            publish_names.append("titles_index.json")
            staged_set = set(staged_titles)
            stale_names = sorted(
                path.name for path in OUTPUT_DIR.glob("title_*.json")
                if path.name not in staged_set)

        publish_staged_files(
            staging_dir, OUTPUT_DIR, publish_names, stale_names)
        print(f"Published {len(staged_titles)} validated title file(s) "
              f"to {OUTPUT_DIR}")

    out_json = json.dumps(index, ensure_ascii=False, indent=2)

    # Write output beside this script unless user provided an absolute path
    if os.path.isabs(args.out):
        output_path = Path(args.out)
    else:
        output_path = HERE / args.out

    write_text_atomic(output_path, out_json)

    print(f"\nSaved to: {output_path}")
    print(f"File size: {output_path.stat().st_size/1024/1024:.2f} MB")


if __name__ == "__main__":
    main()
