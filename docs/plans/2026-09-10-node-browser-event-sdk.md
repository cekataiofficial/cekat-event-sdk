# Node.js and Browser Event SDK Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).

> **Node amendment (2026-09-13):** engines `>=22.12.0`, root `.` export plus `default` export conditions for `require(esm)`, widened optional peers (Express 4–5, Fastify 4–5, Koa 2–3, NestJS 10–12, Next 14–16), no `fastify-plugin` peer, and the package is no longer `private`.

> **Implementation notes — Bun runtime (2026-09-14), overriding the tasks below.** The same `@cekat/event-sdk` package supports Bun (`engines.bun >=1.2.5`); there is no separate Bun build. The User-Agent runtime token comes from `src/node/runtime.ts` (`bun/<version>` when `process.versions.bun` is set, because Bun also reports a Node version). A runtime-agnostic `@cekat/event-sdk/fetch` export (`withCekatVisitor`, `runWithCekatVisitor`) wraps Web `Request` handlers for `Bun.serve` (including `routes`), Hono, and Elysia. `npm run test:bun` runs Vitest with Bun workers plus the Bun-only `test/bun` suite; `CEKAT_NODE_RUNTIME=bun scripts/conformance` runs the shared fixtures on Bun and asserts the exact runtime token. Bun before 1.4.0 has HTTP-client defects: pooled connections left broken by a server-closed response (merged bodies, silent re-sends, extra requests), mitigated by `keepalive: false` on those releases; and `fetch()` rejecting when the connection closes after headers but before the body, which cannot be mitigated, so a truncated 200 is treated as a retried transport failure. `conformance/README.md` records that as a runtime limitation and the Node runner accepts the fallback only for `success-body-interrupted` on Bun before 1.4, labelling the record `runtime_deviation`. Vitest 5 needs Bun 1.2.5+ (`util.parseEnv`). On Bun, AsyncLocalStorage is not restored in `AbortSignal.timeout()` listeners or `MessagePort` messages; the propagation test pins this. CI adds a `bun` job for 1.2.5, 1.3.14, and 1.4.2.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the independently publishable `@cekat/event-sdk` Node.js SDK, request-local framework adapters, and browser visitor-propagation helpers.

**Architecture:** The ESM-only Node entry point owns event validation, built-in `fetch` delivery, retries, response decoding, typed errors, and one `AsyncLocalStorage` visitor store. Framework subpath exports are thin request extractors around that store. Browser-only subpath exports contain no access-token client or `node:` imports and provide explicit enrichment, an optional Axios interceptor, and opt-in allowlisted global interception.

**Tech Stack:** TypeScript, Node built-in `fetch`/Web APIs, `node:async_hooks`, Vitest, Playwright, npm, framework peer dependencies, optional Axios peer dependency.

**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`

## Global Constraints

- Package coordinate is `@cekat/event-sdk`; this plan prepares version `0.1.0` and does not publish.
- Run Task 1 before dependency setup and again immediately before release. Record observed official runtime/framework versions; do not substitute projected patch versions.
- Runtime policy covers maintained/LTS Node releases in roughly the preceding five years. CI minimum/current versions are selected from official release metadata; odd-numbered non-LTS lines are not promised.
- Send only `POST <origin>/api/events/ingest`; default origin is `https://server.cekat.ai`; authorize with `Bearer <access_token>`; never put the token in browser exports, payloads, errors, logs, or snapshots.
- A custom `baseURL` must be an absolute HTTP(S) origin with no credentials, non-root path, query, or fragment. Normalize one trailing slash away.
- Default per-attempt timeout is 10 seconds. Default retry count is two after the initial attempt. Retry transport failures, SDK timeouts, and exact HTTP `500` only. Full-jitter waits are uniform `[0,100ms]` before retry one and `[0,200ms]` before retry two.
- Caller `AbortSignal` cancellation interrupts requests and backoff, is never retried, and rethrows its reason or an `AbortError` without SDK wrapping. SDK timeout exhaustion is `TransportError` with unknown outcome.
- Any received HTTP response has known delivery outcome, including `500` and malformed `200`. Transport failures and SDK timeouts have unknown outcome.
- Retain at most the first 65,536 response bytes and decode UTF-8 with replacement at a truncation boundary.
- A valid `200` is exactly a JSON object with `success: true` and `data: {success: true, message: <non-empty string>, event_key: <non-empty string>, validated_properties: <string[]>}`; extra fields are ignored. A malformed `200` is `ResponseDecodeError`.
- A conforming non-`200` body is `{success:false,error:<non-empty string>,code?:<string>}`. Malformed bodies retain status classification and bounded raw text, using the HTTP status text as message.
- Validate nonblank `eventKey` and at least one nonblank email/phone. Preserve identity strings. Properties recursively accept only null, booleans, strings, finite numbers, safe integers, arrays, and string-keyed plain objects; reject cycles and ecosystem objects before network I/O.
- Trim visitor IDs for storage/transmission. Header `X-Cekat-Visitor-ID` wins over cookie `_cekat_visitor_id`; blank means absent. A nonblank explicit event visitor wins over ambient context; blank explicit visitor falls back to ambient context.
- Common wrappers use `user_registration`, `user_login`, `order_created`, and `order_paid` with `is_common: true`; custom events use `is_common: false`.
- Acknowledgement means accepted for asynchronous processing only. Do not promise idempotency, durable persistence, identity resolution, delivery state, or special common-event semantics.
- Next.js support is Node runtime only. Browser/Edge module graphs must not contain `node:async_hooks`.
- Automatic browser interception is disabled by default and requires parsed HTTP(S) origin/path allowlisting. Never overwrite an explicit visitor header.

