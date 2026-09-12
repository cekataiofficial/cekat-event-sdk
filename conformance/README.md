# Shared conformance contract

This directory is the normative, language-neutral handoff for the seven Cekat Event SDKs and the root CI runner. It defines the fixture corpus, schemas, mock process, and the boundary that each language runner must implement. It does not define language-specific build commands or SDK error classes.

The production target is `POST https://server.cekat.ai/api/events/ingest`. SDKs may configure a base origin, but `POST /api/events/ingest` is fixed and must not be independently configurable. Every request uses `Authorization: Bearer <access_token>` and JSON content.

## Start and stop the mock

From the repository root, launch one mock process for one language runner:

```bash
cd conformance/mock-ingest-server
go run ./cmd/mock-ingest-server --listen 127.0.0.1:0
```

Wait for the first and only stdout line before launching a runner. It is compact JSON such as:

```json
{"base_url":"http://127.0.0.1:43127","control_url":"http://127.0.0.1:43127"}
```

Read `base_url` and `control_url` from that record, set `BASE_URL` to `base_url`, and keep the process alive for the complete runner invocation. The origins are deliberately ephemeral loopback addresses; do not assume a fixed port. The process emits no other stdout records. Send `SIGINT` or `SIGTERM` after the runner exits, wait for exit status `0`, and allow its five-second graceful-shutdown deadline before force-cleaning a failed process. Root orchestration starts an isolated mock process for each language runner and never shares control state between concurrent languages.

For example, after reading the readiness record:

```bash
CEKAT_CONFORMANCE_BASE_URL="$BASE_URL" \
CEKAT_CONFORMANCE_CONTROL_URL="$BASE_URL" \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$(pwd)/../../conformance/fixtures/cases" \
../../go/scripts/conformance
```

The command is intentionally shown from `conformance/mock-ingest-server`, so its fixture and runner paths are relative to that directory. Replace `go` in `../../go/scripts/conformance` with each of the other six language directory names: `node`, `python`, `php`, `java`, `dotnet`, and `ruby`. The seven stable runner entry points are:

```text
go/scripts/conformance
node/scripts/conformance
python/scripts/conformance
php/scripts/conformance
java/scripts/conformance
dotnet/scripts/conformance
ruby/scripts/conformance
```

This replacement names the runner entry point only; it does not make language-internal build, test, package-manager, or runtime commands shared.

## Runner environment boundary

A runner accepts no positional arguments and requires exactly these four non-empty environment variables:

```text
CEKAT_CONFORMANCE_BASE_URL       absolute mock HTTP(S) origin with no path
CEKAT_CONFORMANCE_CONTROL_URL    same-process mock control HTTP(S) origin with no path
CEKAT_CONFORMANCE_ACCESS_TOKEN   conformance-token in CI
CEKAT_CONFORMANCE_FIXTURES       absolute readable path to conformance/fixtures/cases
```

Runners reject missing inputs, aliases, defaults, repository-relative fixture fallbacks, and every additional `CEKAT_CONFORMANCE_*` variable. They do not launch the mock themselves. The access token is test input, not diagnostic data: runner output, errors, fixture assertions, journals used in reports, and mock diagnostics must not disclose the access token or authorization header value beyond the deliberate fixture assertion `Bearer conformance-token`. No real token belongs in this repository.

## Fixture discovery, validation, and accounting

A runner discovers every direct `*.json` file in the absolute directory supplied by `CEKAT_CONFORMANCE_FIXTURES`. Explicit filename allowlists, a fixed expected case count, and nested-file discovery are forbidden. It fails on an empty directory, duplicate ID, filename/ID mismatch, or an unaccounted discovered case.

Before executing a case, the runner schema-validates it against `fixtures/schemas/conformance-case.schema.json` and rejects every unknown or missing schema version, language/capability value, operation, properties recipe, response-body recipe, cancellation phase, queued mock-response field or form, and `expect.result` form. Runtime recipes are fixture instructions: a runner constructs the named non-JSON value locally, and expands `response_body_recipe` to an ordinary response body before posting it to the mock. Recipes are never silently serialized as wire values.

For every discovered case, reset the mock, queue the fixture's expanded responses, configure the SDK from fixture client settings, establish fixture visitor context, dispatch the named operation, and assert the journal after the case. Journal assertions cover request count/attempts, fixed path, fixture authorization, exact payload, normalized headers, and response ordering as the fixture requires. A local validation error has zero attempts and no journal request. HTTP-error assertions compare the caller-visible message exactly to `expect.error_message`; a structured error example is:

```json
{"success":false,"error":"defined server error","code":"fixture_code"}
```

