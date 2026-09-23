# Go Event SDK Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).

> **Go layout amendment (2026-09-13):** the core module targets Go 1.22 and has no third-party dependencies; `middleware/{gin,echo,fiber,chi}` and `internal/conformance` are separate modules. `ApiError` is `APIError`, the retry-delay observer is internal, `ResolveVisitorID`/`VisitorHeader`/`VisitorCookie` are public, and the Fiber adapter enriches `c.Context()`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single Go module `github.com/cekataiofficial/cekat-event-sdk-go`, including its synchronous event client, six typed errors, explicit context-based visitor propagation, five HTTP framework adapters, and stable conformance/package scripts.

**Architecture:** Package `cekat` owns public models, validation, request construction, retries, response decoding, errors, and standard-library request enrichment. Thin packages under `middleware/` adapt native framework requests to that core context contract; only Fiber needs a private local because it is not based on `net/http`. Shared JSON fixtures and the shared mock ingest server remain the language-neutral source of observable behavior.

**Tech Stack:** Go standard library (`context`, `encoding/json`, `net/http`, `net/url`, `time`), Gin, Echo, Fiber, Chi, Go test/race/fuzz tooling, POSIX shell.

**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`

## Dependencies and Global Constraints

- Execute the shared protocol/conformance plan first. This plan consumes `conformance/fixtures/cases`, its schemas, and the running mock API; it does not alter their formats.
- The approved coordinate constraint is a Cekat-owned module ending in `cekat-event-sdk-go`. This plan uses `github.com/cekataiofficial/cekat-event-sdk-go` only after Task 1 verifies Cekat organization ownership and repository-name availability; all five adapters are packages in this one module. If that exact ownership check fails, stop for product review instead of initializing a different module or reverting to the nonconforming `/go` suffix.
- Default origin is `https://t.cekat.ai`; every request is `POST /api/events/ingest` with `Authorization: Bearer <access_token>` and JSON content type. Never serialize `business_id` or expose the token in errors.
- A custom base URL must be an absolute HTTP(S) origin without credentials, non-root path, query, or fragment. A trailing slash is accepted and removed.
- The timeout is 10 seconds per network attempt. Two retries follow the initial request. Full jitter is uniformly `[0,100ms]` before retry 1 and `[0,200ms]` before retry 2.
- Retry transport failures, transport timeouts while the caller context remains active, and HTTP `500` only. Never retry any received non-`500` response.
- Caller cancellation or deadline before a request, during a request, or during backoff returns the raw `ctx.Err()` and stops immediately. An injected `*http.Client` is not mutated; whichever client, SDK-attempt, or caller deadline fires first applies.
- A final transport failure is `*TransportError` with unknown outcome after request execution begins. Every received HTTP response has known outcome, including exhausted `500` and malformed `200`.
- Retain the first 65,536 response bytes. `Body []byte` fields contain an owned copy. A malformed `200` is `*ResponseDecodeError`; malformed non-`200` content retains status-based classification and uses `http.StatusText(status)`.
- A valid `200` requires outer `success:true`, object `data`, inner `success:true`, non-empty `message` and `event_key`, and `validated_properties` as `[]string`. Unknown fields are ignored.
- A conforming error is `{"success":false,"error":"non-empty","code":"optional"}`. Status `401` maps to `AuthenticationError`, `404` to `EventDefinitionNotFoundError`, and all other non-`200` statuses to `ApiError`.
- Preserve submitted email, phone, and contact-name strings; trim them only to test emptiness. At least one nonblank email or phone is required.
- Recursively accept only JSON null, booleans, strings, finite numbers, arrays, and string-keyed objects. Reject cycles, non-string map keys, functions/channels/complex values, and integers outside `[-9007199254740991,9007199254740991]` before networking.
- Trim visitor IDs for storage and transmission. Header `X-Cekat-Visitor-ID` precedes cookie `_cekat_visitor_id`; blank header falls back to cookie. Blank explicit `Event.VisitorID` falls back to context; nonblank explicit ID precedes context.
- Acknowledgement means accepted for asynchronous processing, not durable storage, identity resolution, delivery completion, or analytics availability. Retries can duplicate events because there is no idempotency guarantee.
- At execution time and again before release, verify Go/framework versions from official sources and record observed output. Do not treat projected versions as release facts.

---

## Exact File Map