---

## Exact File Map

```text
node/
├── package.json                         # npm metadata, scripts, peer deps, explicit subpath exports
├── package-lock.json                    # exact execution-verified tool/test versions
├── tsconfig.json                        # strict editor/test compilation
├── tsconfig.build.json                  # ESM declaration build into dist/
├── vitest.config.ts                     # unit, adapter, and conformance projects
├── playwright.config.ts                 # Chromium/Firefox/WebKit browser suite
├── README.md                            # Node initialization, events, adapter and browser usage
├── docs/compatibility.md                # generated observed runtime/framework support evidence
├── scripts/verify-compatibility.mjs     # official Node/npm metadata gate
├── scripts/check-exports.mjs            # package graph and browser node-import guard
├── scripts/conformance                  # stable root-runner entry point
├── scripts/package                      # no-publish 0.1.0 artifact/manifest producer
├── src/node/index.ts                    # Node-only public exports
├── src/node/types.ts                    # public event, option, JSON, acknowledgement types
├── src/node/errors.ts                   # six public typed error classes
├── src/node/validation.ts               # config/event/properties validation and wire shaping
├── src/node/visitor-context.ts          # sole AsyncLocalStorage instance and request extraction
├── src/node/body.ts                     # bounded response stream/text reader
├── src/node/delivery.ts                 # fetch attempt, timeout, retry, cancellation, decoding
├── src/node/client.ts                   # public Client and five operations
├── src/integrations/express.ts          # Express middleware
├── src/integrations/fastify.ts          # Fastify plugin
├── src/integrations/koa.ts              # Koa middleware
├── src/integrations/nestjs.ts           # NestJS HTTP middleware
├── src/integrations/nextjs.ts           # Next Pages/API wrapper and App Router scope helper
├── src/browser/index.ts                 # browser-safe explicit/automatic exports
├── src/browser/constants.ts             # fixed cookie/header names
├── src/browser/cookie.ts                # SSR-safe visitor cookie parsing
├── src/browser/explicit.ts              # RequestInit and Request enrichment
├── src/browser/allowlist.ts             # parsed target normalization and matching
├── src/browser/auto.ts                  # one active global fetch/XHR installation
├── src/browser/axios.ts                 # optional Axios interceptor export
├── test/node/validation.test.ts
├── test/node/visitor-context.test.ts
├── test/node/delivery.test.ts
├── test/node/client.test.ts
├── test/integrations/express.test.ts
├── test/integrations/fastify.test.ts
├── test/integrations/koa.test.ts
├── test/integrations/nestjs-express.test.ts
├── test/integrations/nestjs-fastify.test.ts
├── test/integrations/nextjs.test.ts
├── test/browser/cookie.test.ts
├── test/browser/explicit.test.ts
├── test/browser/allowlist.test.ts
├── test/browser/axios.test.ts
├── test/browser/auto-fetch.spec.ts
├── test/browser/auto-xhr.spec.ts
├── test/browser/fixtures/index.html
├── test/browser/fixtures/server.mjs
├── test/conformance/sdk.test.ts
├── test/package/exports.test.mjs
├── test/package/package-script.test.mjs
└── test/compatibility/verify-compatibility.test.mjs
```

Shared inputs created by the shared-conformance phase and consumed without modification:

```text
conformance/fixtures/schemas/*.schema.json
conformance/fixtures/cases/*.json
conformance/mock-ingest-server/
```

## Interfaces

