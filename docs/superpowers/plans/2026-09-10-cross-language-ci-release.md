# Cross-Language CI, Documentation, and Release-Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume the completed shared conformance contract and seven completed SDK packages to add isolated root conformance orchestration, minimum/current compatibility CI, documentation audits, artifact-manifest validation, and a manual no-publish `0.1.0` release-readiness workflow.

**Architecture:** This plan owns no conformance schema, fixture, case, or mock-server source. Root scripts build the Go mock command delivered by `2026-09-10-shared-conformance.md`, launch one isolated process for each language invocation, parse its single readiness JSON record, and call each language's stable script with exactly four conformance variables. A checked-in compatibility matrix records the exact minimum/current runtime and framework evidence produced by the language plans. Ordinary CI fans out over all fourteen language/runtime profiles. A separately dispatched workflow calls only no-publish package scripts, validates every artifact against one release-manifest contract, and uploads workflow artifacts without signing or registry access.

**Tech Stack:** Bash, Python 3 standard library, Go toolchain for the existing mock server, GitHub Actions, JSON Schema Draft 2020-12 as release-manifest documentation.

**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`

**Shared contract consumed:** `docs/superpowers/plans/2026-09-10-shared-conformance.md`

## Global Constraints

- This is a CI/release-only consumer plan. Do not create or modify anything under `conformance/fixtures/` or `conformance/mock-ingest-server/`.
- The shared plan exclusively owns conformance schemas, per-case fixtures, the fixture DSL, mock controls/journal, and the Go mock executable.
- Languages are exactly `go`, `node`, `python`, `php`, `java`, `dotnet`, and `ruby`, in that order in root reports.
- Root conformance invokes only `<language>/scripts/conformance`; root packaging invokes only `<language>/scripts/package`.
- The shared runner contract and this final consumer plan supersede stale runner variable names, fixture filename lists, mock launch examples, and numbered package-schema references in individual language plans. This precedence changes integration wiring only; it does not authorize changing any language's approved public SDK architecture.
- Every conformance invocation supplies exactly `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_CONTROL_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and `CEKAT_CONFORMANCE_FIXTURES`. No alias, positional argument, default URL, or repository-relative fixture fallback is allowed.
- Every language runner discovers and validates every `*.json` file in the supplied cases directory and fails on any unknown schema version, applicability language/capability, properties recipe, response-body recipe, cancellation phase, operation, mock-response form, expected-result form, duplicate/unaccounted case, undeclared inapplicability, or ordinary skip. Valid schema-declared `not_applicable` is a distinct accounted outcome, never a skip.
- One mock process serves one language runner. Processes, queues, journals, readiness files, logs, and temporary directories are never shared between language invocations.
- Ordinary CI and release readiness contain no registry token, signing key, trusted-publishing permission, tag creation, release creation, or publication command.
- Release readiness is `workflow_dispatch` only and accepts no caller-selected version. The only accepted package version is `0.1.0`.
- Registry ownership, exact final coordinates, signing, credentials, tags, and publication remain manual release-owner gates.
- Compatibility entries are exact observed versions from official evidence. Strings such as `latest`, `stable`, `current`, wildcards, ranges, or projected patch versions are invalid.

## Exact File Map

```text
.github/
└── workflows/
    ├── ci.yml
    └── release-readiness.yml
ci/
├── compatibility-matrix.schema.json
├── compatibility-matrix.json
└── package-manifest.schema.json
scripts/
├── audit-docs.py
├── conformance.sh
├── package-readiness.sh
├── validate-compatibility-matrix.py
├── validate-package-manifest.py
└── tests/
    ├── test_audit_docs.py
    ├── test_conformance_contract.py
    ├── test_package_manifest.py
    └── test_validate_compatibility_matrix.py
docs/
├── sdk-contract.md
├── visitor-propagation.md
├── retry-and-error-semantics.md
├── compatibility.md
└── release-checklist.md
README.md
```

## Interfaces

### Root conformance command

```bash
scripts/conformance.sh
scripts/conformance.sh --language go
```

With no arguments it runs all seven languages in the fixed order. `--language` accepts exactly one of the seven names and exists for CI fanout. Every selected invocation performs this lifecycle:

