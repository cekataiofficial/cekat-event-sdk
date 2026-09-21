from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

import cekat_event_sdk

ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "scripts" / "package"


@pytest.fixture
def dirty(tmp_path: Path) -> Path:
    (tmp_path / "stale.whl").write_text("stale")
    return tmp_path


def test_rejects_invalid_arguments_before_running_checks(dirty: Path) -> None:
    temporary = tempfile.gettempdir()
    cases = [
        [],
        ["--version", "0.2.0"],
        ["--version", "0.1.1", "--output", temporary],
        ["--version", "0.2.0", "--output", "relative"],
        ["--version", "0.2.0", "--output", f"{temporary}/../tmp"],
        ["--version", "0.2.0", "--output", str(dirty)],
        ["--version", "0.2.0", "--output", str(dirty / "stale.whl")],
        ["--version", "0.2.0", "--output", str(ROOT / "dist-output")],
    ]
    for arguments in cases:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments], capture_output=True, text=True, check=False
        )
        assert result.returncode == 2, (arguments, result.stderr)
        assert "usage" in result.stderr
    assert not (ROOT / "dist-output").exists()


def test_matches_package_version_and_never_publishes() -> None:
    source = SCRIPT.read_text()
    assert f'VERSION = "{cekat_event_sdk.__version__}"' in source
    for required in ('"pytest"', '"ruff"', '"mypy"', '"pip_audit"', '"build"', '"twine", "check"'):
        assert required in source
    for forbidden in ("upload", "publish", "git tag", "git push", "gpg", "sign "):
        assert forbidden not in source.replace("never uploads, signs", "")
