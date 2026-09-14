# Cekat Multilanguage Event SDK Design

**Date:** 2026-09-10

**Status:** Approved design, amended 2026-09-13 (`OrderPaid` amount and currency arguments, event ID and timestamp, retryable statuses, `Retry-After`, 3-second default timeout, `User-Agent`, interrupted-body classification, Go module layout)

**Scope:** Shared contract and first release of the Go, Node.js, Python, PHP, Java, .NET, and Ruby SDKs

## 1. Purpose

Cekat needs backend SDKs that submit identity-bearing customer events while correlating them with the anonymous visitor tracked by the browser SDK. The browser tracker stores its visitor identifier in `_cekat_visitor_id`. For cross-origin customer APIs, browser helpers can propagate it in `X-Cekat-Visitor-ID`.

The backend SDKs must make this correlation available without requiring customers to add a visitor-ID parameter throughout their application. Framework middleware extracts the visitor identifier and establishes request-local state. An event call made in that request then includes the identifier automatically. Once Cekat receives an event containing both an accepted contact identity and a visitor ID, backend processing can link the visitor to that contact. Later asynchronous events need only the contact identity.

This repository is a contract-first monorepo. Each language package remains independently buildable, testable, and publishable while implementing equivalent protocol and error semantics.

## 2. Goals

- Require only an access token to initialize a client.
- Submit events synchronously to Cekat and return a typed acknowledgement or error.
- Carry the browser visitor ID automatically through request-local state.
- Support generic integrations and popular web-framework middleware.
- Provide consistent common-event wrappers and a generic custom-event operation.
- Use bounded retries without claiming idempotency.
- Supply safe browser helpers for cross-origin visitor propagation.
- Verify behavioral consistency through shared conformance fixtures.
- Preserve ecosystem-idiomatic APIs rather than forcing identical syntax.

## 3. Non-goals

The first release will not provide:

- Background or offline delivery queues.
- Batch ingestion.
- Automatic authenticated-user model discovery.
- A separate identify endpoint.
- Automatic profile merging inside an SDK.
- Server-enforced idempotency or delivery-status polling.
- Automatic global browser interception without an explicit allowlist.
- Automatic registry publication.
- Any success guarantee beyond synchronous queue acceptance.

## 4. Authoritative protocol

### 4.1 Endpoint

SDKs send:

```http
POST https://server.cekat.ai/api/events/ingest
Authorization: Bearer <access_token>
Content-Type: application/json
```

The default base URL is `https://server.cekat.ai`. Customers may override the base URL, but `/api/events/ingest` is a fixed SDK path and is not independently configurable.

The access token selects the tenant. SDKs must not send `business_id` in the payload and must never expose the access token in errors, diagnostics, browser bundles, or logs.

### 4.2 Event payload

```json
{
  "event_key": "order_paid",
  "event_id": "9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d",
  "occurred_at": "2026-09-13T01:15:30.250Z",
  "contact_name": "Ada Lovelace",
  "phone_number": "+628123456789",
  "email": "ada@example.com",
  "visitor_id": "visitor-abc123",
  "is_common": true,
  "properties": {
    "order_id": "ord_123"
  }
}
```

Fields:

- `event_key`: required, non-empty event-definition key.
- `event_id`: always sent. A caller-supplied ID is trimmed; otherwise the SDK generates a lowercase random (version 4) UUID once per call. The same value is sent in every retry so the server can deduplicate retried deliveries.
- `occurred_at`: always sent. The caller-supplied time or the time of the SDK call, serialized as UTC RFC 3339 with exactly millisecond precision (truncated), fixed once per call.
- `contact_name`: optional and not an identity by itself.
- `phone_number`: conditionally required identity.
- `email`: conditionally required identity.
- `visitor_id`: optional correlation value.
- `is_common`: SDK convention only.
- `properties`: optional string-keyed JSON-compatible object.

At least one non-empty `email` or `phone_number` is required. The SDK validates this stable rule and that `event_key` is non-empty. Tenant-specific definitions, email syntax, and configured property types remain server concerns. The SDK may trim values to determine emptiness but does not silently normalize submitted identities.

### 4.3 Public operations

All SDKs provide ecosystem-idiomatic equivalents of:

- `UserRegistration(event)` → `event_key: user_registration`, `is_common: true`
- `UserLogin(event)` → `event_key: user_login`, `is_common: true`
- `OrderCreated(event)` → `event_key: order_created`, `is_common: true`
- `OrderPaid(amount, currency, event)` → `event_key: order_paid`, `is_common: true`; the required finite `amount` and nonblank `currency` are sent as `properties.amount` and `properties.currency`. Caller properties containing either key are a validation error.
- `CustomEvent(eventKey, event)` → caller key, `is_common: false`

