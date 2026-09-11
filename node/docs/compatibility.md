# Node SDK compatibility evidence

Retrieved: 2026-09-11T04:34:43.822Z

## Official sources

- Node release schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- Node distribution index: https://nodejs.org/dist/index.json
- npm registry: `npm view <package> versions time engines dist-tags --json`

The compatibility gate selected maintained even-numbered LTS lines 22, 24, 26. The package engine floor is Node 22; odd and EOL lines are not supported. Next.js is restricted to its Node runtime.

| Component | Exact observed version | Selected support range |
| --- | --- | --- |
| Node.js | v22.23.2 | >=22.0.0 <28.0.0 |
| TypeScript | 7.0.2 | ^7.0.0 |
| Vitest | 5.0.0 | ^5.0.0 |
| Playwright | 1.63.0 | ^1.0.0 |
| @types/node | 22.20.2 | ^22.0.0 |
| Express | 5.2.1 | ^5.0.0 |
| @types/express | 5.0.6 | ^5.0.0 |
| Fastify | 5.12.3 | ^5.0.0 |
| fastify-plugin | 6.0.0 | ^6.0.0 |
| Koa | 3.2.1 | ^3.0.0 |
| @types/koa | 3.0.3 | ^3.0.0 |
| NestJS | 12.0.1 | ^12.0.0 |
| Next.js (Node runtime) | 16.3.4 | ^16.0.0 |
| Axios | 1.20.0 | ^1.0.0 |
