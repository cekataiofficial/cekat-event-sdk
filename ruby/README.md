# Cekat Ruby Event SDK

`cekat-event-sdk` submits identity-bearing Cekat events from Ruby backends and automatically attaches the browser visitor ID (from the `X-Cekat-Visitor-ID` header or `_cekat_visitor_id` cookie) of the request being handled.

Requires Ruby 3.3 or newer. No runtime gem dependencies. Integrations: Rack middleware (Rack 2.2 and 3) and Rails 8.0–8.1.

```ruby
gem "cekat-event-sdk"
```

## Construct a client and submit events

Construct one client and reuse it; it is thread-safe. Only the access token is required.

```ruby
require "cekat_event_sdk"

CEKAT = CekatEventSdk::Client.new(access_token: ENV.fetch("CEKAT_ACCESS_TOKEN"))

CEKAT.user_registration(email: "person@example.com", contact_name: "Person")
CEKAT.user_login(phone_number: "+628123456789")
CEKAT.order_created(email: "person@example.com", properties: { order_id: "o-1" })
CEKAT.form_submitted(email: "person@example.com", properties: { form_id: "contact" })
CEKAT.order_paid(email: "person@example.com", properties: { order_id: "o-1" }, amount: 125_000, currency: "IDR")
ack = CEKAT.custom_event("wishlist_updated", email: "person@example.com")
```

`form_submitted` sends the common `form_submitted` event (`is_common: true`). Every event method also accepts a `CekatEventSdk::EventInput` or a Hash instead of keyword attributes. `order_paid` additionally requires a finite `amount:` (Integer, Float, BigDecimal, or Rational) and a nonblank `currency:`, sent as the `amount` and `currency` properties; do not also put those keys in `properties`.

An `Acknowledgement` means Cekat accepted the event for **asynchronous processing**. It does not confirm durable storage, identity resolution, delivery completion, or analytics availability.

At least one of `email` or `phone_number` must be nonblank. Identity and contact strings are sent unchanged. `properties` is `nil` (omitted) or a Hash with String or Symbol keys; values may be `nil`, `true`, `false`, UTF-8 Strings, Symbols (sent as strings), finite numbers, Arrays, and Hashes. Integers must be within ±9,007,199,254,740,991; BigDecimal and Rational are sent as floats. Other objects (including `Time` — use `time.iso8601`), cycles, non-String keys, and duplicate keys after Symbol conversion raise `CekatEventSdk::ValidationError` before any request.

## Event IDs and timestamps

Every event carries an `event_id` and an `occurred_at` timestamp. When `event_id` is blank the SDK generates a random UUID, and when `occurred_at` (a `Time`, `DateTime`, or `ActiveSupport::TimeWithZone`) is omitted it uses the time of the call. Both are fixed before the first attempt and reused by every retry, so Cekat can recognize retried deliveries. Supply your own `event_id` when the same business event may be sent more than once:

```ruby
CEKAT.order_paid(email: order.email, event_id: "order-paid-#{order.id}", occurred_at: order.paid_at,
                 amount: order.total, currency: order.currency)
```

## Request visitor context

Install the integration at the request boundary. While the request is handled, event calls attach its visitor ID automatically. A nonblank explicit `visitor_id:` takes precedence; a blank one falls back to the request. Visitor IDs are untrusted correlation data: never use them for authentication or authorization.

### Rails

The Railtie inserts `CekatEventSdk::Rails::Middleware` automatically. The request visitor is available to the client and as `CekatEventSdk::Rails::Current.visitor_id`. To insert the middleware yourself, set `config.cekat_event_sdk.insert_middleware = false` and add it where you want in the stack.

```ruby
# config/initializers/cekat.rb
CEKAT = CekatEventSdk::Client.new(access_token: Rails.application.credentials.cekat_access_token)
```

### Rack (Sinatra, Hanami, Roda, and others)

```ruby
use CekatEventSdk::Rack::Middleware
```

The middleware also exposes the value as `env["cekat_event_sdk.visitor_id"]`. It reads the raw `Cookie` header and never modifies the request, response, or cookies.

### Without middleware

```ruby
CEKAT.with_visitor_id(visitor_id) do
  CEKAT.user_login(email: "person@example.com")
end
```

### Scope and concurrency

The visitor scope lives in fiber storage (`Fiber[]`), so it is isolated per request under threaded servers (Puma) and fiber-based servers (Falcon). Every scope restores the previous visitor when it ends, including when it raises, so long-running workers never leak a visitor ID between requests. Threads and fibers started inside a request begin with a copy of its scope. The scope ends when the middleware returns, so events emitted while a streaming response body is iterated must pass `visitor_id:` explicitly.