Each common key still requires a tenant event definition. Common wrappers do not imply special server behavior.

An event input contains optional `email`, `phone_number`, `contact_name`, `properties`, `event_id`, `occurred_at` (a language-native time value), and an explicit optional `visitor_id`. The explicit visitor ID is an escape hatch for unsupported frameworks, tests, and non-HTTP execution.

### 4.4 Acknowledgement

Only HTTP `200` with a valid success envelope returns an acknowledgement containing:

- `success`
- `message`
- `event_key`
- `validated_properties`
- a bounded raw response body where ecosystem conventions permit

Its API documentation must state that acknowledgement means accepted for asynchronous processing, not confirmed identity resolution, durable persistence, or analytics availability.

## 5. Configuration

Only `accessToken` is required. Every SDK also exposes optional settings with defaults:

- `baseURL`, default `https://server.cekat.ai`
- request `timeout`, default 3 seconds per network attempt
- `retryCount`, default `2` retries after the initial attempt

Where ecosystem conventions support dependency injection, tests and advanced integrations may inject a compatible HTTP transport without expanding the cross-language behavioral contract.

Every request sends `User-Agent: cekat-event-sdk-<language>/<semver>`, optionally followed by runtime details.

These protocol names are fixed:

- Cookie: `_cekat_visitor_id`
- Header: `X-Cekat-Visitor-ID`

## 6. Visitor propagation

### 6.1 Precedence

Middleware resolves request visitor state in this order:

1. A non-empty `X-Cekat-Visitor-ID` header.
2. A non-empty `_cekat_visitor_id` cookie.
3. No visitor ID.

When constructing an event payload, the client resolves visitor state in this order:

1. Explicit event `visitor_id`.
2. Current request-local visitor ID.
3. Omit `visitor_id`.

Header and cookie values are trimmed before testing emptiness. Visitor IDs are untrusted correlation data and must never be used for authentication, authorization, session lookup, or resource ownership.

### 6.2 Generic API

The primary generic integration accepts an HTTP request, or normalized request headers and cookies, rather than requiring customer code to extract the visitor ID. Conceptually:

```text
withVisitorFromRequest(request, handler)
```

It extracts the visitor ID, establishes language-appropriate request scope, invokes the handler, and restores or clears state even when execution fails or is cancelled.

A lower-level primitive is also available:

```text
withVisitorId(visitorId, handler)
```

This supports unsupported servers, tests, and custom integrations. Framework adapters wrap the generic primitives so ordinary application code only installs middleware and calls event methods.

Because there is no universal cross-framework request type, core packages expose extraction from common standard-library request types where possible and from normalized headers/cookies otherwise. Framework packages adapt native request objects.

### 6.3 Language mechanisms

- **Go:** `context.Context`. Generic extraction returns an enriched context/request. Tracking methods accept a context. Framework middleware ensures handlers receive an enriched request context; frameworks whose handler context is not a `context.Context` (Gin's `*gin.Context` without fallback, Fiber's `fiber.Ctx`) document the standard context to pass (`c.Request.Context()`, `c.Context()`).
- **Node.js:** `AsyncLocalStorage`, with scope preserved across supported promise and asynchronous operations.
- **Python:** `contextvars.ContextVar`, using reset tokens in `finally`.
- **PHP:** a request-scoped `VisitorContext` service, always cleared in `finally`, including under long-running servers such as Laravel Octane.
- **Java:** request attributes where available plus a scoped holder for core access. Servlet and Spring filters clean state in `finally`; asynchronous dispatch is tested explicitly.
- **.NET:** ASP.NET Core `HttpContext.Items` through `IHttpContextAccessor`; generic scope uses a disposable `AsyncLocal` abstraction.
- **Ruby:** generic Rack request-local scope; Rails integration uses `ActiveSupport::CurrentAttributes`. Rack middleware clears state in `ensure` to protect reused threads.

Middleware does not authenticate a visitor ID, inspect authenticated users, emit events automatically, change response cookies, or put access tokens in request state.

## 7. Repository architecture

