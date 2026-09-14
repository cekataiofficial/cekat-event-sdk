# Shared Protocol and Conformance Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).



> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the language-neutral wire contract, fixtures, and Go standard-library mock ingest server that every SDK uses for conformance, without implementing any SDK.

**Architecture:** JSON Schema Draft 2020-12 files define wire envelopes, fixtures, mock controls, and journals. One JSON file represents each observable case; language runners translate only explicitly named runtime recipes such as a cycle or caller cancellation. A deterministic Go HTTP server queues scripted responses, journals normalized requests, and exposes localhost control endpoints while the future root runner invokes one stable executable per language.

**Tech Stack:** JSON Schema Draft 2020-12, Go standard library for the server, `github.com/santhosh-tekuri/jsonschema/v6` for test-only schema validation, POSIX shell for contract checks.

**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`

## Global Constraints

- The only ingest path is `POST /api/events/ingest`; the production origin remains `https://server.cekat.ai`.
- Authorization is `Bearer <access_token>`; fixtures and journals must never place a real token in expected diagnostics.
- Default timeout is 10 seconds **per network attempt**. Caller cancellation bounds the full operation and interrupts request/backoff where the runtime supports it.
- Default retry count is 2 after the initial attempt. Retry only transport failures, eligible timeouts while caller cancellation is inactive, and HTTP `500`.
- Full-jitter bounds are `[0,100ms]` before retry 1 and `[0,200ms]` before retry 2.
- Any received HTTP response has known delivery outcome, including exhausted `500` and malformed `200`; transport failure or SDK timeout after request execution begins has unknown outcome.
- Retain at most the first 65,536 response bytes. Text APIs decode an incomplete/invalid UTF-8 boundary with replacement; byte APIs may additionally expose the exact retained bytes.
- A valid `200` is exactly a top-level object with `success: true` and a `data` object containing `success: true`, non-empty string `message`, non-empty string `event_key`, and `validated_properties` as an array of strings. Additional fields are ignored.
- A conforming non-`200` error body is `{"success":false,"error":"non-empty","code":"optional"}`. Malformed error bodies retain status classification and bounded body and synthesize the HTTP reason phrase; only malformed `200` is a response-decoding error.
- Properties recursively allow only JSON null, booleans, strings, finite numbers, arrays, and string-keyed objects. Integers must be within `[-9007199254740991, 9007199254740991]`; cycles and runtime-specific objects are rejected before networking.
- Header `X-Cekat-Visitor-ID` precedes cookie `_cekat_visitor_id`. Visitor IDs are trimmed for emptiness and transmission. Blank explicit visitor ID falls back to ambient context; nonblank explicit visitor ID precedes context.
- Identity strings are trimmed only to test emptiness and otherwise remain byte-for-byte unchanged.
- The mock executable uses only the Go standard library. The JSON Schema validator is test-only.
- At execution time and again before release, verify supported runtime/dependency versions from official sources. Do not substitute projected patch versions.

---

## Exact File Map

Create the following files; no SDK directory is changed by this plan.