```ts
// @cekat/event-sdk/node
export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };
export interface EventInput {
  email?: string;
  phoneNumber?: string;
  contactName?: string;
  visitorId?: string;
  properties?: Record<string, JsonValue>;
}
export interface Acknowledgement {
  success: true;
  message: string;
  eventKey: string;
  validatedProperties: string[];
  rawBody: string;
}
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface ClientOptions {
  baseURL?: string;
  timeoutMs?: number;       // default 10_000, must be > 0
  retryCount?: number;      // default 2, must be a nonnegative integer
  fetch?: FetchLike;        // default globalThis.fetch
}
export interface CallOptions { signal?: AbortSignal }
export class Client {
  constructor(accessToken: string, options?: ClientOptions);
  userRegistration(event: EventInput, options?: CallOptions): Promise<Acknowledgement>;
  userLogin(event: EventInput, options?: CallOptions): Promise<Acknowledgement>;
  orderCreated(event: EventInput, options?: CallOptions): Promise<Acknowledgement>;
  orderPaid(event: EventInput, options?: CallOptions): Promise<Acknowledgement>;
  customEvent(eventKey: string, event: EventInput, options?: CallOptions): Promise<Acknowledgement>;
}
export function currentVisitorId(): string | undefined;
export function runWithVisitorId<T>(visitorId: string | undefined, callback: () => T): T;
export function runWithVisitorFromRequest<T>(request: { headers: Record<string, string | string[] | undefined> }, callback: () => T): T;
export function runWithVisitorFromHeaders<T>(headers: Headers | Record<string, unknown>, cookieHeader: string | undefined, callback: () => T): T;
export class ValidationError extends Error {}
export class AuthenticationError extends Error { readonly status: 401; readonly code?: string; readonly rawBody: string; readonly attempts: number; readonly deliveryOutcomeUnknown: false }
export class EventDefinitionNotFoundError extends Error { readonly status: 404; readonly code?: string; readonly rawBody: string; readonly attempts: number; readonly deliveryOutcomeUnknown: false }
export class ApiError extends Error { readonly status: number; readonly code?: string; readonly rawBody: string; readonly attempts: number; readonly deliveryOutcomeUnknown: false }
export class TransportError extends Error { readonly attempts: number; readonly deliveryOutcomeUnknown: true; override readonly cause: unknown }
export class ResponseDecodeError extends Error { readonly status: 200; readonly rawBody: string; readonly attempts: number; readonly deliveryOutcomeUnknown: false; override readonly cause?: unknown }

// Framework subpaths
export function visitorMiddleware(): import("express").RequestHandler;                 // ./express
export const visitorPlugin: import("fastify").FastifyPluginAsync;                    // ./fastify
export function visitorMiddleware(): import("koa").Middleware;                       // ./koa
export class CekatVisitorMiddleware implements import("@nestjs/common").NestMiddleware { use(req: object, res: object, next: () => void): void }
export function withCekatVisitor<TReq extends {headers: Record<string, unknown>}, TRes>(handler: (req: TReq, res: TRes) => unknown): (req: TReq, res: TRes) => unknown;
export function runWithCekatVisitor<T>(request: Request, handler: () => T): T;          // ./nextjs, Node runtime only

// @cekat/event-sdk/browser
export interface AllowedTarget { origin: string; pathPrefix?: string }
export interface AutoPropagationOptions { allowedTargets: readonly AllowedTarget[] }
export function readVisitorId(cookieSource?: string): string | undefined;
export function withVisitor(init?: RequestInit): RequestInit;
export function withVisitorRequest(request: Request): Request;
export function enableAutoPropagation(options: AutoPropagationOptions): () => void;

// @cekat/event-sdk/browser/axios
export function createAxiosVisitorInterceptor(): (config: import("axios").InternalAxiosRequestConfig) => import("axios").InternalAxiosRequestConfig;
```

The package exports only `./node`, `./express`, `./fastify`, `./koa`, `./nestjs`, `./nextjs`, `./browser`, and `./browser/axios`; it deliberately has no ambiguous root export.

---

### Task 1: Add a blocking compatibility evidence gate and package skeleton

**Files:** Create `node/scripts/verify-compatibility.mjs`, `node/test/compatibility/verify-compatibility.test.mjs`, `node/docs/compatibility.md`, `node/package.json`, `node/package-lock.json`, `node/tsconfig.json`, `node/tsconfig.build.json`, `node/vitest.config.ts`, `node/playwright.config.ts`.

**Interfaces:** Consumes official Node release metadata and npm registry metadata. Produces a strict TypeScript/npm workspace plus a dated compatibility report listing exact observed Node, TypeScript, Vitest, Playwright, `@types/node`, Express, `@types/express`, Fastify, `fastify-plugin`, Koa, `@types/koa`, NestJS, Next.js, and Axios versions and supported majors.

- [ ] **Write the gate test first.** Fixture the official metadata shapes in the test and assert that the script rejects EOL Node lines, prereleases, framework versions whose `engines.node` excludes the chosen floor, or an unresolved Next Node-runtime target; assert generated Markdown contains retrieval timestamp, source URLs, exact versions, and selected support ranges.
- [ ] **Run the red test.** Run `cd node && node --test test/compatibility/verify-compatibility.test.mjs`. Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/verify-compatibility.mjs`.
- [ ] **Implement the gate.** Fetch `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`, `https://nodejs.org/dist/index.json`, and `npm view <package> versions time engines dist-tags --json`, including metadata for `@types/node`, `@types/express`, `@types/koa`, and `fastify-plugin`; select maintained even Node lines no older than the approved Node 22 floor, latest non-prerelease patches for selected maintained framework majors, declaration packages matching the selected runtime/framework majors, and exact secure tooling versions. Exit nonzero when official sources disagree, a selected framework/type/plugin excludes the runtime floor, Next cannot be constrained to Node runtime, or any source is unavailable. Write only evidence—not projections—to `node/docs/compatibility.md`.
- [ ] **Run the gate and bootstrap with observed versions.** Run:
  ```bash
  cd node
  node scripts/verify-compatibility.mjs --write
  npm install --save-dev --save-exact typescript@"$(node scripts/verify-compatibility.mjs --print typescript)" vitest@"$(node scripts/verify-compatibility.mjs --print vitest)" @vitest/coverage-v8@"$(node scripts/verify-compatibility.mjs --print vitest)" playwright@"$(node scripts/verify-compatibility.mjs --print playwright)" @playwright/test@"$(node scripts/verify-compatibility.mjs --print playwright)" @types/node@"$(node scripts/verify-compatibility.mjs --print types-node)" @types/express@"$(node scripts/verify-compatibility.mjs --print types-express)" @types/koa@"$(node scripts/verify-compatibility.mjs --print types-koa)"
  npm install --save-dev --save-exact express@"$(node scripts/verify-compatibility.mjs --print express)" fastify@"$(node scripts/verify-compatibility.mjs --print fastify)" fastify-plugin@"$(node scripts/verify-compatibility.mjs --print fastify-plugin)" koa@"$(node scripts/verify-compatibility.mjs --print koa)" @nestjs/common@"$(node scripts/verify-compatibility.mjs --print nestjs)" @nestjs/core@"$(node scripts/verify-compatibility.mjs --print nestjs)" @nestjs/platform-express@"$(node scripts/verify-compatibility.mjs --print nestjs)" @nestjs/platform-fastify@"$(node scripts/verify-compatibility.mjs --print nestjs)" next@"$(node scripts/verify-compatibility.mjs --print nextjs)" axios@"$(node scripts/verify-compatibility.mjs --print axios)"
  ```
  Expected: PASS, a lockfile with exact versions, and no prerelease dependency. Stop execution rather than weakening constraints if the gate fails.