```text
cekat-event-sdk/
├── README.md
├── docs/
│   ├── sdk-contract.md
│   ├── visitor-propagation.md
│   ├── retry-and-error-semantics.md
│   └── superpowers/specs/
├── conformance/
│   ├── fixtures/
│   └── mock-ingest-server/
├── go/                                  # core module (no third-party deps) + middleware/nethttp
│   └── middleware/{gin,echo,fiber,chi}/  # each its own Go module
├── node/
│   ├── src/
│   ├── integrations/{express,fastify,koa,nestjs,nextjs}/
│   └── browser/
├── python/
│   ├── src/cekat_event_sdk/
│   └── integrations/{django,flask,fastapi-starlette}/
├── php/
│   ├── src/
│   └── integrations/{laravel,symfony}/
├── java/
│   ├── cekat-core/
│   └── integrations/{spring-boot,jakarta-servlet}/
├── dotnet/
│   ├── src/Cekat.EventSdk/
│   └── src/{Cekat.EventSdk.AspNetCore,Cekat.EventSdk.AzureFunctions}/
└── ruby/
    ├── lib/cekat_event_sdk/
    └── integrations/{rack,rails}/
```

Framework adapters stay thin. Where an ecosystem resolves dependencies per package (for example Go modules), each framework adapter that needs a third-party framework is published separately so the core never adds framework dependencies or raises a consumer's language floor. Validation, models, HTTP submission, retry behavior, response decoding, and errors belong in each language core.

Initial package coordinates follow Cekat conventions:

- Go: Cekat-owned module ending in `cekat-event-sdk-go`
- npm: `@cekat/event-sdk`
- Python: `cekat-event-sdk`
- Composer: `cekat/event-sdk`
- Java: Cekat group with `cekat-event-sdk-*` artifacts
- NuGet: `Cekat.EventSdk` plus integration packages
- RubyGems: `cekat-event-sdk`

Registry ownership and exact unresolved coordinates must be verified before publishing.

## 8. Framework matrix

The first release targets:

- Go: standard `net/http`, Gin, Echo, Fiber, Chi.
- Node.js: Express, Fastify, Koa, NestJS, Next.js.
- Python: Django, Flask, and ASGI middleware covering FastAPI/Starlette.
- PHP: Laravel and Symfony, using PSR-compatible facilities where practical.
- Java: Spring Boot and generic Jakarta Servlet.
- .NET: ASP.NET Core and Azure Functions.
- Ruby: Rack and Rails.

Go and Node receive broader coverage because their HTTP ecosystems are more fragmented. Adapters may share an implementation when a framework is built directly on a common middleware standard.

The compatibility policy includes maintained LTS releases and aims to cover runtime versions released within roughly five years of implementation. A version is excluded when required secure transport or request-scope behavior cannot be supported safely. CI tests the selected minimum and current stable versions, and documentation names supported framework major versions explicitly.

## 9. HTTP delivery and retries

Event submission is synchronous. The caller waits for a response and receives an acknowledgement or typed error.

With the default retry count, the SDK makes at most three attempts. It retries only:

- transport or connection failures;
- eligible timeouts;
- HTTP `429`, `500`, `502`, `503`, and `504`.

Retry is decided by status alone. It does not retry `400`, `401`, `404`, or other statuses. Before retry `n`, the SDK waits a full-jitter delay in `[0, min(100ms * 2^(n-1), 1000ms)]`, interruptible by the language’s cancellation mechanism. A valid `Retry-After` (delta-seconds or HTTP-date) raises the delay to the server's value; a `Retry-After` above 5 seconds stops retrying and returns the typed error immediately so callers are never blocked on long pauses.

A received `200` whose body cannot be read is a response-decode error with known outcome and is never retried, because the event was accepted.

Because event submission is synchronous, SDK documentation must show how to keep tracking off a user-facing request's critical path in each language (for example a goroutine with `context.WithoutCancel` in Go, or an un-awaited promise with an attached rejection handler in Node), without the SDK owning a background queue.

Retrying a request whose outcome is unknown can create duplicate events. Every retry reuses the call's `event_id` so the server can deduplicate, but SDK documentation and typed errors must not claim server enforcement.

Cancellation mechanisms include Go contexts, Node abort signals, Python task cancellation, Java interruption or framework cancellation where available, .NET cancellation tokens, and transport-specific Ruby/PHP cancellation or timeout support.

## 10. Errors

Every SDK exposes ecosystem-idiomatic typed errors corresponding to:

- `ValidationError`
- `AuthenticationError` for `401`
- `EventDefinitionNotFoundError` for `404`
- `ApiError`, including structured `400` and exhausted `500` responses
- `TransportError`
- `ResponseDecodeError`

Errors retain, where relevant:

- HTTP status;
- server error text and optional code;
- a size-bounded response body;
- number of attempts;
- underlying transport cause;
- whether delivery outcome is unknown.

A malformed HTTP `200` success envelope is a response-decoding error. If a transport cannot reliably determine whether bytes reached the server, the SDK conservatively marks the outcome unknown.

No logger or telemetry dependency is required in the first release. Applications can log structured acknowledgements and errors.

## 11. Browser propagation helpers

The Node/JavaScript package includes a browser module consumable by the existing tracker.

