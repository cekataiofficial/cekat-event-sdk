# Task 12 Repair Report

## Scope

Resolved every P1/P2 item from `task-12-review.md` without changing the release readiness decision.

- Archive selection is now a conservative allowlist: Go source (`.go`), module metadata (`go.mod`, `go.sum`), root documentation (`README.md`, `COMPATIBILITY.md`), and the two local scripts. The pre-existing credential deny rules remain as defense in depth.
- Archive tests cover `.netrc`, `.npmrc`, `.pypirc`, `id_rsa`, `.pem` and `.key` private-key names, a service-account file, and `auth.json`. A Git-tracked source symlink is rejected before archive creation.
- Public `scripts/package` subprocess tests reject no/missing/reordered/extra/wrong arguments plus relative/traversal, nonempty, and symlink output directories; static inspection confirms the wrapper runs tests/vet/packageprep and contains no publishing, signing, registry, tag, or push operation.
- README now explicitly supports Gin v1, Echo v4, Fiber v3, Chi v5, and standard `net/http`.
- Applied the complete `go mod tidy` result. It moves Chi v5 and Fiber v3 into the direct requirement block because module packages import them, and moves `fasthttp` direct because the Fiber adapter test imports it. The newly recorded checksums are required by the resolved dependency test graph. No selected or resolved dependency version changed.

## Commands and results

```text
$ cd go && gofmt -w internal/packageprep/main.go internal/packageprep/main_test.go
$ go test ./internal/packageprep -count=1
PASS

$ go mod tidy
$ git diff --exit-code -- go.mod go.sum
PASS (after committing the tidy result, this is clean)

$ go vet ./...
PASS

$ go test ./...
PASS

$ go test -race ./...
PASS

$ go test -shuffle=on -count=20 ./...
PASS

$ cd conformance/mock-ingest-server && go build -o /tmp/cekat-mock ./cmd/mock-ingest-server
$ CEKAT_CONFORMANCE_BASE_URL=... CEKAT_CONFORMANCE_CONTROL_URL=... \
  CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
  CEKAT_CONFORMANCE_FIXTURES="$PWD/conformance/fixtures/cases" \
  go/scripts/conformance
PASS (all 49 fixtures)

$ cd go && go list ./... | xargs -n1 go doc
PASS (9 packages documented)

$ out=$(mktemp -d); go/scripts/package --version 0.1.0 --output "$out"
PASS

$ python3 manifest validation
PASS (schema 1, Go 0.1.0, sorted artifact path, exact size, lowercase SHA-256)
```

The package wrapper ran its nested `go test ./...` and `go vet ./...` before producing the archive. Archive inspection showed only allowlisted source/documentation/module/script paths.

## Compatibility and release decision

`COMPATIBILITY.md` now accurately records the applied, clean tidy result and directness rationale. The existing release-readiness **BLOCKED** decision is unchanged: the documented Go 1.26.5 runtime vulnerabilities and `quic-go` v0.59.0 vulnerability still require release-owner remediation. No dependency upgrades were performed.
