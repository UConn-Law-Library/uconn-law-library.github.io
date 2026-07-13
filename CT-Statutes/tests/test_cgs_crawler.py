from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import requests


HERE = Path(__file__).resolve().parent
PROJECT_DIR = HERE.parent
FIXTURES = HERE / "fixtures"


def load_crawler_module():
    path = PROJECT_DIR / "ct_CGS_Crawl-v2.py"
    spec = importlib.util.spec_from_file_location("cgs_crawl_v2_tests", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


crawl = load_crawler_module()


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class ChapterDiscoveryTests(unittest.TestCase):
    def test_multi_letter_chapter_suffixes_are_discovered(self):
        chapters = crawl.extract_chapter_links(
            fixture("title_multi_letter_chapters.html"),
            "https://www.cga.ct.gov/current/pub/title_17b.htm",
        )

        self.assertEqual(
            [chapter[0] for chapter in chapters],
            ["319y", "319aa", "368ll", "588hh"],
        )


class SectionIdentityTests(unittest.TestCase):
    def test_visible_heading_wins_over_conflicting_fragment(self):
        html = fixture("chapter_fragment_mismatch.html")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            sections = crawl.extract_section_links(
                html,
                "https://www.cga.ct.gov/current/pub/chap_319i.htm",
                expected_title_key="17a",
            )

        self.assertEqual([section["section_key"] for section in sections],
                         ["17a-615", "17a-616"])
        self.assertEqual(sections[0]["source_fragment_key"], "17a-175")
        self.assertIn("heading key 17a-615 disagrees",
                      sections[0]["identifier_warning"])
        self.assertIn("WARNING: heading key 17a-615 disagrees",
                      output.getvalue())

        content = crawl.extract_section_text_map(html, sections)
        self.assertIn("The compact text begins here", content["17a-615"]["text"])
        self.assertNotIn("administrator shall carry out",
                         content["17a-615"]["text"])
        self.assertIn("administrator shall carry out",
                      content["17a-616"]["text"])

    def test_grouped_heading_does_not_take_embedded_former_section_key(self):
        html = fixture("chapter_grouped_ranges.html")
        sections = crawl.extract_section_links(
            html,
            "https://www.cga.ct.gov/current/pub/chap_034.htm",
            expected_title_key="03",
        )

        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0]["section_key"], "")
        self.assertEqual(sections[0]["section_keys"],
                         ["3-114p", "3-114q", "3-114r"])
        self.assertTrue(sections[0]["url"].endswith(
            "#secs_3-114p_3-114q_3-114r"))
        content = crawl.extract_grouped_section_content(html, sections[0])
        self.assertEqual(content["status"], "repealed")
        self.assertEqual(content["statuses"], ["repealed"])

    def test_future_effective_fixture_captures_source_blocks(self):
        html = fixture("chapter_future_effective.html")
        sections = crawl.extract_section_links(
            html,
            "https://www.cga.ct.gov/current/pub/chap_166.htm",
            expected_title_key="10",
        )
        content = crawl.extract_section_text_map(html, sections)

        self.assertIn("Existing subsection text", content["10-145a"]["text"])
        self.assertIn("On and after July 1, 2025",
                      content["10-145a"]["text"])
        self.assertIn("Replacement subsection text",
                      content["10-145a"]["text"])


class GroupedSectionTests(unittest.TestCase):
    def test_mixed_ranges_lists_and_suffixes_expand(self):
        self.assertEqual(
            crawl.expand_grouped_keys(
                "secs_10a-4_to_10a-4b_and_10a-5"),
            ["10a-4", "10a-4a", "10a-4b", "10a-5"],
        )
        self.assertEqual(
            crawl.expand_grouped_keys(
                "secs_20-341s_to_20-341bb"),
            [
                "20-341s", "20-341t", "20-341u", "20-341v",
                "20-341w", "20-341x", "20-341y", "20-341z",
                "20-341aa", "20-341bb",
            ],
        )
        self.assertEqual(
            crawl.expand_grouped_keys("secs_8-224_8-225_and_8-225a"),
            ["8-224", "8-225", "8-225a"],
        )

    def test_all_requested_legal_statuses_are_detected(self):
        self.assertEqual(crawl.detect_section_status("Sections are repealed."),
                         ["repealed"])
        self.assertEqual(crawl.detect_section_status("Reserved for future use."),
                         ["reserved"])
        self.assertEqual(crawl.detect_section_status("Sections transferred."),
                         ["transferred"])
        self.assertEqual(crawl.detect_section_status("All sections obsolete."),
                         ["obsolete"])
        self.assertEqual(crawl.detect_section_status("Sec. 1-2. Repealed."),
                         ["repealed"])
        self.assertEqual(crawl.detect_section_status("Sec. 1-3. Reserved."),
                         ["reserved"])
        self.assertEqual(crawl.detect_section_status("Sec. 1-4. Transferred."),
                         ["transferred"])
        self.assertEqual(crawl.detect_section_status("Sec. 1-5. Obsolete."),
                         ["obsolete"])
        self.assertEqual(
            crawl.detect_section_status(
                "All sections transferred, repealed or obsolete."),
            ["repealed", "transferred", "obsolete"],
        )
        self.assertEqual(
            crawl.detect_section_status(
                "Sec. 1-2. Active statute.",
                "(a) This subsection applies. (b) Repealed."),
            [],
        )


