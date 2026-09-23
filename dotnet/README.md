# Cekat .NET Event SDK

Send identity-bearing events from .NET backends to Cekat and connect them to the browser visitor that triggered the request.

| Package | Use it for |
| --- | --- |
| `Cekat.EventSdk` | The client. No dependencies beyond the .NET base library. |
| `Cekat.EventSdk.AspNetCore` | ASP.NET Core visitor middleware and `AddCekatEventSdk` registration. |
| `Cekat.EventSdk.AzureFunctions` | Azure Functions isolated worker middleware and registration. |

All packages target `net8.0` and run on .NET 8 and later. The packages are ordinary .NET assemblies, so F# and VB.NET applications can use them too.

```sh
dotnet add package Cekat.EventSdk.AspNetCore     # or Cekat.EventSdk / Cekat.EventSdk.AzureFunctions
```

Keep the access token on the server. Never ship it to browser or mobile code.

## Submit events

Create one `CekatClient` per application and reuse it; it is thread-safe and owns a connection pool.

```csharp
using Cekat.EventSdk;

using var cekat = new CekatClient(new CekatClientOptions
{
    AccessToken = Environment.GetEnvironmentVariable("CEKAT_ACCESS_TOKEN"),
});

var acknowledgement = await cekat.UserRegistrationAsync(new EventInput(Email: "ada@example.com", ContactName: "Ada Lovelace"));
await cekat.UserLoginAsync(new EventInput(Email: "ada@example.com"));
await cekat.OrderCreatedAsync(new EventInput(PhoneNumber: "+6281234567890", Properties: new Dictionary<string, object?> { ["order_id"] = "ord_123" }));
await cekat.FormSubmittedAsync(new EventInput(Email: "ada@example.com", Properties: new Dictionary<string, object?> { ["form_id"] = "contact" }));
await cekat.OrderPaidAsync(125_000m, "IDR", new EventInput(Email: "ada@example.com", Properties: new Dictionary<string, object?> { ["order_id"] = "ord_123" }));
await cekat.CustomEventAsync("trial_started", new EventInput(Email: "ada@example.com", Properties: new Dictionary<string, object?> { ["plan"] = "pro" }));

Console.WriteLine($"{acknowledgement.EventKey}: {acknowledgement.Message}");
```

Every event needs a nonblank `Email` or `PhoneNumber`. Identity strings are sent exactly as given; they are trimmed only to check that they are not blank.

`FormSubmittedAsync(input)` sends the common `form_submitted` event (`is_common: true`). `OrderPaidAsync(amount, currency, input)` sends `amount` and `currency` (nonblank, sent unchanged) as `properties.amount` and `properties.currency`. Passing either key in `Properties` as well is a `CekatValidationException`.

`Properties` is a string-keyed object: a `Dictionary<string, T>` or other `IDictionary` with string keys, an `IEnumerable<KeyValuePair<string, object?>>` (including `ExpandoObject`), a `JsonObject`, or an object `JsonElement`. Values may be `null`, `bool`, `string`, integral and floating-point numbers, `decimal`, arrays and lists, nested objects, `JsonElement`, and `JsonNode`. Integral values must be within ±9,007,199,254,740,991. `NaN`, infinities, cycles, non-string keys, and other types (`DateTime`, `Guid`, enums, POCOs, anonymous objects) are rejected before anything is sent, and the error names the property path but never its value.

An `Acknowledgement` means Cekat accepted the event for asynchronous processing. It does not confirm storage, identity resolution, or analytics availability. The SDK never sends `business_id`.

Invalid input faults the returned task with `CekatValidationException`; the methods never throw synchronously. Invalid options throw from the constructor or from `AddCekatEventSdk`.

## Event IDs and timestamps

```csharp
await cekat.OrderPaidAsync(order.Total, order.Currency, new EventInput(
    Email: order.Email,
    EventId: $"order-paid-{order.Id}",
    OccurredAt: order.PaidAt));
```