```text
go/
├── go.mod                                      # single module declaration and verified Go directive
├── go.sum                                      # pinned framework dependency checksums
├── README.md                                   # install/API/middleware/error/retry semantics
├── COMPATIBILITY.md                            # dated execution/release source evidence
├── doc.go                                      # package documentation and queue-acceptance caveat
├── client.go                                   # Client, New, five synchronous operations
├── client_test.go                              # operation keys, request construction, token redaction
├── options.go                                  # config, Option, validation, defaults
├── options_test.go
├── event.go                                    # Event, Acknowledgement, private wire payloads
├── errors.go                                   # six public concrete error types
├── errors_test.go
├── context.go                                  # context and *http.Request visitor APIs
├── context_test.go
├── validation.go                              # identity and recursive JSON-domain checks
├── validation_test.go
├── response.go                                # bounded reads and success/error envelope decoding
├── response_test.go
├── retry.go                                   # retry classification, full jitter, interruptible sleep
├── retry_test.go
├── internal/
│   ├── visitor/
│   │   ├── extract.go                         # trimmed header-over-cookie resolution
│   │   └── extract_test.go
│   ├── conformance/
│   │   ├── conformance_test.go                # shared fixture dispatcher
│   │   ├── fixture.go                         # fixture decoding and runtime recipes
│   │   └── mock.go                            # control API client and journal assertions
│   └── packageprep/
│       ├── main.go                            # source archive and manifest writer
│       └── main_test.go                       # version/path/hash/ordering tests
├── middleware/
│   ├── nethttp/
│   │   ├── middleware.go
│   │   └── middleware_test.go
│   ├── gin/
│   │   ├── middleware.go
│   │   └── middleware_test.go
│   ├── echo/
│   │   ├── middleware.go
│   │   └── middleware_test.go
│   ├── fiber/
│   │   ├── middleware.go
│   │   └── middleware_test.go
│   └── chi/
│       ├── middleware.go
│       └── middleware_test.go
└── scripts/
    ├── conformance                            # stable root-runner interface
    └── package                                # 0.1.0 no-publish artifact interface
```

## Interfaces

### Public core API

```go
package cekat

import (
    "context"
    "net/http"
    "time"
)

type Event struct {
    Email       string
    PhoneNumber string
    ContactName string
    VisitorID   string
    Properties  map[string]any
}

type Acknowledgement struct {
    Success             bool
    Message             string
    EventKey            string
    ValidatedProperties []string
    RawBody             []byte
}

type Option func(*config) error

func New(accessToken string, options ...Option) (*Client, error)
func WithBaseURL(baseURL string) Option
func WithTimeout(timeout time.Duration) Option
func WithRetryCount(retryCount int) Option
func WithHTTPClient(httpClient *http.Client) Option

func (c *Client) UserRegistration(ctx context.Context, event Event) (*Acknowledgement, error)
func (c *Client) UserLogin(ctx context.Context, event Event) (*Acknowledgement, error)
func (c *Client) OrderCreated(ctx context.Context, event Event) (*Acknowledgement, error)
func (c *Client) OrderPaid(ctx context.Context, event Event) (*Acknowledgement, error)
func (c *Client) CustomEvent(ctx context.Context, eventKey string, event Event) (*Acknowledgement, error)

func WithVisitorID(ctx context.Context, visitorID string) context.Context
func VisitorIDFromContext(ctx context.Context) (string, bool)
func WithVisitorFromRequest(request *http.Request) *http.Request
```

All operations return `nil, err` on failure. Common operations force their documented key and `is_common:true`; `CustomEvent` uses the supplied key and `is_common:false`.

### Public typed errors

```go
type ValidationError struct { Message string }

type AuthenticationError struct {
    StatusCode int; Message, Code string; Body []byte; Attempts int
}
type EventDefinitionNotFoundError struct {
    StatusCode int; Message, Code string; Body []byte; Attempts int
}
type ApiError struct {
    StatusCode int; Message, Code string; Body []byte; Attempts int
}
type TransportError struct {
    Message string; Attempts int; DeliveryOutcomeUnknown bool; Cause error
}
type ResponseDecodeError struct {
    Message string; StatusCode int; Body []byte; Attempts int; Cause error
}
```

Every type implements `Error() string`; transport and decode errors implement `Unwrap() error`. `errors.As` must match pointers to all six types. No message includes the access token or submitted property values.

### Adapter API

```go
// middleware/nethttp and middleware/chi
func Middleware(next http.Handler) http.Handler

// middleware/gin
func Middleware() gin.HandlerFunc

// middleware/echo
func Middleware() echo.MiddlewareFunc

// middleware/fiber, against the maintained major verified in Task 1
func Middleware() fiber.Handler
func Context(c fiber.Ctx) context.Context
```

Gin and Echo replace the native request with `cekat.WithVisitorFromRequest(request)`. Chi delegates to the standard HTTP adapter. Fiber stores a derived `context.Context` under an unexported collision-safe local key, restores/removes it after downstream completion, and copies visitor text before storing it.

### Internal delivery seams

```go
type config struct {
    baseURL string
    timeout time.Duration
    retryCount int
    httpClient *http.Client
    sleep func(context.Context, time.Duration) error
    jitter func(time.Duration) time.Duration // result is in [0,max]
}

type wirePayload struct {
    EventKey string `json:"event_key"`
    ContactName string `json:"contact_name,omitempty"`
    PhoneNumber string `json:"phone_number,omitempty"`
    Email string `json:"email,omitempty"`
    VisitorID string `json:"visitor_id,omitempty"`
    IsCommon bool `json:"is_common"`
    Properties map[string]any `json:"properties,omitempty"`
}
```

`sleep` and `jitter` are private deterministic test seams, not options. Each attempt builds a fresh request/body and uses `context.WithTimeout(ctx, configuredTimeout)`. The maximum jitter before retry number `n` is `100ms * 2^(n-1)`; with the default retry count this produces 100ms and 200ms.

