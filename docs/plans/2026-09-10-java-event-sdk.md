# Java Event SDK Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).



> **Implementation notes (2026-09-13) — as built, overriding the tasks below.** The `ai.cekat` Central Portal namespace verification was not available; it remains an open release gate recorded in `java/compatibility.md` (development proceeded with the approved coordinate). The core has **no runtime dependencies**: an internal RFC 8259 JSON writer/parser replaces Jackson, avoiding Jackson 2/3 conflicts (Spring Boot 4 uses Jackson 3). Supported Spring Boot lines are 4.0 and 4.1 (3.5 OSS support ended 2026-06-30). `Event` is a record with a builder plus `eventId`/`occurredAt` (`Instant`); `orderPaid(Number amount, String currency, Event)`. `HttpTransport` returns a bounded `TransportResponse` (status, headers, ≤65,536 bytes, truncation, body-read failure) instead of an `InputStream`; `JdkHttpTransport` uses `sendAsync` with a bounded body subscriber so the timeout covers the body. Retries follow the amended contract (429/5xx gateway statuses, Retry-After). Checked `InterruptedException` is thrown with the interrupt flag cleared, per Java convention. Spring creates `CekatClient` only when `cekat.access-token` is set (blank fails startup) so the starter does not break contexts that do not use it; `cekat.visitor-filter-enabled` toggles the filter. Checkstyle/SpotBugs run on JDK 21+ because Checkstyle 11+ requires Java 21.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Java SDK core plus Jakarta Servlet and Spring Boot adapters, with synchronous typed event delivery, bounded retries, automatic request-local visitor enrichment, shared conformance coverage, and releasable Maven artifacts under group `ai.cekat`.

**Architecture:** A Java 17-compatible core owns immutable models, strict local validation, JSON encoding/decoding, retry policy, typed errors, a scoped core visitor holder, and a synchronous `CekatClient`. The default transport adapts `java.net.http.HttpClient` behind a small injectable `HttpTransport`; Jakarta Servlet request attributes remain the canonical HTTP state, while a thread-local scope exists only during a filter dispatch. The Spring Boot artifact is thin auto-configuration over the core and Servlet artifacts; neither adapter propagates visitor scope into arbitrary executor tasks.

**Tech Stack:** Java release 17, Maven Wrapper, Maven multi-module build, `java.net.http.HttpClient`, Jackson (internal JSON implementation), JUnit Jupiter, Jakarta Servlet API, Spring Boot auto-configuration and test support.

**Specs:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md` and `docs/superpowers/plans/2026-09-10-shared-conformance.md`.

## Global Constraints

- The Java coordinate is consistently Maven group `ai.cekat`, Java package prefix `ai.cekat.events`, and Maven repository path prefix `ai/cekat/`. Artifacts are `cekat-event-sdk-core`, `cekat-event-sdk-jakarta-servlet`, and `cekat-event-sdk-spring-boot`. Task 1 verifies Cekat control of the group before POM creation; if ownership is not verified, execution stops rather than substituting another coordinate.
- Default target is `POST https://t.cekat.ai/api/events/ingest`; `baseUrl` is an absolute HTTP(S) origin and the fixed path is always appended.
- Only an `accessToken` is required. Send `Authorization: Bearer <accessToken>` and never include the token in errors, logs, request scope, browser assets, or test snapshots.
- Default timeout is 10 seconds per network attempt. The caller thread bounds the complete synchronous operation through interruption.
- Default retry count is two after the initial attempt. Retry only transport/connection failures, eligible timeouts, and HTTP `500`.
- Retry delay is full jitter: retry 1 uniformly `[0,100ms]`; retry 2 uniformly `[0,200ms]`. Interruption during request or delay propagates as `InterruptedException` without retry; preserve the interrupt status when an implementation catches it for cleanup.
- Never retry HTTP `400`, `401`, `404`, or any other HTTP response except `500`.
- Retain at most the first 65,536 response bytes. Decode public text with UTF-8 replacement at a truncation boundary; byte-oriented raw-body access returns a defensive copy.
- For retry number `n` (1-indexed), use full jitter uniformly in `[0,min(100ms * 2^(n-1),1000ms)]`, saturating before arithmetic can overflow. `retryCount` accepts every integer `>=0`; defaults still produce exactly `[0,100ms]` and `[0,200ms]`.
- Java `HttpClient` has no response reason phrase. Use an internal deterministic standard HTTP status-text map for synthesized non-200 messages and fall back to `HTTP <status>` for an unmapped status; absence of a reason phrase is never a decode error.
- Valid HTTP `200` is exactly a JSON object with `success: true` and a `data` object containing `success: true`, non-empty string `message`, non-empty string `event_key`, and `validated_properties` as an array of strings. Additional fields are ignored.
- A conforming non-200 error body is `{"success":false,"error":"non-empty text","code":"optional"}`. Malformed/nonconforming error bodies retain status classification and bounded raw bytes and use the deterministic status-text map; only malformed HTTP `200` becomes `ResponseDecodeException`.
- HTTP `401` maps to `AuthenticationException`, `404` to `EventDefinitionNotFoundException`, and all other non-success statuses, including `400` and exhausted `500`, map to `ApiException`.
- `deliveryOutcomeUnknown` is `false` after any HTTP response and `true` for transport failures or SDK timeout exhaustion after execution begins.
- Validate locally only stable event rules: non-empty `event_key`, and at least one non-empty email or phone. Trim identities only to test emptiness and preserve submitted identity strings.
- Visitor IDs are different: trim explicit/header/cookie visitor values before storing or transmitting. Blank explicit visitor ID falls back to ambient context. Header `X-Cekat-Visitor-ID` takes precedence over cookie `_cekat_visitor_id`.
- Properties recursively accept only JSON null, booleans, strings, finite numbers, lists, and string-keyed maps; reject cycles, non-string keys, unsupported objects, NaN/infinity, and integral values outside `[-9007199254740991, 9007199254740991]` before network I/O.
- Common methods force their fixed event key and `is_common: true`; `customEvent` forces caller key and `is_common: false`. No method implies special server behavior or idempotency.
- Servlet request attributes are canonical HTTP request state. The core scoped holder is restored in `finally` for the current dispatch only and is never implicitly propagated into user `Executor`, `Runnable`, `Callable`, or `CompletableFuture` work.
- Servlet filters cover `REQUEST`, `ASYNC`, and `ERROR` dispatch. Async request attributes remain until terminal completion/error/timeout, while dispatch-thread scope is always closed when `doFilter` returns.
- Runtime/framework/build-tool versions are verified against official sources at execution time and again at release time. Do not substitute projected patch versions or silently raise the Java floor.
- Every task follows red-green-refactor, runs the named focused test before the full module suite, and makes the listed focused commit.

---

## File Map

