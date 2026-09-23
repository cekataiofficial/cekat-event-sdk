# Cekat Java Event SDK

Submit identity-bearing Cekat events from Java backends and automatically attach the browser visitor ID (from the `X-Cekat-Visitor-ID` header or `_cekat_visitor_id` cookie) of the request being handled.

Requires Java 17 or newer. Artifacts (group `ai.cekat`, version `0.2.0`):

| Artifact | Contents | Dependencies |
| --- | --- | --- |
| `cekat-event-sdk-core` | `CekatClient`, events, errors, `VisitorContext` | none (JDK `java.net.http` only) |
| `cekat-event-sdk-jakarta-servlet` | `CekatVisitorFilter` for Jakarta Servlet 6 containers (Tomcat 10.1/11, Jetty 12, Undertow) | core; Servlet API `provided` |
| `cekat-event-sdk-spring-boot` | Auto-configuration for Spring Boot 4.0 and 4.1 | core, servlet; your Spring Boot version |

```xml
<dependency>
  <groupId>ai.cekat</groupId>
  <artifactId>cekat-event-sdk-spring-boot</artifactId>
  <version>0.2.0</version>
</dependency>
```

The core has no runtime dependencies, so it never conflicts with your Jackson or HTTP client versions.

## Submit events

Construct one client and reuse it; it is thread-safe. Only the access token is required, and it belongs in server-side configuration only.

```java
CekatClient client = new CekatClient(System.getenv("CEKAT_ACCESS_TOKEN"));

Event event = Event.builder()
        .email("ada@example.com")
        .contactName("Ada Lovelace")
        .property("order_id", "ord_123")
        .build();

try {
    client.userRegistration(event);
    client.userLogin(Event.builder().phoneNumber("+628123456789").build());
    client.orderCreated(event);
    client.formSubmitted(event);
    client.orderPaid(new BigDecimal("125000"), "IDR", event);
    Acknowledgement acknowledgement = client.customEvent("wishlist_updated", event);
    System.out.println(acknowledgement.eventKey());
} catch (InterruptedException interrupted) {
    Thread.currentThread().interrupt();
    throw new IllegalStateException("event submission interrupted", interrupted);
}
```

`formSubmitted(event)` sends the common `form_submitted` event (`is_common: true`). `orderPaid(amount, currency, event)` additionally requires a finite `amount` (any `Number`, such as `BigDecimal`) and a nonblank `currency`, sent as the `amount` and `currency` properties; do not also put those keys in the event's properties.

Events are sent to `https://server.cekat.ai/api/events/ingest`. An `Acknowledgement` means Cekat accepted the event for asynchronous processing. It does not confirm durable storage, identity resolution, delivery completion, or analytics availability.

At least one of `email` or `phoneNumber` must be nonblank; identity strings are sent unchanged. Property values may be `null`, `Boolean`, `String`, finite numbers (`Byte`, `Short`, `Integer`, `Long`, `Float`, `Double`, `BigInteger`, `BigDecimal`), `List`s, and `Map`s with `String` keys. Integers must be within ±9,007,199,254,740,991. Other objects (including `Instant` — format it first), arrays, cycles, and non-`String` keys throw `ValidationException` before any request.

## Event IDs and timestamps

Every event carries an `event_id` and an `occurred_at` timestamp. When `eventId` is blank the SDK generates a random UUID, and when `occurredAt` (an `Instant`) is not set it uses the time of the call. Both are fixed before the first attempt and reused by every retry, so Cekat can recognize retried deliveries. Supply your own `eventId` when the same business event may be sent more than once:

```java
client.orderPaid(order.total(), order.currency(), Event.builder()
        .email(order.email())
        .eventId("order-paid-" + order.id())
        .occurredAt(order.paidAt())
        .build());
```

## Request visitor context

Install the integration at the request boundary. While a request is handled, event calls on that thread attach its visitor ID automatically. A nonblank explicit `visitorId` on the event takes precedence; a blank one falls back to the request. Visitor IDs are untrusted correlation data: never use them for authentication or authorization.

### Spring Boot

Adding `cekat-event-sdk-spring-boot` registers the visitor filter automatically, and creates a `CekatClient` bean when the access token is set:

```properties
cekat.access-token=${CEKAT_ACCESS_TOKEN}
cekat.base-url=https://server.cekat.ai
cekat.timeout=3s
cekat.retry-count=2
```

```java
@RestController
class OrdersController {
    private final CekatClient cekat;

    OrdersController(CekatClient cekat) {
        this.cekat = cekat;
    }

    @PostMapping("/orders/{id}/paid")
    void paid(@PathVariable("id") String id) throws InterruptedException {
        cekat.orderPaid(new BigDecimal("125000"), "IDR", Event.builder().email("buyer@example.com").property("order_id", id).build());
    }
}
```

Without `cekat.access-token` no client bean is created (a blank value fails startup). Define your own `CekatClient` bean to customize it; set `cekat.visitor-filter-enabled=false` to register the filter yourself.

### Jakarta Servlet

