# Cekat PHP Event SDK

`cekat/event-sdk` submits identity-bearing Cekat events from PHP backends and automatically attaches the browser visitor ID (from the `X-Cekat-Visitor-ID` header or `_cekat_visitor_id` cookie) of the request being handled.

Requires PHP 8.2 or newer and Guzzle 7.15.2+ or 8. Integrations: PSR-15 middleware, Laravel 12–13, and Symfony 6.4, 7.4, and 8.

```sh
composer require cekat/event-sdk
```

## Construct a client and submit events

Construct one client and reuse it. Only the access token is required; keep it in server-side configuration.

```php
use Cekat\EventSdk\Client;
use Cekat\EventSdk\EventInput;

$cekat = new Client(getenv('CEKAT_ACCESS_TOKEN'));

$cekat->userRegistration(new EventInput(email: 'person@example.com', contactName: 'Person'));
$cekat->userLogin(new EventInput(phoneNumber: '+628123456789'));
$cekat->orderCreated(new EventInput(email: 'person@example.com', properties: ['order_id' => 'o-1']));
$cekat->orderPaid(125000, 'IDR', new EventInput(email: 'person@example.com', properties: ['order_id' => 'o-1']));
$ack = $cekat->customEvent('wishlist_updated', new EventInput(email: 'person@example.com'));
```

`orderPaid($amount, $currency, $event)` additionally requires a finite `amount` and a nonblank `currency`, sent as the `amount` and `currency` properties; do not also put those keys in `properties`.

An `Acknowledgement` means Cekat accepted the event for **asynchronous processing**. It does not confirm durable storage, identity resolution, delivery completion, or analytics availability.

At least one of `email` or `phoneNumber` must be nonblank. Identity and contact strings are sent unchanged. `properties` is `null` (omitted), a string-keyed array, or a `stdClass`, and always becomes a JSON object. Values may be `null`, booleans, UTF-8 strings, finite numbers, lists, string-keyed arrays, `stdClass`, or `JsonSerializable` objects that produce those types. Integers must be within ±9,007,199,254,740,991. Other objects (such as `DateTimeImmutable`), resources, cycles, and arrays with integer keys that are not lists (for example the result of `array_filter()`; use `array_values()`) throw `ValidationException` before any request is sent.

## Event IDs and timestamps

Every event carries an `event_id` and an `occurred_at` timestamp. When `eventId` is blank the SDK generates a random UUID, and when `occurredAt` (any `DateTimeInterface`) is omitted it uses the time of the call. Both are fixed before the first attempt and reused by every retry, so Cekat can recognize retried deliveries. Supply your own `eventId` when the same business event may be sent more than once:

```php
$cekat->orderPaid($order->total, $order->currency, new EventInput(
    email: $order->email,
    eventId: 'order-paid-' . $order->id,
    occurredAt: $order->paidAt,
));
```

## Request visitor context

Install one integration at the request boundary. While the request is handled, event calls attach its visitor ID automatically. A nonblank explicit `visitorId` on `EventInput` takes precedence; a blank one falls back to the request. Visitor IDs are untrusted correlation data: never use them for authentication or authorization.

### PSR-15 (Slim, Mezzio, and others)

```php
use Cekat\EventSdk\Integration\Psr15\VisitorMiddleware;

$app->add(new VisitorMiddleware());
```

`Client` and `VisitorMiddleware` share `VisitorContext::shared()` by default. To isolate state, create one `VisitorContext` and pass it to both constructors.

### Laravel

The service provider is auto-discovered. Configure `config/services.php`:

```php
'cekat' => [
    'access_token' => env('CEKAT_ACCESS_TOKEN'),
    // Optional: 'base_url' => env('CEKAT_BASE_URL'), 'timeout_seconds' => 3.0, 'retry_count' => 2,
],
```

Register the middleware in `bootstrap/app.php` and inject `Client` where you submit events:

```php
use Cekat\EventSdk\Integration\Laravel\VisitorMiddleware;

->withMiddleware(function (Middleware $middleware) {
    $middleware->append(VisitorMiddleware::class);
})
```

The visitor context and client are scoped bindings, so Laravel Octane rebuilds them for every request. The middleware reads the raw `Cookie` header, so the browser tracker's unencrypted `_cekat_visitor_id` cookie works without adding it to `EncryptCookies` exceptions.

### Symfony

Decorate the HTTP kernel in `config/services.yaml`:

```yaml
services:
    Cekat\EventSdk\Context\VisitorContextInterface:
        class: Cekat\EventSdk\Context\VisitorContext

    Cekat\EventSdk\Client:
        arguments:
            $accessToken: '%env(CEKAT_ACCESS_TOKEN)%'
            $visitorContext: '@Cekat\EventSdk\Context\VisitorContextInterface'

    Cekat\EventSdk\Integration\Symfony\VisitorContextKernel:
        decorates: http_kernel
        arguments: ['@.inner', '@Cekat\EventSdk\Context\VisitorContextInterface']
```

Sub-requests without their own visitor ID inherit the main request's visitor.

### Without a framework

```php
use Cekat\EventSdk\Context\VisitorContext;
use Cekat\EventSdk\Context\VisitorExtractor;

$visitorId = VisitorExtractor::fromNormalized(getallheaders(), $_COOKIE);
VisitorContext::shared()->runWithVisitorId($visitorId, function () use ($cekat): void {
    $cekat->userLogin(new EventInput(email: 'person@example.com'));
});
```

