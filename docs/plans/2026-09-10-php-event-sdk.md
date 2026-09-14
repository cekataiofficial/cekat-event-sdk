# PHP Event SDK Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).



> **Implementation notes (2026-09-13) — as built, overriding the tasks below.** Exceptions follow PHP convention: `ValidationException`, `ApiException` (base of `AuthenticationException` and `EventDefinitionNotFoundException`), `TransportException`, `ResponseDecodeException`, all extending `CekatException`. `ClientOptions` defaults to a 3-second timeout. `orderPaid(int|float $amount, string $currency, EventInput $event)`. `EventInput` adds `eventId` and `occurredAt`. A top-level empty `[]` encodes as `{}` (non-empty lists are rejected); non-list arrays with integer keys are rejected; `JsonSerializable` values are accepted after validating their output. `GuzzleTransport` forbids connection reuse because libcurl silently resends on stale keep-alive connections, and reports body failures after headers through `TransportResponse::$bodyReadFailure`. Integrations read the raw `Cookie` header first (Laravel `EncryptCookies` drops unencrypted cookies). Symfony sub-requests without a visitor inherit the outer visitor. Guzzle floor is `^7.15.2 || ^8.0` because Composer blocks 7.8–7.15.1 on security advisories. Evidence and the tested matrix are in `php/docs/compatibility.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the independently releasable `cekat/event-sdk` Composer package with core event delivery, request-local visitor enrichment, PSR-15, Laravel, and Symfony integrations.

**Architecture:** Core models, validation, retry/decoding, and a timeout-aware SDK transport remain framework-neutral. Guzzle 7 is the token-only default transport; a PSR-18 bridge is injectable but explicitly cannot enforce the SDK timeout portably. Every adapter extracts the fixed header/cookie and brackets downstream execution with replace/restore so reused workers cannot leak state.

**Tech Stack:** PHP and Composer versions verified at execution/release time, PHP 8.2 floor subject to that gate, Guzzle 7, PSR-7/15/17/18, PHPUnit, PHPStan, PHP-CS-Fixer.

**Specs:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md` and `docs/superpowers/plans/2026-09-10-shared-conformance.md`.

## Exact file map

```text
php/
├── composer.json
├── phpunit.xml.dist
├── phpstan.neon.dist
├── .php-cs-fixer.dist.php
├── README.md
├── docs/compatibility.md
├── scripts/conformance
├── scripts/package
├── src/
│   ├── Client.php
│   ├── ClientOptions.php
│   ├── Acknowledgement.php
│   ├── EventInput.php
│   ├── Exception/
│   │   ├── ValidationError.php
│   │   ├── AuthenticationError.php
│   │   ├── EventDefinitionNotFoundError.php
│   │   ├── ApiError.php
│   │   ├── TransportError.php
│   │   └── ResponseDecodeError.php
│   ├── Internal/
│   │   ├── EventValidator.php
│   │   ├── HttpStatusText.php
│   │   ├── ResponseDecoder.php
│   │   ├── RetryPolicy.php
│   │   └── Sleeper.php
│   ├── Context/
│   │   ├── VisitorContextInterface.php
│   │   ├── VisitorContext.php
│   │   └── VisitorExtractor.php
│   ├── Transport/
│   │   ├── Transport.php
│   │   ├── TransportRequest.php
│   │   ├── TransportResponse.php
│   │   ├── TransportFailure.php
│   │   ├── GuzzleTransport.php
│   │   └── Psr18Transport.php
│   └── Integration/
│       ├── Psr15/VisitorMiddleware.php
│       ├── Laravel/CekatServiceProvider.php
│       ├── Laravel/VisitorMiddleware.php
│       └── Symfony/VisitorContextKernel.php
└── tests/
    ├── BootstrapTest.php
    ├── Unit/{EventValidatorTest,VisitorContextTest,VisitorExtractorTest,ResponseDecoderTest,RetryPolicyTest}.php
    ├── Transport/{GuzzleTransportTest,Psr18TransportTest}.php
    ├── Support/{FakeTransport,RecordingSleeper,Psr17Factory}.php
    ├── ClientTest.php
    ├── Integration/{Psr15MiddlewareTest,LaravelIntegrationTest,SymfonyIntegrationTest,LongWorkerIsolationTest}.php
    ├── Conformance/SharedFixturesTest.php
    └── Packaging/PackageScriptTest.php
```