```text
conformance/
├── README.md                                      # fixture semantics, runner contract, mock API
├── COMPATIBILITY.md                               # dated execution/release verification evidence
├── fixtures/
│   ├── schemas/
│   │   ├── json-value.schema.json                 # recursive interoperable JSON domain
│   │   ├── event-payload.schema.json              # exact outgoing wire payload
│   │   ├── success-envelope.schema.json           # nested HTTP 200 envelope
│   │   ├── error-envelope.schema.json             # top-level non-200 envelope
│   │   ├── mock-response-queue.schema.json         # POST /__control/responses input
│   │   ├── request-journal.schema.json             # GET /__control/requests output
│   │   └── conformance-case.schema.json            # common case DSL
│   └── cases/
│       ├── request-common-user-registration.json
│       ├── request-common-user-login.json
│       ├── request-common-order-created.json
│       ├── request-common-order-paid.json
│       ├── request-custom-event.json
│       ├── request-header-over-cookie.json
│       ├── request-cookie-fallback.json
│       ├── request-explicit-over-context.json
│       ├── request-blank-explicit-falls-back.json
│       ├── request-trims-visitor.json
│       ├── request-preserves-identity-whitespace.json
│       ├── validation-blank-event-key.json
│       ├── validation-missing-identity.json
│       ├── validation-properties-nan.json
│       ├── validation-properties-positive-infinity.json
│       ├── validation-properties-negative-infinity.json
│       ├── validation-properties-unsafe-integer-high.json
│       ├── validation-properties-unsafe-integer-low.json
│       ├── validation-properties-cycle.json
│       ├── validation-properties-non-string-key.json
│       ├── validation-properties-runtime-object.json
│       ├── success-valid.json
│       ├── success-malformed-outer-false.json
│       ├── success-malformed-data-success-missing.json
│       ├── success-malformed-data-success-false.json
│       ├── success-malformed-blank-message.json
│       ├── success-malformed-blank-event-key.json
│       ├── success-malformed-validated-properties-object.json
│       ├── success-malformed-validated-property-non-string.json
│       ├── success-malformed-json.json
│       ├── success-bounded-multibyte-body.json
│       ├── error-400-structured.json
│       ├── error-401-structured.json
│       ├── error-404-structured.json
│       ├── error-malformed-body.json
│       ├── error-bounded-multibyte-body.json
│       ├── retry-500-500-success.json
│       ├── retry-disconnect-disconnect-success.json
│       ├── retry-timeout-timeout-success.json
│       ├── retry-mixed-final-500.json
│       ├── retry-mixed-final-transport.json
│       ├── retry-no-400.json
│       ├── retry-no-401.json
│       ├── retry-no-404.json
│       ├── retry-no-429.json
│       ├── cancellation-before-request.json
│       ├── cancellation-during-request.json
│       └── cancellation-during-backoff.json
└── mock-ingest-server/
    ├── go.mod
    ├── go.sum
    ├── cmd/mock-ingest-server/main.go              # flags, readiness record, signal shutdown
    ├── cmd/mock-ingest-server/main_test.go
    └── internal/
        ├── contract/schema_test.go                 # compile schemas and validate every fixture
        ├── contract/fixtures_test.go               # IDs, coverage, recipe invariants
        ├── server/server.go                        # HTTP routes and normalized journal
        ├── server/server_test.go
        ├── state/state.go                          # synchronized FIFO response queue/journal
        └── state/state_test.go
```

## Interfaces

### Fixture DSL

`conformance-case.schema.json` exposes this exact language-neutral model:

```text
Case {
  schema_version: 1
  id: string
  description: non-empty string
  kind: "request" | "validation" | "success" | "error" | "retry" | "cancellation"
  applicability?: {
    requires_capabilities: non-empty unique subset of ["caller_cancellation"],
    inapplicable_languages: unique subset of
      ["go", "node", "python", "php", "java", "dotnet", "ruby"]
  }
  client?: { timeout_ms?: positive integer, retry_count?: non-negative integer }
  inbound?: {
    header_visitor_id?: string,
    cookie_visitor_id?: string,
    ambient_visitor_id?: string
  }
  operation: {
    name: "user_registration" | "user_login" | "order_created" | "order_paid" | "custom_event",
    event_key?: string,
    event: { email?: string, phone_number?: string, contact_name?: string,
             visitor_id?: string, properties?: JSONValue },
    properties_recipe?: "nan" | "positive_infinity" | "negative_infinity" |
      "unsafe_integer_high" | "unsafe_integer_low" | "cycle" |
      "non_string_key" | "runtime_object"
  }
  responses?: MockResponse[]
  response_body_recipe?: {
    unit: string,
    minimum_utf8_bytes: integer >= 65537,
    suffix: string
  }
  cancellation?: { phase: "before_request" | "during_request" | "during_backoff" }
  expect: {
    result: "acknowledgement" | "validation_error" | "authentication_error" |
      "event_definition_not_found_error" | "api_error" |
      "transport_error" | "response_decode_error" | "caller_cancelled",
    attempts: integer >= 0,
    delivery_outcome_unknown?: boolean,
    acknowledgement?: { success: true, message: string, event_key: string,
                          validated_properties: string[] },
    status?: integer,
    error_message?: non-empty string,
    server_error?: string,
    server_code?: string,
    retained_body_bytes?: integer 0..65536,
    request?: { path: "/api/events/ingest", authorization: "Bearer conformance-token",
                payload: EventPayload },
    jitter_bounds_ms?: [[0,100], [0,200]]
  }
}
```

