"""Asynchronous client for asyncio and Trio applications."""

from __future__ import annotations

import random
from collections.abc import Awaitable, Callable
from decimal import Decimal
from types import TracebackType

import anyio
import httpx

from ._shared import (
    DEFAULT_BASE_URL,
    DEFAULT_RETRY_COUNT,
    DEFAULT_TIMEOUT,
    Settings,
    body_timeout,
    received,
    transport_error,
)
from .context import current_visitor_id
from .errors import ValidationError
from .models import Acknowledgement, Event
from .protocol import BoundedBuffer, ReceivedResponse, decode
from .retry import is_retryable_status, retry_delay
from .validation import build_body, with_order_paid_properties


class AsyncClient:
    """Non-blocking Cekat event client. Share one instance per event loop.

    Cancelling the awaiting task interrupts the request or backoff and propagates the native
    cancellation exception unchanged. An injected ``http_client`` is never closed by the SDK.
    """

    def __init__(
        self,
        access_token: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        retry_count: int = DEFAULT_RETRY_COUNT,
        http_client: httpx.AsyncClient | None = None,
        _sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
        _uniform: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self._settings = Settings.create(access_token, base_url, timeout, retry_count)
        if http_client is not None and not isinstance(http_client, httpx.AsyncClient):
            raise ValidationError("http_client must be an httpx.AsyncClient")
        self._owns_http = http_client is None
        self._http = http_client if http_client is not None else httpx.AsyncClient()
        self._sleep = _sleep
        self._uniform = _uniform

    def __repr__(self) -> str:
        return f"AsyncClient(url={self._settings.url!r})"

    async def user_registration(self, event: Event) -> Acknowledgement:
        return await self._track("user_registration", True, event)

    async def user_login(self, event: Event) -> Acknowledgement:
        return await self._track("user_login", True, event)

    async def order_created(self, event: Event) -> Acknowledgement:
        return await self._track("order_created", True, event)

    async def form_submitted(self, event: Event) -> Acknowledgement:
        return await self._track("form_submitted", True, event)

    async def order_paid(self, amount: float | int | Decimal, currency: str, event: Event) -> Acknowledgement:
        """Track ``order_paid``; ``amount`` and ``currency`` are sent as properties."""
        return await self._track("order_paid", True, with_order_paid_properties(amount, currency, event))

    async def custom_event(self, event_key: str, event: Event) -> Acknowledgement:
        return await self._track(event_key, False, event)

    async def aclose(self) -> None:
        """Close the SDK-created HTTP client. Injected clients are left open."""
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.aclose()

    async def _track(self, event_key: str, is_common: bool, event: Event) -> Acknowledgement:
        body = build_body(event_key, is_common, event, current_visitor_id())
        attempts = 0
        while True:
            attempts += 1
            try:
                response = await self._attempt(body)
            except httpx.TransportError as error:
                if attempts > self._settings.retry_count:
                    raise transport_error(error, attempts) from error
                await self._sleep(retry_delay(attempts, None, self._uniform) or 0.0)
                continue
            if is_retryable_status(response.status_code) and attempts <= self._settings.retry_count:
                delay = retry_delay(attempts, response.header("Retry-After"), self._uniform)
                if delay is not None:
                    await self._sleep(delay)
                    continue
            return decode(response, attempts)

    async def _attempt(self, body: bytes) -> ReceivedResponse:
        settings = self._settings
        request = self._http.build_request(
            "POST", settings.url, content=body, headers=list(settings.headers), timeout=settings.timeout
        )
        response: httpx.Response | None = None
        buffer = BoundedBuffer()
        failure: BaseException | None = None
        with anyio.move_on_after(settings.timeout) as scope:
            response = await self._http.send(request, stream=True, follow_redirects=False)
            try:
                async for chunk in response.aiter_bytes():
                    if not buffer.append(chunk):
                        break
            except httpx.HTTPError as error:
                failure = error
            finally:
                with anyio.CancelScope(shield=True):
                    await response.aclose()
        if scope.cancelled_caught:
            if response is None:
                raise httpx.TimeoutException(
                    f"no response headers within {settings.timeout:g} seconds", request=request
                )
            failure = body_timeout(settings.timeout)
        assert response is not None
        return received(response, buffer, failure)
