# Cekat Python Event SDK

Send identity-bearing events from Python backends to Cekat and connect them to the browser visitor that triggered the request.

- Python 3.10+; typed (`py.typed`); depends only on `httpx` and `anyio`.
- Blocking `Client` and non-blocking `AsyncClient` (asyncio or Trio).
- Request visitor context for Django, Flask, Starlette, FastAPI, and any ASGI app.

```sh
pip install cekat-event-sdk              # core
pip install "cekat-event-sdk[django]"    # or [flask], [asgi], [fastapi]
```

Keep the access token on the server. Never ship it to browser or mobile code.

## Construct a client and submit events

Create one client per process and reuse it; it holds a connection pool.

```python
import os

from cekat_event_sdk import Client, Event

cekat = Client(os.environ["CEKAT_ACCESS_TOKEN"])

ack = cekat.user_registration(Event(email="ada@example.com", contact_name="Ada Lovelace"))
cekat.user_login(Event(email="ada@example.com"))
cekat.order_created(Event(phone_number="+6281234567890", properties={"order_id": "ord_123"}))
cekat.order_paid(125_000, "IDR", Event(email="ada@example.com", properties={"order_id": "ord_123"}))
cekat.custom_event("trial_started", Event(email="ada@example.com", properties={"plan": "pro"}))

print(ack.event_key, ack.message, ack.validated_properties)
```

The async client has the same methods as coroutines:

```python
import asyncio

from cekat_event_sdk import AsyncClient, Event

async def main() -> None:
    async with AsyncClient("server-access-token") as cekat:
        ack = await cekat.order_paid(
            125_000, "IDR", Event(email="ada@example.com", properties={"order_id": "ord_123"})
        )
        print(ack.event_key, ack.message)

asyncio.run(main())
```

Every event needs a nonblank `email` or `phone_number`. Identity strings are sent exactly as given; they are trimmed only to check that they are not blank.

`order_paid(amount, currency, event)` sends `amount` (a finite `int`, `float`, or `Decimal`) and `currency` (a nonblank string, sent unchanged) as `properties.amount` and `properties.currency`. Passing either key in `properties` as well is a `ValidationError`.

`properties` accepts `None`, `bool`, `str`, finite numbers, lists, tuples, and dicts with string keys, nested to any reasonable depth. Integers (and integral floats) must be within ±9,007,199,254,740,991. Cycles, `datetime`, `set`, `bytes`, and other objects are rejected before anything is sent, and the error names the property path but never its value.

An `Acknowledgement` means Cekat accepted the event for asynchronous processing. It does not confirm storage, identity resolution, or analytics availability.

### Client lifecycle

A client created with `Client(...)` or `AsyncClient(...)` owns its HTTP pool: close it with `close()`/`aclose()` or a `with`/`async with` block. You may pass your own pool instead — `Client(token, http_client=httpx.Client(...))` or `AsyncClient(token, http_client=httpx.AsyncClient(...))` — and the SDK will never close it. `Client` is thread-safe. Use an `AsyncClient` from the event loop that created its pool.

## Event IDs and timestamps

Every event carries an `event_id` and an `occurred_at`:

```python
from datetime import datetime, timezone

cekat.order_paid(
    125_000,
    "IDR",
    Event(email="ada@example.com", event_id=f"order-paid-{order.id}", occurred_at=order.paid_at),
)
```

- `event_id` lets Cekat recognise duplicate deliveries. It is trimmed; when absent or blank the SDK generates a random UUID. Use a stable ID derived from your own records when you may resend the same event.
- `occurred_at` must be a timezone-aware `datetime`; it defaults to the time of the call and is sent in UTC with millisecond precision.

Both values are fixed once per call and reused for every retry.

## Request visitor context

The browser SDK sends the visitor ID in the `X-Cekat-Visitor-ID` header, or it is available from the `_cekat_visitor_id` cookie. The integrations below put it into a request-local context (`contextvars`), and every event sent while handling that request picks it up. A nonblank header wins over the cookie; values are trimmed; a nonblank `Event(visitor_id=...)` wins over both.

Visitor IDs come from the browser and are **untrusted**. Use them only for correlation, never for authentication or authorization.

### Django

```python
# settings.py
MIDDLEWARE = [
    # ...
    "cekat_event_sdk.integrations.django.DjangoVisitorMiddleware",
]
```

The middleware supports both WSGI and ASGI deployments, including async views.

### Flask

```python
from flask import Flask
from cekat_event_sdk.integrations.flask import CekatVisitor

app = Flask(__name__)
CekatVisitor(app)  # or CekatVisitor().init_app(app) in an application factory
```

### Starlette and FastAPI

```python
from fastapi import FastAPI
from cekat_event_sdk.integrations.asgi import VisitorMiddleware

app = FastAPI()
app.add_middleware(VisitorMiddleware)
```

`VisitorMiddleware` is plain ASGI 3 middleware: wrap any ASGI application with `app = VisitorMiddleware(app)`. It does not buffer bodies, and its scope covers streamed responses and Starlette background tasks.

### Other frameworks and explicit scopes

```python
from cekat_event_sdk import current_visitor_id, visitor_from_request, visitor_scope

with visitor_from_request(request_headers, request_cookies):  # header over cookie
    cekat.user_login(Event(email=email))

with visitor_scope(" visitor-123 "):  # explicit value, trimmed
    assert current_visitor_id() == "visitor-123"
```

Scopes nest and restore the previous visitor on exit, including when an exception or cancellation leaves the block.

## Stripe metadata composition

Use the dependency-free helper with the merchant's own Stripe client; it does not create Stripe requests or send Cekat events.

