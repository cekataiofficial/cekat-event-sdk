#!/usr/bin/env python3
"""Validate the manifest.json written by <language>/scripts/package.

Single manifest:
    scripts/validate-package-manifest.py <output>/manifest.json --language <language> --version 0.1.0

All seven languages (one child directory per language, as produced by scripts/package-readiness.sh --all):
    scripts/validate-package-manifest.py --all <aggregate-root> [--markdown]

ci/package-manifest.schema.json documents the shape. This validator is the executable authority: it
also checks path safety and ordering, that the manifest lists exactly the regular files in its output
directory, and every size and SHA-256 hash. It uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

LANGUAGES = ("go", "node", "python", "php", "java", "dotnet", "ruby")
VERSION = "0.1.0"
MANIFEST_NAME = "manifest.json"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
CHUNK_BYTES = 1024 * 1024


class ManifestError(Exception):
    """The manifest or its output directory violates the release manifest contract."""


@dataclass(frozen=True)
class Artifact:
    path: str
    sha256: str
    size_bytes: int


def _reject_constant(value: str) -> None:
    raise ManifestError(f"manifest contains the non-JSON number {value}")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ManifestError(f"manifest repeats the key {key!r}")
        result[key] = value
    return result


def _load(manifest: Path) -> object:
    try:
        with manifest.open("rb") as handle:
            text = handle.read().decode("utf-8")
    except UnicodeDecodeError as error:
        raise ManifestError("manifest is not valid UTF-8") from error
    try:
        return json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except json.JSONDecodeError as error:
        raise ManifestError(f"manifest is not valid JSON: {error.msg} at line {error.lineno}") from error


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_path(path: object) -> str:
    if not isinstance(path, str) or path == "":
        raise ManifestError("artifact path must be a non-empty string")
    if "\\" in path or "\0" in path:
        raise ManifestError(f"artifact path {path!r} contains a backslash or NUL")
    if path.startswith("/"):
        raise ManifestError(f"artifact path {path!r} must be relative")
    if any(part in ("", ".", "..") for part in path.split("/")):
        raise ManifestError(f"artifact path {path!r} contains an empty, '.', or '..' component")
    if path == MANIFEST_NAME:
        raise ManifestError("the manifest must not list itself")
    return path


def parse_manifest(document: object, *, language: str, version: str) -> list[Artifact]:
    """Check the manifest document's shape and return its artifacts."""
    if not isinstance(document, dict):
        raise ManifestError("manifest must be a JSON object")
    expected_keys = {"schema_version", "language", "version", "artifacts"}
    if set(document) != expected_keys:
        unknown = sorted(set(document) - expected_keys)
        missing = sorted(expected_keys - set(document))
        raise ManifestError(f"manifest keys must be exactly {sorted(expected_keys)} (unknown {unknown}, missing {missing})")
    if not _is_int(document["schema_version"]) or document["schema_version"] != 1:
        raise ManifestError("schema_version must be the integer 1")
    if document["language"] not in LANGUAGES:
        raise ManifestError(f"language must be one of {', '.join(LANGUAGES)}")
    if document["language"] != language:
        raise ManifestError(f"language is {document['language']!r}, expected {language!r}")
    if document["version"] != version:
        raise ManifestError(f"version is {document['version']!r}, expected {version!r}")
    raw_artifacts = document["artifacts"]
    if not isinstance(raw_artifacts, list) or not raw_artifacts:
        raise ManifestError("artifacts must be a non-empty array")

    artifacts: list[Artifact] = []
    for index, raw in enumerate(raw_artifacts):
        if not isinstance(raw, dict) or set(raw) != {"path", "sha256", "size_bytes"}:
            raise ManifestError(f"artifacts[{index}] must have exactly path, sha256, and size_bytes")
        path = _check_path(raw["path"])
        sha256 = raw["sha256"]
        if not isinstance(sha256, str) or SHA256_PATTERN.fullmatch(sha256) is None:
            raise ManifestError(f"artifact {path!r} sha256 must be 64 lowercase hexadecimal characters")
        size = raw["size_bytes"]
        if not _is_int(size) or size < 1:
            raise ManifestError(f"artifact {path!r} size_bytes must be an integer of at least 1")
        artifacts.append(Artifact(path, sha256, size))

    paths = [artifact.path for artifact in artifacts]
    if len(set(paths)) != len(paths):
        raise ManifestError("artifact paths must be unique")
    if paths != sorted(paths, key=lambda value: value.encode("utf-8")):
        raise ManifestError("artifacts must be sorted by path (UTF-8 byte order)")
    return artifacts


