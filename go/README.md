# Cekat Go Event SDK

`golang.cekat.ai/event-sdk` synchronously submits Cekat events over HTTP. The core module and its standard `net/http` middleware require Go 1.22 or newer and have no third-party dependencies. Gin v1, Echo v4, Fiber v3, and Chi v5 adapters are separate modules, so you only download the framework you use.

```sh
go get golang.cekat.ai/event-sdk
# Optional, only for the framework you use:
go get golang.cekat.ai/event-sdk/middleware/gin
```

| Module | Minimum Go |
| --- | --- |
| `golang.cekat.ai/event-sdk` (includes `middleware/nethttp`) | 1.22 |
| `golang.cekat.ai/event-sdk/middleware/chi` | 1.23 |
| `golang.cekat.ai/event-sdk/middleware/gin` | 1.25 |
| `golang.cekat.ai/event-sdk/middleware/echo` | 1.25 |
| `golang.cekat.ai/event-sdk/middleware/fiber` | 1.25 |

## Construct a client and submit an event

Construct one client during application setup and reuse it. An access token must be non-blank. The default request timeout is 3 seconds per attempt and the default retry count is two retries after the initial request.

```go
client, err := cekat.New(os.Getenv("CEKAT_ACCESS_TOKEN"))
if err != nil {
    return err
}

ack, err := client.UserRegistration(r.Context(), cekat.Event{
    Email:       "person@example.com",
    ContactName: "Person",
    Properties:  map[string]any{"plan": "starter", "signed_up_at": time.Now()},
})
if err != nil {
    return err
}
log.Printf("accepted event %s: %s", ack.EventKey, ack.Message)
```

The client exposes the common `UserRegistration`, `UserLogin`, `OrderCreated`, `FormSubmitted`, and `OrderPaid` methods. `FormSubmitted(ctx, event)` sends `event_key: "form_submitted"` with `is_common: true`. `OrderPaid(ctx, amount, currency, event)` additionally requires a finite `amount` and a nonblank `currency`, which are sent as the `amount` and `currency` properties; do not also put those keys in `Event.Properties`. For an event definition not represented by a common method, use `CustomEvent(ctx, eventKey, event)`.

`Acknowledgement` means the API accepted the event for asynchronous processing. It does **not** confirm durable storage, identity resolution, delivery completion, or analytics availability. Queue acknowledgement is not end-to-end delivery confirmation.

`Properties` are encoded with `encoding/json`, so `time.Time`, `uuid.UUID`, pointers, structs, `json.RawMessage`, and other `json.Marshaler` values use their normal JSON form. Values that cannot be encoded (channels, functions, `NaN`) and integers outside ±(2^53−1) return a `ValidationError` before any request is sent.

## Event IDs and timestamps

Every event carries an `event_id` and an `occurred_at` timestamp. When `Event.EventID` is blank the SDK generates a random UUID, and when `Event.OccurredAt` is zero it uses the time of the call. Both are fixed before the first attempt and reused by every retry, so Cekat can recognize retried deliveries of the same event. Supply your own `EventID` (for example an order or webhook delivery ID) when your application may submit the same business event more than once:

```go
_, err := client.OrderPaid(ctx, order.Total, order.Currency, cekat.Event{
    Email:      order.CustomerEmail,
    EventID:    "order-paid-" + order.ID,
    OccurredAt: order.PaidAt,
})
```

## Stripe metadata composition

Use the helper with the merchant's Stripe client; it does not create a Stripe request or send a Cekat event.

```go
import cekatstripe "golang.cekat.ai/event-sdk/stripe"

metadata := cekatstripe.MergeMetadata(merchantMetadata, cekatstripe.MetadataFromContext(r.Context())["cekat_"+"visitor_id"])
// stripeParams.Metadata = metadata
// checkoutParams.Metadata = metadata; checkoutParams.PaymentIntentData.Metadata = metadata
```

Only a trimmed 1–128 character `[A-Za-z0-9_-]` visitor becomes the Stripe visitor metadata entry. Merge returns a fresh map, preserving merchant keys and leaving invalid or absent visitor input unchanged.

## Keep tracking off the request's critical path

Event submission is synchronous. To avoid adding tracking latency to a user-facing handler, submit in a goroutine. Use `context.WithoutCancel` so the goroutine keeps the request's visitor ID but is not cancelled when the handler returns, and always add your own deadline:

```go
ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
go func() {
    defer cancel()
    if _, err := client.UserLogin(ctx, cekat.Event{Email: user.Email}); err != nil {
        log.Printf("cekat user_login: %v", err)
    }
}()
```

## Request context and visitor identity

Pass the request context (or another explicitly bounded context) to submission methods. The SDK honors cancellation before a request, while a request is in progress, and while waiting to retry:

```go
ctx := cekat.WithVisitorID(r.Context(), "visitor-123")
ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
defer cancel()
_, err := client.OrderCreated(ctx, cekat.Event{Email: "person@example.com"})
if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
    // The caller cancelled or its deadline elapsed; do not assume delivery.
}
```

`Event.VisitorID` is an explicit event-level value. When it is blank, the SDK uses the visitor ID from `WithVisitorID`. Header `X-Cekat-Visitor-ID` (`cekat.VisitorHeader`) takes precedence over the `_cekat_visitor_id` cookie (`cekat.VisitorCookie`). Visitor IDs are untrusted correlation data: never use them for authentication or authorization. For frameworks without an adapter, `cekat.ResolveVisitorID(header, cookie)` applies the same precedence and trimming.

