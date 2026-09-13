# Node SDK compatibility evidence

Retrieved: 2026-09-11T10:53:18.609Z

## Official sources

- Node release schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- Node distribution index: https://nodejs.org/dist/index.json
- npm registry: `npm view <package> versions time engines dist-tags --json; npm view <package>@<version> engines --json`

The compatibility gate selected active even-numbered Node LTS lines 22, 24: each line has started, reached its LTS date, is not EOL, and is accepted by every selected runtime, declaration, and plugin package engine. The declared package engine floor is Node 22.12.0 (>=22.12.0 <28.0.0), the first Node 22 release that loads ES modules through `require()` without a flag; odd, EOL, and package-engine-incompatible lines are not supported. TypeScript is deliberately pinned to the exact compatible version 5.9.3 because the browser/Edge boundary guard uses its supported createSourceFile compiler API for fail-closed AST parsing. npm metadata establishes only that Next.js accepts this Node version; it does not establish a Next.js runtime boundary. A separate package-graph guard rejects Node-only imports from browser and present Next Edge entrypoints.

| Component | Exact observed version | Selected support range |
| --- | --- | --- |
| Node.js | v22.23.2 | >=22.0.0 <26.0.0 |
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
| Next.js (Node engine compatibility) | 16.3.4 | ^16.0.0 |
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

Older-major smoke evidence (2026-09-13): the packed SDK was installed alongside Express 4.22.2, Koa 2.16.4, Fastify 4.29.1, and NestJS 10.4.22 (`@nestjs/platform-express` and `@nestjs/platform-fastify`) with no peer conflicts; each adapter preserved the visitor ID across five parallel JSON POST requests with body parsing. `require('@cekat/event-sdk')` loaded the package on Node 22.12.0 and 24.18.0. The Fastify adapter no longer depends on `fastify-plugin`; it applies the equivalent `skip-override` plugin metadata directly.