### Script interfaces consumed from the shared/root plans

```text
go/scripts/conformance
  positional arguments: none
  reads: CEKAT_CONFORMANCE_BASE_URL, CEKAT_CONFORMANCE_CONTROL_URL,
         CEKAT_CONFORMANCE_ACCESS_TOKEN, CEKAT_CONFORMANCE_FIXTURES

go/scripts/package --version 0.1.0 --output <absolute-directory>
  runs Go tests and writes manifest.json:
  {"schema_version":1,"language":"go","version":"0.1.0",
   "artifacts":[{"path":"relative/sorted","sha256":"lowercase hex","size_bytes":1}]}
```

Unknown fixture versions/recipes/results, missing environment variables, skipped required cases, non-`0.1.0` versions, relative output paths, traversal paths, test failures, and hash mismatches are hard failures.

---

### Task 1: Verify Versions and Bootstrap the Single Module

**Files:** Create `go/go.mod`, `go/go.sum`, `go/COMPATIBILITY.md`, `go/doc.go`.

**Interfaces:** Produces the module and observed version matrix consumed by every later task.

- [ ] **Step 1: Query official runtime, module, and coordinate-ownership sources before selecting versions**

```bash
curl -fsSL 'https://go.dev/dl/?mode=json' > /tmp/cekat-go-releases.json
go version
for module in github.com/gin-gonic/gin github.com/labstack/echo/v4 github.com/gofiber/fiber/v3 github.com/go-chi/chi/v5; do
  GOWORK=off go list -m -json "$module@latest"
done
curl -fsSL https://api.github.com/orgs/cekataiofficial > /tmp/cekat-go-owner.json
curl -fsSL -o /tmp/cekat-go-repository.json -w '%{http_code}\n' \
  https://api.github.com/repos/cekataiofficial/cekat-event-sdk-go \
  | tee /tmp/cekat-go-repository.status
python3 - <<'PY'
import json
from pathlib import Path
owner = json.loads(Path('/tmp/cekat-go-owner.json').read_text())
assert owner['login'].casefold() == 'cekataiofficial'
status = Path('/tmp/cekat-go-repository.status').read_text().strip()
assert status in {'200', '404'}, status
if status == '200':
    repo = json.loads(Path('/tmp/cekat-go-repository.json').read_text())
    assert repo['full_name'].casefold() == 'cekataiofficial/cekat-event-sdk-go'
PY
```

Expected: all commands exit `0` and report an observed stable Go release plus module versions. The GitHub owner must be exactly the Cekat organization; an existing repository must have the exact full name, while `404` records that the Cekat release owner must create/transfer that exact repository before publication. Any other response or ownership result is a blocking product review, not permission to choose another module path. Confirm the Fiber release exposes `fiber.Ctx`, `fiber.Handler`, `Locals`, `Get`, and `Cookies`; stop for product review if the maintained secure major cannot satisfy the approved Fiber interface. Record date, complete outputs, official URLs, coordinate result, supported framework majors, and rationale in `go/COMPATIBILITY.md`. Include machine-readable lines `Go module: github.com/cekataiofficial/cekat-event-sdk-go`, `Selected minimum Go: <major.minor>`, `Gin module: <version>`, `Echo module: <version>`, `Fiber module: <version>`, and `Chi module: <version>`. Select only maintained secure versions consistent with the approximately-five-year policy.

- [ ] **Step 2: Write the failing module check**

```bash
test -f go/go.mod && grep -Fx 'module github.com/cekataiofficial/cekat-event-sdk-go' go/go.mod
```

Expected: FAIL because `go/go.mod` does not exist.

- [ ] **Step 3: Initialize the module with the verified minimum Go directive**

```bash
cd go
test "$(awk -F': ' '/^Go module:/{print $2}' COMPATIBILITY.md)" = github.com/cekataiofficial/cekat-event-sdk-go
go mod init github.com/cekataiofficial/cekat-event-sdk-go
go mod edit -go="$(awk -F': ' '/^Selected minimum Go:/{print $2}' COMPATIBILITY.md)"
go get \
  "github.com/gin-gonic/gin@$(awk -F': ' '/^Gin module:/{print $2}' COMPATIBILITY.md)" \
  "github.com/labstack/echo/v4@$(awk -F': ' '/^Echo module:/{print $2}' COMPATIBILITY.md)" \
  "github.com/gofiber/fiber/v3@$(awk -F': ' '/^Fiber module:/{print $2}' COMPATIBILITY.md)" \
  "github.com/go-chi/chi/v5@$(awk -F': ' '/^Chi module:/{print $2}' COMPATIBILITY.md)"
```

Expected: exit `0`; the module line is exact, the Go directive equals the observed minimum recorded in `COMPATIBILITY.md`, and every framework requirement uses the exact verified version. Do not run `go mod tidy` until adapter imports exist, because it would remove the intentionally preselected dependencies.

- [ ] **Step 4: Add `doc.go` and verify the empty package**

```bash
cd go && go test ./...
```