`properties_recipe` is mutually exclusive with literal `event.properties`. Each SDK test builder creates the named non-JSON runtime value; no recipe is serialized onto the wire. `response_body_recipe` is expanded by a runner into a UTF-8 response string before posting the ordinary mock response queue.

`applicability` is a closed, schema-validated declaration, not a runner-selected skip. The language vocabulary is exactly `go`, `node`, `python`, `php`, `java`, `dotnet`, and `ruby`; the v1 capability vocabulary is exactly `caller_cancellation`. The approved capability table grants `caller_cancellation` to Go, Node.js, Python, Java, and .NET, and does not grant it to synchronous-v1 PHP or Ruby. For each declared requirement, `inapplicable_languages` must equal exactly the languages absent from the approved capability table: no capable language may be excluded, and no incapable language may be omitted. A case without `applicability` applies to all seven languages. Schema and semantic tests reject unknown language/capability values, an empty `requires_capabilities`, duplicate values, an exclusion inconsistent with the table, and any runner claim of inapplicability not declared by the fixture. The three cancellation fixtures therefore use exactly `{"requires_capabilities":["caller_cancellation"],"inapplicable_languages":["php","ruby"]}`. This makes Ruby v1 explicitly inapplicable while keeping every language with approved native cancellation applicable; it does not remove Ruby's configured Net::HTTP request-timeout support or invent caller cancellation.

### Mock HTTP API

```text
POST /__control/reset
  request: empty
  response: 204, clears queue and journal atomically

POST /__control/responses
  request: {"responses":[MockResponse, ...]}
  response: 204, replaces the remaining queue without clearing journal

GET /__control/requests
  response: {"requests":[JournalEntry, ...]}

POST /api/events/ingest
  consumes one queued response FIFO after journaling the request;
  empty queue returns the canonical 200 success envelope
```

```text
MockResponse {
  status: integer 200..599 (required unless disconnect_before_headers is true),
  headers?: object<string,string>,
  body: string,
  delay_ms?: non-negative integer,
  disconnect_before_headers?: boolean
}
JournalEntry {
  sequence: positive integer,
  method: string,
  path: string,
  headers: object<lowercase string,string[]>,
  body: string
}
```

A disconnect entry is journaled before the HTTP/1.x connection is hijacked and closed. Delay occurs after journaling and before headers. Control routes never consume queued ingest responses and are never journaled.

### Process interface

```bash
go run ./cmd/mock-ingest-server --listen 127.0.0.1:0
```

The first stdout line is one compact readiness record and stdout contains no other records:

```json
{"base_url":"http://127.0.0.1:43127","control_url":"http://127.0.0.1:43127"}
```

The process exits `0` after `SIGINT`/`SIGTERM`, shutting down with a five-second deadline.

### Per-language conformance interface consumed by the root CI plan

Each language plan must create executable `<language>/scripts/conformance` for `go`, `node`, `python`, `php`, `java`, `dotnet`, and `ruby`. The script accepts no positional arguments and requires exactly these four `CEKAT_CONFORMANCE_*` inputs (it must not read aliases, defaults, repository-relative fixture paths, or additional conformance variables):

```text
CEKAT_CONFORMANCE_BASE_URL       absolute mock origin, no path
CEKAT_CONFORMANCE_CONTROL_URL    same-process control origin
CEKAT_CONFORMANCE_ACCESS_TOKEN   always conformance-token in CI
CEKAT_CONFORMANCE_FIXTURES       absolute path to conformance/fixtures/cases
```

The runner discovers and schema-validates every `*.json` file directly in the supplied cases directory; explicit filename allowlists are forbidden. Before classifying or running a case, it rejects missing inputs, an unknown `schema_version`, language, capability, operation name, properties recipe, response-body recipe, cancellation phase, mock-response form, or `expect.result` form and prints the case ID. Each runner has one fixed language identity and the capabilities from the approved table above. It emits one machine-readable record for every discovered case with `id` and status exactly `passed` or `not_applicable`; `not_applicable` also names the declared required capability and is valid only when that runner's language appears in the fixture's `inapplicable_languages`. Ordinary test-framework `skipped`, `pending`, `ignored`, or `unsupported` results are never aliases for `not_applicable` and make the run fail. Exit `0` means every discovered applicable case passed, every declared inapplicable case was validated and reported `not_applicable`, and the discovered IDs equal the disjoint union of those two sets. Any unknown form, undeclared inapplicability, undiscovered/duplicate/unaccounted case, ordinary skip, or applicable case without an executed passing assertion exits nonzero. Root orchestration starts one isolated mock process per language runner; shared control state is never used concurrently across languages.

