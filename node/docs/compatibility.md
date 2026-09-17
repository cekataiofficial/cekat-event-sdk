# Node SDK compatibility evidence

Retrieved: 2026-09-14T04:22:51.691Z

## Official sources

- Node release schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- Node distribution index: https://nodejs.org/dist/index.json
- npm registry: `npm view <package> versions time engines dist-tags --json; npm view <package>@<version> engines --json`
- Bun releases: `npm view bun versions time dist-tags --json (Bun publishes each runtime release to npm)`

The compatibility gate selected active even-numbered Node LTS lines 22, 24: each line has started, reached its LTS date, is not EOL, and is accepted by every selected runtime, declaration, and plugin package engine. The declared package engine floor is Node 22.12.0 (>=22.12.0 <28.0.0), the first Node 22 release that loads ES modules through `require()` without a flag; odd, EOL, and package-engine-incompatible lines are not supported. TypeScript is deliberately pinned to the exact compatible version 5.9.3 because the browser/Edge boundary guard uses its supported createSourceFile compiler API for fail-closed AST parsing. npm metadata establishes only that Next.js accepts this Node version; it does not establish a Next.js runtime boundary. A separate package-graph guard rejects Node-only imports from browser and present Next Edge entrypoints. Bun has no LTS line and maintains only its latest release; the declared engines.bun range is >=1.2.5, whose floor 1.2.5 (released 2025-03-11) and the latest stable release 1.4.2 (released 2026-09-05) are both exercised by the Bun test and conformance profiles.

| Component | Exact observed version | Selected support range |
| --- | --- | --- |
| Node.js | v22.23.2 | >=22.0.0 <26.0.0 |
| Bun | 1.4.2 | >=1.2.5 |
| TypeScript | 5.9.3 | ^5.0.0 |
| Vitest | 5.0.0 | ^5.0.0 |
| Playwright | 1.63.0 | ^1.0.0 |
| SemVer (npm maintained range evaluator) | 7.8.5 | ^7.0.0 |
| @types/node | 22.20.2 | ^22.0.0 |
| Express | 5.2.1 | ^5.0.0 |
| @types/express | 5.0.6 | ^5.0.0 |
| Fastify | 5.12.4 | ^5.0.0 |
| Koa | 3.2.1 | ^3.0.0 |
| @types/koa | 3.0.3 | ^3.0.0 |
| @nestjs/common | 12.0.1 | ^12.0.0 |
| @nestjs/core | 12.0.1 | ^12.0.0 |
| @nestjs/platform-express | 12.0.1 | ^12.0.0 |
| @nestjs/platform-fastify | 12.0.1 | ^12.0.0 |
| Next.js (Node engine compatibility) | 16.3.5 | ^16.0.0 |
| Axios | 1.20.0 | ^1.0.0 |

## Declared optional peer ranges

Adapters import framework packages only for types, so each declared peer range covers the observed current major above plus older majors that share the adapter's middleware contract. The current majors are exercised by the integration suite; older majors are accepted by the same adapter API and must be exercised before release.

| Peer package | Declared range |
| --- | --- |
| @nestjs/common | ^10.0.0 \|\| ^11.0.0 \|\| ^12.0.0 |
| @nestjs/core | ^10.0.0 \|\| ^11.0.0 \|\| ^12.0.0 |
| @nestjs/platform-express | ^10.0.0 \|\| ^11.0.0 \|\| ^12.0.0 |
| @nestjs/platform-fastify | ^10.0.0 \|\| ^11.0.0 \|\| ^12.0.0 |
| axios | ^1.0.0 |
| express | ^4.17.0 \|\| ^5.0.0 |
| fastify | ^4.0.0 \|\| ^5.0.0 |
| koa | ^2.13.0 \|\| ^3.0.0 |
| next | ^14.0.0 \|\| ^15.0.0 \|\| ^16.0.0 |

Older-major smoke evidence (2026-09-13): the packed SDK was installed alongside Express 4.22.2, Koa 2.16.4, Fastify 4.29.1, and NestJS 10.4.22 (`@nestjs/platform-express` and `@nestjs/platform-fastify`) with no peer conflicts; each adapter preserved the visitor ID across five parallel JSON POST requests with body parsing. `require('@cekatai/event-sdk')` loaded the package on Node 22.12.0 and 24.18.0. The Fastify adapter no longer depends on `fastify-plugin`; it applies the equivalent `skip-override` plugin metadata directly.