```text
java/
├── .mvn/wrapper/maven-wrapper.properties
├── mvnw
├── mvnw.cmd
├── pom.xml
├── compatibility.md
├── config/
│   ├── checkstyle.xml
│   └── spotbugs-exclude.xml
├── README.md
├── scripts/
│   ├── conformance
│   └── package
├── cekat-event-sdk-core/
│   ├── pom.xml
│   ├── src/main/java/ai/cekat/events/
│   │   ├── Acknowledgement.java
│   │   ├── CekatClient.java
│   │   ├── CekatClientOptions.java
│   │   ├── Event.java
│   │   ├── VisitorContext.java
│   │   ├── VisitorRequest.java
│   │   └── error/
│   │       ├── ApiException.java
│   │       ├── AuthenticationException.java
│   │       ├── CekatException.java
│   │       ├── EventDefinitionNotFoundException.java
│   │       ├── ResponseDecodeException.java
│   │       ├── TransportException.java
│   │       └── ValidationException.java
│   ├── src/main/java/ai/cekat/events/internal/
│   │   ├── BoundedBody.java
│   │   ├── EventEncoder.java
│   │   ├── EventValidator.java
│   │   ├── JsonValueValidator.java
│   │   ├── ResponseDecoder.java
│   │   ├── HttpStatusText.java
│   │   └── RetryExecutor.java
│   ├── src/main/java/ai/cekat/events/transport/
│   │   ├── HttpTransport.java
│   │   ├── JdkHttpTransport.java
│   │   ├── TransportRequest.java
│   │   └── TransportResponse.java
│   └── src/test/java/ai/cekat/events/
│       ├── BoundedBodyTest.java
│       ├── CekatClientOptionsTest.java
│       ├── CekatClientTest.java
│       ├── EventEncoderTest.java
│       ├── EventValidatorTest.java
│       ├── JsonValueValidatorTest.java
│       ├── JdkHttpTransportTest.java
│       ├── ResponseDecoderTest.java
│       ├── RetryExecutorTest.java
│       ├── VisitorContextTest.java
│       └── support/{FakeTransport.java,MutableClockSleeper.java}
├── cekat-event-sdk-jakarta-servlet/
│   ├── pom.xml
│   ├── src/main/java/ai/cekat/events/servlet/
│   │   ├── CekatAsyncCleanupListener.java
│   │   ├── CekatServletRequest.java
│   │   └── CekatVisitorFilter.java
│   └── src/test/java/ai/cekat/events/servlet/
│       ├── CekatServletRequestTest.java
│       ├── CekatVisitorFilterTest.java
│       └── ServletAsyncIntegrationTest.java
├── cekat-event-sdk-spring-boot/
│   ├── pom.xml
│   ├── src/main/java/ai/cekat/events/spring/
│   │   ├── CekatEventSdkAutoConfiguration.java
│   │   └── CekatEventSdkProperties.java
│   ├── src/main/resources/META-INF/spring/
│   │   └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
│   ├── src/main/resources/META-INF/
│   │   └── spring-configuration-metadata.json
│   └── src/test/java/ai/cekat/events/spring/
│       ├── CekatEventSdkAutoConfigurationTest.java
│       └── CekatSpringMvcIntegrationTest.java
└── conformance-tests/
    ├── pom.xml
    └── src/test/java/ai/cekat/events/conformance/
        ├── ConformanceClientTest.java
        ├── ConformanceContract.java
        └── MockControlClient.java
```

`cekat-event-sdk-core` has no Servlet or Spring dependency. `cekat-event-sdk-jakarta-servlet` depends on core and marks Jakarta Servlet API as `provided`. `cekat-event-sdk-spring-boot` depends on core and the Servlet adapter and uses Spring dependencies without leaking them into core.

---

### Task 1: Verify Compatibility and Bootstrap the Maven Reactor

**Files:**
- Create: `java/compatibility.md`
- Create: `java/pom.xml`
- Create: `java/.mvn/wrapper/maven-wrapper.properties`
- Create: `java/mvnw`
- Create: `java/mvnw.cmd`
- Create: `java/config/{checkstyle.xml,spotbugs-exclude.xml}`
- Create: each module `pom.xml` shown in the file map

**Interfaces:**
- Consumes: Official OpenJDK/Oracle lifecycle data, Maven release metadata, Spring Boot supported-version documentation, Jakarta Servlet specifications, Maven Central metadata, and release-owner evidence that Cekat controls Maven namespace `ai.cekat`.
- Produces: A Java-17-bytecode Maven reactor under group `ai.cekat` and package prefix `ai.cekat.events`; exact checked-in wrapper, compiler, Checkstyle, SpotBugs, Enforcer, plugin, Jackson, JUnit, Jakarta Servlet, and Spring Boot version pins; modules named `:core`, `:servlet`, `:spring`, and `:conformance` by artifact ID.

- [ ] **Step 1: Capture execution-time compatibility evidence before creating dependency files**

Run:

```bash
mkdir -p /tmp/cekat-java-version-gate
curl -fL https://www.oracle.com/java/technologies/java-se-support-roadmap.html \
  -o /tmp/cekat-java-version-gate/oracle-java-roadmap.html
curl -fL https://openjdk.org/projects/jdk/ \
  -o /tmp/cekat-java-version-gate/openjdk-projects.html
curl -fL https://maven.apache.org/docs/history.html \
  -o /tmp/cekat-java-version-gate/maven-history.html
curl -fL https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml \
  -o /tmp/cekat-java-version-gate/maven-metadata.xml
curl -fL https://github.com/spring-projects/spring-boot/wiki/Supported-Versions \
  -o /tmp/cekat-java-version-gate/spring-boot-supported.html
curl -fL https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/maven-metadata.xml \
  -o /tmp/cekat-java-version-gate/spring-boot-metadata.xml
curl -fL https://jakarta.ee/specifications/servlet/6.0/ \
  -o /tmp/cekat-java-version-gate/servlet-6.0.html
java -version
mvn --version
```

Expected: every `curl` exits `0`; the installed JDK is 17 or newer; the evidence establishes at least one maintained LTS JDK compatible with Java 17 bytecode, a maintained Spring Boot line using `jakarta.servlet`, and exact available dependency/plugin versions. Before POM creation, the release owner exports Central Portal namespace verification to `/tmp/cekat-java-version-gate/central-portal-ai.cekat.json`; run `test -s /tmp/cekat-java-version-gate/central-portal-ai.cekat.json`, `grep -F 'ai.cekat' /tmp/cekat-java-version-gate/central-portal-ai.cekat.json`, and `sha256sum /tmp/cekat-java-version-gate/central-portal-ai.cekat.json`, then record the hash and verification date in `java/compatibility.md`. If the file is absent, does not show Cekat ownership, or official support evidence conflicts with Java 17 or Servlet 6, stop before creating a POM; do not guess a group or change the Java floor.

- [ ] **Step 2: Record the verified matrix, sources, retrieval date, checksums, and selection rationale**

Write `java/compatibility.md` with: verified group `ai.cekat`, package prefix `ai.cekat.events`, and repository prefix `ai/cekat/`; Java source/bytecode floor `17`; exact CI JDK feature lines selected from maintained LTS releases; exact Maven Wrapper, Compiler, Enforcer, Checkstyle, SpotBugs, Surefire, Failsafe, JaCoCo, source, Javadoc, and reproducible-build plugin versions; exact Jackson/JUnit versions; exact maintained Spring Boot line and Servlet API version; links above; SHA-256 for downloaded evidence and the namespace-verification export; and exclusions for EOL short-term JDKs. Use the exact values observed in Step 1, not values copied from this plan.

Run:

```bash
! grep -En 'TBD|TODO|latest|[0-9]+\.x' java/compatibility.md
grep -F 'Java bytecode floor: 17' java/compatibility.md
grep -F 'Verified on:' java/compatibility.md
```

Expected: all commands exit `0`; the document has exact versions and dates and no floating-version language.

- [ ] **Step 3: Generate the wrapper and write the parent/module POMs with the recorded exact pins**

The parent POM must set `groupId` to `ai.cekat`, revision to `0.1.0`, `maven.compiler.release` to `17`, UTF-8 encoding, reproducible output timestamp, dependency management, and explicit plugin versions. Every source declaration uses package prefix `ai.cekat.events`; no `com.cekat`, `io.cekat`, or alternate group appears. Add Maven Enforcer rules for Java 17+, the recorded Maven floor, dependency convergence, and banned duplicate classes. Configure Maven Compiler with `-Xlint:all -Werror`. Bind Checkstyle to `validate` with `java/config/checkstyle.xml`, zero allowed violations, and test sources included; bind SpotBugs to `verify` at maximum effort/high threshold with `java/config/spotbugs-exclude.xml`, failing on findings; bind JaCoCo verification to `verify`. Configure Surefire, Failsafe, source JAR, Javadoc JAR, and reproducible-build checks with exact versions from `compatibility.md`. Suppression files may suppress generated wrapper/bootstrap code only, with a comment naming the exact rule and generated path; they must not blanket-exclude SDK packages. Use Maven Central coordinates recorded in `compatibility.md`.