- [ ] **Configure package boundaries.** Set `type: module`, `version: 0.1.0`, `engines.node` from the observed minimum, `sideEffects: false`, the exact exports listed above, framework/axios optional peer dependencies, and scripts `build`, `typecheck`, `test`, `test:browser`, `test:conformance`, `check:exports`, and `verify:compatibility`. Keep the execution-verified `@types/node`, `@types/express`, `@types/koa`, and `fastify-plugin` entries in development metadata/lockfile; expose `fastify-plugin` and framework runtime ranges as appropriate optional peers without making them core runtime dependencies. Configure strict TS with separate Node and browser build configs: Node/framework sources include the verified Node and framework declarations, while browser sources include `DOM`/`DOM.Iterable` and exclude Node types and all `node:` imports. Emit ESM plus declaration files for every advertised subpath into `dist/`.
- [ ] **Verify green.** Run `cd node && npm ci && npm run verify:compatibility && npm run typecheck`. Expected: all commands exit 0; compatibility output names observed exact versions.
- [ ] **Commit.** Run `git add node && git commit -m "chore(node): establish verified package toolchain"`.

### Task 2: Define public types, errors, and strict local validation

**Files:** Create `node/src/node/types.ts`, `node/src/node/errors.ts`, `node/src/node/validation.ts`, `node/test/node/validation.test.ts`.

**Interfaces:** Produces all `./node` types/errors above plus internal `buildPayload(eventKey, isCommon, event, ambientVisitorId): WirePayload`.

- [ ] **Write failing table tests.** Cover blank token/event key, identity absence, preserved email/phone/contact strings, trimmed explicit visitor with ambient fallback, exact wire snake_case, all five event shapes, finite/safe numbers, nested arrays/plain objects, and rejection of `NaN`, infinities, bigint, functions, symbols, dates, maps, sets, class instances, unsafe integers, symbol keys, and cycles. Assert validation messages never include the access token or property value.
- [ ] **Run red.** Run `cd node && npx vitest run test/node/validation.test.ts`. Expected: FAIL because `validation.js` and `errors.js` are absent.
- [ ] **Implement minimal validators and errors.** Walk properties using a `WeakSet<object>`, `Number.isFinite`, `Number.isSafeInteger`, `Object.getPrototypeOf(value) === Object.prototype || null`, and own enumerable string keys. Trim only visitor IDs; use `.trim()` solely to test event key/identity emptiness while retaining submitted identity strings.
- [ ] **Run green.** Run `cd node && npx vitest run test/node/validation.test.ts`. Expected: all validation/payload cases PASS with zero fetch calls in rejection cases.
- [ ] **Commit.** Run `git add node/src/node/{types,errors,validation}.ts node/test/node/validation.test.ts && git commit -m "feat(node): define events and strict validation"`.

### Task 3: Implement AsyncLocalStorage visitor scope and extraction

**Files:** Create `node/src/node/visitor-context.ts`, `node/test/node/visitor-context.test.ts`.

**Interfaces:** Produces `currentVisitorId`, `runWithVisitorId`, `runWithVisitorFromRequest`, and `runWithVisitorFromHeaders`; consumes the fixed header/cookie names.

- [ ] **Write failing scope tests.** Assert case-insensitive header-over-cookie precedence, array header first nonblank value, cookie parsing without decoding or authentication, trimming, blank omission, callback return/rejection preservation, nested scope restoration, cleanup after throw, promise/timer continuity, and 100 parallel scopes with no cross-request leakage.
- [ ] **Run red.** Run `cd node && npx vitest run test/node/visitor-context.test.ts`. Expected: FAIL with missing visitor-context module.
- [ ] **Implement one module-private store.** Use `new AsyncLocalStorage<Readonly<{visitorId?: string}>>()` and `storage.run(Object.freeze({visitorId}), callback)`, never `enterWith()`. Parse the semicolon-delimited cookie for the exact `_cekat_visitor_id` name and normalize Node/Web header carriers before entering scope.
- [ ] **Run green and stress it.** Run `cd node && npx vitest run test/node/visitor-context.test.ts --repeat 20`. Expected: 20 clean passes with no leaked visitor.
- [ ] **Commit.** Run `git add node/src/node/visitor-context.ts node/test/node/visitor-context.test.ts && git commit -m "feat(node): add isolated visitor request scope"`.

