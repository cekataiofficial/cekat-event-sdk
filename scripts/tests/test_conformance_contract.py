"""Tests for scripts/conformance.sh (scripts/conformance.py): isolation, environment, accounting, and cleanup.

The real Go mock ingest server is built once; each test runs the real orchestrator inside a temporary
repository whose language runners are probes. Run from the repository root:
    python3 -m unittest discover -s scripts/tests -p 'test_*.py'
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ("go", "node", "python", "php", "java", "dotnet", "ruby")
FIXTURE_IDS = sorted(path.stem for path in (ROOT / "conformance" / "fixtures" / "cases").glob("*.json"))
CANCELLATION_IDS = sorted(
    path.stem
    for path in (ROOT / "conformance" / "fixtures" / "cases").glob("*.json")
    if "php" in json.loads(path.read_text()).get("applicability", {}).get("inapplicable_languages", [])
)

# A probe runner. Its behaviour comes from <repo>/<language>.behaviour (one word per line).
PROBE = r'''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys, time, urllib.request
language = pathlib.Path(__file__).resolve().parents[1].name
repo = pathlib.Path(__file__).resolve().parents[2]
behaviour_file = repo / f"{language}.behaviour"
behaviour = behaviour_file.read_text().split() if behaviour_file.exists() else []
conformance = {k: v for k, v in os.environ.items() if k.startswith("CEKAT_CONFORMANCE_")}
(repo / f"{language}.observed.json").write_text(json.dumps({"argv": sys.argv[1:], "env": conformance}))
with open(repo / "order.log", "a") as log:
    log.write(language + "\n")
base = conformance["CEKAT_CONFORMANCE_BASE_URL"]
control = conformance["CEKAT_CONFORMANCE_CONTROL_URL"]

def call(url, body=None, method="POST"):
    request = urllib.request.Request(url, data=body, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status, response.read()

# Exercise this language's private mock: reset, queue, ingest, and read a journal that starts at 1.
call(control + "/__control/reset", b"")
call(control + "/__control/responses", json.dumps({"responses": [{"status": 200, "body": "{}"}]}).encode())
call(base + "/api/events/ingest", json.dumps({"event_key": "probe", "email": language}).encode())
_, journal = call(control + "/__control/requests", method="GET")
entries = json.loads(journal)["requests"]
assert [entry["sequence"] for entry in entries] == [1], entries

fixtures = sorted(p.stem for p in pathlib.Path(conformance["CEKAT_CONFORMANCE_FIXTURES"]).glob("*.json"))
cancellation = set(json.loads((repo / "cancellation.json").read_text()))
if "print-token" in behaviour:
    print("token is " + conformance["CEKAT_CONFORMANCE_ACCESS_TOKEN"], flush=True)
if "leave-child" in behaviour:
    child = subprocess.Popen(["sleep", "300"])
    (repo / f"{language}.child").write_text(str(child.pid))
if "sleep" in behaviour:
    (repo / f"{language}.started").write_text(str(os.getpid()))
    time.sleep(300)
if "kill-mock" in behaviour:
    # This language's mock server is the orchestrator's other child, so it shares this probe's parent.
    listing = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,args="], capture_output=True, text=True).stdout
    pid = next(int(fields[0]) for fields in (line.split(None, 2) for line in listing.splitlines())
               if len(fields) == 3 and int(fields[1]) == os.getppid() and "mock-ingest-server" in fields[2])
    os.kill(pid, 9)
for index, fixture in enumerate(fixtures):
    if "omit-one" in behaviour and index == 0:
        continue
    status = "passed"
    if fixture in cancellation and "declared-na" in behaviour:
        status = "not_applicable"
    if index == 1 and "undeclared-na" in behaviour:
        status = "not_applicable"
    if index == 2 and "skipped" in behaviour:
        status = "skipped"
    record = {"id": fixture, "status": status}
    if index == 3 and "deviation" in behaviour:
        record["runtime_deviation"] = "example"
    prefix = "\x1b[37m  " if "prefixed" in behaviour else ""
    print(prefix + json.dumps(record, separators=(",", ":")), flush=True)
    if index == 4 and "duplicate" in behaviour:
        print(json.dumps(record, separators=(",", ":")), flush=True)
if "unknown-id" in behaviour:
    print(json.dumps({"id": "no-such-fixture", "status": "passed"}), flush=True)
sys.exit(3 if "exit-3" in behaviour else 0)
'''


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0); treat a reaped-or-zombie process as gone.
    result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")


class ConformanceOrchestrationTest(unittest.TestCase):
    mock_directory: tempfile.TemporaryDirectory[str]
    mock_binary: Path

    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("go") is None:
            raise AssertionError("Go is required to build the shared mock ingest server for these tests")
        cls.mock_directory = tempfile.TemporaryDirectory()
        cls.mock_binary = Path(cls.mock_directory.name) / "mock-ingest-server"
        subprocess.run(["go", "build", "-o", str(cls.mock_binary), "./cmd/mock-ingest-server"], cwd=ROOT / "conformance" / "mock-ingest-server", check=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.mock_directory.cleanup()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name) / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        for name in ("conformance.sh", "conformance.py"):
            shutil.copy2(ROOT / "scripts" / name, self.repo / "scripts" / name)
        shutil.copytree(ROOT / "conformance" / "fixtures", self.repo / "conformance" / "fixtures")
        (self.repo / "cancellation.json").write_text(json.dumps(CANCELLATION_IDS))
        for language in LANGUAGES:
            runner = self.repo / language / "scripts" / "conformance"
            runner.parent.mkdir(parents=True)
            runner.write_text(PROBE)
            runner.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def behave(self, language: str, *words: str) -> None:
        (self.repo / f"{language}.behaviour").write_text("\n".join(words))

    def run_orchestrator(self, *arguments: str, env: dict[str, str] | None = None, timeout: float = 120) -> subprocess.CompletedProcess[str]:
        environment = {key: value for key, value in os.environ.items() if key not in {"GITHUB_ACTIONS", "MOCK_INGEST_SERVER_BIN"}}
        environment["MOCK_INGEST_SERVER_BIN"] = str(self.mock_binary)
        environment.update(env or {})
        return subprocess.run(["bash", str(self.repo / "scripts" / "conformance.sh"), *arguments], capture_output=True, text=True, env=environment, timeout=timeout, check=False)

    def observed(self, language: str) -> dict[str, object]:
        return json.loads((self.repo / f"{language}.observed.json").read_text())

    def order(self) -> list[str]:
        log = self.repo / "order.log"
        return log.read_text().split() if log.exists() else []

    def test_all_languages_run_in_order_with_private_mocks_and_exactly_four_variables(self) -> None:
        self.behave("php", "declared-na")
        self.behave("ruby", "declared-na", "prefixed")
        result = self.run_orchestrator(env={"CEKAT_CONFORMANCE_EXTRA": "leak", "CEKAT_CONFORMANCE_BASE_URL": "http://example.invalid"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.order(), list(LANGUAGES))
        base_urls = set()
        for language in LANGUAGES:
            observed = self.observed(language)
            self.assertEqual(observed["argv"], [])
            environment = observed["env"]
            self.assertEqual(sorted(environment), ["CEKAT_CONFORMANCE_ACCESS_TOKEN", "CEKAT_CONFORMANCE_BASE_URL", "CEKAT_CONFORMANCE_CONTROL_URL", "CEKAT_CONFORMANCE_FIXTURES"])
            self.assertEqual(environment["CEKAT_CONFORMANCE_ACCESS_TOKEN"], "conformance-token")
            self.assertEqual(environment["CEKAT_CONFORMANCE_BASE_URL"], environment["CEKAT_CONFORMANCE_CONTROL_URL"])
            self.assertRegex(environment["CEKAT_CONFORMANCE_BASE_URL"], r"^http://127\.0\.0\.1:\d+$")
            self.assertEqual(environment["CEKAT_CONFORMANCE_FIXTURES"], str((self.repo / "conformance" / "fixtures" / "cases").resolve()))
            base_urls.add(environment["CEKAT_CONFORMANCE_BASE_URL"])
        self.assertEqual(len(base_urls), 7, "each language must get its own mock server")
        total = len(FIXTURE_IDS)
        self.assertIn(f"go: ok ({total} passed, 0 not_applicable)", result.stdout)
        na = len(CANCELLATION_IDS)
        self.assertIn(f"php: ok ({total - na} passed, {na} not_applicable)", result.stdout)
        self.assertIn(f"ruby: ok ({total - na} passed, {na} not_applicable)", result.stdout)

    def test_single_language_and_argument_errors(self) -> None:
        result = self.run_orchestrator("--language", "dotnet")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.order(), ["dotnet"])
        for arguments in (["--language"], ["--language", "rust"], ["--all"], ["--language", "go", "extra"]):
            with self.subTest(arguments=arguments):
                self.assertEqual(self.run_orchestrator(*arguments).returncode, 2)
        (self.repo / "java" / "scripts" / "conformance").chmod(0o644)
        missing = self.run_orchestrator("--language", "java")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("java/scripts/conformance is missing or not executable", missing.stderr)

    def test_languages_without_runners_are_reported_and_skipped_in_all_mode(self) -> None:
        shutil.rmtree(self.repo / "java")
        result = self.run_orchestrator()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("java has no runner yet; not run", result.stderr)
        self.assertEqual(self.order(), [language for language in LANGUAGES if language != "java"])

    def test_accounting_failures_fail_even_when_the_runner_exits_zero(self) -> None:
        cases = {
            "omit-one": "1 fixture(s) have no result",
            "duplicate": "reported more than once",
            "unknown-id": "unknown fixture no-such-fixture",
            "undeclared-na": "does not declare go inapplicable",
            "skipped": "has status 'skipped'",
        }
        for behaviour, message in cases.items():
            with self.subTest(behaviour=behaviour):
                self.behave("go", behaviour)
                result = self.run_orchestrator("--language", "go")
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)
                self.assertIn("go: FAILED", result.stdout)

    def test_runtime_deviation_records_count_as_passed_and_are_reported(self) -> None:
        self.behave("node", "deviation")
        result = self.run_orchestrator("--language", "node")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"node: ok ({len(FIXTURE_IDS)} passed, 0 not_applicable, 1 with runtime_deviation)", result.stdout)

    def test_a_failing_runner_fails_the_run_but_later_languages_still_run(self) -> None:
        self.behave("python", "exit-3")
        result = self.run_orchestrator()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.order(), list(LANGUAGES))
        self.assertIn("python: FAILED", result.stdout)
        self.assertIn("runner exited with status 3", result.stderr)
        self.assertIn("ruby: ok", result.stdout)

    def test_the_access_token_is_redacted_from_output(self) -> None:
        self.behave("go", "print-token")
        result = self.run_orchestrator("--language", "go")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("token is [redacted]", result.stdout)
        self.assertNotIn("conformance-token", result.stdout + result.stderr)

    def test_processes_left_by_a_runner_are_stopped(self) -> None:
        self.behave("go", "leave-child")
        result = self.run_orchestrator("--language", "go")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("runner left processes running; they were stopped", result.stderr)
        self.assertFalse(alive(int((self.repo / "go.child").read_text())))

    def test_mock_server_failures(self) -> None:
        fake = Path(self.temporary.name) / "fake-mock"
        scenarios = {
            "echo 'not json'; sleep 30": "malformed readiness record",
            'echo \'{"base_url":"http://127.0.0.1:1","control_url":"http://127.0.0.1:2"}\'; sleep 30': "malformed readiness record",
            'echo \'{"base_url":"http://10.0.0.1:1","control_url":"http://10.0.0.1:1"}\'; sleep 30': "not a loopback HTTP origin",
            "exit 4": "exited with status 4 before reporting readiness",
            "sleep 30": "did not report readiness within 1 seconds",
            'echo \'{"base_url":"http://127.0.0.1:9","control_url":"http://127.0.0.1:9"}\'; sleep 30': "control API never answered",
        }
        for script, message in scenarios.items():
            with self.subTest(message=message):
                fake.write_text(f"#!/bin/sh\n{script}\n")
                fake.chmod(0o755)
                result = self.run_orchestrator("--language", "go", env={"MOCK_INGEST_SERVER_BIN": str(fake), "CONFORMANCE_READINESS_TIMEOUT_SECONDS": "1"})
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)
                self.assertEqual(self.order(), [])

    def test_a_mock_server_that_dies_during_the_run_fails_the_language(self) -> None:
        self.behave("go", "kill-mock")
        result = self.run_orchestrator("--language", "go")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("mock server exited with status -9 while the runner was active", result.stderr)

    def test_interrupt_stops_the_runner_and_the_mock_server(self) -> None:
        self.behave("go", "sleep")
        environment = {key: value for key, value in os.environ.items() if key != "GITHUB_ACTIONS"}
        environment["MOCK_INGEST_SERVER_BIN"] = str(self.mock_binary)
        process = subprocess.Popen(["bash", str(self.repo / "scripts" / "conformance.sh"), "--language", "go"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        started = self.repo / "go.started"
        deadline = time.monotonic() + 30
        while not started.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(started.exists(), "probe runner never started")
        runner_pid = int(started.read_text())
        mock_url = self.observed("go")["env"]["CEKAT_CONFORMANCE_BASE_URL"]
        process.send_signal(signal.SIGTERM)
        _, stderr = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 130, stderr)
        self.assertIn("interrupted", stderr)
        deadline = time.monotonic() + 10
        while alive(runner_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(runner_pid), "runner kept running after the orchestrator was interrupted")
        with self.assertRaises(OSError):
            import urllib.request
            urllib.request.urlopen(mock_url + "/__control/requests", timeout=1)

    def test_missing_fixture_directory_fails(self) -> None:
        shutil.rmtree(self.repo / "conformance" / "fixtures" / "cases")
        result = self.run_orchestrator("--language", "go")
        self.assertEqual(result.returncode, 1)
        self.assertIn("fixture directory", result.stderr)


if __name__ == "__main__":
    sys.exit(unittest.main())
