# Node SDK compatibility evidence

Retrieved: 2026-09-11T06:36:37.510Z

## Official sources

- Node release schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- Node distribution index: https://nodejs.org/dist/index.json
- npm registry: `npm view <package> versions time engines dist-tags --json; npm view <package>@<version> engines --json`

The compatibility gate selected active even-numbered Node LTS lines 22, 24: each line has started, reached its LTS date, is not EOL, and is accepted by every selected runtime, declaration, and plugin package engine. The declared package engine floor is Node 22.0.0 (>=22.0.0 <28.0.0); odd, EOL, and package-engine-incompatible lines are not supported. TypeScript is deliberately pinned to the exact compatible version 5.9.3 because the browser/Edge boundary guard uses its supported createSourceFile compiler API for fail-closed AST parsing. npm metadata establishes only that Next.js accepts this Node version; it does not establish a Next.js runtime boundary. A separate package-graph guard rejects Node-only imports from browser and present Next Edge entrypoints.

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
| Fastify | 5.12.3 | ^5.0.0 |
| fastify-plugin | 6.0.0 | ^6.0.0 |
| Koa | 3.2.1 | ^3.0.0 |
| @types/koa | 3.0.3 | ^3.0.0 |
| @nestjs/common | 12.0.1 | ^12.0.0 |
| @nestjs/core | 12.0.1 | ^12.0.0 |
| @nestjs/platform-express | 12.0.1 | ^12.0.0 |
| @nestjs/platform-fastify | 12.0.1 | ^12.0.0 |
| Next.js (Node engine compatibility) | 16.3.4 | ^16.0.0 |
| Axios | 1.20.0 | ^1.0.0 |