## Public Interfaces

```php
namespace Cekat\EventSdk;

final readonly class EventInput {
    public function __construct(
        public ?string $email = null,
        public ?string $phoneNumber = null,
        public ?string $contactName = null,
        public ?string $visitorId = null,
        /** @var array<string,mixed>|\stdClass|null */
        public array|\stdClass|null $properties = null,
    ) {}
}

// null means omit `properties`. A non-null top-level value must be a string-keyed
// PHP array or stdClass and always encodes as a JSON object; list-shaped arrays,
// including an ambiguous empty PHP array, are rejected at the top level. Use a
// stdClass to represent an empty JSON object. Nested JSON arrays remain supported.

final readonly class Acknowledgement {
    /** @param list<string> $validatedProperties */
    public function __construct(
        public bool $success,
        public string $message,
        public string $eventKey,
        public array $validatedProperties,
        public string $rawBody,
    ) {}
}

final readonly class ClientOptions {
    public function __construct(
        public string $baseUrl = 'https://server.cekat.ai',
        public float $timeoutSeconds = 10.0,
        public int $retryCount = 2,
    ) {}
}

final class Client {
    public function __construct(
        string $accessToken,
        ?ClientOptions $options = null,
        ?\Cekat\EventSdk\Transport\Transport $transport = null,
        ?\Cekat\EventSdk\Context\VisitorContextInterface $visitorContext = null,
    );
    public function userRegistration(EventInput $event): Acknowledgement;
    public function userLogin(EventInput $event): Acknowledgement;
    public function orderCreated(EventInput $event): Acknowledgement;
    public function orderPaid(EventInput $event): Acknowledgement;
    public function customEvent(string $eventKey, EventInput $event): Acknowledgement;
}

namespace Cekat\EventSdk\Transport;

interface Transport {
    /** @throws TransportFailure */
    public function send(TransportRequest $request, float $timeoutSeconds): TransportResponse;
}

final readonly class TransportRequest {
    /** @param array<string,string> $headers */
    public function __construct(public string $method, public string $url, public array $headers, public string $body) {}
}
final readonly class TransportResponse {
    /** @param array<string,list<string>> $headers */
    public function __construct(
        public int $status,
        public array $headers,
        public string $body,
        public string $reasonPhrase,
    ) {}
}

namespace Cekat\EventSdk\Context;

interface VisitorContextInterface {
    public function current(): ?string;
    public function replace(?string $visitorId): ?string;
    public function restore(?string $previous): void;
    public function runWithVisitorId(?string $visitorId, callable $handler): mixed;
    public function runWithPsrRequest(\Psr\Http\Message\ServerRequestInterface $request, callable $handler): mixed;
}

final class VisitorContext implements VisitorContextInterface {
    // Default synchronous mutable implementation of the interface above.
}

final class VisitorExtractor {
    public static function fromPsrRequest(\Psr\Http\Message\ServerRequestInterface $request): ?string;
    /** @param array<string,string|list<string>> $headers @param array<string,string> $cookies */
    public static function fromNormalized(array $headers, array $cookies): ?string;
}
```

Errors are concrete exceptions. `AuthenticationError`, `EventDefinitionNotFoundError`, and `ApiError` expose `statusCode`, nullable `serverCode`, `message`, bounded `rawBody`, and `attempts`; `TransportError` exposes `attempts`, `deliveryOutcomeUnknown=true`, and `getPrevious()`; `ResponseDecodeError` exposes `statusCode=200`, bounded body, attempts, and previous cause. Caller-visible raw bodies retain at most the first 65,536 bytes. PHP v1 offers synchronous timeouts only and no custom cancellation token.

