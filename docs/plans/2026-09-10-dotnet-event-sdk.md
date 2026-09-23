# .NET Core, ASP.NET Core, and Azure Functions Implementation Plan

> **Contract amendment (2026-09-13) — overrides conflicting statements below.** See `conformance/README.md` and the amended design spec. (1) Default timeout is **3 seconds** per attempt. (2) Retry transport failures, eligible timeouts, and HTTP **429, 500, 502, 503, 504**; decide by status alone. (3) Full jitter before retry `n` is `[0, min(100ms·2^(n-1), 1000ms)]`. (4) A valid `Retry-After` raises the delay to its value; above **5 seconds**, do not retry and return the typed error. (5) A received `200` whose body read fails is a known-outcome decode error and is never retried. (6) Every payload carries `event_id` (caller value trimmed, else lowercase v4 UUID) and `occurred_at` (caller time or call time, UTC RFC 3339 milliseconds), both fixed per call and reused on retry; event inputs accept optional `event_id` and `occurred_at`. (7) Send `User-Agent: cekat-event-sdk-<language>/<semver>`. (8) Invalid input must surface through the operation's normal error channel (for example a rejected promise/future, never a synchronous throw from an async API). (9) Documentation shows a non-blocking tracking pattern. (10) Fixture `retry-no-429` was replaced by `retry-429-*`, `retry-502-503-504-exhausted`, `retry-500-body-interrupted-success`, `success-body-interrupted`, and `request-explicit-event-id-occurred-at`; the mock supports `disconnect_after_headers`. (11) `OrderPaid` takes required `amount` (finite number) and `currency` (nonblank string) arguments before the event, sent as `properties.amount` and `properties.currency`; caller properties containing either key are a validation error. Fixtures declare them as `operation.amount`/`operation.currency` (required for `order_paid` only).


> **Implementation notes (2026-09-13) — as built, overriding the tasks below.** Packages target `net8.0` (.NET 8 and 9 end support 2026-11-10; .NET 10 LTS runs them) and are tested on SDK 8 (net8.0) and SDK 10 (net10.0) via the `TestTargetFramework` property. Exceptions follow .NET naming with a `Cekat` prefix to avoid collisions: `CekatException` (base: `Attempts`, `DeliveryOutcomeUnknown`), `CekatValidationException`, `CekatApiException` (base of `CekatAuthenticationException` and `CekatEventDefinitionNotFoundException`; `StatusCode`, `Code`, `RawBody`, `GetRawBodyBytes()`), `CekatTransportException`, `CekatResponseDecodeException`. `EventInput` adds `EventId`/`OccurredAt`; `OrderPaidAsync(decimal amount, string currency, EventInput input, CancellationToken)`; `CekatClient` is `IDisposable` (owned `HttpClient` only, redirects disabled) and `WithVisitorIdAsync` is static, as is `AsyncLocalVisitorContext.Push`. Visitor resolution is explicit `VisitorId`, then an `AsyncLocal` scope, then the injected `IVisitorContext`; the ASP.NET Core and Functions middleware write request/invocation `Items` (canonical) and also push an `AsyncLocal` scope so fire-and-forget work keeps the visitor after `IHttpContextAccessor` is cleared. The Functions adapter needs no scoped accessor: `AddCekatEventSdk` registers a singleton client and `FunctionContext.GetCekatVisitorId()` reads `Items`; its tests use a `GetHttpRequestDataAsync` seam with test doubles. Registration runs `configure` immediately so invalid options fail at startup. Payload validation and serialization happen in one `Utf8JsonWriter` pass supporting dictionaries, `KeyValuePair` sequences (e.g. `ExpandoObject`), lists, `JsonElement`, and `JsonNode`. Retry-After is read from non-validated headers; HTTP/2+ responses use the fixed status-text table because they carry no reason phrase. Tests use xunit.v3 4.x (Microsoft Testing Platform, opted in through `global.json` for the .NET 10 SDK). The conformance project is not in `Cekat.EventSdk.sln` (it needs the mock) and runs as an executable through `scripts/conformance`; it validates fixtures with JsonSchema.Net. `scripts/package` adds `dotnet list package --vulnerable --include-transitive`. Evidence and the tested matrix are in `dotnet/COMPATIBILITY.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
**Goal:** Build independently testable `Cekat.EventSdk`, `Cekat.EventSdk.AspNetCore`, and `Cekat.EventSdk.AzureFunctions` NuGet packages implementing the approved event, retry, error, visitor-context, and shared-conformance contracts.
**Architecture:** The core owns recursive JSON-domain validation, serialization, HTTP delivery, retry decisions, response decoding, errors, and a generic `AsyncLocal` scope. ASP.NET Core reads canonical request state from `HttpContext.Items`; Azure Functions isolated worker reads canonical state from `FunctionContext.Items` through an invocation-scoped accessor. Framework middleware extracts the header or cookie, writes canonical request state, invokes the next component, and restores prior state in `finally`. A dedicated fixture-driven xUnit project is the sole .NET consumer of the schemas, cases, control API, and mock server owned by the shared-conformance plan.
**Tech Stack:** the evidence-selected maintained .NET SDK lines, `HttpClient`, `System.Text.Json`, ASP.NET Core shared framework, Azure Functions isolated worker, and xUnit, with exact versions recorded in `dotnet/COMPATIBILITY.md` before project creation.
**Spec:** `docs/superpowers/specs/2026-09-10-multilanguage-event-sdk-design.md`
## Global constraints
- Target `net8.0` for the published libraries. Prove consumption and execution from both the evidence-selected minimum supported .NET line and current stable .NET line; do not claim a runtime/framework line absent from `dotnet/COMPATIBILITY.md`.
- Only `accessToken` is required.
- Never serialize `business_id`.
- Never include the access token in errors, exception messages, response models, logs, or test snapshots.
- Preserve submitted identity strings; trimming is only for emptiness checks.
- Only HTTP `200` with the approved nested envelope returns an acknowledgement.
- Public event methods accept `CancellationToken`.
- Cancellation must interrupt requests and retry delay.
- ASP.NET Core and Functions request items are canonical; `AsyncLocal` is only the generic explicit-scope fallback.
- Acknowledgement means queue acceptance for asynchronous processing only.
- `BaseUrl` is an absolute HTTP(S) origin only: no user info, non-root path, query, or fragment. Normalize an optional root trailing slash and append only `/api/events/ingest`.
- Validate options and the recursive JSON value domain before constructing or sending a request. Integral values at any depth must be within `[-9007199254740991, 9007199254740991]`; reject non-finite values, cycles, non-string object keys, and unsupported runtime objects.
- Version all three packages as `0.1.0`.
## Exact file map
```text
dotnet/
├── Cekat.EventSdk.sln
├── Directory.Build.props
├── Directory.Packages.props
├── COMPATIBILITY.md
├── README.md
├── scripts/
│   ├── conformance
│   └── package
├── src/
│   ├── Cekat.EventSdk/
│   │   ├── Cekat.EventSdk.csproj
│   │   ├── Acknowledgement.cs
│   │   ├── CekatClient.cs
│   │   ├── CekatClientOptions.cs
│   │   ├── CekatConstants.cs
│   │   ├── EventInput.cs
│   │   ├── Errors/
│   │   │   ├── ApiError.cs
│   │   │   ├── AuthenticationError.cs
│   │   │   ├── CekatException.cs
│   │   │   ├── EventDefinitionNotFoundError.cs
│   │   │   ├── ResponseDecodeError.cs
│   │   │   ├── TransportError.cs
│   │   │   └── ValidationError.cs
│   │   ├── Internal/
│   │   │   ├── EnvelopeDecoder.cs
│   │   │   ├── EventRequest.cs
│   │   │   ├── ResponseBodyReader.cs
│   │   │   ├── RetryPolicy.cs
│   │   │   └── Validation.cs
│   │   └── Visitor/
│   │       ├── AsyncLocalVisitorContext.cs
│   │       ├── IVisitorContext.cs
│   │       └── VisitorIdResolver.cs
│   ├── Cekat.EventSdk.AspNetCore/
│   │   ├── Cekat.EventSdk.AspNetCore.csproj
│   │   ├── AspNetCoreVisitorContext.cs
│   │   ├── CekatApplicationBuilderExtensions.cs
│   │   ├── CekatServiceCollectionExtensions.cs
│   │   └── CekatVisitorMiddleware.cs
│   └── Cekat.EventSdk.AzureFunctions/
│       ├── Cekat.EventSdk.AzureFunctions.csproj
│       ├── AzureFunctionsVisitorContext.cs
│       ├── CekatFunctionsWorkerApplicationBuilderExtensions.cs
│       ├── CekatFunctionsWorkerServiceCollectionExtensions.cs
│       └── CekatFunctionsVisitorMiddleware.cs
└── tests/
    ├── Cekat.EventSdk.Tests/
    │   ├── Cekat.EventSdk.Tests.csproj
    │   ├── ClientPayloadTests.cs
    │   ├── ClientResponseTests.cs
    │   ├── ClientRetryTests.cs
    │   ├── ClientSecurityTests.cs
    │   ├── TestHttpMessageHandler.cs
    │   ├── ValidationTests.cs
    │   └── VisitorContextTests.cs
    ├── Cekat.EventSdk.AspNetCore.Tests/
    │   ├── Cekat.EventSdk.AspNetCore.Tests.csproj
    │   └── CekatVisitorMiddlewareTests.cs
    ├── Cekat.EventSdk.Conformance.Tests/
    │   ├── Cekat.EventSdk.Conformance.Tests.csproj
    │   ├── AssemblyInfo.cs
    │   ├── ConformanceTests.cs
    │   ├── FixtureLoader.cs
    │   ├── FixtureModels.cs
    │   ├── MockControlClient.cs
    │   ├── RecipeFactory.cs
    │   └── ResultAssertions.cs
    └── Cekat.EventSdk.AzureFunctions.Tests/
        ├── Cekat.EventSdk.AzureFunctions.Tests.csproj
        ├── CekatFunctionsVisitorMiddlewareTests.cs
        └── TestFunctionContext.cs