A successful response example is:

```json
{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}
```

A received HTTP response has known delivery outcome, including malformed `200` and exhausted `500`. Transport failure and an SDK timeout after request execution begins have unknown delivery outcome. Preserve the fixture's `delivery_outcome_unknown` expectation rather than inferring success from a missing acknowledgement.

Each runner emits exactly one machine-readable record per discovered ID with status `passed` or `not_applicable`. Unknown fixture forms cannot be skipped. Applicable cases cannot be skipped. Ordinary framework `skipped`, `pending`, `ignored`, `unsupported`, or equivalent outcomes fail the run. A schema-declared `not_applicable` is separately accounted: discovered IDs must equal the disjoint union of executed `passed` IDs and validated `not_applicable` IDs.

Applicability is fixture-declared, never runner-selected. The only capability is `caller_cancellation`; Go, Node.js, Python, Java, and .NET have it, while synchronous-v1 PHP and Ruby do not. Every cancellation fixture declares exactly:

```json
{"requires_capabilities":["caller_cancellation"],"inapplicable_languages":["php","ruby"]}
```

PHP and Ruby must discover, schema-validate, and report each cancellation case once as `not_applicable`, naming the declared required capability. They must not claim a general skip, and their configured request timeouts remain supported. All other languages execute the cases through their native caller-cancellation mechanism. Cancellation phases are `before_request`, `during_request`, and `during_backoff`; native cancellation propagates to request execution or interruptible backoff where the runtime supports it.

## Delivery semantics

The default timeout is **10 seconds per network attempt**. Default retry count is 2 after the initial attempt. Retry only transport failures, eligible timeouts while caller cancellation is inactive, and HTTP `500`. The full-jitter bounds are `[0,100ms]` before retry 1 and `[0,200ms]` before retry 2. Do not retry permanent status cases such as `400`, `401`, `404`, or `429`.

Retain at most 65,536 response bytes. Read one additional byte to determine truncation; decode an incomplete or invalid UTF-8 boundary with replacement for text APIs, while byte APIs may expose a defensive copy of the retained bytes. A malformed `200` is a response-decode error. A malformed non-`200` retains status classification and bounded body and uses the HTTP reason phrase as its error message.

A valid `200` has top-level `success: true` and `data.success: true`, plus non-empty `data.message`, non-empty `data.event_key`, and string-array `data.validated_properties`. Additional server fields are ignored. A conforming non-`200` has `success: false`, non-empty `error`, and optional `code`. SDKs own the mapping to acknowledgement and typed errors; the mock simulates transport behavior but does not decide SDK error types.

Properties admit only recursive JSON null, booleans, strings, finite numbers, arrays, and string-keyed objects. Integers must be within `[-9007199254740991, 9007199254740991]`; cycles and runtime-specific objects fail before networking. Identity strings are trimmed only to test emptiness and otherwise transmit unchanged. For visitor propagation, `X-Cekat-Visitor-ID` precedes cookie `_cekat_visitor_id`; visitor IDs are trimmed for emptiness and transmission. A nonblank explicit visitor ID precedes request-local context, while a blank explicit value falls back to context.

## Mock control API

The mock process is transport simulation only. Controls do not consume ingest responses and are never journaled:

```text
POST /__control/reset
  request: empty
  response: 204; atomically clears the response queue and request journal

POST /__control/responses
  request: {"responses":[MockResponse,...]}
  response: 204; replaces remaining queued responses without clearing the journal

GET /__control/requests
  response: {"requests":[JournalEntry,...]}

POST /api/events/ingest
  journals first, then consumes one queued response FIFO;
  an empty queue returns the canonical 200 success envelope
```

A `MockResponse` has a required `body`, an integer `status` from 200 through 599 unless `disconnect_before_headers:true`, optional string headers, and optional non-negative `delay_ms`. Delay happens after journaling and before headers; a disconnect is journaled before the HTTP/1.x connection closes. Journal entries retain a positive sequence, method, path, lowercase header names with string-array values, and unchanged request body. Reset before each fixture case and inspect this journal after each fixture case.

## Schemas and compatibility evidence

`fixtures/schemas/` contains Draft 2020-12 schemas for JSON values, event payloads, success and error envelopes, mock queue controls, request journals, and conformance cases. The repository's contract tests compile every schema and validate the complete fixture corpus, including closed cancellation applicability and the PHP/Ruby exclusion set.

`COMPATIBILITY.md` records dated official-source evidence for the Go mock-server toolchain and its test-only schema validator. Recheck those official sources at release preparation; do not substitute projected runtime or dependency versions. The mock executable imports only the Go standard library, and the schema validator remains test-only.