1. Build `conformance/mock-ingest-server/cmd/mock-ingest-server` into a private temporary directory.
2. Start `mock-ingest-server --listen 127.0.0.1:0` with private stdout/stderr files and record its PID.
3. Read exactly the first newline-terminated stdout record, require compact JSON with exactly `base_url` and `control_url`, and require both to be identical loopback HTTP origins with no path/query/fragment.
4. Poll `POST <control_url>/__control/reset` until it returns `204`, with a ten-second total readiness deadline; fail if the process exits first.
5. Invoke the selected executable with no arguments and these exact values:

```bash
CEKAT_CONFORMANCE_BASE_URL="$base_url" \
CEKAT_CONFORMANCE_CONTROL_URL="$control_url" \
CEKAT_CONFORMANCE_ACCESS_TOKEN="conformance-token" \
CEKAT_CONFORMANCE_FIXTURES="$repository_root/conformance/fixtures/cases" \
"$repository_root/$language/scripts/conformance"
```

6. On success, failure, or signal, send `TERM`, wait up to six seconds for exit `0`, escalate to `KILL` only after the deadline, preserve runner/server diagnostics, and delete the private directory. Require the readiness file to contain exactly one JSON line, as promised by the shared process contract.

The command requires every selected runner to exit `0`; with no arguments, all seven runner exits must be zero. It fails if a selected runner is absent/non-executable, the cases directory is absent, readiness is malformed, reset never becomes ready, the runner is signalled/nonzero, the server leaks/exits nonzero, or cleanup fails. A runner may exit zero with schema-declared `not_applicable` records only after validating those cases and proving its language is explicitly listed; an ordinary `skipped`, `pending`, `ignored`, or `unsupported` result is a failure. Root reports preserve this distinction and summarize passed and `not_applicable` counts separately. A failure report names the language but never prints access tokens, authorization headers, fixture event identity, or request bodies.

### Compatibility matrix

`ci/compatibility-matrix.json` is a closed schema-v1 document:

```json
{
  "schema_version": 1,
  "generated_on": "2026-09-10",
  "entries": [
    {
      "language": "go",
      "profile": "minimum",
      "runner": "ubuntu-24.04",
      "runtime": "1.23.4",
      "evidence": "go/COMPATIBILITY.md",
      "frameworks": {
        "chi": "5.2.0",
        "echo": "4.13.3",
        "fiber": "3.0.0",
        "gin": "1.10.0",
        "net/http": "stdlib 1.23.4"
      }
    }
  ]
}
```

The version values above are shape examples only; execution replaces the entire example entry with values copied from then-current official evidence rather than treating the displayed numbers as selected support claims. The finished file has exactly fourteen entries: `minimum` then `current` for each of the seven languages in fixed language order. Each entry has one absolute-semver-like exact runtime string accepted by its setup action, an existing repository-relative evidence path, and all approved framework adapters for that language:

- Go: `net/http`, Gin, Echo, Fiber, Chi.
- Node.js: Express, Fastify, Koa, NestJS, Next.js.
- Python: Django, Flask, FastAPI/Starlette.
- PHP: Laravel, Symfony, and the documented PSR integration.
- Java: Spring Boot, Jakarta Servlet.
- .NET: ASP.NET Core, Azure Functions.
- Ruby: Rack, Rails.

`validate-compatibility-matrix.py` rejects aliases/ranges/placeholders, duplicate language/profile pairs, unknown/missing frameworks, unsupported runner labels, absent evidence, evidence that does not contain the selected runtime/framework version strings and dated official source URLs, or a `generated_on` date older than the latest evidence verification. `--github-matrix` writes compact `{"include":[...]}` JSON for Actions.

### Release artifact manifest

`ci/package-manifest.schema.json` documents this closed, non-conformance schema:

```text
PackageManifest {
  schema_version: 1
  language: "go" | "node" | "python" | "php" | "java" | "dotnet" | "ruby"
  version: "0.1.0"
  artifacts: non-empty array sorted by path of {
    path: non-empty slash-normalized relative path
    sha256: exactly 64 lowercase hexadecimal characters
    size_bytes: integer >= 1
  }
}
```

