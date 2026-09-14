#!/usr/bin/env python3
"""Run the shared conformance fixtures for one or more SDK languages.

    scripts/conformance.sh                     # every language that has an executable runner
    scripts/conformance.sh --language php      # one language (used by CI fan-out)

Each language gets a private mock ingest server process, so queues and journals are never shared.
The runner receives exactly the four CEKAT_CONFORMANCE_* variables. A language passes only when its
runner exits 0, the mock server stays up and exits cleanly, and the runner's result records account
for every discovered fixture exactly once: "passed", or "not_applicable" where the fixture itself
declares the language inapplicable.

Set MOCK_INGEST_SERVER_BIN to reuse a prebuilt mock binary; otherwise it is built with Go.
Standard library only.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

LANGUAGES = ("go", "node", "python", "php", "java", "dotnet", "ruby")
ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "conformance" / "fixtures" / "cases"
ACCESS_TOKEN = "conformance-token"
CONFORMANCE_PREFIX = "CEKAT_CONFORMANCE_"
READINESS_TIMEOUT_SECONDS = float(os.environ.get("CONFORMANCE_READINESS_TIMEOUT_SECONDS", "10"))
STOP_TIMEOUT_SECONDS = 6.0
RECORD_START = re.compile(r'\{"id"\s*:')
GITHUB_ACTIONS = bool(os.environ.get("GITHUB_ACTIONS"))


class Failure(Exception):
    """A per-language failure with a message that never contains the access token."""


@dataclass
class Outcome:
    passed: int = 0
    not_applicable: int = 0
    deviations: int = 0
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def usage(message: str) -> None:
    print(f"conformance: {message}", file=sys.stderr)
    print(f"usage: scripts/conformance.sh [--language <{'|'.join(LANGUAGES)}>]", file=sys.stderr)
    sys.exit(2)


def group(title: str) -> None:
    print(f"::group::{title}" if GITHUB_ACTIONS else f"== {title}", flush=True)


def end_group() -> None:
    if GITHUB_ACTIONS:
        print("::endgroup::", flush=True)


def load_fixtures(directory: Path) -> dict[str, set[str]]:
    """Map each fixture ID (its file name) to the languages it declares inapplicable."""
    if not directory.is_dir():
        raise SystemExit(f"conformance: fixture directory {directory} is missing")
    fixtures: dict[str, set[str]] = {}
    for path in sorted(directory.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        inapplicable = document.get("applicability", {}).get("inapplicable_languages", [])
        fixtures[path.stem] = set(inapplicable)
    if not fixtures:
        raise SystemExit(f"conformance: fixture directory {directory} contains no fixtures")
    return fixtures


def parse_records(lines: list[str]) -> list[dict[str, object]]:
    """Extract {"id": ..., "status": ...} result records, wherever they start on a line."""
    decoder = json.JSONDecoder()
    records = []
    for line in lines:
        match = RECORD_START.search(line)
        if match is None:
            continue
        try:
            record, _ = decoder.raw_decode(line, match.start())
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and isinstance(record.get("id"), str) and "status" in record:
            records.append(record)
    return records


def account(language: str, fixtures: dict[str, set[str]], records: list[dict[str, object]], outcome: Outcome) -> None:
    """Require exactly one passed or declared not_applicable record for every fixture."""
    seen: dict[str, int] = {}
    for record in records:
        fixture_id = str(record["id"])
        seen[fixture_id] = seen.get(fixture_id, 0) + 1
        status = record["status"]
        if fixture_id not in fixtures:
            outcome.problems.append(f"result for unknown fixture {fixture_id}")
        elif status == "passed":
            outcome.passed += 1
            if "runtime_deviation" in record:
                outcome.deviations += 1
        elif status == "not_applicable":
            if language in fixtures[fixture_id]:
                outcome.not_applicable += 1
            else:
                outcome.problems.append(f"{fixture_id} reported not_applicable but does not declare {language} inapplicable")
        else:
            outcome.problems.append(f"{fixture_id} has status {status!r}; only passed or declared not_applicable count")
    duplicates = sorted(fixture_id for fixture_id, count in seen.items() if count > 1)
    if duplicates:
        outcome.problems.append(f"fixtures reported more than once: {', '.join(duplicates)}")
    missing = sorted(set(fixtures) - set(seen))
    if missing:
        shown = ", ".join(missing[:5]) + (f" and {len(missing) - 5} more" if len(missing) > 5 else "")
        outcome.problems.append(f"{len(missing)} fixture(s) have no result: {shown}")


def build_mock(work: Path) -> Path:
    binary = os.environ.get("MOCK_INGEST_SERVER_BIN")
    if binary:
        path = Path(binary)
    else:
        path = work / "mock-ingest-server"
        subprocess.run(["go", "build", "-o", str(path), "./cmd/mock-ingest-server"], cwd=ROOT / "conformance" / "mock-ingest-server", check=True)
    if not (path.is_file() and os.access(path, os.X_OK)):
        raise SystemExit(f"conformance: mock binary {path} is not executable")
    return path


def stop(process: subprocess.Popen[bytes] | subprocess.Popen[str], *, group_kill: bool) -> int:
    """TERM, then KILL after the deadline; return the exit status."""
    if process.poll() is None:
        signal_target(process, signal.SIGTERM, group_kill)
        try:
            return process.wait(STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            signal_target(process, signal.SIGKILL, group_kill)
    return process.wait()


def signal_target(process: subprocess.Popen[bytes] | subprocess.Popen[str], signum: int, group_kill: bool) -> None:
    try:
        if group_kill:
            os.killpg(process.pid, signum)
        else:
            process.send_signal(signum)
    except (ProcessLookupError, PermissionError):
        pass


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def group_has_live_members(pgid: int) -> bool:
    """True while the group has a member that is not a zombie (zombies cannot be reaped from a handler)."""
    if not group_alive(pgid):
        return False
    result = subprocess.run(["ps", "-A", "-o", "pgid=,stat="], capture_output=True, text=True, check=False)
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == str(pgid) and not parts[1].startswith("Z"):
            return True
    return False


def wait_for_readiness(mock: subprocess.Popen[bytes], ready: Path) -> str:
    deadline = time.monotonic() + READINESS_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        text = ready.read_text(encoding="utf-8", errors="replace") if ready.exists() else ""
        if text.endswith("\n"):
            break
        if mock.poll() is not None:
            raise Failure(f"mock server exited with status {mock.returncode} before reporting readiness")
        time.sleep(0.05)
    else:
        raise Failure(f"mock server did not report readiness within {READINESS_TIMEOUT_SECONDS:g} seconds")
    lines = text.splitlines()
    try:
        record = json.loads(lines[0]) if len(lines) == 1 else None
    except json.JSONDecodeError:
        record = None
    if not isinstance(record, dict) or set(record) != {"base_url", "control_url"} or record["base_url"] != record["control_url"]:
        raise Failure("mock server wrote a malformed readiness record")
    origin = urllib.parse.urlsplit(str(record["base_url"]))
    if origin.scheme != "http" or origin.hostname != "127.0.0.1" or origin.path or origin.query or origin.fragment:
        raise Failure("mock server readiness origin is not a loopback HTTP origin")
    return str(record["base_url"])


def wait_for_control(mock: subprocess.Popen[bytes], base_url: str) -> None:
    deadline = time.monotonic() + READINESS_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if mock.poll() is not None:
            raise Failure(f"mock server exited with status {mock.returncode} before its control API was ready")
        request = urllib.request.Request(f"{base_url}/__control/reset", data=b"", method="POST")
        try:
            with urllib.request.urlopen(request, timeout=1) as response:
                if response.status == 204:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.1)
    raise Failure("mock server control API never answered POST /__control/reset with 204")


def run_runner(language: str, base_url: str, log_lines: list[str], active: dict[str, subprocess.Popen[str]], outcome: Outcome) -> int:
    environment = {name: value for name, value in os.environ.items() if not name.startswith(CONFORMANCE_PREFIX)}
    environment.update({
        "CEKAT_CONFORMANCE_BASE_URL": base_url,
        "CEKAT_CONFORMANCE_CONTROL_URL": base_url,
        "CEKAT_CONFORMANCE_ACCESS_TOKEN": ACCESS_TOKEN,
        "CEKAT_CONFORMANCE_FIXTURES": str(FIXTURES),
    })
    runner = subprocess.Popen(
        [str(ROOT / language / "scripts" / "conformance")],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        bufsize=1,
        start_new_session=True,
    )
    active["runner"] = runner

    def stream() -> None:
        assert runner.stdout is not None
        for line in runner.stdout:
            redacted = line.replace(ACCESS_TOKEN, "[redacted]")
            log_lines.append(redacted.rstrip("\n"))
            sys.stdout.write(redacted)
            sys.stdout.flush()

    reader = threading.Thread(target=stream, daemon=True)
    reader.start()
    status = runner.wait()
    # Processes the runner started and left behind share its process group; stop them so they cannot
    # hold the output pipe open or disturb the next language.
    if group_alive(runner.pid):
        outcome.warnings.append("runner left processes running; they were stopped")
        signal_target(runner, signal.SIGTERM, True)
        deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
        while group_alive(runner.pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        if group_alive(runner.pid):
            signal_target(runner, signal.SIGKILL, True)
    reader.join(STOP_TIMEOUT_SECONDS)
    active.pop("runner", None)
    return status


def run_language(language: str, mock_binary: Path, fixtures: dict[str, set[str]], work: Path, active: dict[str, subprocess.Popen[str]]) -> Outcome:
    outcome = Outcome()
    private = Path(tempfile.mkdtemp(prefix=f"{language}-", dir=work))
    ready = private / "ready"
    mock_stderr = private / "mock.stderr"
    with ready.open("wb") as ready_file, mock_stderr.open("wb") as stderr_file:
        mock = subprocess.Popen([str(mock_binary), "--listen", "127.0.0.1:0"], stdin=subprocess.DEVNULL, stdout=ready_file, stderr=stderr_file, start_new_session=True)
    active["mock"] = mock  # type: ignore[assignment]
    try:
        base_url = wait_for_readiness(mock, ready)
        wait_for_control(mock, base_url)
        log_lines: list[str] = []
        status = run_runner(language, base_url, log_lines, active, outcome)
        if status != 0:
            outcome.problems.append(f"runner exited with status {status}")
        if mock.poll() is not None:
            outcome.problems.append(f"mock server exited with status {mock.returncode} while the runner was active")
        account(language, fixtures, parse_records(log_lines), outcome)
    except Failure as error:
        outcome.problems.append(str(error))
    finally:
        was_running = mock.poll() is None
        mock_status = stop(mock, group_kill=False)
        active.pop("mock", None)
        if was_running and mock_status != 0:
            outcome.problems.append(f"mock server exited with status {mock_status} when stopped")
        if outcome.problems and mock_stderr.exists():
            diagnostics = mock_stderr.read_text(encoding="utf-8", errors="replace").strip()
            if diagnostics:
                print(diagnostics.replace(ACCESS_TOKEN, "[redacted]"), file=sys.stderr)
    return outcome


def main(arguments: list[str]) -> int:
    if not arguments:
        selected = []
        for language in LANGUAGES:
            if os.access(ROOT / language / "scripts" / "conformance", os.X_OK):
                selected.append(language)
            else:
                print(f"conformance: {language} has no runner yet; not run", file=sys.stderr)
        if not selected:
            print("conformance: no language runners found", file=sys.stderr)
            return 1
    elif len(arguments) == 2 and arguments[0] == "--language":
        if arguments[1] not in LANGUAGES:
            usage(f"unknown language: {arguments[1]}")
        if not os.access(ROOT / arguments[1] / "scripts" / "conformance", os.X_OK):
            print(f"conformance: {arguments[1]}/scripts/conformance is missing or not executable", file=sys.stderr)
            return 1
        selected = [arguments[1]]
    else:
        usage("expected no arguments or --language <language>")

    fixtures = load_fixtures(FIXTURES)
    work = Path(tempfile.mkdtemp(prefix="cekat-conformance-"))
    active: dict[str, subprocess.Popen[str]] = {}

    def interrupted(signum: int, _frame: object) -> None:
        # The main thread may be blocked in Popen.wait(); waiting here again would deadlock, so only
        # signal the runner and mock process groups (both run in their own sessions) and poll.
        groups = [process.pid for process in active.values()]
        for pgid in groups:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
        while any(group_has_live_members(pgid) for pgid in groups) and time.monotonic() < deadline:
            time.sleep(0.05)
        for pgid in groups:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        shutil.rmtree(work, ignore_errors=True)
        print("\nconformance: interrupted", file=sys.stderr)
        os._exit(130)

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        mock_binary = build_mock(work)
        summary = []
        failed = False
        for language in selected:
            group(f"conformance {language}")
            outcome = run_language(language, mock_binary, fixtures, work, active)
            end_group()
            counts = f"{outcome.passed} passed, {outcome.not_applicable} not_applicable" + (f", {outcome.deviations} with runtime_deviation" if outcome.deviations else "")
            for warning in outcome.warnings:
                print(f"conformance: {language}: warning: {warning}", file=sys.stderr)
            if outcome.problems:
                failed = True
                for problem in outcome.problems:
                    print(f"conformance: {language}: {problem}", file=sys.stderr)
                summary.append(f"{language}: FAILED ({counts}; {'; '.join(outcome.problems)})")
            else:
                summary.append(f"{language}: ok ({counts})")
        print("\nConformance summary")
        for line in summary:
            print(f"  {line}")
        return 1 if failed else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
