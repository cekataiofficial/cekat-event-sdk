# `@cekat/event-sdk`

The Node.js SDK sends Cekat events through a backend-only access token. Browser exports deliberately contain **no token client**, `Authorization` handling, or Node imports.

## Install and initialize (Node.js)

```sh
npm install @cekat/event-sdk
```

```ts
import { Client } from '@cekat/event-sdk/node';

// Keep the token in server-side configuration; never ship it to a browser.
const cekat = new Client(process.env.CEKAT_ACCESS_TOKEN!);
```

`Client` accepts a token only plus optional `{ baseURL, timeoutMs, retryCount, fetch }` options. `baseURL` must be an absolute HTTP(S) origin without credentials, path, query, or fragment. The default is `https://server.cekat.ai`; each operation posts only to `/api/events/ingest`. The default timeout is 10 seconds per attempt and the default retry count is two after the initial request. Transport failures, SDK timeouts, and exactly HTTP 500 may retry with jitter; retries can create duplicate accepted events. Pass `{ signal }` to any event call to cancel without retrying.

```ts
await cekat.userRegistration({ email: 'person@example.test' });
await cekat.userLogin({ phoneNumber: '+15551234567', visitorId: 'browser-visitor' });
await cekat.orderCreated({ email: 'person@example.test', properties: { order_id: 'o-1' } });
await cekat.orderPaid({ email: 'person@example.test', properties: { total: 42 } });
await cekat.customEvent('wishlist_updated', { email: 'person@example.test', contactName: 'Ada' });
```

A nonblank explicit `visitorId` takes precedence over request context; a blank explicit value falls back to context. Email and phone are retained as submitted but at least one must be nonblank. Event properties are JSON values only (finite safe numbers, arrays, and plain objects).

A successful `Acknowledgement` means the ingest service accepted the event for **asynchronous processing**. It is not a promise of idempotency, durable persistence, identity resolution, delivery state, or special common-event behavior.

## Node request visitor context and adapters

`X-Cekat-Visitor-ID` wins over the `_cekat_visitor_id` cookie. Values are trimmed; blank values are absent. For non-framework code, establish a request-local scope explicitly:

```ts
import { runWithVisitorId } from '@cekat/event-sdk/node';

await runWithVisitorId('visitor-123', () => cekat.customEvent('page_server_rendered', { email: 'person@example.test' }));
```

Use one adapter at the server boundary. Context is request-local, including asynchronous work started within the handler.

```ts
// Express
import express from 'express';
import { visitorMiddleware } from '@cekat/event-sdk/express';
express().use(visitorMiddleware());

// Fastify
import Fastify from 'fastify';
import { visitorPlugin } from '@cekat/event-sdk/fastify';
await Fastify().register(visitorPlugin);

// Koa
import Koa from 'koa';
import { visitorMiddleware as koaVisitorMiddleware } from '@cekat/event-sdk/koa';
new Koa().use(koaVisitorMiddleware());

// NestJS
import { CekatVisitorMiddleware } from '@cekat/event-sdk/nestjs';
// consumer.apply(CekatVisitorMiddleware).forRoutes('*');
```

Next.js support is **Node runtime only**. Declare the runtime in a route before importing the Next helper; Edge route module graphs must not import this subpath.

```ts
export const runtime = 'nodejs';

import { withCekatVisitor } from '@cekat/event-sdk/nextjs';
export default withCekatVisitor(async (request, response) => { /* ... */ });
```

For App Router handlers use `runWithCekatVisitor(request, () => handler())` in the same kind of Node-runtime route.

## Errors and delivery outcome

Invalid local input throws `ValidationError` before network I/O. Received responses have known delivery outcome and throw `AuthenticationError` (401), `EventDefinitionNotFoundError` (404), `ApiError` (other non-200), or `ResponseDecodeError` (malformed/truncated 200). `TransportError` means outcome is unknown after transport failure or SDK timeout. HTTP bodies retained in errors are bounded to 65,536 bytes. Do not blindly resend after an unknown outcome unless your application accepts the duplicate risk.

## Browser visitor propagation

Browser helpers read the exact `_cekat_visitor_id` cookie; they are SSR-safe and return no visitor when `document` is unavailable. They never make backend token-bearing requests.

Use explicit enrichment as the default escape hatch:

```ts
import { withVisitor, withVisitorRequest } from '@cekat/event-sdk/browser';

await fetch('https://api.example.test/events', withVisitor({ method: 'POST' }));
await fetch(withVisitorRequest(new Request('https://api.example.test/events')));
```

Existing `X-Cekat-Visitor-ID` headers are preserved case-insensitively. If the target is cross-origin, its CORS policy must allow the `X-Cekat-Visitor-ID` request header.

Axios is optional and should be attached only to a dedicated instance, not a process-wide/default instance:

```ts
import axios from 'axios';
import { createAxiosVisitorInterceptor } from '@cekat/event-sdk/browser/axios';

const api = axios.create({ baseURL: 'https://api.example.test' });
api.interceptors.request.use(createAxiosVisitorInterceptor());
```

Automatic propagation is disabled by default. Enable it only with parsed, explicit HTTP(S) origin/path allowlist entries. Matching requires exact normalized `URL.origin` equality and `URL.pathname.startsWith(pathPrefix)`; it is not a raw URL-prefix match. One active installation is allowed and `disable()` restores the original globals.

```ts
import { enableAutoPropagation } from '@cekat/event-sdk/browser';

const disable = enableAutoPropagation({
  allowedTargets: [{ origin: 'https://api.example.test', pathPrefix: '/v1/' }],
});
// Later, for example during application teardown:
disable();
```

The automatic interceptor covers browser global `fetch` and `XMLHttpRequest` only. It does not cover server fetches, Axios unless the dedicated interceptor is registered, WebSocket/EventSource traffic, navigation, forms, service-worker-controlled requests, or arbitrary third-party HTTP clients.

## Local no-publish package preparation

```sh
./scripts/package --version 0.1.0 --output /absolute/empty-directory
```

The command runs dependency installation, official compatibility verification, production and full dependency audits, the approved-range dependency gate, tests, type checks, builds, export checks, and browser tests; it then creates one local `.tgz` plus an atomic SHA-256 `manifest.json`. It never publishes, signs, tags, or pushes.