```python
from cekat_event_sdk.stripe import merge_metadata, metadata_from_current_visitor

metadata = merge_metadata(merchant_metadata, metadata_from_current_visitor().get("cekat_" + "visitor_id"))
stripe.PaymentIntent.create(amount=1200, currency="usd", metadata=metadata)
stripe.checkout.Session.create(mode="payment", metadata=metadata, payment_intent_data={"metadata": metadata})
```

The helper accepts only a trimmed 1–128 character `[A-Za-z0-9_-]` visitor and returns a fresh mapping. Invalid or absent visitors leave merchant metadata unchanged.

## Keep tracking off the request's critical path

Each call waits for Cekat's response (up to 3 seconds per attempt, plus retries). Don't make users wait for it.

In async applications, run the call in a task. Tasks copy the current context, so the visitor ID follows automatically; keep a reference so the task is not garbage-collected, and handle its errors:

```python
import asyncio
import logging

from cekat_event_sdk import CekatError

background: set[asyncio.Task[None]] = set()

async def track_login(email: str) -> None:
    try:
        await cekat.user_login(Event(email=email))
    except CekatError:
        logging.getLogger(__name__).warning("Cekat user_login failed", exc_info=True)

@app.post("/login")
async def login(form: LoginForm) -> dict[str, bool]:
    task = asyncio.create_task(track_login(form.email))
    background.add(task)
    task.add_done_callback(background.discard)
    return {"ok": True}
```

FastAPI/Starlette `BackgroundTasks` also see the visitor, because they run inside the middleware.

For job queues (Celery, RQ, Dramatiq) and thread pools, capture the visitor ID while the request is active and pass it explicitly — workers do not inherit the request context:

```python
from cekat_event_sdk import current_visitor_id

track_login.delay(user.email, current_visitor_id())

@celery.task
def track_login(email: str, visitor_id: str | None) -> None:
    cekat.user_login(Event(email=email, visitor_id=visitor_id))
```

Events sent later without a visitor ID are still attributed through the contact's email or phone number.

## Errors, cancellation, and retries

All errors inherit from `CekatError`, which exposes `message`, `attempts`, and `delivery_outcome_unknown`:

| Error | Meaning |
| --- | --- |
| `ValidationError` | Invalid configuration or event input; nothing was sent. |
| `AuthenticationError` | HTTP 401. Subclass of `HttpError`. |
| `EventDefinitionNotFoundError` | HTTP 404. Subclass of `HttpError`. |
| `ApiError` | Any other non-200 response. Subclass of `HttpError`. |
| `ResponseDecodeError` | HTTP 200 whose body was invalid, over 65,536 bytes, or unreadable. The event was received. |
| `TransportError` | No response after all attempts. `delivery_outcome_unknown` is `True`: Cekat may have received the event. The underlying `httpx` exception is `cause`. |

`HttpError` subclasses expose `status_code`, `message` (the server's `error` text, else the HTTP reason phrase), `code`, and `raw_body` (at most 65,536 bytes).

```python
from cekat_event_sdk import HttpError, TransportError

try:
    cekat.order_paid(125_000, "IDR", Event(email=email))
except TransportError as error:
    log.warning("Cekat unreachable after %d attempts; delivery outcome unknown", error.attempts)
except HttpError as error:
    log.error("Cekat rejected the event (%d): %s", error.status_code, error.message)
```

The SDK makes up to `retry_count + 1` attempts (3 by default). It retries connection failures, timeouts, and HTTP 429, 500, 502, 503, and 504 — never other statuses. Before retry *n* it waits a random delay between 0 and min(100 ms × 2ⁿ⁻¹, 1 s). A `Retry-After` header raises that delay to the requested value; if the server asks for more than 5 seconds, the SDK stops and raises the error instead of blocking. A retried event keeps its `event_id`, so Cekat can recognise it, but a `TransportError` still means the event may have arrived.

Cancelling the task awaiting an `AsyncClient` call interrupts the request or backoff immediately and propagates `asyncio.CancelledError` unchanged, with no further attempts. Cancellation during a request leaves the delivery outcome unknown.

Error messages never include the access token or request headers, and client `repr()` omits the token.

## Configuration

| Argument | Default | |
| --- | --- | --- |
| `access_token` | required | Server-side Cekat access token. |
| `base_url` | `https://server.cekat.ai` | Absolute HTTP(S) origin without path, query, fragment, or credentials. |
| `timeout` | `3.0` | Seconds per attempt, covering the connection, response headers, and response body. |
| `retry_count` | `2` | Retries after the first attempt; `0` disables retries. |
| `http_client` | SDK-owned | Your own `httpx.Client` / `httpx.AsyncClient` (proxies, TLS, limits). Never closed by the SDK. |

Redirects are not followed.

## Development

```sh
python3 -m venv .venv
.venv/bin/pip install -e ".[test,django,flask,asgi,fastapi]"
.venv/bin/python -m pytest                   # unit, integration, and packaging tests
.venv/bin/python -m ruff check src tests && .venv/bin/python -m ruff format --check src tests
.venv/bin/python -m mypy
../scripts/conformance.sh --language python  # shared contract against the mock ingest server
.venv/bin/python scripts/package --version 0.2.0 --output /absolute/empty/dir
```

`pip install -c constraints-lowest.txt -e ".[test,django,flask,asgi,fastapi]"` installs the declared dependency floors. `scripts/package` runs every check plus `pip-audit`, builds the wheel and sdist, runs `twine check`, and writes a SHA-256 `manifest.json`. It never uploads, signs, tags, or pushes; releases to PyPI run from the repository's `release-python.yml` workflow when a `python/vX.Y.Z` tag is pushed. See [docs/compatibility.md](docs/compatibility.md) for supported versions.
