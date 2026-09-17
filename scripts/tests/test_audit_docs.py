"""Tests for scripts/audit-docs.py.

Each test copies the repository's tracked and new (non-ignored) files into a temporary directory, breaks one
thing, and checks the audit reports it. Run from the repository root:
    python3 -m unittest discover -s scripts/tests -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "audit-docs.py"

_spec = importlib.util.spec_from_file_location("audit_docs", SCRIPT)
assert _spec is not None and _spec.loader is not None
audit_docs = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = audit_docs
_spec.loader.exec_module(audit_docs)


def repository_files() -> list[str]:
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [line for line in result.stdout.splitlines() if (ROOT / line).is_file()]


class RealRepositoryTest(unittest.TestCase):
    def test_the_repository_documentation_passes(self) -> None:
        self.assertEqual([str(problem) for problem in audit_docs.audit(ROOT)], [])


class AuditTest(unittest.TestCase):
    files: list[str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.files = repository_files()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for relative in self.files:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def problems(self) -> list[str]:
        return [str(problem) for problem in audit_docs.audit(self.root)]

    def append(self, relative: str, text: str) -> None:
        path = self.root / relative
        path.write_text(path.read_text(encoding="utf-8") + "\n" + text + "\n", encoding="utf-8")

    def replace(self, relative: str, old: str, new: str) -> None:
        path = self.root / relative
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"test setup: {old!r} not in {relative}")
        path.write_text(text.replace(old, new), encoding="utf-8")

    def assertReported(self, fragment: str) -> None:
        problems = self.problems()
        self.assertTrue(any(fragment in problem for problem in problems), f"expected {fragment!r} in {problems}")

    def test_copy_passes(self) -> None:
        self.assertEqual(self.problems(), [])

    def test_missing_documents_and_root_links(self) -> None:
        (self.root / "docs" / "visitor-propagation.md").unlink()
        self.assertReported("docs/visitor-propagation.md:1: required document is missing")
        self.replace("README.md", "](docs/release-checklist.md", "](docs/RELEASE.md")
        self.assertReported("README.md:1: does not link docs/release-checklist.md")

    def test_links(self) -> None:
        self.append("docs/sdk-contract.md", "See [missing](no-such-page.md), [bad anchor](visitor-propagation.md#no-such-heading), and [absolute](/docs/sdk-contract.md).")
        problems = self.problems()
        self.assertTrue(any("broken link 'no-such-page.md'" in problem for problem in problems), problems)
        self.assertTrue(any("points to a missing heading" in problem for problem in problems), problems)
        self.assertTrue(any("absolute link '/docs/sdk-contract.md'" in problem for problem in problems), problems)

    def test_links_inside_code_are_ignored_and_external_links_are_not_fetched(self) -> None:
        self.append("docs/sdk-contract.md", "```md\n[not a link](missing.md)\n```\n\nSee [the site](https://example.com/page) and [a heading](#errors).")
        self.assertEqual(self.problems(), [])

    def test_forbidden_content(self) -> None:
        cases = {
            "The TODO list is empty.": "unfinished marker",
            "Logs are in /Users/someone/app.log.": "absolute local path",
            "Use ghp_abcdefghijklmnopqrstuvwxyz0123 to authenticate.": "token-like secret",
            "Send Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345.": "token-like bearer credential",
            "Run npm publish when ready.": "publication command",
            "The SDK is now available on npm.": "publication claim",
            "Point it at http://server.cekat.ai for testing.": "insecure production origin",
            "Events go to /api/events/track.": "wrong ingest path",
            "The api.cekat.ai host also works.": "unknown Cekat host 'api.cekat.ai'",
            "Send the X-Cekat-Visitor-Id header.": "visitor header spelled 'X-Cekat-Visitor-Id'",
            "Read the cekat_visitor_id cookie.": "visitor cookie without its leading underscore",
            "The SDK guarantees delivery of every event.": "claims durability",
            "Events are processed exactly once.": "claims durability",
            "The default timeout is 10 seconds.": "stale 10-second timeout",
            "The SDK retries only HTTP 500 responses.": "stale retry claim",
        }
        for sentence, fragment in cases.items():
            with self.subTest(sentence=sentence):
                original = (self.root / "docs" / "sdk-contract.md").read_text(encoding="utf-8")
                self.append("docs/sdk-contract.md", sentence)
                self.assertReported(fragment)
                (self.root / "docs" / "sdk-contract.md").write_text(original, encoding="utf-8")

    def test_negated_claims_and_code_examples_are_allowed(self) -> None:
        self.append("docs/sdk-contract.md", "The SDK does not guarantee delivery, and events are never processed exactly once by design.\n\n```go\nctx, cancel := context.WithTimeout(ctx, 10*time.Second) // guarantees delivery? no\n```")
        self.assertEqual(self.problems(), [])

    def test_required_terms(self) -> None:
        self.replace("docs/retry-and-error-semantics.md", "65,536", "sixty-five thousand")
        self.assertReported("docs/retry-and-error-semantics.md:1: missing required term '65,536'")
        self.replace("ruby/README.md", "untrusted", "unverified")
        self.assertReported("ruby/README.md:1: missing required term 'untrusted'")

    def test_language_readmes_must_name_matrix_frameworks_and_floors(self) -> None:
        self.replace("node/README.md", "Elysia", "another framework")
        self.assertReported("node/README.md:1: does not mention 'Elysia'")
        self.replace("php/README.md", "8.2", "eight point two")
        self.assertReported("php/README.md:1: does not name the PHP floor '8.2'")

    def test_compatibility_page_must_match_the_matrix(self) -> None:
        self.replace("docs/compatibility.md", "| Chi | v5.3.2+ |", "| Chi | v5.0.0+ |")
        self.assertReported("docs/compatibility.md:1: is out of date")
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--write-compatibility"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.problems(), [])

    def test_an_invalid_matrix_is_reported(self) -> None:
        self.replace("ci/compatibility-matrix.json", '"verified_on": "2026-09-14"', '"verified_on": "yesterday"')
        self.assertReported("ci/compatibility-matrix.json:1: invalid")

    def test_command_line(self) -> None:
        run = lambda *arguments: subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), *arguments], capture_output=True, text=True, check=False)
        passed = run()
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertIn("documentation audit passed: 14 documents", passed.stdout)
        self.append("docs/release-checklist.md", "FIXME before release.")
        failed = run()
        self.assertEqual(failed.returncode, 1)
        self.assertIn("docs/release-checklist.md:", failed.stderr)
        self.assertIn("documentation audit failed: 1 problem(s)", failed.stderr)


class HelperTest(unittest.TestCase):
    def test_github_anchors(self) -> None:
        text = "# Title\n## Bun before 1.4\n## `code` and Symbols!\n## Title\n```\n# not a heading\n```\n"
        self.assertEqual(audit_docs.anchors(text), {"title", "bun-before-14", "code-and-symbols", "title-1"})

    def test_runtime_tokens(self) -> None:
        self.assertEqual(audit_docs.runtime_token(">=22.12.0 <28.0.0"), "22.12")
        self.assertEqual(audit_docs.runtime_token(">=1.2.5"), "1.2.5")
        self.assertEqual(audit_docs.runtime_token(">= 3.3.0"), "3.3")
        self.assertEqual(audit_docs.runtime_token("^8.2"), "8.2")
        self.assertEqual(audit_docs.runtime_token("net8.0"), "net8.0")


if __name__ == "__main__":
    unittest.main()
