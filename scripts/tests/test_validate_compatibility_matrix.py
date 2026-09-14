"""Tests for scripts/validate-compatibility-matrix.py.

Run from the repository root: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "validate-compatibility-matrix.py"
MATRIX = ROOT / "ci" / "compatibility-matrix.json"

_spec = importlib.util.spec_from_file_location("validate_compatibility_matrix", SCRIPT)
assert _spec is not None and _spec.loader is not None
matrix_validator = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = matrix_validator
_spec.loader.exec_module(matrix_validator)


def referenced_files(matrix: dict) -> set[str]:
    files = {".github/workflows/ci.yml", ".github/workflows/release-readiness.yml"}
    for entry in matrix["languages"]:
        files.add(entry["evidence"])
        files.update(runtime["declared_in"]["file"] for runtime in entry["runtimes"])
        files.update(framework["declared_in"]["file"] for framework in entry["frameworks"] if framework["declared_in"])
    return files


class RealRepositoryTest(unittest.TestCase):
    def test_the_checked_in_matrix_matches_the_repository(self) -> None:
        matrix, _ = matrix_validator.validate(MATRIX, ROOT)
        self.assertEqual([entry["language"] for entry in matrix["languages"]], list(matrix_validator.LANGUAGES))


class DriftTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.matrix = json.loads(MATRIX.read_text())
        for relative in referenced_files(self.matrix):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        self.write_matrix()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @property
    def matrix_path(self) -> Path:
        return self.root / "ci" / "compatibility-matrix.json"

    def write_matrix(self) -> None:
        self.matrix_path.parent.mkdir(parents=True, exist_ok=True)
        self.matrix_path.write_text(json.dumps(self.matrix, indent=2))

    def entry(self, language: str) -> dict:
        return next(entry for entry in self.matrix["languages"] if entry["language"] == language)

    def edit(self, relative: str, old: str, new: str) -> None:
        path = self.root / relative
        text = path.read_text()
        self.assertIn(old, text, f"test setup: {old!r} not in {relative}")
        path.write_text(text.replace(old, new, 1))

    def assertInvalid(self, message: str, **options) -> None:
        with self.assertRaisesRegex(matrix_validator.MatrixError, message):
            matrix_validator.validate(self.matrix_path, self.root, **options)

    def test_copy_is_valid(self) -> None:
        matrix_validator.validate(self.matrix_path, self.root)

    def test_runtime_floor_drift_in_package_metadata(self) -> None:
        cases = [
            ("go/go.mod", "go 1.22", "go 1.23", "go/go.mod declares '1.23'"),
            ("node/package.json", '"bun": ">=1.2.5"', '"bun": ">=1.4.0"', "node/package.json declares '>=1.4.0'"),
            ("python/pyproject.toml", 'requires-python = ">=3.10"', 'requires-python = ">=3.11"', "declares '>=3.11'"),
            ("php/composer.json", '"php": "^8.2"', '"php": "^8.3"', "declares '\\^8.3'"),
            ("java/pom.xml", "<maven.compiler.release>17</maven.compiler.release>", "<maven.compiler.release>21</maven.compiler.release>", "declares '21'"),
            ("dotnet/Directory.Build.props", "<TargetFramework>net8.0</TargetFramework>", "<TargetFramework>net10.0</TargetFramework>", "declares 'net10.0'"),
            ("ruby/cekat-event-sdk.gemspec", 'required_ruby_version = ">= 3.3.0"', 'required_ruby_version = ">= 3.4.0"', "declares '>= 3.4.0'"),
        ]
        for relative, old, new, message in cases:
            with self.subTest(relative=relative):
                original = (self.root / relative).read_text()
                self.edit(relative, old, new)
                self.assertInvalid(message)
                (self.root / relative).write_text(original)

    def test_ci_matrix_drift(self) -> None:
        ci = ".github/workflows/ci.yml"
        cases = [
            ("go-version: '1.22.12'", "go-version: '1.23.0'", "job 'go' has go-version \\['1.23.0', 'stable'\\]"),
            ("bun-version: ['1.2.5', '1.3.14', '1.4.2']", "bun-version: ['1.2.5', '1.4.2']", "job 'bun' has bun-version"),
            ("spring-boot: '4.1.1'", "spring-boot: '4.1.2'", "job 'java' has spring-boot"),
            ("dependencies: symfony-6.4-floor", "dependencies: symfony-7.4-floor", "job 'php' has dependencies"),
        ]
        for old, new, message in cases:
            with self.subTest(old=old):
                original = (self.root / ci).read_text()
                self.edit(ci, old, new)
                self.assertInvalid(message)
                (self.root / ci).write_text(original)

    def test_added_ci_row_is_detected(self) -> None:
        self.edit(".github/workflows/ci.yml", "          - python-version: '3.14'", "          - python-version: '3.12'\n            dependencies: highest\n          - python-version: '3.14'")
        self.assertInvalid("job 'python' has python-version \\['3.10', '3.12', '3.14'\\]")

    def test_missing_job_or_matrix_is_reported(self) -> None:
        self.entry("go")["ci"][0]["job"] = "golang"
        self.write_matrix()
        self.assertInvalid("job 'golang' not found")

    def test_release_readiness_drift(self) -> None:
        self.edit(".github/workflows/release-readiness.yml", "python-version: '3.14'", "python-version: '3.13'")
        self.assertInvalid("release-readiness.yml installs python-version \\['3.13'\\]")

    def test_release_readiness_must_match_the_current_profile(self) -> None:
        self.edit(".github/workflows/release-readiness.yml", "java-version: '25'", "java-version: '21'")
        self.entry("java")["release_readiness"]["value"] = "21"
        self.write_matrix()
        self.assertInvalid("does not match the current CI profile '25'")

    def test_framework_declaration_drift(self) -> None:
        self.edit("node/package.json", '"express": "^4.17.0 || ^5.0.0"', '"express": "^5.0.0"')
        self.assertInvalid("node/package.json no longer contains")

    def test_evidence_must_contain_observed_versions_tested_frameworks_and_dates(self) -> None:
        self.entry("ruby")["profiles"][1]["observed"] = "4.0.7"
        self.write_matrix()
        self.assertInvalid("'4.0.7' does not appear in ruby/COMPATIBILITY.md")

        self.matrix = json.loads(MATRIX.read_text())
        self.entry("php")["frameworks"][0]["tested"].append("12.0.99")
        self.write_matrix()
        self.assertInvalid("'12.0.99' does not appear in php/docs/compatibility.md")

        self.matrix = json.loads(MATRIX.read_text())
        self.entry("dotnet")["end_of_support"][0]["date"] = "2026-11-11"
        self.write_matrix()
        self.assertInvalid("'2026-11-11' does not appear in dotnet/COMPATIBILITY.md")

    def test_structure_errors(self) -> None:
        mutations = [
            (lambda m: m["languages"].reverse(), "exactly go, node, python, php, java, dotnet, ruby"),
            (lambda m: m["languages"].pop(), "exactly go, node"),
            (lambda m: m.update(extra=True), "matrix must have exactly the keys"),
            (lambda m: m.update(schema_version=2), "schema_version"),
            (lambda m: m.update(verified_on="2026-09"), "full YYYY-MM-DD"),
            (lambda m: m["languages"][0]["profiles"].reverse(), "exactly minimum then current"),
            (lambda m: m["languages"][0]["profiles"][1].update(observed="latest"), "exact version"),
            (lambda m: m["languages"][0]["profiles"][0].update(ci_value="1.21"), "not one of the CI values"),
            (lambda m: m["languages"][0].update(evidence="../go/COMPATIBILITY.md"), "repository-relative"),
            (lambda m: m["languages"][0].update(evidence="go/MISSING.md"), "does not exist"),
            (lambda m: m["languages"][0]["runtimes"][0]["declared_in"].update(kind="toml"), "unknown declared_in kind"),
            (lambda m: m["languages"][2]["frameworks"].append(dict(m["languages"][2]["frameworks"][0])), "duplicate names"),
            (lambda m: m["languages"][2]["end_of_support"][0].update(date="October 2026"), "YYYY-MM-DD or YYYY-MM"),
        ]
        for mutate, message in mutations:
            with self.subTest(message=message):
                self.matrix = json.loads(MATRIX.read_text())
                mutate(self.matrix)
                self.write_matrix()
                self.assertInvalid(message)

    def test_duplicate_keys_and_invalid_json(self) -> None:
        self.matrix_path.write_text('{"schema_version": 1, "schema_version": 1}')
        self.assertInvalid("repeats the key")
        self.matrix_path.write_text("{")
        self.assertInvalid("not valid JSON")

    def test_time_gates(self) -> None:
        self.matrix["verified_on"] = "2026-09-14"
        self.write_matrix()
        _, warnings = matrix_validator.validate(self.matrix_path, self.root, as_of=dt.date(2026, 9, 14), max_age_days=30)
        self.assertIn("python: CPython 3.10 reaches end of support on 2026-10 (47 days)", warnings)
        self.assertIn("dotnet: .NET 8.0 reaches end of support on 2026-11-10 (57 days)", warnings)

        self.assertInvalid("45 days old; recheck official sources", as_of=dt.date(2026, 10, 29), max_age_days=30)
        self.assertInvalid("CPython 3.10 reached end of support on 2026-10", as_of=dt.date(2026, 11, 1))
        self.assertInvalid("after --as-of", as_of=dt.date(2026, 9, 1))
        # Without --as-of, no time-based gate applies (ordinary CI never fails just because time passed).
        matrix_validator.validate(self.matrix_path, self.root)

    def test_command_line(self) -> None:
        run = lambda *arguments: subprocess.run([sys.executable, str(SCRIPT), str(self.matrix_path), "--root", str(self.root), *arguments], capture_output=True, text=True, check=False)
        ok = run()
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("compatibility matrix valid: 7 languages", ok.stdout)
        table = run("--as-of", "2026-09-14", "--markdown")
        self.assertEqual(table.returncode, 0, table.stderr)
        self.assertIn("| python | CPython >=3.10 | 3.10.21 → 3.14.7 |", table.stdout)
        self.assertIn("warning: ruby: Rails 8.0 reaches end of support on 2026-11-07", table.stderr)
        self.assertEqual(run("--max-age-days", "30").returncode, 2)
        self.assertEqual(run("--as-of", "2027-01-01").returncode, 1)


class WorkflowExtractionTest(unittest.TestCase):
    WORKFLOW = """jobs:
  alpha:
    strategy:
      matrix:
        include:
          - version: '1.0'   # floor
            extra: a
          - version: "2.0"
            extra: b
    steps:
      - run: echo version: 9
  beta:
    strategy:
      matrix:
        version: ['3.0', 4.0 ]
  package:
    steps:
      - if: matrix.language == 'go'
        uses: actions/setup-go@v7
        with:
          go-version: stable
      - if: matrix.language == 'node'
        with:
          node-version: '24'
      - name: unrelated
        with:
          go-version: '1.0'
"""

    def test_matrix_values_support_include_rows_lists_and_comments(self) -> None:
        self.assertEqual(matrix_validator.ci_matrix_values(self.WORKFLOW, "alpha", "version"), ["1.0", "2.0"])
        self.assertEqual(matrix_validator.ci_matrix_values(self.WORKFLOW, "beta", "version"), ["3.0", "4.0"])
        with self.assertRaisesRegex(matrix_validator.MatrixError, "no strategy.matrix"):
            matrix_validator.ci_matrix_values(self.WORKFLOW, "package", "version")

    def test_release_values_only_come_from_the_language_guarded_steps(self) -> None:
        self.assertEqual(matrix_validator.release_readiness_values(self.WORKFLOW, "go", "go-version"), ["stable"])
        self.assertEqual(matrix_validator.release_readiness_values(self.WORKFLOW, "node", "node-version"), ["24"])
        self.assertEqual(matrix_validator.release_readiness_values(self.WORKFLOW, "ruby", "ruby-version"), [])


if __name__ == "__main__":
    unittest.main()
