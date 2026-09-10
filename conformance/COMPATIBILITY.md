# Conformance Toolchain Compatibility

## Execution verification (2026-09-10 UTC)

The Task 1 toolchain was selected from sources queried at execution time rather than from projected versions.

### Official Go release source

Source: <https://go.dev/VERSION?m=text>

```text
go1.27.1
time 2026-08-28T16:20:06Z
```

The installed toolchain reported:

```text
go version go1.26.5 darwin/arm64
```

This module selects Go **1.26** (the generated directive is `go 1.26.5`). Go 1.26 is within the approximately five-year compatibility window and remains supported under the official Go release policy because only one newer major release, Go 1.27, exists. The official policy states that a major release is supported until two newer major releases exist: <https://go.dev/doc/devel/release#policy>. Go 1.26.5 is also the locally installed secure patch level used to run this verification. The later compatibility matrix should test this selected maintained line and current stable Go 1.27.

### JSON Schema test dependency

Version source queried through the official Go module proxy mechanism:

```text
github.com/santhosh-tekuri/jsonschema/v6 v6.0.0-alpha.1 v6.0.0-beta1 v6.0.0 v6.0.1 v6.0.2 v6.0.3
```

Source command: `go list -m -versions github.com/santhosh-tekuri/jsonschema/v6`

Module source: <https://github.com/santhosh-tekuri/jsonschema/tree/v6.0.3>

Selected version: **v6.0.3**, the latest version returned by the source query. Its official module file declares Go 1.21 (<https://raw.githubusercontent.com/santhosh-tekuri/jsonschema/v6.0.3/go.mod>), so it is compatible with selected Go 1.26 and the approximately-five-year policy. It is used only by contract tests; the mock server implementation must continue to import only the Go standard library.

## Release verification (2026-09-10 UTC)

Release-preparation checks were repeated from `conformance/mock-ingest-server`:

```text
$ curl -fsSL 'https://go.dev/VERSION?m=text'
go1.27.1
time 2026-08-28T16:20:06Z

$ go version
go version go1.26.5 darwin/arm64

$ go list -m -versions github.com/santhosh-tekuri/jsonschema/v6
github.com/santhosh-tekuri/jsonschema/v6 v6.0.0-alpha.1 v6.0.0-beta1 v6.0.0 v6.0.1 v6.0.2 v6.0.3

$ go list -m -u -json all
```

The selected Go 1.26.5 line remains supported under the two-newer-major-release policy: Go 1.27.1 is the only newer major line reported by the official release source. The direct test dependency remains pinned at the latest listed `github.com/santhosh-tekuri/jsonschema/v6` release, v6.0.3; `go list -m -u -json all` reported no update for that direct dependency. It did report available updates for indirect transitive modules (`github.com/dlclark/regexp2`, `golang.org/x/mod`, `golang.org/x/sys`, `golang.org/x/text`, and `golang.org/x/tools`); this verification does not silently adopt them. No security finding was reported by the prescribed version checks. The selected runtime and direct test dependency therefore continue to match this document's supported matrix; the complete race suite, vet, module-stability check, and process-contract smoke test were rerun before release evidence was recorded.