For background jobs with no request (queues, webhooks, schedulers), start with `context.Background()` and a deadline; identity alone is enough once an earlier event linked the visitor:

```go
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
_, err := client.CustomEvent(ctx, "background_job_completed", cekat.Event{Email: userEmail})
```

## Middleware

Middleware extracts the visitor identity into a request-local context without mutating request headers or cookies. Install the adapter before handlers that submit events.

```go
// net/http
mux.Handle("/signup", cekatnethttp.Middleware(http.HandlerFunc(signup)))
// import cekatnethttp "golang.cekat.ai/event-sdk/middleware/nethttp"

// Gin
router.Use(cekatgin.Middleware())
// import cekatgin "golang.cekat.ai/event-sdk/middleware/gin"

// Echo
e.Use(cekatecho.Middleware())
// import cekatecho "golang.cekat.ai/event-sdk/middleware/echo"

// Fiber
app.Use(cekatfiber.Middleware())
// import cekatfiber "golang.cekat.ai/event-sdk/middleware/fiber"

// Chi
r.Use(cekatchi.Middleware)
// import cekatchi "golang.cekat.ai/event-sdk/middleware/chi"
```

Pass the context that carries the visitor ID:

| Framework | Pass to client methods |
| --- | --- |
| `net/http`, Chi | `r.Context()` |
| Gin | `c.Request.Context()` — **not** `c`. `*gin.Context` only reads request-context values when `engine.ContextWithFallback` is enabled, so passing `c` silently drops the visitor ID. |
| Echo | `c.Request().Context()` |
| Fiber | `c.Context()` — **not** `c`. |

## Errors, cancellation, and retries

Use `errors.As` to handle typed SDK failures and preserve the original error for logs and diagnostics:

```go
ack, err := client.OrderPaid(ctx, 125000, "IDR", event)
if err != nil {
    var authErr *cekat.AuthenticationError
    var apiErr *cekat.APIError
    var transportErr *cekat.TransportError
    switch {
    case errors.As(err, &authErr):
        return fmt.Errorf("check access token: %w", err)
    case errors.As(err, &apiErr):
        return fmt.Errorf("Cekat rejected the event (%d): %w", apiErr.StatusCode, err)
    case errors.As(err, &transportErr):
        if transportErr.DeliveryOutcomeUnknown {
            // A connection failed before a response. Delivery may have occurred.
        }
        return err
    }
}
_ = ack
```

`ValidationError` reports invalid construction options or event input. `AuthenticationError` is HTTP 401, `EventDefinitionNotFoundError` is HTTP 404, `APIError` represents other non-success HTTP responses, `TransportError` represents a request failure before a response, and `ResponseDecodeError` reports an invalid HTTP 200 envelope or a 200 whose body could not be read. Status and decode errors retain bounded response bytes; transport and decode errors unwrap their causes. Caller cancellation returns the context's own error (`context.Canceled` or `context.DeadlineExceeded`).

Transport failures, per-attempt timeouts, and HTTP 429, 500, 502, 503, and 504 are retried. Other statuses, including 400, 401, and 404, are not. Retry delay uses capped exponential full jitter (up to 100ms, 200ms, 400ms, 800ms, then 1s) and respects context cancellation. A valid `Retry-After` header raises the delay to the server's value; if the server asks for more than 5 seconds, the SDK returns the error immediately instead of blocking. A received 200 is never retried, even if its body cannot be read, because the event was already accepted.

A retry can create a **duplicate** event when the first attempt reached the server: `DeliveryOutcomeUnknown` signals that the service may have received the request even though the client saw no response. Retries reuse the same `event_id` so the server can recognize duplicates, but the SDK does not guarantee server-side deduplication. Choose retry counts according to your duplicate tolerance.

## Configuration

`WithBaseURL` accepts only an absolute HTTP(S) origin and is useful for controlled test endpoints. `WithTimeout` configures each network attempt (default 3 seconds). `WithRetryCount` configures retries after the first request (default 2). `WithHTTPClient` uses a caller-owned HTTP client without mutating it. Requests identify the SDK with `User-Agent: cekat-event-sdk-go/<version>`. Keep credentials out of source control and configure them through your runtime secret mechanism.

## Local package preparation

`./scripts/package --version 0.2.0 --output /absolute/empty-directory` runs tests and vet for every module, then creates a deterministic Git-tracked source archive for each publishable module (the core and each `middleware/*` adapter) plus a SHA-256 manifest. The modules are served from `golang.cekat.ai/event-sdk`, where each module path has its own `go-import` meta tag pointing at that module's directory in the `cekataiofficial/cekat-event-sdk` repository (`go` for the core, `go/middleware/gin` for the Gin adapter), so release tags carry the full directory prefix: `go/v0.2.0` for the core and `go/middleware/gin/v0.2.0` for an adapter. The adapters' `replace` directives only affect local development. It does not publish, sign, create tags, or push changes. Releases run from the repository's `release-go.yml` workflow: a release owner pushes the core tag `go/vX.Y.Z`, and the workflow verifies the commit, creates the adapter tags, and publishes a GitHub Release for each module. See the root release checklist.