Run:

```bash
cd java
mvn -N wrapper:wrapper -Dmaven="$(awk -F': ' '/Maven Wrapper distribution:/ {print $2}' compatibility.md)"
chmod +x mvnw
./mvnw -B -ntp help:effective-pom > /tmp/cekat-java-effective-pom.xml
./mvnw -B -ntp validate
```

Expected: wrapper files are generated; `validate` reports `BUILD SUCCESS`; effective POM contains group `ai.cekat`, version `0.1.0`, all four modules, compiler release 17, `-Xlint:all`, `-Werror`, and executions for Checkstyle, SpotBugs, and JaCoCo.

- [ ] **Step 4: Verify dependency boundaries**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core dependency:tree > /tmp/core-deps.txt
! grep -E 'spring|jakarta.servlet' /tmp/core-deps.txt
./mvnw -B -ntp -pl cekat-event-sdk-jakarta-servlet dependency:tree | grep 'jakarta.servlet-api.*provided'
./mvnw -B -ntp verify
! grep -R -nE '^package (com|io)\.cekat|<groupId>(com|io)\.cekat</groupId>' \
  --include='*.java' --include='pom.xml' .
```

Expected: core has neither Spring nor Servlet dependencies; Servlet API is provided scope; compilation has no warnings; Checkstyle, SpotBugs, Enforcer, JaCoCo, tests, and reproducibility checks pass; no alternate Cekat Java package/group appears.

- [ ] **Step 5: Commit the verified build skeleton**

```bash
git add java/.mvn java/mvnw java/mvnw.cmd java/pom.xml java/compatibility.md java/config \
  java/cekat-event-sdk-core/pom.xml java/cekat-event-sdk-jakarta-servlet/pom.xml \
  java/cekat-event-sdk-spring-boot/pom.xml java/conformance-tests/pom.xml
git commit -m "build(java): establish verified Maven reactor"
```

---

### Task 2: Define Immutable Public Models, Visitor Scope, and Strict Local Validation

**Files:**
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/Event.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/Acknowledgement.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/VisitorRequest.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/VisitorContext.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/error/{CekatException,ValidationException}.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/internal/{EventValidator,JsonValueValidator}.java`
- Test: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/{EventValidatorTest,JsonValueValidatorTest,VisitorContextTest}.java`

**Interfaces:**
- Consumes: Header name `X-Cekat-Visitor-ID`, cookie name `_cekat_visitor_id`, safe integer range `±9007199254740991`.
- Produces:
  - `record Event(String email, String phoneNumber, String contactName, String visitorId, Map<String,Object> properties)`
  - `record Acknowledgement(boolean success, String message, String eventKey, List<String> validatedProperties, byte[] rawBody)` with defensive copies
  - `interface VisitorRequest { Optional<String> firstHeader(String name); Optional<String> cookie(String name); }`
  - `VisitorContext.Scope VisitorContext.open(String)` and `open(VisitorRequest)`; `Optional<String> currentVisitorId()`
  - `ValidationException extends CekatException`

- [ ] **Step 1: Write failing model/validation tests**

Include parameterized tests proving: whitespace event key fails; whitespace email plus whitespace phone fails; original email/phone/contact strings are retained; immutable copies protect properties, validated-properties, and raw bytes; safe JSON values pass; `Double.NaN`, infinities, `BigInteger("9007199254740992")`, object arrays, POJOs, non-string map keys, and direct/indirect cycles fail before transport. Assert validation messages contain a safe path such as `properties.order.total`, never the rejected value.

Representative test:

```java
@Test
void rejectsNonFiniteNumberWithoutEchoingValue() {
    Event event = new Event("ada@example.com", null, null, null,
            Map.of("risk", Double.NaN));

    ValidationException error = assertThrows(
            ValidationException.class,
            () -> EventValidator.validate("order_paid", event));

    assertEquals("properties.risk is not a JSON-compatible value", error.getMessage());
    assertFalse(error.getMessage().contains("NaN"));
}
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core \
  -Dtest=EventValidatorTest,JsonValueValidatorTest test
```

Expected: test compilation fails because `Event`, validators, and `ValidationException` do not exist.

- [ ] **Step 3: Implement immutable records and recursive validation**

Use compact constructors to replace null properties with `Map.of()` and recursively defensive-copy accepted maps/lists. Accept only null, `Boolean`, `String`, `Byte`, `Short`, `Integer`, safe `Long`, safe `BigInteger`, finite `Float`/`Double`, finite-compatible `BigDecimal`, `List<?>`, and maps whose keys are strings. For `BigDecimal`, call `stripTrailingZeros`; when its scale is `<= 0`, apply the same safe-integer bound before acceptance. Track containers with an identity set while descending; remove each container on ascent so repeated acyclic references remain legal.

`EventValidator.validate` trims only for emptiness checks. It returns no normalized identity. Visitor normalization belongs to `VisitorContext` and payload resolution.

- [ ] **Step 4: Write failing visitor precedence/scope tests**

```java
@Test
void requestHeaderWinsAndNestedScopesRestore() throws Exception {
    VisitorRequest request = new VisitorRequest() {
        public Optional<String> firstHeader(String name) {
            return Optional.of("  header-id  ");
        }
        public Optional<String> cookie(String name) {
            return Optional.of("cookie-id");
        }
    };

    assertTrue(VisitorContext.currentVisitorId().isEmpty());
    try (VisitorContext.Scope outer = VisitorContext.open(request)) {
        assertEquals("header-id", VisitorContext.currentVisitorId().orElseThrow());
        try (VisitorContext.Scope inner = VisitorContext.open(" explicit ")) {
            assertEquals("explicit", VisitorContext.currentVisitorId().orElseThrow());
        }
        assertEquals("header-id", VisitorContext.currentVisitorId().orElseThrow());
    }
    assertTrue(VisitorContext.currentVisitorId().isEmpty());
}
```

Also test blank header falls through to trimmed cookie, both blank produce no visitor, close is idempotent, exception paths restore prior scope, and a new plain executor thread does not receive scope.

- [ ] **Step 5: Implement the core scope without executor propagation**

Use a private `ThreadLocal<String>` and a scope object that records the previous value. `open(VisitorRequest)` calls only the two fixed names, trims nonblank values, and chooses header before cookie. `Scope.close()` restores the previous value once. Do not use `InheritableThreadLocal`; do not expose the holder.

- [ ] **Step 6: Run core tests and commit**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core test
```

Expected: `BUILD SUCCESS`; all validation, immutability, precedence, restoration, and non-propagation tests pass.

```bash
git add java/cekat-event-sdk-core
git commit -m "feat(java): add event models and visitor scope"
```

---

### Task 3: Add Configuration, Transport Abstraction, and JDK HTTP Transport

**Files:**
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/CekatClientOptions.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/transport/{HttpTransport,JdkHttpTransport,TransportRequest,TransportResponse}.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/internal/BoundedBody.java`
- Test: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/CekatClientOptionsTest.java`
- Test: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/JdkHttpTransportTest.java`
- Test support: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/support/FakeTransport.java`

**Interfaces:**
- Consumes: Java `HttpClient`, origin-only base URL, 10-second per-attempt default.
- Produces:
  - `CekatClientOptions.defaults()` and builder methods `baseUrl(URI)`, `timeout(Duration)`, `retryCount(int)`, `transport(HttpTransport)`
  - `record TransportRequest(URI uri, Map<String,String> headers, byte[] body, Duration timeout)` with defensive copies
  - `interface HttpTransport { TransportResponse execute(TransportRequest request) throws IOException, InterruptedException; }`
  - `TransportResponse(int statusCode, InputStream body) implements AutoCloseable`
  - `JdkHttpTransport(HttpClient)`

