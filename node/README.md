# `@cekatai/event-sdk`

The server SDK for Node.js and Bun sends Cekat events through a backend-only access token. Browser exports deliberately contain **no token client**, `Authorization` handling, or Node imports.

## Install and initialize (Node.js and Bun)

```sh
npm install @cekatai/event-sdk    # or: bun add @cekatai/event-sdk
```

Requires Node.js 22.12 or newer, or Bun 1.2.5 or newer. The same package runs on both; see [Bun](#bun). The package is ESM and also loads from CommonJS through `require()` (for example in default NestJS projects). The Node client is exported from both `@cekatai/event-sdk` and `@cekatai/event-sdk/node`.

| Framework adapter | Supported majors |
| --- | --- |
| Express | 4.17+, 5 |
| Fastify | 4, 5 |
| Koa | 2.13+, 3 |
| NestJS (Express or Fastify platform) | 10, 11, 12 |
| Next.js (Node runtime) | 14, 15, 16 |
| Fetch-style handlers: `Bun.serve`, Hono, Elysia (`@cekatai/event-sdk/fetch`) | Any |

```ts
import { Client } from '@cekatai/event-sdk';

// Keep the token in server-side configuration; never ship it to a browser.
const cekat = new Client(process.env.CEKAT_ACCESS_TOKEN!);
```

`Client` accepts a token only plus optional `{ baseURL, timeoutMs, retryCount, fetch }` options. `baseURL` must be an absolute HTTP(S) origin without credentials, path, query, or fragment. The default is `https://server.cekat.ai`; each operation posts only to `/api/events/ingest` and identifies itself with `User-Agent: cekat-event-sdk-node/<version> <runtime>/<version>`, where the runtime is `node` or `bun`. The default timeout is 3 seconds per attempt and the default retry count is two after the initial request. Pass `{ signal }` to any event call to cancel without retrying.

```ts
await cekat.userRegistration({ email: 'person@example.test' });
await cekat.userLogin({ phoneNumber: '+15551234567', visitorId: 'browser-visitor' });
await cekat.orderCreated({ email: 'person@example.test', properties: { order_id: 'o-1' } });
await cekat.formSubmitted({ email: 'person@example.test', properties: { form_id: 'contact' } });
await cekat.orderPaid(125000, 'IDR', { email: 'person@example.test', properties: { order_id: 'o-1' } });
await cekat.customEvent('wishlist_updated', { email: 'person@example.test', contactName: 'Ada' });
```

`formSubmitted(event)` sends the common `form_submitted` event (`is_common: true`). `orderPaid(amount, currency, event)` additionally requires a finite `amount` and a nonblank `currency`, sent as the `amount` and `currency` properties; do not also put those keys in `event.properties`.

A nonblank explicit `visitorId` takes precedence over request context; a blank explicit value falls back to context. Email and phone are retained as submitted but at least one must be nonblank. Event properties are JSON values only (finite safe numbers, arrays, and plain objects); convert values such as `Date` to strings first.

Every event carries an `event_id` and an `occurred_at` timestamp. When `eventId` is blank the SDK generates a random UUID, and when `occurredAt` (a `Date`) is omitted it uses the time of the call. Both are fixed before the first attempt and reused by every retry, so Cekat can recognize retried deliveries. Supply your own `eventId` (for example an order or webhook ID) when the same business event may be sent more than once:

```ts
await cekat.orderPaid(order.total, order.currency, { email: order.email, eventId: `order-paid-${order.id}`, occurredAt: order.paidAt });
```

## Keep tracking off the request's critical path

Event methods always return a promise; invalid input rejects it rather than throwing synchronously. To avoid adding tracking latency to a user-facing request, you can skip `await` — but **always attach a `.catch`**. An unhandled rejection terminates the Node.js process by default, so a Cekat outage must never reach it:

```ts
cekat.userLogin({ email: user.email }).catch((error) => logger.warn({ error }, 'cekat user_login failed'));
```

The call reads the request's visitor scope synchronously, so this works inside adapters.

A successful `Acknowledgement` means the ingest service accepted the event for **asynchronous processing**. It is not a promise of idempotency, durable persistence, identity resolution, delivery state, or special common-event behavior.

## Node request visitor context and adapters

`X-Cekat-Visitor-ID` wins over the `_cekat_visitor_id` cookie. Values are trimmed; blank values are absent. Visitor IDs are untrusted correlation data from the browser: never use them for authentication or authorization. For non-framework code, establish a request-local scope explicitly:

```ts
import { runWithVisitorId } from '@cekatai/event-sdk/node';

await runWithVisitorId('visitor-123', () => cekat.customEvent('page_server_rendered', { email: 'person@example.test' }));
```

Use one adapter at the server boundary. Context is request-local, including asynchronous work started within the handler.

```ts
// Express
import express from 'express';
import { visitorMiddleware } from '@cekatai/event-sdk/express';
express().use(visitorMiddleware());

// Fastify
import Fastify from 'fastify';
import { visitorPlugin } from '@cekatai/event-sdk/fastify';
await Fastify().register(visitorPlugin);

// Koa
import Koa from 'koa';
import { visitorMiddleware as koaVisitorMiddleware } from '@cekatai/event-sdk/koa';
new Koa().use(koaVisitorMiddleware());

// NestJS
import { CekatVisitorMiddleware } from '@cekatai/event-sdk/nestjs';
// consumer.apply(CekatVisitorMiddleware).forRoutes('*');
```

Next.js support is **Node runtime only**. Declare the runtime in a route before importing the Next helper; Edge route module graphs must not import this subpath.

```ts
export const runtime = 'nodejs';

import { withCekatVisitor } from '@cekatai/event-sdk/nextjs';
export default withCekatVisitor(async (request, response) => { /* ... */ });
```

For App Router handlers use `runWithCekatVisitor(request, () => handler())` in the same kind of Node-runtime route.

## Bun

On Bun 1.2.5 or newer the client, the visitor scope, and the Express, Fastify, Koa, and NestJS adapters run unchanged; their test suites pass with Bun as the runtime. The Next.js helpers' tests also pass on Bun, but whether Next.js itself runs on Bun is up to Next.js. No separate import or build is needed. Bun-native servers pass a Web `Request` to a `fetch` handler, so use `@cekatai/event-sdk/fetch`:

```ts
import { Client } from '@cekatai/event-sdk';
import { withCekatVisitor } from '@cekatai/event-sdk/fetch';

const cekat = new Client(Bun.env.CEKAT_ACCESS_TOKEN!);

Bun.serve({
  // `this` and extra arguments such as `server` pass through unchanged.
  fetch: withCekatVisitor(async (request, server) => {
    const { email } = await request.json();
    await cekat.userLogin({ email }); // sends the request's visitor_id
    return new Response('ok');
  }),
  // Route handlers can be wrapped individually:
  // routes: { '/login': { POST: withCekatVisitor(login) } },
});
```

Hono and Elysia expose a standard `fetch`, so wrap it, or use Hono middleware:

```ts
import { Hono } from 'hono';
import { runWithCekatVisitor, withCekatVisitor } from '@cekatai/event-sdk/fetch';

const hono = new Hono();
hono.use((c, next) => runWithCekatVisitor(c.req.raw, next));
export default { fetch: hono.fetch };

// Elysia: serve its fetch handler with the wrapper instead of app.listen().
Bun.serve({ fetch: withCekatVisitor(elysiaApp.fetch) });
```

`@cekatai/event-sdk/fetch` needs only a Web `Request` and `AsyncLocalStorage`, so it also works with Hono on Node.js. The scope covers the handler and everything it awaits or starts. A streaming response body that is generated after the handler returns may not observe it: read `currentVisitorId()` in the handler and pass the value along.

On Bun, `AsyncLocalStorage` is not restored inside `AbortSignal.timeout()` listeners or `MessagePort` message handlers (it is on Node.js). Calls made from those callbacks send no visitor unless you capture it first and pass it explicitly: `const visitorId = currentVisitorId();` then `cekat.userLogin({ email, visitorId })`. Every other asynchronous boundary the test suite covers behaves as on Node.js.

### Bun before 1.4

Bun 1.2.5 through 1.3.x are supported with two differences, both caused by Bun's HTTP client and fixed in Bun 1.4.0:

- **No connection reuse.** Those releases can hand a new request a pooled connection that a server closed mid-response, which makes the request hang, read part of another response, or be sent twice. The SDK therefore opens a new connection for every attempt on Bun before 1.4 (`keepalive: false`). This adds a TCP (and TLS) handshake to each event; keep tracking off the request's critical path as shown above.
- **A truncated response looks like a network failure.** If the connection closes after Cekat's response headers but before the full body, Bun rejects the request without exposing the status. Instead of `ResponseDecodeError` (received, not retried), the SDK sees a `TransportError`, retries with the same `event_id`, and reports `deliveryOutcomeUnknown: true` if retries are exhausted. A retry may therefore deliver the same event again, as with any network failure. On Bun 1.4.0+ and Node.js the received response is classified exactly.

Bun older than 1.2.5 is not tested. See [docs/compatibility.md](docs/compatibility.md#bun) for the evidence.

## Stripe metadata composition

Use the helper with the merchant's Stripe client; it does not create a Stripe request or send a Cekat event.

```ts
import { mergeMetadata, metadataFromCurrentVisitor } from '@cekatai/event-sdk/stripe';

const metadata = mergeMetadata(merchantMetadata, metadataFromCurrentVisitor()['cekat_' + 'visitor_id']);
await stripe.paymentIntents.create({ amount: 1200, currency: 'usd', metadata });
await stripe.checkout.sessions.create({ mode: 'payment', metadata, payment_intent_data: { metadata } });
```

Only a trimmed 1–128 character `[A-Za-z0-9_-]` visitor becomes the Stripe visitor metadata entry. Merge returns a fresh object, preserving merchant keys and leaving invalid or absent visitor input unchanged.

## Errors and delivery outcome

Invalid local input rejects with `ValidationError` before network I/O. Received responses have known delivery outcome and reject with `AuthenticationError` (401), `EventDefinitionNotFoundError` (404), `ApiError` (other non-200), or `ResponseDecodeError` (malformed, truncated, or unreadable 200). `TransportError` means outcome is unknown after transport failure or SDK timeout. HTTP bodies retained in errors are bounded to 65,536 bytes.

Transport failures, SDK timeouts, and HTTP 429, 500, 502, 503, and 504 are retried with capped exponential full jitter (up to 100ms, 200ms, 400ms, 800ms, then 1s). Other statuses, including 400, 401, and 404, are not retried. A valid `Retry-After` header raises the delay to the server's value; if the server asks for more than 5 seconds, the call rejects immediately instead of blocking. A received 200 is never retried, even if its body cannot be read, because the event was already accepted. Retries after an unknown outcome can create duplicate events; they reuse the same `event_id`, but the SDK does not guarantee server-side deduplication.

## Browser visitor propagation

Browser helpers read the exact `_cekat_visitor_id` cookie; they are SSR-safe and return no visitor when `document` is unavailable. They never make backend token-bearing requests.

Use explicit enrichment as the default escape hatch:

```ts
import { withVisitor, withVisitorRequest } from '@cekatai/event-sdk/browser';

await fetch('https://api.example.test/events', withVisitor({ method: 'POST' }));
await fetch(withVisitorRequest(new Request('https://api.example.test/events')));
```

Existing `X-Cekat-Visitor-ID` headers are preserved case-insensitively. If the target is cross-origin, its CORS policy must allow the `X-Cekat-Visitor-ID` request header.

Axios is optional and should be attached only to a dedicated instance, not a process-wide/default instance:

```ts
import axios from 'axios';
import { createAxiosVisitorInterceptor } from '@cekatai/event-sdk/browser/axios';

const api = axios.create({ baseURL: 'https://api.example.test' });
api.interceptors.request.use(createAxiosVisitorInterceptor());
```

Automatic propagation is disabled by default. Enable it only with parsed, explicit HTTP(S) origin/path allowlist entries. Matching requires exact normalized `URL.origin` equality and `URL.pathname.startsWith(pathPrefix)`; it is not a raw URL-prefix match. One active installation is allowed and `disable()` restores the original globals.

```ts
import { enableAutoPropagation } from '@cekatai/event-sdk/browser';

const disable = enableAutoPropagation({
  allowedTargets: [{ origin: 'https://api.example.test', pathPrefix: '/v1/' }],
});
// Later, for example during application teardown:
disable();
```

The automatic interceptor covers browser global `fetch` and `XMLHttpRequest` only. It does not cover server fetches, Axios unless the dedicated interceptor is registered, WebSocket/EventSource traffic, navigation, forms, service-worker-controlled requests, or arbitrary third-party HTTP clients.

## Local no-publish package preparation

```sh
./scripts/package --version 0.2.0 --output /absolute/empty-directory
```

Bun support is verified separately with `npm run test:bun` (the test suites on Bun, including the Bun-only `test/bun` servers) and `CEKAT_NODE_RUNTIME=bun scripts/conformance` (the shared conformance fixtures on Bun). Both use Node.js and npm for installation and type checking.

The command runs dependency installation, official compatibility verification, production and full dependency audits, the approved-range dependency gate, tests, type checks, builds, export checks, and browser tests; it then creates one local `.tgz` plus an atomic SHA-256 `manifest.json`. It never publishes, signs, tags, or pushes. Releases to npm run from the repository's `release-node.yml` workflow when a `node/vX.Y.Z` tag is pushed; see the root release checklist.
