#!/usr/bin/env python3
"""Validate ci/compatibility-matrix.json against the repository.

    scripts/validate-compatibility-matrix.py                         # structure and drift (ordinary CI)
    scripts/validate-compatibility-matrix.py --as-of 2026-09-14 --max-age-days 30   # also time-based gates (release)
    scripts/validate-compatibility-matrix.py --markdown              # print a summary table

The matrix is the single record of what each SDK supports and how it is tested. This validator fails when
it drifts from the repository:

- each declared runtime floor must equal the package metadata (go.mod, package.json engines,
  pyproject.toml, composer.json, pom.xml, Directory.Build.props, gemspec);
- each framework declaration must appear verbatim in the named file;
- the CI matrix values of each listed job and key must equal .github/workflows/ci.yml, in order;
- the current profile must match what .github/workflows/release-readiness.yml installs;
- every observed version, tested framework version, and end-of-support date must appear in the
  language's evidence document.

With --as-of it also fails when a supported line's end-of-support date has passed or when verified_on is
older than --max-age-days, and warns about lines ending within 90 days. Standard library only.
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import re
import sys
from pathlib import Path, PurePosixPath

LANGUAGES = ("go", "node", "python", "php", "java", "dotnet", "ruby")
PROFILES = ("minimum", "current")
ROOT = Path(__file__).resolve().parent.parent
WARNING_DAYS = 90


class MatrixError(Exception):
    """The matrix is malformed or disagrees with the repository."""


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise MatrixError(f"matrix repeats the key {key!r}")
        result[key] = value
    return result


def _keys(value: object, expected: set[str], where: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != expected:
        actual = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise MatrixError(f"{where} must have exactly the keys {sorted(expected)}, found {actual}")
    return value


def _string(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MatrixError(f"{where} must be a non-empty string")
    return value


def _strings(value: object, where: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not value and not allow_empty):
        raise MatrixError(f"{where} must be a {'' if allow_empty else 'non-empty '}array of strings")
    return [_string(item, f"{where}[{index}]") for index, item in enumerate(value)]


def _repo_file(root: Path, value: object, where: str) -> Path:
    path = _string(value, where)
    parts = PurePosixPath(path).parts
    if path.startswith("/") or "\\" in path or any(part in ("", ".", "..") for part in path.split("/")) or not parts:
        raise MatrixError(f"{where} must be a repository-relative path without '.' or '..': {path!r}")
    file = root / path
    if not file.is_file():
        raise MatrixError(f"{where} does not exist: {path}")
    return file


def _parse_date(value: str, where: str) -> dt.date:
    """Accept YYYY-MM-DD, or YYYY-MM meaning the last day of that month."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return dt.date.fromisoformat(value)
        if re.fullmatch(r"\d{4}-\d{2}", value):
            year, month = (int(part) for part in value.split("-"))
            return dt.date(year, month, calendar.monthrange(year, month)[1])
    except ValueError:
        pass
    raise MatrixError(f"{where} must be a date in YYYY-MM-DD or YYYY-MM form, found {value!r}")


# ---------------------------------------------------------------------------------------------------
# Declared runtime floors


def declared_runtime(file: Path, kind: str) -> str:
    text = file.read_text(encoding="utf-8")
    if kind == "go-directive":
        match = re.search(r"(?m)^go\s+(\S+)\s*$", text)
    elif kind.startswith("npm-engine:"):
        engines = json.loads(text).get("engines", {})
        return str(engines.get(kind.split(":", 1)[1], ""))
    elif kind == "requires-python":
        match = re.search(r'(?m)^requires-python\s*=\s*"([^"]+)"', text)
    elif kind.startswith("composer-require:"):
        return str(json.loads(text).get("require", {}).get(kind.split(":", 1)[1], ""))
    elif kind.startswith("maven-property:"):
        name = re.escape(kind.split(":", 1)[1])
        match = re.search(rf"<{name}>([^<$]+)</{name}>", text)
    elif kind.startswith("msbuild-property:"):
        name = re.escape(kind.split(":", 1)[1])
        match = re.search(rf"<{name}>([^<$]+)</{name}>", text)
    elif kind.startswith("gemspec:"):
        name = re.escape(kind.split(":", 1)[1])
        match = re.search(rf'{name}\s*=\s*"([^"]+)"', text)
    else:
        raise MatrixError(f"unknown declared_in kind {kind!r}")
    return match.group(1) if match else ""


