# cekat-event-sdk

Backend SDKs that submit Cekat events and correlate them with the browser visitor. Implemented: [Go](go/README.md), [Node.js](node/README.md), [PHP](php/README.md), [Ruby](ruby/README.md), and [Java](java/README.md).

## Shared conformance

Every SDK runs the same language-neutral fixtures (`conformance/fixtures/cases`) against a real HTTP mock of the ingest API (`conformance/mock-ingest-server`). See [conformance/README.md](conformance/README.md) for the contract.

```sh
scripts/conformance.sh                    # every language that has a runner
scripts/conformance.sh --language php     # one language
```

For each language, the script builds the Go mock server (or uses `MOCK_INGEST_SERVER_BIN`), starts a private instance on a random loopback port, waits for its readiness record and control API, runs `<language>/scripts/conformance` with exactly the four `CEKAT_CONFORMANCE_*` variables, and stops the server. It requires Go, `python3`, `curl`, and each language's own toolchain.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: the conformance contract and mock server tests, then minimum and current runtime profiles for each SDK (unit, integration, and shared conformance). The `CI required` job succeeds only when every other job succeeds, so it is the single check to require in branch protection.