## Bun

Bun runs the same package; there is no separate Bun build. `npm run test:bun` executes the Vitest suites with Bun as the worker runtime (`bun --bun`) and adds the Bun-only `test/bun` suite (real `Bun.serve` servers, route handlers, Hono and Elysia applications, timeouts, and cancellation on Bun's `fetch`). `CEKAT_NODE_RUNTIME=bun scripts/conformance` runs the shared fixtures on Bun, and the runner requires the User-Agent runtime token to be `bun/<version>`.

### Execution evidence (2026-09-14)

Docker `oven/bun` binaries, with Node.js 24.21.0 for npm and TypeScript tooling:

| Bun | Released | Test suites | Conformance, 10 consecutive runs | Truncated-response fallback used |
| --- | --- | --- | --- | --- |
| 1.4.2 | 2026-09-05 | 185 passed | 10 of 10 | 0 of 10 runs |
| 1.3.14 | 2026-05-13 | 185 passed | 10 of 10 | 3 of 10 runs |
| 1.2.5 | 2025-03-11 | 185 passed | 10 of 10 | 7 of 10 runs |

Bun 1.2.23 and 1.3.0 passed 5 of 5 conformance runs (fallback used in 3 and 1 runs), and their test suites passed. Bun 1.4.0 and 1.4.1 passed 10 of 10 conformance runs before the fallback existed. Bun 1.2.0 and older cannot run the test tooling: Vitest 5 imports `util.parseEnv`, which Bun provides from 1.2.5.

### Bun before 1.4.0

Standalone probes of `fetch` against the mock server (8 runs each) found two HTTP-client defects in Bun 1.1.45 through 1.3.14 that Bun 1.4.0 fixes:

1. **Connection-pool defects.** With default connection reuse, Bun 1.1.45, 1.2.0, and 1.2.5 returned a truncated body concatenated with the next response on the connection, silently re-sent a request after a disconnect before the headers (a duplicate request), and sent an extra request after an interrupted response (8 of 8 runs each). On 1.3.0, the SDK recorded three requests for `retry-500-body-interrupted-success` instead of two. The SDK therefore passes `keepalive: false` on Bun before 1.4 (`connectionReuseInit` in `src/node/runtime.ts`), and every such defect disappeared in the probes. Removing it makes Bun 1.2.5 fail conformance in 5 of 5 runs.
2. **Truncated responses reject `fetch()`.** When the connection closes after the response headers but before the complete body, Bun rejects `fetch()` itself (2 to 8 of 8 probe runs, depending on the release), with the same `ECONNRESET` error as a connection that never received headers. On 1.3.14 `node:http` behaves the same way, so no built-in transport observes the status. The SDK then treats the attempt as a transport failure and retries it with the same `event_id`. For `success-body-interrupted`, which requires a decode error without a retry, the Node runner accepts this documented fallback on Bun before 1.4 only; see "Runtime limitations" in `conformance/README.md`. Every other fixture is asserted unchanged.

An earlier revision of this document attributed the 1.3 conformance failures to stale responses after timeouts; the probes above showed the cause is defect 2 (the retry received the mock's default acknowledgement), and defect 1 explains the extra request on 1.3.0.

### AsyncLocalStorage

`AsyncLocalStorage` behaves like Node.js across promises, timers, `setImmediate`, `process.nextTick`, `queueMicrotask`, thenables, async generators, streams, `EventEmitter`, `EventTarget` and `AbortController` listeners, `fetch`, `node:http`, and `crypto.subtle` on every tested Bun release. It is not restored in `AbortSignal.timeout()` listeners or `MessagePort` message handlers (Bun 1.2.5 through 1.4.2); `test/node/visitor-context-propagation.test.ts` pins that difference. The SDK reads the visitor synchronously when a call starts, so its own calls are unaffected.

### Test-only difference

Bun before 1.3.10 ignores `Request`'s `cache` option and always reports `default`. This affects only the browser-helper test's stand-in `Request`, which now requires the helper to preserve whatever mode the runtime records.