- `EventId` lets Cekat recognise duplicate deliveries. It is trimmed; when absent or blank the SDK generates a random UUID. Use a stable ID from your own records when you may resend the same event.
- `OccurredAt` defaults to the time of the call and is sent in UTC with millisecond precision.

Both values are fixed once per call and reused for every retry.

## Request visitor context

The browser SDK sends the visitor ID in the `X-Cekat-Visitor-ID` header, or it is available from the `_cekat_visitor_id` cookie. A nonblank header wins over the cookie and values are trimmed. For each event, a nonblank `EventInput.VisitorId` wins, then the current visitor scope, then the request context.

Visitor IDs come from the browser and are **untrusted**. Use them only for correlation, never for authentication or authorization.

### ASP.NET Core

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCekatEventSdk(options =>
{
    options.AccessToken = builder.Configuration["Cekat:AccessToken"];
});

var app = builder.Build();
app.UseCekatVisitor(); // before the endpoints and middleware that track events

app.MapPost("/login", async (LoginRequest login, CekatClient cekat, CancellationToken cancellationToken) =>
{
    // ... authenticate ...
    await cekat.UserLoginAsync(new EventInput(Email: login.Email), cancellationToken);
    return Results.Ok();
});

app.Run();
```

`AddCekatEventSdk` registers a singleton `CekatClient`. The middleware stores the visitor in `HttpContext.Items` (read it with `AspNetCoreVisitorContext.FromHttpContext`) and in a visitor scope that also flows into work started by the request.

### Azure Functions (isolated worker)

```csharp
var builder = FunctionsApplication.CreateBuilder(args);
builder.UseCekatVisitor();
builder.Services.AddCekatEventSdk(options =>
{
    options.AccessToken = Environment.GetEnvironmentVariable("CEKAT_ACCESS_TOKEN");
});
builder.Build().Run();
```

For HTTP-triggered invocations the middleware reads the header or cookie through `HttpRequestData` and makes the visitor current for the function (`FunctionContext.GetCekatVisitorId()` returns it). Other triggers run unchanged.

### Other hosts and explicit scopes

```csharp
using (AsyncLocalVisitorContext.Push(visitorIdFromYourFramework))
{
    await cekat.UserLoginAsync(new EventInput(Email: email));
}

