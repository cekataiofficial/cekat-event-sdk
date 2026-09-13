# .NET SDK compatibility evidence

Retrieved: 2026-09-13 (UTC).

## Official sources

- .NET release metadata and support policy: <https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json> and <https://dotnet.microsoft.com/platform/support/policy/dotnet-core>
- NuGet package metadata: `https://api.nuget.org/v3-flatcontainer/<package>/index.json` and `https://api.nuget.org/v3-flatcontainer/<package>/<version>/<package>.nuspec`
- Container images: `mcr.microsoft.com/dotnet/sdk:8.0` and `mcr.microsoft.com/dotnet/sdk:10.0`
- Security advisories: `dotnet list package --vulnerable --include-transitive` (GitHub Advisory Database), run by `scripts/package`

## .NET

| Line | Release type | Support phase | End of support | Latest runtime / SDK (2026-09-08) |
| --- | --- | --- | --- | --- |
| 11.0 | STS | go-live (RC) | — | 11.0.0-rc.1 |
| 10.0 | LTS | active | 2028-11-14 | 10.0.12 / 10.0.401 |
| 9.0 | STS | maintenance | **2026-11-10** | 9.0.20 / 9.0.318 |
| 8.0 | LTS | maintenance | **2026-11-10** | 8.0.31 / 8.0.425 |

All three packages target `net8.0`, the oldest supported line, so they run on .NET 8, 9, and 10. .NET 8 and 9 reach end of support on 2026-11-10; the target moves to `net10.0` in a release after that date. The core package has no NuGet dependencies; all three packages set `IsAotCompatible` and build without trimming or AOT analyzer warnings.

## ASP.NET Core and Azure Functions

| Package | Dependency | Evidence |
| --- | --- | --- |
| `Cekat.EventSdk.AspNetCore` | `Microsoft.AspNetCore.App` shared framework (framework reference) | Runs on the ASP.NET Core version matching the application's runtime: 8.0, 9.0, or 10.0. |
| `Cekat.EventSdk.AzureFunctions` | `Microsoft.Azure.Functions.Worker.Core >= 2.0.0` | 2.0.0 (2024-11-12) is the first stable 2.x isolated worker release and targets net8.0; 2.52.0 (2026-04-21) is the latest. The in-process model is not supported (it ends with .NET 8 on 2026-11-10). |

The adapter is compiled and tested against the 2.0.0 floor. The middleware reads HTTP requests through `FunctionContext.GetHttpRequestDataAsync()` (the built-in `HttpRequestData` model); its tests use `FunctionContext` and `HttpRequestData` test doubles rather than a running Functions host, and the ASP.NET Core integration model (`Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore`) has not been verified.

## Test tooling (latest observed)

xunit.v3 4.0.1, xunit.runner.visualstudio 4.0.0, Microsoft.NET.Test.Sdk 18.10.0, JsonSchema.Net 9.4.0 (conformance schema validation), Microsoft.AspNetCore.TestHost 8.0.31 (net8.0) and 10.0.12 (net10.0). xunit.v3 4.x uses Microsoft Testing Platform; `global.json` opts the .NET 10 SDK's `dotnet test` into it, while the .NET 8 SDK runs the same projects through VSTest.

## Execution matrix (2026-09-13)

Every row built the solution with warnings as errors (`AnalysisLevel` 8.0-recommended) and ran the core, ASP.NET Core, and Azure Functions tests, then the shared conformance suite against `conformance/mock-ingest-server`: all 57 cases passed, including the three caller-cancellation cases.

| SDK (Docker) | Test runtime | Functions Worker.Core | Tests |
| --- | --- | --- | --- |
| 8.0.425 | net8.0 (8.0.31) | 2.0.0 | 127 core + 9 ASP.NET Core + 8 Functions passed |
| 10.0.401 | net10.0 (10.0.12) | 2.0.0 | 127 core + 9 ASP.NET Core + 8 Functions passed |

`scripts/package` passed on SDK 8.0.425 and 10.0.401: tests, vulnerability audit (no vulnerable packages, including transitive), and `dotnet pack` of the three `0.1.0` packages with README, MIT license expression, XML documentation, and embedded symbols.

## Release checklist

1. Recheck the release metadata and NuGet sources above.
2. If a supported line reached end of support, update the target framework, test profiles, CI matrix, and this document together.
3. Run both CI profiles and `scripts/package`.