---

### Task 1: Verify Toolchain Sources and Bootstrap Schema Tests

**Files:**
- Create: `conformance/COMPATIBILITY.md`
- Create: `conformance/mock-ingest-server/go.mod`
- Create: `conformance/mock-ingest-server/internal/contract/schema_test.go`

**Interfaces:**
- Consumes: repository design and the runtime policy in Global Constraints.
- Produces: a Go module whose server imports only standard-library packages and whose tests compile Draft 2020-12 schemas from `conformance/fixtures/schemas`.

- [ ] **Step 1: Record execution-time source evidence before selecting versions**

Run:

```bash
mkdir -p conformance/mock-ingest-server/internal/contract
curl -fsSL 'https://go.dev/VERSION?m=text'
go version
go list -m -versions github.com/santhosh-tekuri/jsonschema/v6
```

Expected: all commands exit `0`; the first output names the current official Go release, the second names the installed toolchain, and the third returns one or more `v6` versions. Record the date, complete outputs, selected Go major/minor, test-library version, source URLs, and compatibility rationale in `conformance/COMPATIBILITY.md`. Stop execution if the selected Go release cannot satisfy the maintained/LTS and approximately-five-year policy.

- [ ] **Step 2: Initialize the module and pin the verified test dependency**

Run from `conformance/mock-ingest-server`:

```bash
go mod init github.com/cekataiofficial/cekat-event-sdk/conformance/mock-ingest-server
SCHEMA_VERSION="$(go list -m -versions github.com/santhosh-tekuri/jsonschema/v6 | awk '{print $NF}')"
test -n "$SCHEMA_VERSION"
go get "github.com/santhosh-tekuri/jsonschema/v6@$SCHEMA_VERSION"
```

Expected: exit `0`; `go.mod` contains the module path, the verified Go directive, and the schema library as a test dependency after tests are added. The future server package must have no non-standard import.

- [ ] **Step 3: Write the failing schema discovery test**

Add a table of the seven exact schema filenames from the file map. For each path, use `jsonschema.NewCompiler()`, add the file URI, and compile it. Also assert `$schema` equals `https://json-schema.org/draft/2020-12/schema` and `$id` is `https://schemas.cekat.ai/event-sdk/conformance/<filename>`.

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/contract -run TestSchemasCompile -count=1
```

Expected: FAIL listing `json-value.schema.json` as missing.

- [ ] **Step 4: Create all seven schema files with closed control/fixture shapes**

Use `additionalProperties: false` for control records and fixture DSL objects. Wire envelope schemas allow additional server fields. Define reusable JSON values recursively:

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://schemas.cekat.ai/event-sdk/conformance/json-value.schema.json",
  "$defs":{"value":{"oneOf":[
    {"type":"null"},{"type":"boolean"},{"type":"string"},
    {"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},
    {"type":"number","not":{"type":"integer"}},
    {"type":"array","items":{"$ref":"#/$defs/value"}},
    {"type":"object","additionalProperties":{"$ref":"#/$defs/value"}}
  ]}},
  "$ref":"#/$defs/value"
}
```

JSON syntax already excludes NaN and infinities. `event-payload` requires `event_key`, `is_common`, and at least one of `email`/`phone_number`; it permits only the seven approved payload keys and references `json-value` for property values. Encode the exact nested success envelope and top-level error envelope from Global Constraints.

- [ ] **Step 5: Run and commit**

Run:

```bash
cd conformance/mock-ingest-server
go test ./internal/contract -run TestSchemasCompile -count=1
go mod tidy
git diff --check
```

Expected: PASS; tidy preserves only the test validator dependency; diff check prints nothing.