### 11.1 Explicit fetch enrichment

The default helper enriches one request without modifying global APIs:

```javascript
await fetch(url, cekat.withVisitor(options));
```

A companion helper accepts and returns a `Request`. Helpers read `_cekat_visitor_id`, add `X-Cekat-Visitor-ID`, preserve caller headers and request settings, do not overwrite an explicitly supplied visitor header, do not mutate input, and no-op safely during server-side rendering.

### 11.2 Axios integration

An interceptor factory can be attached to a dedicated Axios instance. Documentation warns against attaching it globally, because doing so could forward visitor IDs to unrelated third-party origins.

### 11.3 Opt-in automatic propagation

An advanced helper may wrap global `fetch` and `XMLHttpRequest`:

```javascript
const disable = cekat.enableAutoPropagation({
  allowedTargets: [
    { origin: window.location.origin, pathPrefix: "/api/" },
    { origin: "https://api.customer.example", pathPrefix: "/" }
  ]
});
```

Requirements:

- Explicit parsed-origin allowlist; optional path-prefix restrictions.
- No broad string-prefix URL matching.
- HTTP(S) requests only.
- No overwrite of an explicit visitor header.
- Idempotent installation and reliable uninstall.
- Correct preservation of headers, request bodies, credentials, abort signals, and return behavior.
- Clear documentation that early requests, navigation, forms, resource tags, workers, WebSockets, and other non-fetch/XHR traffic may not be intercepted.

The SDK will not install automatic interception by default and will not use a service worker solely for visitor propagation.

Cross-origin customer APIs must allow `X-Cekat-Visitor-ID` through CORS. Authentication-cookie credential settings remain the customer application’s responsibility.

## 12. Identity-link semantics

The SDK does not expose a separate identify operation. Any event containing both an accepted identity and a visitor ID can cause server-side linking.

The selected product policy is “latest contact wins” for current attribution when a browser visitor is later associated with a different contact. The server should nevertheless retain immutable timestamped link history instead of destructively rewriting prior link evidence. That preserves auditability and allows the policy to evolve. Implementing server-side link storage is outside this repository; SDKs only transmit the event inputs.

Events emitted by queues, payment webhooks, scheduled jobs, or other asynchronous execution do not need the original visitor context once a previous event linked the contact identity. They submit email or phone identity normally.

## 13. Testing and conformance

A language-neutral fixture set and mock ingest server verify:

- fixed endpoint and bearer authentication;
- common and custom payloads;
- header-over-cookie extraction;
- explicit visitor-over-context precedence;
- email-or-phone validation;
- acknowledgement parsing;
- typed handling of `400`, `401`, `404`, exhausted `500`, malformed responses, and transport failures;
- exactly two default retries for retryable failures, including `429`, `502`, `503`, and `504`;
- `Retry-After` lower bounds and the 5-second cap;
- interrupted `200` bodies as non-retried decode errors;
- generated and caller-supplied `event_id`/`occurred_at`, identical across retries;
- `User-Agent` identification;
- no retries for permanent responses;
- cancellation during requests and backoff;
- token redaction;
- request-state cleanup on success and failure;
- concurrent request isolation;
- dynamic JSON-compatible properties.

Each framework package adds native middleware integration tests.

Browser tests cover cookie parsing, options and `Request` enrichment, Axios integration, fetch/XHR wrapping, allowlist enforcement, explicit-header preservation, idempotent install/uninstall, SSR behavior, and a documented CORS example.

## 14. Implementation sequence

Implementation is split into independently reviewable phases:

1. Shared protocol documentation, fixtures, and mock server.
2. Go core and `net/http` as the explicit-context reference implementation.
3. Remaining Go middleware.
4. Node core and `AsyncLocalStorage` as the ambient-context reference implementation.
5. Node framework adapters and browser helpers.
6. Python core and adapters.
7. PHP core and adapters.
8. Java core and adapters.
9. .NET core and adapters.
10. Ruby core, Rack, and Rails adapters.
11. Cross-language conformance, documentation audit, compatibility CI, and release preparation.

Each language package should be independently releasable after satisfying the shared conformance contract; completion of every language is not required to publish an earlier approved package.

## 15. Success criteria

The design succeeds when customers can:

1. Initialize one client with an access token.
2. Install one supported middleware or generic request adapter.
3. Call an event method with email or phone identity from ordinary application code.
4. Have the current browser visitor ID attached automatically when a request carries it.
5. Receive an accurate acknowledgement or actionable typed error.
6. Emit later background events using identity alone.

Across all supported languages, equivalent inputs, retries, visitor precedence, acknowledgements, and failure conditions must produce equivalent observable behavior.