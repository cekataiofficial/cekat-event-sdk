# Cekat Go Event SDK

`github.com/cekataiofficial/cekat-event-sdk-go` synchronously submits Cekat events over HTTP. It supports Go 1.26 and the standard `net/http` middleware plus Gin v1, Echo v4, Fiber v3, and Chi v5 request middleware adapters.

```sh
go get github.com/cekataiofficial/cekat-event-sdk-go
```

## Construct a client and submit an event

Construct one client during application setup and reuse it. An access token must be non-blank. The default request timeout is 10 seconds and the default retry count is two retries after the initial request.

```go
client, err := cekat.New(os.Getenv("CEKAT_ACCESS_TOKEN"),
    cekat.WithTimeout(5*time.Second),
    cekat.WithRetryCount(2),
)
if err != nil {
    return err
}

ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
defer cancel()
ack, err := client.UserRegistration(ctx, cekat.Event{
    Email:      "person@example.com",
    ContactName: "Person",
    Properties: map[string]any{"plan": "starter"},
})
if err != nil {
    return err
}
log.Printf("accepted event %s: %s", ack.EventKey, ack.Message)
```

The client exposes the common `UserRegistration`, `UserLogin`, `OrderCreated`, and `OrderPaid` methods. For an event definition not represented by a common method, use `CustomEvent(ctx, eventKey, event)`.

`Acknowledgement` means the API accepted the event for asynchronous processing. It does **not** confirm durable storage, identity resolution, delivery completion, or analytics availability. Queue acknowledgement is not end-to-end delivery confirmation.

## Request context and visitor identity

Always pass the request context (or another explicitly bounded context) to submission methods. The SDK honors cancellation before a request, while a request is in progress, and while waiting to retry:

```go
ctx := cekat.WithVisitorID(r.Context(), "visitor-123")
ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
defer cancel()
_, err := client.OrderCreated(ctx, cekat.Event{Email: "person@example.com"})
if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
    // The caller cancelled or its deadline elapsed; do not assume delivery.
}
```

`Event.VisitorID` is an explicit event-level value. When it is blank, the SDK can use the visitor ID from `WithVisitorID`. Header/cookie values are untrusted request input; use the middleware below only when your application accepts that identity source. Header `X-Cekat-Visitor-ID` takes precedence over `_cekat_visitor_id` cookie.

For background work, do not retain a request context after its handler returns. Start with `context.Background()` and attach only a trusted, explicitly supplied identity and a deadline:

```go
ctx := cekat.WithVisitorID(context.Background(), trustedVisitorID)
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
_, err := client.CustomEvent(ctx, "background_job_completed", cekat.Event{Email: userEmail})
```

## Middleware

Middleware extracts the visitor identity into a request-local context without mutating request headers or cookies. Install the adapter before handlers that submit events.

```go
// net/http
mux.Handle("/signup", cekatnethttp.Middleware(http.HandlerFunc(signup)))
// import cekatnethttp "github.com/cekataiofficial/cekat-event-sdk-go/middleware/nethttp"

// Gin
router.Use(cekatgin.Middleware())
// import cekatgin "github.com/cekataiofficial/cekat-event-sdk-go/middleware/gin"

// Echo
e.Use(cekatecho.Middleware())
// import cekatecho "github.com/cekataiofficial/cekat-event-sdk-go/middleware/echo"

// Fiber
app.Use(cekatfiber.Middleware())
// import cekatfiber "github.com/cekataiofficial/cekat-event-sdk-go/middleware/fiber"
// use cekatfiber.Context(c) as the context passed to client methods.

// Chi
r.Use(cekatchi.Middleware)
// import cekatchi "github.com/cekataiofficial/cekat-event-sdk-go/middleware/chi"
```

For `net/http`, Gin, Echo, and Chi, pass the resulting request context to the client. Fiber does not expose a portable standard request context, so pass `cekatfiber.Context(c)`.

## Errors, cancellation, and retries

Use `errors.As` to handle typed SDK failures and preserve the original error for logs and diagnostics:

```go
ack, err := client.OrderPaid(ctx, event)
if err != nil {
    var authErr *cekat.AuthenticationError
    var apiErr *cekat.ApiError
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

`ValidationError` reports invalid construction options or event input. `AuthenticationError` is HTTP 401, `EventDefinitionNotFoundError` is HTTP 404, `ApiError` represents other non-success HTTP responses, `TransportError` represents a request failure before a response, and `ResponseDecodeError` reports an invalid HTTP 200 envelope. Status and decode errors retain bounded response bytes; transport and decode errors unwrap their causes.

Only transport failures before a response and HTTP 500 responses are retried. HTTP 400, 401, 404, and 429 are not retried. Retry delay uses capped exponential full jitter and respects context cancellation. A retry can create a **duplicate** event: there is no idempotency guarantee, and `DeliveryOutcomeUnknown` specifically signals that the service may have received the request even though the client saw no response. Choose retry counts according to your duplicate-tolerance and reconciliation strategy.

## Configuration

`WithBaseURL` accepts only an absolute HTTP(S) origin and is useful for controlled test endpoints. `WithTimeout` configures each network attempt. `WithRetryCount` configures retries after the first request. `WithHTTPClient` uses a caller-owned HTTP client without mutating it. Keep credentials out of source control and configure them through your runtime secret mechanism.

## Local package preparation

`./scripts/package --version 0.1.0 --output /absolute/empty-directory` runs tests and vet, then creates a deterministic Git-tracked source archive and a SHA-256 manifest. It does not publish, sign, create tags, or push changes; those are release-owner responsibilities.