- [ ] **Step 1: Write failing option validation tests**

Test defaults and reject: blank token at client construction; relative URI; non-HTTP scheme; credentials/user-info; port remains allowed; query; fragment; every non-root path including `/root/`; zero/negative timeout; negative retries; null injected transport. Assert only `https://example.test` and `https://example.test/` are accepted and normalize to the same origin, an IPv6 origin with port is handled correctly, the fixed request URI becomes exactly `<origin>/api/events/ingest`, and access-token text never appears in an error.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core -Dtest=CekatClientOptionsTest test
```

Expected: FAIL because options do not exist.

- [ ] **Step 2: Implement options and transport records**

Keep options immutable. Validate `baseUrl` as an absolute HTTP(S) origin: scheme and host required; user-info, query, fragment, and non-root path forbidden; normalize only a root trailing slash. Build the ingest URI by appending the fixed path to that validated origin, never by resolving an absolute path against and silently discarding user input. The default transport owns one reusable `HttpClient`; injected clients are not mutated. `JdkHttpTransport.execute` builds a request from `TransportRequest`, applies `HttpRequest.Builder.timeout(request.timeout())`, uses `BodyPublishers.ofByteArray`, and calls `client.send(..., BodyHandlers.ofInputStream())`.

- [ ] **Step 3: Write and pass JDK transport tests with a loopback `HttpServer`**

Tests assert POST, exact `/api/events/ingest`, bearer header, JSON content type, body bytes, per-request timeout, and that interruption is not wrapped. Use a token sentinel and assert it is absent from thrown messages.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core -Dtest=JdkHttpTransportTest test
```

Expected: PASS with one loopback request per non-timeout test and `HttpTimeoutException` for a delayed endpoint.

- [ ] **Step 4: Implement bounded streaming reads and verify the byte cap**

`BoundedBody.read(InputStream)` reads at most 65,537 bytes, returns the first 65,536 and an `oversized` flag, and always closes through `TransportResponse.close()`. Test ASCII, a multibyte UTF-8 character split at byte 65,536, and an unbounded stream that proves the reader stops after byte 65,537.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core -Dtest=BoundedBodyTest test
```

Expected: PASS; retained arrays are exactly 65,536 bytes and public string conversion uses replacement for an incomplete code point.

- [ ] **Step 5: Commit transport foundations**

```bash
git add java/cekat-event-sdk-core
git commit -m "feat(java): add configurable JDK HTTP transport"
```

---

### Task 4: Encode Events and Decode Typed Responses

**Files:**
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/internal/{EventEncoder,ResponseDecoder}.java`
- Create: remaining files under `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/error/`
- Test: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/ResponseDecoderTest.java`
- Test: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/EventEncoderTest.java`

**Interfaces:**
- Consumes: validated event, resolved visitor, bounded response bytes, HTTP status, attempt count.
- Produces: exact snake_case wire JSON; immutable acknowledgement; six typed public errors with status/code/body/attempt/cause/outcome fields where applicable.

Public error shape:

```java
public abstract class CekatException extends RuntimeException {
    protected CekatException(String message, Throwable cause) { super(message, cause); }
}

public final class ValidationException extends CekatException { /* message only */ }

public class ApiException extends CekatException {
    public int statusCode();
    public Optional<String> serverCode();
    public byte[] rawBody();
    public int attempts();
    public boolean deliveryOutcomeUnknown(); // always false
}

public final class AuthenticationException extends ApiException { }
public final class EventDefinitionNotFoundException extends ApiException { }

public final class TransportException extends CekatException {
    public int attempts();
    public boolean deliveryOutcomeUnknown();
}

public final class ResponseDecodeException extends CekatException {
    public int statusCode(); // 200
    public byte[] rawBody();
    public int attempts();
    public boolean deliveryOutcomeUnknown(); // false
}
```

- [ ] **Step 1: Write failing exact-payload tests**

Assert field names and values for all four common events and custom event. Explicit trimmed visitor wins; blank explicit uses context; no visitor omits the field; null optional contact fields are omitted; properties remain dynamic; `business_id` is absent; identity strings remain byte-for-byte unchanged.

Representative expected JSON:

```json
{"event_key":"order_paid","contact_name":" Ada ","phone_number":" +6281 ","email":" ada@example.com ","visitor_id":"explicit-id","is_common":true,"properties":{"order_id":"ord_123"}}
```

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core -Dtest=EventEncoderTest test
```

Expected: FAIL because `EventEncoder` does not exist.

- [ ] **Step 2: Implement deterministic encoding**

Use an internal Jackson `ObjectMapper` configured to reject non-finite numbers and duplicate keys. Build a `LinkedHashMap` in wire-field order after local validation; do not serialize public Java records directly. Resolve `visitor_id` as trimmed explicit value, then `VisitorContext.currentVisitorId()`, then omission.

- [ ] **Step 3: Write failing response matrix tests**

Cover canonical nested success, false outer/inner success, absent/wrong/empty message or event key, non-array/mixed validated properties, invalid JSON, oversized success, extra fields, UTF-8 boundary, conforming error envelope, malformed/non-object error, and statuses `400`, `401`, `404`, `409`, `429`, `500`, and `503`. Assert defensive raw bytes, exact attempt count, and outcome-known false flag. Assert malformed non-200 never becomes `ResponseDecodeException`.

Canonical success fixture:

```json
{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}
```

Canonical error fixture:

```json
{"success":false,"error":"invalid event","code":"invalid_event"}
```

- [ ] **Step 4: Implement strict success and tolerant error decoding**

For status 200, reject oversized/truncated or malformed content with `ResponseDecodeException`. For non-200, extract `error` only when it is a non-empty string and `code` only when it is a string; otherwise use `HttpStatusText.forStatus(status)`. Implement a deterministic standard status-text map covering at least every fixture status and fall back to `HTTP <status>` for unmapped values. Instantiate status-specific error types and never treat status `201`/`204` as success.

- [ ] **Step 5: Run focused and module tests, then commit**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core \
  -Dtest=EventEncoderTest,ResponseDecoderTest test
./mvnw -B -ntp -pl cekat-event-sdk-core test
```

Expected: both commands report `BUILD SUCCESS`; all response matrix assertions pass.

```bash
git add java/cekat-event-sdk-core
git commit -m "feat(java): encode events and expose typed responses"
```

---

### Task 5: Implement Synchronous Client Operations, Retries, and Interruption

**Files:**
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/CekatClient.java`
- Create: `java/cekat-event-sdk-core/src/main/java/ai/cekat/events/internal/RetryExecutor.java`
- Test: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/{CekatClientTest,RetryExecutorTest}.java`
- Test support: `java/cekat-event-sdk-core/src/test/java/ai/cekat/events/support/{FakeTransport,MutableClockSleeper}.java`

**Interfaces:**
- Consumes: Tasks 2–4 types.
- Produces:

```java
public final class CekatClient {
    public CekatClient(String accessToken);
    public CekatClient(String accessToken, CekatClientOptions options);
    public Acknowledgement userRegistration(Event event) throws InterruptedException;
    public Acknowledgement userLogin(Event event) throws InterruptedException;
    public Acknowledgement orderCreated(Event event) throws InterruptedException;
    public Acknowledgement orderPaid(Event event) throws InterruptedException;
    public Acknowledgement customEvent(String eventKey, Event event) throws InterruptedException;
}
```

The internal retry seam is `Sleeper.sleep(Duration) throws InterruptedException` plus a bounded-random function `long nextLong(long exclusiveUpperBound)`; production uses `Thread.sleep` and `ThreadLocalRandom`.

- [ ] **Step 1: Write failing client and retry tests**

