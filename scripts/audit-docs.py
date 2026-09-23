#!/usr/bin/env python3
"""Audit the repository's user-facing documentation.

    scripts/audit-docs.py                          # audit (runs in CI)
    scripts/audit-docs.py --write-compatibility    # regenerate docs/compatibility.md from ci/compatibility-matrix.json

It checks the root README, the five root documents, the conformance guide, and the seven language READMEs:

- the document set exists and the root README links every document;
- relative Markdown links (and their #anchors) resolve, and no absolute local paths appear;
- no unfinished markers, token-like secrets, publication commands, or claims that packages are published;
- the fixed protocol names are spelled exactly (production origin, ingest path, visitor header and cookie);
- no positive claims of durable storage, guaranteed delivery, or exactly-once processing, and no stale
  defaults (a 10-second timeout, retrying only HTTP 500);
- each root document states its required contract terms, and each language README states the shared ones;
- each language README names its runtime floor and every framework in the compatibility matrix;
- docs/compatibility.md is exactly what the matrix generates.

Standard library only.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LANGUAGES = ("go", "node", "python", "php", "java", "dotnet", "ruby")
LANGUAGE_NAMES = {"go": "Go", "node": "Node.js and Bun", "python": "Python", "php": "PHP", "java": "Java", "dotnet": ".NET", "ruby": "Ruby"}
ROOT_DOCUMENTS = (
    "docs/sdk-contract.md",
    "docs/visitor-propagation.md",
    "docs/retry-and-error-semantics.md",
    "docs/compatibility.md",
    "docs/release-checklist.md",
)
LANGUAGE_READMES = tuple(f"{language}/README.md" for language in LANGUAGES)
CONFORMANCE_GUIDE = "conformance/README.md"
AUDITED = ("README.md", *ROOT_DOCUMENTS, CONFORMANCE_GUIDE, *LANGUAGE_READMES)

REQUIRED_TERMS = {
    "docs/sdk-contract.md": [
        "https://t.cekat.ai", "/api/events/ingest", "Authorization: Bearer", "business_id", "User-Agent: cekat-event-sdk-",
        "user_registration", "user_login", "order_created", "order_paid", "is_common", "event_id", "occurred_at",
        "asynchronous processing", "ValidationError", "AuthenticationError", "EventDefinitionNotFoundError",
        "ApiError", "TransportError", "ResponseDecodeError", "conformance/README.md",
        "conformance/fixtures/schemas/conformance-case.schema.json",
    ],
    "docs/visitor-propagation.md": ["X-Cekat-Visitor-ID", "_cekat_visitor_id", "untrusted", "precedence", "finally"],
    "docs/retry-and-error-semantics.md": [
        "3 seconds", "429", "500", "502", "503", "504", "Retry-After", "5 seconds", "65,536", "duplicate", "event_id",
        "full jitter", "cancel",
    ],
    "docs/release-checklist.md": ["release-readiness.yml", "manifest", "signing", "registry", "never publishes"],
}
LANGUAGE_README_TERMS = ["X-Cekat-Visitor-ID", "_cekat_visitor_id", "asynchronous processing", "untrusted", "duplicate", "Retry-After", "429", "event_id"]

FORBIDDEN = [
    (re.compile(r"\b(?:TODO|TBD|FIXME)\b"), "unfinished marker"),
    (re.compile(r"(?:/Users/|/home/[a-z]|[A-Z]:\\\\|file://)"), "absolute local path"),
    (re.compile(r"\b(?:sk_live_[0-9A-Za-z]{8,}|ghp_[0-9A-Za-z]{20,}|xox[bp]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})"), "token-like secret"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key"),
    (re.compile(r"Bearer\s+(?!<)[A-Za-z0-9._~+/-]{24,}"), "token-like bearer credential"),
    (re.compile(r"\b(?:npm publish|twine upload|gem push|nuget push|mvnw? deploy|composer publish|gh release create|git push --tags)\b"), "publication command"),
    (re.compile(r"\b(?:is|are|has been|have been|is now|are now)\s+(?:published|available)\s+(?:on|to|in)\s+(?:npm|PyPI|Packagist|RubyGems|Maven Central|NuGet|the registry)", re.IGNORECASE), "publication claim"),
    (re.compile(r"http://t\.cekat\.ai"), "insecure production origin"),
    (re.compile(r"/api/events/(?!ingest\b)[A-Za-z]"), "wrong ingest path"),
    (re.compile(r"(?<![_A-Za-z0-9])cekat_visitor_id"), "visitor cookie without its leading underscore"),
    (re.compile(r"\bonly (?:HTTP )?`?500`?\b", re.IGNORECASE), "stale retry claim (only HTTP 500)"),
]
CEKAT_HOST = re.compile(r"\b([a-z0-9.-]*cekat\.ai)\b")
ALLOWED_HOSTS = {"t.cekat.ai", "schemas.cekat.ai", "golang.cekat.ai"}
HEADER = re.compile(r"x-cekat-visitor-id", re.IGNORECASE)
POSITIVE_CLAIMS = re.compile(
    r"\bdurabl[ey]\s+(?:stored|persisted|saved|storage|persistence|delivery)\b"
    r"|\bguarantee[sd]?\s+(?:delivery|persistence|storage|deduplication|that\s+(?:the\s+)?events?)\b"
    r"|\bexactly[- ]once\s+(?:delivery|processing|semantics)\b"
    r"|\b(?:delivered|processed|ingested|stored)\s+exactly[- ]once\b",
    re.IGNORECASE,
)
NEGATION = re.compile(r"\b(?:not|never|no|without|cannot|isn't|doesn't|don't|nor)\b", re.IGNORECASE)
STALE_TIMEOUT = re.compile(r"\btimeout\b[^.]*?\b10\s*(?:s|seconds?)\b|\b10\s*(?:s|seconds?)\b[^.]*?\btimeout\b", re.IGNORECASE)
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


@dataclass(frozen=True)
class Problem:
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.message}"


def _load_matrix_module():
    spec = importlib.util.spec_from_file_location("validate_compatibility_matrix", ROOT / "scripts" / "validate-compatibility-matrix.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(spec.name, module)
    spec.loader.exec_module(module)
    return module


def strip_code(text: str) -> str:
    """Blank fenced code blocks and inline code so prose heuristics ignore examples; keep line numbers."""
    result = []
    in_fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            result.append("")
            continue
        result.append("" if in_fence else re.sub(r"`[^`]*`", "`code`", line))
    return "\n".join(result)


def github_anchor(heading: str) -> str:
    text = re.sub(r"`([^`]*)`", r"\1", heading.strip()).lower()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s", "-", text)


def anchors(text: str) -> set[str]:
    found: dict[str, int] = {}
    result = set()
    in_fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        match = re.match(r"^#{1,6}\s+(.+?)\s*#*\s*$", line)
        if match and not in_fence:
            slug = github_anchor(match.group(1))
            count = found.get(slug, 0)
            result.add(slug if count == 0 else f"{slug}-{count}")
            found[slug] = count + 1
    return result


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def audit_text(path: str, text: str, root: Path) -> list[Problem]:
    problems: list[Problem] = []
    prose = strip_code(text)

    for pattern, label in FORBIDDEN:
        source = text if label in {"unfinished marker", "absolute local path", "token-like secret", "private key", "token-like bearer credential", "publication command", "insecure production origin", "wrong ingest path", "visitor cookie without its leading underscore"} else prose
        for match in pattern.finditer(source):
            problems.append(Problem(path, line_of(source, match.start()), f"{label}: {match.group(0)!r}"))

    for match in CEKAT_HOST.finditer(text):
        if match.group(1) not in ALLOWED_HOSTS:
            problems.append(Problem(path, line_of(text, match.start()), f"unknown Cekat host {match.group(1)!r}; the production origin is https://t.cekat.ai"))

    for match in HEADER.finditer(text):
        if match.group(0) not in {"X-Cekat-Visitor-ID", "x-cekat-visitor-id"}:
            problems.append(Problem(path, line_of(text, match.start()), f"visitor header spelled {match.group(0)!r}; use X-Cekat-Visitor-ID"))

    for sentence_match in re.finditer(r"[^.!?\n]+(?:[.!?]|$)", prose, re.MULTILINE):
        sentence = sentence_match.group(0)
        if POSITIVE_CLAIMS.search(sentence) and not NEGATION.search(sentence):
            problems.append(Problem(path, line_of(prose, sentence_match.start()), f"claims durability, guaranteed delivery, or exactly-once processing: {sentence.strip()[:100]!r}"))
        if STALE_TIMEOUT.search(sentence):
            problems.append(Problem(path, line_of(prose, sentence_match.start()), f"stale 10-second timeout: {sentence.strip()[:100]!r}"))

    base = (root / path).parent
    for match in LINK.finditer(prose):
        target = match.group(1)
        if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.IGNORECASE):
            continue
        file_part, _, anchor = target.partition("#")
        line = line_of(prose, match.start())
        if file_part.startswith("/"):
            problems.append(Problem(path, line, f"absolute link {target!r}; use a relative repository link"))
            continue
        destination = (base / file_part).resolve() if file_part else (root / path).resolve()
        if not destination.exists():
            problems.append(Problem(path, line, f"broken link {target!r}"))
            continue
        try:
            destination.relative_to(root.resolve())
        except ValueError:
            problems.append(Problem(path, line, f"link leaves the repository: {target!r}"))
            continue
        if anchor and destination.suffix == ".md" and anchor not in anchors(destination.read_text(encoding="utf-8")):
            problems.append(Problem(path, line, f"link {target!r} points to a missing heading"))
    return problems


def require_terms(path: str, text: str, terms: list[str]) -> list[Problem]:
    return [Problem(path, 1, f"missing required term {term!r}") for term in terms if term not in text]


def runtime_token(declared: str) -> str:
    """The version a README must name for a declared floor: net8.0 stays whole; 22.12.0 becomes 22.12."""
    if declared.startswith("net"):
        return declared
    match = re.search(r"\d+(?:\.\d+)*", declared)
    if not match:
        return declared
    version = match.group(0)
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) == 3 and parts[2] == "0" else version


def render_compatibility(matrix: dict) -> str:
    lines = [
        "# SDK compatibility",
        "",
        "<!-- Generated from ci/compatibility-matrix.json by scripts/audit-docs.py --write-compatibility. Do not edit by hand. -->",
        "",
        f"Verified on {matrix['verified_on']}. Each SDK's evidence document records the official sources, exact observed versions, and test results; "
        "[`ci/compatibility-matrix.json`](../ci/compatibility-matrix.json) is checked against package metadata, CI, and that evidence by "
        "[`scripts/validate-compatibility-matrix.py`](../scripts/validate-compatibility-matrix.py).",
        "",
        "| SDK | Runtime floor | Tested in CI (minimum → current) | Evidence |",
        "| --- | --- | --- | --- |",
    ]
    for entry in matrix["languages"]:
        language = entry["language"]
        floors = "; ".join(f"{runtime['name']} `{runtime['declared']}`" for runtime in entry["runtimes"])
        minimum, current = entry["profiles"]
        lines.append(f"| [{LANGUAGE_NAMES[language]}](../{language}/README.md) | {floors} | {minimum['observed']} → {current['observed']} | [{entry['evidence'].split('/')[-1]}](../{entry['evidence']}) |")
    for entry in matrix["languages"]:
        language = entry["language"]
        lines += ["", f"## {LANGUAGE_NAMES[language]}", "", "| Framework or integration | Supported | Tested versions |", "| --- | --- | --- |"]
        for framework in entry["frameworks"]:
            tested = ", ".join(framework["tested"]) if framework["tested"] else "—"
            lines.append(f"| {framework['name']} | {framework['supported']} | {tested} |")
        ci_rows = "; ".join(f"`{ci['job']}` job `{ci['key']}`: {', '.join(ci['values'])}" for ci in entry["ci"])
        lines += ["", f"CI: {ci_rows}. Release readiness installs `{entry['release_readiness']['key']}` {entry['release_readiness']['value']}."]
        if entry["end_of_support"]:
            ends = "; ".join(f"{line['component']} {line['line']} on {line['date']}" for line in entry["end_of_support"])
            lines += ["", f"Upcoming end of support: {ends}."]
    lines += [
        "",
        "## Keeping this current",
        "",
        "When a runtime floor, CI row, or framework range changes, update the package metadata, the CI workflow, the language's evidence document, and "
        "`ci/compatibility-matrix.json` together, then regenerate this page with `python3 scripts/audit-docs.py --write-compatibility`. The release "
        "readiness preflight fails when a listed line has reached end of support or the matrix was verified more than 30 days earlier.",
        "",
    ]
    return "\n".join(lines)


def audit(root: Path = ROOT) -> list[Problem]:
    problems: list[Problem] = []
    texts: dict[str, str] = {}
    for path in AUDITED:
        file = root / path
        if not file.is_file():
            problems.append(Problem(path, 1, "required document is missing"))
            continue
        texts[path] = file.read_text(encoding="utf-8")
        problems += audit_text(path, texts[path], root)

    readme = texts.get("README.md", "")
    for target in (*ROOT_DOCUMENTS, CONFORMANCE_GUIDE, *LANGUAGE_READMES):
        if f"]({target})" not in readme and f"]({target}#" not in readme:
            problems.append(Problem("README.md", 1, f"does not link {target}"))

    for path, terms in REQUIRED_TERMS.items():
        if path in texts:
            problems += require_terms(path, texts[path], terms)
    for path in LANGUAGE_READMES:
        if path in texts:
            problems += require_terms(path, texts[path], LANGUAGE_README_TERMS)

    matrix_module = _load_matrix_module()
    try:
        matrix, _ = matrix_module.validate(root / "ci" / "compatibility-matrix.json", root)
    except matrix_module.MatrixError as error:
        return problems + [Problem("ci/compatibility-matrix.json", 1, f"invalid: {error}")]
    for entry in matrix["languages"]:
        path = f"{entry['language']}/README.md"
        if path not in texts:
            continue
        for runtime in entry["runtimes"]:
            token = runtime_token(runtime["declared"])
            if token not in texts[path]:
                problems.append(Problem(path, 1, f"does not name the {runtime['name']} floor {token!r} from the compatibility matrix"))
        for framework in entry["frameworks"]:
            for name in (part.strip() for part in framework["name"].split(",")):
                if name not in texts[path]:
                    problems.append(Problem(path, 1, f"does not mention {name!r}, which the compatibility matrix lists"))

    expected = render_compatibility(matrix)
    if "docs/compatibility.md" in texts and texts["docs/compatibility.md"] != expected:
        problems.append(Problem("docs/compatibility.md", 1, "is out of date with ci/compatibility-matrix.json; run scripts/audit-docs.py --write-compatibility"))
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write-compatibility", action="store_true", help="regenerate docs/compatibility.md from the compatibility matrix")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    arguments = parser.parse_args(argv)
    if arguments.write_compatibility:
        matrix_module = _load_matrix_module()
        try:
            matrix, _ = matrix_module.validate(arguments.root / "ci" / "compatibility-matrix.json", arguments.root)
        except matrix_module.MatrixError as error:
            print(f"compatibility matrix invalid: {error}", file=sys.stderr)
            return 1
        (arguments.root / "docs" / "compatibility.md").write_text(render_compatibility(matrix), encoding="utf-8")
        print("wrote docs/compatibility.md")
        return 0
    problems = audit(arguments.root)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(f"documentation audit failed: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    print(f"documentation audit passed: {len(AUDITED)} documents")
    return 0


if __name__ == "__main__":
    sys.exit(main())