def _regular_files(output: Path) -> set[str]:
    """Return slash-separated relative paths of regular files, rejecting symlinks and special files."""
    files: set[str] = set()
    for directory, subdirectories, names in os.walk(output, followlinks=False):
        for name in subdirectories + names:
            entry = Path(directory, name)
            relative = entry.relative_to(output).as_posix()
            mode = entry.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ManifestError(f"output contains a symbolic link: {relative}")
            if stat.S_ISDIR(mode):
                continue
            if not stat.S_ISREG(mode):
                raise ManifestError(f"output contains a non-regular file: {relative}")
            files.add(relative)
    return files


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest(manifest: Path, *, language: str, version: str = VERSION) -> list[Artifact]:
    """Validate one manifest and its output directory; return the verified artifacts."""
    if manifest.name != MANIFEST_NAME:
        raise ManifestError(f"manifest file must be named {MANIFEST_NAME}")
    try:
        manifest_mode = manifest.lstat().st_mode
    except FileNotFoundError as error:
        raise ManifestError(f"{manifest} does not exist") from error
    if not stat.S_ISREG(manifest_mode):
        raise ManifestError(f"{manifest} must be a regular file, not a symbolic link or directory")
    output = manifest.parent
    if output.is_symlink():
        raise ManifestError(f"output directory {output} must not be a symbolic link")

    artifacts = parse_manifest(_load(manifest), language=language, version=version)
    present = _regular_files(output) - {MANIFEST_NAME}
    listed = {artifact.path for artifact in artifacts}
    if listed - present:
        raise ManifestError(f"listed artifacts are missing or not regular files: {sorted(listed - present)}")
    if present - listed:
        raise ManifestError(f"output contains files the manifest does not list: {sorted(present - listed)}")
    for artifact in artifacts:
        file = output / artifact.path
        size = file.lstat().st_size
        if size != artifact.size_bytes:
            raise ManifestError(f"artifact {artifact.path!r} is {size} bytes, manifest says {artifact.size_bytes}")
        if _sha256(file) != artifact.sha256:
            raise ManifestError(f"artifact {artifact.path!r} SHA-256 does not match the manifest")
    return artifacts


def validate_all(root: Path, *, version: str = VERSION) -> dict[str, list[Artifact]]:
    """Validate an aggregate directory holding exactly one child directory per language."""
    if root.is_symlink() or not root.is_dir():
        raise ManifestError(f"{root} must be a directory")
    entries = {entry.name: entry for entry in root.iterdir()}
    if set(entries) != set(LANGUAGES):
        missing = [language for language in LANGUAGES if language not in entries]
        unexpected = sorted(set(entries) - set(LANGUAGES))
        raise ManifestError(f"aggregate must contain exactly the seven language directories (missing {missing}, unexpected {unexpected})")
    results: dict[str, list[Artifact]] = {}
    for language in LANGUAGES:
        directory = entries[language]
        if directory.is_symlink() or not directory.is_dir():
            raise ManifestError(f"{language} must be a directory")
        try:
            results[language] = validate_manifest(directory / MANIFEST_NAME, language=language, version=version)
        except ManifestError as error:
            raise ManifestError(f"{language}: {error}") from error
    return results


def markdown_summary(results: dict[str, list[Artifact]], version: str = VERSION) -> str:
    lines = [f"### Cekat event SDK {version} package artifacts", "", "| Language | Artifact | Bytes | SHA-256 |", "| --- | --- | ---: | --- |"]
    for language, artifacts in results.items():
        lines.extend(f"| {language} | `{artifact.path}` | {artifact.size_bytes} | `{artifact.sha256}` |" for artifact in artifacts)
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", nargs="?", type=Path, help="path to <output>/manifest.json")
    parser.add_argument("--language", choices=LANGUAGES, help="language the manifest must declare")
    parser.add_argument("--version", default=None, help=f"package version; only {VERSION} is accepted")
    parser.add_argument("--all", dest="aggregate", type=Path, metavar="ROOT", help="validate ROOT/<language>/manifest.json for all seven languages")
    parser.add_argument("--markdown", action="store_true", help="with --all, print a Markdown artifact table")
    arguments = parser.parse_args(argv)

    if arguments.aggregate is not None:
        if arguments.manifest is not None or arguments.language is not None:
            parser.error("--all cannot be combined with a manifest path or --language")
        if arguments.version not in (None, VERSION):
            parser.error(f"only version {VERSION} is accepted")
        try:
            results = validate_all(arguments.aggregate)
        except ManifestError as error:
            print(f"package manifests invalid: {error}", file=sys.stderr)
            return 1
        if arguments.markdown:
            sys.stdout.write(markdown_summary(results))
        else:
            for language, artifacts in results.items():
                print(f"{language}: {len(artifacts)} artifact(s) verified")
        return 0

    if arguments.manifest is None or arguments.language is None or arguments.version is None:
        parser.error("a manifest path, --language, and --version are required (or use --all)")
    if arguments.markdown:
        parser.error("--markdown requires --all")
    if arguments.version != VERSION:
        parser.error(f"only version {VERSION} is accepted")
    try:
        artifacts = validate_manifest(arguments.manifest, language=arguments.language, version=arguments.version)
    except ManifestError as error:
        print(f"package manifest invalid: {error}", file=sys.stderr)
        return 1
    print(f"{arguments.language}: {len(artifacts)} artifact(s) verified in {arguments.manifest.parent}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