Paths must be unique, contain no empty, `.` or `..` component, contain no backslash/NUL, and resolve beneath the language output directory. Each artifact must be a regular file, never a symlink. The manifest lists every regular output file except `manifest.json`, and no unlisted regular file may exist. `validate-package-manifest.py <output>/manifest.json --language <language> --version 0.1.0` checks the shape, exact file set, byte sizes, and streaming SHA-256 hashes. `--all <aggregate-root>` requires exactly seven child directories named by language and validates all seven manifests.

### Root no-publish package command

```bash
scripts/package-readiness.sh --language go --output /absolute/empty/directory
scripts/package-readiness.sh --all --output /absolute/empty/directory
```

The script rejects any other arguments, relative/nonempty/symlink output paths, and creates one `<output>/<language>` directory. It invokes:

```bash
<language>/scripts/package --version 0.1.0 --output <absolute-language-output>
```

It then runs `validate-package-manifest.py` for that language. `--all` executes the seven packages serially in fixed order and finally runs aggregate validation. It never invokes a registry, signing, tag, or release command.

---

### Task 1: Define and Test the Release Artifact Manifest Contract

**Files:**
- Create: `ci/package-manifest.schema.json`
- Create: `scripts/validate-package-manifest.py`
- Create: `scripts/tests/test_package_manifest.py`

**Interfaces:**
- Consumes: the `<language>/scripts/package` manifest shape fully specified above.
- Produces: single-manifest and seven-language aggregate validation without owning any conformance artifact.

- [ ] **Step 1: Write failing validator tests**

Use `unittest.TemporaryDirectory` to construct valid files/manifests and mutation cases. Cover all seven languages, wrong schema/version/language, unknown keys, empty artifacts, unsorted/duplicate/unsafe paths, symlinks, missing/unlisted files, wrong size/hash, uppercase hash, non-file output, duplicate aggregate language, and missing aggregate language.

Run:

```bash
python3 -m unittest scripts.tests.test_package_manifest
```

Expected: FAIL because `scripts/validate-package-manifest.py` and the release schema do not exist.

- [ ] **Step 2: Implement the closed schema and standard-library validator**

Use `json.load(..., parse_constant=reject)` and reject duplicate JSON object keys with `object_pairs_hook`. Stream hashes in 1 MiB chunks. Sort paths by UTF-8 byte sequence. Do not follow symlinks while walking output. The JSON Schema is documentation and editor input; the Python validator is the executable authority and enforces every rule in the interface without a third-party schema dependency.

- [ ] **Step 3: Run green checks**

```bash
python3 -m unittest scripts.tests.test_package_manifest
python3 scripts/validate-package-manifest.py --help
git diff --check
```

Expected: all tests pass; help exits `0`; diff check prints nothing.

- [ ] **Step 4: Commit**

```bash
git add ci/package-manifest.schema.json scripts/validate-package-manifest.py scripts/tests/test_package_manifest.py
git commit -m "build: validate release artifact manifests"
```

### Task 2: Add Isolated Root Conformance Orchestration

**Files:**
- Create: `scripts/conformance.sh`
- Create: `scripts/tests/test_conformance_contract.py`

**Interfaces:**
- Consumes: the shared mock process and fixture paths plus seven language-owned conformance executables.
- Produces: the root command and isolated lifecycle defined above.

- [ ] **Step 1: Write failing contract/lifecycle tests**

The test builds the real shared mock once and creates temporary executable runner probes for all seven names. Each probe records its argument count and the names/values of the four required variables, validates that fixtures is absolute and contains case JSON files, resets/queues through the control URL, submits one ingest request through the base URL, and verifies its own isolated journal begins at sequence 1. Require all seven probes to exit `0`. Add records proving a schema-declared `not_applicable` outcome is accepted and reported separately from passes, while ordinary `skipped`/`pending`/`ignored`/`unsupported` output or undeclared inapplicability makes orchestration fail. Add failure probes for malformed readiness through an injected test-only mock executable, nonzero runner exit, server premature exit, signal cleanup, absent runner, invalid `--language`, and a runner that leaves child work running. Assert every launched PID is reaped and logs redact `conformance-token`.