Use `FakeTransport` to queue outcomes. Assert: token-only construction; maximum three attempts by default; 500→500→200 succeeds with delays each inside `[0,100]ms` then `[0,200]ms`; three 500s yield `ApiException(attempts=3, outcomeUnknown=false)`; `IOException` exhaustion yields `TransportException(attempts=3, outcomeUnknown=true)`; timeout exhaustion has the same classification; mixed failures classify the final failure; 400/401/404/other statuses have one attempt; validation/encoding has zero calls; each attempt receives 10 seconds; request bytes are identical across retries.

- [ ] **Step 2: Run focused tests and confirm red**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core \
  -Dtest=CekatClientTest,RetryExecutorTest test
```

Expected: FAIL because `CekatClient` and `RetryExecutor` do not exist.

- [ ] **Step 3: Implement the minimal synchronous attempt loop**

Validate and encode once before attempt 1. For each attempt, call `HttpTransport.execute`, read/close response, return valid 200, immediately throw non-500 API errors, or retain a 500 as the retryable result. Catch `IOException` only; never catch `InterruptedException` except to close response resources and rethrow it unchanged. An `IOException` before an HTTP response yields `TransportException(deliveryOutcomeUnknown=true)`; an `IOException` while reading a received response yields `TransportException(deliveryOutcomeUnknown=false)`. Close every received response before retry delay. Before sleeping and before each attempt, check `Thread.currentThread().isInterrupted()` and throw `InterruptedException` without consuming another queued transport result.

Use exact bounds:

```java
long exclusiveUpperBoundMillis = switch (retryIndex) {
    case 1 -> 101L; // sampled values 0..100 inclusive
    case 2 -> 201L; // sampled values 0..200 inclusive
    default -> throw new IllegalArgumentException("retry index out of range");
};
```

For configured retry counts above two, continue capped exponential full jitter: retry `n` uses inclusive `[0,min(100 * 2^(n-1),1000)]ms`, while defaults remain exactly the approved first two bounds. Saturate first—`n >= 5` always uses `[0,1000ms]`—so shifting or multiplication can never overflow.

- [ ] **Step 4: Prove interruption behavior**

Add tests for: pre-interrupted caller makes zero transport calls; interruption thrown by transport is returned raw; interruption during backoff prevents the next attempt; interrupt status is not cleared by SDK code. Public methods declare `throws InterruptedException`; they do not wrap caller interruption as `TransportException`.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core \
  -Dtest=RetryExecutorTest#preInterruptedCallerDoesNotAttempt+transportInterruptionIsNotWrapped+backoffInterruptionStopsRetries test
```

Expected: PASS; each test observes `InterruptedException` and the expected attempt count.

- [ ] **Step 5: Run core verification and commit**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-core verify
```

Expected: `BUILD SUCCESS`; JaCoCo and static checks pass; no token appears in Surefire reports.

```bash
git add java/cekat-event-sdk-core
git commit -m "feat(java): deliver events with bounded retries"
```

---

### Task 6: Add Jakarta Servlet Request Extraction and Async-Safe Dispatch Scoping

**Files:**
- Create: `java/cekat-event-sdk-jakarta-servlet/src/main/java/ai/cekat/events/servlet/{CekatServletRequest,CekatVisitorFilter,CekatAsyncCleanupListener}.java`
- Test: `java/cekat-event-sdk-jakarta-servlet/src/test/java/ai/cekat/events/servlet/{CekatServletRequestTest,CekatVisitorFilterTest,ServletAsyncIntegrationTest}.java`

**Interfaces:**
- Consumes: `VisitorContext`, Jakarta Servlet API, fixed header/cookie names.
- Produces:
  - `CekatVisitorFilter implements jakarta.servlet.Filter`
  - `Optional<String> CekatServletRequest.visitorId(HttpServletRequest request)`
  - `VisitorContext.Scope CekatServletRequest.openScope(HttpServletRequest request)`
  - Public immutable attribute name `CekatServletRequest.VISITOR_ID_ATTRIBUTE`, namespaced as `ai.cekat.events.servlet.visitorId.v1`

- [ ] **Step 1: Write failing extraction and synchronous lifecycle tests**

Assert header-over-cookie, trimming, blank fallback, no cookie mutation, request attribute set before downstream code, `CekatClient` sees ambient visitor during the dispatch, previous core scope restoration after success and exception, and no cross-request leakage on a reused test executor.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-jakarta-servlet -am \
  -Dtest=CekatServletRequestTest,CekatVisitorFilterTest -Dsurefire.failIfNoSpecifiedTests=false test
```

Expected: FAIL because Servlet adapter classes do not exist.

- [ ] **Step 2: Implement request attributes as canonical state**

On first `REQUEST` dispatch, resolve and store only a trimmed nonblank visitor under `VISITOR_ID_ATTRIBUTE`. On `ASYNC` and `ERROR` redispatch, reuse the request attribute rather than re-reading potentially wrapped/mutated inputs. Every dispatch calls `openScope(request)`, invokes `chain.doFilter`, and closes the scope in `finally`. Synchronous completion removes SDK attributes in that same `finally`.

Core scope usage must be structurally equivalent to:

```java
try (VisitorContext.Scope ignored = CekatServletRequest.openScope(request)) {
    chain.doFilter(request, response);
} finally {
    if (!request.isAsyncStarted()) {
        CekatServletRequest.clear(request);
    }
}
```

- [ ] **Step 3: Write failing real-container async lifecycle tests**

Use the verified maintained embedded Servlet container test dependency. Cover:

1. `REQUEST` starts async and returns; request attribute remains, thread-local scope is empty.
2. `ASYNC` redispatch exposes the same visitor during downstream handling.
3. Completion removes request attributes.
4. `onError` and `onTimeout` remove attributes.
5. `onStartAsync` registers cleanup for a restarted async cycle.
6. `ERROR` dispatch opens and restores scope without double extraction.
7. Two interleaved async requests retain distinct visitor IDs.
8. `CompletableFuture.runAsync` without explicit wrapping does not see visitor state.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-jakarta-servlet -am \
  -Dtest=ServletAsyncIntegrationTest -Dsurefire.failIfNoSpecifiedTests=false test
```

Expected: FAIL on missing async listener behavior before implementation.

- [ ] **Step 4: Implement terminal cleanup and listener re-registration**

Register one listener per async cycle using a private request marker. `onComplete`, `onError`, and `onTimeout` call idempotent `CekatServletRequest.clear`. `onStartAsync` moves/re-registers the listener on `event.getAsyncContext()` and resets the cycle marker. Do not leave a thread-local scope open while async work is pending, and do not wrap user tasks or use `InheritableThreadLocal`.

- [ ] **Step 5: Verify all dispatcher paths and commit**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-jakarta-servlet -am verify
```

Expected: `BUILD SUCCESS`; REQUEST/ASYNC/ERROR, terminal cleanup, concurrency, and non-propagation tests all pass.

```bash
git add java/cekat-event-sdk-jakarta-servlet
git commit -m "feat(java): add async-safe Servlet visitor filter"
```

---

### Task 7: Add Spring Boot Auto-Configuration and MVC Integration

**Files:**
- Create: `java/cekat-event-sdk-spring-boot/src/main/java/ai/cekat/events/spring/{CekatEventSdkProperties,CekatEventSdkAutoConfiguration}.java`
- Create: `java/cekat-event-sdk-spring-boot/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`
- Create: `java/cekat-event-sdk-spring-boot/src/main/resources/META-INF/spring-configuration-metadata.json`
- Test: `java/cekat-event-sdk-spring-boot/src/test/java/ai/cekat/events/spring/{CekatEventSdkAutoConfigurationTest,CekatSpringMvcIntegrationTest}.java`

**Interfaces:**
- Consumes: core client/options, `CekatVisitorFilter`, verified maintained Spring Boot line.
- Produces: properties `cekat.access-token`, `cekat.base-url`, `cekat.timeout`, `cekat.retry-count`; conditional `CekatClient`; async-enabled `FilterRegistrationBean<CekatVisitorFilter>` for `REQUEST`, `ASYNC`, and `ERROR`.