Expected: PASS; package documentation states synchronous queue acceptance and duplicate risk without promising idempotency.

- [ ] **Step 5: Commit**

```bash
git add go/go.mod go/go.sum go/COMPATIBILITY.md go/doc.go
git commit -m "build(go): initialize SDK module"
```

### Task 2: Define Models, Options, and Six Typed Errors

**Files:** Create `go/event.go`, `go/options.go`, `go/options_test.go`, `go/errors.go`, `go/errors_test.go`.

**Interfaces:** Produces the public models, constructors/options, and exact six-error taxonomy defined above.

- [ ] **Step 1: Write table tests for defaults, invalid options, and `errors.As`**

Cover blank token, relative/non-HTTP URL, credentials/path/query/fragment, zero timeout, negative retries, nil HTTP client, trailing-slash normalization, token redaction, error fields, `Unwrap`, and body ownership. Assert defaults `https://t.cekat.ai`, 10 seconds, and 2 retries.

- [ ] **Step 2: Run the focused tests**

```bash
cd go && go test . -run 'Test(New|Options|TypedErrors)' -count=1
```

Expected: FAIL with undefined `New`, `ValidationError`, and the other public types.

- [ ] **Step 3: Implement the minimal public types and validation**

Use this constructor pattern so option and final-config failures consistently return `*ValidationError`:

```go
func New(accessToken string, options ...Option) (*Client, error) {
    cfg := defaultConfig()
    if strings.TrimSpace(accessToken) == "" {
        return nil, &ValidationError{Message: "access token must not be blank"}
    }
    for _, option := range options {
        if err := option(&cfg); err != nil { return nil, asValidationError(err) }
    }
    if err := validateConfig(cfg); err != nil { return nil, err }
    return &Client{accessToken: accessToken, config: cfg}, nil
}
```

Validate URLs via `url.Parse`; require `http`/`https`, nonempty host, empty user/query/fragment, and path `""` or `"/"`. Never format the token into an error.

- [ ] **Step 4: Verify focused and package tests**

```bash
cd go && gofmt -w event.go options.go options_test.go errors.go errors_test.go && go test . -count=1
```

Expected: PASS with all six pointer error types matching through `errors.As`.

- [ ] **Step 5: Commit**

```bash
git add go/event.go go/options.go go/options_test.go go/errors.go go/errors_test.go
git commit -m "feat(go): add public models options and errors"
```

### Task 3: Add Strict Event Validation and Payload Construction

**Files:** Create `go/validation.go`, `go/validation_test.go`; begin `go/client.go`, `go/client_test.go`.

**Interfaces:** Consumes `Event`; produces pre-network validation and the five operation-to-payload mappings.

- [ ] **Step 1: Write failing table and cycle tests**

Assert blank keys and absent identities fail; identity whitespace is preserved; valid nested values pass; NaN/infinities, unsafe integers, cycles, functions, channels, complex numbers, structs, pointers, and nested non-string-key maps fail without echoing values. Assert all failures occur before a counting `RoundTripper` is called.

- [ ] **Step 2: Run validation tests**

```bash
cd go && go test . -run 'Test(ValidateEvent|BuildPayload|Operations)' -count=1
```

Expected: FAIL with undefined validation/payload helpers and client methods.

- [ ] **Step 3: Implement recursive path-aware validation and operation wrappers**

Use a recursion-stack identity for maps/slices/pointers to reject cycles, and accept only interoperable values. Error text may identify a safe key path such as `properties.order.total` but never use `%v` on its value. Build payloads from copies so neither validation nor submission mutates caller maps. Common wrappers call one private `track(ctx,key,true,event)`; custom calls `track(ctx,eventKey,false,event)`.

- [ ] **Step 4: Run tests and fuzz the validator**

```bash
cd go
gofmt -w validation.go validation_test.go client.go client_test.go
go test . -run 'Test(ValidateEvent|BuildPayload|Operations)' -count=1
go test . -run=^$ -fuzz=FuzzValidateProperties -fuzztime=10s
```

Expected: PASS; fuzzing completes without panic, stack overflow, mutation, or leakage of rendered property values.

- [ ] **Step 5: Commit**

```bash
git add go/validation.go go/validation_test.go go/client.go go/client_test.go
git commit -m "feat(go): validate events and build operation payloads"
```

### Task 4: Implement Context Visitor Extraction and Precedence

**Files:** Create `go/internal/visitor/extract.go`, `go/internal/visitor/extract_test.go`, `go/context.go`, `go/context_test.go`; extend `go/client_test.go`.

**Interfaces:** Produces `WithVisitorID`, `VisitorIDFromContext`, `WithVisitorFromRequest`, and private `visitor.Resolve(header,cookie)`.

- [ ] **Step 1: Write failing extraction/context tests**

Test trimmed header over cookie, blank-header cookie fallback, missing visitor, immutable request replacement, private typed context key, blank context input not overwriting an existing value, explicit trimmed event visitor precedence, blank explicit fallback, and omitted visitor when neither source exists.

- [ ] **Step 2: Run focused tests**