Run:

```bash
python3 -m unittest scripts.tests.test_conformance_contract
```

Expected: FAIL because `scripts/conformance.sh` does not exist.

- [ ] **Step 2: Implement strict argument, readiness, and cleanup behavior**

Use Bash with `set -Eeuo pipefail`, an explicit seven-name array, `mktemp -d`, process-group-aware cleanup, and Python standard library only to parse/validate readiness JSON. Build with:

```bash
(
  cd conformance/mock-ingest-server
  go build -o "$private_dir/mock-ingest-server" ./cmd/mock-ingest-server
)
```

Use `curl --fail --silent --show-error --request POST --max-time 1` for readiness reset and inspect its status. Install `EXIT INT TERM HUP` traps before starting the process. Never use `eval`, fixed ports, `pkill`, a shared PID file, or shell parsing of JSON.

- [ ] **Step 3: Run unit and real seven-language smoke checks**

```bash
python3 -m unittest scripts.tests.test_conformance_contract
scripts/conformance.sh
```

Expected: lifecycle tests pass; after all language plans have been implemented, all seven real runners exit `0` with a fresh mock process each, passing every applicable discovered case and separately accounting for every schema-declared `not_applicable` case. An unknown fixture/applicability form, undeclared inapplicability, or ordinary skip introduced by a contract-test copy causes each selected runner to fail and print that case ID.

- [ ] **Step 4: Commit**

```bash
git add scripts/conformance.sh scripts/tests/test_conformance_contract.py
git commit -m "ci: orchestrate isolated language conformance"
```

### Task 3: Record and Validate Seven-Language Compatibility Matrices

**Files:**
- Create: `ci/compatibility-matrix.schema.json`
- Create: `ci/compatibility-matrix.json`
- Create: `scripts/validate-compatibility-matrix.py`
- Create: `scripts/tests/test_validate_compatibility_matrix.py`

**Interfaces:**
- Consumes these exact language-plan evidence files:
  - `go/COMPATIBILITY.md`
  - `node/docs/compatibility.md`
  - `python/docs/compatibility.md` and `python/docs/compatibility-evidence.json`
  - `php/docs/compatibility.md`
  - `java/compatibility.md`
  - `dotnet/COMPATIBILITY.md`
  - `ruby/COMPATIBILITY.md`
- Produces: fourteen exact runtime profiles and explicit framework compatibility evidence for ordinary CI.

- [ ] **Step 1: Re-run each language's official-source compatibility command**

Run the exact execution-time verification command named in Tasks 1 of the seven language plans. For .NET and Ruby, do not proceed until their implementation has produced the exact evidence paths above with dated official runtime/framework/package metadata. If any evidence is absent, stale, insecure, or contradicts the approved roughly-five-year maintained/LTS policy, stop release integration and correct that language plan implementation through review; do not invent a version in this plan.

Expected: seven evidence sets name exact observed minimum/current runtime versions, exact supported framework majors/versions, retrieval dates, and official source URLs.

- [ ] **Step 2: Write failing schema/semantic tests**

Test exact fourteen-entry coverage, fixed ordering, framework sets, duplicate rejection, aliases/ranges/placeholders, evidence path traversal, missing/mismatched evidence versions, stale dates, invalid runner labels, and deterministic `--github-matrix` output.

Run:

```bash
python3 -m unittest scripts.tests.test_validate_compatibility_matrix
```

Expected: FAIL because the schema, validator, and matrix do not exist.

- [ ] **Step 3: Implement the validator and create the matrix from observed evidence**

Use Python standard library only. Copy exact observed values, never examples from this plan. Use `ubuntu-24.04` unless official compatibility evidence requires another GitHub-hosted runner; any exception must be explained in that language's evidence. The schema closes every object and declares the exact language/profile/framework enums.

- [ ] **Step 4: Validate evidence and matrix output**