- [ ] **Step 1: Write failing auto-configuration tests**

Using `ApplicationContextRunner`, assert: token creates exactly one client; absent/blank token fails startup with a redacted message; user `CekatClient` backs off auto-configuration; property values map exactly to options; filter order is early and deterministic; registration is async-supported and includes all three dispatch types; core remains independent from Spring.

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-spring-boot -am \
  -Dtest=CekatEventSdkAutoConfigurationTest -Dsurefire.failIfNoSpecifiedTests=false test
```

Expected: FAIL because auto-configuration is absent.

- [ ] **Step 2: Implement properties and conditional beans**

Use `@ConfigurationProperties("cekat")` with `String accessToken`, `URI baseUrl`, `Duration timeout`, and `int retryCount`. Defaults mirror core. Use `@AutoConfiguration`, `@EnableConfigurationProperties`, `@ConditionalOnMissingBean`, and `@ConditionalOnWebApplication(type = SERVLET)`. Never render the token in `toString`, binding exceptions, or validation messages.

The imports resource contains exactly:

```text
ai.cekat.events.spring.CekatEventSdkAutoConfiguration
```

- [ ] **Step 3: Write failing MVC request/async tests**

With a Boot test application and MockMvc, assert a controller calling `orderPaid` receives visitor from header, cookie fallback works, explicit event visitor wins, exception response cleanup works, and MVC async dispatch preserves request-attribute state while leaving the original and redispatch threads clean after each dispatch.

- [ ] **Step 4: Implement filter registration and metadata**

Register the same Servlet filter; do not duplicate extraction in a Spring interceptor. Set async support, dispatch types `REQUEST`, `ASYNC`, `ERROR`, URL pattern `/*`, and a documented order before application filters without assuming authentication semantics.

- [ ] **Step 5: Verify Spring adapter and commit**

Run:

```bash
cd java
./mvnw -B -ntp -pl cekat-event-sdk-spring-boot -am verify
```

Expected: `BUILD SUCCESS`; context, property, synchronous MVC, async MVC, exception, and cleanup tests pass.

```bash
git add java/cekat-event-sdk-spring-boot
git commit -m "feat(java): add Spring Boot visitor auto-configuration"
```

---

### Task 8: Run Java Against Shared Conformance Fixtures

**Files:**
- Create: `java/conformance-tests/src/test/java/ai/cekat/events/conformance/{ConformanceContract,MockControlClient,ConformanceClientTest}.java`
- Create: `java/scripts/conformance`
- Consume without modifying: `conformance/fixtures/cases/*.json`
- Consume without modifying: `conformance/mock-ingest-server/`

**Interfaces:**
- Consumes: running shared mock server with `POST /__control/reset`, `POST /__control/responses`, `GET /__control/requests`, and ingest `POST /api/events/ingest`; queued response `{status,headers?,body,delay_ms?,disconnect_before_headers?}`.
- Produces: executable `java/scripts/conformance`. It accepts no positional arguments and requires exactly `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_CONTROL_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and `CEKAT_CONFORMANCE_FIXTURES`; it reads no aliases, defaults, repository-relative fixture path, or additional conformance variables and exits nonzero on any Java/shared-contract mismatch.

- [ ] **Step 1: Write a failing fixture-driven conformance test**

`ConformanceContract` discovers every `*.json` file directly in the absolute directory supplied as `CEKAT_CONFORMANCE_FIXTURES`; explicit filename allowlists are forbidden. Before case execution it rejects duplicate IDs and unknown/missing `schema_version`, case kind, operation, properties recipe, response-body recipe, cancellation phase, queued mock-response field/form, or `expect.result`, naming the case ID. It maps all known expected outcomes to Java acknowledgements/errors/interruption. `MockControlClient` uses only `CEKAT_CONFORMANCE_CONTROL_URL`, posts response queues as `{"responses":[...]}`, validates journal wrapper `{"requests":[...]}`, and never derives controls from the ingest origin. Tests construct `CekatClient` with `CEKAT_CONFORMANCE_BASE_URL` and `CEKAT_CONFORMANCE_ACCESS_TOKEN`; they cover every discovered case, including endpoint/auth, common/custom payloads, visitor precedence, all invalid runtime recipes/no request, canonical acknowledgement, exact structured and synthesized error messages, malformed 200/non-200, bounded bodies, retry/certainty forms, all permanent responses, delayed timeout, disconnect-before-headers, cancellation phases, and token redaction. Maintain discovered and executed ID sets; teardown fails if any required case was skipped or lacked an executed assertion.

Representative control call:

```java
control.reset();
control.queue(List.of(
    new ResponseSpec(500, Map.of(), "{\"success\":false,\"error\":\"retry\"}", 0, false),
    new ResponseSpec(200, Map.of(), CANONICAL_SUCCESS, 0, false)
));
Acknowledgement ack = client.orderPaid(EVENT);
assertEquals("order_paid", ack.eventKey());
assertEquals(2, control.requests().size());
```

- [ ] **Step 2: Run against the shared server and confirm red**

From the repository root, start the server from its Go module directory and parse the first readiness JSON record:

```bash
READY="$(mktemp)"
(
  cd conformance/mock-ingest-server
  exec go run ./cmd/mock-ingest-server --listen 127.0.0.1:0
) >"$READY" 2>"$READY.stderr" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; rm -f "$READY" "$READY.stderr"' EXIT
for _ in $(seq 1 100); do test -s "$READY" && break; sleep 0.1; done
BASE_URL="$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readline())["base_url"])' "$READY")"
CONTROL_URL="$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).readline())["control_url"])' "$READY")"
CEKAT_CONFORMANCE_BASE_URL="$BASE_URL" \
CEKAT_CONFORMANCE_CONTROL_URL="$CONTROL_URL" \
CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
CEKAT_CONFORMANCE_FIXTURES="$(pwd)/conformance/fixtures/cases" \
java/scripts/conformance
```

Expected: tests fail until fixture loader, strict dispatch, control client, and assertions are complete; readiness is parsed rather than assumed, and the trap terminates the server. No command runs a non-main Go directory.

- [ ] **Step 3: Implement fixture mapping and exact observations**

Use the public `CekatClient` only. Expand each known properties/body recipe in Java, execute operation dispatch exhaustively, propagate cancellation as interruption, and compare exact result form, attempts, outcome certainty, status, caller-visible `error_message`, bounded body, method, path, authorization, and parsed request JSON. Separately check preserved identity string bytes where fixtures require it. Unknown values fail rather than fall through, and Java-specific behavior may not weaken shared fixtures.

- [ ] **Step 4: Add the stable executable entry point**

`java/scripts/conformance` must use `set -euo pipefail`, reject positional arguments, require all four nonempty variables, validate both URLs as HTTP(S) origins, and validate the fixture path as an absolute readable directory. It then executes:

```bash
exec "$JAVA_DIR/mvnw" -f "$JAVA_DIR/pom.xml" -B -ntp \
  -pl conformance-tests -am verify \
  -Dcekat.conformance.baseUrl="$CEKAT_CONFORMANCE_BASE_URL" \
  -Dcekat.conformance.controlUrl="$CEKAT_CONFORMANCE_CONTROL_URL" \
  -Dcekat.conformance.accessToken="$CEKAT_CONFORMANCE_ACCESS_TOKEN" \
  -Dcekat.conformance.fixtures="$CEKAT_CONFORMANCE_FIXTURES"
```

- [ ] **Step 5: Run the public script and commit**

Run the Step 2 readiness/lifecycle command after `chmod +x java/scripts/conformance`.

Expected: `BUILD SUCCESS` only when every discovered required fixture has an executed assertion; unknown, duplicate, skipped, or unexecuted cases fail; the server journal proves no request for locally invalid events.

```bash
git add java/conformance-tests java/scripts/conformance
git commit -m "test(java): enforce shared event conformance"
```

---

### Task 9: Document Usage, Semantics, and Adapter Boundaries

**Files:**
- Create: `java/README.md`
- Modify: `README.md` to link the Java package without changing other language instructions

**Interfaces:**
- Consumes: public APIs from Tasks 2–8.
- Produces: copy-paste Java, Servlet, and Spring examples; explicit operational limitations.

- [ ] **Step 1: Write a documentation assertion script and run it red**

Run:

```bash
for text in \
  'https://t.cekat.ai/api/events/ingest' \
  '_cekat_visitor_id' \
  'X-Cekat-Visitor-ID' \
  'accepted for asynchronous processing' \
  'may create duplicate events' \
  'does not propagate into executor tasks'; do
  grep -F "$text" java/README.md
done
```

Expected: command fails because `java/README.md` does not exist.

- [ ] **Step 2: Write complete core usage documentation**

Include token-only construction, options, every event method, typed exception catches, `InterruptedException`, explicit `VisitorContext.open` in try-with-resources, acknowledgement semantics, retry duplication warning, background-event identity behavior, no separate identify call, no token in browser code, and exact base URL restriction.

Representative sample:

```java
CekatClient client = new CekatClient(System.getenv("CEKAT_ACCESS_TOKEN"));
Event event = new Event(
        "ada@example.com",
        null,
        "Ada Lovelace",
        null,
        Map.of("order_id", "ord_123"));

try {
    Acknowledgement acknowledgement = client.orderPaid(event);
    System.out.println(acknowledgement.eventKey());
} catch (InterruptedException interrupted) {
    Thread.currentThread().interrupt();
    throw new IllegalStateException("event submission interrupted", interrupted);
}
```

- [ ] **Step 3: Document Servlet and Spring installation precisely**

Show Servlet programmatic filter registration with async support and dispatchers, and Spring configuration:

```properties
cekat.access-token=${CEKAT_ACCESS_TOKEN}
cekat.base-url=https://t.cekat.ai
cekat.timeout=10s
cekat.retry-count=2
```

State that request attributes survive servlet async redispatch, thread scope exists only while a dispatch is executing, and user-created tasks must pass explicit immutable data rather than expecting ambient propagation.

- [ ] **Step 4: Verify snippets compile and documentation assertions pass**

Extract Java code blocks into test fixtures or compile them through a Javadoc/snippet test in the relevant module.

Run:

```bash
cd java
./mvnw -B -ntp verify
cd ..
for text in \
  'https://t.cekat.ai/api/events/ingest' \
  '_cekat_visitor_id' \
  'X-Cekat-Visitor-ID' \
  'accepted for asynchronous processing' \
  'may create duplicate events' \
  'does not propagate into executor tasks'; do
  grep -F "$text" java/README.md
done
```

Expected: build and every grep succeed.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md java/README.md
git commit -m "docs(java): document SDK and request scope"
```

---

### Task 10: Add Deterministic No-Publish Package Preparation

**Files:**
- Create: `java/scripts/package`
- Modify: `java/pom.xml`
- Modify: three publishable module POMs
- Test: shell assertions executed against a temporary output directory

**Interfaces:**
- Consumes: exact root contract `<language>/scripts/package --version 0.1.0 --output <absolute-dir>`.
- Produces: tested main/source/Javadoc JARs and POMs plus `<output>/manifest.json`:

```json
{
  "schema_version": 1,
  "language": "java",
  "version": "0.1.0",
  "artifacts": [
    {"path":"ai/cekat/cekat-event-sdk-core/0.1.0/cekat-event-sdk-core-0.1.0.jar","sha256":"64 lowercase hex characters","size_bytes":12345}
  ]
}
```

Artifact entries are sorted by path; paths are output-relative and contain no `..`; hashes cover exact bytes. The command never publishes or signs.

- [ ] **Step 1: Write and run failing package-contract assertions**

Run:

```bash
rm -rf /tmp/cekat-java-package
java/scripts/package --version 0.1.0 --output /tmp/cekat-java-package
test -f /tmp/cekat-java-package/manifest.json
```

Expected: FAIL because the script does not exist.

- [ ] **Step 2: Configure reproducible source/Javadoc/main artifacts**

Ensure all three publishable modules attach source and Javadoc JARs, include Apache/MIT license metadata according to repository policy, developer/project URLs, SCM coordinates, and no test classes or secrets. Keep `conformance-tests` unpublished.

- [ ] **Step 3: Implement strict argument and output validation**

The POSIX shell script accepts only version `0.1.0`, requires an absolute empty/nonexistent output directory, and runs `./mvnw -B -ntp clean verify`. For each of the three publishable artifacts it copies the main, sources, and Javadoc JARs plus the effective release POM into exact Maven repository layout `ai/cekat/<artifactId>/0.1.0/<artifactId>-0.1.0[-sources|-javadoc].jar` and `ai/cekat/<artifactId>/0.1.0/<artifactId>-0.1.0.pom`; conformance artifacts are excluded. It computes SHA-256 and byte size and writes deterministic sorted JSON. Use a small Java source-file-mode helper embedded in the script for portable JSON escaping and SHA-256 rather than platform-specific `sha256sum`.

- [ ] **Step 4: Verify positive and negative package behavior**

Run:

```bash
rm -rf /tmp/cekat-java-package
java/scripts/package --version 0.1.0 --output /tmp/cekat-java-package
python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path('/tmp/cekat-java-package').resolve()
data = json.loads((root / 'manifest.json').read_text())
assert data['schema_version'] == 1
assert data['language'] == 'java'
assert data['version'] == '0.1.0'
paths = [a['path'] for a in data['artifacts']]
assert paths == sorted(paths) and paths
expected_artifacts = {
    'cekat-event-sdk-core',
    'cekat-event-sdk-jakarta-servlet',
    'cekat-event-sdk-spring-boot',
}
assert all(path.startswith('ai/cekat/') for path in paths)
assert {path.split('/')[2] for path in paths} == expected_artifacts
for artifact_id in expected_artifacts:
    base = f'ai/cekat/{artifact_id}/0.1.0/{artifact_id}-0.1.0'
    assert {base + '.jar', base + '-sources.jar', base + '-javadoc.jar', base + '.pom'} <= set(paths)
for item in data['artifacts']:
    assert '..' not in pathlib.PurePosixPath(item['path']).parts
    artifact = (root / item['path']).resolve()
    assert artifact.is_relative_to(root)
    content = artifact.read_bytes()
    assert len(content) == item['size_bytes']
    assert hashlib.sha256(content).hexdigest() == item['sha256']
PY
TMP_SETTINGS="$(mktemp)"
cat >"$TMP_SETTINGS" <<'XML'
<settings><profiles><profile><id>staged</id><repositories><repository><id>staged</id><url>file:///tmp/cekat-java-package</url></repository></repositories></profile></profiles><activeProfiles><activeProfile>staged</activeProfile></activeProfiles></settings>
XML
for artifact in cekat-event-sdk-core cekat-event-sdk-jakarta-servlet cekat-event-sdk-spring-boot; do
  for coordinate in \
    "ai.cekat:${artifact}:0.1.0" \
    "ai.cekat:${artifact}:0.1.0:jar:sources" \
    "ai.cekat:${artifact}:0.1.0:jar:javadoc" \
    "ai.cekat:${artifact}:0.1.0:pom"; do
    java/mvnw -B -ntp -s "$TMP_SETTINGS" -o dependency:get \
      -Dartifact="$coordinate" \
      -DremoteRepositories="staged::default::file:///tmp/cekat-java-package"
  done
done
rm -f "$TMP_SETTINGS"
! java/scripts/package --version 1.0.0 --output /tmp/rejected-java-version
! java/scripts/package --version 0.1.0 --output relative/path
```

Expected: package build and manifest validator pass; every POM/main/sources/Javadoc artifact resolves from the temporary file-based Maven repository under `ai/cekat/`; both invalid invocations fail before building.

- [ ] **Step 5: Inspect package contents and commit**

Run:

```bash
find /tmp/cekat-java-package -name '*.jar' -print0 | while IFS= read -r -d '' jar; do
  jar tf "$jar" >/dev/null
  ! jar tf "$jar" | grep -E '(^|/)(CEKAT_ACCESS_TOKEN|access-token)|(^|/)src/test/'
done
cd java
./mvnw -B -ntp verify
```

Expected: all JARs are readable; the negated grep proves no test tree or credential-named entry exists; reactor verification succeeds.

```bash
git add java/scripts/package java/pom.xml \
  java/cekat-event-sdk-core/pom.xml \
  java/cekat-event-sdk-jakarta-servlet/pom.xml \
  java/cekat-event-sdk-spring-boot/pom.xml
git commit -m "build(java): prepare deterministic package artifacts"
```

---

### Task 11: Run Full Verification and the Release-Time Compatibility Gate

**Files:**
- Modify: `java/compatibility.md` only if release-time official evidence changed an exact supported patch while preserving the approved Java 17 compatibility floor.
- No registry credentials, signing keys, publication configuration, or release tags are added.

**Interfaces:**
- Consumes: complete Java reactor, shared mock server, package scripts, official lifecycle sources.
- Produces: reviewable release-readiness evidence; no publication.

- [ ] **Step 1: Re-run official version checks immediately before release readiness**

Repeat Task 1 downloads into a fresh dated directory, record new SHA-256 values and retrieval date, and compare maintained JDK, Maven, Spring Boot, and Servlet lines with `java/compatibility.md`.

Run:

```bash
java -version
java/mvnw --version
curl -fL https://www.oracle.com/java/technologies/java-se-support-roadmap.html -o /tmp/java-roadmap-release.html
curl -fL https://github.com/spring-projects/spring-boot/wiki/Supported-Versions -o /tmp/spring-supported-release.html
sha256sum /tmp/java-roadmap-release.html /tmp/spring-supported-release.html
```

Expected: selected runtime/framework lines remain maintained and compatible. If not, stop release preparation and obtain approval for a compatibility-policy change; do not silently alter the floor or public artifact split.

- [ ] **Step 2: Run all unit, integration, conformance, and static checks**

Run `cd java && ./mvnw -B -ntp clean verify`, then run Task 8 Step 2's exact readiness-parsing command to start `go run ./cmd/mock-ingest-server` from `conformance/mock-ingest-server` and invoke `java/scripts/conformance` with all four required variables.

Expected: both Maven invocations report `BUILD SUCCESS`; the reactor runs core, Servlet, Spring, and conformance tests; compiler warnings are errors; Checkstyle and SpotBugs pass; package dependency boundaries remain intact; the shared server is readiness-checked and terminated by the trap.

- [ ] **Step 3: Verify Java 17 bytecode and public API package boundaries**

Run:

```bash
find java -path '*/target/classes/*.class' -print0 | xargs -0 javap -verbose \
  | awk '/major version:/ { if ($3 != 61) { print; bad=1 } } END { exit bad }'
jdeps --multi-release 17 --ignore-missing-deps \
  java/cekat-event-sdk-core/target/cekat-event-sdk-core-0.1.0.jar
! jdeps --multi-release 17 \
  java/cekat-event-sdk-core/target/cekat-event-sdk-core-0.1.0.jar \
  | grep -E 'springframework|jakarta.servlet'
```

Expected: every production class has major version `61` (Java 17); `jdeps` resolves core without Spring or Servlet packages.

- [ ] **Step 4: Build and independently validate no-publish artifacts**

Run:

```bash
rm -rf /tmp/cekat-java-release-readiness
java/scripts/package --version 0.1.0 --output /tmp/cekat-java-release-readiness
python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path('/tmp/cekat-java-release-readiness').resolve()
manifest = json.loads((root / 'manifest.json').read_text())
assert manifest['schema_version'] == 1
assert manifest['language'] == 'java'
assert manifest['version'] == '0.1.0'
assert manifest['artifacts'] == sorted(manifest['artifacts'], key=lambda a: a['path'])
for entry in manifest['artifacts']:
    path = (root / entry['path']).resolve()
    assert path.is_relative_to(root)
    data = path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == entry['sha256']
    assert len(data) == entry['size_bytes']
PY
```

Expected: artifact build and independent manifest verification pass; no network publication or signing operation occurs.

- [ ] **Step 5: Inspect the final diff for protocol drift and secrets**

Run:

```bash
git diff --check
git grep -nE '/internal/api|/api/v1|business_id|X-Cekat-Visitor-Id' -- java ':!java/target'
! git grep -nE 'Bearer [A-Za-z0-9_-]{12,}|CEKAT_ACCESS_TOKEN=' -- java ':!java/README.md'
git status --short
```

Expected: `git diff --check` passes; the drift scan emits no matches; no literal credential is present; status lists only intentional release-gate documentation changes, if official evidence required an exact pin update.

- [ ] **Step 6: Commit release-gate evidence only when it changed**

If `java/compatibility.md` changed after the official recheck:

```bash
git add java/compatibility.md java/pom.xml java/*/pom.xml
git commit -m "build(java): refresh verified compatibility pins"
```

Expected: commit contains only exact verified version/evidence updates. If no compatibility file or POM changed, do not create an empty commit.

---

## Execution Dependencies and Review Gates

1. The shared conformance fixtures, JSON schemas, and mock server must exist before Task 8. Tasks 1–7 are independently executable with Java-local fakes and loopback servers.
2. Task 1 is a blocking execution-time gate. An executor must not create unverified Maven version pins or claim future runtime support.
3. Task 6 requires a maintained embedded Jakarta Servlet 6-compatible test container selected and pinned during Task 1. Request attributes, not thread-local state, remain authoritative if container lifecycle details differ.
4. Task 7 uses the maintained Spring Boot line verified in Task 1. If its Java floor exceeds 17 or it no longer uses a compatible Servlet namespace, stop for product review rather than silently raising the SDK floor.
5. Task 8 relies only on the stable mock-control contract and public Java API; Java-specific behavior may not weaken shared fixtures.
6. Task 10 implements release preparation only. Registry ownership, signing, staging repositories, credentials, and publication remain external release-owner gates.
7. Task 11 is a blocking release-time gate. A reviewer must approve compatibility evidence, conformance output, Servlet async lifecycle tests, package manifest/hash validation, and the absence of protocol drift before publication work is considered.

## Final Acceptance Checklist

- [ ] `new CekatClient(accessToken)` works with the fixed production endpoint and documented defaults.
- [ ] All five event operations validate locally, preserve submitted identities, enforce wire keys, and attach the correctly trimmed explicit/ambient visitor.
- [ ] Success and error envelopes match the authoritative nested-success/top-level-error schemas.
- [ ] Bodies are bounded to exactly 65,536 bytes and exposed defensively.
- [ ] Retries occur only for transport/eligible timeout/500, with exact default jitter bounds and maximum three attempts.
- [ ] Interruption is never retried or wrapped, and delays are interruptible.
- [ ] Every public failure maps to one of the six required typed categories with correct attempts and outcome certainty.
- [ ] Servlet request attributes survive async redispatch and are cleared on complete, error, and timeout; dispatch-local scope is restored in every `finally`.
- [ ] No arbitrary executor propagation is implemented or promised.
- [ ] Spring auto-configuration delegates to the same core and Servlet implementation.
- [ ] `java/scripts/conformance` passes the shared fixtures.
- [ ] `java/scripts/package --version 0.1.0 --output <absolute-dir>` produces validated, deterministic, unsigned, unpublished artifacts.
- [ ] Execution-time and release-time version gates record exact official evidence without projected patch claims.