```bash
cd go && go test ./internal/visitor . -run 'Test(Resolve|Visitor|PayloadVisitor)' -count=1
```

Expected: FAIL because visitor helpers do not exist.

- [ ] **Step 3: Implement extraction and immutable context enrichment**

```go
func WithVisitorFromRequest(r *http.Request) *http.Request {
    cookie := ""
    if c, err := r.Cookie("_cekat_visitor_id"); err == nil { cookie = c.Value }
    id, ok := visitor.Resolve(r.Header.Get("X-Cekat-Visitor-ID"), cookie)
    if !ok { return r }
    return r.WithContext(WithVisitorID(r.Context(), id))
}
```

`Resolve` trims both candidates; `WithVisitorID` trims input and returns the original context for blank input. Payload construction trims a nonblank explicit ID, otherwise reads context.

- [ ] **Step 4: Verify tests and race safety**

```bash
cd go && gofmt -w context.go context_test.go internal/visitor/*.go && go test -race ./internal/visitor . -count=1
```

Expected: PASS with no race and no cross-context visitor leakage.

- [ ] **Step 5: Commit**

```bash
git add go/context.go go/context_test.go go/client_test.go go/internal/visitor
git commit -m "feat(go): add request visitor context"
```

### Task 5: Implement Bounded Response Decoding and Status Errors

**Files:** Create `go/response.go`, `go/response_test.go`.

**Interfaces:** Produces owned bounded-body decoding into `*Acknowledgement`, `*AuthenticationError`, `*EventDefinitionNotFoundError`, `*ApiError`, or `*ResponseDecodeError`.

- [ ] **Step 1: Write failing response tables**

Include the canonical nested success, each required-field/type violation, unknown fields, malformed JSON, structured `400/401/404/500`, malformed non-`200`, optional/invalid code, and multibyte bodies over 65,536 bytes. Assert attempts and exact body length/content.

- [ ] **Step 2: Run focused tests**

```bash
cd go && go test . -run 'Test(ReadBoundedBody|DecodeResponse)' -count=1
```

Expected: FAIL with undefined response decoder.

- [ ] **Step 3: Implement bounded reads and strict envelope validation**

Read at most 65,537 bytes to detect overflow, retain an owned copy of bytes `[0:65536]`, and never expose the read buffer. Decode the nested success structure into typed private fields and explicitly check nonblank message/key and every validated-property element. For non-`200`, accept server text only when outer success is exactly false and error is nonblank; otherwise use `http.StatusText` while preserving body and status classification.

- [ ] **Step 4: Verify response tests**

```bash
cd go && gofmt -w response.go response_test.go && go test . -run 'Test(ReadBoundedBody|DecodeResponse)' -count=1
```

Expected: PASS; only malformed `200` values produce `ResponseDecodeError`.

- [ ] **Step 5: Commit**

```bash
git add go/response.go go/response_test.go
git commit -m "feat(go): decode bounded ingest responses"
```

### Task 6: Implement Synchronous Delivery, Retry, Timeout, and Cancellation

**Files:** Create `go/retry.go`, `go/retry_test.go`; complete `go/client.go`, `go/client_test.go`.

**Interfaces:** Completes all five public event methods and the delivery semantics in Global Constraints.

- [ ] **Step 1: Write failing scripted-transport tests**

Assert endpoint/auth/content type, fresh equal body per attempt, success on attempt 1, retry sequences `500/500/200` and transport/transport/200, mixed-final classification, no retry for `400/401/404/429`, jitter bounds, 10-second attempt contexts, earlier injected-client timeout, unknown outcome, raw caller cancellation before/in-flight/backoff, and unchanged injected `http.Client.Timeout`.

- [ ] **Step 2: Run focused tests**

```bash
cd go && go test . -run 'Test(ClientRequest|Retry|Timeout|Cancellation)' -count=1
```

Expected: FAIL because delivery/retry behavior is incomplete.

- [ ] **Step 3: Implement the attempt loop with private deterministic seams**

Use this control shape; `doAttempt` creates a new request and `context.WithTimeout` on every call:

```go
for attempt := 1; attempt <= 1+c.config.retryCount; attempt++ {
    if err := ctx.Err(); err != nil { return nil, err }
    ack, err, retryable := c.doAttempt(ctx, payload, attempt)
    if err == nil { return ack, nil }
    if ctx.Err() != nil { return nil, ctx.Err() }
    if !retryable || attempt == 1+c.config.retryCount { return nil, err }
    max := 100 * time.Millisecond * time.Duration(1<<(attempt-1))
    if err := c.config.sleep(ctx, c.config.jitter(max)); err != nil {
        return nil, ctx.Err()
    }
}
```

Before returning an HTTP `500`, decode it as `ApiError` with the current attempt count. Before returning a `client.Do` failure, use `TransportError{Attempts:attempt,DeliveryOutcomeUnknown:true,Cause:err}`. If caller context is done, return raw `ctx.Err()` instead. Never mutate `c.config.httpClient`.

- [ ] **Step 4: Verify timing-independent tests and races**