```bash
git add conformance/COMPATIBILITY.md conformance/fixtures/schemas conformance/mock-ingest-server/go.mod conformance/mock-ingest-server/go.sum conformance/mock-ingest-server/internal/contract/schema_test.go
git commit -m "test: define shared conformance schemas"
```

### Task 2: Add Request and Validation Fixtures

**Files:**
- Create: the twenty-one `request-*` and `validation-*` files listed in the file map
- Create: `conformance/mock-ingest-server/internal/contract/fixtures_test.go`
- Modify: `conformance/mock-ingest-server/internal/contract/schema_test.go`

**Interfaces:**
- Consumes: `conformance-case.schema.json`, `event-payload.schema.json`.
- Produces: request precedence, wrapper, identity validation, and invalid-runtime-value cases used unchanged by all SDK plans.

- [ ] **Step 1: Write failing fixture validation and uniqueness tests**

Discover only `fixtures/cases/*.json`; validate each against the case schema; require filename stem equals `id`, `schema_version == 1`, and globally unique IDs. Recursively inspect string values and reject any case containing an authorization value other than the exact fixture value `Bearer conformance-token`; use ordinary string comparisons because Go regular expressions do not support lookahead.

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/contract -run 'TestCasesValidate|TestCaseIDsAndTokens' -count=1
```

Expected: FAIL because no case files exist.

- [ ] **Step 2: Add exact request cases**

Use `conformance-token` and expected path `/api/events/ingest`. Assert common wrappers set their fixed key with `is_common:true`; custom uses its supplied nonblank key and `is_common:false`. Include nested arrays/objects, null, booleans, finite decimal, and safe-range boundary integers. The visitor cases assert: header over cookie, cookie fallback, explicit over ambient, blank explicit fallback, and trimming before transmission. The identity whitespace case expects original email/phone strings unchanged.

- [ ] **Step 3: Add exact local validation cases**

`validation-blank-event-key` and `validation-missing-identity` expect `attempts:0`, no request, and `validation_error`. Add one file for each of the eight `properties_recipe` names from Interfaces; each expects local validation and zero attempts. The fixture test must require that recipe set exactly, preventing a language runner from omitting cycles or unsafe integers.

- [ ] **Step 4: Run and commit**

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/contract -count=1
git diff --check
```

Expected: PASS with twenty-one case files discovered, all five operation names covered, and all required invalid recipes present.

```bash
git add conformance/fixtures/cases conformance/mock-ingest-server/internal/contract
git commit -m "test: add shared request and validation cases"
```

### Task 3: Add Response, Retry, Body-Bound, and Cancellation Fixtures

**Files:**
- Create: the twenty-seven `success-*`, `error-*`, `retry-*`, and `cancellation-*` files listed in the file map
- Modify: `conformance/mock-ingest-server/internal/contract/fixtures_test.go`

**Interfaces:**
- Consumes: fixture DSL and `MockResponse` queue shape.
- Produces: typed-result, attempts, certainty, jitter, cancellation phase, closed applicability, and bounded-body assertions for SDK runners.

- [ ] **Step 1: Add failing semantic coverage test**