## Task 1: Verify compatibility and bootstrap the one-package build

**Files:** Create `php/composer.json`, `php/phpunit.xml.dist`, `php/phpstan.neon.dist`, `php/.php-cs-fixer.dist.php`, `php/docs/compatibility.md`, `php/tests/BootstrapTest.php`.

**Interfaces:** Produces PSR-4 namespace `Cekat\EventSdk\`; one package `cekat/event-sdk`; production requirements include Guzzle 7 and required PSR interfaces; Laravel/Symfony are optional Composer suggestions and dev test dependencies.

- [ ] **Red:** Run `test -f php/composer.json && composer --working-dir=php validate --strict`. Expected: FAIL because the manifest does not exist.
- [ ] **Implement:** Query official sources before selecting constraints: `php -r 'echo PHP_VERSION, PHP_EOL;'`, `composer show --all guzzlehttp/guzzle`, `composer show --all laravel/framework`, `composer show --all symfony/http-kernel`, and compare PHP/Laravel/Symfony official support tables. Record command output, date, selected maintained runtime/framework majors, and source URLs in `php/docs/compatibility.md`. Stop if the proposed PHP `^8.2` floor or Guzzle 7 conflicts with maintained secure releases. Configure `autoload`, `autoload-dev`, PHPUnit, PHPStan maximum practical level, and formatter; do not commit a library `composer.lock`.
- [ ] **Green:** Run `composer --working-dir=php validate --strict && composer --working-dir=php install --prefer-dist --no-interaction && composer --working-dir=php test -- --filter BootstrapTest`. Expected: manifest valid, dependencies install, one bootstrap test passes.
- [ ] **Commit:** `git add php && git commit -m "build(php): bootstrap Composer package"`.

## Task 2: Add values, typed errors, and local validation

**Files:** Create `php/src/{EventInput,Acknowledgement,ClientOptions}.php`, all `php/src/Exception/*.php`, `php/src/Internal/EventValidator.php`, `php/tests/Unit/EventValidatorTest.php`.

**Interfaces:** `EventValidator::validate(string $eventKey, EventInput $event): void`; input strings are preserved except visitor IDs, which are trimmed. Absent properties are `null` and omitted from the payload. A present top-level properties value must be a string-keyed PHP array or `stdClass` and encodes as a JSON object; reject every top-level list-shaped array, including ambiguous `[]`. Recursively allow JSON null, bool, string, finite number, lists, string-keyed arrays, and `stdClass`, with integers restricted to `[-9007199254740991,9007199254740991]`; reject arbitrary class instances.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter EventValidatorTest`. Expected: FAIL because `EventInput`/`EventValidator` are missing.
- [ ] **Implement:** Test blank key, missing/blank email and phone, preserved identity whitespace, trimmed explicit visitor, blank explicit visitor treated absent, invalid key types, NaN/infinity, unsafe integers, resources, arbitrary objects, and recursive data. Add exact serialization assertions that default `null` omits `properties`, top-level `[]` and `["value"]` fail before transport, `new \stdClass()` serializes as `{}`, a nonempty string-keyed array serializes as an object, and nested lists plus nested empty `stdClass` values retain their JSON forms. Use `json_encode(..., JSON_THROW_ON_ERROR)` as a final recursion/encoding guard and translate failures to `ValidationError` without echoing values; name a safe property path when available. Validate options: blank token, non-HTTP(S) or credentialed/non-origin base URL, timeout `<=0`, retries `<0`; normalize only one root trailing slash.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter EventValidatorTest && composer --working-dir=php phpstan`. Expected: all validation tests pass and static analysis reports no errors.
- [ ] **Commit:** `git add php/src php/tests/Unit/EventValidatorTest.php && git commit -m "feat(php): add event validation and errors"`.

## Task 3: Implement replace/restore visitor scope and extraction

**Files:** Create `php/src/Context/{VisitorContextInterface,VisitorContext,VisitorExtractor}.php`, `php/tests/Unit/{VisitorContextTest,VisitorExtractorTest}.php`, `php/tests/Integration/LongWorkerIsolationTest.php`.

**Interfaces:** `VisitorContext` implements the `VisitorContextInterface` signatures above, and `Client`, PSR-15, Laravel, and Symfony integrations type against that interface. Header `X-Cekat-Visitor-ID` wins over cookie `_cekat_visitor_id`; values are trimmed and blank means absent.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter '/(VisitorContext|VisitorExtractor|LongWorkerIsolation)Test/'`. Expected: FAIL because context classes are missing.
- [ ] **Implement:** Store only the current scalar visitor in the default injected context instance. `runWithVisitorId()` captures `replace()`, invokes the callback, and restores in `finally`; nested scopes restore their parent. Cover normal return, exception, sequential simulated worker requests, nested calls, header/cookie precedence, and mixed-case header lookup. Add a test double implementing `VisitorContextInterface` and prove the interface does not require extending the final default class; document that interleaved coroutine requests must inject a coroutine-local implementation of this interface or use explicit per-request storage, never share the default mutable implementation. Task 5 proves custom-context injection into `Client`, and Task 6 proves it through middleware.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter '/(VisitorContext|VisitorExtractor|LongWorkerIsolation)Test/'`. Expected: tests pass with no value retained after success or exception.
- [ ] **Commit:** `git add php/src/Context php/tests/Unit/VisitorContextTest.php php/tests/Unit/VisitorExtractorTest.php php/tests/Integration/LongWorkerIsolationTest.php && git commit -m "feat(php): add isolated visitor request scope"`.

## Task 4: Add timeout-aware transport, Guzzle default, and PSR-18 bridge

**Files:** Create `php/src/Transport/*.php`, `php/tests/Transport/{GuzzleTransportTest,Psr18TransportTest}.php`, `php/tests/Support/Psr17Factory.php`.

**Interfaces:** `Transport::send(TransportRequest,float): TransportResponse`; every response carries `status`, headers, bounded body, and `reasonPhrase`. `GuzzleTransport` passes `timeout` and disables Guzzle retries; `Psr18Transport(ClientInterface,RequestFactoryInterface,StreamFactoryInterface)` accepts timeout but cannot enforce it.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter '/(GuzzleTransport|Psr18Transport)Test/'`. Expected: FAIL because transport classes are missing.
- [ ] **Implement:** Map Guzzle connection/request failures and PSR-18 `ClientExceptionInterface` to `TransportFailure` with previous cause. Preserve every received status and PSR-7 `ResponseInterface::getReasonPhrase()` in `TransportResponse`, including 4xx/5xx; Guzzle and PSR-18 tests assert propagation of a custom phrase and an empty phrase. Read at most 65,537 bytes, retain the first 65,536, and discard the excess. In `Psr18Transport`, issue a standards-compliant PSR-7 request but document/test that arbitrary PSR-18 has no portable per-request timeout or cancellation option; caller must preconfigure it. The default `new Client($token)` constructs `GuzzleTransport`, which guarantees the configured per-attempt timeout.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter '/(GuzzleTransport|Psr18Transport)Test/'`. Expected: tests pass, including exact timeout option and bounded multibyte body bytes.
- [ ] **Commit:** `git add php/src/Transport php/tests/Transport php/tests/Support/Psr17Factory.php && git commit -m "feat(php): add HTTP transport adapters"`.

## Task 5: Implement synchronous client, retry policy, and decoding

**Files:** Create `php/src/Client.php`, `php/src/Internal/{HttpStatusText,ResponseDecoder,RetryPolicy,Sleeper}.php`, `php/tests/{ClientTest.php,Unit/ResponseDecoderTest.php,Unit/RetryPolicyTest.php,Support/FakeTransport.php,Support/RecordingSleeper.php}`.

**Interfaces:** Public `Client` methods above; `Sleeper::sleepMilliseconds(int $milliseconds): void`; injectable internal random integer source selects full jitter `[0,100]` then `[0,200]` for the default two retries.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter '/(Client|ResponseDecoder|RetryPolicy)Test/'`. Expected: FAIL because `Client` and decoder are missing.
- [ ] **Implement:** POST fixed `/api/events/ingest` with bearer auth/content type and no `business_id`. Common wrappers fix key/`is_common=true`; custom uses caller key/false. Explicit trimmed nonblank visitor wins, blank falls back to context. Prove `Client` accepts and reads a custom `VisitorContextInterface` implementation. Omit `properties` when null; encode every present accepted top-level properties value as a JSON object, never `[]`. Retry only transport failures, eligible timeout failures, and 500, at most `retryCount+1` attempts; never retry 400/401/404/other statuses. Decode only nested `{"success":true,"data":{"success":true,"message":"nonempty","event_key":"nonempty","validated_properties":["..."]}}`; malformed 200 is `ResponseDecodeError`. Decode non-200 `{"success":false,"error":"nonempty","code":"optional"}` when valid. For a malformed non-200 body, preserve status classification/raw bytes and choose the caller-visible fallback deterministically: trim and use `TransportResponse::$reasonPhrase` when nonempty; otherwise use `HttpStatusText::forStatus($status)`, covering every fixture status and returning `HTTP <status>` when unmapped. Unit tests assert exact messages for custom reason phrase, empty phrase with mapped status, and unmapped status. Map 401/404/supported others to typed errors, final 500 to `ApiError`, and exhausted transport to `TransportError`; every received HTTP response has known outcome, transport failure unknown. Never include token in errors. Acknowledgement means queue acceptance only.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter '/(Client|ResponseDecoder|RetryPolicy)Test/'`. Expected: all payload, precedence, envelope, status, attempt-count, jitter-bound, token-redaction, and retry tests pass.
- [ ] **Commit:** `git add php/src/Client.php php/src/Internal php/tests/ClientTest.php php/tests/Unit/ResponseDecoderTest.php php/tests/Unit/RetryPolicyTest.php php/tests/Support && git commit -m "feat(php): deliver events with bounded retries"`.

## Task 6: Add generic PSR-15 middleware

**Files:** Create `php/src/Integration/Psr15/VisitorMiddleware.php`, `php/tests/Integration/Psr15MiddlewareTest.php`.

**Interfaces:** `VisitorMiddleware::__construct(VisitorContextInterface)` and `process(ServerRequestInterface,RequestHandlerInterface): ResponseInterface`; delegates through `VisitorContextInterface::runWithPsrRequest()`.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter Psr15MiddlewareTest`. Expected: FAIL because `VisitorMiddleware` is missing.
- [ ] **Implement:** Extract header before cookie, trim the chosen value, put it in context only while the downstream handler runs, and restore on response or exception. Prove middleware accepts a custom `VisitorContextInterface` implementation. Do not mutate cookies, authenticate visitor IDs, emit events, or place tokens in request attributes.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter Psr15MiddlewareTest`. Expected: middleware precedence, nested scope, exception cleanup, and sequential request tests pass.
- [ ] **Commit:** `git add php/src/Integration/Psr15 php/tests/Integration/Psr15MiddlewareTest.php && git commit -m "feat(php): add PSR-15 visitor middleware"`.

## Task 7: Add Laravel scoped services and middleware

**Files:** Create `php/src/Integration/Laravel/{CekatServiceProvider,VisitorMiddleware}.php`, `php/tests/Integration/LaravelIntegrationTest.php`.

**Interfaces:** Provider reads `services.cekat.access_token`, optional `base_url`, `timeout_seconds`, `retry_count`; registers `VisitorContextInterface` to a scoped default `VisitorContext` binding and registers `Client` with Laravel `scoped()`; middleware signature `handle(\Illuminate\Http\Request $request, \Closure $next): mixed`.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter LaravelIntegrationTest`. Expected: FAIL because provider and middleware are missing.
- [ ] **Implement:** Keep Laravel imports isolated to the adapter namespace. Resolve visitor from native request header/cookie, call `$context->runWithVisitorId($visitor, fn () => $next($request))`, and ensure scoped bindings are rebuilt on worker lifecycle flush. Test two application scopes representing Octane requests plus an exception path; neither may retain visitor state. Do not capture a request/container in the long-lived client.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter LaravelIntegrationTest`. Expected: provider resolution, payload enrichment, scope flush, and exception cleanup pass.
- [ ] **Commit:** `git add php/src/Integration/Laravel php/tests/Integration/LaravelIntegrationTest.php && git commit -m "feat(php): add Laravel integration"`.

## Task 8: Add Symfony HttpKernel decorator

**Files:** Create `php/src/Integration/Symfony/VisitorContextKernel.php`, `php/tests/Integration/SymfonyIntegrationTest.php`.

**Interfaces:** `VisitorContextKernel::__construct(HttpKernelInterface $inner, VisitorContextInterface $context)`; `handle(Request $request, int $type = HttpKernelInterface::MAIN_REQUEST, bool $catch = true): Response`.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter SymfonyIntegrationTest`. Expected: FAIL because the kernel decorator is missing.
- [ ] **Implement:** Decorate the application kernel and bracket every main/subrequest dispatch with replace/restore using Symfony header/cookie access. Nested subrequests restore the outer visitor; exceptions and consecutive worker/message dispatches clear state. Document the service decoration stanza with the inner kernel reference; keep `RequestStack` out of core.
- [ ] **Green:** Run `composer --working-dir=php test -- --filter SymfonyIntegrationTest`. Expected: main request, nested subrequest, exception, and sequential worker tests pass.
- [ ] **Commit:** `git add php/src/Integration/Symfony php/tests/Integration/SymfonyIntegrationTest.php && git commit -m "feat(php): add Symfony integration"`.

## Task 9: Wire shared conformance

**Files:** Create `php/tests/Conformance/SharedFixturesTest.php`, `php/scripts/conformance`; modify `php/composer.json` scripts. Consume without modifying `conformance/fixtures/cases/*.json` and `conformance/mock-ingest-server/`.

**Interfaces:** Executable `php/scripts/conformance` accepts no positional arguments and requires exactly `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_CONTROL_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and `CEKAT_CONFORMANCE_FIXTURES`. It reads no aliases, defaults, repository-relative fixture paths, or additional conformance variables. It is the only PHP entrypoint root `scripts/conformance.sh --language php` calls.

- [ ] **Red:** Run `test -x php/scripts/conformance && php/scripts/conformance`. Expected: FAIL because the executable does not exist; after it exists, the same invocation fails before PHPUnit and names all four missing inputs.
- [ ] **Implement:** Use `set -eu`, reject positional arguments and missing/empty inputs, validate both URLs as absolute HTTP(S) origins and `CEKAT_CONFORMANCE_FIXTURES` as an absolute readable directory, then pass the exact four values to the conformance-only PHPUnit suite. `SharedFixturesTest` discovers every `*.json` file directly in the supplied cases directory (no explicit filename allowlist), rejects duplicate IDs, and validates before execution: `schema_version`, case kind, operation, properties recipe, response-body recipe, cancellation phase, every queued mock-response field/form, and `expect.result`. For each case, reset and queue through `CEKAT_CONFORMANCE_CONTROL_URL`, construct the SDK with `CEKAT_CONFORMANCE_BASE_URL` and `CEKAT_CONFORMANCE_ACCESS_TOKEN`, expand runtime/body recipes, invoke the named public operation, assert the complete expected result (including exact HTTP `error_message`), and fetch the journal for attempt/request assertions. Maintain discovered/executed ID sets and fail on every unknown form, skipped required case, or discovered case lacking an executed assertion. PHP's approved synchronous-v1 cancellation limitation is emitted as an explicit non-passing capability report for cancellation cases and is never counted as a pass.
- [ ] **Green:** From the repository root, run the shared server from its module directory, parse its first readiness JSON record, export all four inputs, and stop it reliably:

```bash
READY="$(mktemp)"
(
  cd conformance/mock-ingest-server
  exec go run ./cmd/mock-ingest-server --listen 127.0.0.1:0
) >"$READY" 2>"$READY.stderr" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; rm -f "$READY" "$READY.stderr"' EXIT
for _ in $(seq 1 100); do test -s "$READY" && break; sleep 0.1; done
BASE_URL="$(php -r '$r=json_decode(trim(file($argv[1])[0] ?? ""), true, 512, JSON_THROW_ON_ERROR); echo $r["base_url"];' "$READY")"
CONTROL_URL="$(php -r '$r=json_decode(trim(file($argv[1])[0] ?? ""), true, 512, JSON_THROW_ON_ERROR); echo $r["control_url"];' "$READY")"
CEKAT_CONFORMANCE_BASE_URL="$BASE_URL" \
CEKAT_CONFORMANCE_CONTROL_URL="$CONTROL_URL" \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$(pwd)/conformance/fixtures/cases" \
php/scripts/conformance
```

Expected: exit `0` only when every applicable discovered PHP fixture passes and every mock-journal observation matches; unknown or unexecuted cases make the command nonzero. The launch command is `go run ./cmd/mock-ingest-server` from `conformance/mock-ingest-server`; no language plan creates or calls a mock helper script.
- [ ] **Commit:** `git add php/tests/Conformance php/scripts/conformance php/composer.json && git commit -m "test(php): add shared conformance runner"`.

## Task 10: Document, verify, and package without publishing

**Files:** Create `php/README.md`, `php/scripts/package`, `php/tests/Packaging/PackageScriptTest.php`; update `php/docs/compatibility.md`.

**Interfaces:** Executable `php/scripts/package --version 0.1.0 --output <absolute-dir>` accepts only `0.1.0`, runs checks, builds without publishing/signing, and emits `<output>/manifest.json` with `schema_version: 1`, `language: "php"`, `version`, and sorted `artifacts[{path,sha256,size_bytes}]`; paths are output-relative and traversal-free.

- [ ] **Red:** Run `composer --working-dir=php test -- --filter PackageScriptTest`. Expected: FAIL because packaging script/docs are missing.
- [ ] **Implement:** Document token-only setup, all event calls, queue-acceptance meaning, PSR-15/Laravel/Symfony setup, exact fixed names, long-worker cleanup, no coroutine safety for a shared mutable context, explicit visitor behavior, retries/duplicate risk, six errors, raw-body cap, origin-only base URL, and the PSR-18 timeout exception. Package with `composer archive --working-dir=php --format=zip --dir=<output>` (setting archive version to `0.1.0` for the command), hash the archive, and generate deterministic JSON. Reject relative output, wrong version, traversal, missing artifact, or hash mismatch. Never publish or sign.
- [ ] **Green:** Run `composer --working-dir=php validate --strict && composer --working-dir=php test && composer --working-dir=php phpstan && composer --working-dir=php cs-check && composer --working-dir=php audit && OUT="$(mktemp -d)" && php/scripts/package --version 0.1.0 --output "$OUT" && php -r '$m=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR); exit(($m["schema_version"]===1 && $m["language"]==="php" && $m["version"]==="0.1.0")?0:1);' "$OUT/manifest.json"`. Expected: every check exits 0; archive and valid manifest exist; no registry request occurs.
- [ ] **Release gate and commit:** Repeat Task 1 official lifecycle/version checks, run lowest and newest supported dependency matrices plus `composer audit`, update `php/docs/compatibility.md` with dated evidence, and stop release readiness if any selected line is not security-maintained. Then run `git add php && git commit -m "docs(php): prepare SDK package artifacts"`.