# ---------------------------------------------------------------------------------------------------
# Workflow extraction (the workflows are authored in this repository; only the needed subset is read)


def _job_block(workflow: str, job: str) -> list[str]:
    lines = workflow.splitlines()
    start = next((index for index, line in enumerate(lines) if line == f"  {job}:"), None)
    if start is None:
        raise MatrixError(f"job {job!r} not found in the workflow")
    end = next((index for index in range(start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[index]) or re.match(r"^\S", lines[index])), len(lines))
    return lines[start + 1:end]


def _scalar(value: str) -> str:
    value = re.sub(r"\s+#.*$", "", value).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


def ci_matrix_values(workflow: str, job: str, key: str) -> list[str]:
    """Values of `key` inside the job's strategy.matrix, in file order (list syntax is flattened)."""
    block = _job_block(workflow, job)
    matrix_index = next((index for index, line in enumerate(block) if line.strip() == "matrix:"), None)
    if matrix_index is None:
        raise MatrixError(f"job {job!r} has no strategy.matrix")
    indent = len(block[matrix_index]) - len(block[matrix_index].lstrip())
    values: list[str] = []
    for line in block[matrix_index + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        match = re.match(rf"^\s*(?:-\s+)?{re.escape(key)}:\s*(.+?)\s*$", line)
        if not match:
            continue
        raw = _scalar(match.group(1)) if not match.group(1).startswith("[") else match.group(1)
        if raw.startswith("["):
            values.extend(_scalar(item) for item in raw.strip("[] ").split(",") if item.strip())
        else:
            values.append(raw)
    return values


def release_readiness_values(workflow: str, language: str, key: str) -> list[str]:
    """Values of `key` in the package job's steps guarded by `if: matrix.language == '<language>'`."""
    block = _job_block(workflow, "package")
    values: list[str] = []
    inside = False
    step_indent = None
    for line in block:
        stripped = line.strip()
        if stripped.startswith("- "):
            step_indent = len(line) - len(line.lstrip())
            inside = stripped == f"- if: matrix.language == '{language}'"
            continue
        if inside and step_indent is not None and stripped and len(line) - len(line.lstrip()) <= step_indent:
            inside = False
        if inside:
            match = re.match(rf"^\s*{re.escape(key)}:\s*(.+?)\s*$", line)
            if match:
                values.append(_scalar(match.group(1)))
    return values


# ---------------------------------------------------------------------------------------------------


def validate(matrix_path: Path, root: Path = ROOT, *, as_of: dt.date | None = None, max_age_days: int | None = None) -> tuple[dict[str, object], list[str]]:
    """Validate the matrix; return it with any non-fatal warnings. Raises MatrixError on the first problem."""
    try:
        document = json.loads(matrix_path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
    except json.JSONDecodeError as error:
        raise MatrixError(f"matrix is not valid JSON: {error.msg} at line {error.lineno}") from error
    matrix = _keys(document, {"schema_version", "verified_on", "languages"}, "matrix")
    if matrix["schema_version"] != 1 or isinstance(matrix["schema_version"], bool):
        raise MatrixError("schema_version must be the integer 1")
    verified_on = _parse_date(_string(matrix["verified_on"], "verified_on"), "verified_on")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(matrix["verified_on"])):
        raise MatrixError("verified_on must be a full YYYY-MM-DD date")

    entries = matrix["languages"]
    if not isinstance(entries, list) or [entry.get("language") if isinstance(entry, dict) else None for entry in entries] != list(LANGUAGES):
        raise MatrixError(f"languages must list exactly {', '.join(LANGUAGES)} in that order")

    ci_workflow = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    release_workflow = (root / ".github" / "workflows" / "release-readiness.yml").read_text(encoding="utf-8")
    warnings: list[str] = []

    for entry in entries:
        language = entry["language"]
        where = f"languages.{language}"
        entry = _keys(entry, {"language", "evidence", "runtimes", "ci", "profiles", "release_readiness", "frameworks", "end_of_support"}, where)
        evidence = _repo_file(root, entry["evidence"], f"{where}.evidence").read_text(encoding="utf-8")

        def in_evidence(value: str, label: str) -> None:
            if value not in evidence:
                raise MatrixError(f"{label} {value!r} does not appear in {entry['evidence']}")

        runtimes = entry["runtimes"]
        if not isinstance(runtimes, list) or not runtimes:
            raise MatrixError(f"{where}.runtimes must be a non-empty array")
        for index, runtime in enumerate(runtimes):
            runtime_where = f"{where}.runtimes[{index}]"
            runtime = _keys(runtime, {"name", "declared", "declared_in"}, runtime_where)
            _string(runtime["name"], f"{runtime_where}.name")
            declared = _string(runtime["declared"], f"{runtime_where}.declared")
            source = _keys(runtime["declared_in"], {"file", "kind"}, f"{runtime_where}.declared_in")
            file = _repo_file(root, source["file"], f"{runtime_where}.declared_in.file")
            actual = declared_runtime(file, _string(source["kind"], f"{runtime_where}.declared_in.kind"))
            if actual != declared:
                raise MatrixError(f"{runtime_where}: {source['file']} declares {actual!r}, matrix says {declared!r}")

        ci_entries = entry["ci"]
        if not isinstance(ci_entries, list) or not ci_entries:
            raise MatrixError(f"{where}.ci must be a non-empty array")
        primary_values: list[str] = []
        for index, ci in enumerate(ci_entries):
            ci_where = f"{where}.ci[{index}]"
            ci = _keys(ci, {"job", "key", "values"}, ci_where)
            values = _strings(ci["values"], f"{ci_where}.values")
            actual_values = ci_matrix_values(ci_workflow, _string(ci["job"], f"{ci_where}.job"), _string(ci["key"], f"{ci_where}.key"))
            if actual_values != values:
                raise MatrixError(f"{ci_where}: ci.yml job {ci['job']!r} has {ci['key']} {actual_values}, matrix says {values}")
            if index == 0:
                primary_values = values

        profiles = entry["profiles"]
        if not isinstance(profiles, list) or [profile.get("name") if isinstance(profile, dict) else None for profile in profiles] != list(PROFILES):
            raise MatrixError(f"{where}.profiles must be exactly minimum then current")
        current_value = ""
        for profile in profiles:
            profile_where = f"{where}.profiles.{profile['name']}"
            profile = _keys(profile, {"name", "ci_value", "observed"}, profile_where)
            ci_value = _string(profile["ci_value"], f"{profile_where}.ci_value")
            if ci_value not in primary_values:
                raise MatrixError(f"{profile_where}.ci_value {ci_value!r} is not one of the CI values {primary_values}")
            observed = _string(profile["observed"], f"{profile_where}.observed")
            if not re.fullmatch(r"v?\d+(\.\d+)+", observed):
                raise MatrixError(f"{profile_where}.observed must be an exact version, found {observed!r}")
            in_evidence(observed, f"{profile_where}.observed")
            if profile["name"] == "current":
                current_value = ci_value

        release = _keys(entry["release_readiness"], {"key", "value"}, f"{where}.release_readiness")
        release_value = _string(release["value"], f"{where}.release_readiness.value")
        actual_release = release_readiness_values(release_workflow, language, _string(release["key"], f"{where}.release_readiness.key"))
        if actual_release != [release_value]:
            raise MatrixError(f"{where}.release_readiness: release-readiness.yml installs {release['key']} {actual_release}, matrix says [{release_value!r}]")
        if release_value != current_value and not release_value.startswith(current_value + "."):
            raise MatrixError(f"{where}.release_readiness value {release_value!r} does not match the current CI profile {current_value!r}")

        frameworks = entry["frameworks"]
        if not isinstance(frameworks, list) or not frameworks:
            raise MatrixError(f"{where}.frameworks must be a non-empty array")
        names = [framework.get("name") if isinstance(framework, dict) else None for framework in frameworks]
        if len(set(names)) != len(names):
            raise MatrixError(f"{where}.frameworks has duplicate names")
        for framework in frameworks:
            framework_where = f"{where}.frameworks.{framework.get('name')}"
            framework = _keys(framework, {"name", "supported", "declared_in", "tested"}, framework_where)
            _string(framework["name"], f"{framework_where}.name")
            _string(framework["supported"], f"{framework_where}.supported")
            if framework["declared_in"] is not None:
                declaration = _keys(framework["declared_in"], {"file", "contains"}, f"{framework_where}.declared_in")
                file = _repo_file(root, declaration["file"], f"{framework_where}.declared_in.file")
                contains = _string(declaration["contains"], f"{framework_where}.declared_in.contains")
                if contains not in file.read_text(encoding="utf-8"):
                    raise MatrixError(f"{framework_where}: {declaration['file']} no longer contains {contains!r}")
            for version in _strings(framework["tested"], f"{framework_where}.tested", allow_empty=True):
                in_evidence(version, f"{framework_where}.tested")

        support = entry["end_of_support"]
        if not isinstance(support, list):
            raise MatrixError(f"{where}.end_of_support must be an array")
        for index, line in enumerate(support):
            line_where = f"{where}.end_of_support[{index}]"
            line = _keys(line, {"component", "line", "date"}, line_where)
            label = f"{_string(line['component'], f'{line_where}.component')} {_string(line['line'], f'{line_where}.line')}"
            raw_date = _string(line["date"], f"{line_where}.date")
            ends = _parse_date(raw_date, f"{line_where}.date")
            in_evidence(raw_date, f"{line_where}.date")
            if as_of is not None:
                if ends < as_of:
                    raise MatrixError(f"{language}: {label} reached end of support on {raw_date}; update the supported floor")
                if (ends - as_of).days <= WARNING_DAYS:
                    warnings.append(f"{language}: {label} reaches end of support on {raw_date} ({(ends - as_of).days} days)")

    if as_of is not None:
        if verified_on > as_of:
            raise MatrixError(f"verified_on {verified_on} is after --as-of {as_of}")
        if max_age_days is not None and (as_of - verified_on).days > max_age_days:
            raise MatrixError(f"verified_on {verified_on} is {(as_of - verified_on).days} days old; recheck official sources and evidence (limit {max_age_days} days)")
    return matrix, warnings


def markdown(matrix: dict[str, object]) -> str:
    rows = ["| Language | Runtime floor | CI minimum → current (observed) | Frameworks |", "| --- | --- | --- | --- |"]
    for entry in matrix["languages"]:  # type: ignore[union-attr]
        floors = ", ".join(f"{runtime['name']} {runtime['declared']}" for runtime in entry["runtimes"])
        minimum, current = entry["profiles"]
        frameworks = ", ".join(f"{framework['name']} {framework['supported']}" for framework in entry["frameworks"])
        rows.append(f"| {entry['language']} | {floors} | {minimum['observed']} → {current['observed']} | {frameworks} |")
    return f"### SDK compatibility (verified {matrix['verified_on']})\n\n" + "\n".join(rows) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("matrix", nargs="?", type=Path, default=ROOT / "ci" / "compatibility-matrix.json")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    parser.add_argument("--as-of", type=dt.date.fromisoformat, help="enable end-of-support and freshness gates for this date (YYYY-MM-DD)")
    parser.add_argument("--max-age-days", type=int, help="with --as-of, fail when verified_on is older than this many days")
    parser.add_argument("--markdown", action="store_true", help="print a Markdown summary table after validating")
    arguments = parser.parse_args(argv)
    if arguments.max_age_days is not None and arguments.as_of is None:
        parser.error("--max-age-days requires --as-of")
    try:
        matrix, warnings = validate(arguments.matrix, arguments.root, as_of=arguments.as_of, max_age_days=arguments.max_age_days)
    except MatrixError as error:
        print(f"compatibility matrix invalid: {error}", file=sys.stderr)
        return 1
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if arguments.markdown:
        sys.stdout.write(markdown(matrix))
    else:
        print(f"compatibility matrix valid: {len(LANGUAGES)} languages, verified {matrix['verified_on']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
