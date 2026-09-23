# SDK contract

Every Cekat event SDK in this repository implements the same behavior with idiomatic names. This page describes that shared contract; each language README shows the exact API. The executable form of the contract is the shared conformance suite: [`conformance/README.md`](../conformance/README.md) explains it, and [`conformance/fixtures/schemas/conformance-case.schema.json`](../conformance/fixtures/schemas/conformance-case.schema.json) defines the fixture format. Every SDK must pass every fixture.

Related pages: [visitor propagation](visitor-propagation.md), [retries and errors](retry-and-error-semantics.md), [compatibility](compatibility.md).

## Client

A client needs only an access token. Create one client per application and reuse it.

| Setting | Default | Notes |
| --- | --- | --- |
| Access token | required | Server-side only. Never ship it to browser or mobile code. |
| Base URL | `https://server.cekat.ai` | An absolute HTTP(S) origin without path, query, fragment, or credentials. |
| Timeout | 3 seconds per attempt | See [retries and errors](retry-and-error-semantics.md). |
| Retry count | 2 retries after the first attempt | `0` disables retries. |
| HTTP transport | the SDK's own | Most SDKs accept a caller-owned HTTP client or transport, which the SDK never closes. |

Invalid settings fail when the client is created.

## Request

Every event is one HTTP request:

```http
POST https://server.cekat.ai/api/events/ingest
Authorization: Bearer <access token>
Content-Type: application/json
User-Agent: cekat-event-sdk-<language>/<version>
```

Some SDKs append runtime details to the `User-Agent` (for example `node/24.21.0` or `bun/1.4.2`). The path `/api/events/ingest` is fixed; only the origin is configurable. The access token selects the tenant, so the SDK never sends `business_id`. Error messages, logs, and string representations of clients and errors never contain the access token.

## Event payload

| Field | Sent | Meaning |
| --- | --- | --- |
| `event_key` | always | The event definition key. Must not be blank. |
| `event_id` | always | The caller's ID (trimmed), otherwise a random lowercase version 4 UUID. Fixed once per call and reused by every retry. |
| `occurred_at` | always | The caller's time or the time of the call, in UTC with millisecond precision (`2026-09-13T01:15:30.250Z`). Fixed once per call. |
| `is_common` | always | `true` for the five common operations, `false` for custom events. |
| `email` | when given | Contact identity. Sent exactly as given. |
| `phone_number` | when given | Contact identity. Sent exactly as given. |
| `contact_name` | when given | Display name; not an identity by itself. |
| `visitor_id` | when known | The browser visitor, from the event or the request; see [visitor propagation](visitor-propagation.md). |
| `properties` | when given | A JSON object. |

At least one of `email` or `phone_number` must be nonblank. Identity strings are trimmed only to check that they are not blank; the SDK does not normalize or validate their format, and tenant-specific rules stay on the server.

`properties` must be a string-keyed object whose values are JSON values: null, booleans, strings, finite numbers, arrays, and objects. Integral numbers must be within ±9,007,199,254,740,991. `NaN`, infinities, cycles, non-string keys, and runtime-specific objects (dates, custom classes) are rejected with a validation error before any request is sent.

## Operations

| Operation | `event_key` | `is_common` | Arguments |
| --- | --- | --- | --- |
| User registration | `user_registration` | `true` | event |
| User login | `user_login` | `true` | event |
| Order created | `order_created` | `true` | event |
| Form submitted (`FormSubmitted` / language-equivalent method) | `form_submitted` | `true` | event |
| Order paid | `order_paid` | `true` | amount, currency, event |
| Custom event | caller's key | `false` | event key, event |

Form submitted is a built-in common operation. Its language-specific methods are listed below; each fixes `event_key` to `form_submitted` and `is_common` to `true`.

Order paid requires a finite `amount` and a nonblank `currency`. They are sent as `properties.amount` and `properties.currency` (currency unchanged, not validated as a code). Passing either key in the event's own properties is a validation error rather than being overwritten. A common key still needs an event definition in the tenant; the common operations imply no special server behavior.

| SDK | Form submitted | Order paid | Custom event |
| --- | --- | --- | --- |
| [Go](../go/README.md) | `client.FormSubmitted(ctx, event)` | `client.OrderPaid(ctx, amount, currency, event)` | `client.CustomEvent(ctx, key, event)` |
| [Node.js and Bun](../node/README.md) | `await client.formSubmitted(event, { signal })` | `await client.orderPaid(amount, currency, event, { signal })` | `await client.customEvent(key, event)` |
| [Python](../python/README.md) | `client.form_submitted(event)` (also `AsyncClient`) | `client.order_paid(amount, currency, event)` (also `AsyncClient`) | `client.custom_event(key, event)` |
| [PHP](../php/README.md) | `$client->formSubmitted($event)` | `$client->orderPaid($amount, $currency, $event)` | `$client->customEvent($key, $event)` |
| [Java](../java/README.md) | `client.formSubmitted(event)` | `client.orderPaid(amount, currency, event)` | `client.customEvent(key, event)` |
| [.NET](../dotnet/README.md) | `await client.FormSubmittedAsync(input, cancellationToken)` | `await client.OrderPaidAsync(amount, currency, input, cancellationToken)` | `await client.CustomEventAsync(key, input)` |
| [Ruby](../ruby/README.md) | `client.form_submitted(event)` | `client.order_paid(event, amount:, currency:)` | `client.custom_event(key, event)` |

Asynchronous APIs report invalid input through their normal error channel (a rejected promise, a faulted task, an error when awaited), never by throwing synchronously.

## Acknowledgement

Only HTTP 200 with a valid success envelope produces an acknowledgement:

```json
{"success":true,"data":{"success":true,"message":"accepted","event_key":"order_paid","validated_properties":["order_id"]}}
```

The acknowledgement exposes `success`, `message`, `event_key`, `validated_properties`, and the bounded raw body. It means Cekat accepted the event for asynchronous processing. It does not confirm durable storage, identity resolution, delivery completion, or analytics availability.

## Errors

Every failure is one of six categories, all deriving from a common SDK base error:

| Category | When | Delivery outcome |
| --- | --- | --- |
| `ValidationError` | Invalid settings or event input; nothing was sent. | Not sent |
| `AuthenticationError` | HTTP 401. | Known |
| `EventDefinitionNotFoundError` | HTTP 404. | Known |
| `ApiError` | Any other non-200 response. | Known |
| `ResponseDecodeError` | HTTP 200 whose body was invalid, too large, or unreadable. | Known: the event was received |
| `TransportError` | No response after all attempts. | Unknown: the event may have arrived |

Names follow each ecosystem:

| SDK | Class names |
| --- | --- |
| Go | `ValidationError`, `AuthenticationError`, `EventDefinitionNotFoundError`, `APIError`, `ResponseDecodeError`, `TransportError` |
| Node.js and Bun, Python, Ruby | `ValidationError`, `AuthenticationError`, `EventDefinitionNotFoundError`, `ApiError`, `ResponseDecodeError`, `TransportError` |
| PHP, Java | `ValidationException`, `AuthenticationException`, `EventDefinitionNotFoundException`, `ApiException`, `ResponseDecodeException`, `TransportException` |
| .NET | `CekatValidationException`, `CekatAuthenticationException`, `CekatEventDefinitionNotFoundException`, `CekatApiException`, `CekatResponseDecodeException`, `CekatTransportException` |

Status codes, messages, retained bodies, attempt counts, and cancellation are described in [retries and errors](retry-and-error-semantics.md).