```bash
cd go
gofmt -w client.go client_test.go retry.go retry_test.go
go test . -run 'Test(ClientRequest|Retry|Timeout|Cancellation)' -count=1
go test -race . -run 'TestClientConcurrent' -count=20
```

Expected: PASS; recorded jitter maxima are exactly 100ms then 200ms, total attempts never exceed three by default, and concurrent requests do not share state.

- [ ] **Step 5: Commit**

```bash
git add go/client.go go/client_test.go go/retry.go go/retry_test.go
git commit -m "feat(go): deliver events with bounded retries"
```

### Task 7: Add Standard `net/http` and Chi Middleware

**Files:** Create `go/middleware/nethttp/middleware.go`, `go/middleware/nethttp/middleware_test.go`, `go/middleware/chi/middleware.go`, `go/middleware/chi/middleware_test.go`.

**Interfaces:** Produces both `Middleware(http.Handler) http.Handler` APIs; Chi delegates behavior to nethttp.

- [ ] **Step 1: Write failing native middleware tests**

Use `httptest` and a Chi router. Assert header/cookie precedence, trimming, context visibility only through the derived request, no cookie/header mutation, no emitted event/cookie, downstream status preservation, parallel isolation, and absence after request completion.

- [ ] **Step 2: Run adapter tests**

```bash
cd go && go test ./middleware/nethttp ./middleware/chi -count=1
```

Expected: FAIL with missing middleware packages/functions.

- [ ] **Step 3: Implement minimal wrappers**

```go
func Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        next.ServeHTTP(w, cekat.WithVisitorFromRequest(r))
    })
}
```

Chi exports its own function and delegates to `nethttp.Middleware(next)` so consumers retain a framework-named import without duplicated extraction logic.

- [ ] **Step 4: Verify tests with races**

```bash
cd go && gofmt -w middleware/nethttp/*.go middleware/chi/*.go && go test -race ./middleware/nethttp ./middleware/chi -count=20
```

Expected: PASS with no shared state or race reports.

- [ ] **Step 5: Commit**

```bash
git add go/middleware/nethttp go/middleware/chi
git commit -m "feat(go): add net/http and Chi middleware"
```

### Task 8: Add Gin Middleware

**Files:** Create `go/middleware/gin/middleware.go`, `go/middleware/gin/middleware_test.go`.

**Interfaces:** Produces `gin.Middleware() gin.HandlerFunc`; downstream sees visitor through `c.Request.Context()`.

- [ ] **Step 1: Write failing Gin tests**

Use `gin.New`, install middleware, and assert header/cookie cases, abort/status preservation, panic propagation to Gin recovery, and 50 parallel requests each observing only its own visitor.

- [ ] **Step 2: Run the Gin package**

```bash
cd go && go test ./middleware/gin -count=1
```

Expected: FAIL because `Middleware` is undefined.

- [ ] **Step 3: Implement request replacement before `c.Next()`**

```go
func Middleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Request = cekat.WithVisitorFromRequest(c.Request)
        c.Next()
    }
}
```

Do not use `c.Set`, authenticate the ID, change cookies, or retain `*gin.Context`.

- [ ] **Step 4: Verify races**

```bash
cd go && gofmt -w middleware/gin/*.go && go test -race ./middleware/gin -count=20
```

Expected: PASS with unchanged response/abort behavior and isolated visitors.

- [ ] **Step 5: Commit**

```bash
git add go/middleware/gin
git commit -m "feat(go): add Gin visitor middleware"
```

### Task 9: Add Echo Middleware

**Files:** Create `go/middleware/echo/middleware.go`, `go/middleware/echo/middleware_test.go`.

**Interfaces:** Produces `echo.Middleware() echo.MiddlewareFunc`; it returns the exact downstream error.

- [ ] **Step 1: Write failing Echo tests**

Use `echo.New`; assert context enrichment, precedence/trimming, exact downstream error identity, panic propagation, and parallel isolation.

- [ ] **Step 2: Run the Echo package**

```bash
cd go && go test ./middleware/echo -count=1
```

Expected: FAIL because `Middleware` is undefined.

- [ ] **Step 3: Implement request replacement and error preservation**

```go
func Middleware() echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            c.SetRequest(cekat.WithVisitorFromRequest(c.Request()))
            return next(c)
        }
    }
}
```

Do not write Echo-local visitor state or intercept returned errors.

- [ ] **Step 4: Verify races**

```bash
cd go && gofmt -w middleware/echo/*.go && go test -race ./middleware/echo -count=20
```

Expected: PASS with the exact handler error returned and no visitor leakage.

- [ ] **Step 5: Commit**

```bash
git add go/middleware/echo
git commit -m "feat(go): add Echo visitor middleware"
```

### Task 10: Add Fiber Middleware and Scoped Context Helper

**Files:** Create `go/middleware/fiber/middleware.go`, `go/middleware/fiber/middleware_test.go`.

**Interfaces:** Produces `fiber.Middleware() fiber.Handler` and `fiber.Context(c fiber.Ctx) context.Context` using the verified Fiber API.

- [ ] **Step 1: Write failing Fiber lifecycle tests**