```
### Task 1: Verify compatibility, bootstrap the solution, and define the public model surface
**Files:**
- Create: `dotnet/COMPATIBILITY.md`
- Create: `dotnet/Cekat.EventSdk.sln`
- Create: `dotnet/Directory.Build.props`
- Create: `dotnet/Directory.Packages.props`
- Create: all seven `.csproj` files in the map
- Create: `dotnet/src/Cekat.EventSdk/{CekatConstants,CekatClientOptions,EventInput,Acknowledgement}.cs`
- Create: `dotnet/tests/Cekat.EventSdk.Tests/ValidationTests.cs`
**Interfaces:**
- Consumes: no earlier task.
- Produces:
  ```csharp
  namespace Cekat.EventSdk;
  public static class CekatConstants
  {
      public const string DefaultBaseUrl = "https://t.cekat.ai";
      public const string IngestPath = "/api/events/ingest";
      public const string VisitorCookie = "_cekat_visitor_id";
      public const string VisitorHeader = "X-Cekat-Visitor-ID";
      public const int MaximumResponseBodyBytes = 65_536;
  }
  public sealed record EventInput(
      string? Email = null,
      string? PhoneNumber = null,
      string? ContactName = null,
      object? Properties = null,
      string? VisitorId = null);
  public sealed record Acknowledgement(
      bool Success,
      string Message,
      string EventKey,
      IReadOnlyList<string> ValidatedProperties,
      string RawBody);
  public sealed class CekatClientOptions
  {
      public string? AccessToken { get; set; }
      public Uri BaseUrl { get; set; } = new(CekatConstants.DefaultBaseUrl);
      public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(10);
      public int RetryCount { get; set; } = 2;
  }
  ```
  `AccessToken` is settable so `Action<CekatClientOptions>` registration can construct options conventionally; client/service registration rejects null, blank, or whitespace-only tokens before creating the transport.
- [ ] **Step 1: Record compatibility evidence before selecting dependencies**
  Run:
  ```bash
  mkdir -p dotnet
  curl -fsSL https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core
  curl -fsSL https://dotnet.microsoft.com/en-us/download/dotnet
  dotnet --info
  curl -fsSL https://api.nuget.org/v3-flatcontainer/microsoft.azure.functions.worker.core/index.json
  curl -fsSL https://api.nuget.org/v3-flatcontainer/microsoft.net.test.sdk/index.json
  curl -fsSL https://api.nuget.org/v3-flatcontainer/xunit/index.json
  curl -fsSL https://api.nuget.org/v3-flatcontainer/xunit.runner.visualstudio/index.json
  ```
  Expected: every request and `dotnet --info` exit `0`. In `dotnet/COMPATIBILITY.md`, record the UTC date, source URLs, complete observed SDK/runtime versions, maintained support dates, selected minimum and current stable SDK/runtime profiles, ASP.NET Core majors, an Azure Functions isolated-worker version compatible with the target framework, and exact test package versions. Select versions only from observed official .NET and NuGet metadata; stop rather than guessing if the maintained minimum cannot target/consume `net8.0`, Functions compatibility is unclear, or the policy has changed. `Directory.Packages.props` pins exactly those observed package versions. This check is repeated before package readiness.
- [ ] **Step 2: Create the solution, projects, references, and shared build settings**
  Run:
  ```bash
  cd dotnet
  dotnet new sln -n Cekat.EventSdk
  dotnet new classlib -n Cekat.EventSdk -o src/Cekat.EventSdk -f net8.0
  dotnet new classlib -n Cekat.EventSdk.AspNetCore -o src/Cekat.EventSdk.AspNetCore -f net8.0
  dotnet new classlib -n Cekat.EventSdk.AzureFunctions -o src/Cekat.EventSdk.AzureFunctions -f net8.0
  dotnet new xunit -n Cekat.EventSdk.Tests -o tests/Cekat.EventSdk.Tests -f net8.0
  dotnet new xunit -n Cekat.EventSdk.AspNetCore.Tests -o tests/Cekat.EventSdk.AspNetCore.Tests -f net8.0
  dotnet new xunit -n Cekat.EventSdk.AzureFunctions.Tests -o tests/Cekat.EventSdk.AzureFunctions.Tests -f net8.0
  dotnet new xunit -n Cekat.EventSdk.Conformance.Tests -o tests/Cekat.EventSdk.Conformance.Tests -f net8.0
  dotnet sln add src/*/*.csproj tests/*/*.csproj
  dotnet add src/Cekat.EventSdk.AspNetCore reference src/Cekat.EventSdk
  dotnet add src/Cekat.EventSdk.AzureFunctions reference src/Cekat.EventSdk
  dotnet add tests/Cekat.EventSdk.Tests reference src/Cekat.EventSdk
  dotnet add tests/Cekat.EventSdk.AspNetCore.Tests reference src/Cekat.EventSdk.AspNetCore
  dotnet add tests/Cekat.EventSdk.AzureFunctions.Tests reference src/Cekat.EventSdk.AzureFunctions
  dotnet add tests/Cekat.EventSdk.Conformance.Tests reference src/Cekat.EventSdk
  ```
  Set `Directory.Build.props` to enable nullable references, implicit usings, deterministic builds, warnings as errors, package version `0.1.0`, repository metadata, and XML documentation. Add `<FrameworkReference Include="Microsoft.AspNetCore.App" />` to the ASP.NET projects. Pin the evidence-recorded packages centrally in `Directory.Packages.props`; do not invent projected patch versions.
  Expected: all seven projects are listed by `dotnet sln list`, and both evidence-selected SDK profiles can restore and build the `net8.0` solution.
- [ ] **Step 3: Write failing option and model tests**
  ```csharp
  [Fact]
  public void Options_use_approved_defaults()
  {
      var options = new CekatClientOptions { AccessToken = "token" };
      Assert.Equal(new Uri("https://t.cekat.ai"), options.BaseUrl);
      Assert.Equal(TimeSpan.FromSeconds(10), options.Timeout);
      Assert.Equal(2, options.RetryCount);
      Assert.Equal("/api/events/ingest", CekatConstants.IngestPath);
  }
  [Fact]
  public void Event_input_preserves_identity_text()
  {
      var input = new EventInput(Email: "  ada@example.com  ");
      Assert.Equal("  ada@example.com  ", input.Email);
  }
  ```
- [ ] **Step 4: Verify red**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj \
    --filter "Options_use_approved_defaults|Event_input_preserves_identity_text"
  ```
  Expected: compilation fails because the public types do not exist.