```bash
python3 scripts/validate-compatibility-matrix.py ci/compatibility-matrix.json
python3 scripts/validate-compatibility-matrix.py ci/compatibility-matrix.json --github-matrix > /tmp/cekat-sdk-matrix.json
python3 - <<'PY'
import json
m = json.load(open('/tmp/cekat-sdk-matrix.json'))
assert len(m['include']) == 14
assert {(e['language'], e['profile']) for e in m['include']} == {
    (language, profile)
    for language in ('go','node','python','php','java','dotnet','ruby')
    for profile in ('minimum','current')
}
PY
git diff --check
```

Expected: all commands exit `0`; no aliases or missing evidence are reported.

- [ ] **Step 5: Commit**

```bash
git add ci/compatibility-matrix.schema.json ci/compatibility-matrix.json scripts/validate-compatibility-matrix.py scripts/tests/test_validate_compatibility_matrix.py
git commit -m "ci: record verified SDK compatibility matrices"
```

### Task 4: Add Contract, Visitor, Retry, and Compatibility Documentation Audits

**Files:**
- Create: `docs/sdk-contract.md`
- Create: `docs/visitor-propagation.md`
- Create: `docs/retry-and-error-semantics.md`
- Create: `docs/compatibility.md`
- Create: `docs/release-checklist.md`
- Modify: `README.md`
- Create: `scripts/audit-docs.py`
- Create: `scripts/tests/test_audit_docs.py`

**Interfaces:**
- Consumes: approved design, shared contract, compatibility matrix, and the seven language READMEs.
- Produces: discoverable user contract documentation and a deterministic audit.

- [ ] **Step 1: Write failing documentation-audit tests**

Fixture tests must prove the audit rejects broken/absolute/missing repository links, unfinished planning markers, vague cross-plan references, production tokens, publication claims, omitted languages/frameworks, wrong endpoint/header/cookie, acknowledgement durability claims, missing retry duplication warning, undocumented compatibility entries, and any supported framework major in a language README that is absent from the matrix evidence.

Run:

```bash
python3 -m unittest scripts.tests.test_audit_docs
```

Expected: FAIL because the audit and root contract documents do not exist.

- [ ] **Step 2: Write the root documents without duplicating the fixture DSL**

`README.md` links the five root documents, shared conformance guide, and all seven language READMEs. `sdk-contract.md` states token-only initialization, fixed production origin/path/auth, event fields/five operations, identity validation, acknowledgement limits, and six error categories. `visitor-propagation.md` states exact cookie/header names, both precedence rules, trust boundary, generic/framework lifecycle, cleanup, and asynchronous identity-only behavior. `retry-and-error-semantics.md` states timeout/retry/jitter values, only transport/eligible timeout/500 retry eligibility, cancellation, duplicate risk, 65,536-byte retention, outcome certainty, and structured/malformed response behavior. `compatibility.md` is generated from the validated matrix and links each evidence file while naming supported framework majors. `release-checklist.md` names every manual gate and explicitly prohibits publishing from either workflow.

Do not restate individual fixture case bodies or create a second schema description; link `conformance/README.md` and `conformance/fixtures/schemas/conformance-case.schema.json` by exact path.

- [ ] **Step 3: Implement the audit**

The standard-library script checks the exact root and language document set, Markdown links, required literal contract terms, matrix/evidence consistency, forbidden placeholders, token-like text, and publication language. It scans planning references only in the three integration plans changed by this planning task when validating plan links, avoiding false failures from language plans that this task is not authorized to edit.

- [ ] **Step 4: Run audits**

```bash
python3 -m unittest scripts.tests.test_audit_docs
python3 scripts/audit-docs.py
python3 scripts/validate-compatibility-matrix.py ci/compatibility-matrix.json
python3 - <<'PY'
from pathlib import Path
paths = [
    Path('README.md'), Path('docs/sdk-contract.md'), Path('docs/visitor-propagation.md'),
    Path('docs/retry-and-error-semantics.md'), Path('docs/compatibility.md'),
    Path('docs/release-checklist.md'),
    Path('docs/superpowers/plans/2026-09-10-cross-language-ci-release.md'),
    Path('docs/superpowers/plans/2026-09-10-shared-conformance.md'),
    Path('docs/superpowers/plans/2026-09-10-multilanguage-event-sdk-index.md'),
]
for path in paths:
    text = path.read_text()
    assert not any(marker in text for marker in ('TO' + 'DO', 'T' + 'BD', 'FIX' + 'ME'))
PY
git diff --check
```