### Task 4: Implement bounded fetch delivery, decoding, retry, and cancellation

**Files:** Create `node/src/node/body.ts`, `node/src/node/delivery.ts`, `node/test/node/delivery.test.ts`.

**Interfaces:** Consumes `FetchLike`, wire payloads, errors, and call signals. Produces internal `deliver(config, payload, options, deps): Promise<Acknowledgement>`; `deps` supplies `fetch`, `sleep`, and `random` for deterministic tests.

- [ ] **Write failing delivery tests.** Assert URL/method/auth/content-type/body; distinct exactly-65,536-byte EOF and 65,537-byte oversized cases, retention of exactly the first 65,536 bytes, UTF-8 replacement only when the retained truncation boundary is incomplete; strict nested success parsing; malformed `200`; status mappings for `400/401/404/other`; conforming and malformed error bodies; retry sequences for transport/timeout/`500`; no retry for other statuses; jitter boundaries using random values `0` and `<1`; attempts `1..3`; token redaction; and `deliveryOutcomeUnknown` rules.
- [ ] **Write failing cancellation tests.** Cover pre-aborted signal (zero fetches), abort during fetch, abort during both backoffs, and caller abort racing the SDK timer. Assert caller reason identity is preserved and no further attempt starts.
- [ ] **Run red.** Run `cd node && npx vitest run test/node/delivery.test.ts`. Expected: FAIL because `deliver` is absent.
- [ ] **Implement bounded response reading.** Read `Response.body` incrementally until EOF or until byte 65,537 is observed. Retain only bytes `0..65,535`; set `bodyTruncated=true` only after observing byte 65,537, then cancel the reader. An exact 65,536-byte body that reaches EOF is not truncated. Decode the retained bytes with `new TextDecoder("utf-8", {fatal:false})`; a truncation that splits a multibyte sequence yields U+FFFD. For a null body, decode an empty byte array. A truncated `200` is a `ResponseDecodeError` even if its retained prefix parses as a valid success envelope.
- [ ] **Implement each attempt with separate cancellation.** Use a fresh `AbortController`, a 10,000ms timer, and listeners that abort on caller cancellation. Clear timer/listeners in `finally`. Check caller abortion before classifying fetch rejection; otherwise classify timer abortion or fetch rejection as retryable transport failure. Implement abortable sleep and compute `Math.floor(random() * (bound + 1))` for inclusive integer millisecond bounds 100 and 200.
- [ ] **Implement exact response classification.** A received response is always known outcome. Decode a valid nested success only for `200`; map malformed `200` to `ResponseDecodeError`; map `401`, `404`, and all other non-`200` statuses to the declared classes; retry only exact `500`; after exhaustion classify the final failure and report total network attempts.
- [ ] **Run green.** Run `cd node && npx vitest run test/node/delivery.test.ts`. Expected: all protocol, retry, bound, and cancellation tests PASS under fake timers.
- [ ] **Commit.** Run `git add node/src/node/{body,delivery}.ts node/test/node/delivery.test.ts && git commit -m "feat(node): deliver events with bounded retries"`.

### Task 5: Add the public client and Node-only export

**Files:** Create `node/src/node/client.ts`, `node/src/node/index.ts`, `node/test/node/client.test.ts`.

**Interfaces:** Produces `Client` and the complete `@cekat/event-sdk/node` surface. Consumes validation, `currentVisitorId`, and delivery.

- [ ] **Write failing client tests.** Assert token-only construction, origin validation, `timeoutMs > 0`, integer `retryCount >= 0`, callable injected fetch, fixed endpoint, common/custom keys and flags, explicit/ambient visitor precedence, no ambient visitor outside scope, one payload snapshot without `business_id`, and all five methods returning typed acknowledgement.
- [ ] **Run red.** Run `cd node && npx vitest run test/node/client.test.ts`. Expected: FAIL because `Client` is absent.
- [ ] **Implement the facade.** Store the token in a private field; normalize options once; have all public methods call one private `track(eventKey, isCommon, event, options)`; build payload immediately before delivery so the current ALS visitor is observed.
- [ ] **Run green plus API typecheck.** Run `cd node && npx vitest run test/node/client.test.ts && npm run typecheck`. Expected: all tests PASS and declarations expose only the Interfaces block.
- [ ] **Commit.** Run `git add node/src/node/{client,index}.ts node/test/node/client.test.ts && git commit -m "feat(node): expose synchronous event client API"`.

### Task 6: Add Express, Fastify, and Koa adapters

**Files:** Create `node/src/integrations/express.ts`, `fastify.ts`, `koa.ts`; create corresponding three tests.

**Interfaces:** Consumes `runWithVisitorFromRequest`/`runWithVisitorFromHeaders`. Produces `visitorMiddleware()` for Express/Koa and `visitorPlugin` for Fastify.

