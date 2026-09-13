from __future__ import annotations

import asyncio

import httpx
import pytest

from cekat_event_sdk import (
    ApiError,
    AsyncClient,
    Event,
    ResponseDecodeError,
    TransportError,
    ValidationError,
    visitor_scope,
)
from tests.support import InterruptedStream, failure, ok, payload

TOKEN = "super-secret-token"


class Harness:
    def __init__(self, *responses: httpx.Response | Exception, timeout: float = 3.0) -> None:
        self.queue = list(responses)
        self.requests: list[httpx.Request] = []
        self.sleeps: list[float] = []
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        self.sdk = AsyncClient(
            TOKEN,
            base_url="https://example.test",
            timeout=timeout,
            http_client=self.http,
            _sleep=self.sleep,
            _uniform=lambda low, high: high,
        )

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self.queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.mark.asyncio
async def test_async_methods_mirror_sync_payloads() -> None:
    harness = Harness(ok("order_paid"), ok("user_login"), ok("custom"))
    await harness.sdk.order_paid(10, "USD", Event(email="a"))
    with visitor_scope("v"):
        await harness.sdk.user_login(Event(email="a"))
    await harness.sdk.custom_event("custom", Event(email="a"))
    bodies = [payload(request) for request in harness.requests]
    assert bodies[0]["properties"] == {"amount": 10, "currency": "USD"}
    assert (bodies[1]["is_common"], bodies[1]["visitor_id"]) == (True, "v")
    assert bodies[2]["is_common"] is False


@pytest.mark.asyncio
async def test_validation_error_is_raised_when_awaited() -> None:
    harness = Harness()
    call = harness.sdk.custom_event(" ", Event(email="a"))
    with pytest.raises(ValidationError):
        await call
    assert harness.requests == []


@pytest.mark.asyncio
async def test_async_retries_and_errors() -> None:
    harness = Harness(failure(500), httpx.ConnectError("refused"), failure(429, {"Retry-After": "1"}))
    with pytest.raises(ApiError) as caught:
        await harness.sdk.custom_event("k", Event(email="a"))
    assert (caught.value.status_code, caught.value.attempts) == (429, 3)
    assert harness.sleeps == [0.1, 0.2]

    harness = Harness(httpx.ConnectError("a"), httpx.ConnectError("b"), httpx.ReadTimeout("c"))
    with pytest.raises(TransportError) as transport:
        await harness.sdk.custom_event("k", Event(email="a"))
    assert transport.value.attempts == 3
    assert transport.value.delivery_outcome_unknown is True

    harness = Harness(httpx.Response(200, stream=InterruptedStream(b"{")), ok())
    with pytest.raises(ResponseDecodeError):
        await harness.sdk.custom_event("k", Event(email="a"))
    assert len(harness.requests) == 1


@pytest.mark.asyncio
async def test_attempt_timeout_covers_headers_and_body() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls < 3:
            await asyncio.sleep(1)
        return ok()

    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    sdk = AsyncClient(
        TOKEN,
        base_url="https://example.test",
        timeout=0.02,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        _sleep=sleep,
    )
    assert (await sdk.custom_event("k", Event(email="a"))).success
    assert (calls, len(sleeps)) == (3, 2)


@pytest.mark.asyncio
async def test_task_cancellation_during_request_propagates() -> None:
    started = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.sleep(60)
        raise AssertionError

    sdk = AsyncClient(
        TOKEN,
        base_url="https://example.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    task = asyncio.create_task(sdk.custom_event("k", Event(email="e")))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_task_cancellation_during_backoff_propagates_without_next_attempt() -> None:
    attempts = 0
    sleeping = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return failure(500)

    async def blocked_sleep(delay: float) -> None:
        sleeping.set()
        await asyncio.sleep(60)

    sdk = AsyncClient(
        TOKEN,
        base_url="https://example.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        _sleep=blocked_sleep,
    )
    task = asyncio.create_task(sdk.custom_event("k", Event(email="e")))
    await sleeping.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert attempts == 1


@pytest.mark.asyncio
async def test_default_sleep_is_real_and_interruptible() -> None:
    harness = Harness()
    sdk = AsyncClient(TOKEN, http_client=harness.http)
    assert sdk._sleep is not None
    await sdk._sleep(0)


@pytest.mark.asyncio
async def test_async_ownership() -> None:
    harness = Harness(ok())
    async with harness.sdk as sdk:
        await sdk.custom_event("k", Event(email="a"))
    assert not harness.http.is_closed
    async with AsyncClient(TOKEN) as owned:
        pass
    assert owned._http.is_closed
    assert TOKEN not in repr(owned)
    with pytest.raises(ValidationError):
        AsyncClient(TOKEN, http_client=httpx.Client())  # type: ignore[arg-type]