class TransactionTests(unittest.TestCase):
    def test_publish_installs_manifests_last_and_removes_stale_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, target = root / "stage", root / "target"
            stage.mkdir()
            target.mkdir()
            (stage / "title_01.json").write_text("new title", encoding="utf-8")
            (stage / "titles_index.json").write_text("new index", encoding="utf-8")
            (target / "title_01.json").write_text("old title", encoding="utf-8")
            (target / "title_02.json").write_text("stale title", encoding="utf-8")
            (target / "titles_index.json").write_text("old index", encoding="utf-8")

            crawl.publish_staged_files(
                stage,
                target,
                ["title_01.json", "titles_index.json"],
                ["title_02.json"],
            )

            self.assertEqual((target / "title_01.json").read_text(), "new title")
            self.assertEqual((target / "titles_index.json").read_text(), "new index")
            self.assertFalse((target / "title_02.json").exists())

    def test_publish_failure_rolls_back_every_installed_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, target = root / "stage", root / "target"
            stage.mkdir()
            target.mkdir()
            for name in ("title_01.json", "title_02.json", "titles_index.json"):
                (stage / name).write_text(f"new {name}", encoding="utf-8")
                (target / name).write_text(f"old {name}", encoding="utf-8")

            real_replace = os.replace
            failed = False

            def flaky_replace(src, dst):
                nonlocal failed
                src_path = Path(src)
                if (not failed and src_path.parent == stage
                        and src_path.name == "title_02.json"):
                    failed = True
                    raise OSError("simulated publish failure")
                return real_replace(src, dst)

            with mock.patch.object(crawl.os, "replace", side_effect=flaky_replace):
                with self.assertRaisesRegex(RuntimeError, "rolled back"):
                    crawl.publish_staged_files(
                        stage,
                        target,
                        ["title_01.json", "title_02.json", "titles_index.json"],
                    )

            for name in ("title_01.json", "title_02.json", "titles_index.json"):
                self.assertEqual((target / name).read_text(), f"old {name}")

    def test_staged_validation_rejects_embedded_crawler_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            title = {
                "title_key": "01",
                "error": "network failure",
                "chapters": [],
            }
            (stage / "title_01.json").write_text(
                json.dumps(title), encoding="utf-8")
            index = {"titles": [{
                "title_key": "01",
                "label": "Title 1",
                "file": "title_01.json",
            }]}

            with self.assertRaisesRegex(RuntimeError, "crawler error"):
                crawl.validate_staged_base_crawl(
                    index, stage, only_titles={"01"})

    def test_staged_validation_rejects_missing_section_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            title = {
                "title_key": "01",
                "chapters": [{
                    "chapter_key": "1",
                    "sections": [{"section_key": "1-1"}],
                }],
            }
            (stage / "title_01.json").write_text(
                json.dumps(title), encoding="utf-8")
            index = {"titles": [{
                "title_key": "01",
                "label": "Title 1",
                "file": "title_01.json",
            }]}

            with self.assertRaisesRegex(RuntimeError, "incomplete content"):
                crawl.validate_staged_base_crawl(
                    index, stage, only_titles={"01"})


class FetchRetryTests(unittest.TestCase):
    def test_fetch_retries_then_returns_html(self):
        class Response:
            headers = {"Content-Type": "text/html; charset=utf-8"}
            content = b"<html><body>ok</body></html>"
            apparent_encoding = "utf-8"
            text = "<html><body>ok</body></html>"

            @staticmethod
            def raise_for_status():
                return None

        class Session:
            calls = 0

            def get(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise requests.ConnectionError("temporary failure")
                return Response()

        session = Session()
        cfg = crawl.FetchConfig(
            sleep=0, jitter=0, timeout=1, verify_ssl=True,
            attempts=2, backoff=0)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            html = crawl.fetch_html(session, "https://example.test/page", cfg)

        self.assertIn("<body>ok</body>", html)
        self.assertEqual(session.calls, 2)
        self.assertIn("retrying", output.getvalue())


if __name__ == "__main__":
    unittest.main()