Require the fixture corpus to contain: canonical success; malformed `200`; each typed HTTP status; malformed non-`200`; exact 65,536-byte bounds; retryable `500`, disconnect, and timeout; mixed final failure; permanent no-retry; and all three cancellation phases. Validate every retry case has `attempts <= retry_count + 1`. Validate the closed language/capability table, require cases without `applicability` to apply to all seven languages, and reject unknown values or any `inapplicable_languages` set that differs from the languages lacking the declared capability.

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/contract -run TestRequiredBehaviorCoverage -count=1
```

Expected: FAIL naming `success-valid` first.

- [ ] **Step 2: Add success and HTTP error cases**

The canonical queued body is:

```json
{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}
```

Malformed success cases cover outer false, absent/false `data.success`, blank message, blank event key, non-array validated properties, non-string array entries, and invalid JSON; all expect `response_decode_error`, the actual attempt count, and `delivery_outcome_unknown:false`. Structured `400`, `401`, and `404` use:

```json
{"success":false,"error":"defined server error","code":"fixture_code"}
```

They expect `api_error`, `authentication_error`, and `event_definition_not_found_error` respectively. Every HTTP-error fixture with result `api_error`, `authentication_error`, or `event_definition_not_found_error` must contain a non-empty `expect.error_message`, and the case schema makes that field conditionally required for those three result forms. For a structured envelope, `error_message` equals the envelope's `error`; for a malformed non-`200`, it equals the synthesized standard reason-phrase/status-text message. Malformed non-`200` expects status-based classification, no `server_error` or `server_code`, the exact `error_message`, bounded body, and never `response_decode_error`. Every runner asserts the caller-visible message exactly.

- [ ] **Step 3: Add deterministic retry and cancellation cases**

Use FIFO response arrays. `retry-500-500-success` expects three requests and jitter bounds `[[0,100],[0,200]]`. Disconnect uses `disconnect_before_headers:true`; timeout uses `delay_ms` greater than a fixture `timeout_ms` of 25. Mixed cases assert the **final** failure type. Permanent statuses `400`, `401`, `404`, and `429` each expect one attempt. Each of the three cancellation cases includes exactly `"applicability":{"requires_capabilities":["caller_cancellation"],"inapplicable_languages":["php","ruby"]}` and expects `caller_cancelled` and no retry when applicable: zero attempts before request, one journaled delayed request during request, and one completed `500` before a runner-controlled interruptible backoff. The fixture invariant test proves Ruby is explicitly excluded, all five languages with approved native cancellation remain applicable, and no runner can declare a fourth case inapplicable.

- [ ] **Step 4: Add exact byte-bound recipes**

For each body-bound case, set `response_body_recipe` to `{"unit":"€","minimum_utf8_bytes":65537,"suffix":"END"}`. Runners repeat the UTF-8 unit until the minimum is met, append suffix, and post the resulting string. Expect exactly 65,536 retained bytes; text exposure must end with U+FFFD when truncation splits the three-byte unit. The fixture invariant test reconstructs the bytes and proves length, split boundary, and expectation.

- [ ] **Step 5: Run and commit**

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/contract -count=1
git diff --check
```

Expected: PASS with all 48 total case files valid, all three cancellation fixtures carrying the exact capability-based applicability declaration, and every required semantic category covered.

```bash
git add conformance/fixtures/cases conformance/mock-ingest-server/internal/contract/fixtures_test.go
git commit -m "test: specify response retry and cancellation conformance"
```

### Task 4: Implement Atomic Queue and Journal State

**Files:**
- Create: `conformance/mock-ingest-server/internal/state/state.go`
- Create: `conformance/mock-ingest-server/internal/state/state_test.go`

**Interfaces:**
- Consumes: `MockResponse` and `JournalEntry` shapes.
- Produces: `New() *State`, `Reset()`, `ReplaceResponses([]ResponseSpec)`, `Record(RequestRecord)`, `NextResponse() (ResponseSpec, bool)`, and `Requests() []RequestRecord`; all methods are concurrency-safe and return/capture defensive copies.

- [ ] **Step 1: Write failing FIFO/reset/copy/concurrency tests**

Tests require replacement rather than append, monotonic sequence numbers beginning at 1, reset of both queue and sequence, immutable snapshots, and 100 concurrent records detectable under the race detector.

Run:

```bash
cd conformance/mock-ingest-server && go test -race ./internal/state -count=1
```

Expected: FAIL because package `internal/state` has no implementation.

- [ ] **Step 2: Implement the minimal mutex-protected state**

Use one `sync.Mutex`. Copy header maps/slices and response slices on entry and exit. `Record` assigns sequence while holding the lock. `NextResponse` removes index zero and clears the vacated slot before shortening the slice.

- [ ] **Step 3: Run and commit**

Run:

```bash
cd conformance/mock-ingest-server && go test -race ./internal/state -count=1
```

Expected: PASS with no race report.

```bash
git add conformance/mock-ingest-server/internal/state
git commit -m "feat: add mock response and journal state"
```

### Task 5: Implement Control and Ingest HTTP Behavior

**Files:**
- Create: `conformance/mock-ingest-server/internal/server/server.go`
- Create: `conformance/mock-ingest-server/internal/server/server_test.go`

**Interfaces:**
- Consumes: `*state.State`.
- Produces: `server.New(*state.State) http.Handler`; exact routes and normalization defined in Mock HTTP API.

- [ ] **Step 1: Write failing route tests**