- [ ] **Step 5: Add the complete public models and constants**
  Implement the signatures above. Validate options later in `CekatClient`; do not mutate or normalize model values.
- [ ] **Step 6: Verify green**
  Run: `dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj`
  Expected: 2 tests pass with zero warnings.
- [ ] **Step 7: Commit**
  ```bash
  git add dotnet
  git commit -m "build(dotnet): verify and bootstrap SDK packages"
  ```
### Task 2: Implement validation, typed errors, and visitor resolution
**Files:**
- Create: `dotnet/src/Cekat.EventSdk/Errors/*.cs`
- Create: `dotnet/src/Cekat.EventSdk/Internal/Validation.cs`
- Create: `dotnet/src/Cekat.EventSdk/Visitor/*.cs`
- Modify: `dotnet/tests/Cekat.EventSdk.Tests/ValidationTests.cs`
- Create: `dotnet/tests/Cekat.EventSdk.Tests/VisitorContextTests.cs`
**Interfaces:**
- Consumes: `EventInput`, `CekatClientOptions`, and constants from Task 1.
- Produces:
  ```csharp
  public interface IVisitorContext
  {
      string? CurrentVisitorId { get; }
  }
  public sealed class AsyncLocalVisitorContext : IVisitorContext
  {
      public static AsyncLocalVisitorContext Shared { get; }
      public string? CurrentVisitorId { get; }
      public IDisposable Push(string? visitorId);
  }
  public static class VisitorIdResolver
  {
      public static string? FromHeaderAndCookie(string? header, string? cookie);
      public static string? ForEvent(string? explicitVisitorId, IVisitorContext context);
  }
  ```
  ```csharp
  public abstract class CekatException : Exception
  {
      public int Attempts { get; }
      public bool DeliveryOutcomeUnknown { get; }
  }
  public sealed class ValidationError : CekatException { }
  public sealed class AuthenticationError : ApiError { }
  public sealed class EventDefinitionNotFoundError : ApiError { }
  public class ApiError : CekatException
  {
      public HttpStatusCode Status { get; }
      public string? Code { get; }
      public string RawBody { get; }
  }
  public sealed class TransportError : CekatException { }
  public sealed class ResponseDecodeError : CekatException
  {
      public string RawBody { get; }
  }
  ```