Use a native Fiber app. Assert trimmed header/cookie extraction, `Context(c)` visibility, background context when middleware is absent, exact downstream error identity, restoration/removal after success and error, copied visitor text under context reuse, and 50 concurrent requests without leakage.

- [ ] **Step 2: Run the Fiber package**

```bash
cd go && go test ./middleware/fiber -count=1
```

Expected: FAIL because Fiber helpers are undefined.

- [ ] **Step 3: Implement private-local replace/restore scope**

Resolve native `c.Get("X-Cekat-Visitor-ID")` and `c.Cookies("_cekat_visitor_id")` through `internal/visitor.Resolve`. Store only a derived standard context under an unexported pointer key, call `c.Next()`, and restore the prior local in `defer` on success, returned error, and panic. `Context(c)` type-asserts the local and otherwise returns `context.Background()`. Never retain `fiber.Ctx`, request headers, or pooled byte slices.

- [ ] **Step 4: Verify lifecycle and races**

```bash
cd go && gofmt -w middleware/fiber/*.go && go test -race ./middleware/fiber -count=20
```

Expected: PASS; cleanup assertions hold on every exit path and the race detector is silent.

- [ ] **Step 5: Commit**

```bash
git add go/middleware/fiber
git commit -m "feat(go): add Fiber visitor middleware"
```

### Task 11: Execute Shared Conformance Through the Stable Script

**Files:** Create `go/internal/conformance/fixture.go`, `go/internal/conformance/mock.go`, `go/internal/conformance/conformance_test.go`, `go/scripts/conformance`.

**Interfaces:** Consumes every shared case and mock control route exactly as defined by `docs/superpowers/plans/2026-09-10-shared-conformance.md`; produces executable `go/scripts/conformance` with the environment contract above.

- [ ] **Step 1: Write failing script/fixture contract checks**

```bash
test -x go/scripts/conformance
CEKAT_CONFORMANCE_BASE_URL=http://127.0.0.1:1 \
CEKAT_CONFORMANCE_CONTROL_URL=http://127.0.0.1:1 \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$PWD/conformance/fixtures/cases" \
  go/scripts/conformance
```

Expected: first command fails because the script is absent. After creating a non-executable test stub, the second command must fail nonzero and identify that the mock is unreachable rather than count cases as passing.

- [ ] **Step 2: Implement fixture loading, runtime recipes, and control client**

Discover every direct `*.json` child of the absolute directory in `CEKAT_CONFORMANCE_FIXTURES` with `os.ReadDir`; reject an empty corpus, subdirectory case files, duplicate fixture IDs, filename/ID mismatches, and any discovered case not accounted for as executed. Decode with `DisallowUnknownFields`; reject unknown schema versions, operation names, properties recipes, response-body recipe units/forms, cancellation phases, mock-response fields/forms, and `expect.result` forms before executing that case. The dispatcher must have exhaustive switches for all forms in the shared plan and must fail rather than skip a required case. For each case, use `CEKAT_CONFORMANCE_ACCESS_TOKEN` to construct the public client, use only `CEKAT_CONFORMANCE_CONTROL_URL` for reset/response-queue/journal calls, and use only `CEKAT_CONFORMANCE_BASE_URL` for ingest. Reset mock state, post the exact `{"responses":[...]}` queue envelope, construct Go-only recipe values, invoke the public client, validate the exact `{"requests":[...]}` journal envelope, then assert error type/message/fields, acknowledgement, attempts, journal length/order, auth, endpoint, and JSON payload. Caller cancellation cases must compare with `errors.Is(err, context.Canceled/DeadlineExceeded)` and reject an SDK wrapper. At suite end compare discovered IDs with executed IDs and fail on any missing, duplicated, unknown, or skipped required case.

- [ ] **Step 3: Add the executable wrapper**

```sh
#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo "conformance accepts no positional arguments" >&2; exit 2; }
: "${CEKAT_CONFORMANCE_BASE_URL:?required}"
: "${CEKAT_CONFORMANCE_CONTROL_URL:?required}"
: "${CEKAT_CONFORMANCE_ACCESS_TOKEN:?required}"
: "${CEKAT_CONFORMANCE_FIXTURES:?required}"
case "$CEKAT_CONFORMANCE_FIXTURES" in /*) ;; *) echo "CEKAT_CONFORMANCE_FIXTURES must be absolute" >&2; exit 2;; esac
cd "$(dirname "$0")/.."
exec go test ./internal/conformance -run '^TestSharedConformance$' -count=1 -v
```

Run `chmod +x go/scripts/conformance`.

- [ ] **Step 4: Run against the shared mock server**

```bash
cd conformance/mock-ingest-server
go build -o /tmp/cekat-mock ./cmd/mock-ingest-server
: > /tmp/cekat-mock.ready
/tmp/cekat-mock --listen 127.0.0.1:0 > /tmp/cekat-mock.ready 2>/tmp/cekat-mock.err & mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true; wait "$mock_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 200); do [ -s /tmp/cekat-mock.ready ] && break; kill -0 "$mock_pid" 2>/dev/null || exit 1; sleep 0.05; done
read -r base_url control_url <<EOF
$(python3 -c 'import json; r=json.loads(open("/tmp/cekat-mock.ready").readline()); print(r["base_url"], r["control_url"])')
EOF
cd ../..
CEKAT_CONFORMANCE_BASE_URL="$base_url" \
CEKAT_CONFORMANCE_CONTROL_URL="$control_url" \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$PWD/conformance/fixtures/cases" \
  go/scripts/conformance
```

