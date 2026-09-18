"""Tests for scripts/validate-package-manifest.py, scripts/package-readiness.sh, and the release workflow.

Run from the repository root: python3 -m unittest discover -s scripts/tests -p 'test_*.py'
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts" / "validate-package-manifest.py"
WRAPPER = ROOT / "scripts" / "package-readiness.sh"
WORKFLOW = ROOT / ".github" / "workflows" / "release-readiness.yml"
NODE_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-node.yml"
GO_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-go.yml"
PYTHON_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-python.yml"
RUBY_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-ruby.yml"
JAVA_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-java.yml"
PHP_RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release-php.yml"
SCHEMA = ROOT / "ci" / "package-manifest.schema.json"
LANGUAGES = ("go", "node", "python", "php", "java", "dotnet", "ruby")

_spec = importlib.util.spec_from_file_location("validate_package_manifest", VALIDATOR)
assert _spec is not None and _spec.loader is not None
validator = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = validator
_spec.loader.exec_module(validator)


def write_package(output: Path, language: str, files: dict[str, bytes], **overrides: object) -> Path:
    """Write artifact files and a valid manifest for them; overrides replace top-level manifest keys."""
    output.mkdir(parents=True, exist_ok=True)
    artifacts = []
    for path in sorted(files, key=lambda value: value.encode("utf-8")):
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(files[path])
        artifacts.append({"path": path, "sha256": hashlib.sha256(files[path]).hexdigest(), "size_bytes": len(files[path])})
    manifest = {"schema_version": 1, "language": language, "version": "0.1.0", "artifacts": artifacts}
    manifest.update(overrides)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return output / "manifest.json"


def read_manifest(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


class ManifestValidatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def assertInvalid(self, manifest: Path, message: str, language: str = "node") -> None:
        with self.assertRaisesRegex(validator.ManifestError, message):
            validator.validate_manifest(manifest, language=language)

    def rewrite(self, manifest: Path, mutate) -> None:
        document = read_manifest(manifest)
        mutate(document)
        manifest.write_text(json.dumps(document), encoding="utf-8")

    def test_accepts_every_language_with_flat_and_nested_artifacts(self) -> None:
        for language in LANGUAGES:
            files = {"b.pkg": b"bee", "a/nested/x.jar": b"x" * 5, ".hidden-name": b"h"}
            manifest = write_package(self.root / language, language, files)
            artifacts = validator.validate_manifest(manifest, language=language)
            self.assertEqual([artifact.path for artifact in artifacts], [".hidden-name", "a/nested/x.jar", "b.pkg"])

    def test_rejects_wrong_top_level_values(self) -> None:
        manifest = write_package(self.root / "node", "node", {"a.tgz": b"a"})
        cases = [
            (lambda d: d.update(schema_version=2), "schema_version"),
            (lambda d: d.update(schema_version=True), "schema_version"),
            (lambda d: d.update(schema_version=1.0), "schema_version"),
            (lambda d: d.update(language="rust"), "language must be one of"),
            (lambda d: d.update(language="go"), "expected 'node'"),
            (lambda d: d.update(version="0.1.1"), "version"),
            (lambda d: d.update(extra=True), "unknown \\['extra'\\]"),
            (lambda d: d.pop("artifacts"), "missing \\['artifacts'\\]"),
            (lambda d: d.update(artifacts=[]), "non-empty array"),
            (lambda d: d.update(artifacts={}), "non-empty array"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                write_package(self.root / "node", "node", {"a.tgz": b"a"})
                self.rewrite(manifest, mutate)
                self.assertInvalid(manifest, message)

    def test_rejects_invalid_artifact_entries(self) -> None:
        digest = hashlib.sha256(b"a").hexdigest()
        cases = [
            ({"path": "a.tgz", "sha256": digest}, "exactly path, sha256, and size_bytes"),
            ({"path": "a.tgz", "sha256": digest, "size_bytes": 1, "mode": 1}, "exactly path, sha256, and size_bytes"),
            ({"path": "a.tgz", "sha256": digest.upper(), "size_bytes": 1}, "lowercase hexadecimal"),
            ({"path": "a.tgz", "sha256": digest[:63], "size_bytes": 1}, "lowercase hexadecimal"),
            ({"path": "a.tgz", "sha256": digest, "size_bytes": 0}, "at least 1"),
            ({"path": "a.tgz", "sha256": digest, "size_bytes": "1"}, "at least 1"),
            ({"path": "a.tgz", "sha256": digest, "size_bytes": True}, "at least 1"),
        ]
        for artifact, message in cases:
            with self.subTest(message=message, artifact=artifact):
                manifest = write_package(self.root / "node", "node", {"a.tgz": b"a"}, artifacts=[artifact])
                self.assertInvalid(manifest, message)

    def test_rejects_unsafe_duplicate_and_unsorted_paths(self) -> None:
        digest = hashlib.sha256(b"a").hexdigest()
        for path, message in [
            ("", "non-empty string"),
            ("/abs.tgz", "must be relative"),
            ("../escape.tgz", "'..'"),
            ("a/./b.tgz", "'.'"),
            ("a//b.tgz", "empty"),
            ("dir/", "empty"),
            ("a\\b.tgz", "backslash"),
            ("a" + chr(0) + ".tgz", "NUL"),
            ("manifest.json", "must not list itself"),
        ]:
            with self.subTest(path=path):
                manifest = write_package(self.root / "node", "node", {"a.tgz": b"a"}, artifacts=[{"path": path, "sha256": digest, "size_bytes": 1}])
                self.assertInvalid(manifest, message)

        entry = {"path": "a.tgz", "sha256": digest, "size_bytes": 1}
        manifest = write_package(self.root / "dup", "node", {"a.tgz": b"a"}, artifacts=[entry, entry])
        self.assertInvalid(manifest, "unique")

        files = {"B.tgz": b"b", "a.tgz": b"a"}
        manifest = write_package(self.root / "unsorted", "node", files)
        self.rewrite(manifest, lambda d: d["artifacts"].reverse())
        self.assertInvalid(manifest, "sorted")

    def test_sorting_uses_utf8_bytes(self) -> None:
        files = {"Z.tgz": b"z", "a.tgz": b"a", "é.tgz": b"e"}
        manifest = write_package(self.root / "node", "node", files)
        self.assertEqual([artifact.path for artifact in validator.validate_manifest(manifest, language="node")], ["Z.tgz", "a.tgz", "é.tgz"])

    def test_rejects_duplicate_keys_non_json_numbers_and_invalid_documents(self) -> None:
        manifest = write_package(self.root / "node", "node", {"a.tgz": b"a"})
        text = manifest.read_text(encoding="utf-8")
        manifest.write_text(text.replace('"schema_version": 1,', '"schema_version": 1, "schema_version": 1,'), encoding="utf-8")
        self.assertInvalid(manifest, "repeats the key")
        manifest.write_text(text.replace('"schema_version": 1', '"schema_version": NaN'), encoding="utf-8")
        self.assertInvalid(manifest, "non-JSON number")
        manifest.write_text("[]", encoding="utf-8")
        self.assertInvalid(manifest, "JSON object")
        manifest.write_text("{", encoding="utf-8")
        self.assertInvalid(manifest, "not valid JSON")
        manifest.write_bytes(b"\xff")
        self.assertInvalid(manifest, "UTF-8")

    def test_requires_exact_file_set_sizes_and_hashes(self) -> None:
        manifest = write_package(self.root / "node", "node", {"a.tgz": b"abc", "nested/b.tgz": b"b"})
        (self.root / "node" / "nested" / "unlisted.txt").write_text("x")
        self.assertInvalid(manifest, "does not list: \\['nested/unlisted.txt'\\]")

        manifest = write_package(self.root / "missing", "node", {"a.tgz": b"abc"})
        (self.root / "missing" / "a.tgz").unlink()
        self.assertInvalid(manifest, "missing or not regular files")

        manifest = write_package(self.root / "size", "node", {"a.tgz": b"abc"})
        (self.root / "size" / "a.tgz").write_bytes(b"abcd")
        self.assertInvalid(manifest, "is 4 bytes, manifest says 3")

        manifest = write_package(self.root / "hash", "node", {"a.tgz": b"abc"})
        (self.root / "hash" / "a.tgz").write_bytes(b"xyz")
        self.assertInvalid(manifest, "SHA-256 does not match")

    def test_rejects_symlinks_and_non_regular_files(self) -> None:
        manifest = write_package(self.root / "node", "node", {"a.tgz": b"a"})
        outside = self.root / "outside.tgz"
        outside.write_bytes(b"a")
        (self.root / "node" / "a.tgz").unlink()
        (self.root / "node" / "a.tgz").symlink_to(outside)
        self.assertInvalid(manifest, "symbolic link: a.tgz")

        manifest = write_package(self.root / "dirlink", "node", {"a.tgz": b"a"})
        (self.root / "dirlink" / "linked").symlink_to(self.root / "node", target_is_directory=True)
        self.assertInvalid(manifest, "symbolic link: linked")

        manifest = write_package(self.root / "fifo", "node", {"a.tgz": b"a"})
        os.mkfifo(self.root / "fifo" / "pipe")
        self.assertInvalid(manifest, "non-regular file: pipe")

        real = write_package(self.root / "real", "node", {"a.tgz": b"a"})
        linked_manifest_dir = self.root / "linked-manifest"
        linked_manifest_dir.mkdir()
        (linked_manifest_dir / "manifest.json").symlink_to(real)
        self.assertInvalid(linked_manifest_dir / "manifest.json", "regular file")
        self.assertInvalid(self.root / "absent" / "manifest.json", "does not exist")
        self.assertInvalid(self.root / "real" / "a.tgz", "must be named manifest.json")

    def test_aggregate_requires_exactly_seven_valid_language_directories(self) -> None:
        aggregate = self.root / "aggregate"
        for language in LANGUAGES:
            write_package(aggregate / language, language, {f"{language}.pkg": language.encode()})
        self.assertEqual(list(validator.validate_all(aggregate)), list(LANGUAGES))

        shutil.rmtree(aggregate / "ruby")
        with self.assertRaisesRegex(validator.ManifestError, "missing \\['ruby'\\]"):
            validator.validate_all(aggregate)
        write_package(aggregate / "ruby", "ruby", {"ruby.pkg": b"ruby"})

        (aggregate / "rust").mkdir()
        with self.assertRaisesRegex(validator.ManifestError, "unexpected \\['rust'\\]"):
            validator.validate_all(aggregate)
        (aggregate / "rust").rmdir()

        self.rewrite(aggregate / "java" / "manifest.json", lambda d: d.update(language="go"))
        with self.assertRaisesRegex(validator.ManifestError, "java: language is 'go'"):
            validator.validate_all(aggregate)

    def test_command_line_exit_codes_and_markdown(self) -> None:
        manifest = write_package(self.root / "go", "go", {"go.zip": b"go"})
        run = lambda *arguments: subprocess.run([sys.executable, str(VALIDATOR), *arguments], capture_output=True, text=True, check=False)
        self.assertEqual(run("--help").returncode, 0)
        ok = run(str(manifest), "--language", "go", "--version", "0.1.0")
        self.assertEqual((ok.returncode, ok.stdout.strip().startswith("go: 1 artifact(s) verified")), (0, True))
        self.assertEqual(run(str(manifest), "--language", "node", "--version", "0.1.0").returncode, 1)
        self.assertEqual(run(str(manifest), "--language", "go", "--version", "1.0.0").returncode, 2)
        self.assertEqual(run(str(manifest), "--language", "go").returncode, 2)
        self.assertEqual(run("--all", str(self.root), "--language", "go").returncode, 2)

        aggregate = self.root / "aggregate"
        for language in LANGUAGES:
            write_package(aggregate / language, language, {f"{language}.pkg": language.encode()})
        markdown = run("--all", str(aggregate), "--markdown")
        self.assertEqual(markdown.returncode, 0, markdown.stderr)
        self.assertIn("| dotnet | `dotnet.pkg` | 6 |", markdown.stdout)
        self.assertEqual(run("--all", str(self.root)).returncode, 1)

    def test_schema_documents_the_same_contract(self) -> None:
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertEqual(set(schema["required"]), {"schema_version", "language", "version", "artifacts"})
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(tuple(schema["properties"]["language"]["enum"]), LANGUAGES)
        self.assertEqual(schema["properties"]["version"]["const"], validator.VERSION)
        item = schema["properties"]["artifacts"]["items"]
        self.assertEqual(set(item["required"]), {"path", "sha256", "size_bytes"})
        self.assertEqual(item["properties"]["size_bytes"]["minimum"], 1)
        path_pattern = re.compile(item["properties"]["path"]["pattern"])
        for good in ["a.tgz", "ai/cekat/x.jar", ".hidden"]:
            self.assertIsNotNone(path_pattern.fullmatch(good), good)
        for bad in ["", "/a", "a//b", "./a", "a/..", "a\\b"]:
            self.assertIsNone(path_pattern.fullmatch(bad), bad)


FAKE_PACKAGE = r'''#!/usr/bin/env python3
"""Stub package script: writes a valid artifact and manifest unless told to misbehave."""
import hashlib, json, os, pathlib, sys, time
language = pathlib.Path(__file__).resolve().parents[1].name
root = pathlib.Path(__file__).resolve().parents[2]
with open(root / "order.log", "a") as log:
    log.write(language + "\n")
assert sys.argv[1:4:2] == ["--version", "--output"] and len(sys.argv) == 5, sys.argv
assert sys.argv[2] == "0.1.0", sys.argv
output = pathlib.Path(sys.argv[4])
assert output.is_dir() and not any(output.iterdir()), "output must be an existing empty directory"
behaviour = (root / f"{language}.behaviour").read_text().strip() if (root / f"{language}.behaviour").exists() else "ok"
if behaviour == "fail":
    sys.exit(7)
if behaviour == "sleep":
    (root / f"{language}.started").write_text(str(os.getpid()))
    time.sleep(60)
body = f"{language} artifact".encode()
(output / f"{language}-0.1.0.pkg").write_bytes(body)
digest = hashlib.sha256(body).hexdigest()
if behaviour == "bad-hash":
    digest = "0" * 64
manifest = {"schema_version": 1, "language": language, "version": "0.1.0", "artifacts": [{"path": f"{language}-0.1.0.pkg", "sha256": digest, "size_bytes": len(body)}]}
(output / "manifest.json").write_text(json.dumps(manifest))
'''


class PackageReadinessWrapperTest(unittest.TestCase):
    """Runs the real wrapper and validator inside a fake repository whose package scripts are stubs."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.repo = base / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy2(WRAPPER, self.repo / "scripts" / WRAPPER.name)
        shutil.copy2(VALIDATOR, self.repo / "scripts" / VALIDATOR.name)
        for language in LANGUAGES:
            script = self.repo / language / "scripts" / "package"
            script.parent.mkdir(parents=True)
            script.write_text(FAKE_PACKAGE)
            script.chmod(0o755)
        self.outputs = base / "out dir with spaces"
        self.outputs.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_wrapper(self, *arguments: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        environment = {key: value for key, value in os.environ.items() if key != "GITHUB_ACTIONS"}
        environment.update(env or {})
        return subprocess.run(["bash", str(self.repo / "scripts" / WRAPPER.name), *arguments], capture_output=True, text=True, env=environment, check=False, timeout=120)

    def order(self) -> list[str]:
        log = self.repo / "order.log"
        return log.read_text().split() if log.exists() else []

    def test_rejects_invalid_arguments_and_outputs_without_running_packages(self) -> None:
        nonempty = self.outputs / "nonempty"
        nonempty.mkdir()
        (nonempty / "stale").write_text("stale")
        a_file = self.outputs / "file"
        a_file.write_text("x")
        link = self.outputs / "link"
        link.symlink_to(self.outputs, target_is_directory=True)
        cases = [
            [],
            ["--all"],
            ["--language", "rust", "--output", str(self.outputs / "x")],
            ["--language", "go", "--output", str(self.outputs / "x"), "--version", "0.1.0"],
            ["--output", str(self.outputs / "x"), "--all"],
            ["--all", "--output", "relative"],
            ["--all", "--output", f"{self.outputs}/../escape"],
            ["--all", "--output", str(nonempty)],
            ["--all", "--output", str(a_file)],
            ["--all", "--output", str(link)],
            ["--all", "--output", str(self.outputs / "missing-parent" / "x")],
            ["--all", "--output", str(self.repo / "inside")],
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = self.run_wrapper(*arguments)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("usage:", result.stderr)
        self.assertEqual(self.order(), [])
        self.assertFalse((self.repo / "inside").exists())

    def test_single_language_builds_and_validates_into_a_language_directory(self) -> None:
        output = self.outputs / "single"
        result = self.run_wrapper("--language", "php", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.order(), ["php"])
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["php"])
        self.assertIn("php: 1 artifact(s) verified", result.stdout)
        self.assertIn("php: ok", result.stdout)

    def test_all_runs_in_fixed_order_and_validates_the_aggregate(self) -> None:
        output = self.outputs / "all"
        output.mkdir()
        result = self.run_wrapper("--all", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.order(), list(LANGUAGES))
        self.assertEqual(sorted(path.name for path in output.iterdir()), sorted(LANGUAGES))
        self.assertIn("ruby: 1 artifact(s) verified", result.stdout)
        self.assertEqual(result.stdout.count(": ok"), 7)
        self.assertIn(f"Artifacts: {output.resolve()}", result.stdout)

    def test_package_failures_and_invalid_manifests_fail_but_every_language_still_runs(self) -> None:
        (self.repo / "node.behaviour").write_text("fail")
        (self.repo / "java.behaviour").write_text("bad-hash")
        (self.repo / "dotnet" / "scripts" / "package").chmod(0o644)
        output = self.outputs / "failing"
        result = self.run_wrapper("--all", "--output", str(output))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.order(), ["go", "node", "python", "php", "java", "ruby"])
        self.assertIn("node: FAILED (exit 7", result.stdout)
        self.assertIn("java: FAILED (exit 1", result.stdout)
        self.assertIn("SHA-256 does not match", result.stderr)
        self.assertIn("dotnet: FAILED", result.stdout)
        self.assertIn("dotnet/scripts/package is missing or not executable", result.stderr)
        self.assertNotIn("aggregate", result.stdout)
        self.assertNotIn("Artifacts:", result.stdout)

    def test_interrupt_stops_the_running_package_script(self) -> None:
        (self.repo / "go.behaviour").write_text("sleep")
        environment = {key: value for key, value in os.environ.items() if key != "GITHUB_ACTIONS"}
        process = subprocess.Popen(["bash", str(self.repo / "scripts" / WRAPPER.name), "--language", "go", "--output", str(self.outputs / "interrupted")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        started = self.repo / "go.started"
        deadline = time.monotonic() + 30
        while not started.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(started.exists(), "stub package script never started")
        child = int(started.read_text())
        process.send_signal(signal.SIGTERM)
        _, stderr = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 130)
        self.assertIn("interrupted while packaging go", stderr)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("the package script kept running after the wrapper was interrupted")


class NoPublishTest(unittest.TestCase):
    FORBIDDEN = re.compile(
        r"npm publish|gem push|nuget push|twine upload|composer\s+publish|mvn\S*\s+deploy|mvnw\s+deploy|cosign|gpg\s|gh release|git tag|git push|secrets\.",
        re.IGNORECASE,
    )

    def test_release_workflow_is_manual_read_only_and_never_publishes(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        trigger = re.search(r"^on:\n((?:[ #].*\n|\n)*?)^\S", text, re.MULTILINE)
        self.assertIsNotNone(trigger)
        self.assertEqual([line.strip() for line in trigger.group(1).splitlines() if line.strip() and not line.strip().startswith("#")], ["workflow_dispatch:"])
        self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n")
        self.assertNotRegex(text, r"(?m)^\s+(?:id-token|packages|contents):\s*write")
        self.assertIsNone(self.FORBIDDEN.search(text))
        self.assertIn("language: [go, node, python, php, java, dotnet, ruby]", text)
        self.assertIn('scripts/package-readiness.sh --language "${{ matrix.language }}"', text)
        self.assertIn("validate-package-manifest.py --all", text)
        self.assertIn("actions/upload-artifact@", text)
        self.assertIn("validate-compatibility-matrix.py --as-of", text)

    def test_root_release_scripts_never_publish(self) -> None:
        for path in (WRAPPER, VALIDATOR, ROOT / "scripts" / "conformance.py", ROOT / "scripts" / "validate-compatibility-matrix.py"):
            with self.subTest(path=path.name):
                self.assertIsNone(self.FORBIDDEN.search(path.read_text(encoding="utf-8")))

    def test_only_the_release_workflows_publish(self) -> None:
        workflows = sorted((ROOT / ".github" / "workflows").glob("*.y*ml"))
        releases = {NODE_RELEASE_WORKFLOW, GO_RELEASE_WORKFLOW, PYTHON_RELEASE_WORKFLOW, RUBY_RELEASE_WORKFLOW, JAVA_RELEASE_WORKFLOW, PHP_RELEASE_WORKFLOW}
        self.assertTrue(releases.issubset(set(workflows)))
        for path in workflows:
            if path in releases:
                continue
            with self.subTest(path=path.name):
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(self.FORBIDDEN.search(text))
                self.assertNotRegex(text, r"(?m)^\s+(?:id-token|contents|packages):\s*write")


class NodeReleaseWorkflowTest(unittest.TestCase):
    """The npm release publishes one verified tarball through trusted publishing, and nothing else."""

    def setUp(self) -> None:
        self.text = NODE_RELEASE_WORKFLOW.read_text(encoding="utf-8")
        publish = re.search(r"(?ms)^  publish:\n(.*)", self.text)
        self.assertIsNotNone(publish)
        self.publish = publish.group(1)
        self.build = self.text[: publish.start()]

    def test_triggers_only_on_node_version_tags(self) -> None:
        trigger = re.search(r"^on:\n((?:[ #].*\n|\n)*?)^\S", self.text, re.MULTILINE)
        self.assertIsNotNone(trigger)
        lines = [line.strip() for line in trigger.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertEqual(lines, ["push:", "tags:", "- 'node/v*'"])

    def test_uses_trusted_publishing_without_stored_credentials(self) -> None:
        self.assertRegex(self.text, r"(?m)^permissions:\n  contents: read\n")
        self.assertNotIn("secrets.", self.text)
        self.assertNotRegex(self.text, r"NPM_TOKEN|NODE_AUTH_TOKEN|_authToken")
        self.assertEqual(len(re.findall(r"id-token:\s*write", self.text)), 1)
        self.assertRegex(self.publish, r"(?m)^      id-token: write$")
        self.assertRegex(self.publish, r"(?m)^    runs-on: ubuntu-latest$")
        self.assertRegex(self.publish, r"(?m)^    environment: npm$")

    def test_publishes_only_the_verified_artifact_once(self) -> None:
        self.assertEqual(len(re.findall(r"npm publish", self.text)), 1)
        self.assertNotRegex(self.build, r"npm publish|id-token")
        self.assertIn("scripts/package-readiness.sh --language node", self.build)
        self.assertIn("validate-package-manifest.py", self.publish)
        self.assertIn('npm publish "$TARBALL" --access public --tag', self.publish)
        self.assertIsNone(re.search(r"gem push|nuget push|twine upload|cosign|gpg\s|gh release|git tag|git push", self.text, re.IGNORECASE))



class GoReleaseWorkflowTest(unittest.TestCase):
    """The Go release creates the adapter tags and GitHub Releases for one verified commit, and nothing else."""

    ADAPTERS = ("chi", "echo", "fiber", "gin")

    def setUp(self) -> None:
        self.text = GO_RELEASE_WORKFLOW.read_text(encoding="utf-8")
        release = re.search(r"(?ms)^  release:\n(.*)", self.text)
        self.assertIsNotNone(release)
        self.release = release.group(1)
        self.verify = self.text[: release.start()]

    def test_triggers_only_on_core_go_version_tags(self) -> None:
        trigger = re.search(r"^on:\n((?:[ #].*\n|\n)*?)^\S", self.text, re.MULTILINE)
        self.assertIsNotNone(trigger)
        lines = [line.strip() for line in trigger.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertEqual(lines, ["push:", "tags:", "- 'go/v*'"])

    def test_write_access_is_confined_to_the_approved_release_job(self) -> None:
        self.assertRegex(self.text, r"(?m)^permissions:\n  contents: read\n")
        self.assertNotIn("secrets.", self.text)
        self.assertNotRegex(self.text, r"id-token|persist-credentials: true")
        self.assertEqual(len(re.findall(r"contents: write", self.text)), 1)
        self.assertRegex(self.release, r"(?m)^      contents: write$")
        self.assertRegex(self.release, r"(?m)^    environment: go-release$")
        self.assertNotRegex(self.verify, r"contents: write|gh api|gh release")

    def test_the_commit_is_verified_before_anything_is_created(self) -> None:
        self.assertIn('scripts/package-readiness.sh --language go', self.verify)
        self.assertIn('expected v$VERSION', self.verify)
        self.assertIn('repos/$REPO/compare/main...$SHA', self.release)
        commit_check = self.release.index("compare/main")
        for created in ('gh api "repos/$REPO/git/refs"', "gh release create"):
            self.assertLess(commit_check, self.release.index(created), created)

    def test_creates_only_the_adapter_tags_for_the_released_version(self) -> None:
        self.assertIn('tag="go/middleware/$adapter/v$VERSION"', self.release)
        self.assertEqual(len(re.findall(r'gh api "repos/\$REPO/git/refs"', self.release)), 1)
        self.assertIn('-f "ref=refs/tags/$tag" -f "sha=$SHA"', self.release)
        for adapter in self.ADAPTERS:
            self.assertIn(adapter, self.release)
        self.assertIsNone(re.search(r"npm publish|gem push|nuget push|twine upload|git push|secrets\.", self.text, re.IGNORECASE))

    def test_never_publishes_to_a_registry_and_keeps_the_proxy_step_advisory(self) -> None:
        self.assertIn("GOPROXY=https://proxy.golang.org", self.release)
        proxy = self.release[self.release.index("Warm the public module proxy") :]
        self.assertNotIn("exit 1", proxy)
        self.assertIn("::warning::", proxy)



class RegistryReleaseWorkflowTest(unittest.TestCase):
    """Each registry release publishes exactly one artifact set that the build job verified, without secrets."""

    CASES = (
        ("python", "python/v*", "pypi", "cekat-event-sdk", "pypa/gh-action-pypi-publish@"),
        ("ruby", "ruby/v*", "rubygems", "cekat-event-sdk", "rubygems/configure-rubygems-credentials@"),
    )

    def workflow(self, language: str) -> tuple[str, str, str]:
        path = PYTHON_RELEASE_WORKFLOW if language == "python" else RUBY_RELEASE_WORKFLOW
        text = path.read_text(encoding="utf-8")
        publish = re.search(r"(?ms)^  publish:\n(.*)", text)
        self.assertIsNotNone(publish)
        return text, text[: publish.start()], publish.group(1)

    def test_triggers_only_on_the_language_version_tag(self) -> None:
        for language, tag, _, _, _ in self.CASES:
            with self.subTest(language=language):
                text, _, _ = self.workflow(language)
                trigger = re.search(r"^on:\n((?:[ #].*\n|\n)*?)^\S", text, re.MULTILINE)
                self.assertIsNotNone(trigger)
                lines = [line.strip() for line in trigger.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
                self.assertEqual(lines, ["push:", "tags:", f"- '{tag}'"])

    def test_uses_trusted_publishing_without_stored_credentials(self) -> None:
        for language, _, environment, _, action in self.CASES:
            with self.subTest(language=language):
                text, build, publish = self.workflow(language)
                self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n")
                self.assertNotIn("secrets.", text)
                self.assertNotRegex(text, r"API_KEY|GEM_HOST_API_KEY|PYPI_TOKEN|_authToken|password:")
                self.assertEqual(len(re.findall(r"id-token:\s*write", text)), 1)
                self.assertRegex(publish, r"(?m)^      id-token: write$")
                self.assertRegex(publish, r"(?m)^    runs-on: ubuntu-latest$")
                self.assertRegex(publish, f"(?m)^    environment: {environment}$")
                self.assertIn(action, publish)
                self.assertNotRegex(build, r"id-token|gem push|gh-action-pypi-publish")
                self.assertNotRegex(text, r"(?m)^\s+contents:\s*write")

    def test_publishes_only_the_verified_artifacts(self) -> None:
        for language, _, _, package, _ in self.CASES:
            with self.subTest(language=language):
                text, build, publish = self.workflow(language)
                self.assertIn(f"scripts/package-readiness.sh --language {language}", build)
                self.assertIn("does not match", build)
                self.assertIn("validate-package-manifest.py", publish)
                self.assertIn(f"{package}", publish)
                self.assertIn("already exists", publish)
                self.assertIsNone(re.search(r"npm publish|nuget push|twine upload|mvn\S*\s+deploy|cosign|gpg\s|gh release|git tag|git push", text, re.IGNORECASE))

    def test_the_gem_push_is_the_only_push_and_pypi_uploads_only_distributions(self) -> None:
        ruby = RUBY_RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"gem push", ruby)), 1)
        self.assertIn('gem push "$GEM"', ruby)
        python = PYTHON_RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("packages-dir: ${{ runner.temp }}/dist", python)
        self.assertIn('cp "$ARTIFACTS/cekat_event_sdk-$VERSION-py3-none-any.whl" "$ARTIFACTS/cekat_event_sdk-$VERSION.tar.gz" "$RUNNER_TEMP/dist/"', python)



class SecretHoldingReleaseWorkflowTest(unittest.TestCase):
    """Maven Central and Packagist have no trusted publishing, so these two workflows hold secrets.

    The secrets must stay in the approved publish job, name only what that registry needs, and act only on
    artifacts the build job verified.
    """

    WORKFLOWS = {"java": JAVA_RELEASE_WORKFLOW, "php": PHP_RELEASE_WORKFLOW}
    SECRETS = {
        "java": {"GPG_PRIVATE_KEY", "GPG_PASSPHRASE", "MAVEN_CENTRAL_USERNAME", "MAVEN_CENTRAL_PASSWORD"},
        "php": {"PHP_MIRROR_TOKEN"},
    }
    ENVIRONMENTS = {"java": "maven-central", "php": "packagist"}
    TAGS = {"java": "java/v*", "php": "php/v*"}

    def parts(self, language: str) -> tuple[str, str, str]:
        text = self.WORKFLOWS[language].read_text(encoding="utf-8")
        publish = re.search(r"(?ms)^  publish:\n(.*)", text)
        self.assertIsNotNone(publish)
        return text, text[: publish.start()], publish.group(1)

    def test_triggers_only_on_the_language_version_tag(self) -> None:
        for language, tag in self.TAGS.items():
            with self.subTest(language=language):
                text, _, _ = self.parts(language)
                trigger = re.search(r"^on:\n((?:[ #].*\n|\n)*?)^\S", text, re.MULTILINE)
                self.assertIsNotNone(trigger)
                lines = [line.strip() for line in trigger.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
                self.assertEqual(lines, ["push:", "tags:", f"- '{tag}'"])

    def test_secrets_are_named_and_confined_to_the_approved_publish_job(self) -> None:
        for language, expected in self.SECRETS.items():
            with self.subTest(language=language):
                text, build, publish = self.parts(language)
                self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n")
                self.assertEqual(set(re.findall(r"secrets\.([A-Z_]+)", text)), expected)
                self.assertNotIn("secrets.", build)
                self.assertRegex(publish, f"(?m)^    environment: {self.ENVIRONMENTS[language]}$")
                self.assertNotRegex(text, r"(?m)^\s+(?:contents|packages|id-token):\s*write")

    def test_the_build_job_verifies_the_tag_and_the_package(self) -> None:
        for language in self.WORKFLOWS:
            with self.subTest(language=language):
                _, build, _ = self.parts(language)
                self.assertIn(f"scripts/package-readiness.sh --language {language}", build)
                self.assertIn("does not match", build)

    def test_each_registry_receives_what_the_build_job_checked(self) -> None:
        # Maven Central takes the artifact tree the build job hashed; Packagist consumes Git history, so the
        # mirror is taken from the same tagged commit instead of an uploaded archive.
        _, _, java = self.parts("java")
        self.assertIn("actions/download-artifact@", java)
        _, _, php = self.parts("php")
        self.assertIn('rsync --archive --delete --exclude .git "$GITHUB_WORKSPACE/php/" .', php)
        self.assertNotIn("actions/download-artifact@", php)

    def test_maven_central_signs_the_verified_tree_and_stops_before_publishing(self) -> None:
        text, _, publish = self.parts("java")
        validate = publish.index("validate-package-manifest.py")
        self.assertLess(validate, publish.index("--detach-sign"), "artifacts are signed before being verified")
        self.assertLess(validate, publish.index("publisher/upload"), "artifacts are uploaded before being verified")
        self.assertIn("publishingType=USER_MANAGED", publish)
        self.assertNotIn("AUTOMATIC", text)
        self.assertIn("::add-mask::", publish)
        self.assertIn("--exclude=manifest.json", publish)
        for suffix in (".asc", ".md5", ".sha1"):
            self.assertIn(suffix, publish)

    def test_the_php_mirror_is_the_only_push_target(self) -> None:
        text, _, publish = self.parts("php")
        self.assertRegex(text, r"(?m)^  MIRROR: cekataiofficial/cekat-event-sdk-php$")
        pushes = re.findall(r"git push[^\n]*", publish)
        self.assertEqual(pushes, ['git push --quiet origin HEAD:main', 'git push --quiet origin "refs/tags/v$VERSION"'])
        self.assertLess(publish.index("compare/main..."), publish.index("git push"), "the mirror is pushed before the commit is checked")
        self.assertIn('git ls-remote --tags --exit-code origin "refs/tags/v$VERSION"', publish)
        self.assertIn('git tag "v$VERSION"', publish)


if __name__ == "__main__":
    unittest.main()
