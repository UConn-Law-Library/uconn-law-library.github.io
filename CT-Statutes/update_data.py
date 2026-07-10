#!/usr/bin/env python3
"""
One-command refresh of every dataset the CT Statutes Explorer uses.

Stages, in dependency order:
  1. statutes     ct_CGS_Crawl-v2.py    crawls cga.ct.gov  -> data/title_*.json,
                                                              data/titles_index.json
  2. supplement   ct_CGS_Supplement_Crawl.py
                                        crawls cga.ct.gov  -> data/supplement/*.json
  3. index        parse_index.py        LCO index PDFs     -> data/statutes_index.json
  4. infractions  parse_infractions.py  schedule PDF       -> data/infractions.json
  5. app indexes  build_app_indexes.py  generated JSON     -> data/search_index.json,
                                                              data/version.json
  6. validate     validate_data.py      generated JSON     -> exit status only;
     schema, counts (vs. the pre-refresh version.json), citation integrity,
     parser-artifact and sentinel checks — a failure fails the whole refresh

The infractions stage must run after the statutes stage because it links each
schedule entry to the freshly crawled title files.

Unless --no-download is given, the source PDFs are downloaded before their
stage runs:
  - the three "Index *.pdf" ranges, found by scraping the LCO index page so the
    year-versioned URLs (e.g. index/2025/...) keep working after each revision;
  - infractions_schedule.pdf from the Judicial Branch's stable URL.
A failed download keeps the existing local PDF and continues with it.

Usage (from inside CT-Statutes):
  python update_data.py                    # download PDFs and run all three stages
  python update_data.py --no-download      # reuse the PDFs already in this folder
  python update_data.py --only infractions # run one stage (repeatable)
  python update_data.py --sleep 0.5        # slow the statute crawl down

Dependencies: pip install requests beautifulsoup4 certifi pdfplumber
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urljoin

import certifi
import requests
from bs4 import BeautifulSoup

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

INDEX_PAGE_URL = "https://www.cga.ct.gov/lco/statutes-index.asp"
INDEX_PDFS = ["Index A-H.pdf", "Index I-S.pdf", "Index T-Z.pdf"]
INFRACTIONS_URL = "https://www.jud.ct.gov/webforms/forms/infractions.pdf"
INFRACTIONS_PDF = "infractions_schedule.pdf"

UA = (
    "Mozilla/5.0 (compatible; CTStatutesIndexer/1.0; "
    "+https://www.cga.ct.gov/current/pub/titles.htm)"
)
# jud.ct.gov resets connections from datacenter IPs (e.g. GitHub Actions
# runners) for non-browser clients; retries fall back to this and, last of
# all, to curl, whose TLS fingerprint differs from Python's.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
DOWNLOAD_ATTEMPTS = 4

STAGES = ("statutes", "supplement", "index", "infractions")


def make_session() -> requests.Session:
    """Session that can verify cga.ct.gov: the site omits its intermediate
    certificate, which fails against certifi's bundle, so prefer the OS trust
    store (truststore) when available — it builds the chain like a browser."""
    session = requests.Session()
    session.headers["User-Agent"] = UA
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        session.verify = certifi.where()
    return session


def download(session: requests.Session, url: str, dest: str) -> int:
    """Download url to dest atomically; the old file survives any failure.

    Retries with backoff, switching to a browser User-Agent after the first
    failure and finally trying curl (see BROWSER_UA note)."""
    name = os.path.basename(dest)
    tmp = dest + ".part"
    last_error: Exception = RuntimeError("download not attempted")
    try:
        for attempt in range(DOWNLOAD_ATTEMPTS):
            if attempt:
                wait = 2 ** attempt
                print(f"  retrying {name} in {wait}s "
                      f"(attempt {attempt + 1}/{DOWNLOAD_ATTEMPTS}, "
                      f"browser user-agent)", flush=True)
                time.sleep(wait)
            try:
                headers = {"User-Agent": BROWSER_UA} if attempt else None
                with session.get(url, stream=True, timeout=120,
                                 headers=headers) as resp:
                    resp.raise_for_status()
                    with open(tmp, "wb") as f:
                        for chunk in resp.iter_content(chunk_size=1 << 16):
                            f.write(chunk)
                os.replace(tmp, dest)
                return os.path.getsize(dest)
            except Exception as e:
                last_error = e
                print(f"  ! attempt {attempt + 1} failed for {name}: {e}",
                      flush=True)

        curl = shutil.which("curl")
        if curl:
            print(f"  retrying {name} with curl", flush=True)
            proc = subprocess.run(
                [curl, "--fail", "--silent", "--show-error", "--location",
                 "--retry", "3", "--max-time", "180",
                 "--user-agent", BROWSER_UA, "--output", tmp, url],
                capture_output=True, text=True)
            if proc.returncode == 0:
                os.replace(tmp, dest)
                return os.path.getsize(dest)
            last_error = RuntimeError(
                proc.stderr.strip() or f"curl exited {proc.returncode}")
        raise last_error
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def find_index_pdf_urls(session: requests.Session):
    """Scrape the LCO page for the current index PDF links and revision note."""
    resp = session.get(INDEX_PAGE_URL, timeout=60)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    wanted = {name.lower(): name for name in INDEX_PDFS}
    urls: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        filename = unquote(a["href"].rsplit("/", 1)[-1]).strip().lower()
        name = wanted.get(filename)
        if name:
            urls[name] = urljoin(INDEX_PAGE_URL, a["href"])

    revised = None
    m = re.search(
        r"revision of 1958,?\s*revised to\s*([a-z]+\s+\d{1,2},\s*\d{4})",
        soup.get_text(" "), re.IGNORECASE)
    if m:
        date = re.sub(r"\s+", " ", m.group(1)).strip().title()
        revised = f"Revision of 1958, revised to {date}"

    return urls, revised


def run_stage(name: str, script: str, extra_args=()) -> bool:
    cmd = [sys.executable, os.path.join(HERE, script), *extra_args]
    print(f"\n=== {name}: running {script} ===", flush=True)
    started = time.monotonic()
    result = subprocess.run(cmd, cwd=HERE)
    minutes = (time.monotonic() - started) / 60
    ok = result.returncode == 0
    status = "done" if ok else f"FAILED (exit {result.returncode})"
    print(f"=== {name}: {status} after {minutes:.1f} min ===", flush=True)
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Refresh statutes, subject index, and infractions data.")
    ap.add_argument("--only", action="append", choices=STAGES, metavar="STAGE",
                    help="run only this stage (repeatable); "
                         f"choices: {', '.join(STAGES)}")
    ap.add_argument("--no-download", action="store_true",
                    help="parse the PDFs already in this folder instead of "
                         "downloading fresh copies")
    ap.add_argument("--sleep", type=float, default=None,
                    help="base sleep between crawler requests (passed through "
                         "to ct_CGS_Crawl-v2.py)")
    args = ap.parse_args()
    wanted = set(args.only or STAGES)

    session = make_session()

    # Snapshot the pre-refresh manifest so the validate stage can flag record
    # counts that drifted more than its threshold from the last dataset.
    baseline_path = None
    version_path = os.path.join(DATA_DIR, "version.json")
    if os.path.exists(version_path):
        fd, baseline_path = tempfile.mkstemp(prefix="cgs-version-", suffix=".json")
        os.close(fd)
        shutil.copy(version_path, baseline_path)

    results: dict[str, bool] = {}

    if "statutes" in wanted:
        extra = ["--sleep", str(args.sleep)] if args.sleep is not None else []
        results["statutes"] = run_stage("statutes", "ct_CGS_Crawl-v2.py", extra)

    if "supplement" in wanted:
        extra = ["--sleep", str(args.sleep)] if args.sleep is not None else []
        results["supplement"] = run_stage(
            "supplement", "ct_CGS_Supplement_Crawl.py", extra)

    if "index" in wanted:
        revised = None
        if not args.no_download:
            urls: dict[str, str] = {}
            try:
                urls, revised = find_index_pdf_urls(session)
            except Exception as e:
                print(f"! Could not read {INDEX_PAGE_URL}: {e}")
            for name in INDEX_PDFS:
                url = urls.get(name)
                if not url:
                    print(f"! No link for {name!r} on the index page — "
                          "keeping the existing local PDF")
                    continue
                try:
                    size = download(session, url, os.path.join(HERE, name))
                    print(f"Downloaded {name} ({size / 1e6:.1f} MB)")
                except Exception as e:
                    print(f"! Download failed for {name}: {e} — "
                          "keeping the existing local PDF")
        missing = [n for n in INDEX_PDFS
                   if not os.path.exists(os.path.join(HERE, n))]
        if missing:
            print(f"! Skipping index stage — missing PDFs: {missing}")
            results["index"] = False
        else:
            extra = ["--revised", revised] if revised else []
            results["index"] = run_stage("index", "parse_index.py", extra)

    if "infractions" in wanted:
        pdf_path = os.path.join(HERE, INFRACTIONS_PDF)
        if not args.no_download:
            try:
                size = download(session, INFRACTIONS_URL, pdf_path)
                print(f"Downloaded {INFRACTIONS_PDF} ({size / 1e6:.1f} MB)")
            except Exception as e:
                print(f"! Download failed for {INFRACTIONS_PDF}: {e}")
                if os.path.exists(pdf_path):
                    # jud.ct.gov blocks some datacenter IPs (GitHub runners
                    # among them), so the repository carries the last-known
                    # PDF. Compare its effective date in the summary below
                    # with the current schedule when reviewing.
                    print(f"! Parsing the committed copy of {INFRACTIONS_PDF} "
                          "instead — the schedule may be stale")
        if not os.path.exists(pdf_path):
            print("! Skipping infractions stage — no schedule PDF")
            results["infractions"] = False
        else:
            results["infractions"] = run_stage(
                "infractions", "parse_infractions.py")

    # Rebuild the complete navigation index and deterministic version after
    # every successful full or partial refresh.  The service worker uses the
    # version to invalidate cached legal data when a refreshed dataset ships.
    if results and all(results.values()):
        results["app-indexes"] = run_stage(
            "app indexes", "build_app_indexes.py")

    # Gate the refreshed dataset: a parser can exit 0 on a changed source
    # layout and still emit wrong records, so check what actually landed.
    if results.get("app-indexes"):
        extra = ["--baseline", baseline_path] if baseline_path else []
        results["validate"] = run_stage("validate", "validate_data.py", extra)
    if baseline_path:
        os.remove(baseline_path)

    print("\n--- Summary ---")
    for name in STAGES:
        status = ("OK" if results[name] else "FAILED") if name in results else "skipped"
        print(f"  {name:<12} {status}")
    for name, label in (("app-indexes", "app indexes"), ("validate", "validate")):
        if name in results:
            print(f"  {label:<12} {'OK' if results[name] else 'FAILED'}")

    # sanity-check the files the web app loads at startup
    for fname in ("titles_index.json", "statutes_index.json", "infractions.json",
                  os.path.join("supplement", "supplement_map.json")):
        path = os.path.join(DATA_DIR, fname)
        try:
            with open(path, encoding="utf-8") as f:
                src = json.load(f).get("source") or {}
            stamp = src.get("generated") or src.get("generated_at_utc") or "unknown date"
            edition = src.get("effective") or src.get("revised")
            print(f"  {fname}: generated {stamp}, "
                  f"{os.path.getsize(path) / 1e6:.1f} MB"
                  + (f" (source: {edition})" if edition else ""))
        except (OSError, ValueError) as e:
            print(f"  {fname}: unreadable ({e})")

    sys.exit(0 if results and all(results.values()) else 1)


if __name__ == "__main__":
    main()