Expected: tests and audits pass; the marker check and diff check print nothing.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/sdk-contract.md docs/visitor-propagation.md \
  docs/retry-and-error-semantics.md docs/compatibility.md docs/release-checklist.md \
  scripts/audit-docs.py scripts/tests/test_audit_docs.py
git commit -m "docs: publish cross-language SDK contract guidance"
```

### Task 5: Add the Fourteen-Profile Ordinary CI Workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: compatibility matrix, root validators/audit, shared mock tests, and root conformance command.
- Produces: pull-request/push validation with minimum/current profiles for all seven languages.

- [ ] **Step 1: Add a failing workflow contract test**

Extend `scripts/tests/test_conformance_contract.py` to parse workflow text and require: only `pull_request` and branch `push` triggers; read-only contents permission; a matrix generated by `validate-compatibility-matrix.py`; seven conditional runtime setup steps; `scripts/conformance.sh --language`; contract/server test jobs; no `workflow_dispatch`, secrets context, publication/signing command, package command, fixed mock port, or direct language conformance invocation.

Run:

```bash
python3 -m unittest scripts.tests.test_conformance_contract
```

Expected: FAIL because `.github/workflows/ci.yml` does not exist.

- [ ] **Step 2: Implement contract and matrix jobs**

Create:

1. `contract`: Python unit tests, both validators, docs audit, `git diff --check`, then from `conformance/mock-ingest-server` run `go test -race ./... -count=1` and `go vet ./...`.
2. `matrix`: a small job validates the checked-in matrix and writes `--github-matrix` to `$GITHUB_OUTPUT`.
3. `language-conformance`: `needs: [contract, matrix]`, `strategy.fail-fast: false`, and `matrix: fromJSON(needs.matrix.outputs.matrix)`. Conditionally configure exact runtime values with the ecosystem setup action: Go, Node, Python, PHP, Java, .NET, or Ruby. Run `scripts/conformance.sh --language "${{ matrix.language }}"`, require exit `0` for every invocation across the fourteen jobs, and retain separate pass/`not_applicable` reporting; ordinary skips fail the job.

During execution, resolve each setup action's maintained release to a reviewed full commit SHA, record that source/retrieval date in the workflow review notes, and write the SHA directly in `uses:`. Do not leave action tags, branch names, or placeholder SHAs. Cache keys include language, exact runtime, profile, and the ecosystem lockfile hash; no cache contains package output or mock state.

- [ ] **Step 3: Validate workflow locally**

```bash
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
python3 scripts/audit-docs.py
python3 scripts/validate-compatibility-matrix.py ci/compatibility-matrix.json --github-matrix >/dev/null
python3 - <<'PY'
from pathlib import Path
p = Path('.github/workflows/ci.yml').read_text()
for language in ('go','node','python','php','java','dotnet','ruby'):
    assert f"matrix.language == '{language}'" in p
assert 'scripts/conformance.sh --language' in p
PY
git diff --check
```

Expected: all checks pass and the workflow exposes fourteen matrix jobs from the validated JSON.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml scripts/tests/test_conformance_contract.py
git commit -m "ci: test minimum and current SDK runtimes"
```

### Task 6: Add Root Package Readiness and Manual No-Publish Workflow

**Files:**
- Create: `scripts/package-readiness.sh`
- Modify: `scripts/tests/test_package_manifest.py`
- Create: `.github/workflows/release-readiness.yml`
- Modify: `docs/release-checklist.md`

**Interfaces:**
- Consumes: seven language package scripts, current runtime profiles, and release artifact validator.
- Produces: local/CI no-publish artifact preparation and review evidence only.

- [ ] **Step 1: Write failing wrapper/workflow contract tests**

Test strict CLI parsing, exact fixed version, absolute empty output, one/all language modes, fixed order, package failure propagation, manifest validation, aggregate completeness, path-with-spaces behavior, signal cleanup, and refusal to reuse a nonempty directory. Parse the workflow and require only `workflow_dispatch`, read-only permissions, a seven-language `current`-profile matrix, package artifact upload, aggregate validation, and no registry/signing/tag/release command or secrets context.