- [ ] **Step 1: Write validation and precedence tests**
  Cover:
  - blank access token rejected before transport construction;
  - `BaseUrl` accepts `http://localhost:43127` and a root trailing slash, normalizes to an origin, and rejects relative values, credentials, non-HTTP(S) schemes, non-root paths, query, and fragment;
  - zero/negative timeout and negative retry count rejected before transport construction;
  - blank key rejected;
  - both email and phone blank rejected;
  - whitespace is used only for emptiness checks;
  - valid email or valid phone accepted without syntax normalization;
  - `properties` is absent/null or a top-level string-keyed object; it rejects a top-level array;
  - recursive JSON accepts null, booleans, strings, arrays, objects, finite decimals, and both safe-integer boundaries;
  - recursive JSON rejects NaN, positive/negative infinity, both out-of-range integral values, cycles, non-string keys, and unsupported runtime values before any HTTP call (including nested occurrences);
  - header beats cookie;
  - blank header falls back to cookie;
  - explicit event visitor beats scoped visitor;
  - nested scopes restore previous values;
  - scope restores after exception;
  - two asynchronous flows do not leak values.
  Representative isolation test:
  ```csharp
  [Fact]
  public async Task AsyncLocal_scopes_are_isolated_and_restored()
  {
      var context = AsyncLocalVisitorContext.Shared;
      async Task<string?> ReadAsync(string id)
      {
          using var scope = context.Push(id);
          await Task.Yield();
          return context.CurrentVisitorId;
      }
      var values = await Task.WhenAll(ReadAsync("visitor-a"), ReadAsync("visitor-b"));
      Assert.Equal(["visitor-a", "visitor-b"], values);
      Assert.Null(context.CurrentVisitorId);
  }
  ```
- [ ] **Step 2: Verify red**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj \
    --filter "FullyQualifiedName~ValidationTests|FullyQualifiedName~VisitorContextTests"
  ```
  Expected: compilation fails because validation, errors, and visitor types are absent.
- [ ] **Step 3: Implement complete option/JSON validation and stack-safe generic scope**
  Validate options synchronously at the client and DI-registration boundary. Accept `BaseUrl` only when `IsAbsoluteUri`, scheme is HTTP or HTTPS, `UserInfo`, `Query`, and `Fragment` are empty, and `AbsolutePath` is empty or `/`; normalize with `UriBuilder` to origin plus `/`. Require non-null `Properties` to be a string-keyed object, then recursively validate its public object graph with reference-identity cycle detection. Permit only `null`, `bool`, `string`, signed/unsigned integral CLR values within ±9,007,199,254,740,991, finite `float`/`double`/`decimal`, arrays/lists of allowed values, string-keyed read-only/mutable dictionaries, and `JsonElement`. A top-level `JsonElement` must be an object. For every `JsonElement`, allow only `Null`, `True`, `False`, `String`, `Array`, `Object`, and `Number`; use raw numeric text/`TryGetInt64` or `TryGetUInt64` to identify integral values and enforce the same safe range, require non-integral values to parse finite, and recurse at every depth. Reject top-level lists, enum/date/custom objects, non-string dictionary keys, cycles, NaN, and infinities with `ValidationError` before serialization or networking. `Push` captures the exact previous `AsyncLocal` holder and restores it from `Dispose`. Normalize visitor IDs by trimming only in the resolver; return `null` for whitespace. Do not expose access tokens as fields on exceptions.
- [ ] **Step 4: Verify green and leak safety**
  Run:
  ```bash
  for i in $(seq 1 25); do
    dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj \
      --filter "FullyQualifiedName~ValidationTests|FullyQualifiedName~VisitorContextTests" \
      || exit 1
  done
  ```
  Expected: all 25 supported `dotnet test` invocations pass; every invalid option/value records zero handler calls and final context is null.
- [ ] **Step 5: Commit**
  ```bash
  git add dotnet/src/Cekat.EventSdk dotnet/tests/Cekat.EventSdk.Tests
  git commit -m "feat(dotnet): add validation errors and visitor scopes"
  ```
### Task 3: Implement payload construction and the public client API
**Files:**
- Create: `dotnet/src/Cekat.EventSdk/Internal/EventRequest.cs`
- Create: `dotnet/src/Cekat.EventSdk/CekatClient.cs`
- Create: `dotnet/tests/Cekat.EventSdk.Tests/{TestHttpMessageHandler,ClientPayloadTests}.cs`
**Interfaces:**
- Consumes: Task 2 validation and `IVisitorContext`.
- Produces:
  ```csharp
  public sealed class CekatClient
  {
      public CekatClient(
          CekatClientOptions options,
          HttpClient? httpClient = null,
          IVisitorContext? visitorContext = null);
      public Task<Acknowledgement> UserRegistrationAsync(
          EventInput input, CancellationToken cancellationToken = default);
      public Task<Acknowledgement> UserLoginAsync(
          EventInput input, CancellationToken cancellationToken = default);
      public Task<Acknowledgement> OrderCreatedAsync(
          EventInput input, CancellationToken cancellationToken = default);
      public Task<Acknowledgement> OrderPaidAsync(
          EventInput input, CancellationToken cancellationToken = default);
      public Task<Acknowledgement> CustomEventAsync(
          string eventKey, EventInput input,
          CancellationToken cancellationToken = default);
      public Task<T> WithVisitorIdAsync<T>(
          string? visitorId,
          Func<CancellationToken, Task<T>> action,
          CancellationToken cancellationToken = default);
  }
  ```
- [ ] **Step 1: Write failing request-shape tests**
  Assert every wrapper’s exact `event_key` and `is_common`; custom events are false; URI combines an override base URL with the fixed ingest path; bearer authorization is present; `business_id` is absent; null optionals are omitted; explicit visitor wins over context; properties preserve arrays, booleans, numbers, objects, and null JSON values.
  Representative assertion:
  ```csharp
  [Fact]
  public async Task Order_paid_sends_the_fixed_contract()
  {
      var handler = TestHttpMessageHandler.ReturnJson(
          """{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}""");
      using var http = new HttpClient(handler);
      var client = new CekatClient(
          new CekatClientOptions {
              AccessToken = "secret-token",
              BaseUrl = new Uri("https://example.test/")
          },
          http,
          new FixedVisitorContext("context-visitor"));
      await client.OrderPaidAsync(new EventInput(
          Email: "ada@example.com",
          Properties: new Dictionary<string, object?> {
              ["order_id"] = "ord_123"
          }));
      Assert.Equal("https://example.test/api/events/ingest", handler.RequestUri!.ToString());
      Assert.Equal("Bearer", handler.Authorization!.Scheme);
      Assert.Equal("secret-token", handler.Authorization.Parameter);
      Assert.Equal("order_paid", handler.Body.RootElement.GetProperty("event_key").GetString());
      Assert.True(handler.Body.RootElement.GetProperty("is_common").GetBoolean());
      Assert.Equal("context-visitor", handler.Body.RootElement.GetProperty("visitor_id").GetString());
      Assert.False(handler.Body.RootElement.TryGetProperty("business_id", out _));
  }
  ```
- [ ] **Step 2: Verify red**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj \
    --filter "FullyQualifiedName~ClientPayloadTests"
  ```
  Expected: compilation fails because `CekatClient` is absent.