### Long-running workers

Every integration restores the previous visitor when the request finishes, including when it throws, so PHP-FPM, Octane, RoadRunner, and FrankenPHP workers never leak a visitor ID between sequential requests. Servers that interleave requests in one process with coroutines (for example Swoole coroutines) must implement `VisitorContextInterface` with coroutine-local storage instead of sharing `VisitorContext`.

## Keep tracking off the request's critical path

PHP calls are synchronous, so each event adds its round-trip to the request. To send after the response, capture the visitor ID first, because the request scope has ended when deferred work runs:

```php
$visitorId = app(\Cekat\EventSdk\Context\VisitorContextInterface::class)->current();

// Laravel 11+: runs after the response is sent.
\Illuminate\Support\defer(fn () => $cekat->userLogin(new EventInput(email: $user->email, visitorId: $visitorId)));

// PHP-FPM without a framework: flush the response, then send.
fastcgi_finish_request();
$cekat->userLogin(new EventInput(email: $email, visitorId: $visitorId));
```

In Symfony, send from a `kernel.terminate` listener with an explicitly captured `visitorId`. Catch and log exceptions in deferred work.

## Errors and retries

All exceptions extend `Cekat\EventSdk\Exception\CekatException`:

| Exception | Meaning |
| --- | --- |
| `ValidationException` | Invalid configuration or event input; nothing was sent. |
| `AuthenticationException` | HTTP 401. Extends `ApiException`. |
| `EventDefinitionNotFoundException` | HTTP 404. Extends `ApiException`. |
| `ApiException` | Any other non-200 response: `statusCode`, `serverCode`, bounded `rawBody`, `attempts`. |
| `ResponseDecodeException` | HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received. |
| `TransportException` | No response after all attempts. `deliveryOutcomeUnknown` is `true`: Cekat may have received it. |

```php
use Cekat\EventSdk\Exception\ApiException;
use Cekat\EventSdk\Exception\CekatException;
use Cekat\EventSdk\Exception\TransportException;

try {
    $cekat->orderPaid(125000, 'IDR', $event);
} catch (TransportException $e) {
    $logger->warning('Cekat unreachable; delivery outcome unknown', ['attempts' => $e->attempts]);
} catch (ApiException $e) {
    $logger->error('Cekat rejected the event', ['status' => $e->statusCode, 'message' => $e->getMessage()]);
} catch (CekatException $e) {
    $logger->error('Cekat event failed', ['exception' => $e]);
}
```

Response bodies retained in exceptions are capped at 65,536 bytes. Transport exception messages never include request headers, and the access token is marked `#[\SensitiveParameter]`.

Transport failures, per-attempt timeouts, and HTTP 429, 500, 502, 503, and 504 are retried, up to `retryCount` retries (default 2). Delays use capped exponential full jitter (up to 100ms, 200ms, 400ms, 800ms, then 1s). A valid `Retry-After` header raises the delay to the server's value; above 5 seconds the SDK throws immediately instead of blocking. Other statuses, including 400, 401, and 404, are not retried, and a received 200 is never retried. A retry after an unknown outcome can create a **duplicate** event; retries reuse the same `event_id`, but the SDK does not guarantee server-side deduplication.

PHP has no portable caller cancellation, so bound each call with `timeoutSeconds` and `retryCount`.

## Configuration and transports

```php
use Cekat\EventSdk\ClientOptions;

$cekat = new Client($token, new ClientOptions(baseUrl: 'https://server.cekat.ai', timeoutSeconds: 3.0, retryCount: 2));
```

`baseUrl` must be an absolute HTTP(S) origin without credentials, path, query, or fragment; the SDK always posts to `/api/events/ingest`. Requests send `User-Agent: cekat-event-sdk-php/<version>`.

The default `GuzzleTransport` enforces the per-attempt timeout (connection, headers, and body), never follows redirects, reads at most 65,537 response bytes, and opens a fresh connection per attempt so libcurl cannot silently resend a request on a stale keep-alive connection. You may pass your own `GuzzleHttp\ClientInterface` to `GuzzleTransport`. `Psr18Transport` accepts any PSR-18 client, but PSR-18 has no portable per-request timeout: configure the timeout (and disable redirects) on the client you inject.

## Local package preparation

```sh
./scripts/package --version 0.1.0 --output /absolute/empty-directory
```

Runs `composer validate --strict`, installs dependencies, runs `composer audit`, the unit tests, PHPStan, and PHP-CS-Fixer, then writes a Composer archive and a SHA-256 `manifest.json`. It never uploads, signs, tags, or pushes. Because Packagist reads `composer.json` from a repository root, releases go through a generated mirror: pushing a `php/vX.Y.Z` tag makes the repository's `release-php.yml` workflow copy this directory to [cekataiofficial/cekat-event-sdk-php](https://github.com/cekataiofficial/cekat-event-sdk-php) and tag it `vX.Y.Z`, which is what Packagist reads. Development stays here. See the root release checklist.

`./scripts/conformance` runs the shared conformance fixtures; see `conformance/README.md`. The three caller-cancellation cases are reported as `not_applicable` for PHP.