Run:

```bash
python3 -m unittest scripts.tests.test_package_manifest
```

Expected: FAIL because the wrapper and workflow do not exist.

- [ ] **Step 2: Implement the wrapper**

Use Bash `set -Eeuo pipefail`, the fixed language array, `realpath`/Python path validation without following a final symlink, and private temporary directories. Invoke only each language's package interface with exact flags. Validate immediately; on failure retain a path to local diagnostics but remove partial artifacts in CI. Never infer or rewrite a language manifest.

- [ ] **Step 3: Implement manual release readiness**

The workflow has no `push`, `pull_request`, `schedule`, `release`, or `workflow_call` trigger. Jobs:

1. `preflight`: rerun all official-source compatibility gates named by the seven language plans, validate/update review evidence through a normal reviewed change rather than mutating the checkout, run unit tests/audits/shared mock tests, and emit the seven current matrix entries.
2. `package`: seven-way fail-fast-false matrix; configure the exact current runtime and run `scripts/package-readiness.sh --language "$language" --output "$RUNNER_TEMP/cekat-artifacts"`; upload only the validated `<language>` directory as `cekat-event-sdk-0.1.0-<language>` with a finite retention period.
3. `aggregate`: download all seven workflow artifacts into fixed language directories, run `scripts/validate-package-manifest.py --all`, rerun the no-publish/static workflow audit, and write a Markdown job summary containing language, version, paths, sizes, and hashes.
4. `manual-gates`: print (without satisfying) checklist items for registry ownership/coordinates, legal/license review, changelog approval, signing by release owner, credentials/trusted publishing, tags, and publication. This job creates no environment deployment and requests no approval secret.

Pin setup/upload/download actions to reviewed full commit SHAs exactly as in ordinary CI. Artifact upload is workflow storage, not registry publication.

- [ ] **Step 4: Run local manual-readiness validation**

```bash
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
python3 scripts/audit-docs.py
out="$(mktemp -d)"
rmdir "$out"
scripts/package-readiness.sh --all --output "$out"
python3 scripts/validate-package-manifest.py --all "$out"
! grep -Ein '(npm publish|gem push|dotnet nuget push|twine upload|composer.*publish|mvn.*deploy|go.*publish|cosign|gpg|gh release|git tag)' \
  .github/workflows/ci.yml .github/workflows/release-readiness.yml scripts/package-readiness.sh
```

Expected: all seven package scripts build local `0.1.0` artifacts; every manifest/file/hash validates; forbidden-command grep prints nothing; no signing, tag, credential, registry, or publication operation occurs.

- [ ] **Step 5: Commit**

```bash
git add scripts/package-readiness.sh scripts/tests/test_package_manifest.py \
  .github/workflows/release-readiness.yml docs/release-checklist.md
git commit -m "build: add manual no-publish release readiness"
```

### Task 7: Final Integration, Compatibility Recheck, and Review Gate

**Files:**
- Modify only when official evidence changed: `ci/compatibility-matrix.json`, `docs/compatibility.md`, and the corresponding language evidence file.
- No conformance fixture, schema, case, or mock source changes are permitted.

**Interfaces:**
- Consumes: every deliverable from the shared, language, and this plan.
- Produces: review evidence; no publication and no automatic commit.

- [ ] **Step 1: Re-run official-source evidence immediately before readiness approval**

Run every language's documented release-time compatibility command and `conformance/COMPATIBILITY.md` release gate. Compare exact observed runtime, framework, package-manager, transport, and setup-action data to the checked-in evidence/matrix. If support or security status changed, stop, update the affected language through review, regenerate the matrix/docs, and run ordinary CI again. Do not silently change a runtime in the readiness run.

- [ ] **Step 2: Run all contract and orchestration checks**

```bash
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
python3 scripts/validate-compatibility-matrix.py ci/compatibility-matrix.json
python3 scripts/audit-docs.py
(
  cd conformance/mock-ingest-server
  go mod tidy
  git diff --exit-code -- go.mod go.sum
  go test -race ./... -count=1
  go vet ./...
)
scripts/conformance.sh
git diff --check
```