- [ ] **Write failing native integration tests.** For every framework send header, cookie, and neither; invoke `currentVisitorId()` after an awaited timer; run parallel requests; force downstream throw/rejection; and assert no value remains afterward. Assert middleware does not mutate headers/cookies, emit events, set cookies, or alter response/error semantics.
- [ ] **Run red.** Run `cd node && npx vitest run test/integrations/{express,fastify,koa}.test.ts`. Expected: FAIL because adapter exports are absent.
- [ ] **Implement thin adapters.** Representative Express implementation:
  ```ts
  export function visitorMiddleware(): RequestHandler {
    return (request, _response, next) => runWithVisitorFromRequest(request, next);
  }
  ```
  Register Fastify `onRequest` so `done()` executes inside `storage.run`; return a `fastify-plugin`-compatible async plugin without global registration. Koa must `return runWithVisitorFromHeaders(ctx.headers, ctx.headers.cookie, () => next())` so onion unwinding remains in scope.
- [ ] **Run green.** Run `cd node && npx vitest run test/integrations/{express,fastify,koa}.test.ts`. Expected: all native lifecycle/isolation tests PASS.
- [ ] **Commit.** Run `git add node/src/integrations/{express,fastify,koa}.ts node/test/integrations/{express,fastify,koa}.test.ts && git commit -m "feat(node): add Express Fastify and Koa visitor adapters"`.

### Task 7: Add NestJS and Next.js Node-runtime adapters

**Files:** Create `node/src/integrations/nestjs.ts`, `nextjs.ts`; create `node/test/integrations/nestjs-express.test.ts`, `nestjs-fastify.test.ts`, `nextjs.test.ts`.

**Interfaces:** Consumes visitor scope helpers. Produces `CekatVisitorMiddleware`, `withCekatVisitor`, and `runWithCekatVisitor`.

- [ ] **Write failing Nest tests.** Boot minimal Nest applications over both platform Express and platform Fastify, install `CekatVisitorMiddleware`, and assert precedence, awaited continuity, parallel isolation, cleanup, and unchanged thrown-error behavior.
- [ ] **Write failing Next tests.** Exercise Pages/API wrapper with Node request headers and App Router helper with a Web `Request`; assert `export const runtime = "nodejs"` usage in fixture, async continuity, return preservation, and a clear unsupported-runtime error when `globalThis.EdgeRuntime` exists.
- [ ] **Run red.** Run `cd node && npx vitest run test/integrations/nestjs-{express,fastify}.test.ts test/integrations/nextjs.test.ts`. Expected: FAIL because both adapters are absent.
- [ ] **Implement adapters.** Nest `use` calls `runWithVisitorFromRequest(req, next)` and holds no instance state. Next exports only Node-scoped wrappers; at invocation, reject an Edge runtime before accessing ALS-backed helpers. Do not import Next internals so supported Node request shapes remain stable.
- [ ] **Run green.** Run the red command again. Expected: Nest passes over both HTTP platforms and Next passes only its Node-runtime contract.
- [ ] **Commit.** Run `git add node/src/integrations/{nestjs,nextjs}.ts node/test/integrations/{nestjs-express,nestjs-fastify,nextjs}.test.ts && git commit -m "feat(node): add NestJS and Next Node adapters"`.

### Task 8: Add browser-safe explicit enrichment and Axios integration

**Files:** Create `node/src/browser/constants.ts`, `cookie.ts`, `explicit.ts`, `axios.ts`, `index.ts`; create `node/test/browser/cookie.test.ts`, `explicit.test.ts`, `axios.test.ts`, `public-api.types.ts`; modify `node/tsconfig.json`, `node/tsconfig.build.json`, and `node/vitest.config.ts` for their browser-oriented TypeScript/Vitest environment.

**Interfaces:** Produces the exact `@cekat/event-sdk/browser` and `@cekat/event-sdk/browser/axios` signatures from the Interfaces block: `AllowedTarget`, `AutoPropagationOptions`, `readVisitorId(cookieSource?: string): string | undefined`, `withVisitor(init?: RequestInit): RequestInit`, `withVisitorRequest(request: Request): Request`, `enableAutoPropagation(options): () => void`, and `createAxiosVisitorInterceptor(): (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig`. Browser index does not re-export Axios, keeping it in `./browser/axios` and optional. Browser source/declaration compilation uses DOM types and no Node globals; the browser unit project provides a DOM implementation for `document`, `Headers`, and `Request`, while SSR tests delete/omit `document` explicitly.

- [ ] **Write failing tests.** Cover exact cookie name, whitespace trimming, malformed/unrelated cookies, SSR with no `document`, copied `Headers`, explicit-header preservation case-insensitively, immutable `Request` cloning with URL, method, body bytes, credentials, cache, redirect, referrer, integrity, keepalive, and signal identity intact, and Axios `AxiosHeaders` plus plain-header configs. Add a TypeScript consumer fixture importing both browser subpaths and assigning every public function to the exact declared type. Assert no helper imports `./node`, references `AsyncLocalStorage`, or contains an access token.
- [ ] **Run red.** Run `cd node && npx vitest run test/browser/{cookie,explicit,axios}.test.ts && npx tsc --noEmit -p tsconfig.json`. Expected: FAIL because browser modules are absent.
- [ ] **Implement explicit helpers.** Representative behavior:
  ```ts
  export function withVisitor(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    const visitorId = readVisitorId();
    if (visitorId && !headers.has(VISITOR_HEADER)) headers.set(VISITOR_HEADER, visitorId);
    return {...init, headers};
  }
  export function withVisitorRequest(request: Request): Request {
    return new Request(request, withVisitor({headers: request.headers}));
  }
  ```
  `readVisitorId(cookieSource = globalThis.document?.cookie ?? "")` safely returns undefined in SSR. Axios interceptor uses `AxiosHeaders.from(config.headers)` and returns a new config; documentation directs users to attach it only to a dedicated instance.