Use `httptest.NewServer`. Assert method/path rejection, 204 reset/replace, schema-conforming journal JSON, lowercase header names with all values, unchanged request body, FIFO responses, canonical empty-queue success, delay of at least the scripted duration, and disconnect observed as an `io`/EOF transport failure after journaling.

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/server -count=1
```

Expected: FAIL because `server.New` is undefined.

- [ ] **Step 2: Implement control routes with strict decoding**

Reject unknown JSON fields, trailing JSON values, invalid status/header/delay combinations, and a response lacking both valid status and `disconnect_before_headers:true` with `400 application/json`. Never echo request authorization in errors. Return `405` with `Allow` for a known path using the wrong method.

- [ ] **Step 3: Implement ingest journaling and response execution**

Read the request body before `Record`. Normalize header keys with `strings.ToLower`, sort each copied value slice only where order is semantically irrelevant, then consume one queue entry. Sleep with the request context so client cancellation releases the handler. For disconnect, require `http.Hijacker`, flush nothing, close the connection, and return. The canonical default body is the success snippet from Task 3 with `event_key:"conformance_default"` and empty validated properties.

- [ ] **Step 4: Validate races and schemas, then commit**

Run:

```bash
cd conformance/mock-ingest-server
go test -race ./internal/server ./internal/state -count=1
go test ./internal/contract -count=1
git diff --check
```

Expected: PASS, no race report, no diff errors.

```bash
git add conformance/mock-ingest-server/internal/server
git commit -m "feat: add mock ingest and control HTTP API"
```

### Task 6: Add the Runnable Mock Server Process

**Files:**
- Create: `conformance/mock-ingest-server/cmd/mock-ingest-server/main.go`
- Create: `conformance/mock-ingest-server/cmd/mock-ingest-server/main_test.go`

**Interfaces:**
- Consumes: `server.New(state.New())`.
- Produces: the process/readiness/signal interface defined above.

- [ ] **Step 1: Write failing subprocess tests**

Build the command to a temporary path, launch with `--listen 127.0.0.1:0`, parse exactly one readiness line, call reset/queue/ingest/journal, send `SIGTERM`, and require exit `0` within six seconds. A separate test starts two processes and proves queue/journal isolation.

Run:

```bash
cd conformance/mock-ingest-server && go test ./cmd/mock-ingest-server -count=1
```

Expected: FAIL because the command has no source.

- [ ] **Step 2: Implement flags, readiness, and graceful shutdown**

Use `net.Listen`, `http.Server`, `signal.NotifyContext`, and `Shutdown` with a five-second context. Marshal the readiness object with `json.Encoder` only after the listener succeeds. Diagnostics go to stderr and must not contain request headers or bodies.

- [ ] **Step 3: Run the complete server suite and commit**

Run:

```bash
cd conformance/mock-ingest-server
go test -race ./... -count=1
go vet ./...
git diff --check
```

Expected: all packages PASS, no race report, `go vet` and diff check print no findings.

```bash
git add conformance/mock-ingest-server/cmd
git commit -m "feat: add conformance mock server command"
```

### Task 7: Document the Shared Contract and Language Runner Boundary

**Files:**
- Create: `conformance/README.md`
- Modify: `conformance/mock-ingest-server/internal/contract/fixtures_test.go`

**Interfaces:**
- Consumes: all schemas, fixtures, and mock process behavior.
- Produces: the normative handoff for every language SDK plan and the root CI/release plan.

- [ ] **Step 1: Add a failing documentation contract test**

Require `conformance/README.md` to contain the four environment variables, all seven `<language>/scripts/conformance` paths, fixed endpoint, timeout/retry/jitter constants, 65,536-byte rule, success/error examples, mock endpoints, cancellation phase and applicability semantics, and the rule that unknown or applicable cases cannot be skipped while schema-declared `not_applicable` remains separately accounted.

Run:

```bash
cd conformance/mock-ingest-server && go test ./internal/contract -run TestConformanceReadmeContract -count=1
```

Expected: FAIL because `conformance/README.md` does not exist.

- [ ] **Step 2: Write the README as an executable consumer guide**

Include exact commands:

```bash
cd conformance/mock-ingest-server
go run ./cmd/mock-ingest-server --listen 127.0.0.1:0