```java
FilterRegistration.Dynamic filter = servletContext.addFilter("cekatVisitorFilter", new CekatVisitorFilter());
filter.setAsyncSupported(true);
filter.addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR), false, "/*");
```

The filter resolves the visitor once per request and stores it in the request attribute `CekatServletRequest.VISITOR_ID_ATTRIBUTE`, which survives async redispatch and is removed when the request completes, errors, or times out. The thread scope exists only while a dispatch is executing and is always closed when it returns. `CekatServletRequest.visitorId(request)` reads the value from any code that has the request.

### Other frameworks and explicit scopes

```java
try (VisitorContext.Scope scope = VisitorContext.open(visitorId)) {
    client.userLogin(event);
}
```

`VisitorContext.open(VisitorRequest)` resolves the header and cookie from any request abstraction.

### Threads and background work

The visitor scope is thread-local and does not propagate into executor tasks, `CompletableFuture`s, `@Async` methods, or virtual threads you start. Capture the visitor ID while handling the request and pass it explicitly:

```java
String visitorId = VisitorContext.currentVisitorId().orElse(null);
executor.submit(() -> {
    try {
        client.userLogin(Event.builder().email(email).visitorId(visitorId).build());
    } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
    } catch (CekatException failure) {
        log.warn("Cekat user_login failed", failure);
    }
});
```

Submitting from a background executor also keeps tracking off the request's critical path. Jobs that run later need only the contact's email or phone number.

## Stripe metadata composition

Use the helper with the merchant's Stripe client; it does not create a Stripe request or send a Cekat event.

```java
import ai.cekat.events.stripe.StripeMetadata;

Map<String, String> metadata = StripeMetadata.mergeMetadata(merchantMetadata, StripeMetadata.fromCurrentVisitor().get("cekat_" + "visitor_id"));
// paymentIntentParams.putMetadata(metadata);
// checkoutSessionParams.putMetadata(metadata); // and payment-mode PaymentIntent metadata
```

Only a trimmed 1–128 character `[A-Za-z0-9_-]` visitor becomes the Stripe visitor metadata entry. Merge returns a new immutable map, preserving merchant keys and leaving invalid or absent visitor input unchanged.

## Errors, interruption, and retries

All SDK exceptions extend the unchecked `CekatException`, which exposes `attempts()` and `deliveryOutcomeUnknown()`:

| Exception | Meaning |
| --- | --- |
| `ValidationException` | Invalid configuration or event input; nothing was sent. |
| `AuthenticationException` | HTTP 401. Extends `ApiException`. |
| `EventDefinitionNotFoundException` | HTTP 404. Extends `ApiException`. |
| `ApiException` | Any other non-200 response: `statusCode()`, `serverCode()`, bounded `rawBody()`. |
| `ResponseDecodeException` | HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received. |
| `TransportException` | No response after all attempts. `deliveryOutcomeUnknown()` is `true`: Cekat may have received it. |

Event methods declare `InterruptedException`: interrupting the calling thread stops a request or a retry delay immediately, without retrying or wrapping. Restore the interrupt flag when you catch it.

Transport failures, per-attempt timeouts, and HTTP 429, 500, 502, 503, and 504 are retried, up to `retryCount` retries (default 2). Delays use capped exponential full jitter (up to 100ms, 200ms, 400ms, 800ms, then 1s). A valid `Retry-After` header raises the delay to the server's value; above 5 seconds the SDK throws immediately instead of blocking. Other statuses, including 400, 401, and 404, are not retried, and a received 200 is never retried. Retries may create duplicate events when an attempt's outcome was unknown; they reuse the same `event_id`, but the SDK does not guarantee server-side deduplication.

## Configuration

```java
CekatClient client = new CekatClient(token, CekatClientOptions.builder()
        .baseUrl("https://server.cekat.ai")
        .timeout(Duration.ofSeconds(3))
        .retryCount(2)
        .build());
```

`baseUrl` must be an absolute HTTP(S) origin without credentials, path, query, or fragment. `timeout` covers connecting, sending, the response headers, and the body of each attempt. Requests send `User-Agent: cekat-event-sdk-java/<version>`. The default transport never follows redirects and reads at most 65,537 response bytes; `transport(HttpTransport)` accepts `new JdkHttpTransport(yourHttpClient)` or your own implementation.

## Development

```sh
./mvnw verify                                    # tests; Checkstyle and SpotBugs also run on JDK 21+
./mvnw verify -Dspring-boot.version=4.0.8        # test the Spring module against another Boot line
./scripts/package --version 0.2.0 --output /absolute/empty-directory
```

`scripts/package` runs the full build and writes the parent POM plus each module's POM, jar, sources jar, and Javadoc jar in Maven repository layout with a SHA-256 `manifest.json`. It never deploys, signs, tags, or pushes. Releases run from the repository's `release-java.yml` workflow when a `java/vX.Y.Z` tag is pushed: it signs and uploads those artifacts to the Sonatype Portal and stops at `VALIDATED`, leaving the final Publish to a release owner. See the root release checklist. `scripts/conformance` runs the shared conformance fixtures, including the three caller-cancellation cases; see `conformance/README.md`.