- [ ] **Run green.** Run the red command again. Expected: explicit and Axios cases PASS without mutating inputs; the browser public API type fixture compiles with DOM types and without Node ambient types.
- [ ] **Commit.** Run `git add node/src/browser node/test/browser/{cookie,explicit,axios}.test.ts node/test/browser/public-api.types.ts node/tsconfig.json node/tsconfig.build.json node/vitest.config.ts && git commit -m "feat(browser): add explicit visitor propagation"`.

### Task 9: Add allowlisted, idempotent global fetch/XHR propagation

**Files:** Create `node/src/browser/allowlist.ts`, `auto.ts`, `node/test/browser/allowlist.test.ts`, both Playwright specs, browser fixture page/server.

**Interfaces:** Produces `enableAutoPropagation({allowedTargets})`; consumes `readVisitorId` and parsed normalized targets.

- [ ] **Write failing allowlist tests.** Reject empty lists, credentials, non-HTTP(S) origins, origin paths/queries/fragments, and path prefixes not beginning `/`. Normalize origin case/default ports, default path `/`, deduplicate, sort, and match by `URL.origin` equality plus `URL.pathname.startsWith(pathPrefix)`—never raw URL string prefix.
- [ ] **Write failing real-browser tests.** In Chromium, Firefox, and WebKit verify allowed/disallowed same- and cross-origin fetch/XHR, relative URLs, explicit visitor header preservation, body/credentials/signal/response preservation, XHR event/return behavior, aborts, one active install, identical normalized install returning the same disable function, different config throwing until disabled, and restoration of exact original methods.
- [ ] **Run red.** Run `cd node && npx vitest run test/browser/allowlist.test.ts && npx playwright test test/browser/auto-{fetch,xhr}.spec.ts`. Expected: unit import failure followed by absent interception in browser tests.
- [ ] **Implement one installation record.** Normalize and canonicalize targets first. Wrap `globalThis.fetch` by constructing one `Request`, matching its parsed URL, and enriching only allowed requests. Wrap `XMLHttpRequest.prototype.open`, `setRequestHeader`, and `send`; store parsed URL and explicit case-insensitive header state in `WeakMap` per XHR, and inject only immediately before original `send`. Keep originals and wrappers in the installation record; disable restores originals once and clears active state.
- [ ] **Run green in real browsers.** Run `cd node && npx playwright install && npx vitest run test/browser/allowlist.test.ts && npx playwright test`. Expected: all three browser projects PASS; server logs show no visitor header for denied targets.
- [ ] **Commit.** Run `git add node/src/browser/{allowlist,auto,index}.ts node/test/browser node/playwright.config.ts && git commit -m "feat(browser): add allowlisted fetch and XHR propagation"`.

### Task 10: Wire shared conformance and package boundary checks

**Files:** Create `node/test/conformance/sdk.test.ts`, `node/scripts/conformance`, `node/scripts/check-exports.mjs`, `node/test/package/exports.test.mjs`.

