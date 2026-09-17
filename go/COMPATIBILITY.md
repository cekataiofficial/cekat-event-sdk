# Go SDK Compatibility

## Module path update (2026-09-15 UTC)

The module path is the vanity import path `golang.cekat.ai/event-sdk` (adapters under `golang.cekat.ai/event-sdk/middleware/*`). Every module path needs its own `go-import` meta tag whose subdirectory field names that module's directory: `https://golang.cekat.ai/event-sdk?go-get=1` (and any path below it that is not an adapter) must serve `<meta name="go-import" content="golang.cekat.ai/event-sdk git https://github.com/cekataiofficial/cekat-event-sdk go">`, and `https://golang.cekat.ai/event-sdk/middleware/gin?go-get=1` (and paths below it) must serve `<meta name="go-import" content="golang.cekat.ai/event-sdk/middleware/gin git https://github.com/cekataiofficial/cekat-event-sdk go/middleware/gin">`, and likewise for `chi`, `echo`, and `fiber`. Each page must serve exactly one matching tag. With that layout, tags are `go/vX.Y.Z` for the core and `go/middleware/<name>/vX.Y.Z` for an adapter. A single root tag is not enough: the Go command then resolves `golang.cekat.ai/event-sdk/middleware/gin` relative to the root's subdirectory and looks for tags such as `middleware/gin/go/v0.1.0`. Both layouts were checked on 2026-09-15 against a local vanity server and Git repository with Go 1.27.1 and `GOPROXY=direct`. The subdirectory field of `go-import` is understood by Go 1.25 and newer; consumers on older toolchains receive the modules through the default module proxy (`proxy.golang.org`), which resolves the path itself. Consumers who bypass the proxy (`GOPROXY=direct`, or a `GOPRIVATE`/`GONOPROXY` pattern covering `golang.cekat.ai`) need Go 1.25 or newer; Go 1.22.12 in direct mode rejects the four-field tag with `no go-import meta tags`. The `github.com/cekataiofficial/cekat-event-sdk-go` coordinate checks recorded below predate this change.

## Module layout update (2026-09-13 UTC)

The SDK is split into independently versioned modules so that importing the core never adds framework dependencies to a consumer's module graph or raises their Go floor.

Go module: golang.cekat.ai/event-sdk
Selected minimum Go: 1.22

| Module | `go` directive | Tested framework version |
| --- | --- | --- |
| `golang.cekat.ai/event-sdk` (core and `middleware/nethttp`) | 1.22 | none; standard library only |
| `.../middleware/chi` | 1.23 (from Chi v5.3.2) | Chi v5.3.2 |
| `.../middleware/gin` | 1.25.0 (from Gin v1.12.0) | Gin v1.12.0 |
| `.../middleware/echo` | 1.25.0 (from Echo v4.15.4) | Echo v4.15.4 |
| `.../middleware/fiber` | 1.25.0 (from Fiber v3.5.0) | Fiber v3.5.0 |
| `.../internal/conformance` (unpublished test runner) | 1.22 | jsonschema v6.0.1 |

Go 1.22 is the core floor because the core uses `math/rand/v2` and Go 1.22 loop-variable semantics. The core package, `middleware/nethttp`, and `internal/retryobserver` tests were executed with the Go 1.22.12 toolchain (`GOTOOLCHAIN=go1.22.12 go test -ldflags=-linkmode=external`; external linking is only required because macOS 26 rejects binaries produced by the Go 1.22 internal linker) and with Go 1.26.5. `go vet` reports no use of standard-library APIs newer than each module's `go` directive.

Adapter modules keep the framework versions below as their minimum requirements. Each adapter's `go.mod` contains `replace golang.cekat.ai/event-sdk => ../..` for local development; `replace` directives are ignored when the module is consumed as a dependency. Nested modules are released with directory-prefixed tags such as `go/middleware/gin/v0.1.0`, and each adapter's core requirement must name a published core version at release time.

The sections below record the original single-module evidence from 2026-09-10 and are retained for history.

## Execution verification (2026-09-10 UTC)