- [ ] **Step 3: Implement the client shell and payload**
  Run Task 2 option and recursive JSON validation before constructing `HttpRequestMessage`. Use `JsonSerializerOptions` with snake_case names omitted through explicit `[JsonPropertyName]` attributes on `EventRequest`. Construct the endpoint only from the already validated/normalized origin with `new Uri(options.BaseUrl, CekatConstants.IngestPath)`; never silently discard a configured path. Set authorization per request rather than mutating shared default headers.
- [ ] **Step 4: Verify green**
  Run: `dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj --filter FullyQualifiedName~ClientPayloadTests`
  Expected: every wrapper and payload test passes.
- [ ] **Step 5: Commit**
  ```bash
  git add dotnet/src/Cekat.EventSdk dotnet/tests/Cekat.EventSdk.Tests
  git commit -m "feat(dotnet): serialize common and custom events"
  ```
### Task 4: Add decoding, retries, timeouts, cancellation, and token redaction
**Files:**
- Create: `dotnet/src/Cekat.EventSdk/Internal/{EnvelopeDecoder,ResponseBodyReader,RetryPolicy}.cs`
- Modify: `dotnet/src/Cekat.EventSdk/CekatClient.cs`
- Create: `dotnet/tests/Cekat.EventSdk.Tests/{ClientResponseTests,ClientRetryTests,ClientSecurityTests}.cs`
**Interfaces:**
- Consumes: the client request construction from Task 3.
- Produces these observable mappings:
  - `200` plus valid nested envelope → `Acknowledgement`.
  - malformed, oversized, or nonconforming `200` → `ResponseDecodeError`.
  - `400` → `ApiError`.
  - `401` → `AuthenticationError`.
  - `404` → `EventDefinitionNotFoundError`.
  - exhausted `500` → `ApiError`.
  - exhausted transport failure/timeout → `TransportError`.
  - caller cancellation → `OperationCanceledException`.
- [ ] **Step 1: Write failing envelope and status tests**
  Test missing outer success, missing data, false inner success, blank message/key, non-array properties, non-string array members, malformed JSON, and a 65,537-byte success body. Test valid unknown fields are ignored. Test conforming and malformed error bodies for `400`, `401`, `404`, `500`, and another permanent status.
- [ ] **Step 2: Write failing retry tests using deterministic injected seams**
  Add internal constructor seams, made test-visible with `InternalsVisibleTo`:
  ```csharp
  internal CekatClient(
      CekatClientOptions options,
      HttpClient httpClient,
      IVisitorContext visitorContext,
      Func<int, TimeSpan> retryDelay,
      Func<TimeSpan, CancellationToken, Task> delay);
  ```
  Assert:
  - success uses one attempt;
  - `500, 500, 200` uses exactly three attempts;
  - default retry windows receive retry ordinals 1 and 2 and never exceed 100ms/200ms;
  - `400`, `401`, `404`, and `429` use one attempt;
  - timeout and `HttpRequestException` retry to three attempts;
  - cancellation during the request and delay makes no later attempt;
  - HTTP errors have known outcome;
  - transport exhaustion has `DeliveryOutcomeUnknown == true`;
  - attempts are exact on every error.
- [ ] **Step 3: Verify red**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj \
    --filter "FullyQualifiedName~ClientResponseTests|FullyQualifiedName~ClientRetryTests|FullyQualifiedName~ClientSecurityTests"
  ```
  Expected: response and retry assertions fail because the client does not yet decode or retry.
- [ ] **Step 4: Implement bounded decoding and retry**
  For each attempt, create a linked `CancellationTokenSource`, apply `CancelAfter(options.Timeout)`, and distinguish caller cancellation from attempt timeout. Dispose request, response, linked source, and content each attempt. Retry only `HttpRequestException`, internal timeout, and status `500`. Use `Random.Shared.NextDouble()` for full jitter:
  ```csharp
  internal static TimeSpan DefaultDelay(int retryOrdinal)
  {
      var maximumMs = retryOrdinal switch
      {
          1 => 100,
          2 => 200,
          _ => 200 * Math.Pow(2, retryOrdinal - 2)
      };
      return TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * maximumMs);
  }
  ```
  Read at most 65,537 bytes. Reject an oversized `200`; truncate non-200 raw bodies to 65,536 bytes. Never put request headers, request JSON, options, or token into exception messages.
- [ ] **Step 5: Verify green and all core tests**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj
  dotnet test Cekat.EventSdk.sln --configuration Release
  ```
  Expected: all core tests and the empty adapter projects pass with zero warnings.
