# Visitor propagation

The Cekat browser SDK tracks an anonymous visitor. When a backend event carries both that visitor ID and a contact identity (email or phone number), Cekat can link the visitor to the contact. The backend SDKs attach the visitor ID automatically for events sent while handling the browser's request, so application code does not pass it around.

Related pages: [SDK contract](sdk-contract.md), [retries and errors](retry-and-error-semantics.md).

## Names

| Name | Value |
| --- | --- |
| Cookie set by the browser SDK | `_cekat_visitor_id` |
| Request header (for cross-origin APIs, set by the browser helpers) | `X-Cekat-Visitor-ID` |
| Payload field | `visitor_id` |

## Precedence

Middleware resolves the visitor for a request in this order of precedence:

1. A nonblank `X-Cekat-Visitor-ID` header.
2. A nonblank `_cekat_visitor_id` cookie.
3. No visitor.

When an event is sent, the SDK uses:

1. A nonblank visitor ID given explicitly on the event.
2. Otherwise the visitor of the current request scope.
3. Otherwise no `visitor_id` field.

Values are trimmed before the blank check and before sending.

## Trust boundary

Visitor IDs come from the browser and are untrusted correlation data. Never use them for authentication, authorization, session lookup, or deciding who owns a resource. The middleware does not authenticate them, does not inspect your users, does not send events by itself, does not change cookies, and never stores the access token in request state.

## Request scope

Each integration extracts the visitor at the start of a request, makes it current for the rest of that request, and restores the previous state when the request ends. Cleanup runs in `finally` (or the ecosystem's equivalent) so a failing request, a cancelled request, or a reused worker never leaks one request's visitor into the next.

| SDK | Scope mechanism | Integrations | Explicit scope |
| --- | --- | --- | --- |
| [Go](../go/README.md) | `context.Context` | `net/http`, Gin, Echo, Fiber, Chi middleware | `cekat.WithVisitorID(ctx, id)` |
| [Node.js and Bun](../node/README.md) | `AsyncLocalStorage` | Express, Fastify, Koa, NestJS, Next.js (Node runtime); `@cekatai/event-sdk/fetch` for `Bun.serve`, Hono, and Elysia | `runWithVisitorId(id, callback)` |
| [Python](../python/README.md) | `contextvars` | Django middleware, Flask extension, ASGI middleware for Starlette and FastAPI | `with visitor_scope(id):` |
| [PHP](../php/README.md) | request-scoped `VisitorContext` service | PSR-15 middleware, Laravel, Symfony | `VisitorContext::shared()->runWithVisitorId($id, $callback)` |
| [Java](../java/README.md) | request attribute plus thread-local scope | Jakarta Servlet filter, Spring Boot auto-configuration | `try (VisitorContext.Scope scope = VisitorContext.open(id))` |
| [.NET](../dotnet/README.md) | `HttpContext.Items` / `FunctionContext.Items` plus `AsyncLocal` | ASP.NET Core `UseCekatVisitor()`, Azure Functions isolated worker | `using (AsyncLocalVisitorContext.Push(id))` |
| [Ruby](../ruby/README.md) | fiber-local storage (`Fiber[]`); Rails `CurrentAttributes` | Rack middleware, Rails (inserted automatically) | `client.with_visitor_id(id) { ... }` |

Install the integration before the handlers or middleware that send events. In Go, pass the context that carries the visitor: `r.Context()`, `c.Request.Context()` for Gin (not `c`), `c.Request().Context()` for Echo, and `c.Context()` for Fiber (not `c`).

## Stripe metadata composition

The `stripe` helpers use the current request visitor only to create a fresh native metadata collection containing the Stripe visitor metadata entry. They do not import a Stripe SDK, create a Checkout Session or PaymentIntent, send a Cekat event, or mutate merchant metadata. A merchant passes the returned metadata into its own official Stripe client for a direct PaymentIntent, a Checkout Session's `metadata`, and, for payment-mode Checkout, `payment_intent_data.metadata`.

A valid visitor is 1–128 ASCII letters, digits, `_`, or `-` after trimming. `merge` returns a new collection; it preserves merchant entries and replaces only a valid Cekat visitor value. With no valid visitor, it returns a fresh copy without adding a Cekat key.

## Work outside the request

A visitor scope belongs to the request. Whether it reaches other work depends on the runtime:

- **Carried automatically:** Go goroutines given the request context (use `context.WithoutCancel` so they outlive the handler); promises and tasks started during the request in Node.js, Bun, Python `asyncio`, and .NET (`Task.Run` included); Starlette and FastAPI background tasks.
- **Not carried:** job queues and schedulers in every language (for example Active Job, Celery, Laravel queues, Java executors and `@Async` methods, a .NET `BackgroundService`), Java threads you start, and on Bun, `AbortSignal.timeout()` listeners and `MessagePort` message handlers.

For work that is not carried, read the visitor while handling the request and pass it explicitly on the event. Each language README shows how. Events sent later with only an email or phone number are still attributed to the contact once an earlier event linked the visitor, so background jobs usually need only the contact identity.

## Browser side

For requests to a different origin, the browser helpers in `@cekatai/event-sdk/browser` add `X-Cekat-Visitor-ID` explicitly or for an allowlist of origins; the receiving API's CORS policy must allow that header. The browser helpers never contain the access token. See the [Node.js and Bun README](../node/README.md#browser-visitor-propagation).