Expected: PASS; every applicable fixture ID is printed, no required case is skipped, and the script exits `0`.

- [ ] **Step 5: Commit**

```bash
git add go/internal/conformance go/scripts/conformance
git commit -m "test(go): run shared conformance fixtures"
```

### Task 12: Add Documentation and No-Publish Package Preparation

**Files:** Create `go/README.md`, `go/internal/packageprep/main.go`, `go/internal/packageprep/main_test.go`, `go/scripts/package`; update `go/COMPATIBILITY.md` only with fresh verification evidence.

**Interfaces:** Produces user guidance and `go/scripts/package --version 0.1.0 --output <absolute-directory>` with the approved manifest schema.

- [ ] **Step 1: Write failing package-tool and README contract tests**

Test exact version acceptance, rejection of relative output/traversal, deterministic sorted artifact paths, lowercase SHA-256, accurate byte size, no publish/sign command, and token-free output. Add a README test that requires examples for client construction, each middleware, explicit context, errors.As, cancellation, retries/duplicate risk, queue acknowledgement, and background identity-only events.

- [ ] **Step 2: Run focused tests and missing-script checks**

```bash
cd go && go test ./internal/packageprep -count=1
test -x scripts/package
grep -F 'github.com/cekataiofficial/cekat-event-sdk-go' README.md
```

Expected: FAIL because the tool, executable script, and README do not exist.

- [ ] **Step 3: Implement deterministic source preparation and wrapper**

`packageprep` writes `cekat-event-sdk-go-v0.1.0.zip` under the absolute output directory from module files tracked by Git, with slash-normalized archive paths rooted at `github.com/cekataiofficial/cekat-event-sdk-go@v0.1.0/`. Exclude `.git`, generated output, and credentials. It then writes the approved manifest with sorted relative artifact paths and hashes the completed archive. The wrapper validates exact arguments, runs `go test ./...` and `go vet ./...`, then invokes `go run ./internal/packageprep`; it contains no registry, signing, tag, or push command.

- [ ] **Step 4: Verify package and full module**

```bash
chmod +x go/scripts/package
cd go
find . -name '*.go' -type f -exec gofmt -w {} +
go mod tidy
git diff --exit-code -- go.mod go.sum
go vet ./...
go test ./...
go test -race ./...
go test -shuffle=on -count=20 ./...
out="$(mktemp -d)"
scripts/package --version 0.1.0 --output "$out"
python3 - "$out/manifest.json" <<'PY'
import hashlib, json, pathlib, sys
manifest = json.load(open(sys.argv[1]))
assert manifest["schema_version"] == 1
assert manifest["language"] == "go" and manifest["version"] == "0.1.0"
assert [x["path"] for x in manifest["artifacts"]] == sorted(x["path"] for x in manifest["artifacts"])
root = pathlib.Path(sys.argv[1]).parent
for item in manifest["artifacts"]:
    data = (root / item["path"]).read_bytes()
    assert len(data) == item["size_bytes"]
    assert hashlib.sha256(data).hexdigest() == item["sha256"]
PY
```

Expected: formatting and module metadata are already clean, every vet/test command passes, package exits `0`, manifest validation passes, the archive exists, and no publication occurs.

- [ ] **Step 5: Re-run release-time evidence gates immediately before approval**

```bash
curl -fsSL 'https://go.dev/dl/?mode=json' > /tmp/cekat-go-releases-release.json
cd go
go list -m -u -json all
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...
```

Expected: all commands exit `0`; no unresolved vulnerability affects the selected runtime/dependencies. Append the date, outputs, changed support status, and resulting decision to `COMPATIBILITY.md`; rerun the full checks and rebuild artifacts if any selected version changes. Registry ownership, tag creation, signing, and publishing remain external release-owner gates.

- [ ] **Step 6: Commit**

```bash
git add go/README.md go/COMPATIBILITY.md go/internal/packageprep go/scripts/package
git commit -m "build(go): add package readiness and documentation"
```

## Final Acceptance Gate

- [ ] Run `git status --short` and confirm only intentionally uncommitted cross-plan files appear; the Go implementation itself is committed.
- [ ] Run `cd go && go vet ./... && go test ./... && go test -race ./...`; expect all commands to pass.
- [ ] Run the shared mock command from Task 11 and `go/scripts/conformance`; expect every required Go case to pass.
- [ ] Run `go/scripts/package --version 0.1.0 --output "$(mktemp -d)"`; expect a validated archive/manifest and no publication or signing.
- [ ] Review exported documentation with `cd go && go doc ./...`; expect all public functions and types to be discoverable and the queue-acceptance/duplicate-risk caveats to be explicit.