var acknowledgement = await CekatClient.WithVisitorIdAsync(visitorId, token => cekat.UserLoginAsync(new EventInput(Email: email), token));
```

Use `VisitorIdResolver.FromHeadersAndCookies` and `VisitorIdResolver.CookieValues` to apply the same precedence to your framework's request. Scopes nest, flow across `await` and `Task.Run`, and restore the previous visitor when disposed.

## Stripe metadata composition

Use the helper with the merchant's Stripe client; it does not create a Stripe request or send a Cekat event.

```csharp
var visitorMetadata = StripeMetadata.FromCurrentVisitor();
var metadata = StripeMetadata.MergeMetadata(merchantMetadata, visitorMetadata.GetValueOrDefault("cekat_" + "visitor_id"));
// paymentIntentOptions.Metadata = metadata.ToDictionary();
// checkoutOptions.Metadata = metadata.ToDictionary(); // and payment-mode PaymentIntent metadata
```

Only a trimmed 1–128 character `[A-Za-z0-9_-]` visitor becomes the Stripe visitor metadata entry. Merge returns a fresh read-only dictionary, preserving merchant keys and leaving invalid or absent visitor input unchanged.

## Keep tracking off the request's critical path

Each call waits for Cekat's response (up to 3 seconds per attempt, plus retries). In ASP.NET Core you can start the call without awaiting it; the visitor scope flows into the task, but handle its errors and don't pass the request's `CancellationToken`, which belongs to the request's lifetime:

```csharp
app.MapPost("/login", (LoginRequest login, CekatClient cekat, ILogger<Program> logger) =>
{
    _ = Task.Run(async () =>
    {
        try
        {
            await cekat.UserLoginAsync(new EventInput(Email: login.Email));
        }
        catch (CekatException error)
        {
            logger.LogWarning(error, "Cekat user_login failed");
        }
    });
    return Results.Ok();
});
```

For work that must survive restarts, enqueue it (for example a `Channel<T>` drained by a `BackgroundService`, or a durable queue) and pass the visitor explicitly: `new EventInput(Email: email, VisitorId: AspNetCoreVisitorContext.FromHttpContext(httpContext))`. In Azure Functions, await the call: the worker may be suspended once the function returns. Events sent later without a visitor ID are still attributed through the contact's email or phone number.

## Errors, cancellation, and retries

| Exception | Meaning |
| --- | --- |
| `CekatValidationException` | Invalid options or event input; nothing was sent. |
| `CekatAuthenticationException` | HTTP 401. Derives from `CekatApiException`. |
| `CekatEventDefinitionNotFoundException` | HTTP 404. Derives from `CekatApiException`. |
| `CekatApiException` | Any other non-200 response: `StatusCode`, `Code`, `RawBody`, `GetRawBodyBytes()` (at most 65,536 bytes). |
| `CekatResponseDecodeException` | HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received. |
| `CekatTransportException` | No response after all attempts. `DeliveryOutcomeUnknown` is `true`: Cekat may have received the event. |

All derive from `CekatException`, which exposes `Attempts` and `DeliveryOutcomeUnknown`. The message of a `CekatApiException` is the server's `error` text, else the HTTP reason phrase.

```csharp
try
{
    await cekat.OrderPaidAsync(125_000m, "IDR", new EventInput(Email: email), cancellationToken);
}
catch (CekatTransportException error)
{
    logger.LogWarning("Cekat unreachable after {Attempts} attempts; delivery outcome unknown", error.Attempts);
}
catch (CekatApiException error)
{
    logger.LogError("Cekat rejected the event ({Status}): {Message}", (int)error.StatusCode, error.Message);
}
```

The SDK makes up to `RetryCount + 1` attempts (3 by default). It retries connection failures, timeouts, and HTTP 429, 500, 502, 503, and 504 — never other statuses. Before retry *n* it waits a random delay between 0 and min(100 ms × 2ⁿ⁻¹, 1 s). A `Retry-After` header raises that delay to the requested value; if the server asks for more than 5 seconds, the SDK stops and throws instead of blocking. A retried event keeps its `EventId` (sent as `event_id`), but a `CekatTransportException` still means the event may have arrived.

Cancelling the `CancellationToken` interrupts the request or the retry delay immediately and throws `OperationCanceledException`, with no further attempts. Cancellation during a request leaves the delivery outcome unknown.

Exception messages and `ToString()` never include the access token or request headers.

## Configuration

| Option | Default | |
| --- | --- | --- |
| `AccessToken` | required | Server-side Cekat access token. |
| `BaseUrl` | `https://t.cekat.ai` | Absolute HTTP(S) origin without path, query, fragment, or credentials. |
| `Timeout` | 3 seconds | Per attempt, covering the connection, response headers, and response body. |
| `RetryCount` | 2 | Retries after the first attempt; 0 disables retries. |

To control proxies, TLS, or handlers, pass your own `HttpClient`: `new CekatClient(options, httpClient)`. The SDK never disposes an injected client, and the client's own `Timeout` also applies. The SDK-created client does not follow redirects.

## Development

```sh
dotnet test Cekat.EventSdk.sln                                  # unit, ASP.NET Core, and Functions tests
../scripts/conformance.sh --language dotnet                     # shared contract against the mock ingest server
scripts/package --version 0.3.0 --output /absolute/empty/dir    # tests, vulnerability audit, pack, manifest
```

On the .NET 10 SDK, add `-p:TestTargetFramework=net10.0` (or set `TEST_TARGET_FRAMEWORK=net10.0` for the scripts) to run the tests on .NET 10. `scripts/package` never pushes, signs, tags, or publishes; releases to nuget.org run from the repository's `release-dotnet.yml` workflow when a `dotnet/vX.Y.Z` tag is pushed. See [COMPATIBILITY.md](COMPATIBILITY.md) for supported versions.