- [ ] **Step 6: Commit**
  ```bash
  git add dotnet
  git commit -m "feat(dotnet): add bounded retries and typed responses"
  ```
### Task 5: Implement ASP.NET Core request integration
**Files:**
- Create: all four `.cs` files under `dotnet/src/Cekat.EventSdk.AspNetCore/`
- Create: `dotnet/tests/Cekat.EventSdk.AspNetCore.Tests/CekatVisitorMiddlewareTests.cs`
**Interfaces:**
- Consumes: core `IVisitorContext`, `VisitorIdResolver`, and `CekatClient`.
- Produces:
  ```csharp
  public sealed class AspNetCoreVisitorContext(IHttpContextAccessor accessor)
      : IVisitorContext
  {
      public const string ItemKey = "Cekat.EventSdk.VisitorId";
      public string? CurrentVisitorId { get; }
  }
  public sealed class CekatVisitorMiddleware(RequestDelegate next)
  {
      public Task InvokeAsync(HttpContext context);
  }
  public static IServiceCollection AddCekatEventSdk(
      this IServiceCollection services,
      Action<CekatClientOptions> configure);
  public static IApplicationBuilder UseCekatVisitor(
      this IApplicationBuilder app);
  ```
- [ ] **Step 1: Write failing native middleware tests**
  Use `DefaultHttpContext` and a throwing/suspending `RequestDelegate`. Assert header-over-cookie, trimmed values, no response cookie mutation, the item is visible during the delegate, prior item restoration after success/failure, and isolation for two concurrent contexts. Assert `AspNetCoreVisitorContext` reads items rather than generic `AsyncLocal`.
- [ ] **Step 2: Verify red**
  Run: `dotnet test tests/Cekat.EventSdk.AspNetCore.Tests/Cekat.EventSdk.AspNetCore.Tests.csproj`
  Expected: compilation fails because middleware and registration extensions are absent.
- [ ] **Step 3: Implement middleware with unconditional cleanup**
  ```csharp
  public async Task InvokeAsync(HttpContext context)
  {
      var hadPrevious = context.Items.TryGetValue(
          AspNetCoreVisitorContext.ItemKey, out var previous);
      var header = context.Request.Headers[CekatConstants.VisitorHeader]
          .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
      context.Request.Cookies.TryGetValue(CekatConstants.VisitorCookie, out var cookie);
      var visitorId = VisitorIdResolver.FromHeaderAndCookie(header, cookie);
      try
      {
          if (visitorId is null)
              context.Items.Remove(AspNetCoreVisitorContext.ItemKey);
          else
              context.Items[AspNetCoreVisitorContext.ItemKey] = visitorId;
          await _next(context);
      }
      finally
      {
          if (hadPrevious)
              context.Items[AspNetCoreVisitorContext.ItemKey] = previous;
          else
              context.Items.Remove(AspNetCoreVisitorContext.ItemKey);
      }
  }
  ```
  Register `IHttpContextAccessor`, `AspNetCoreVisitorContext` as the `IVisitorContext`, a configured `HttpClient`, and `CekatClient`.
