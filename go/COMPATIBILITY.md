# Go SDK Compatibility

## Execution verification (2026-09-10 UTC)

Task 1 selected the module path and dependency versions only after querying the official sources below. The repository uses maintained release lines compatible with the installed Go 1.26.5 toolchain and the approximately-five-year compatibility goal. Go itself supports release lines until two newer major releases exist; the observed current stable release is Go 1.27.1, so selected Go 1.26 remains supported. See the [Go release policy](https://go.dev/doc/devel/release#policy).

Go module: github.com/cekataiofficial/cekat-event-sdk-go
Selected minimum Go: 1.26
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
	"GoMod": "/Users/gusaul/go/pkg/mod/cache/download/github.com/gin-gonic/gin/@v/v1.12.0.mod",
	"GoVersion": "1.25.0"
}

$ GOWORK=off go list -m -json github.com/labstack/echo/v4@latest
{
	"Path": "github.com/labstack/echo/v4",
	"Version": "v4.15.4",
	"Query": "latest",
	"Time": "2026-06-15T18:23:04Z",
	"GoMod": "/Users/gusaul/go/pkg/mod/cache/download/github.com/labstack/echo/v4/@v/v4.15.4.mod",
	"GoVersion": "1.25.0"
}

$ GOWORK=off go list -m -json github.com/gofiber/fiber/v3@latest
{
	"Path": "github.com/gofiber/fiber/v3",
	"Version": "v3.5.0",
	"Query": "latest",
	"Time": "2026-08-12T15:09:15Z",
	"GoMod": "/Users/gusaul/go/pkg/mod/cache/download/github.com/gofiber/fiber/v3/@v/v3.5.0.mod",
	"GoVersion": "1.25.0"
}

$ GOWORK=off go list -m -json github.com/go-chi/chi/v5@latest
{
	"Path": "github.com/go-chi/chi/v5",
	"Version": "v5.3.2",
	"Query": "latest",
	"Time": "2026-08-20T09:37:52Z",
	"GoMod": "/Users/gusaul/go/pkg/mod/cache/download/github.com/go-chi/chi/v5/@v/v5.3.2.mod",
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