## Stripe metadata composition

Use the helper with the merchant's Stripe client; it does not create a Stripe request or send a Cekat event.

```ruby
metadata = CekatEventSdk::Stripe.merge_metadata(merchant_metadata, CekatEventSdk::Stripe.metadata_from_current_visitor["cekat_" + "visitor_id"])
# stripe.payment_intents.create(amount: 1200, currency: "usd", metadata: metadata)
# stripe.checkout.sessions.create(mode: "payment", metadata: metadata, payment_intent_data: { metadata: metadata })
```

Only a trimmed 1–128 character `[A-Za-z0-9_-]` visitor becomes the Stripe visitor metadata entry. Merge returns a fresh hash, preserving merchant keys and leaving invalid or absent visitor input unchanged.

## Keep tracking off the request's critical path

Calls are synchronous, so each event adds its round-trip to the request. To send in the background, capture the visitor ID while the request scope is active and pass it explicitly:

```ruby
visitor_id = CekatEventSdk::VisitorContext.current_visitor_id
TrackLoginJob.perform_later(user.email, visitor_id)

class TrackLoginJob < ApplicationJob
  def perform(email, visitor_id)
    CEKAT.user_login(email: email, visitor_id: visitor_id)
  end
end
```

Jobs run outside the request, so they never see its scope; later events that carry the contact's email or phone number do not need a visitor ID. Rescue and log errors in background work.

## Errors and retries

All errors inherit from `CekatEventSdk::Error`, which exposes `attempts` and `delivery_outcome_unknown?`:

| Error | Meaning |
| --- | --- |
| `ValidationError` | Invalid configuration or event input; nothing was sent. |
| `AuthenticationError` | HTTP 401. Inherits from `ApiError`. |
| `EventDefinitionNotFoundError` | HTTP 404. Inherits from `ApiError`. |
| `ApiError` | Any other non-200 response: `status`, `code`, bounded `raw_body`. |
| `ResponseDecodeError` | HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received. |
| `TransportError` | No response after all attempts. `delivery_outcome_unknown?` is `true`: Cekat may have received it. |

```ruby
begin
  CEKAT.order_paid(email: email, amount: 125_000, currency: "IDR")
rescue CekatEventSdk::TransportError => e
  Rails.logger.warn("Cekat unreachable after #{e.attempts} attempts; delivery outcome unknown")
rescue CekatEventSdk::ApiError => e
  Rails.logger.error("Cekat rejected the event (#{e.status}): #{e.message}")
end
```

Response bodies retained in errors are capped at 65,536 bytes. Error messages never include request headers, and `Client#inspect` omits the access token.

Transport failures, timeouts, and HTTP 429, 500, 502, 503, and 504 are retried, up to `retry_count` retries (default 2). Delays use capped exponential full jitter (up to 100ms, 200ms, 400ms, 800ms, then 1s). A valid `Retry-After` header raises the delay to the server's value; above 5 seconds the SDK raises immediately instead of blocking. Other statuses, including 400, 401, and 404, are not retried, and a received 200 is never retried. A retry after an unknown outcome can create a **duplicate** event; retries reuse the same `event_id`, but the SDK does not guarantee server-side deduplication.

## Configuration

```ruby
CekatEventSdk::Client.new(access_token: token, base_url: "https://t.cekat.ai", timeout: 3, retry_count: 2)
```

`base_url` must be an absolute HTTP(S) origin without credentials, path, query, or fragment; the SDK always posts to `/api/events/ingest`. Requests send `User-Agent: cekat-event-sdk-ruby/<version>`.

The Net::HTTP transport opens a fresh connection per attempt, never follows redirects, reads at most 65,537 response bytes, and applies `timeout` to connecting, writing, waiting for the response, and reading the body. Ruby has no portable caller cancellation, so bound each call with `timeout` and `retry_count`.

## Development

```sh
bundle install
bundle exec rake            # core, Rack, and Rails specs plus RuboCop
RAILS_VERSION="~> 8.0.0" RACK_VERSION="~> 2.2" bundle update && bundle exec rake spec
./scripts/package --version 0.3.0 --output /absolute/empty-directory
```

`scripts/package` runs the specs, RuboCop, and `bundle-audit`, then builds the gem and a SHA-256 `manifest.json`. It never pushes, signs, or tags; releases to RubyGems run from the repository's `release-ruby.yml` workflow when a `ruby/vX.Y.Z` tag is pushed. `scripts/conformance` runs the shared conformance fixtures (see `conformance/README.md`); the three caller-cancellation cases are reported as `not_applicable` for Ruby.