- [ ] **Step 4: Verify green and run the solution**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.AspNetCore.Tests/Cekat.EventSdk.AspNetCore.Tests.csproj
  dotnet test Cekat.EventSdk.sln --configuration Release
  ```
  Expected: middleware cleanup and concurrent-isolation tests pass.
- [ ] **Step 5: Commit**
  ```bash
  git add dotnet/src/Cekat.EventSdk.AspNetCore dotnet/tests/Cekat.EventSdk.AspNetCore.Tests
  git commit -m "feat(dotnet): add ASP.NET Core visitor middleware"
  ```
### Task 6: Implement Azure Functions isolated-worker integration
**Files:**
- Create: all five `.cs` files under `dotnet/src/Cekat.EventSdk.AzureFunctions/`
- Create: both files under `dotnet/tests/Cekat.EventSdk.AzureFunctions.Tests/`
**Interfaces:**
- Consumes: core visitor resolver and client.
- Produces:
  ```csharp
  public sealed class AzureFunctionsVisitorContext : IVisitorContext
  {
      public const string ItemKey = "Cekat.EventSdk.VisitorId";
      public string? CurrentVisitorId { get; }
      internal void Bind(FunctionContext context);
      internal void Unbind(FunctionContext context);
  }
  public sealed class CekatFunctionsVisitorMiddleware : IFunctionsWorkerMiddleware
  {
      public Task Invoke(FunctionContext context, FunctionExecutionDelegate next);
  }
  public static IFunctionsWorkerApplicationBuilder UseCekatVisitor(
      this IFunctionsWorkerApplicationBuilder builder);
  public static IServiceCollection AddCekatEventSdk(
      this IServiceCollection services,
      Action<CekatClientOptions> configure);
  ```
- [ ] **Step 1: Write failing isolated-worker tests**
  Build a concrete `TestFunctionContext` and `HttpRequestData` test double. Assert:
  - HTTP header beats cookie;
  - non-HTTP triggers expose no visitor but still invoke the function;
  - canonical value is in `FunctionContext.Items`;
  - scoped accessor reads that item;
  - prior item is restored after success and exception;
  - two concurrent invocation scopes cannot see each other.
- [ ] **Step 2: Verify red**
  Run: `dotnet test tests/Cekat.EventSdk.AzureFunctions.Tests/Cekat.EventSdk.AzureFunctions.Tests.csproj`
  Expected: compilation fails because the Functions adapter is absent.
- [ ] **Step 3: Implement invocation-scoped binding and middleware**
  Register `AzureFunctionsVisitorContext` and `IVisitorContext` as scoped services. Middleware obtains `HttpRequestData` through `GetHttpRequestDataAsync`, searches all header values for the first non-empty visitor header, reads the named cookie, stores the resolved ID in `context.Items`, and binds the same `FunctionContext` to the scoped accessor. Restore the prior item and unbind in `finally`; do not copy the access token into `Items`.
- [ ] **Step 4: Verify green**
  Run:
  ```bash
  dotnet test tests/Cekat.EventSdk.AzureFunctions.Tests/Cekat.EventSdk.AzureFunctions.Tests.csproj
  dotnet test Cekat.EventSdk.sln --configuration Release
  ```
  Expected: all Functions and full-solution tests pass.
- [ ] **Step 5: Commit**
  ```bash
  git add dotnet/src/Cekat.EventSdk.AzureFunctions dotnet/tests/Cekat.EventSdk.AzureFunctions.Tests
  git commit -m "feat(dotnet): add isolated worker visitor middleware"
  ```
### Task 7: Implement exhaustive fixture-driven .NET conformance
**Files:**
- Create: every file under `dotnet/tests/Cekat.EventSdk.Conformance.Tests/` from the exact map
- Create: `dotnet/scripts/conformance`

**Interfaces:**
- Consumes only the shared plan's `conformance/fixtures/cases/*.json`, mock ingest origin, and control origin.
- Produces executable `dotnet/scripts/conformance` accepting no arguments and requiring exactly `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_CONTROL_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and `CEKAT_CONFORMANCE_FIXTURES`.

- [ ] **Step 1: Write failing loader/dispatcher and script contract tests**
  `FixtureLoader` reads every `*.json` directly beneath the supplied absolute cases directory, sorts by full path, requires at least one file, rejects duplicate fixture IDs, and deserializes with unmapped-member rejection. Tests create temporary fixture directories proving an unknown `schema_version`, applicability language/capability, operation, properties recipe, response-body recipe, cancellation phase, mock-response field/form, or `expect.result` fails while printing the case ID. Also reject duplicate applicability values, an exclusion inconsistent with the shared capability table, and undeclared `not_applicable` classification. `AssemblyInfo.cs` disables test parallelization because one runner owns one mutable mock process. Run:
  ```bash
  dotnet test dotnet/tests/Cekat.EventSdk.Conformance.Tests/Cekat.EventSdk.Conformance.Tests.csproj
  test -x dotnet/scripts/conformance
  ```
  Expected: FAIL because fixture helpers, cases, and script do not exist.

- [ ] **Step 2: Implement complete fixture and recipe models**
  `FixtureModels` models every field of the shared `Case`, closed `applicability`, `MockResponse`, expected request, acknowledgement, and expected result contracts. Use closed enums/custom converters so unknown values are errors, not enum defaults. Fix this runner's language identity to `dotnet`, validate the exact seven-language and `caller_cancellation` vocabularies plus the shared capability table, and reject undeclared inapplicability before any SDK call. `RecipeFactory` supports all eight property recipes (`nan`, both infinities, both unsafe integers, `cycle`, `non_string_key`, `runtime_object`) as actual CLR object graphs passed to `EventInput`, and the one body recipe form (`unit`, `minimum_utf8_bytes`, `suffix`), expanding UTF-8 bytes exactly. Literal fixture properties become a top-level string-keyed dictionary containing recursively validated dictionaries/lists/scalars. There is no filename or case-ID allowlist.

- [ ] **Step 3: Implement control, operation, cancellation, and result dispatch**
  `MockControlClient` uses only `CEKAT_CONFORMANCE_CONTROL_URL`, posts an empty body to `/__control/reset`, posts `{"responses":[...]}` to `/__control/responses`, and validates/unwraps `{"requests":[...]}` from `/__control/requests`. For every case, reset first, queue expanded responses, create `CekatClient` with `CEKAT_CONFORMANCE_BASE_URL`, `CEKAT_CONFORMANCE_ACCESS_TOKEN`, and fixture client overrides, establish inbound/ambient visitor state, dispatch all five operations, and assert every expected result form, exact attempts, outcome certainty, status/code/message, bounded body bytes/text, acknowledgement, jitter bounds, and normalized request journal. Implement cancellation before request, during a journaled delayed request, and during injected interruptible backoff using `CancellationTokenSource`; no cancellation case may be skipped.

- [ ] **Step 4: Enforce applicability and exhaustive accounting**
  `ConformanceTests` exposes one xUnit row per discovered case and records every completed fixture ID as `passed` or schema-declared `not_applicable`. Because .NET has approved native caller cancellation, all three cancellation cases must be applicable and execute; their exclusion of PHP/Ruby cannot classify .NET as inapplicable. A final accounting assertion compares discovered IDs to the disjoint union of passed and declared-inapplicable IDs and fails on a missing, duplicate, filtered, ordinary skipped, or undeclared-inapplicable case. Validation recipes assert zero journal entries. Request/success/error/retry cases assert journal count equals `expect.attempts`, fixed path/auth, and payload where present. Unknown forms fail before any SDK call.

- [ ] **Step 5: Implement the exact four-variable script**
  Use POSIX shell with `set -eu`; reject positional arguments; require each of the four names to be set and non-empty; reject any `CEKAT_CONFORMANCE_*` variable other than those four; require both URLs to be absolute HTTP(S) origins without user info/path/query/fragment; require the fixtures value to be an absolute readable directory. Do not start the server, infer repository paths, use aliases/defaults, or accept extra conformance variables. Execute:
  ```bash
  dotnet test dotnet/tests/Cekat.EventSdk.Conformance.Tests/Cekat.EventSdk.Conformance.Tests.csproj \
    --configuration Release
  ```
  The tests read the four exact environment names directly.

- [ ] **Step 6: Verify against the shared server**
  Run from repository root:
  ```bash
  ready="$(mktemp)"
  (cd conformance/mock-ingest-server && go run ./cmd/mock-ingest-server --listen 127.0.0.1:0 >"$ready") & pid=$!
  trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$ready"' EXIT INT TERM
  while ! test -s "$ready"; do kill -0 "$pid"; sleep 0.1; done
  base_url="$(jq -er .base_url "$ready")"
  control_url="$(jq -er .control_url "$ready")"
  CEKAT_CONFORMANCE_BASE_URL="$base_url" \
  CEKAT_CONFORMANCE_CONTROL_URL="$control_url" \
  CEKAT_CONFORMANCE_ACCESS_TOKEN=conformance-token \
  CEKAT_CONFORMANCE_FIXTURES="$(pwd)/conformance/fixtures/cases" \
    dotnet/scripts/conformance
  ```
  Expected: every discovered fixture is accounted exactly once, all three applicable cancellation fixtures execute, and the runner exits `0`; deleting a case assertion, claiming undeclared inapplicability, ordinarily skipping a case, or adding an unknown form makes the run nonzero.

- [ ] **Step 7: Commit**
  ```bash
  git add dotnet/tests/Cekat.EventSdk.Conformance.Tests dotnet/scripts/conformance
  git commit -m "test(dotnet): run shared conformance fixtures"
  ```

### Task 8: Add .NET documentation and executable package contract
**Files:**
- Create: `dotnet/README.md`
- Create: `dotnet/scripts/package`
- Create: package-script contract tests under `dotnet/tests/Cekat.EventSdk.Tests/`
- Modify: `.csproj` package metadata

**Interfaces:**
- Consumes: all .NET projects. The later cross-language plan exclusively creates `ci/package-manifest.schema.json` and `scripts/validate-package-manifest.py`; this task does not invoke or depend on those future files.
- Produces `dotnet/scripts/package --version 0.1.0 --output <absolute-dir>` and a closed manifest `{schema_version:1, language:"dotnet", version:"0.1.0", artifacts:[{path,sha256,size_bytes}]}` for later root validation.

- [ ] **Step 1: Write self-contained package contract tests before the package script**
  Add package-script tests that first run `test -x dotnet/scripts/package`, then parse produced JSON with duplicate-key rejection and assert exact closed top-level/artifact key sets, fixed schema/language/version values, a non-empty artifact list, unique paths sorted by UTF-8 bytes, relative traversal-safe slash-separated paths, lowercase 64-hex SHA-256 values, exact byte sizes, complete accounting of every regular output file except `manifest.json`, rejection of unlisted files, and rejection of symlinks anywhere in output.
  Expected: the executable check fails before the script exists; mutation cases fail for every malformed-manifest/output condition above.
- [ ] **Step 2: Write usage documentation**
  Include complete examples for direct `CekatClient`, `WithVisitorIdAsync`, ASP.NET registration/order, and Functions registration. State visitor IDs are untrusted, acknowledgements only mean queue acceptance, retries may duplicate events, `business_id` is never sent, base URLs are origins only, properties use the recursive interoperable JSON domain, cancellation uses `CancellationToken`, and supported SDK/ASP.NET/Functions lines are exactly those evidenced in `COMPATIBILITY.md`.
- [ ] **Step 3: Implement package script**
  Reject any version other than `0.1.0`; require an absolute absent-or-empty output directory; run release tests; execute `dotnet pack --configuration Release --output "$output"`; and atomically write sorted relative `.nupkg` entries with lowercase SHA-256 and byte size. Enforce exact manifest shape and complete regular-file accounting locally; reject symlinks anywhere in output, traversal, unlisted files, and publication/signing commands. Do not call `dotnet nuget push`.
- [ ] **Step 4: Verify scripts and packages**
  Run:
  ```bash
  chmod +x dotnet/scripts/conformance dotnet/scripts/package
  dotnet test dotnet/Cekat.EventSdk.sln --configuration Release
  output="$(mktemp -d)"
  dotnet/scripts/package --version 0.1.0 --output "$output"
  dotnet test dotnet/tests/Cekat.EventSdk.Tests/Cekat.EventSdk.Tests.csproj \
    --configuration Release --filter PackageScript
  ! grep -R "secret-token" "$output"
  ```
  Expected: three NuGet packages and self-contained assertions prove exact manifest shape, sorted safe paths, hashes, sizes, complete file accounting, and symlink rejection; no token text, signing, or publication. Root validation is applied later by the cross-language CI/release plan.
- [ ] **Step 5: Commit**
  ```bash
  git add dotnet
  git commit -m "docs(dotnet): add integration and package guidance"
  ```

### Task 9: Run the release-time compatibility and acceptance gate
**Files:**
- Modify only if fresh evidence differs: `dotnet/COMPATIBILITY.md`, `dotnet/Directory.Packages.props`

- [ ] **Step 1: Repeat Task 1 official-source checks immediately before release readiness**
  Record a dated release-verification section with exact observed .NET SDK/runtime, ASP.NET Core, Azure Functions Worker, NuGet test package, support, and security metadata. If a selected line is no longer maintained/compatible or metadata changed, stop; update the matrix/dependencies through review and rerun all tests rather than silently retaining or upgrading it.
- [ ] **Step 2: Test both compatibility profiles and all contracts**
  Run the solution and conformance command under the exact minimum and current stable SDK/runtime profiles recorded in `COMPATIBILITY.md` (the root CI matrix installs those exact SDKs), then run:
  ```bash
  dotnet test dotnet/Cekat.EventSdk.sln --configuration Release
  git diff --check -- docs/superpowers/plans/2026-09-10-dotnet-event-sdk.md
  ```
  Expected: both profiles pass with zero warnings; the conformance run executes all shared cases; compatibility claims equal the evidence; no package is published.
- [ ] **Step 3: Commit evidence only when changed**
  ```bash
  git add dotnet/COMPATIBILITY.md dotnet/Directory.Packages.props
  git commit -m "docs(dotnet): refresh compatibility evidence"
  ```
  Make no empty commit.
---
