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
{
    "Path": "github.com/dlclark/regexp2",
    "Version": "v1.11.0",
    "Update": {"Path": "github.com/dlclark/regexp2", "Version": "v1.12.0"},
    "Indirect": true
}
{
    "Path": "github.com/santhosh-tekuri/jsonschema/v6",
    "Version": "v6.0.3"
}
{
    "Path": "golang.org/x/mod",
    "Version": "v0.8.0",
    "Update": {"Path": "golang.org/x/mod", "Version": "v0.41.0"},
    "Indirect": true
}
{
    "Path": "golang.org/x/sys",
    "Version": "v0.5.0",
    "Update": {"Path": "golang.org/x/sys", "Version": "v0.48.0"},
    "Indirect": true
}
{
    "Path": "golang.org/x/text",
    "Version": "v0.14.0",
    "Update": {"Path": "golang.org/x/text", "Version": "v0.42.0"},
    "Indirect": true
}
{
    "Path": "golang.org/x/tools",
    "Version": "v0.6.0",
    "Update": {"Path": "golang.org/x/tools", "Version": "v0.50.0"},
    "Indirect": true
}
```

This is an intentionally abbreviated, field-filtered transcript of the dependency records emitted by the command: it retains every direct dependency and every record with an `Update` field, while omitting the main-module record and unrelated metadata (timestamps, cache paths, checksums, and Go-version fields). Reproduce it by running the displayed command from `conformance/mock-ingest-server`; an absent `Update` field for direct dependency `github.com/santhosh-tekuri/jsonschema/v6` records current `v6.0.3` with no available update. The indirect update pairs are `github.com/dlclark/regexp2` `v1.11.0` → `v1.12.0`, `golang.org/x/mod` `v0.8.0` → `v0.41.0`, `golang.org/x/sys` `v0.5.0` → `v0.48.0`, `golang.org/x/text` `v0.14.0` → `v0.42.0`, and `golang.org/x/tools` `v0.6.0` → `v0.50.0`; this verification does not silently adopt them.

The selected Go 1.26.5 line remains supported under the two-newer-major-release policy: Go 1.27.1 is the only newer major line reported by the official release source. The direct test dependency remains pinned at the latest listed `github.com/santhosh-tekuri/jsonschema/v6` release, v6.0.3. The prescribed release/version queries are not vulnerability or advisory scans and do not establish the absence of relevant security advisories; no separate advisory review is recorded in this evidence. The selected runtime and direct test dependency therefore continue to match this document's supported matrix based on version compatibility; the complete race suite, vet, module-stability check, and process-contract smoke test were rerun before release evidence was recorded.