CEKAT_CONFORMANCE_BASE_URL="$BASE_URL" \
CEKAT_CONFORMANCE_CONTROL_URL="$BASE_URL" \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$(pwd)/../../conformance/fixtures/cases" \
../../go/scripts/conformance
```

State that `go` is replaced by each of the other six language directory names, not that their internal build commands are shared. Document discovery of every case JSON file, rejection of every unknown schema version/recipe/operation/result form, fixture expansion, mock reset before each case, journal assertion after each case, exact assertion of `expect.error_message` for HTTP errors, native caller-cancellation propagation, response certainty, and token redaction. Make clear the server simulates transport behavior but does not decide SDK error types.

- [ ] **Step 3: Run and commit**

Run:

```bash
cd conformance/mock-ingest-server
go test ./internal/contract -count=1
git diff --check
```

Expected: PASS and no diff errors.

```bash
git add conformance/README.md conformance/mock-ingest-server/internal/contract/fixtures_test.go
git commit -m "docs: define shared conformance runner contract"
```

### Task 8: Final Validation and Release-Time Version Gate

**Files:**
- Modify only if verification evidence changed: `conformance/COMPATIBILITY.md`

**Interfaces:**
- Consumes: complete shared contract deliverable.
- Produces: acceptance evidence for language-plan execution and a repeatable release gate; produces no SDK artifact.

- [ ] **Step 1: Re-run official-source checks at release preparation time**

Run:

```bash
curl -fsSL 'https://go.dev/VERSION?m=text'
go version
go list -m -versions github.com/santhosh-tekuri/jsonschema/v6
go list -m -u -json all
```

Expected: exit `0`. Append a dated release-verification section to `conformance/COMPATIBILITY.md` only when performing release preparation. Stop release preparation if the selected runtime is unsupported, the test dependency has a relevant security issue, or the documented outputs no longer match the supported matrix; update and rerun the full suite through review rather than silently taking a new version.

- [ ] **Step 2: Run all acceptance checks**

Run:

```bash
cd conformance/mock-ingest-server
go mod tidy
git diff --exit-code -- go.mod go.sum
go test -race ./... -count=1
go vet ./...
cd ../..
git diff --check
git status --short
```

Expected: module files remain unchanged after tidy; every test passes under the race detector; vet and diff check print nothing; status lists only files owned by `docs/superpowers/plans/2026-09-10-shared-conformance.md` and no SDK files.

- [ ] **Step 3: Smoke-test the compiled binary**

Run:

```bash
cd conformance/mock-ingest-server
go build -o "$(mktemp -d)/mock-ingest-server" ./cmd/mock-ingest-server
go test ./cmd/mock-ingest-server -run TestProcessContract -count=1
```

Expected: build exits `0`; process contract test passes, including readiness, controls, ingest, journal, and signal shutdown.

- [ ] **Step 4: Commit any release-gate evidence change**

If `conformance/COMPATIBILITY.md` changed:

```bash
git add conformance/COMPATIBILITY.md
git commit -m "docs: record conformance release verification"
```

Expected: commit contains only the dated compatibility evidence. If it did not change, make no empty commit.

## Dependencies Consumed by Language Plans

1. All runners discover and validate every `*.json` file in the supplied `CEKAT_CONFORMANCE_FIXTURES` directory and fail with the case ID on an unknown schema/applicability value, properties recipe, response-body recipe, cancellation phase, operation, mock-response form, expected-result form, duplicate/unaccounted case, undeclared inapplicability, or ordinary skip; every discovered case is reported exactly once as passed or schema-declared `not_applicable`.
2. Every SDK uses the same fixed endpoint, payload keys, nested success decoder, top-level error decoder, body byte cap, retry eligibility, jitter bounds, and outcome-certainty expectations encoded here.
3. Language unit tests may inject clocks/random sources/transports to make backoff and runtime recipes deterministic; their public APIs remain ecosystem-idiomatic.
4. Framework adapter tests consume request/visitor cases but add native cleanup and concurrency assertions in their own plans.
5. The root CI plan owns `scripts/conformance.sh`, process orchestration, and the seven-language matrix. It invokes only the four-environment-variable script contract defined here.
6. Package preparation and registry publication are outside this plan; this plan emits no package and stores no credentials.
