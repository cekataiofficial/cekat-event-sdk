# SDK compatibility

<!-- Generated from ci/compatibility-matrix.json by scripts/audit-docs.py --write-compatibility. Do not edit by hand. -->

Verified on 2026-09-14. Each SDK's evidence document records the official sources, exact observed versions, and test results; [`ci/compatibility-matrix.json`](../ci/compatibility-matrix.json) is checked against package metadata, CI, and that evidence by [`scripts/validate-compatibility-matrix.py`](../scripts/validate-compatibility-matrix.py).

| SDK | Runtime floor | Tested in CI (minimum → current) | Evidence |
| --- | --- | --- | --- |
| [Go](../go/README.md) | Go `1.22` | 1.22.12 → 1.27.1 | [COMPATIBILITY.md](../go/COMPATIBILITY.md) |
| [Node.js and Bun](../node/README.md) | Node.js `>=22.12.0 <28.0.0`; Bun `>=1.2.5` | 22.12.0 → 24.21.0 | [compatibility.md](../node/docs/compatibility.md) |
| [Python](../python/README.md) | CPython `>=3.10` | 3.10.21 → 3.14.7 | [compatibility.md](../python/docs/compatibility.md) |
| [PHP](../php/README.md) | PHP `^8.2` | 8.2.33 → 8.5.10 | [compatibility.md](../php/docs/compatibility.md) |
| [Java](../java/README.md) | Java `17` | 17.0.20 → 25.0.4 | [compatibility.md](../java/compatibility.md) |
| [.NET](../dotnet/README.md) | .NET `net8.0` | 8.0.425 → 10.0.401 | [COMPATIBILITY.md](../dotnet/COMPATIBILITY.md) |
| [Ruby](../ruby/README.md) | Ruby `>= 3.3.0` | 3.3.12 → 4.0.6 | [COMPATIBILITY.md](../ruby/COMPATIBILITY.md) |

## Go

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| net/http | standard library | — |
| Chi | v5.3.2+ | v5.3.2 |
| Gin | v1.12.0+ | v1.12.0 |
| Echo | v4.15.4+ | v4.15.4 |
| Fiber | v3.5.0+ | v3.5.0 |

CI: `go` job `go-version`: 1.22.12, stable. Release readiness installs `go-version` stable.

## Node.js and Bun

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| Express | 4.17+, 5 | 5.2.1, 4.22.2 |
| Fastify | 4, 5 | 5.12.4, 4.29.1 |
| Koa | 2.13+, 3 | 3.2.1, 2.16.4 |
| NestJS | 10, 11, 12 | 12.0.1, 10.4.22 |
| Next.js | 14, 15, 16 (Node runtime) | 16.3.5 |
| Bun.serve, Hono, Elysia | fetch-style handlers via @cekat/event-sdk/fetch | 1.2.5, 1.3.14, 1.4.2 |

CI: `node` job `node-version`: 22.12.0, 24; `bun` job `bun-version`: 1.2.5, 1.3.14, 1.4.2. Release readiness installs `node-version` 24.

## Python

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| Django | 5.2, 6.x | 5.2, 6.1.1 |
| Flask | 3.1+ | 3.1.0, 3.1.3 |
| Starlette | 0.41+, 1.x | 0.41.0, 1.6.0 |
| FastAPI | 0.115.3+ | 0.115.3, 0.141.1 |

CI: `python` job `python-version`: 3.10, 3.14. Release readiness installs `python-version` 3.14.

Upcoming end of support: CPython 3.10 on 2026-10.

## PHP

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| Laravel | 12, 13 | 12.61.1, 13.31.0 |
| Symfony | 6.4, 7.4, 8 | 6.4.0, 7.4.12, 8.1.6 |
| PSR-15 middleware | psr/http-server-middleware 1.x | — |

CI: `php` job `php-version`: 8.2, 8.5, 8.2; `php` job `dependencies`: lowest, highest, symfony-6.4-floor. Release readiness installs `php-version` 8.5.

Upcoming end of support: PHP 8.2 on 2026-12-31.

## Java

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| Spring Boot | 4.0, 4.1 | 4.0.8, 4.1.1 |
| Jakarta Servlet | 6.0+ | 6.0.0 |

CI: `java` job `java-version`: 17, 25; `java` job `spring-boot`: 4.0.8, 4.1.1. Release readiness installs `java-version` 25.

Upcoming end of support: Spring Boot 4.0 on 2026-12-31.

## .NET

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| ASP.NET Core | 8, 9, 10 (shared framework) | 8.0.31, 10.0.12 |
| Azure Functions isolated worker | Worker.Core 2.x | 2.0.0 |

CI: `dotnet` job `sdk`: 8.0, 10.0; `dotnet` job `test-framework`: net8.0, net10.0. Release readiness installs `dotnet-version` 10.0.x.

Upcoming end of support: .NET 8.0 on 2026-11-10.

## Ruby

| Framework or integration | Supported | Tested versions |
| --- | --- | --- |
| Rails | 8.0, 8.1 | 8.0.5.1, 8.1.3.1 |
| Rack | 2.2, 3.1, 3.2 | 2.2.24, 3.1.22, 3.2.7 |

CI: `ruby` job `ruby-version`: 3.3, 3.4, 4.0; `ruby` job `rails`: 8.0, 8.1, 8.1; `ruby` job `rack`: 2.2, 3.1, 3.2. Release readiness installs `ruby-version` 4.0.

Upcoming end of support: Rails 8.0 on 2026-11-07; Ruby 3.3 on 2027-03-31.

## Keeping this current

When a runtime floor, CI row, or framework range changes, update the package metadata, the CI workflow, the language's evidence document, and `ci/compatibility-matrix.json` together, then regenerate this page with `python3 scripts/audit-docs.py --write-compatibility`. The release readiness preflight fails when a listed line has reached end of support or the matrix was verified more than 30 days earlier.