**Interfaces:** Consumes exactly `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_CONTROL_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and `CEKAT_CONFORMANCE_FIXTURES`; accepts no positional arguments, aliases, defaults, repository-relative fixture paths, or extra conformance variables. Produces executable `node/scripts/conformance` for root orchestration and verified npm subpath graphs.

- [ ] **Write failing conformance tests.** Discover every direct `*.json` child of the absolute `CEKAT_CONFORMANCE_FIXTURES` directory; fail on an empty corpus, duplicate IDs, filename/ID mismatch, unknown `schema_version`, operation, properties recipe, response-body recipe unit/form, cancellation phase, mock-response field/form, or `expect.result`, and fail if any discovered required case is skipped or lacks an executed assertion. Use `CEKAT_CONFORMANCE_ACCESS_TOKEN` to construct the SDK, only `CEKAT_CONFORMANCE_CONTROL_URL` for reset/queue/journal, and only `CEKAT_CONFORMANCE_BASE_URL` for ingest. For each case post `{"responses":[...]}`, validate the returned `{"requests":[...]}` envelope, and assert fixed path/auth, payload and visitor precedence, strict validation, exact HTTP error message, success/error decoding, retry count/jitter via injected sleeper, disconnect/timeout/cancellation, bounded bodies, and token redaction. At suite end compare discovered IDs with executed IDs; unknown or unexecuted cases are failures, never passes.
- [ ] **Write failing export tests.** Pack to a temporary directory, import every advertised subpath from a clean consumer, typecheck representative imports, scan browser artifacts recursively for `node:`, `async_hooks`, `Client`, and `Authorization`, and assert Edge/browser bundling never traverses Node modules.
- [ ] **Run red.** Run `cd node && npm run build && npx vitest run test/conformance/sdk.test.ts test/package/exports.test.mjs`. Expected: FAIL because scripts/exports are not wired.
- [ ] **Implement scripts.** `scripts/conformance` is executable, rejects positional arguments, requires all four exact variables above, validates base/control as absolute HTTP(S) origins and fixtures as an absolute readable directory, runs `npm ci`, build/typecheck, conformance tests, and exits with their status. It must not read any `CEKAT_MOCK_*` alias or start a server. `check-exports.mjs` validates every `package.json` target exists and performs the browser forbidden-import scan.
- [ ] **Run green against the mock server.** Run:
  ```bash
  cd conformance/mock-ingest-server
  go build -o /tmp/cekat-node-mock ./cmd/mock-ingest-server
  : > /tmp/cekat-node-mock.ready
  /tmp/cekat-node-mock --listen 127.0.0.1:0 > /tmp/cekat-node-mock.ready 2>/tmp/cekat-node-mock.err & server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 200); do [ -s /tmp/cekat-node-mock.ready ] && break; kill -0 "$server_pid" 2>/dev/null || exit 1; sleep 0.05; done
  read -r base_url control_url <<EOF
  $(python3 -c 'import json; r=json.loads(open("/tmp/cekat-node-mock.ready").readline()); print(r["base_url"], r["control_url"])')
  EOF
  cd ../..
  CEKAT_CONFORMANCE_BASE_URL="$base_url" \
  CEKAT_CONFORMANCE_CONTROL_URL="$control_url" \
  CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
  CEKAT_CONFORMANCE_FIXTURES="$PWD/conformance/fixtures/cases" \
    node/scripts/conformance
  cd node && npm run check:exports
  ```
  Expected: readiness JSON parses, conformance and export checks exit `0`, every discovered case ID is reported exactly once, and the mock journal contains no unexpected endpoint or token in payload.
- [ ] **Commit.** Run `git add node/test/{conformance,package} node/scripts/{conformance,check-exports.mjs} node/package.json && git commit -m "test(node): enforce shared conformance and exports"`.

### Task 11: Add deterministic no-publish packaging and user documentation

**Files:** Create `node/scripts/package`, `node/test/package/package-script.test.mjs`; modify `node/README.md`, `node/package.json`.

**Interfaces:** Produces executable `node/scripts/package --version 0.1.0 --output <absolute-dir>` and `<output>/manifest.json` with `{schema_version:1,language:"node",version:"0.1.0",artifacts:[{path,sha256,size_bytes}]}`.

- [ ] **Write failing packaging tests.** Assert rejection of missing/relative output, any version other than `0.1.0`, path traversal, dirty generated contents, publishing/signing commands, unsorted artifacts, and incorrect hashes. Assert two clean runs produce equivalent artifact contents and manifests apart from output location.
- [ ] **Run red.** Run `cd node && node --test test/package/package-script.test.mjs`. Expected: FAIL because `scripts/package` is absent.
- [ ] **Implement package script.** Parse exact flags, create output, run `npm ci`, all tests, browser tests, typecheck, build, export checks, and `npm pack --pack-destination <output>`. Hash regular artifacts with SHA-256, record relative traversal-free paths sorted bytewise and sizes, and atomically write the schema-v1 manifest. Never invoke `npm publish` or signing.
- [ ] **Document complete usage.** Include token-only Node setup, options, all event calls, middleware installation for five frameworks, Next `export const runtime = "nodejs"`, explicit visitor escape hatch, typed errors and duplicate risk, acknowledgement limits, dedicated Axios instance warning, explicit and automatic browser examples, exact allowlist semantics, CORS requirement for `X-Cekat-Visitor-ID`, SSR behavior, interceptor coverage exclusions, and assurance that browser exports contain no backend token client.
- [ ] **Run the release-time gate again.** Run `cd node && npm run verify:compatibility && npm audit --omit=dev && npm audit && npm outdated`. Expected: verification and audits exit 0 and `npm outdated` has no selected supported dependency unexpectedly behind its approved range. If official support/security changed, stop, update compatibility policy/lockfile/tests, and rerun Tasks 1–11 before artifact creation.
- [ ] **Run full validation and package.** Run:
  ```bash
  cd node
  npm ci
  npm run typecheck
  npm test
  npm run build
  npm run check:exports
  npm run test:browser
  out="$(mktemp -d)"
  ./scripts/package --version 0.1.0 --output "$out"
  node -e 'const fs=require("node:fs");const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p,"utf8"));if(m.schema_version!==1||m.language!=="node"||m.version!=="0.1.0")process.exit(1)' "$out/manifest.json"
  ```
  Expected: every command exits 0; one `.tgz` and a valid sorted hash manifest exist; no registry mutation occurs.
- [ ] **Commit.** Run `git add node && git commit -m "docs(node): document and package the SDK"`.

## Final Review Gate

- [ ] Run `git diff --check` and `git status --short`; expected: no whitespace errors and only intended Node plan implementation changes before the final commit.
- [ ] Run `cd node && npm ci && npm run verify:compatibility && npm run typecheck && npm test && npm run build && npm run check:exports && npm run test:browser`; expected: all exit 0.
- [ ] Inspect `npm pack --dry-run --json`; expected: only `dist`, package metadata, README, and license files; no source tests, access tokens, fixture secrets, Node/browser cross-imports, or framework runtime dependencies bundled into core.
- [ ] Confirm independent review explicitly checks endpoint/auth, envelopes, retries/cancellation, 64 KiB bound, strict JSON validation, ALS isolation, all five adapters, Node-only Next support, browser allowlisting/idempotence/uninstall, conformance script, and package manifest contract.