Task 1 selected the module path and dependency versions only after querying the official sources below. The repository uses maintained release lines compatible with the installed Go 1.26.5 toolchain and the approximately-five-year compatibility goal. Go itself supports release lines until two newer major releases exist; the observed current stable release is Go 1.27.1, so selected Go 1.26 remains supported. See the [Go release policy](https://go.dev/doc/devel/release#policy).

Original single-module selection (superseded above): minimum Go 1.26
Gin module: v1.12.0
Echo module: v4.15.4
Fiber module: v3.5.0
Chi module: v5.3.2

### Runtime source

Official release source: <https://go.dev/dl/?mode=json>

```text
$ go version
go version go1.26.5 darwin/arm64

$ curl -fsSL 'https://go.dev/dl/?mode=json' > /tmp/cekat-go-releases.json
# First JSON release record:
{"version":"go1.27.1","stable":true}
```

Go 1.26 is selected as the minimum because the installed secure patch release is Go 1.26.5, it is supported under the official two-newer-major-release policy, and each selected framework declares compatibility with Go 1.25 or earlier.

### Framework module sources

Versions were queried from the Go module proxy with the following official module-resolution command:

```text
$ GOWORK=off go list -m -json github.com/gin-gonic/gin@latest
{
	"Path": "github.com/gin-gonic/gin",
	"Version": "v1.12.0",
	"Query": "latest",
	"Time": "2026-02-28T10:10:09Z",
	"GoMod": "$GOMODCACHE/cache/download/github.com/gin-gonic/gin/@v/v1.12.0.mod",
	"GoVersion": "1.25.0"
}

$ GOWORK=off go list -m -json github.com/labstack/echo/v4@latest
{
	"Path": "github.com/labstack/echo/v4",
	"Version": "v4.15.4",
	"Query": "latest",
	"Time": "2026-06-15T18:23:04Z",
	"GoMod": "$GOMODCACHE/cache/download/github.com/labstack/echo/v4/@v/v4.15.4.mod",
	"GoVersion": "1.25.0"
}

$ GOWORK=off go list -m -json github.com/gofiber/fiber/v3@latest
{
	"Path": "github.com/gofiber/fiber/v3",
	"Version": "v3.5.0",
	"Query": "latest",
	"Time": "2026-08-12T15:09:15Z",
	"GoMod": "$GOMODCACHE/cache/download/github.com/gofiber/fiber/v3/@v/v3.5.0.mod",
	"GoVersion": "1.25.0"
}

$ GOWORK=off go list -m -json github.com/go-chi/chi/v5@latest
{
	"Path": "github.com/go-chi/chi/v5",
	"Version": "v5.3.2",
	"Query": "latest",
	"Time": "2026-08-20T09:37:52Z",
	"GoMod": "$GOMODCACHE/cache/download/github.com/go-chi/chi/v5/@v/v5.3.2.mod",
	"GoVersion": "1.23"
}
```

The selected supported framework majors are Gin v1, Echo v4, Fiber v3, and Chi v5. The exact latest versions above are pinned for future adapter tasks. Fiber v3.5.0 was checked in its downloaded source and exposes the approved adapter API: `fiber.Ctx`, `fiber.Handler`, and `Ctx.Locals`, `Ctx.Get`, and `Ctx.Cookies`.

```text
$ grep -n -E 'type (Ctx interface|Handler =)' ctx_interface_gen.go app.go
ctx_interface_gen.go:18:type Ctx interface {
app.go:41:type Handler = func(Ctx) error

$ sed -n '/type Ctx interface {/,/^}/p' ctx_interface_gen.go | grep -E '^[[:space:]]*(Locals|Get|Cookies)\('
	Get(key string, defaultValue ...string) string
	Cookies(key string, defaultValue ...string) string
	Locals(key any, value ...any) any
```

### Coordinate ownership source

Organization source: <https://api.github.com/orgs/cekataiofficial>

```text
$ curl -fsSL https://api.github.com/orgs/cekataiofficial > /tmp/cekat-go-owner.json
{"login":"cekataiofficial","html_url":"https://github.com/cekataiofficial","type":"Organization"}

$ curl -sSL -o /tmp/cekat-go-repository.json -w '%{http_code}\n' https://api.github.com/repos/cekataiofficial/cekat-event-sdk-go
404

$ cat /tmp/cekat-go-repository.json
{"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#get-a-repository","status":"404"}
```

The owner login exactly matches `cekataiofficial`. The exact repository coordinate returned 404, which records availability rather than authorizing an alternate module path: the Cekat release owner must create or transfer `cekataiofficial/cekat-event-sdk-go` before publication.

The owner and coordinate result were validated with:

```text
owner['login'].casefold() == 'cekataiofficial'
repository HTTP status in {'200', '404'}
# If 200, repository full_name must case-fold to cekataiofficial/cekat-event-sdk-go.
```

## Release-time verification (2026-09-10 UTC) — BLOCKED

The following release evidence was collected immediately before approval. `go mod tidy` was applied and re-run cleanly. It correctly classifies Chi v5 and Fiber v3 (used by adapter packages) plus `fasthttp` (used by the Fiber adapter test) as direct module requirements, and records checksums required by the resolved dependency test graph. The tidy result made no dependency version upgrades. `go list -m -u -json all` completed successfully; the selected framework versions have no reported update in that output (Gin v1.12.0, Echo v4.15.4, Fiber v3.5.0, and Chi v5.3.2). It did report `github.com/quic-go/quic-go` v0.59.0 has an available v0.62.0 update.

```text
$ curl -fsSL 'https://go.dev/dl/?mode=json' > /tmp/cekat-go-releases-release.json
# First stable records: go1.27.1 and go1.26.8

$ cd go
$ go list -m -u -json all > /tmp/cekat-go-module-updates-release.json
# exit 0

$ go install golang.org/x/vuln/cmd/govulncheck@latest
# exit 0

$ govulncheck ./...
# exit 3: code is affected by five vulnerabilities
```

`govulncheck` found reachable vulnerabilities in the installed Go 1.26.5 runtime: GO-2026-6218 (`net/url`, fixed in Go 1.26.6), GO-2026-6090 (`crypto/tls`, fixed in Go 1.26.6), GO-2026-5972 (`encoding/asn1`, fixed in Go 1.26.6), and GO-2026-5026 (`net/http`, fixed in Go 1.26.6). It also found GO-2026-5676 in required transitive module `github.com/quic-go/quic-go` v0.59.0, fixed in v0.59.1. The scan additionally reported imported/required vulnerability findings without detected calls; this record does **not** claim a clean or vulnerability-free scan.

**Decision: release readiness is BLOCKED.** A release owner must upgrade the runtime to Go 1.26.6 or later and update the resolved `github.com/quic-go/quic-go` dependency to at least v0.59.1, then rerun the complete package, compatibility, and vulnerability evidence gates. No registry ownership, tag creation, signing, or publishing was performed or authorized here. The local archive and manifest prepared by `scripts/package` are inspection artifacts only and are not release-approved while these blockers remain.
