# Retries and errors

Every SDK delivers an event synchronously: the call returns once Cekat answers, all attempts fail, or the caller cancels. This page describes when the SDKs retry, how they classify responses, and what each outcome tells you. The shared conformance suite ([`conformance/README.md`](../conformance/README.md)) checks each rule.

Related pages: [SDK contract](sdk-contract.md), [visitor propagation](visitor-propagation.md).

## Attempts and timeouts

- Each attempt has a timeout of 3 seconds by default. Each language README describes exactly which phases of an attempt the timeout covers.
- The default retry count is 2, so a call makes at most 3 attempts. A retry count of 0 disables retries.

## What is retried

| Outcome of an attempt | Retried? |
| --- | --- |
| Connection failure or per-attempt timeout (no response) | Yes |
| HTTP 429, 500, 502, 503, or 504 | Yes, decided by the status alone, even if the body cannot be read |
| Any other status, including 400, 401, and 404 | No |
| HTTP 200, valid or not, including a body that cannot be read | No: the event was received |
| Caller cancellation | No |

## Delay between attempts

Before retry *n* the SDK waits a random delay between 0 and min(100 ms × 2ⁿ⁻¹, 1 s) (full jitter):

| Retry | Maximum delay |
| --- | --- |
| 1 | 100 ms |
| 2 | 200 ms |
| 3 | 400 ms |
| 4 | 800 ms |
| 5 and later | 1 s |

A retryable response with a valid `Retry-After` header (delta-seconds or an HTTP date) raises the delay to the requested value. If the server asks for more than 5 seconds, the SDK does not retry and returns that response's error immediately, so a caller is never blocked on a long pause. An invalid `Retry-After` is ignored.

## Duplicates

A call's `event_id` and `occurred_at` are fixed before the first attempt and sent unchanged in every retry. When an attempt failed without a response, Cekat may already have received the event, so a retry can deliver it again. Reusing the `event_id` lets the server recognize the duplicate, but the SDKs do not guarantee server-side deduplication. Supply your own stable `event_id` (for example `order-paid-<order id>`) when your application might send the same business event more than once, and choose the retry count according to how much duplication you can tolerate.

## Response classification

| Response | Result |
| --- | --- |
| HTTP 200 with a valid success envelope | Acknowledgement |
| HTTP 200 that is not a valid envelope, exceeds 65,536 bytes, or whose body could not be read | `ResponseDecodeError` |
| HTTP 401 | `AuthenticationError` |
| HTTP 404 | `EventDefinitionNotFoundError` |
| Any other non-200 status, after retries where eligible | `ApiError` |
| No response after all attempts | `TransportError` |

A valid success envelope has `success: true` and a `data` object with `success: true`, a non-empty `message`, a non-empty `event_key`, and a `validated_properties` array of strings; other fields are ignored. For a non-200 response, the error message is the server's `error` text from a `{"success":false,"error":"...","code":"..."}` envelope, otherwise the HTTP reason phrase, otherwise the standard status text (for example `Too Many Requests`), otherwise `HTTP <status>`. The optional `code` is exposed separately.

HTTP errors expose the status code, the server code, the attempt count, and the raw response body. At most 65,536 response bytes are retained; the SDK reads one more byte only to detect that the body was longer.

## Delivery outcome

SDK errors for sent events report how many attempts were made, and the transport error reports that the delivery outcome is unknown:

| Outcome | Errors | Meaning |
| --- | --- | --- |
| Not sent | `ValidationError` | Nothing left the process. Fix the input. |
| Known | `AuthenticationError`, `EventDefinitionNotFoundError`, `ApiError`, `ResponseDecodeError` | Cekat answered. After `ResponseDecodeError` the event was received even though the body was unusable. |
| Unknown | `TransportError` | No response arrived. The event may have been received; resending can create a duplicate. |

| SDK | Outcome flag |
| --- | --- |
| Go | `TransportError.DeliveryOutcomeUnknown` |
| Node.js and Bun | `error.deliveryOutcomeUnknown` |
| Python | `error.delivery_outcome_unknown` |
| PHP | `$exception->deliveryOutcomeUnknown` |
| Java | `exception.deliveryOutcomeUnknown()` |
| .NET | `exception.DeliveryOutcomeUnknown` |
| Ruby | `error.delivery_outcome_unknown?` |

## Cancellation

Where the language has a standard way to cancel a call, cancelling it stops the request in flight or the wait before a retry, makes no further attempt, and reports the runtime's own cancellation rather than an SDK error. A request cancelled while in flight has an unknown delivery outcome.

| SDK | How to cancel | What the call reports |
| --- | --- | --- |
| Go | cancel the `context.Context` | `context.Canceled` or `context.DeadlineExceeded` |
| Node.js and Bun | pass `{ signal }` and abort it | a rejection with the abort reason |
| Python | cancel the task awaiting `AsyncClient` | `asyncio.CancelledError` |
| Java | interrupt the calling thread | `InterruptedException` |
| .NET | cancel the `CancellationToken` | `OperationCanceledException` |
| PHP, Ruby | not supported | calls are bounded by the timeout and retry count |

PHP and Ruby calls cannot be cancelled by the caller; the conformance fixtures declare the cancellation cases not applicable to those two SDKs.

## Runtime limitation: Bun before 1.4

On Bun releases before 1.4.0, a connection that closes after Cekat's response headers but before the complete body makes the whole request fail, so the SDK cannot see that a 200 arrived. It reports the attempt as a failure without a response and retries it with the same `event_id`. The conformance guide records this under [runtime limitations](../conformance/README.md#runtime-limitations); Node.js and Bun 1.4.0 or newer classify the response exactly.