Expected: all commands pass; all seven conformance runners exit `0`, each reports every discovered case as either passed or schema-declared `not_applicable`, ordinary skips are absent, and each uses a distinct loopback origin/process.

- [ ] **Step 3: Build and independently validate all local artifacts**

```bash
output="$(mktemp -d)"
rmdir "$output"
scripts/package-readiness.sh --all --output "$output"
python3 scripts/validate-package-manifest.py --all "$output"
python3 - "$output" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for language in ('go','node','python','php','java','dotnet','ruby'):
    manifest = json.loads((root/language/'manifest.json').read_text())
    assert manifest['language'] == language
    assert manifest['version'] == '0.1.0'
    for item in manifest['artifacts']:
        data = (root/language/item['path']).read_bytes()
        assert len(data) == item['size_bytes']
        assert hashlib.sha256(data).hexdigest() == item['sha256']
PY
```

Expected: seven manifests and every declared artifact independently match exact sizes/hashes; no registry mutation occurs.

- [ ] **Step 4: Audit ownership, publication boundaries, and repository state**

```bash
python3 scripts/audit-docs.py
! git grep -nE '(npm publish|gem push|dotnet nuget push|twine upload|mvn[^\n]*deploy|gh release|git tag)' -- \
  .github scripts ':!scripts/tests/*'
git status --short
git diff --check
```

Expected: publication search and diff check print nothing. Status contains only intentionally uncommitted review evidence; no generated package artifact is inside the repository and no file is staged.

- [ ] **Step 5: Independent review and manual readiness record**

A reviewer verifies: shared ownership was not duplicated; exact four-variable invocation; unknown/undeclared-inapplicable/ordinary-skip failure; schema-declared `not_applicable` reporting distinct from skips; zero exit from all seven runners; isolated mock lifecycle/readiness JSON; fourteen compatibility profiles and framework evidence; endpoint/auth/envelope/retry/visitor/error documentation; manifest exact-file/hash validation; workflow permissions/triggers/action pins; and absence of signing/publication. The release owner then records unresolved registry coordinate/ownership and signing decisions outside automation. A passing workflow means only “artifacts are ready for manual release review,” never “published” or “approved for publication.”

- [ ] **Step 6: Commit only reviewed evidence changes**

If Step 1 legitimately changed evidence after language-owner review:

```bash
git add ci/compatibility-matrix.json docs/compatibility.md \
  go/COMPATIBILITY.md node/docs/compatibility.md python/docs/compatibility.md \
  python/docs/compatibility-evidence.json php/docs/compatibility.md \
  java/compatibility.md dotnet/COMPATIBILITY.md ruby/COMPATIBILITY.md
git commit -m "docs: refresh verified release compatibility evidence"
```

Expected: stage only files that actually changed; omit absent/unchanged paths from `git add`; do not create an empty commit.

## Final Acceptance Checklist

- [ ] No file under `conformance/fixtures/` or `conformance/mock-ingest-server/` is created or modified by this plan.
- [ ] Root and all seven language runners use exactly the four named conformance variables and no aliases/defaults.
- [ ] Every runner discovers all case JSON files, rejects unknown schema/applicability values and undeclared inapplicability, passes each applicable case, reports valid `not_applicable` separately, and rejects ordinary skips.
- [ ] Root orchestration parses readiness JSON, proves control readiness, starts one isolated mock per language, reaps it on every exit path, and requires all seven runners to exit `0`.
- [ ] Ordinary CI covers minimum/current profiles for all seven languages from dated official compatibility evidence.
- [ ] Root docs and all language docs pass endpoint, visitor, retry/error, compatibility, link, and placeholder audits.
- [ ] Every `0.1.0` package manifest is closed, complete, traversal-free, sorted, and independently size/hash validated.
- [ ] Release readiness can run only manually and performs no signing, tagging, credential use, registry publication, or release creation.
- [ ] Registry ownership, exact final coordinates, signing, and publication remain explicit manual gates.
