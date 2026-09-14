# cekat-event-sdk

Backend SDKs that submit Cekat events and correlate them with the browser visitor. Implemented: [Go](go/README.md), [Node.js and Bun](node/README.md), [Python](python/README.md), [PHP](php/README.md), [Ruby](ruby/README.md), [Java](java/README.md), and [.NET](dotnet/README.md).

## Shared conformance

Every SDK runs the same language-neutral fixtures (`conformance/fixtures/cases`) against a real HTTP mock of the ingest API (`conformance/mock-ingest-server`). See [conformance/README.md](conformance/README.md) for the contract.

```sh
scripts/conformance.sh                    # every language that has a runner
scripts/conformance.sh --language php     # one language
```

For each language, the script builds the Go mock server (or uses `MOCK_INGEST_SERVER_BIN`), starts a private instance on a random loopback port, waits for its readiness record and control API, runs `<language>/scripts/conformance` with exactly the four `CEKAT_CONFORMANCE_*` variables, and stops the server. It requires Go, `python3`, `curl`, and each language's own toolchain.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: the conformance contract and mock server tests, then minimum and current runtime profiles for each SDK (unit, integration, and shared conformance). The `CI required` job succeeds only when every other job succeeds, so it is the single check to require in branch protection.

## Release readiness

Nothing in this repository publishes packages. Before a release, run the **Release readiness** workflow (`.github/workflows/release-readiness.yml`, manual trigger only). It builds every SDK with its own `scripts/package` on the current toolchain, validates each `manifest.json` and the complete seven-language set, and keeps the artifacts as workflow artifacts for 14 days, with a summary table of file names, sizes, and SHA-256 hashes. Registry setup, signing, tags, and publication remain manual release-owner steps; the workflow lists them without performing them.

Locally (each language's toolchain must be installed):

```sh
scripts/package-readiness.sh --language node --output /absolute/empty/dir   # one language, into <dir>/node
scripts/package-readiness.sh --all --output /absolute/empty/dir             # all seven, then aggregate validation
python3 scripts/validate-package-manifest.py --all /absolute/empty/dir       # re-check an existing set
python3 -m unittest discover -s scripts/tests -p 'test_*.py'                # root script tests
```

`ci/package-manifest.schema.json` documents the manifest format; `scripts/validate-package-manifest.py` enforces it, including the exact file set, sizes, and hashes.
